package com.pusuan.ui

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.pusuan.PusuanApp
import com.pusuan.api.DshClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 对话界面的状态与业务。
 *
 * 会话内容的来源选择：内核会把流式增量经 `events.mux` 下发，但该帧的内部结构属于
 * 内核实现细节、随版本可变。这里改用**轮询 session.history 作为事实来源**，
 * 事件流只当作"有变化，去刷新一次"的触发器——少一层对未公开 schema 的耦合，
 * 内核升级时不容易碎。
 *
 * 为什么不继承 androidx ViewModel：本应用只有一个常驻界面，实例由 MainActivity
 * 用 remember 持有、生命周期与进程一致，引入 ViewModel 只增加依赖不增加正确性。
 */
class ChatViewModel {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** 一条界面消息。streaming=true 时气泡显示"正在输出"。 */
    data class Msg(val role: String, val text: String, val streaming: Boolean = false)

    var status: String by mutableStateOf("")
        private set
    var sessionReady: Boolean by mutableStateOf(false)
        private set
    var busy: Boolean by mutableStateOf(false)
        private set
    var messages: List<Msg> by mutableStateOf(emptyList())
        private set

    private var client: DshClient? = null
    private var sessionId: String? = null
    private var initJob: Job? = null

    /**
     * 引擎就绪后调用：建客户端、开会话、订阅事件。
     * 幂等——重复调用不会重建会话。
     */
    fun onEngineReady(port: Int) {
        if (initJob?.isActive == true || sessionReady) return
        initJob = scope.launch {
            try {
                status = "连接内核…"
                val c = DshClient(port, scope)
                client = c

                if (!c.ping()) {
                    status = "内核未响应 host.describe"
                    return@launch
                }
                c.connect()

                status = "创建会话…"
                // 默认用 question（提问式占卜）：这是普算的主场交互模式，
                // 会在需要用户补充现实信息时主动提问。可在设置里换成 standard。
                val sid = c.createSession(agentPreset = DEFAULT_PRESET)
                sessionId = sid
                sessionReady = true
                status = ""

                // 事件只作触发器：收到本会话事件就刷新一次历史
                scope.launch {
                    c.events.collect { frame ->
                        val type = frame["type"]?.jsonPrimitive?.contentOrNull
                        if (type == "session/event") {
                            val frameSid = frame["sessionId"]?.jsonPrimitive?.contentOrNull
                            if (frameSid == null || frameSid == sessionId) refreshHistory()
                        }
                    }
                }

                refreshHistory()
            } catch (e: Exception) {
                Log.e(TAG, "初始化失败", e)
                status = "初始化失败：${e.message}"
            }
        }
    }

    /** 从内核拉取会话历史并刷新界面。 */
    fun refreshHistory() {
        val c = client ?: return
        val sid = sessionId ?: return
        scope.launch {
            try {
                val res = c.history(sid)
                val list = extractMessages(res)
                if (list.isNotEmpty()) messages = list
            } catch (e: Exception) {
                Log.w(TAG, "拉取历史失败: ${e.message}")
            }
        }
    }

    /** 发一条用户消息。 */
    fun send(text: String) {
        val c = client ?: return
        val sid = sessionId ?: return
        if (busy) return

        // 乐观上屏，避免等待内核往返造成输入无反馈
        messages = messages + Msg("user", text)
        busy = true
        status = ""

        scope.launch {
            try {
                c.prompt(sid, text, mode = "queue", clientTimeZone = null)
                awaitTurnEnd(c, sid)
            } catch (e: Exception) {
                Log.e(TAG, "发送失败", e)
                status = "发送失败：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    /** 打断当前回合。 */
    fun cancel() {
        val c = client ?: return
        val sid = sessionId ?: return
        scope.launch {
            try {
                c.cancel(sid)
                status = "已停止"
                refreshHistory()
            } catch (e: Exception) {
                status = "停止失败：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    /**
     * 轮询到本轮结束。
     *
     * 判定方式保守：历史连续 [STABLE_TICKS] 次没有变化就认为停稳。
     * 不依赖会话的 running 标志——那属于内核内部状态，不是公开契约。
     */
    private suspend fun awaitTurnEnd(c: DshClient, sid: String) {
        var lastSize = -1
        var stable = 0
        val deadline = System.currentTimeMillis() + TURN_TIMEOUT_MS

        while (System.currentTimeMillis() < deadline) {
            delay(POLL_INTERVAL_MS)
            val n = try {
                val list = extractMessages(c.history(sid))
                if (list.isNotEmpty()) {
                    messages = list.map { it.copy(streaming = false) }
                }
                list.size
            } catch (e: Exception) {
                lastSize
            }
            if (n == lastSize) stable++ else { stable = 0; lastSize = n }
            if (stable >= STABLE_TICKS) return
        }
        Log.w(TAG, "等待回合结束超时")
    }

    // ── 历史解析 ────────────────────────────────────────────────────────────

    /**
     * 从 session.history 的响应里取出对话消息。
     *
     * 实测的响应形状（设备上确认）：
     *   {events: [{type, seq, time, data}], hasMore, projections}
     * 消息不在 `messages` 字段，而是以**会话日志事件**形式排在 events 里：
     *   - "user/message"      data 即消息对象（含 content 块数组）
     *   - "assistant/message" data = {turn, step, message:{content:[…]}, usage?}
     */
    private fun extractMessages(res: JsonObject): List<Msg> {
        val events = res["events"] as? JsonArray ?: return emptyList()
        val out = ArrayList<Msg>(events.size)
        for (el in events) {
            val ev = el as? JsonObject ?: continue
            val type = ev["type"]?.jsonPrimitive?.contentOrNull ?: continue
            val role = when (type) {
                "user/message" -> "user"
                "assistant/message" -> "assistant"
                else -> continue
            }
            val data = ev["data"] as? JsonObject ?: continue
            // assistant/message 把消息包在 message 下；user/message 直接就是消息本身
            val msg = (data["message"] as? JsonObject) ?: data
            val text = renderContent(msg["content"])
            if (text.isNotEmpty()) out.add(Msg(role, text))
        }
        return out
    }

    /** content 可能是字符串，也可能是内容块数组；只拼出应展示给用户的正文。 */
    private fun renderContent(el: JsonElement?): String = when (el) {
        null -> ""
        is JsonPrimitive -> el.contentOrNull.orEmpty()
        is JsonArray -> el.mapNotNull { part ->
            when (part) {
                is JsonPrimitive -> part.contentOrNull
                is JsonObject -> {
                    // 内容块用 type 区分（text / tool-call / reasoning …）。
                    // 只有 text 块是正文；其余（工具调用、思考）不进消息列表，
                    // 否则工具参数会被当成回答展示给用户。
                    val t = part["type"]?.jsonPrimitive?.contentOrNull
                    if (t == "text") part["text"]?.jsonPrimitive?.contentOrNull else null
                }
                else -> null
            }
        }.joinToString("")
        else -> ""
    }

    private companion object {
        const val TAG = "PusuanChat"

        /** 默认预设：提问式占卜。 */
        const val DEFAULT_PRESET = "question"

        const val POLL_INTERVAL_MS = 900L
        const val STABLE_TICKS = 3
        const val TURN_TIMEOUT_MS = 10 * 60 * 1000L
    }
}
