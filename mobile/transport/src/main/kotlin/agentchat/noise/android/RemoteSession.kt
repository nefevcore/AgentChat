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

private const val TAG = "AgentChatRemote"

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

        _state.value = _state.value.copy(phase = LinkPhase.CONNECTING, relayUrl = relayUrl, message = null)
        Log.i(TAG, "startPairing relay=" + relayUrl + " room=" + room)
        val rc = RelayClient()
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
        pairing.savePairing(corePub, relayUrl)
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
                if (!manualStop) startReconnectLoop(cp, rid, rurl)
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
        _state.value = _state.value.copy(phase = LinkPhase.CONNECTING)
        val rc = RelayClient()
        rc.onPayload = { json -> dispatch(json) }
        rc.onClose = { reason ->
            Log.w(TAG, "链路关闭: " + reason)
            // 非用户主动断开 → 进入重连循环（切后台的 stop() 会把 manualStop 置位）
            if (!manualStop) startReconnectLoop(corePub, deviceId, relayUrl)
        }
        val room = deriveRoom(unb64u(corePub), deviceId, b64u(identity.publicKey))
        val ok = runCatching { rc.reconnect(relayUrl, room, unb64u(corePub), identity) }.isSuccess
        if (!ok) {
            Log.w(TAG, "KK 重连未成功（room=" + room + "），等待退避重试")
            return false
        }
        // 换链前排掉旧链（旧 KK 帧序号必然错位，留着只会污染）
        relay?.close()
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
     * 退避重连循环（1s 起、上限 60s、±20% 抖动——与核心端 scheduleReconnect 同参数）。
     * 幂等：已在跑则不重入。用户主动 stop() 置 manualStop 后自然退出。
     */
    private fun startReconnectLoop(corePub: String, deviceId: String, relayUrl: String) {
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            var backoffMs = 1_000L
            while (!manualStop) {
                val jitter = (backoffMs / 5.0 * (Math.random() * 2 - 1)).toLong()
                delay((backoffMs + jitter).coerceAtLeast(200L))
                if (manualStop) return@launch
                if (tryReconnect(corePub, deviceId, relayUrl)) return@launch
                backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
            }
        }
    }

    // ---- 桥 ----

    /** 起回环桥；返回端口（WebView 加载 http://127.0.0.1:<port>/） */
    private fun startBridge(rc: RelayClient): Int {
        bridge?.stop()
        val up = object : Upstream {
            override fun send(payloadJson: String) = rc.send(payloadJson)
            override var onPayload: ((String) -> Unit)?
                get() = downlink
                set(v) { downlink = v }
        }
        val b = LoopbackBridge(up, staticDir)
        val port = b.start()
        bridge = b
        _state.value = _state.value.copy(bridgePort = port)
        return port
    }

    fun stop() {
        manualStop = true
        reconnectJob?.cancel()
        reconnectJob = null
        bridge?.stop()
        bridge = null
        downlink = null
        relay?.close()
        relay = null
        _state.value = _state.value.copy(phase = LinkPhase.IDLE, bridgePort = null)
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
