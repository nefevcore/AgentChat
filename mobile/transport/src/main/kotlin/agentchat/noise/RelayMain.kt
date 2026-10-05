// ============================================================
// M3.1 relay 全链路验证驱动器（Kotlin 手机端原型）
//
// 用法（前置：本地 relay 已起，宿主已起）：
//   java -cp <classpath> agentchat.noise.RelayMainKt <relayUrl> <rpcWsUrl> [deviceName] [--reconnect]
//
// 流程 = remote-loopback-client.ts 的 Kotlin 对照：
//   RPC 面 ws://127.0.0.1:3839 调 remote/pair-start → 解 qrUri →
//   RelayClient XK 握手 → 打印 SAS → 轮询 remote/status 等 online →
//   agents/list 加密 RPC 冒烟 → --reconnect 走 KK。
// 身份落盘 sandbox/kotlin-identity.txt（模拟 Keystore）。
// ============================================================
package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.File
import java.util.concurrent.TimeUnit

private val gson = Gson()

fun main(args: Array<String>) = runBlocking {
    val relayUrl = args.getOrNull(0) ?: "ws://127.0.0.1:18443"
    val rpcUrl = args.getOrNull(1) ?: "ws://127.0.0.1:3839"
    val deviceName = args.getOrNull(2) ?: "kotlin-phone"
    val doReconnect = args.contains("--reconnect")
    val kkRoom = (args.firstOrNull { it.startsWith("--kk-room=") })?.removePrefix("--kk-room=")
    val corePubArg = (args.firstOrNull { it.startsWith("--core-pub=") })?.removePrefix("--core-pub=")

    // 身份落盘（模拟 Keystore——重启算同设备）
    val idFile = File("sandbox/kotlin-identity.txt")
    val identity = if (idFile.exists()) {
        val parts = idFile.readText().trim().split(":")
        StaticIdentity(unb64u(parts[0]), unb64u(parts[1]))
    } else {
        val id = generateStaticIdentity()
        idFile.parentFile?.mkdirs()
        idFile.writeText(b64u(id.publicKey) + ":" + b64u(id.privateKey))
        id
    }
    println("[kotlin] identity: " + b64u(identity.publicKey))

    if (kkRoom != null) {
        // KK 专项模式：用注册表里的已知身份直连（绕过宿主服务，responder 由外部脚本扮演）
        val kk = RelayClient()
        kk.onRaw = { println("[kotlin] RAW< " + it.take(120)) }
        val kkDone = CompletableDeferred<Boolean>()
        kk.onPayload = { raw -> println("[kotlin] KK 收帧: " + raw.take(80)); kkDone.complete(true) }
        kk.reconnect(relayUrl, kkRoom, unb64u(corePubArg!!), identity)
        println("[kotlin] KK-only 握手完成，等帧...")
        withTimeoutOrNull(15000) { kkDone.await() } ?: println("[kotlin] （15s 无帧）")
        kk.close()
        println("[kotlin] DONE")
        return@runBlocking
    }

    val rpc = RpcClient()
    rpc.connect(rpcUrl)
    println("[kotlin] RPC connected: " + rpcUrl)

    // 1. pair-start（宿主残留 pairing 态会 throw——验证流程用全新宿主）
    val session = rpc.call("remote/pair-start")
    val qrUri = session.get("qrUri")?.asString
        ?: run { println("[kotlin] FAIL pair-start: " + session); kotlin.system.exitProcess(1) }
    // sessionId 落盘供外部代答（m31-auto-confirm 轮询此文件）
    File("sandbox/pair-session.txt").writeText(session.get("sessionId")?.asString ?: "")
    println("[kotlin] qrUri: " + qrUri)
    val kv = qrUri.removePrefix("agentchat://pair?").split("&").associate {
        val i = it.indexOf('=')
        it.take(i) to java.net.URLDecoder.decode(it.substring(i + 1), "UTF-8")
    }
    val relay = kv["relay"] ?: relayUrl
    val room = kv["room"]!!
    val pk = unb64u(kv["pk"]!!)
    println("[kotlin] relay=" + relay + " room=" + room)

    // 2. XK 配对握手
    val rc = RelayClient()
    val sas = rc.pairAndHandshake(relay, room, pk, identity, deviceName)
    println("[kotlin] SAS=" + sas)
    // 验证模式自动确认（真机由用户在 WebUI 核对；sessionId 已在手）
    val sid = session.get("sessionId")?.asString ?: ""
    val cr = rpc.call("remote/pair-confirm", JsonObject().apply {
        addProperty("sessionId", sid); addProperty("accept", true)
    })
    println("[kotlin] pair-confirm → " + cr)

    // 3. 等 confirm（WebUI 用户点击 SAS 确认；测试用 node 代答）
    val deadline = System.currentTimeMillis() + 120_000
    var online = false
    while (System.currentTimeMillis() < deadline) {
        val st = rpc.call("remote/status")
        if (st.get("state")?.asString == "online" ||
            (st.get("onlineDeviceIds")?.asJsonArray?.size() ?: 0) > 0) { online = true; break }
        Thread.sleep(1000)
    }
    if (!online) { println("[kotlin] FAIL: 120s 内未上线"); kotlin.system.exitProcess(1) }
    println("[kotlin] ONLINE")

    // 4. RPC 冒烟：经加密链路发 agents/list，等应答帧
    val smokeDone = CompletableDeferred<Boolean>()
    rc.onPayload = { raw ->
        if (raw.contains("kt-smoke-1")) {
            println("[kotlin] 收到 agents/list 应答: " + raw.take(160))
            smokeDone.complete(true)
        }
    }
    rc.send(gson.toJson(mapOf(
        "type" to "rpc/call",
        "data" to mapOf("method" to "agents/list", "requestId" to "kt-smoke-1"))))
    val got = withTimeoutOrNull(15000) { smokeDone.await() }
    println(if (got == true) "[kotlin] RPC 冒烟通过" else "[kotlin] WARN: 15s 未见应答帧")

    // 5. KK 重连
    if (doReconnect) {
        println("[kotlin] 断开重连（KK）...")
        rc.close()
        Thread.sleep(4000)
        val st = rpc.call("remote/status")
        val corePub = unb64u(st.get("identityPubkey").asString)
        val devices = rpc.call("remote/devices")
        val devObj = devices.getAsJsonArray("devices")
            ?.firstOrNull { it.asJsonObject.get("pubkey").asString == b64u(identity.publicKey) }
            ?.asJsonObject
        if (devObj == null) { println("[kotlin] FAIL: 未注册"); kotlin.system.exitProcess(1) }
        val devId = devObj.get("id").asString
        val md = java.security.MessageDigest.getInstance("SHA-256")
        md.update(corePub)
        md.update(devId.toByteArray())
        md.update(b64u(identity.publicKey).toByteArray())
        val derived = md.digest()
        val rr = "r" + b64u(derived.copyOfRange(0, 17))
        println("[kotlin] KK room=" + rr)
        println("[kotlin] remote/connect → " + rpc.call("remote/connect", JsonObject().apply { addProperty("deviceId", devId) }))
        Thread.sleep(4000)
        rc.reconnect(relay, rr, corePub, identity)
        val kkDone = CompletableDeferred<Boolean>()
        rc.onPayload = { if (it.contains("kt-kk-1")) kkDone.complete(true) }
        rc.send(gson.toJson(mapOf(
            "type" to "rpc/call",
            "data" to mapOf("method" to "agents/list", "requestId" to "kt-kk-1"))))
        val kk = withTimeoutOrNull(15000) { kkDone.await() }
        println(if (kk == true) "[kotlin] KK 后 RPC 应答通过" else "[kotlin] WARN: KK 后应答未见")
    }

    rc.close()
    println("[kotlin] DONE")
}
