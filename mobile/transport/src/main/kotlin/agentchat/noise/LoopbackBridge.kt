// ============================================================
// LoopbackBridge —— 原生到 WebView 的回环桥（M3.2 核心）
//
// 形态（remote-client-relay-plan §4.4「传输」行）：WebView 只见 loopback 明文，
// 与本地开发完全同构。因此桥必须与 ac-web-server 同构：
//   · **同口** HTTP（静态 webui dist）+ WS（/ws）——webui 用
//     `${location.protocol}//${location.host}/ws` 同源推导连接地址（零改动前提）；
//   · 连接建立即下发 ws/ready { protocol:1, connId, serverStartedAt }；
//   · WebView → 上行：rpc/call { method, requestId, params }（加密过 relay 到核心端）；
//   · 核心端 → 下行：rpc/result 与事件帧原样推给 WebView。
//
// 纪律（照 remote-link 服务端 handleDevicePayload）：只转发入站 rpc/call，
// 其余类型忽略——出站语义的帧不应入站。
//
// 静态面（cr-101 变体B）：在线时 GET 静态路径原样投核心端（http/static RPC，
// read 档）——核心端 dist 是 webui 唯一事实源，前端更新免重装 APK；断链或
// 上游失败回落本地 dist（离线兜底 = 旧壳行为）。
//
// 书写坑（Kotlin 专属，踩过一次）：**块注释可嵌套**——KDoc/块注释里出现
// 通配路径字面量（斜杠 + 星号）会开启嵌套注释，需多一个收尾符，否则整文件
// 报「Unclosed comment」且报错行指向无关位置。行注释（双斜杠）里无此问题。
// ============================================================
package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.defaultForFile
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.server.request.receiveStream
import io.ktor.server.request.uri
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.consumeEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** 上行通道（真实实现 = RelayClient；测试可注入假实现） */
interface Upstream {
    fun send(payloadJson: String)
    var onPayload: ((String) -> Unit)?
}

/**
 * 回环桥：同口 HTTP 静态资源 + WS 业务面。
 *
 * 端口语义（cr-56）：WebView 的 localStorage 按 origin（含端口）分区——端口
 * 漂移即换分区，webui 全部持久化清零。故固定端口是产品语义不是偏好；被占
 * （其他 App 先拿到同端口）才回退 port=0 随机，由调用方把实际端口记下来
 * 下次优先复用，避免漂移固化。
 *
 * @param staticDir webui dist 目录（缺失时仅 WS 面可用——测试态）
 */
class LoopbackBridge(
    private val upstream: Upstream,
    private val staticDir: File? = null,
    private val host: String = "127.0.0.1",
    port: Int = 0,
) {
    private val configuredPort = port
    private val gson = Gson()
    private val connSeq = AtomicInteger()
    private val sockets = ConcurrentHashMap<String, io.ktor.websocket.WebSocketSession>()
    private val serverStartedAt = System.currentTimeMillis()
    private var engine: ApplicationEngine? = null
    private var actualPort = 0
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** 下行/上行观察口（测试与日志；不影响转发） */
    var onDownlink: ((String) -> Unit)? = null
    var onUplink: ((String) -> Unit)? = null

    /** 桥自身发起的 RPC 应答等待表（requestId 前缀 bridge- 区分 WebView 的调用） */
    private val pendingRpc = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()
    private val rpcSeq = AtomicInteger()

    /** 当前上行通道（swapUpstream 可换——链路重连时桥不死） */
    @Volatile private var currentUpstream: Upstream = upstream

    /** 上行通道可用（cr-101 变体B：静态面在线代理的前提；断链回落本地 dist） */
    @Volatile private var upstreamLive = false

    /**
     * 换上行通道（cr-49：KK 重连成功后桥不死、端口不变，只换通道——WebView 零感知）。
     * 旧通道静默废弃（调用方已 close）；pendingRpc 的在途请求随旧链丢失，由请求方超时自愈。
     */
    fun swapUpstream(newUpstream: Upstream) {
        newUpstream.onPayload = { json -> handleDownlink(json) }
        currentUpstream = newUpstream
        upstreamLive = true
    }

    /**
     * 启动桥，返回实际监听端口（port=0 时由系统分配）。
     * 固定端口 bind 失败（被占）时回退 port=0 随机——fail-soft，不因端口冲突
     * 断链路；实际端口由调用方持久化、下次优先复用，避免漂移固化（cr-56）。
     */
    fun start(awaitMs: Long = 10_000): Int {
        currentUpstream.onPayload = { json -> handleDownlink(json) }
        upstreamLive = true
        return try {
            startAndWait(configuredPort, awaitMs)
        } catch (ex: Exception) {
            if (configuredPort == 0) throw ex
            System.err.println("loopback bridge: 固定端口 $configuredPort 启动失败（" + ex.message + "）——回退随机端口")
            startAndWait(0, awaitMs)
        }
    }

    /**
     * 单次启动尝试：建引擎 → 起 → 轮询 resolvedConnectors 拿实际端口。
     * bind 失败也走「监听超时」抛出（CIO 异步绑定，失败经解析轮询浮出）——
     * 由 start() 统一回退；超时收尾自清，不留半启动引擎。
     */
    private fun startAndWait(port: Int, awaitMs: Long): Int {
        val e = embeddedServer(CIO, host = host, port = port) {
            install(WebSockets)
            routing {
                webSocket("/ws") {
                    val connId = "c" + connSeq.incrementAndGet()
                    sockets[connId] = this
                    send(Frame.Text(readyFrame(connId)))
                    try {
                        incoming.consumeEach { frame ->
                            if (frame is Frame.Text) handleUplink(frame.readText())
                        }
                    } finally {
                        sockets.remove(connId)
                    }
                }
                // ---- 核心端 HTTP 面：通用转发（M3.4）----
                // WebView 只见 loopback，而 webui 除 RPC 面外还依赖 /api/* 同源 HTTP
                // 端点。**不逐端点 bridge**——那要一直追着 webui 的新端点跑（M3.2 的
                // boot-graph、M3.3 的 extensions/workspace 已是同一模式两次）。
                // 这里把任何 /api/* 原样投给核心端自身 web-server，桥不理解端点语义。
                get("/api/{...}") { call.proxyApiSafely() }
                post("/api/{...}") { call.proxyApiSafely() }
                put("/api/{...}") { call.proxyApiSafely() }
                patch("/api/{...}") { call.proxyApiSafely() }
                delete("/api/{...}") { call.proxyApiSafely() }
                // ---- 静态面：在线代理核心端（cr-101 变体B）----
                // 在线时 GET 静态路径原样投核心端（WebView 永远跑核心端匹配的 dist
                // ——前端更新免重装 APK；缓存协商走 If-None-Match/cacheHeaders，
                // assets/* 内容哈希文件名 + immutable 命中 WebView 缓存零流量）；
                // 上游失败回落本地 dist（离线兜底，行为等同旧壳）。
                get("/{...}") { call.proxyStaticSafely() }
                get("/") { call.proxyStaticSafely() }
            }
        }
        e.start(wait = false)
        val deadline = System.currentTimeMillis() + awaitMs
        while (System.currentTimeMillis() < deadline) {
            val p = runCatching {
                kotlinx.coroutines.runBlocking { e.resolvedConnectors().first().port }
            }.getOrNull() ?: 0
            if (p > 0) { engine = e; actualPort = p; return p }
            Thread.sleep(50)
        }
        e.stop(500, 1000)
        throw RelayClientException("loopback bridge: 监听超时（port=$port）")
    }

    fun stop() {
        upstreamLive = false
        scope.cancel()
        engine?.stop(500, 1000)
    }

    val port: Int get() = actualPort
    val clientCount: Int get() = sockets.size

    /**
     * 下行分流：桥自身 RPC 的应答（rpc/result 且 requestId 命中等待表）由桥内部消费，
     * 其余（WebView 的 RPC 应答、事件帧）一律广播给 WebView。
     */
    private fun handleDownlink(json: String) {
        onDownlink?.invoke(json)
        val obj = runCatching { gson.fromJson(json, JsonObject::class.java) }.getOrNull()
        if (obj?.get("type")?.asString == "rpc/result") {
            val data = obj.getAsJsonObject("data")
            val rid = data?.get("requestId")?.asString
            if (rid != null) {
                val waiter = pendingRpc.remove(rid)
                if (waiter != null) { waiter.complete(data); return }
            }
        }
        broadcast(json)
    }

    /** 下行广播（核心端载荷原样推给全部 WebView 连接） */
    fun broadcast(json: String) {
        for (session in sockets.values) {
            scope.launch {
                runCatching { session.send(Frame.Text(json)) }
            }
        }
    }

    /** 在途请求合并键（cr-52：移动网络下大应答慢，webui 重试同 path 的 GET 会
     *  打出重发风暴——宿主每秒重发 1.35MB 应答把上行带宽打满，形成拥塞死循环。
     *  相同 (method,path) 的在途请求合并等同一个应答，不重发。） */
    private val inflightHttp = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()

    /** 经加密链路调核心端 RPC（桥自身使用；解包 ok/result，失败抛错） */
    suspend fun callUpstream(method: String, params: JsonObject? = null, timeoutMs: Long = 15000): JsonObject {
        // http 代理面的在途合并（rpc/call 直接放行——非幂等）
        val mergeKey = if (method == "http/read" || method == "http/write") {
            method + " " + (params?.get("path")?.asString ?: "")
        } else null
        if (mergeKey != null) {
            inflightHttp[mergeKey]?.let { existing ->
                // 已有同 path 在途——等它（新 timeout 与原请求共享命运）
                return withTimeout(timeoutMs) { existing.await() }
            }
        }
        val rid = "bridge-" + rpcSeq.incrementAndGet() + "-" + System.nanoTime() % 100000
        val d = CompletableDeferred<JsonObject>()
        pendingRpc[rid] = d
        if (mergeKey != null) {
            inflightHttp[mergeKey] = d
            d.invokeOnCompletion { inflightHttp.remove(mergeKey) }
        }
        val frame = JsonObject().apply {
            addProperty("type", "rpc/call")
            add("data", JsonObject().apply {
                addProperty("method", method)
                addProperty("requestId", rid)
                params?.let { add("params", it) }
            })
        }
        currentUpstream.send(gson.toJson(frame))
        return try {
            val data = withTimeout(timeoutMs) { d.await() }
            if (data.get("ok")?.asBoolean == true) {
                (data.get("result")?.takeIf { it.isJsonObject })?.asJsonObject ?: JsonObject()
            } else {
                throw RelayClientException("upstream rpc " + method + ": " +
                    (data.get("error")?.asString ?: "unknown"))
            }
        } finally {
            pendingRpc.remove(rid)
        }
    }

    /**
     * /api/ 任意子路径的通用转发：方法 / 路径（含 query）/ Content-Type / body 字节原样上行，
     * 核心端响应的状态码 / Content-Type / 字节 / 缓存头（cr-82 白名单）原样下行。
     *
     * 读写分流到不同档位：GET → http/read（read 档）；其余 → http/write（files 档，
     * 须显式开启）——读权限不该能写。
     *
     * 上游失败一律显式 JSON + 502，**绝不回落 index.html**（回落 HTML 会让前端解析出
     * undefined 而非可控错误，掩盖真实缺口——M3.2 实测教训）。
     */
    private suspend fun ApplicationCall.proxyApiSafely() {
        try {
            proxyToUpstream()
        } catch (t: Throwable) {
            // Ktor 的未捕获异常默认是**空体 500**（且 SLF4J 被静音时零输出）——
            // 现场排查等于瞎猜。这里一律转成带原因的 JSON（M3.4 实测教训）。
            println("[bridge] 代理异常: " + t)
            respondText(
                gson.toJson(mapOf("error" to ("remote bridge handler: " + t))),
                ContentType.Application.Json,
                HttpStatusCode.InternalServerError,
            )
        }
    }

    private suspend fun ApplicationCall.proxyToUpstream() {
        val method = request.httpMethod.value.uppercase()
        val isRead = method == "GET"
        val body = if (isRead) ByteArray(0) else receiveStream().readBytes()
        val params = JsonObject().apply {
            addProperty("method", method)
            addProperty("path", request.uri)
            request.headers[HttpHeaders.ContentType]?.let { addProperty("contentType", it) }
            if (body.isNotEmpty()) addProperty("bodyB64", b64u(body))
            // 条件请求上行（cr-82）：核心端头像等 /api/* 资源已带 ETag——WebView
            // 重协商请求的 If-None-Match 原样上行，核心端才有机会回 304 零字节。
            request.headers[HttpHeaders.IfNoneMatch]?.let { addProperty("ifNoneMatch", it) }
        }
        // 诊断口：本模块同时被 JVM 轨（测试/CLI）与 Android 轨编译，不能用 android.util.Log
        // （android 子包被 JVM 轨排除）。println 两端都可达（Android 侧进 logcat 的 System.out）。
        println("[bridge] 代理 → " + method + " " + request.uri + " (body " + body.size + "B)")
        val outcome = runCatching { callUpstream(if (isRead) "http/read" else "http/write", params) }
        println("[bridge] 代理 ← " + (outcome.getOrNull()?.get("status")?.asInt ?: -1) +
            (outcome.exceptionOrNull()?.let { " 失败: " + it.message } ?: ""))
        outcome.fold(
            onSuccess = { o -> replyProxied(o) },
            onFailure = { err ->
                respondText(
                    gson.toJson(mapOf("error" to ("remote bridge: " + (err.message ?: "upstream failed")))),
                    ContentType.Application.Json,
                    HttpStatusCode.BadGateway,
                )
            },
        )
    }

    /**
     * 静态面代理（cr-101 变体B）：核心端 dist 是 webui 的唯一事实源。
     *
     * 在线时 GET 静态路径 → http/static RPC（read 档，核心端对路径再做白名单
     * 闸——/api/ 前缀原路、dist 顶层白名单放行）；断链（upstreamLive=false）直接
     * 回落本地 dist。确定性失败（旧核心端不认方法/RPC 错误应答）回落本地；
     * **超时不回落**（cr-246 真机实锤：启动期并发拉 chunk 打满 15s 超时 →
     * 回落本地旧 dist → 新 chunk 本地缺失 404 →「页面资源已更新」弹窗死循环。
     * 超时 = 上游忙/慢 ≠ 资源不存在，回落只会造成哈希断代）——直报 504，
     * WebView 侧的 import 重试机制自会再拉。资源拉取非交互面，窗放宽到 60s。
     */
    private suspend fun ApplicationCall.proxyStaticSafely() {
        if (!upstreamLive) { serveLocal(); return }
        val params = JsonObject().apply {
            addProperty("method", "GET")
            addProperty("path", request.uri)
            request.headers[HttpHeaders.IfNoneMatch]?.let { addProperty("ifNoneMatch", it) }
        }
        // 静态拉取超时的恢复策略（cr-256）：超时主因是链路静默死（WiFi 半开——OkHttp
        // 判死需两个 ping 周期 ~30s，期间所有 RPC 白等 60s）。第一次超时后等链路恢复
        // （最多 20s，500ms 轮询 upstreamLive）再重试一次；仍失败才 504——把「链路瞬断」
        // 吸收在桥内，WebView 的 import 不至于立刻失败弹窗。
        var outcome = runCatching { callUpstream("http/static", params, timeoutMs = 60_000) }
        if (outcome.isFailure && outcome.exceptionOrNull() is kotlinx.coroutines.TimeoutCancellationException) {
            val revived = waitUpstreamAlive(20_000)
            if (revived) {
                println("[bridge] 静态代理超时后链路已恢复，重试: " + request.uri)
                outcome = runCatching { callUpstream("http/static", params, timeoutMs = 30_000) }
            }
        }
        outcome.fold(
            onSuccess = { o -> replyProxied(o) },
            onFailure = { err ->
                if (err is kotlinx.coroutines.TimeoutCancellationException) {
                    println("[bridge] 静态代理超时（上游忙，不回落本地防哈希断代）: " + request.uri)
                    respondText("upstream busy (timeout, no local fallback)", ContentType.Application.Json, HttpStatusCode.GatewayTimeout)
                } else {
                    // 确定性失败（断链/旧核心端不认 http/static）→ 本地 dist 兜底
                    println("[bridge] 静态代理失败回落本地: " + (err.message ?: "upstream failed"))
                    serveLocal()
                }
            },
        )
    }

    /** 等上行通道恢复（半开链路被 OkHttp ping 判死后 KK 重连的窗口）；到期仍未活返回 false */
    private suspend fun waitUpstreamAlive(maxMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + maxMs
        while (System.currentTimeMillis() < deadline) {
            if (upstreamLive) return true
            kotlinx.coroutines.delay(500)
        }
        return upstreamLive
    }

    /** 代理应答写回（API 面与静态面共源）：状态码 / 缓存头 / 字节原样下行 */
    private suspend fun ApplicationCall.replyProxied(o: JsonObject) {
        val status = o.get("status")?.asInt ?: 200
        val bytes = o.get("bodyB64")?.asString?.let { unb64u(it) } ?: ByteArray(0)
        o.get("cacheHeaders")?.takeIf { it.isJsonObject }?.asJsonObject?.entrySet()?.forEach { (k, v) ->
            if (v.isJsonPrimitive) response.headers.append(k, v.asJsonPrimitive.asString)
        }
        respondBytes(bytes, contentTypeOf(o.get("contentType")?.asString), HttpStatusCode.fromValue(status))
    }

    /** 本地静态（离线兜底 = 旧壳行为）；本地也缺失才 404 */
    private suspend fun ApplicationCall.serveLocal() {
        val sub = request.path().trimStart('/')
        serveStatic(if (sub.isEmpty()) "index.html" else sub)
    }

    /** 上游 Content-Type 解析（异常字面量回落 octet-stream，不因它废掉整次转发） */
    private fun contentTypeOf(raw: String?): ContentType =
        raw?.let { runCatching { ContentType.parse(it) }.getOrNull() } ?: ContentType.Application.OctetStream

    private fun handleUplink(text: String) {
        val obj = runCatching { gson.fromJson(text, JsonObject::class.java) }.getOrNull() ?: return
        if (obj.get("type")?.asString != "rpc/call") return // 出站语义帧不入站
        onUplink?.invoke(text)
        currentUpstream.send(text)
    }

    /** ws/ready 帧（与 ac-web-server 同字面） */
    private fun readyFrame(connId: String): String {
        val o = JsonObject()
        o.addProperty("type", "ws/ready")
        o.add("data", gson.toJsonTree(mapOf(
            "protocol" to 1, "connId" to connId, "serverStartedAt" to serverStartedAt)))
        return gson.toJson(o)
    }

    /** 静态资源（SPA fallback：未命中文件回落 index.html） */
    private suspend fun io.ktor.server.application.ApplicationCall.serveStatic(sub: String) {
        val root = staticDir ?: return respondText("no static dir", status = HttpStatusCode.NotFound)
        val clean = sub.substringBefore('?').replace("..", "")
        val candidate = File(root, clean).takeIf { it.canonicalPath.startsWith(root.canonicalPath) }
        val target = when {
            candidate != null && candidate.isFile -> candidate
            else -> File(root, "index.html").takeIf { it.isFile }
        } ?: return respondText("not found", status = HttpStatusCode.NotFound)
        val bytes = target.readBytes()
        respondBytes(bytes, ContentType.defaultForFile(target))
    }
}
