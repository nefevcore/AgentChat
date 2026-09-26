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
class RelayClient(private val client: OkHttpClient = RelayClient.defaultClient()) : Upstream {
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

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            // 协议层 ping（TCP 保活）——注意：relay 的活跃判定只看应用层 ping 帧，
            // 此项不能替代 startHeartbeat（M3.2 实测）
            .pingInterval(25, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
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

    /** KK 重连（发起方）。 */
    suspend fun reconnect(
        relayUrl: String,
        roomId: String,
        corePub: ByteArray,
        identity: StaticIdentity,
    ) {
        dialAndJoin(relayUrl, roomId)
        val hs = NoiseHandshake(NoisePattern.KK, NoiseRole.INITIATOR, identity, corePub)
        sendHandshake(hs.writeMessage())
        hs.readMessage(nextHandshake())
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
    }
}
