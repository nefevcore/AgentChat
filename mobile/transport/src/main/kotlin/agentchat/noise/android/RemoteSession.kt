// ============================================================
// RemoteSession —— Android 侧远程链路会话（M3.3/M3.4 的中枢）
//
// 职责（方案 §4.4「传输」「锁」行）：
//   · 持有 KeystoreIdentity（设备身份）；
//   · 配对：连 relay → XK 握手 → SAS 交给 UI 显示 → 用户在**核心端**比对确认 →
//     核心端经加密通道下发 {type:"remote/paired", data:{deviceId, scopes}} →
//     本类落库（deviceId 是 KK 重连房间派生的必需输入，手机无从自算）；
//   · 在线：起回环桥喂 WebView；断线后按 deviceId 派生房间做 KK 重连；
//   · 切后台即断开（锁行语义）——由 Service 生命周期调用 stop()。
//
// 入站帧分发：relay 链路上的下行帧有两类消费者——配对信令（本类）与
// WebView 业务帧（回环桥）。用单一分发器按类型分流，避免两处抢同一个回调。
// ============================================================
package agentchat.noise.android

import agentchat.noise.LoopbackBridge
import agentchat.noise.RelayClient
import agentchat.noise.StaticIdentity
import agentchat.noise.Upstream
import agentchat.noise.b64u
import agentchat.noise.unb64u
import android.content.Context
import android.os.PowerManager
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "AgentChatRemote"

/** 回环桥缺省固定端口（cr-56：稳定 origin 保 localStorage 分区；被占回退随机） */
private const val DEFAULT_BRIDGE_PORT = 27182

/**
 * KK 重连（发起方）的单轮尝试次数与重试间隔。
 *
 * 为什么需要重试：relay 只转发实时帧，m1 早于对端进房即丢失（见
 * RelayClient.KK_HANDSHAKE_TIMEOUT_MS 的根因说明）。单次尝试会与对端的退避
 * 相位错开而永久错过；短超时 + 快速重试让本端在对方的等待窗内多次"撞门"。
 *
 * 节奏取值受 relay join 频控约束：ac-relay-server DEFAULT_LIMITS.joinBucket
 * = burst 20 / 每分钟 30 次（per IP，cr-43 ⑬ 提容后），**每次重试都是一次新 join**。
 * 3s 握手超时 + 4s 间隔 ≈ 8.6s/轮 ≈ 7 次/分钟，留有余量不触顶
 * （早期实测用 1s 级重试会烧穿 bucket → relay 回 room-unavailable）。
 * 10 轮 ≈ 86s，覆盖核心端 70s 长驻 + 2s 间隙的完整循环。
 */
private const val KK_RECONNECT_ATTEMPTS = 10
// 4s（cr-63 会合提速：3s 超时 + 4s 间隔 ≈ 8.6s/轮 ≈ 7/min。cr-43 ⑬ 时代调 7s 的前提
// 〔频控 10/min、核心端 1s×10 连发〕已双双失效：频控现为 30/min（burst 20），核心端
// 改为 70s 长驻 + 2s 间隙（每 72s 一次 join）——双端合计 ~8/min，余量充足）
private const val KK_RETRY_DELAY_MS = 4_000L

/** 退避重连总时长上限（cr-43 ⑪：防「对端已移除设备」下的无限重连卡死） */
private const val RECONNECT_GIVE_UP_MS = 10 * 60_000L

/** 链路状态（UI 直接投影） */
enum class LinkPhase { IDLE, CONNECTING, AWAIT_CONFIRM, ONLINE, ERROR }

data class SessionState(
    val phase: LinkPhase = LinkPhase.IDLE,
    /** 待用户比对的双端短认证串（AWAIT_CONFIRM 期） */
    val sas: String? = null,
    val relayUrl: String? = null,
    val devicePubkey: String? = null,
    val deviceId: String? = null,
    /** 核心端授予的权限档（read/chat/files/admin） */
    val scopes: List<String> = emptyList(),
    /** 回环桥端口（ONLINE 期 WebView 的加载目标） */
    val bridgePort: Int? = null,
    /** 后台保活中（cr-109：链路活动期切后台持 CPU 部分锁不断链） */
    val backgroundHold: Boolean = false,
    val message: String? = null,
)

class RemoteSession(
    private val context: Context,
    private val staticDir: File?,
) {
    private val identityStore = KeystoreIdentity(context)
    private val pairing = PairingStore(context)
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val gson = Gson()

    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private var relay: RelayClient? = null
    private var bridge: LoopbackBridge? = null
    private var reconnectJob: Job? = null

    /**
     * 会话代数（cr-109 重连风暴修复）：stop() 递增。在途 KK 尝试循环逐轮校验，
     * 过期即自弃——stop 之后不再有残余 dial 撞门（真机 relay 日志实锤：切后台
     * 后仍每 ~15s join→1006 一分多钟，正是内层尝试循环不感知 stop 的残响）。
     */
    private val epoch = AtomicInteger(0)

    /** CPU 部分锁（cr-109 后台保活）：持锁期 = 后台链路活动期，见 updateWakeLock */
    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    private var wakeLock: PowerManager.WakeLock? = null

    /** 用户主动断开（切后台 / dispose）——置位后重连循环与 onClose 都不再拉新链 */
    @Volatile private var manualStop = false

    /** 回环桥的下行出口（bridge.start() 会写入；分发器转发非信令帧给它） */
    private var downlink: ((String) -> Unit)? = null

    /** 等核心端配对确认（remote/paired 帧） */
    @Volatile private var pairedWaiter: CompletableDeferred<JsonObject>? = null

    val identity: StaticIdentity by lazy { identityStore.load() }

    init {
        _state.value = _state.value.copy(
            devicePubkey = b64u(identity.publicKey),
            relayUrl = pairing.relayUrl,
            deviceId = pairing.deviceId,
            scopes = pairing.scopes,
        )
        // 链路状态投影到 WebView（cr-274）：桥与链路解耦（cr-49）后链路死而桥活，
        // webui 的 wire WS（连本地桥）无感断线——RPC 只会慢慢超时，无即时提示。
        // 状态流已是唯一事实源，此处把它以 remote/link-state 事件帧广播（remote/*
        // 是 wire-format 直发词汇，合法），webui 全局连接条消费。online 视为「无帧」
        // ——常态零噪音，只有离开 online 才需要打扰。
        scope.launch {
            _state.collect { st ->
                // online = 常态零噪音（webui 侧清除横幅）；CONNECTING/ERROR = 打横幅。
                // IDLE/AWAIT_CONFIRM 只出现在配对期与整链停止（WebView 未起或即将整页重载），不播。
                val phase = if (st.phase == LinkPhase.ONLINE) "online" else "reconnecting"
                if (st.phase == LinkPhase.ONLINE || st.phase == LinkPhase.CONNECTING || st.phase == LinkPhase.ERROR) {
                    bridge?.broadcast("{\"type\":\"remote/link-state\",\"data\":{\"args\":[\"$phase\"]}}")
                }
            }
        }
    }

    // ---- 配对 ----

    /**
     * 第一步：连 relay 做 XK 握手，产出 SAS。
     * 拿到后必须在 UI 上显示给用户——用户要在**核心端**对照同一串数字。
     */
    suspend fun startPairing(qrUri: String, deviceName: String): String {
        val kv = parseQr(qrUri)
        val relayUrl = kv["relay"] ?: throw IllegalArgumentException("二维码缺 relay")
        val room = kv["room"] ?: throw IllegalArgumentException("二维码缺 room")
        val corePub = kv["pk"] ?: throw IllegalArgumentException("二维码缺 pk")
        val tlsPin = kv["pin"] // cr-65：可选——部署方配了才带出
        // exp 校验（cr-65 配对面）：过期码拒绝——旧码重放是钓鱼面（攻击者出示
        // 历史截图诱导连到抢先占座的房间；过期即拒，配对面缩小到 TTL 内）
        kv["exp"]?.toLongOrNull()?.let { exp ->
            if (System.currentTimeMillis() > exp) throw IllegalArgumentException("二维码已过期——请刷新核心端重新生成")
        }

        _state.value = _state.value.copy(phase = LinkPhase.CONNECTING, relayUrl = relayUrl, message = null)
        Log.i(TAG, "startPairing relay=" + relayUrl + " room=" + room)
        val rc = RelayClient(tlsPin)
        rc.onPayload = { json -> dispatch(json) }
        // 原始帧观测（真机排障：区分「帧没到」与「到了没认出」）
        rc.onRaw = { raw -> Log.i(TAG, "RAW< " + raw.take(160)) }
        rc.onClose = { reason -> Log.w(TAG, "链路关闭: " + reason) }
        val sas = try {
            rc.pairAndHandshake(relayUrl, room, unb64u(corePub), identity, deviceName)
        } catch (e: Exception) {
            // 失败必须留痕：静默只更新 UI 时，真机排障无从下手（M3.3 实测教训）
            Log.e(TAG, "startPairing 失败：" + e, e)
            _state.value = _state.value.copy(phase = LinkPhase.ERROR, message = e.message)
            throw e
        }
        relay = rc
        pairing.savePairing(corePub, relayUrl, tlsPin)
        pairing.deviceName = deviceName
        _state.value = _state.value.copy(phase = LinkPhase.AWAIT_CONFIRM, sas = sas)
        return sas
    }

    /**
     * 第二步：等核心端确认（用户在核心端点「一致」后，核心端下发 remote/paired）。
     * 成功则落库 deviceId/scopes。超时返回 null（用户未确认 / SAS 不一致）。
     */
    suspend fun awaitPaired(timeoutMs: Long = 120_000): Boolean {
        val rc = relay ?: return false
        if (pairing.deviceId != null) return true // 已确认过（重复调用幂等）
        val waiter = CompletableDeferred<JsonObject>()
        pairedWaiter = waiter
        val got = withTimeoutOrNull(timeoutMs) { waiter.await() }
        pairedWaiter = null
        if (got == null) {
            _state.value = _state.value.copy(phase = LinkPhase.ERROR, message = "核心端未确认（超时）")
            return false
        }
        // 配对完成即接管断线：配对房会随任一方离线销毁，此后走 KK 重连
        // （此前 onClose 只打日志——配对完成后断线就永久掉线了）
        val cp = pairing.corePubkey
        val rid = pairing.deviceId
        val rurl = pairing.relayUrl
        if (cp != null && rid != null && rurl != null) {
            manualStop = false
            rc.onClose = { reason ->
                Log.w(TAG, "链路关闭: " + reason)
                // 只认现行链路（cr-109）：旧链残骸迟到的关闭不得触发重连
                if (!manualStop && relay === rc) startReconnectLoop(cp, rid, rurl)
            }
        }
        // 顺序要紧：先起桥拿到端口，再置 ONLINE——否则 UI 收到 ONLINE 时
        // bridgePort 仍为 null，加载分支永远不触发（实测踩坑）
        startBridge(rc)
        _state.value = _state.value.copy(
            phase = LinkPhase.ONLINE,
            deviceId = pairing.deviceId,
            scopes = pairing.scopes,
            bridgePort = bridge?.port ?: _state.value.bridgePort,
            message = null,
        )
        return true
    }

    /**
     * 已配对设备的启动路径：KK 重连（核心端未 connect 是常态——失败即退避重试）。
     *
     * 「断线重连」是本产品的基本语义（方案 §4.4 断线语义：真相源在核心端，
     * 手机离线期间消息全部入账，重连后补齐）——因此**一次失败不能停在 ERROR**：
     * 手机切回前台、核心端刚开机、relay 抖动，都要求自动恢复。
     */
    suspend fun resumeOnline(): Boolean {
        val corePub = pairing.corePubkey ?: return false
        val deviceId = pairing.deviceId ?: return false
        val relayUrl = pairing.relayUrl ?: return false
        // 去重（cr-109）：退避循环已在跑 = 链路有人看护，并发再跑一轮 tryReconnect
        // 会双循环同房互踩（双连接占满 2 席把 PC 关在门外）。等循环自己成功即可。
        if (reconnectJob?.isActive == true) return false
        manualStop = false
        val ok = tryReconnect(corePub, deviceId, relayUrl)
        if (!ok) startReconnectLoop(corePub, deviceId, relayUrl)
        return ok
    }

    /**
     * 单次 KK 重连尝试。成功即起桥并置 ONLINE。
     * 失败**不置 ERROR**——由调用方决定是立刻重试还是停（配对面路径要报错给用户，
     * 在线路径要静默重试）。
     */
    private suspend fun tryReconnect(corePub: String, deviceId: String, relayUrl: String): Boolean {
        val myEpoch = epoch.get()
        _state.value = _state.value.copy(phase = LinkPhase.CONNECTING)
        val room = deriveRoom(unb64u(corePub), deviceId, b64u(identity.publicKey))
        val tlsPin = pairing.tlsPin?.takeIf { it.isNotEmpty() } // cr-65：配对时带出的 pin 持久复用
        // 发起方短超时重试（根因见 KK_RECONNECT_ATTEMPTS 常量说明）。
        // 每轮用**全新实例**：onClose 只在握手成功后才订阅——否则失败轮的自我关闭
        // 会误触发 startReconnectLoop，与外层退避循环并发抢链。
        var connected: RelayClient? = null
        for (attempt in 1..KK_RECONNECT_ATTEMPTS) {
            // 代数校验（cr-109）：stop() 已发生 → 立即弃轮，残余 dial 一轮不留
            if (epoch.get() != myEpoch) return false
            val candidate = RelayClient(tlsPin)
            candidate.onPayload = { json -> dispatch(json) }
            val outcome = runCatching { candidate.reconnect(relayUrl, room, unb64u(corePub), identity) }
            if (outcome.isSuccess) {
                connected = candidate
                if (attempt > 1) Log.i(TAG, "KK 重连第 " + attempt + " 轮成功")
                break
            }
            candidate.cancel() // 超时放弃走 cancel（僵尸连接根因，见 RelayClient.cancel 注释）
            if (epoch.get() != myEpoch) return false // 等待窗内被 stop——不烧下一轮
            if (attempt < KK_RECONNECT_ATTEMPTS) {
                Log.w(TAG, "KK 重连第 " + attempt + "/" + KK_RECONNECT_ATTEMPTS + " 轮未成（room=" + room + "），重试")
                delay(KK_RETRY_DELAY_MS)
            }
        }
        val rc = connected
        if (rc == null) {
            Log.w(TAG, "KK 重连未成功（room=" + room + "，" + KK_RECONNECT_ATTEMPTS + " 轮均超时），等待退避重试")
            return false
        }
        if (epoch.get() != myEpoch) { // 成功轮撞上 stop 竞态——新链不采纳
            rc.cancel()
            return false
        }
        rc.onClose = { reason ->
            Log.w(TAG, "链路关闭: " + reason)
            // 只认现行链路（cr-109 风暴根因之一）：旧链残骸迟到的关闭回调会把健康
            // 新链当 stale 清掉重连（stop→resume 间旧 ws 的 onClose 迟到即触发），
            // 链路反复重置。断链重连只由现行链路的关闭启动。
            if (!manualStop && relay === rc) startReconnectLoop(corePub, deviceId, relayUrl)
        }
        // 换链前排掉旧链（旧 KK 帧序号必然错位，留着只会污染）。旧链在此语境按死链
        // 处理走 cancel（RST 立断）——close 优雅等待只会在 relay 侧多养 15s 残骸。
        relay?.cancel()
        relay = rc
        startBridge(rc)
        _state.value = _state.value.copy(
            phase = LinkPhase.ONLINE,
            bridgePort = bridge?.port ?: _state.value.bridgePort,
            message = null,
        )
        Log.i(TAG, "KK 重连成功，桥端口=" + bridge?.port)
        return true
    }

    /**
     * 退避重连循环（1s 起、上限 15s、±20% 抖动）。
     * 幂等：已在跑则不重入。用户主动 stop() 置 manualStop 后自然退出。
     *
     * 总时长上限 RECONNECT_GIVE_UP_MS（cr-43 ⑪：核心端移除设备/长期离线时，手机端
     * 不该无限重连卡死——超时置 ERROR 终态，UI 引导「解除配对重新开始」自救）。
     */
    private fun startReconnectLoop(corePub: String, deviceId: String, relayUrl: String) {
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            var backoffMs = 1_000L
            val deadline = System.currentTimeMillis() + RECONNECT_GIVE_UP_MS
            while (!manualStop) {
                val jitter = (backoffMs / 5.0 * (Math.random() * 2 - 1)).toLong()
                delay((backoffMs + jitter).coerceAtLeast(200L))
                if (manualStop) return@launch
                if (tryReconnect(corePub, deviceId, relayUrl)) return@launch
                if (System.currentTimeMillis() > deadline) {
                    Log.w(TAG, "重连超总时长上限（" + (RECONNECT_GIVE_UP_MS / 60_000L) + " 分钟）——置 ERROR 终态等用户处置")
                    _state.value = _state.value.copy(
                        phase = LinkPhase.ERROR,
                        message = "长时间无法连接核心端：电脑可能不在线，或已在电脑端移除了本设备。可解除配对后重新扫码。",
                        backgroundHold = false,
                    )
                    // 后台保活收尾（cr-109）：ERROR 终态不再值得保——App 在后台时没有
                    // Activity 生命周期回调会来解锁，锁必须在此随终态释放。
                    updateWakeLock(false)
                    return@launch
                }
                backoffMs = (backoffMs * 2).coerceAtMost(15_000L)
            }
        }
    }

    // ---- 桥 ----

    /**
     * 起回环桥；返回端口（WebView 加载 http://127.0.0.1:<port>/）。
     * 幂等（cr-49）：桥已活则只换上行通道——重连不换端口，WebView 不整页重载。
     *
     * 端口选择（cr-56）：优先上次实际端口（PairingStore），无记录用缺省
     * 27182，仍被占由桥回退随机。实际端口写回持久化——localStorage 按
     * origin 分区，端口漂移 = webui 全部持久化清零，故稳定端口是产品语义。
     */
    private fun startBridge(rc: RelayClient): Int {
        val up = object : Upstream {
            override fun send(payloadJson: String) = rc.send(payloadJson)
            override var onPayload: ((String) -> Unit)?
                get() = downlink
                set(v) { downlink = v }
        }
        val existing = bridge
        if (existing != null) {
            existing.swapUpstream(up)
            return _state.value.bridgePort ?: existing.port
        }
        val wanted = pairing.bridgePort.takeIf { it > 0 } ?: DEFAULT_BRIDGE_PORT
        val b = LoopbackBridge(up, staticDir, port = wanted)
        val port = b.start()
        bridge = b
        if (port != pairing.bridgePort) pairing.bridgePort = port
        _state.value = _state.value.copy(bridgePort = port)
        return port
    }

    fun stop() {
        manualStop = true
        epoch.incrementAndGet() // 在途 KK 尝试循环自弃（cr-109：防 stop 后残余 dial 撞门）
        reconnectJob?.cancel()
        reconnectJob = null
        bridge?.stop()
        bridge = null
        downlink = null
        relay?.close()
        relay = null
        updateWakeLock(false)
        _state.value = _state.value.copy(phase = LinkPhase.IDLE, bridgePort = null, backgroundHold = false)
    }

    // ---- 后台保活（cr-109）----

    /**
     * 后台保活判定：已配对且链路活动（在线/重连中）才值得保——前台服务通知常驻 +
     * CPU 部分锁让系统省电策略（MIUI 真机实锤：后台 TCP 被静默杀）不冻结网络；
     * 其余形态（未配对/终态 ERROR/配对确认期）保持「切后台即断开」锁行语义
     * （丢机缓解纵深——生物锁管入口，后台断链管闲置面）。重连循环自带 10 分钟
     * 上限，后台持锁时长有界，不会无限耗电。
     */
    fun shouldHoldBackground(): Boolean {
        if (manualStop || !pairing.paired) return false
        return _state.value.phase == LinkPhase.ONLINE || _state.value.phase == LinkPhase.CONNECTING
    }

    /** 进后台（Activity onStop）：链路活动期持锁保链；非持有形态回落 stop()。 */
    fun onAppBackground() {
        if (!shouldHoldBackground()) {
            stop()
            return
        }
        updateWakeLock(true)
        _state.value = _state.value.copy(backgroundHold = true)
    }

    /** 回前台（Activity onStart）：释放锁（前台进程自身保 CPU）。 */
    fun onAppForeground() {
        updateWakeLock(false)
        if (_state.value.backgroundHold) _state.value = _state.value.copy(backgroundHold = false)
    }

    /**
     * CPU 部分锁：链路与回环桥是纯 CPU + 网络负载，PARTIAL 锁即可（不亮屏）。
     * 无超时——持锁期 = 后台链路活动期，onAppForeground/stop 释放；进程被杀由
     * 系统自动回收。acquire 失败（厂商 ROM 极端限制）静默降级：等价旧行为
     * （后台断链、回前台自愈），不阻断。
     */
    private fun updateWakeLock(hold: Boolean) {
        if (!hold) {
            wakeLock?.let { runCatching { it.release() } }
            wakeLock = null
            return
        }
        val pm = powerManager ?: return
        if (wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentchat:remote-link").also {
                it.setReferenceCounted(false)
                runCatching { it.acquire() }
            }
        }
    }

    fun dispose() {
        stop()
        scope.cancel()
    }

    // ---- 入站帧分发 ----

    private fun dispatch(json: String) {
        val obj = runCatching { gson.fromJson(json, JsonObject::class.java) }.getOrNull()
        val type = obj?.get("type")?.takeIf { it.isJsonPrimitive }?.asString
        if (type != null && type.startsWith("remote/")) Log.i(TAG, "收到信令 " + type)
        if (type == "remote/resync") {
            // 重同步信令（cr-112）：链路重握手——转 WebView 触发对账拉取，不落库
            downlink?.invoke(json)
            return
        }
        if (type == "remote/paired") {
            val data = obj.getAsJsonObject("data") ?: JsonObject()
            val deviceId = data.get("deviceId")?.asString
            val scopes = data.getAsJsonArray("scopes")?.map { it.asString } ?: emptyList()
            if (deviceId != null) pairing.saveDevice(deviceId, scopes)
            pairedWaiter?.complete(data)
            return
        }
        if (type == null) Log.i(TAG, "入站帧无 type，转下行: " + json.take(80))
        downlink?.invoke(json)
    }

    companion object {
        /** 解析 agentchat://pair?... 的查询参数（值已 URL 编码） */
        fun parseQr(uri: String): Map<String, String> =
            uri.substringAfter("?", "").split("&").filter { it.isNotEmpty() }.associate {
                val i = it.indexOf('=')
                if (i < 0) it to ""
                else it.take(i) to java.net.URLDecoder.decode(it.substring(i + 1), "UTF-8")
            }

        /** KK 房间号派生（与核心端 service.ts runDeviceConnection 同式） */
        fun deriveRoom(corePub: ByteArray, deviceId: String, devicePubB64u: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            md.update(corePub)
            md.update(deviceId.toByteArray(Charsets.UTF_8))
            md.update(devicePubB64u.toByteArray(Charsets.UTF_8))
            return "r" + b64u(md.digest().copyOfRange(0, 17))
        }
    }
}
