package com.pusuan.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.pusuan.MainActivity
import com.pusuan.PusuanApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 引擎前台服务。
 *
 * 为什么要前台服务：payload 解压 + node 启动要几十秒，且引擎必须在界面退到后台后
 * 继续跑（AI 回答可能很长）。普通 Service 会被系统快速回收，前台服务带常驻通知才稳。
 */
class EngineService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 必须在 5 秒内调用 startForeground，否则 ANR
        startForeground(NOTIF_ID, buildNotification("正在启动引擎…"))

        scope.launch {
            val engine = PusuanApp.engine
            engine.ensureReady { text ->
                runCatching { notify(buildNotification(text)) }
                    .onFailure { Log.w(PusuanApp.TAG, "更新通知失败", it) }
            }
            val st = engine.state.value
            notify(
                when (st) {
                    is EngineManager.EngineState.Running -> buildNotification("引擎运行中 · 端口 ${st.port}")
                    is EngineManager.EngineState.Failed -> buildNotification("引擎启动失败：${st.message}")
                    else -> buildNotification("等待引擎")
                }
            )
        }
        // 被系统杀掉后重建时不要重放上次的 Intent
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "普算引擎", NotificationManager.IMPORTANCE_LOW).apply {
                description = "引擎运行状态"
                setShowBadge(false)
            }
        )
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return b.setContentTitle("普算")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    @Suppress("DEPRECATION")
    private fun notify(n: Notification) {
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        runCatching { mgr.notify(NOTIF_ID, n) }
    }

    companion object {
        private const val CHANNEL_ID = "pusuan_engine"
        private const val NOTIF_ID = 1001

        fun start(ctx: Context) {
            val i = Intent(ctx, EngineService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }
    }
}
