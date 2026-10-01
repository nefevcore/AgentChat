// ============================================================
// MainActivity —— 安卓单 App 的装配点（M3.3）
//
// 两种启动形态（据 PairingStore 判定）：
//   · 已配对：启前台服务 → 等回环桥就绪 → WebView 加载桥（http://127.0.0.1:<port>）
//     —— 与本地开发完全同构，webui 零改动（方案 §4.4「UI」行）；
//   · 未配对：显示配对面板（粘贴/深链二维码 URI → XK 握手 → 显示 SAS → 等核心端确认）。
//
// 切后台即断开（方案「锁」行，丢机缓解纵深）：onStop 停服务会话。
// ============================================================
package com.agentchat.mobile

import agentchat.noise.VersionChecker
import agentchat.noise.VersionInfo
import agentchat.noise.android.BiometricGate
import agentchat.noise.android.ScanActivity
import agentchat.noise.android.LinkPhase
import agentchat.noise.android.PairingStore
import agentchat.noise.android.RemoteLinkService
import agentchat.noise.android.SessionHolder
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.lifecycle.lifecycleScope
import com.getcapacitor.BridgeActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : BridgeActivity() {

    private companion object {
        const val SCAN_REQ = 7043
    }

    private var panel: LinearLayout? = null
    private var statusView: TextView? = null
    private var sasView: TextView? = null
    private var loadedBridge = false
    /** 已加载的桥端口（0=未加载；变化即重载——桥异常重启时端口会换） */
    private var loadedPort = 0
    /** 曾 ONLINE 过（CONNECTING 防抖：短暂断线不弹全屏覆盖层——秒级自愈的闪断闪屏根因） */
    private var wasOnline = false
    private var watchJob: Job? = null
    private var updateBar: TextView? = null
    private var pairingInput: EditText? = null
    /** 连接期全屏状态覆盖层（cr-43 ⑫：WebView 未加载时给用户可视反馈，免黑屏盲等） */
    private var connectOverlay: android.widget.FrameLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // WebView CDP 调试口（debug 构建）——真机 UI 自动化/现场排障用：
        // chrome://inspect → agentchat WebView。仅 debug 生效，不进 release。
        if (BuildConfig.DEBUG) android.webkit.WebView.setWebContentsDebuggingEnabled(true)
        val store = PairingStore(this)
        val deepLink = intent?.data?.toString()
        // 更新检查与配对状态无关：**任何**启动形态下都该知道有没有新版（M3.5）
        checkForUpdate()

        if (store.paired && store.deviceId != null) {
            // 「锁」行第一步：生物识别解锁**才**连 relay（顺序即语义——没解锁就没链路）
            gateAndLoad()
        } else {
            // 未配对：**总是**建面板（深链路径也要能看到进度与 SAS——否则用户
            // 扫码后毫无反馈）。有深链则预填并自动开配。
            showPairingPanel(deepLink)
            if (deepLink != null && deepLink.startsWith("agentchat://pair")) {
                startAndLoad()
                lifecycleScope.launch { pairWith(deepLink) }
            }
        }
    }

    /**
     * Android 返回键（cr-29 Phase①）：先问 WebView UI 是否消费——
     * 会话页 push 态/全屏覆盖层开着时由 webui 关闭之（栈式导航），
     * 未消费才退后台（moveTaskToBack——不 finish，链路不断）。
     * 配对面板期（WebView 未加载）直接退后台。
     */
    override fun onBackPressed() {
        val webView = bridge?.webView
        if (webView == null) { moveTaskToBack(true); return }
        // 双通道（cr-43 真机实锤：WebView 加载失败/崩溃态 evaluateJavascript 永不回调，
        // 返回键失灵黑屏困死）——JS 应答 + 600ms 超时兜底，谁先到谁算；两通道都
        // 幂等（moveTaskToBack 重复无害）。
        var settled = false
        android.os.Handler(mainLooper).postDelayed({ if (!settled) { settled = true; moveTaskToBack(true) } }, 600)
        webView.evaluateJavascript("(window.__agentchatBack && window.__agentchatBack().handled) === true") { handled ->
            if (!settled) {
                settled = true
                if (handled != "true") moveTaskToBack(true)
            }
        }
    }

    /** 扫码回填（cr-43 ③）：ScanActivity RESULT_OK → 回填输入框并直接开配（扫码本身即用户意图） */
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != SCAN_REQ || resultCode != RESULT_OK) return
        val uri = data?.getStringExtra(ScanActivity.EXTRA_RESULT_URI) ?: return
        pairingInput?.setText(uri)
        startAndLoad()
        lifecycleScope.launch { pairWith(uri) }
    }

    private fun scanForPairing() {
        startActivityForResult(Intent(this, ScanActivity::class.java), SCAN_REQ)
    }

    /** 系统扫到 agentchat://pair 再次唤起（应用已在栈中） */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val uri = intent.data?.toString() ?: return
        if (uri.startsWith("agentchat://pair")) {
            // 配对路径同样要过锁（扫码本身是用户在场动作，但链路不该在锁前建立）
            gateAndLoad()
            lifecycleScope.launch { pairWith(uri) }
        }
    }

    /**
     * 过生物识别门再起链路（M3.4「锁」行）。
     *
     * 降级策略在 BiometricGate 内（无硬件/未录入 → 记日志放行）——设备不可用
     * 比「锁没开」更糟，故降级是显式的、可见的。
     */
    private fun gateAndLoad() {
        // debug 构建跳过生物锁（M3 真机自动化验证：无人在场时反复冷启/重连不被
        // 指纹门挡住；release 构建不受影响，A/B 开关语义全部保留）
        if (BuildConfig.DEBUG) { startAndLoad(); return }
        BiometricGate.request(
            this,
            "解锁 AgentChat",
            onUnlocked = { startAndLoad() },
            onDenied = { msg ->
                setStatus("已取消解锁：" + msg)
                // 面板被取消时不建链路——用户可在配对面板点「开始配对」重试
                showPairingPanel(null)
            },
            // 生物锁开关（默认开 = 方案 A；用户可在设置区关闭 = 方案 B，自担丢机风险）
            enabled = PairingStore(this).biometricLockEnabled,
        )
    }

    // ---- 在线路径 ----

    private fun startAndLoad() {
        RemoteLinkService.start(this)
        watchJob?.cancel()
        watchJob = lifecycleScope.launch {
            // 等服务把会话装起来（服务 onCreate/ensureSession 是异步的）
            var waited = 0
            while (SessionHolder.session == null && waited < 10_000) {
                delay(100)
                waited += 100
            }
            val session = SessionHolder.session ?: run {
                setStatus("服务未启动")
                return@launch
            }
            session.state.collect { st ->
                when (st.phase) {
                    LinkPhase.ONLINE -> {
                        val port = st.bridgePort
                        // 端口变化即重载（cr-43：链路抖动重建桥后端口已换——原一次性
                        // loadedBridge 门闩让二次会合后 WebView 停留在死端口白屏）。
                        // cr-49 桥与链路解耦后重连不再换端口——此分支只在桥真重启时触发。
                        if (port != null && port != loadedPort) {
                            loadedBridge = true
                            loadedPort = port
                            wasOnline = true
                            setStatus(null)
                            hidePanel()
                            hideConnectOverlay()
                            bridge?.webView?.loadUrl("http://127.0.0.1:$port/")
                        }
                    }
                    LinkPhase.CONNECTING -> {
                        setStatusIfPanel("连接中…")
                        // 防抖（cr-49）：曾 ONLINE 过的短暂断线秒级自愈——全屏覆盖层
                        // 只会闪一下眼，不弹；首次连接仍弹（用户需要反馈）。
                        if (!wasOnline) showConnectOverlay("正在连接你的电脑…")
                    }
                    LinkPhase.AWAIT_CONFIRM -> {
                        setStatusIfPanel("请在核心端确认短码")
                        showConnectOverlay("请在电脑端核对短码", showUnpair = false)
                        showSas(st.sas)
                    }
                    LinkPhase.ERROR -> {
                        // 终态（cr-43 ⑪：重连超上限/对端移除）——黑屏静默不可接受，
                        // 覆盖层给文案 + 解除配对出口。
                        setStatus(st.message ?: "连接失败")
                        showConnectOverlay(st.message ?: "连接失败")
                    }
                    LinkPhase.IDLE -> Unit
                }
            }
        }
    }

    // ---- 配对路径 ----

    private fun showPairingPanel(initialUri: String? = null) {
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
            setBackgroundColor(Color.parseColor("#0B1020"))
        }
        root.addView(TextView(this).apply {
            text = "连接你的电脑"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
        }, lp)
        root.addView(TextView(this).apply {
            text = "在电脑端 AgentChat 打开「远程设备」→ 添加设备，然后扫码（或把二维码链接粘贴到下方）。"
            setTextColor(Color.parseColor("#9AA4BF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(8), 0, dp(16))
        }, lp)

        val input = EditText(this).apply {
            hint = "agentchat://pair?... "
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#5A6480"))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setBackgroundColor(Color.parseColor("#141A2E"))
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        if (!initialUri.isNullOrEmpty()) input.setText(initialUri)
        pairingInput = input
        root.addView(input, lp)

        // 扫码按钮（cr-43 ③：App 自带扫码——扫得 URI 自动回填配对，免跳微信/系统相机）
        root.addView(Button(this).apply {
            text = "扫码"
            setOnClickListener { scanForPairing() }
        }, lp)

        root.addView(Button(this).apply {
            text = "开始配对"
            setOnClickListener {
                val uri = input.text.toString().trim()
                if (uri.isEmpty()) { setStatus("请先扫码或粘贴二维码链接"); return@setOnClickListener }
                startAndLoad()
                lifecycleScope.launch { pairWith(uri) }
            }
        }, lp)

        // 已配对态区块（cr-43 ⑪：核心端移除设备/长期连不上时的自救出口——
        // 未配对时隐藏，不留死胡同）
        val storeEarly = PairingStore(this)
        if (storeEarly.paired) {
            root.addView(Button(this).apply {
                text = "重试连接"
                setOnClickListener { startAndLoad() }
            }, lp)
            root.addView(Button(this).apply {
                text = "解除配对并重新开始"
                setOnClickListener { confirmUnpair() }
            }, lp)
        }

        sasView = TextView(this).apply {
            setTextColor(Color.parseColor("#7FD1FF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 34f)
            gravity = Gravity.CENTER
            setPadding(0, dp(20), 0, dp(4))
            visibility = TextView.GONE
        }
        root.addView(sasView, lp)

        // 生物锁开关（默认开 = 方案 A；关 = 方案 B「跳过解锁直接连接」，自担丢机风险）
        val store = PairingStore(this)
        root.addView(android.widget.CheckBox(this).apply {
            text = "生物识别解锁（丢机保护）"
            setTextColor(Color.parseColor("#9AA4BF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            isChecked = store.biometricLockEnabled
            setOnCheckedChangeListener { _, checked ->
                if (!checked) {
                    android.app.AlertDialog.Builder(this@MainActivity)
                        .setTitle("关闭丢机保护？")
                        .setMessage("关闭后打开 App 将直接连接核心端，不再要求生物识别。\n\n若手机在解锁状态下被他人拿走，对方可直接查看你的全部会话。")
                        .setPositiveButton("仍然关闭") { _, _ ->
                            store.biometricLockEnabled = false
                        }
                        .setNegativeButton("保留") { _, _ -> isChecked = true }
                        .show()
                } else {
                    store.biometricLockEnabled = true
                }
            }
        }, lp)

        statusView = TextView(this).apply {
            setTextColor(Color.parseColor("#C9D2E8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(8), 0, 0)
        }
        root.addView(statusView, lp)

        val host = FrameLayout(this)
        host.addView(root)
        panel = root
        addContentView(
            host,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
    }

    /** 配对的幂等标记：onCreate 与 onNewIntent 可能针对同一二维码各触发一次 */
    @Volatile private var pairingStarted = false

    private suspend fun pairWith(uri: String) {
        if (pairingStarted) return
        pairingStarted = true
        var waited = 0
        while (SessionHolder.session == null && waited < 10_000) {
            delay(100)
            waited += 100
        }
        val session = SessionHolder.session ?: run {
            android.util.Log.e("MainActivity", "服务未启动：SessionHolder 为空")
            setStatus("服务未启动")
            return
        }
        val name = PairingStore(this).deviceName
        runCatching {
            val sas = session.startPairing(uri, name)
            showSas(sas)
            setStatus("两端短码一致后，在电脑端点「一致」")
            // 等核心端确认：确认后核心端经加密通道下发 deviceId（KK 重连的必要输入），
            // 本调用返回后 state 转 ONLINE，由 watchJob 的 collect 加载回环桥。
            val ok = session.awaitPaired()
            if (ok) setStatus("已连接，正在加载…") else setStatus("核心端未确认（超时或已拒绝）")
        }.onFailure { err ->
            android.util.Log.e("MainActivity", "配对失败", err)
            setStatus("配对失败：" + (err.message ?: "未知"))
            pairingStarted = false // 允许重试
        }
    }

    // ---- 小工具 ----

    private fun showSas(sas: String?) {
        val v = sasView ?: return
        if (sas == null) { v.visibility = TextView.GONE; return }
        v.visibility = TextView.VISIBLE
        // 8 位数字分两段显示（人工比对更省力）
        v.text = if (sas.length == 8) sas.substring(0, 4) + "  " + sas.substring(4) else sas
    }

    private fun setStatus(text: String?) {
        val v = statusView ?: return
        v.text = text ?: ""
        v.visibility = if (text == null) TextView.GONE else TextView.VISIBLE
    }

    private fun setStatusIfPanel(text: String) {
        if (panel?.visibility == android.view.View.VISIBLE) setStatus(text)
    }

    private fun hidePanel() {
        panel?.visibility = android.view.View.GONE
    }

    // ---- 连接期状态覆盖层（cr-43 ⑫：WebView 未加载时的用户反馈面） ----

    private fun showConnectOverlay(message: String, showUnpair: Boolean = true) {
        if (connectOverlay != null) {
            // 已在显示——只更新文案
            (connectOverlay!!.findViewWithTag<TextView>("msg"))?.text = message
            return
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), 0, dp(32), 0)
            setBackgroundColor(Color.parseColor("#0B1020"))
        }
        root.addView(TextView(this).apply {
            text = "AgentChat"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val msg = TextView(this).apply {
            tag = "msg"
            text = message
            setTextColor(Color.parseColor("#9AA4BF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, 0)
        }
        root.addView(msg, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // 动态提示（呼吸点）——不引动画资源，文本省略号循环由系统 marquee 处理不必要，静态即可
        if (showUnpair && PairingStore(this).paired) {
            root.addView(Button(this).apply {
                text = "解除配对并重新开始"
                setOnClickListener { confirmUnpair() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(32)
                gravity = Gravity.CENTER_HORIZONTAL
            })
        }
        val host = FrameLayout(this)
        host.addView(root, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        addContentView(host, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        connectOverlay = host
    }

    private fun hideConnectOverlay() {
        val host = connectOverlay ?: return
        (host.parent as? ViewGroup)?.removeView(host)
        connectOverlay = null
    }

    /** 解除配对确认（cr-43 ⑪： irreversible 动作先确认）——清身份绑定 + 停链路 + 回扫码面 */
    private fun confirmUnpair() {
        android.app.AlertDialog.Builder(this)
            .setTitle("解除配对？")
            .setMessage("将清除本机与此电脑的配对信息。解除后需在电脑端重新扫码配对才能连接。")
            .setPositiveButton("解除") { _, _ ->
                PairingStore(this).clearPairing()
                SessionHolder.session?.stop()
                loadedBridge = false
                wasOnline = false
                // 重建面板（回到未配对形态——无解除/重试按钮）
                panel?.visibility = android.view.View.GONE
                (panel?.parent as? ViewGroup)?.removeView(panel)
                showPairingPanel(null)
                setStatus("已解除配对——请重新扫码")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun dp(v: Int): Int = ((v * resources.displayMetrics.density).toInt())

    override fun onStop() {
        // 方案「锁」行：切后台即断开（丢机缓解纵深）
        watchJob?.cancel()
        SessionHolder.session?.stop()
        super.onStop()
    }

    override fun onStart() {
        super.onStart()
        // 回前台自愈（cr-81）：两处「链路停摆、无人重拉」的恢复缺口——
        //   ① ERROR 终态（重连超 10 分钟上限后 startReconnectLoop 已退出）；
        //   ② 切后台 stop() 后的 IDLE（onStop 断链，原实现回前台无任何恢复路径，
        //     WebView 停在死桥上白屏 ERR_CONNECTION_REFUSED）。
        // 用户切回前台的意图就是「连上」。CONNECTING/AWAIT_CONFIRM/ONLINE 不动
        // （正在推进或已在线）；首启期 session 尚未建好（null）也自然跳过。
        // resumeOnline 必须显式调：startAndLoad 起服务后 ensureSession 见 session
        // 非空直接返回，链路不会被拉起。
        if (!PairingStore(this).paired) return
        val session = SessionHolder.session ?: return
        val phase = session.state.value.phase
        // watchJob 在跑 = startAndLoad 的状态流活着（服务侧 resumeOnline 也在途），
        // 不重复拉——并发双 dial 同房会占满 2 席把 PC 关在门外（relay 房间无属主）。
        // 只兜「链路停摆且无人看护」：watchJob 已死（onStop 取消/ERROR 后退出）。
        if ((phase == LinkPhase.ERROR || phase == LinkPhase.IDLE) && watchJob?.isActive != true) {
            startAndLoad()
            lifecycleScope.launch { session.resumeOnline() }
        }
    }

    // ---- 版本更新提醒（M3.5）----

    /**
     * 拉版本清单并判定。清单是**外部输入**，任何失败都只当「没检查到更新」
     * ——更新检查绝不该阻断启动或打扰用户。
     *
     * 日志是验收锚点（「版本更新提醒走通」由它判定）：本地 versionCode 与结论。
     */
    private fun checkForUpdate() {
        val url = BuildConfig.UPDATE_MANIFEST_URL
        if (url.isBlank()) return
        lifecycleScope.launch {
            // 失败必须可见：更新检查静默失败会让人以为「没新版本」，而真实原因
            // 可能是清单地址错/明文被拦/网络不通——三者排查方向完全不同。
            var info: VersionInfo? = null
            var err: String? = null
            withContext(Dispatchers.IO) {
                try {
                    info = VersionChecker(url).checkUpdate(BuildConfig.VERSION_CODE.toLong())
                } catch (t: Throwable) {
                    err = t.javaClass.simpleName + ": " + t.message
                }
            }
            android.util.Log.i(
                "AgentChatUpdate",
                "本地 versionCode=" + BuildConfig.VERSION_CODE + " (" + BuildConfig.VERSION_NAME + ")" +
                    " 清单=" + url + " 结论=" +
                    when {
                        err != null -> "检查失败（" + err + "）"
                        info != null -> "有新版本 " + info!!.version + " (code " + info!!.versionCode + ")"
                        else -> "已是最新"
                    },
            )
            if (info != null) showUpdateBar(info!!)
        }
    }

    /** 顶部提示条：有新版本才出现；点击进下载面（浏览器/系统下载器接管） */
    private fun showUpdateBar(info: VersionInfo) {
        if (updateBar != null) return
        val bar = TextView(this).apply {
            text = "有新版本 " + info.version + " · 点击下载"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#1E5AA8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            setOnClickListener {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.url))) }
            }
        }
        addContentView(
            bar,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ),
        )
        updateBar = bar
    }
}
