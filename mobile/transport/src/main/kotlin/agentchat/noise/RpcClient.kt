// ============================================================
// RpcClient —— 本地 RPC 面轻量客户端（web-server 的 ws 契约）。
//
// 契约（与 ac-web-server 同构）：
//   发 { type:"rpc/call", data:{ method, requestId, params } }
//   收 { type:"rpc/result", data:{ requestId, ok, result|error } }（另有 ws/ready、ws/ack）
// 解包：ok=true → 返回 result 对象；否则返回 { __rpcError } 载体（调用方判空）。
// requestId 唯一（带纳秒后缀）——避开 web-server 30s 幂等去重窗（同 method+requestId）。
// ============================================================
package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.CompletableDeferred
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class RpcClient {
    private val gson = Gson()
    private val client = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).build()
    private var nextId = 0
    private val waiters = HashMap<String, CompletableDeferred<JsonObject>>()
    private lateinit var ws: WebSocket

    suspend fun connect(url: String) {
        val d = CompletableDeferred<Unit>()
        val req = Request.Builder().url(url).header("Origin", "http://localhost:5173").build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { d.complete(Unit) }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val f = gson.fromJson(text, JsonObject::class.java)
                val data = f.get("data")?.asJsonObject ?: return
                val rid = data.get("requestId")?.asString ?: return
                val payload = if (data.get("ok")?.asBoolean == true) {
                    (data.get("result")?.takeIf { it.isJsonObject })?.asJsonObject ?: JsonObject()
                } else {
                    JsonObject().apply {
                        addProperty("__rpcError", data.get("error")?.asString ?: data.toString().take(200))
                    }
                }
                waiters.remove(rid)?.complete(payload)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                d.completeExceptionally(t)
                waiters.values.forEach { it.completeExceptionally(t) }
            }
        })
        d.await()
    }

    suspend fun call(method: String, params: JsonObject? = null): JsonObject {
        val rid = "kt-" + (++nextId) + "-" + System.nanoTime() % 100000
        val d = CompletableDeferred<JsonObject>()
        waiters[rid] = d
        val body = JsonObject().apply {
            addProperty("type", "rpc/call")
            add("data", JsonObject().apply {
                addProperty("method", method)
                addProperty("requestId", rid)
                params?.let { add("params", it) }
            })
        }
        ws.send(gson.toJson(body))
        return d.await()
    }
}
