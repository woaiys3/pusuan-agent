package com.pusuan.engine

import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * 引擎管理器：把内嵌 payload 解压出来，然后拉起 DSH 内核（node）。
 *
 * 为什么内核要以独立进程跑：它是原生 node 可执行文件 + 完整 DSH 运行时，
 * 和 UI 进程的 GC/ANR 约束不兼容；另外进程隔离也让引擎崩了不必带着 UI 一起死。
 *
 * 为什么必须 targetSdk 28：Android 从 29 起给应用私有目录挂 noexec，
 * 内核的 bin/node 是随 APK 分发的可执行文件，届时直接 exec 失败。
 */
class EngineManager(private val context: Context) {

    /**
     * 引擎状态，供 UI 与前台通知观察。
     *
     * Starting 带一句步骤文案：首次启动要先解压约 269MB 的 payload 再拉内核，
     * 可能耗时一分钟以上，没有进度提示用户会以为卡死。
     */
    sealed interface EngineState {
        data object Idle : EngineState
        data class Starting(val step: String) : EngineState
        data class Running(val port: Int) : EngineState
        data class Failed(val message: String) : EngineState
    }

    companion object {
        private const val TAG = "PusuanEngine"

        /** 内核监听端口。回环地址，仅本机可达。 */
        const val PORT = 3080

        /**
         * payload 内容版本。payload 内容或布局变化时必须递增，
         * 否则已安装的设备会继续用旧的解压结果。
         *
         * 2：加入 Android 适配（原生模块桩 + 平台清理 + home 层补丁）。
         */
        private const val PAYLOAD_VERSION = "2"

        private const val READY_TIMEOUT_MS = 120_000L
    }

    private val root = File(context.filesDir, "payload")
    private val kernelDir = File(root, "kernel")
    private val dshHome = File(context.filesDir, "dshhome")
    private val versionStamp = File(root, ".version")

    @Volatile
    private var process: Process? = null

    private val _state = MutableStateFlow<EngineState>(EngineState.Idle)
    val state: StateFlow<EngineState> = _state.asStateFlow()

    val baseUrl: String get() = "http://127.0.0.1:$PORT"
    val homeDir: File get() = dshHome
    val logFile: File get() = File(dshHome, "engine.log")

    // ─────────────────────────────────────────────────────────────
    // 启动
    // ─────────────────────────────────────────────────────────────

    /**
     * 幂等启动：已在运行则直接返回 true。
     * @param onProgress 步骤回调，用于前台通知/界面展示长耗时的进展。
     */
    suspend fun ensureReady(onProgress: (String) -> Unit = {}): Boolean = withContext(Dispatchers.IO) {
        if (process?.isAlive == true) return@withContext true
        try {
            step("解压内核…", onProgress)
            extractIfNeeded(onProgress)

            val rt = pickRuntime() ?: run {
                val msg = "payload 中没有匹配本机 ABI 的运行时；设备 ABI=${Build.SUPPORTED_ABIS.joinToString()}"
                Log.e(TAG, msg)
                _state.value = EngineState.Failed(msg)
                return@withContext false
            }

            step("启动引擎…", onProgress)
            launchNode(rt)

            if (waitReady()) {
                _state.value = EngineState.Running(PORT)
                onProgress("引擎运行中 · 端口 $PORT")
                true
            } else {
                val tail = logTail()
                _state.value = EngineState.Failed("引擎在 ${READY_TIMEOUT_MS / 1000}s 内未就绪。日志尾部：\n$tail")
                onProgress("引擎启动失败")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "引擎启动失败", e)
            _state.value = EngineState.Failed(e.message ?: e.toString())
            onProgress("引擎启动失败")
            false
        }
    }

    /** 同时更新状态流与进度回调，避免两处文案漂移。 */
    private fun step(text: String, onProgress: (String) -> Unit) {
        _state.value = EngineState.Starting(text)
        onProgress(text)
    }

    /**
     * 选择与本机匹配的运行时目录。
     * 按 SUPPORTED_ABIS 顺序找第一个实际存在 bin/node 的 ABI。
     */
    private fun pickRuntime(): File? {
        for (abi in Build.SUPPORTED_ABIS) {
            val dir = File(root, "runtime/$abi")
            if (File(dir, "bin/node").exists()) return dir
        }
        return null
    }

    /** 拉起 node 进程运行 DSH 内核。 */
    private fun launchNode(rt: File) {
        val node = File(rt, "bin/node")
        node.setExecutable(true, false)

        val binDir = File(rt, "bin")
        val libDir = File(rt, "lib")
        // 内核自带的辅助工具（rg 等）也要可执行
        binDir.listFiles()?.forEach { it.setExecutable(true, false) }

        dshHome.mkdirs()
        installHomePatch()

        val cmd = listOf(
            node.absolutePath,
            // --expose-internals：内核的 Web 表层会在运行时动态挂载一个 cordis HMR
            // 实例（id 是哈希，无法用 YAML 禁用），它构造时需要 node 的内部模块，
            // 否则报 "--expose-internals is required for HMR service" 并中断启动。
            "--expose-internals",
            File(kernelDir, "lib/bin.js").absolutePath,
            "--profile", "web",
            "--host", "127.0.0.1",
            "--port", PORT.toString(),
            "--no-open",
        )

        Log.i(TAG, "启动内核: ${cmd.joinToString(" ")}")

        val pb = ProcessBuilder(cmd)
            .directory(kernelDir)
            .redirectErrorStream(true)

        pb.environment().apply {
            // node 的动态库（libicu/libssl/libc++_shared 等）在 runtime/<abi>/lib，
            // 不设这一项 node 会以 "library not found" 直接退出。
            put("LD_LIBRARY_PATH", libDir.absolutePath)
            put("PATH", "${binDir.absolutePath}:/system/bin")
            put("DSH_HOME", dshHome.absolutePath)
            put("HOME", context.filesDir.absolutePath)
            put("TMPDIR", context.cacheDir.absolutePath)
            // 关掉遥测，移动端没有必要外发
            put("DSH_TELEMETRY_DISABLED", "1")
        }

        val p = pb.start()
        process = p

        // 内核日志是排查启动失败的唯一线索，转发到文件与 logcat
        Thread({
            try {
                p.inputStream.bufferedReader().useLines { lines ->
                    logFile.outputStream().bufferedWriter().use { out ->
                        lines.forEach { line ->
                            out.write(line); out.newLine(); out.flush()
                            Log.i(TAG, line)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "日志转发结束: ${e.message}")
            }
        }, "pusuan-engine-log").apply { isDaemon = true }.start()
    }

    /** 轮询内核的 HTTP 端口，直到返回 200。 */
    private suspend fun waitReady(): Boolean {
        val deadline = System.currentTimeMillis() + READY_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (process?.isAlive != true) {
                Log.e(TAG, "node 进程已退出，退出码=${process?.exitValue()}")
                return false
            }
            if (probe()) return true
            delay(500)
        }
        return false
    }

    private fun probe(): Boolean = try {
        val conn = URL("$baseUrl/").openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code == 200
    } catch (e: Exception) {
        false
    }

    fun stop() {
        process?.let {
            Log.i(TAG, "停止内核")
            it.destroy()
        }
        process = null
        _state.value = EngineState.Idle
    }

    private fun logTail(lines: Int = 25): String = try {
        if (!logFile.exists()) "(无日志)"
        else logFile.readLines().takeLast(lines).joinToString("\n")
    } catch (e: Exception) {
        "(日志读取失败: ${e.message})"
    }

    /**
     * 把随 APK 分发的 Android 适配补丁写进 $DSH_HOME。
     *
     * 内核会把 $DSH_HOME/cordis.patch.yml 当作 home 层叠到配置树上（优先级高于 profile 层）。
     * 补丁内容（禁用 sandbox/permission/hmr、改用 bash-local 提供 shell）与理由
     * 都写在文件自身的注释里；这里只负责就位。
     *
     * 策略：只要内容不同就覆盖 —— 补丁随 APK 版本走，用户不应被旧补丁卡住。
     */
    private fun installHomePatch() {
        val target = File(dshHome, "cordis.patch.yml")
        try {
            val wanted = context.assets.open("dsh-home/cordis.patch.yml")
                .bufferedReader().use { it.readText() }
            val current = if (target.exists()) target.readText() else null
            if (current != wanted) {
                target.writeText(wanted)
                Log.i(TAG, "已写入 Android 适配补丁（${wanted.length} 字符）")
            }
        } catch (e: Exception) {
            // 补丁缺失不致命但会导致内核起不来，所以要说清楚
            Log.e(TAG, "写入适配补丁失败：${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────
    // payload 解压
    // ─────────────────────────────────────────────────────────────

    /** 首次启动或 payload 版本变化时解压；否则跳过（解压 270MB 不值得每次做）。 */
    private fun extractIfNeeded(onProgress: (String) -> Unit = {}) {
        val stampOk = versionStamp.exists() && versionStamp.readText().trim() == PAYLOAD_VERSION
        if (stampOk && File(kernelDir, "lib/bin.js").exists()) {
            Log.i(TAG, "payload 已就绪，跳过解压")
            return
        }

        Log.i(TAG, "解压 payload…")
        if (root.exists()) root.deleteRecursively()
        root.mkdirs()

        var count = 0
        context.assets.open("payload.zip").use { input ->
            ZipInputStream(input.buffered(1 shl 16)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val out = File(root, entry.name)

                    // zip 条目路径可能越界，做一次规范化防御
                    if (!out.canonicalPath.startsWith(root.canonicalPath)) {
                        zip.closeEntry(); continue
                    }

                    if (entry.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        FileOutputStream(out).use { fos -> zip.copyTo(fos, 1 shl 16) }
                        // zip 不保留 Unix 权限位，node 等可执行文件必须补上
                        if (entry.name.contains("/bin/") || entry.name.endsWith("/node")) {
                            out.setExecutable(true, false)
                        }
                        count++
                        if (count % 2000 == 0) step("解压内核… $count 个文件", onProgress)
                    }
                    zip.closeEntry()
                }
            }
        }

        versionStamp.writeText(PAYLOAD_VERSION)
        Log.i(TAG, "payload 解压完成，共 $count 个文件")
    }
}
