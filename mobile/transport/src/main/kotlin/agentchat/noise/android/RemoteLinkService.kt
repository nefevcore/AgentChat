// ============================================================
// RemoteLinkService —— 远程链路前台服务（M3.3）
//
// 方案 §4.4「锁」行：生物识别解锁才连 relay；切后台即断开。
// Android 的现实约束：Activity 后台后系统随时可回收进程，而 relay 连接与
// 回环桥要活到「用户切回来」为止。故用**前台服务**持有：
//   · 通知栏常驻（用户可见 = 系统不杀 + 用户知情链路开着）；
//   · 切后台由 Activity 调 stop()（锁行语义）；
//   · 返回 START_NOT_STICKY：进程被杀后不该悄悄复活一条远程链路。
//
// 启动分支：已配对（有 deviceId）→ resumeOnline()（KK 重连）；
// 未配对 → 停在 IDLE，由配对界面（M3.3 配对面）驱动 startPairing。
// ============================================================
package agentchat.noise.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.agentchat.mobile.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class RemoteLinkService : Service() {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification("准备中…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopSelf()
            // 回前台（cr-109）：Activity onStart 唤起——解锁保活回落 + 兜底链路自愈
            ACTION_RESUME -> {
                ensureSession()
                SessionHolder.session?.onAppForeground()
            }
            else -> ensureSession()
        }
        return START_NOT_STICKY
    }

    /** 幂等：服务重复 start（Activity 重建）时不重建会话 */
    private fun ensureSession() {
        if (SessionHolder.session != null) return
        // 构建标识：adb install -r 在部分 adb/Windows 组合下**不真正替换** APK，
        // 导致真机跑旧代码却看新源码排障（M3.3 实测踩了两次）。有这行就能一眼确认。
        println("AgentChatMobile build " + BuildConfig.BUILD_TAG)
        // 平台密码学能力一次性入日志：Android 的 JCA 算法名注册集与桌面 JDK 不同，
        // 真机兼容性问题只能实测（M3.3 实测：X25519 在部分 Android 上无 KeyPairGenerator）。
        // 保留此日志——换设备/刷系统后的第一个排查锚点。
        println(agentchat.noise.probeX25519Support())
        val s = RemoteSession(applicationContext, WebuiAssets.ensure(applicationContext))
        SessionHolder.session = s
        scope.launch {
            // 已配对 → 直接 KK 重连；未配对 → 留在 IDLE 等配对面驱动
            val store = PairingStore(applicationContext)
            if (store.paired && store.deviceId != null) {
                s.resumeOnline() // 失败由退避循环接管，通知文案交给下面的状态流
            }
            // 通知 = 状态流投影（cr-109）：链路状态变化即更新——后台保活期用户靠它
            // 知道链路死活（「已连接 · 后台保活中」/「连接中…」/「未配对」）。
            s.state.collect { st ->
                val text = when {
                    st.backgroundHold -> "已连接 · 后台保活中"
                    st.phase == LinkPhase.ONLINE -> "已连接"
                    st.phase == LinkPhase.CONNECTING -> "连接中…"
                    st.phase == LinkPhase.AWAIT_CONFIRM -> "等待配对确认"
                    st.phase == LinkPhase.ERROR -> "连接断开（打开应用重试）"
                    else -> "未配对"
                }
                notify(buildNotification(text))
            }
        }
    }

    override fun onDestroy() {
        SessionHolder.session?.dispose()
        SessionHolder.session = null
        scope.cancel()
        super.onDestroy()
    }

    // ---- 通知 ----

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "远程链路", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        return builder
            .setContentTitle("AgentChat")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun notify(n: Notification) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
    }

    companion object {
        const val ACTION_STOP = "agentchat.remote.STOP"
        const val ACTION_RESUME = "agentchat.remote.RESUME"
        private const val CHANNEL_ID = "agentchat.remote.link"
        private const val NOTIFICATION_ID = 4711

        fun start(context: Context) {
            context.startForegroundService(Intent(context, RemoteLinkService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, RemoteLinkService::class.java).setAction(ACTION_STOP))
        }

        /** 回前台通知（cr-109：释放保活锁 + 兜底链路自愈） */
        fun resume(context: Context) {
            runCatching { context.startService(Intent(context, RemoteLinkService::class.java).setAction(ACTION_RESUME)) }
        }
    }
}

/** 服务与 Activity/Plugin 共享的会话引用（同进程，故用静态引用） */
object SessionHolder {
    @Volatile var session: RemoteSession? = null
}
