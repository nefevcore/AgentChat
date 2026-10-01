// ============================================================
// M3.2 回环桥测试：与 ac-web-server 线上协议同构性（无需 Android 设备）
//   · ws/ready：连接即下发 { protocol:1, connId, serverStartedAt }；
//   · 上行：WebView rpc/call → 原样进上游（其余类型忽略）；
//   · 下行：上游载荷 → 广播给全部 WebView 连接。
//   · 静态面（cr-101 变体B）：在线经 http/static 代理核心端（含 304 重协商），
//     上游失败回落本地 dist（SPA fallback 依旧）。
// ============================================================
package agentchat.noise

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
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
 * fail=true 时回失败应答，验证桥的 502 分支（静态面 = 回落本地 dist）。
 * staticHtml 非空时对 http/static 回核心端式静态应答（200 + ETag；
 * If-None-Match 命中回 304 零字节——cr-101 变体B）。
 */
private class ProxyFakeUpstream(
    private val fail: Boolean = false,
    private val staticHtml: String? = null,
) : Upstream {
    private val gson = com.google.gson.Gson()
    val sent = mutableListOf<String>()
    override var onPayload: ((String) -> Unit)? = null

    override fun send(payloadJson: String) {
        sent.add(payloadJson)
        val o = com.google.gson.JsonParser.parseString(payloadJson).asJsonObject
        val data = o.getAsJsonObject("data")
        val rid = data.get("requestId").asString
        // 只对桥自身发起的 http/* RPC 应答；WebView 业务帧（agents/list 等，无
        // params 形态）只记录不回应——回显分支会因缺 params 而 NPE 炸掉 WS 会话
        val method = data.get("method")?.asString ?: ""
        if (!method.startsWith("http/")) return
        val resultBody = if (fail) {
            com.google.gson.JsonObject()
        } else if (data.get("method").asString == "http/static" && staticHtml != null) {
            val p = data.getAsJsonObject("params")
            if (p.get("ifNoneMatch")?.asString == "\"idx-1\"") {
                com.google.gson.JsonObject().apply {
                    addProperty("status", 304)
                    addProperty("contentType", "text/html")
                    add("cacheHeaders", com.google.gson.JsonObject().apply {
                        addProperty("etag", "\"idx-1\"")
                    })
                }
            } else {
                com.google.gson.JsonObject().apply {
                    addProperty("status", 200)
                    addProperty("contentType", "text/html; charset=utf-8")
                    addProperty("bodyB64", b64u(staticHtml.toByteArray()))
                    add("cacheHeaders", com.google.gson.JsonObject().apply {
                        addProperty("etag", "\"idx-1\"")
                        addProperty("cache-control", "no-cache")
                    })
                }
            }
        } else {
            val p = data.getAsJsonObject("params")
            // Gson 构造（cr-82）：手拼 JSON 在含引号值（如 ifNoneMatch 的 ETag
            // 带引号字面量）上必错转义——结构化构造后序列化。
            val echoed = com.google.gson.JsonObject().apply {
                addProperty("upstreamMethod", data.get("method").asString)
                addProperty("path", p.get("path").asString)
                addProperty("body", p.get("bodyB64")?.let { String(unb64u(it.asString)) } ?: "")
                p.get("ifNoneMatch")?.asString?.let { addProperty("ifNoneMatch", it) }
            }.toString()
            com.google.gson.JsonObject().apply {
                addProperty("status", 200)
                addProperty("contentType", "application/json")
                addProperty("bodyB64", b64u(echoed.toByteArray()))
                // cr-82：核心端 proxyToSelf 的缓存头白名单帧（etag/cache-control）
                add("cacheHeaders", com.google.gson.JsonObject().apply {
                    addProperty("etag", "\"av-1-2\"")
                    addProperty("cache-control", "no-cache")
                })
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
        // 静态面在线代理后（cr-101 变体B），同口 HTTP 静态必须走会应答的上游——
        // 永不应答的 FakeUpstream 会让每个静态请求挂 15s 超时再回落。
        val up = ProxyFakeUpstream(staticHtml = "<html>core</html>")
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val client = HttpClient(CIO) { install(WebSockets) }
            // 1) 静态资源（同口 HTTP，在线经 http/static 从核心端取）
            val html = client.get("http://127.0.0.1:$port/").bodyAsText()
            assertEquals("<html>core</html>", html, "在线静态应来自核心端")
            // SPA fallback：未知路径同样代理（核心端回 index.html）
            val fb = client.get("http://127.0.0.1:$port/nonexistent/route").bodyAsText()
            assertEquals(html, fb)
            // 2) WS 同口：ws/ready + 上行 rpc/call + 下行广播
            //（静态代理请求也走 up.send——rpc/call 断言以基线计数，不写死绝对值）
            val base = up.sent.size
            client.webSocket("ws://127.0.0.1:$port/ws") {
                val ready = (withTimeout(5000) { incoming.receive() } as Frame.Text).readText()
                assertContains(ready, "\"ws/ready\"")
                assertContains(ready, "\"protocol\":1")
                assertEquals(1, bridge.clientCount)

                // 上行：rpc/call 应进上游
                send(Frame.Text("""{"type":"rpc/call","data":{"method":"agents/list","requestId":"b-1"}}"""))
                var waited = 0
                while (up.sent.size <= base && waited < 50) { Thread.sleep(50); waited++ }
                assertEquals(base + 1, up.sent.size)
                assertContains(up.sent.last(), "agents/list")

                // 出站语义帧不入站（rpc/result 不应触发上游）
                send(Frame.Text("""{"type":"rpc/result","data":{"requestId":"x"}}"""))
                Thread.sleep(200)
                assertEquals(base + 1, up.sent.size)

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

    /**
     * cr-56：固定端口是产品语义——localStorage 按 origin（含端口）分区，
     * 桥必须监听请求的端口。占住固定端口后 start 应回退随机而非失败。
     */
    @Test
    fun fixedPortListensAndOccupiedFallsBackToRandom() = runBlocking {
        // 1) 指定固定端口 → 实际监听该端口
        val up1 = FakeUpstream()
        val b1 = LoopbackBridge(up1, distDir, port = 0) // 先随机拿一个可用端口
        val probePort = b1.start()
        try {
            val up2 = FakeUpstream()
            val b2 = LoopbackBridge(up2, distDir, port = probePort) // 与 b1 同端口
            val p2 = b2.start() // 应回退随机（probePort 被 b1 占着）
            assertTrue(p2 != probePort, "被占端口应回退随机端口（$p2 == $probePort 即未回退）")
            b2.stop()
        } finally {
            b1.stop()
        }

        // 2) 未被占的固定端口 → 实际监听它（非随机值）
        val up3 = FakeUpstream()
        val b3 = LoopbackBridge(up3, distDir, port = 0)
        val freePort = b3.start()
        b3.stop()
        val up4 = FakeUpstream()
        val b4 = LoopbackBridge(up4, distDir, port = freePort)
        val p4 = b4.start()
        assertEquals(freePort, p4, "未占用固定端口应原样监听")
        b4.stop()
    }

    /** cr-49：链路重连只换上行通道，桥不死端口不变，下行随新通道恢复 */
    @Test
    fun swapUpstreamKeepsPortAndDownlinkAlive() = runBlocking {
        val up1 = FakeUpstream()
        val bridge = LoopbackBridge(up1, distDir)
        val port = bridge.start()
        try {
            val client = HttpClient(CIO) { install(WebSockets) }
            client.webSocket("ws://127.0.0.1:$port/ws") {
                withTimeout(5000) { incoming.receive() } // ready
                // 链路重连：换上游（旧链 close 由调用方负责）
                val up2 = FakeUpstream()
                bridge.swapUpstream(up2)
                // 端口不变
                assertEquals(port, bridge.port)
                // 上行走新通道
                send(Frame.Text("""{"type":"rpc/call","data":{"method":"agents/list","requestId":"s-1"}}"""))
                var waited = 0
                while (up2.sent.isEmpty() && waited < 50) { Thread.sleep(50); waited++ }
                assertEquals(1, up2.sent.size, "swap 后上行应走新通道")
                assertEquals(0, up1.sent.size, "旧通道不再收")
                // 下行随新通道恢复广播
                up2.onPayload?.invoke("""{"type":"rpc/result","data":{"requestId":"s-1","ok":true}}""")
                val down = (withTimeout(5000) { incoming.receive() } as Frame.Text).readText()
                assertContains(down, "\"ok\":true")
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

            // cr-82：缓存头白名单帧下行进响应头（WebView 原生 HTTP 缓存前提）
            assertEquals("\"av-1-2\"", client.get("http://127.0.0.1:$port/api/workspaces")
                .headers[HttpHeaders.ETag])
            assertEquals("no-cache", client.get("http://127.0.0.1:$port/api/workspaces")
                .headers[HttpHeaders.CacheControl])
            // cr-82：WebView 重协商条件请求 If-None-Match 原样上行
            val cond = client.get("http://127.0.0.1:$port/api/workspaces") {
                header(HttpHeaders.IfNoneMatch, "\"av-1-2\"")
            }.bodyAsText()
            assertContains(cond, "\"ifNoneMatch\":\"\\\"av-1-2\\\"\"")

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

    // ---- 静态面在线代理（cr-101 变体B）----

    /** 在线：静态走 http/static（read 档）；If-None-Match 命中 → 304 零字节 */
    @Test
    fun staticProxyOnlineWithConditionalRequest() = runBlocking {
        val up = ProxyFakeUpstream(staticHtml = "<html>core</html>")
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val client = HttpClient(CIO)
            // 200：正文来自核心端，缓存协商头透传
            val resp = client.get("http://127.0.0.1:$port/index.html")
            assertEquals(HttpStatusCode.OK, resp.status)
            assertEquals("<html>core</html>", resp.bodyAsText())
            assertEquals("\"idx-1\"", resp.headers[HttpHeaders.ETag])
            assertEquals("no-cache", resp.headers[HttpHeaders.CacheControl])
            // 304：If-None-Match 命中——免重装的核心收益（零字节下行）
            val cond = client.get("http://127.0.0.1:$port/index.html") {
                header(HttpHeaders.IfNoneMatch, "\"idx-1\"")
            }
            assertEquals(HttpStatusCode.NotModified, cond.status)
            // 静态分流走 http/static（非 http/read）
            assertTrue(up.sent.any { it.contains("\"http/static\"") }, "应走 http/static")
            assertTrue(up.sent.none { it.contains("\"http/read\"") }, "静态不应混入 http/read")
        } finally {
            bridge.stop()
        }
    }

    /** 断链（链路已关 send 即抛）：runCatching 兜住 → 本地 dist（不 502 不白屏） */
    @Test
    fun staticOfflineFallsBackToLocalDist() = runBlocking {
        if (distDir == null) return@runBlocking // 本机无 dist（CI 未构建）——跳过
        // RelayClient.send 在链路关闭后的真实签名就是抛 "not connected"
        val up = object : Upstream {
            override var onPayload: ((String) -> Unit)? = null
            override fun send(payloadJson: String) = throw RelayClientException("not connected")
        }
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val html = HttpClient(CIO).get("http://127.0.0.1:$port/").bodyAsText()
            assertContains(html, "<div id=\"app\">", message = "断链应回落本地 dist")
        } finally {
            bridge.stop()
        }
    }

    /** 上游失败（旧核心端不认 http/static / rpc 错误应答）→ 回落本地 dist */
    @Test
    fun staticProxyFailureFallsBackToLocalDist() = runBlocking {
        if (distDir == null) return@runBlocking
        val up = ProxyFakeUpstream(fail = true)
        val bridge = LoopbackBridge(up, distDir)
        val port = bridge.start()
        try {
            val html = HttpClient(CIO).get("http://127.0.0.1:$port/").bodyAsText()
            assertContains(html, "<div id=\"app\">", message = "失败应回落本地 dist")
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
