// ============================================================
// M3.2 验收驱动器：回环桥 + 真实 relay 全链路
//
// 用法：
//   java -cp <cp> agentchat.noise.BridgeMainKt <relayWs> <rpcWs> [staticDir]
//
// 流程：RPC pair-start → 用二维码参数连 relay + XK 握手 → 内置 pair-confirm →
//   启动回环桥（同口 HTTP 静态 dist + WS /ws）→ 打印 BRIDGE_PORT=<n> 待命。
// 此后任意 WebView/客户端连 ws://127.0.0.1:<n>/ws 即可经加密链路做 RPC——
// 这正是 M3.2 验收「WebView 加载 webui dist 并能 rpc/call 通回环桥」。
// ============================================================
package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import java.io.File

private val gson = Gson()

fun main(args: Array<String>) = runBlocking {
    val relayUrl = args.getOrNull(0) ?: "ws://127.0.0.1:18443"
    val rpcUrl = args.getOrNull(1) ?: "ws://127.0.0.1:4183"
    val staticDir = args.getOrNull(2)?.let { File(it) }
    val deviceName = "kotlin-phone"

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
    println("[bridge] identity=" + b64u(identity.publicKey))

    val rpc = RpcClient()
    rpc.connect(rpcUrl)

    val session = rpc.call("remote/pair-start")
    val qrUri = session.get("qrUri")?.asString
        ?: run { println("[bridge] FAIL pair-start: " + session); kotlin.system.exitProcess(1) }
    val kv = qrUri.removePrefix("agentchat://pair?").split("&").associate {
        val i = it.indexOf('=')
        it.take(i) to java.net.URLDecoder.decode(it.substring(i + 1), "UTF-8")
    }
    val relay = kv["relay"] ?: relayUrl
    val room = kv["room"]!!
    val pk = unb64u(kv["pk"]!!)

    val rc = RelayClient()
    val sas = rc.pairAndHandshake(relay, room, pk, identity, deviceName)
    println("[bridge] SAS=" + sas)
    val sid = session.get("sessionId")?.asString ?: ""
    val cr = rpc.call("remote/pair-confirm", JsonObject().apply {
        addProperty("sessionId", sid); addProperty("accept", true)
    })
    val confirmErr = cr.get("__rpcError")?.asString
    if (confirmErr != null) { println("[bridge] FAIL confirm: " + confirmErr); kotlin.system.exitProcess(1) }
    println("[bridge] ONLINE (device=" + (cr.get("deviceName")?.asString ?: "?") + ")")

    // 回环桥：上游 = 已加密的 RelayClient
    val bridge = LoopbackBridge(rc, staticDir)
    // 诊断口：把上下行帧落盘（M3.2 排查；生产壳移除）
    val traceFile = File("sandbox/bridge-trace.log")
    var maxFrame = 0
    bridge.onDownlink = { json ->
        val n = json.toByteArray().size
        if (n > maxFrame) { maxFrame = n; println("[bridge] 新最大下行帧: " + n + " 字节") }
        if (n > 1_000_000) println("[bridge] ⚠ 超 1MB 帧: " + n + " 字节 — " + json.take(120))
        traceFile.appendText("IN  " + json.take(200) + "\n")
    }
    bridge.onUplink = { json -> traceFile.appendText("OUT " + json.take(200) + "\n") }
    val port = bridge.start()
    println("[bridge] 静态目录=" + (staticDir?.absolutePath ?: "(无)"))
    println("BRIDGE_PORT=" + port)
    System.out.flush()

    // 连接观测：断链即打印（M3.2 排查用）；每 20s 探测一次上游可用性
    rc.onClose = { reason -> println("[bridge] UPSTREAM CLOSED: " + reason) }
    val probe = Thread {
        while (true) {
            Thread.sleep(20_000)
            val ok = runCatching {
                kotlinx.coroutines.runBlocking { bridge.callUpstream("agents/list", null, 8000) }
            }
            println("[bridge] 上游探测: " + if (ok.isSuccess) "OK" else "FAIL — " + ok.exceptionOrNull()?.message)
        }
    }
    probe.isDaemon = true
    probe.start()

    // 待命（真机由 Android 壳持有生命周期；此处由外部进程结束）
    Thread.currentThread().join()
}
