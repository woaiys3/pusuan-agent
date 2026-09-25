package com.pusuan.api

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * DSH 内核的客户端。
 *
 * 与内核的通信有两条通道，都是内核自带 Web 表层的既有契约（未做任何内核改动）：
 *
 *  - unary RPC：`POST /api/<endpoint>`，body 是 `{type, rpcId, method, payload}`，
 *    响应 `{rpcId, result}`。业务错误同样是 HTTP 200（错误在信封里），
 *    HTTP 状态只表达载体层问题（404 路径不存在 / 415 非 JSON / 400 body 非 JSON / 500 崩溃）。
 *  - 事件流：`WS /api/events.mux` 与 `WS /api/events.host`，只下行，
 *    客户端不在这些 socket 上发业务数据。
 *
 * 连接就绪的判定：两条 WS 都打开，且 `host.describe` 调用成功。
 */
class DshClient(private val port: Int, private val scope: CoroutineScope) {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // 模型响应可能很久（思考 + 长文），读超时给足以免误判断流
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val base = "http://127.0.0.1:$port"

    /** 事件流：转发内核下行帧（session/event、approval/requested 等）。 */
    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)
    val events: SharedFlow<JsonObject> = _events.asSharedFlow()

    private var muxSocket: WebSocket? = null
    private var hostSocket: WebSocket? = null

    // ── RPC ────────────────────────────────────────────────────────────────

    /**
     * 调用一个 unary 端点。
     *
     * 响应信封（在设备上实测确认的形状）：
     *   {"type":"server-response","rpcId":"…","result":{"ok":true,"value":{…}}}
     * 业务失败也是 HTTP 200，只是 result.ok=false 并带 error：
     *   {"result":{"ok":false,"error":{"code":"bad-request","message":"…"}}}
     * 所以判定成功与否看的是 result.ok，不是 HTTP 状态码。
     *
     * @return result.value（端点真正的返回值）
     * @throws DshException 传输层失败、rpcId 不匹配、或 result.ok=false
     */
    suspend fun call(
        endpoint: String,
        payload: JsonObject = JsonObject(emptyMap()),
    ): JsonObject = kotlinx.coroutines.withContext(Dispatchers.IO) {
        val rpcId = UUID.randomUUID().toString()
        val envelope = buildJsonObject {
            put("type", "client-request")
            put("rpcId", rpcId)
            put("method", endpoint)
            put("payload", payload)
        }
        val req = Request.Builder()
            .url("$base/api/$endpoint")
            .post(envelope.toString().toRequestBody(JSON_MEDIA))
            .header("content-type", "application/json")
            .build()

        http.newCall(req).execute().use { resp: Response ->
            val bodyText = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw DshException("传输层失败 $endpoint: HTTP ${resp.code} $bodyText")
            }
            val root = json.parseToJsonElement(bodyText).jsonObject
            val gotId = root["rpcId"]?.jsonPrimitive?.content
            if (gotId != rpcId) {
                throw DshException("rpcId 不匹配 $endpoint: 发出 $rpcId，收到 $gotId")
            }

            val result = root["result"]?.jsonObject ?: JsonObject(emptyMap())
            val ok = result["ok"]?.jsonPrimitive?.booleanOrNull ?: false
            if (!ok) {
                val err = result["error"]
                val code = (err as? JsonObject)?.get("code")?.jsonPrimitive?.contentOrNull
                val message = (err as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
                throw DshException(
                    "$endpoint 失败" +
                        (if (code != null) "[$code]" else "") +
                        (if (message != null) ": $message" else ": ${err ?: "未知错误"}")
                )
            }
            result["value"]?.jsonObject ?: JsonObject(emptyMap())
        }
    }

    // ── 会话 ───────────────────────────────────────────────────────────────

    /** 新建会话。agentPreset 用 "question"（提问式占卜）或 "standard"。 */
    suspend fun createSession(agentPreset: String, cwd: String? = null): String {
        val payload = buildJsonObject {
            put("agentPreset", agentPreset)
            if (cwd != null) put("cwd", cwd)
        }
        val res = call("session.create", payload)
        return res["sessionId"]?.jsonPrimitive?.content
            ?: throw DshException("session.create 未返回 sessionId")
    }

    suspend fun listSessions(): JsonArray {
        val res = call("session.list", JsonObject(emptyMap()))
        return res["items"] as? JsonArray ?: JsonArray(emptyList())
    }

    /** 取会话历史（含已有的消息，用于进入会话时回填界面）。 */
    suspend fun history(sessionId: String): JsonObject =
        call("session.history", buildJsonObject { put("sessionId", sessionId) })

    /**
     * 发送一条用户消息。
     *
     * mode：`queue` 追加到队列；`steer` 打断当前回合。用户发新消息用 queue 更符合直觉。
     * clientTimeZone 让内核按用户所在时区记录来源（内核文档明确该值只随本次请求附加、不缓存）。
     */
    suspend fun prompt(
        sessionId: String,
        text: String,
        mode: String = "queue",
        clientTimeZone: String? = null,
    ) {
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("mode", mode)
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "text")
                    put("text", text)
                })
            })
            if (clientTimeZone != null) put("clientTimeZone", clientTimeZone)
        }
        call("session.prompt", payload)
    }

    suspend fun cancel(sessionId: String) {
        call("session.cancel", buildJsonObject { put("sessionId", sessionId) })
    }

    suspend fun rename(sessionId: String, title: String) {
        call("session.rename", buildJsonObject {
            put("sessionId", sessionId)
            put("title", title)
        })
    }

    suspend fun selectModel(sessionId: String, provider: String, model: String, reasoningEffort: String?) {
        call("session.selectModel", buildJsonObject {
            put("sessionId", sessionId)
            put("provider", provider)
            put("model", model)
            if (reasoningEffort != null) put("reasoningEffort", reasoningEffort)
        })
    }

    /** 可用模型（已配置凭据的 provider）。 */
    suspend fun models(sessionId: String): JsonObject =
        call("session.models", buildJsonObject { put("sessionId", sessionId) })

    /** 技能目录（需会话上下文：技能是按会话解析的）。 */
    suspend fun skillList(sessionId: String): JsonArray {
        val res = call("skill.list", buildJsonObject { put("sessionId", sessionId) })
        return (res["skills"] ?: res["items"]) as? JsonArray ?: JsonArray(emptyList())
    }

    suspend fun agentPresets(): JsonArray {
        val res = call("agentPreset.list", JsonObject(emptyMap()))
        return (res["presets"] ?: res["items"]) as? JsonArray ?: JsonArray(emptyList())
    }

    suspend fun setCredential(provider: String, apiKey: String) {
        call("credentials.set", buildJsonObject {
            put("provider", provider)
            put("apiKey", apiKey)
        })
    }

    suspend fun describeCredentials(): JsonObject =
        call("credentials.describe", JsonObject(emptyMap()))

    // ── 事件流 ─────────────────────────────────────────────────────────────

    /** 打开两条下行 WebSocket。 */
    fun connect() {
        muxSocket = openSocket("/api/events.mux", "mux")
        hostSocket = openSocket("/api/events.host", "host")
    }

    private fun openSocket(path: String, label: String): WebSocket {
        val req = Request.Builder().url("ws://127.0.0.1:$port$path").build()
        return http.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val obj = json.parseToJsonElement(text).jsonObject
                    _events.tryEmit(obj)
                } catch (e: Exception) {
                    Log.w(TAG, "[$label] 事件解析失败: ${e.message}")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "[$label] 连接断开: ${t.message}")
            }
        })
    }

    /** 探活：host.describe 是连接就绪三项之一，也最适合做健康检查。 */
    suspend fun ping(): Boolean = try {
        call("host.describe", JsonObject(emptyMap()))
        true
    } catch (e: Exception) {
        false
    }

    fun close() {
        muxSocket?.close(1000, null)
        hostSocket?.close(1000, null)
        muxSocket = null
        hostSocket = null
    }

    companion object {
        private const val TAG = "Pusuan"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

class DshException(message: String) : Exception(message)
