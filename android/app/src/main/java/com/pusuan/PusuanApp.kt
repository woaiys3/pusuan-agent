package com.pusuan

import android.app.Application
import android.util.Log
import com.pusuan.engine.EngineManager

/**
 * 应用入口。
 *
 * 这里只持有随时可用的单例，不做重活：payload 解压与 node 启动都要几十秒，
 * 必须放在前台服务里，否则一进 Activity 就 ANR。
 */
class PusuanApp : Application() {

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "普算启动，包名=$packageName")
    }

    companion object {
        const val TAG = "Pusuan"

        lateinit var instance: PusuanApp
            private set

        val engine: EngineManager by lazy { EngineManager(instance) }
    }
}
