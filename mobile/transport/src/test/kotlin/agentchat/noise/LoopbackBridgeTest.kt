// ============================================================
// M3.2 回环桥测试：与 ac-web-server 线上协议同构性（无需 Android 设备）
//   · 静态资源：webui dist 的 index.html 与资源可达（SPA fallback）；
//   · ws/ready：连接即下发 { protocol:1, connId, serverStartedAt }；
//   · 上行：WebView rpc/call → 原样进上游（其余类型忽略）；
//   · 下行：上游载荷 → 广播给全部 WebView 连接。
// ============================================================
package agentchat.noise

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.File
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeUpstream : Upstream {
    val sent = mutableListOf<String>()
    override var onPayload: ((String) -> Unit)? = null
    override fun send(payloadJson: String) { sent.add(payloadJson) }
}

/**
 * 假上游（转发面）：对 http/read|http/write 同步回一个「原样回显」的应答，
 * 从而在无核心端的情况下验证桥的转发契约（方法分流 / 路径带 query / 体字节）。
 * fail=true 时回失败应答，验证桥的 502 分支。
 */
private class ProxyFakeUpstream(private val fail: Boolean = false) : Upstream {
    private val gson = com.google.gson.Gson()
    override var onPayload: ((String) -> Unit)? = null

    override fun send(payloadJson: String) {
        val o = com.google.gson.JsonParser.parseString(payloadJson).asJsonObject
        val data = o.getAsJsonObject("data")
        val rid = data.get("requestId").asString
        val resultBody = if (fail) {
            com.google.gson.JsonObject()
        } else {
            val p = data.getAsJsonObject("params")
            val echoed = "{\"upstreamMethod\":\"" + data.get("method").asString +
                "\",\"path\":\"" + p.get("path").asString +
                "\",\"body\":\"" + (p.get("bodyB64")?.let { String(unb64u(it.asString)) } ?: "") + "\"}"
            com.google.gson.JsonObject().apply {
                addProperty("status", 200)
                addProperty("contentType", "application/json")
                addProperty("bodyB64", b64u(echoed.toByteArray()))
            }
        }
        val res = com.google.gson.JsonObject().apply {
            addProperty("type", "rpc/result")
            add("data", com.google.gson.JsonObject().apply {
                addProperty("requestId", rid)
                addProperty("ok", !fail)
                if (fail) addProperty("error", "simulated upstream failure") else add("result", resultBody)
            })
        }
        onPayload?.invoke(gson.toJson(res))
    }
}

class LoopbackBridgeTest {

    private val distDir: File? = listOf(
        File("../../src/webui/dist"),
        File("src/webui/dist"),
    ).firstOrNull { it.isDirectory }

    @Test
    fun staticAndWebsocketShareOnePort() = runBlocking {
        val up = FakeUpstream()
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val client = HttpClient(CIO) { install(WebSockets) }
            // 1) 静态资源（同口 HTTP）
            if (distDir != null) {
                val html = client.get("http://127.0.0.1:$port/").bodyAsText()
                assertContains(html, "<div id=\"app\">", message = "index.html 应可达")
                // SPA fallback：未知路径回落 index.html
                val fb = client.get("http://127.0.0.1:$port/nonexistent/route").bodyAsText()
                assertEquals(html, fb)
            }
            // 2) WS 同口：ws/ready + 上行 rpc/call + 下行广播
            client.webSocket("ws://127.0.0.1:$port/ws") {
                val ready = (withTimeout(5000) { incoming.receive() } as Frame.Text).readText()
                assertContains(ready, "\"ws/ready\"")
                assertContains(ready, "\"protocol\":1")
                assertEquals(1, bridge.clientCount)

                // 上行：rpc/call 应进上游
                send(Frame.Text("""{"type":"rpc/call","data":{"method":"agents/list","requestId":"b-1"}}"""))
                var waited = 0
                while (up.sent.isEmpty() && waited < 50) { Thread.sleep(50); waited++ }
                assertEquals(1, up.sent.size)
                assertContains(up.sent[0], "agents/list")

                // 出站语义帧不入站（rpc/result 不应触发上游）
                send(Frame.Text("""{"type":"rpc/result","data":{"requestId":"x"}}"""))
                Thread.sleep(200)
                assertEquals(1, up.sent.size)

                // 下行：上游载荷广播到 WebView
                up.onPayload?.invoke("""{"type":"rpc/result","data":{"requestId":"b-1","ok":true}}""")
                val down = (withTimeout(5000) { incoming.receive() } as Frame.Text).readText()
                assertContains(down, "\"ok\":true")
                assertTrue(bridge.clientCount >= 1)
            }
        } finally {
            bridge.stop()
        }
    }

    // ---- /api/ 通用转发（M3.4）----

    /** 假上游：对 http/read|http/write 自动回应答，模拟核心端转发面 */
    @Test
    fun apiProxyForwardsMethodPathAndBody() = runBlocking {
        val up = ProxyFakeUpstream()
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val client = HttpClient(CIO)
            // GET → http/read
            val got = client.get("http://127.0.0.1:$port/api/workspaces").bodyAsText()
            assertContains(got, "\"upstreamMethod\":\"http/read\"")
            assertContains(got, "\"path\":\"/api/workspaces\"")

            // **多段路径**（真机 webui 实际请求形态）：/api/ui/boot-graph、
            // /api/workspace/tree/xxx —— tailcard 必须匹配任意段数
            val deep = client.get("http://127.0.0.1:$port/api/ui/boot-graph").bodyAsText()
            assertContains(deep, "\"path\":\"/api/ui/boot-graph\"")
            val deeper = client.get("http://127.0.0.1:$port/api/workspace/tree/a/b").bodyAsText()
            assertContains(deeper, "\"/api/workspace/tree/a/b\"")

            // POST（含体）→ http/write；体与 Content-Type 原样上行
            val posted = client.post("http://127.0.0.1:$port/api/upload?name=x") {
                setBody("hello-body")
            }.bodyAsText()
            assertContains(posted, "\"upstreamMethod\":\"http/write\"")
            assertContains(posted, "\"path\":\"/api/upload?name=x\"")
            assertContains(posted, "hello-body")
        } finally {
            bridge.stop()
        }
    }

    @Test
    fun apiProxySurfacesUpstreamFailureAs502() = runBlocking {
        val up = ProxyFakeUpstream(fail = true)
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val resp = HttpClient(CIO).get("http://127.0.0.1:$port/api/nope")
            assertEquals(HttpStatusCode.BadGateway, resp.status)
            // 关键：**不得**回落 index.html（M3.2 教训——回落 HTML 会掩盖真实缺口）
            assertContains(resp.bodyAsText(), "remote bridge:")
        } finally {
            bridge.stop()
        }
    }
}
