// ============================================================
// RelayClient —— 手机端 relay 连接半边（scripts/remote-loopback-client.ts 的 Kotlin 移植）
//
//   · OkHttp WebSocket 出站连 relay（明文 ws:// 本地联调；wss:// + 证书 pin 是 Android 壳的事）
//   · join(roomId) → XK（配对）/ KK（重连）握手 → TransportCipher 帧泵
//   · 帧词汇与 ac-relay-server 一致：join/joined/room-unavailable/frame/ping/pong
// ============================================================
package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class RelayClientException(message: String) : Exception(message)

/** 一次 relay 会话（房间 = 连接生命周期；断线整体废弃重来） */
class RelayClient(
    /** relay TLS 证书 sha256 pin（hex；cr-65——null/空 = 不校验，行为同旧）。wss 才生效 */
    tlsPinHex: String? = null,
    private val client: OkHttpClient = RelayClient.defaultClient(tlsPinHex),
) : Upstream {
    private val gson = Gson()
    var ws: WebSocket? = null
        private set
    var transport: TransportPair? = null
        private set
    override var onPayload: ((String) -> Unit)? = null
    var onClose: ((String) -> Unit)? = null

    companion object {
        /** relay 应用层心跳超时 60s——取 25s 留足余量（含链路抖动） */
        const val HEARTBEAT_INTERVAL_MS = 25_000L

        /**
         * KK 单次尝试的 m2 等待窗。
         *
         * **短超时是刻意的**：relay 只转发实时帧，m1 若早于对端进房即被丢弃
         * （双方进房时序不定——M3 真机实录：RELAY_DEBUG 显示设备 join 即发 m1 时
         * 宿主尚未进房，帧无 peer 可投 → 双方各自超时 → 退避错开反复错过）。
         * 单次长等待只会让两端各自退避到上限；正确解法是发起方**短超时 + 整链
         * 重试**（每次新 dial、新握手、新临时密钥）——对齐 scripts/remote-loopback-client.ts
         * reconnect() 的既有裁决，本端 M3.1 移植时漏了该重试层。
         */
        const val KK_HANDSHAKE_TIMEOUT_MS = 3_000L

        fun defaultClient(tlsPinHex: String? = null): OkHttpClient = OkHttpClient.Builder()
            // 协议层 ping（TCP 保活 + pong 监视——OkHttp 两个周期无 pong 即杀链，是
            // 手机端唯一的死链检测器）。15s：死链最坏 30s 检出（cr-48 真机轮 25s 时
            // 「sent ping but no pong in 25s」断链后重连等待分钟级，检出越快恢复越快）。
            // 注意：relay 的活跃判定只看应用层 ping 帧，此项不能替代 startHeartbeat（M3.2 实测）
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            // TLS pin（cr-65）：二维码带出的证书 sha256。注意与自签 trustAll 的层
            // 次分工——trustAll 过连接关（自签链无 CA 可验），CertificatePinner 在其
            // 后比对 pin：对不上即 SSLPeerUnverifiedException 断链。pin 语义是
            // 「这个 relay 必须还是配对时那台」，堵 KCI 下伪 relay 对接。
            .apply {
                val pin = tlsPinHex?.trim()?.takeIf { it.isNotEmpty() } ?: return@apply
                val b64 = java.util.Base64.getEncoder().encodeToString(
                    pin.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
                certificatePinner(
                    okhttp3.CertificatePinner.Builder().add("*", "sha256/$b64").build())
            }
            // relay 自签证书（M3 方案 §4.3：认证职责在 Noise 层，TLS 仅混淆——对齐
            // PC 侧 relay-connection.ts 的 rejectUnauthorized:false；公网 wss 自签在
            // Android 默认信任链下 CertPathValidatorException，真机 cr-43 轮实锤）
            .sslSocketFactory(trustAllSslContext().socketFactory, trustAllManager)
            .hostnameVerifier { _, _ -> true }
            .build()

        /** 信任所有证书的 X509TrustManager（仅 TLS 通道层——身份认证由 Noise XK/KK 承载） */
        private val trustAllManager: javax.net.ssl.X509TrustManager =
            object : javax.net.ssl.X509TrustManager {
                override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
            }

        private fun trustAllSslContext(): javax.net.ssl.SSLContext =
            javax.net.ssl.SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(trustAllManager), java.security.SecureRandom())
            }
    }

    /** 出站连 relay 并 join（等待 joined 确认） */
    private suspend fun dialAndJoin(relayUrl: String, roomId: String, timeoutMs: Long = 15000) {
        val joined = CompletableDeferred<Unit>()
        val request = Request.Builder().url(relayUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(gson.toJson(mapOf("op" to "join", "room" to roomId)))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleWire(text, joined)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                joined.completeExceptionally(RelayClientException("relay: " + (t.message ?: "dial failed")))
                onClose?.invoke(t.message ?: "failure")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onClose?.invoke(reason.ifEmpty { "closed" })
            }
        })
        withTimeout(timeoutMs) { joined.await() }
        startHeartbeat()
    }

    private var pendingHandshake: CompletableDeferred<ByteArray>? = null

    /** KK 首握 m1 缓存（cr-249）：peer-arrived 到达（对端进房晚于 m1 发出）时重发——
     *  relay 只转发实时帧，早发的 m1 已丢；responder 对重复 m1 幂等，重发无害 */
    @Volatile private var lastM1: ByteArray? = null

    /** transport 就绪前到达的加密帧（握手尾帧竞态——赋值后重放） */
    private val earlyFrames = ArrayDeque<Pair<Long, String>>()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var heartbeatJob: Job? = null

    /**
     * 应用层心跳（relay 协议要求）：ac-relay-server 只把 **应用层 {op:"ping"}**、
     * join 与 frame 计入活跃（touch），60s 未见即销毁房间。
     * OkHttp 的协议层 pingInterval **不计入**——空闲连接照样被判死（M3.2 实测教训）。
     */
    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                runCatching { ws?.send(gson.toJson(mapOf("op" to "ping"))) }
            }
        }
    }



    private fun deliverFrame(t: TransportPair, n: Long, ct: String) {
        try {
            val pt = t.recv.read(n, unb64u(ct))
            onPayload?.invoke(String(pt))
        } catch (e: Exception) {
            onClose?.invoke("decrypt failed: " + e.message)
            close()
        }
    }

    private fun replayEarlyFrames() {
        while (earlyFrames.isNotEmpty()) {
            val (n, ct) = earlyFrames.removeFirst()
            transport?.let { deliverFrame(it, n, ct) }
        }
    }

    /** 原始入站帧观察口（调试用） */
    var onRaw: ((String) -> Unit)? = null

    private fun handleWire(text: String, joinedOnce: CompletableDeferred<Unit>? = null) {
        onRaw?.invoke(text)
        val f = gson.fromJson(text, JsonObject::class.java) ?: return
        when (f.get("op")?.asString) {
            "joined" -> joinedOnce?.complete(Unit)
            "room-unavailable" -> joinedOnce?.completeExceptionally(
                RelayClientException("relay: room-unavailable"))
            "pong" -> {}
            // 占座会合（cr-249）：对端进房信令。KK 首握在途（m1 已发但 m2 未回）时
            // m1 极可能早于对端进房而丢失——重发缓存 m1，等待窗内对端即可响应。
            "peer-arrived" -> {
                lastM1?.let { m1 -> sendHandshake(m1) }
            }
            // cr-70/71 常住方模型：对端（PC）的连接走了，但房间保留——PC 若活着
            // 会立刻回来（常住），死透了则本端撞门永远无人应答后自然退避。
            // 正确动作 = 断开本连接并走既有重连循环（onClose 驱动 startReconnectLoop），
            // 绝不能守死幽灵连接，也不能只 cancel 不通知（cr-71 真机实锤：
            // 发消息瞬间 PC 侧换轮触发 peer-left，旧处理自杀了健康链路）。
            "peer-left" -> {
                onClose?.invoke("peer-left")
                heartbeatJob?.cancel()
                heartbeatJob = null
                ws?.cancel()
                ws = null
                transport = null
            }
            "frame" -> {
                val data = f.getAsJsonObject("data") ?: return
                val hs = data.get("hs")?.takeIf { it.isJsonPrimitive }?.asString
                if (hs != null) {
                    pendingHandshake?.complete(unb64u(hs))
                    return
                }
                val n = data.get("n")?.takeIf { it.isJsonPrimitive }?.asLong ?: return
                val ct = data.get("ct")?.takeIf { it.isJsonPrimitive }?.asString ?: return
                val t = transport
                if (t == null) {
                    // 竞态窗口缓存：握手刚完成、transport 赋值前的帧先排队（OkHttp 回调线程
                    // 与挂起协程的赋值存在窗口——对端握手后立即发帧会先于赋值到达）
                    earlyFrames.add(Pair(n, ct))
                    return
                }
                deliverFrame(t, n, ct)
            }
        }
    }

    private suspend fun nextHandshake(timeoutMs: Long = 15000): ByteArray {
        val d = CompletableDeferred<ByteArray>()
        pendingHandshake = d
        return withTimeout(timeoutMs) { d.await() }
    }

    private fun sendHandshake(msg: ByteArray) {
        ws?.send(gson.toJson(mapOf("op" to "frame", "data" to mapOf("hs" to b64u(msg)))))
    }

    /** XK 配对（发起方）。返回 SAS。 */
    suspend fun pairAndHandshake(
        relayUrl: String,
        roomId: String,
        corePub: ByteArray,
        identity: StaticIdentity,
        deviceName: String,
    ): String {
        dialAndJoin(relayUrl, roomId)
        val hs = NoiseHandshake(NoisePattern.XK, NoiseRole.INITIATOR, identity, corePub)
        sendHandshake(hs.writeMessage()) // m1 载荷空（协议约定）
        hs.readMessage(nextHandshake())
        if (!hs.remoteStaticMatches(corePub)) throw RelayClientException("XK: static key mismatch")
        val info = gson.toJson(mapOf("name" to deviceName, "pubkey" to b64u(identity.publicKey)))
        sendHandshake(hs.writeMessage(info.toByteArray()))
        val pair = hs.split()
        transport = pair
        replayEarlyFrames()
        return sasFromHandshakeHash(pair.handshakeHash)
    }

    /**
     * KK 重连（发起方）——**一次**尝试：dial + join + 发 m1 + 等 m2。
     *
     * 等待窗由 handshakeTimeoutMs 决定（缺省 KK_HANDSHAKE_TIMEOUT_MS，短超时见该常量）。
     * 失败即抛错，**重试由调用方负责**（RemoteSession.tryReconnect 逐轮全新建链）——
     * 本函数只保证"一轮尝试干净"，这样调用方可以自由决定节奏与次数。
     *
     * m1 丢失自愈（cr-249 占座会合）：relay 只转发实时帧——m1 早于对端进房即丢失。
     * 本端 join 后收 peer-arrived（对端此刻进房）即重发 m1 缓存帧。responder 侧
     * 对重复 m1 幂等（每次到达重新响应），重发无害。
     */
    suspend fun reconnect(
        relayUrl: String,
        roomId: String,
        corePub: ByteArray,
        identity: StaticIdentity,
        handshakeTimeoutMs: Long = KK_HANDSHAKE_TIMEOUT_MS,
    ) {
        dialAndJoin(relayUrl, roomId)
        val hs = NoiseHandshake(NoisePattern.KK, NoiseRole.INITIATOR, identity, corePub)
        lastM1 = hs.writeMessage()
        sendHandshake(lastM1!!)
        hs.readMessage(nextHandshake(handshakeTimeoutMs))
        lastM1 = null
        transport = hs.split()
        replayEarlyFrames()
    }

    /** 发送加密业务帧（载荷 JSON 字符串）——Upstream 契约 */
    override fun send(payloadJson: String) {
        val t = transport ?: throw RelayClientException("not connected")
        val f = t.send.write(payloadJson.toByteArray())
        ws?.send(gson.toJson(mapOf("op" to "frame", "data" to mapOf("n" to f.first, "ct" to b64u(f.second)))))
    }

    fun close() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        ws?.close(1000, "bye")
        ws = null
        transport = null
        lastM1 = null
    }

    /**
     * 立即断开（cr-43 真机实锤）：KK 重试轮的超时放弃必须用 cancel——close(1000)
     * 是优雅关闭（等对端 close ACK），relay 侧若未及处理 close 帧，TCP 挂成僵尸；
     * 每轮重试漏一条，几分钟即爬满 relay 的 per-IP 连接上限（1013 try-again-later
     * 互杀）。cancel 直接切 TCP，无等待。
     */
    fun cancel() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        ws?.cancel()
        ws = null
        transport = null
        lastM1 = null
    }
}
