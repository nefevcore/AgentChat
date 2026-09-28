// ============================================================
// RelayReconnectTimeoutTest —— KK 重连发起方的**超时契约**回归锁
//
// 背景（M3 真机 §3.3 实测根因）：relay 只转发实时帧——m1 若早于对端进房即被丢弃
// （双方进房时序不定，RELAY_DEBUG 日志实录）。单次长等待会让两端各自退避到上限
// 反复错开；正确解法是发起方**短超时 + 整链重试**（每轮新 dial / 新握手），
// 对齐 scripts/remote-loopback-client.ts 的既有裁决。
//
// 本测试锁的就是那个前提：m2 不到时必须**按超时快速失败**，而不是长挂。
// 若有人把超时改回 15s，重试节奏会重新与对端错开——本条即红灯。
//
// 夹具 = 最小 relay（ktor server）：应答 join，此后永不回 m2（等价「对端不在房」）。
// ============================================================
package agentchat.noise

import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import java.net.ServerSocket
import kotlin.system.measureTimeMillis
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertTrue

class RelayReconnectTimeoutTest {

    private companion object {
        /** relay 的 joined 控制帧 */
        const val JOINED_FRAME = "{\"op\":\"joined\"}"

        /** 取一个当前空闲的端口（随后立即释放给 ktor 绑定） */
        fun freePort(): Int = ServerSocket(0).use { it.localPort }
    }

    /**
     * 最小 relay：完成 WS 升级后，收到含 join 的文本帧即回 joined；
     * 其余入站帧一律丢弃——这正是「m1 无 peer 可投」的真实语义。
     */
    private fun startSilentRelay(port: Int) = embeddedServer(CIO, port = port) {
        install(WebSockets)
        routing {
            webSocket("/") {
                for (frame in incoming) {
                    if (frame is Frame.Text && frame.readText().contains("join")) {
                        send(Frame.Text(JOINED_FRAME))
                    }
                }
            }
        }
    }.start(wait = false)

    @Test
    fun kkReconnectFailsFastWhenM2NeverArrives() {
        val port = freePort()
        val server = startSilentRelay(port)
        try {
            val device = generateStaticIdentity()
            val core = generateStaticIdentity()
            val elapsed = measureTimeMillis {
                val outcome = runBlocking {
                    runCatching {
                        RelayClient().reconnect(
                            "ws://127.0.0.1:" + port,
                            "rSilentRelayTimeoutTest001",
                            core.publicKey,
                            device,
                            1_000L,
                        )
                    }
                }
                assertTrue(outcome.isFailure, "m2 未到达时必须抛错（不得长挂）");
            };
            assertTrue(elapsed < 6_000, "短超时未生效：耗时 " + elapsed + "ms");
        } finally {
            server.stop(0, 0)
        }
    }

    @Test
    fun defaultTimeoutIsAlsoShort() {
        // 缺省值（KK_HANDSHAKE_TIMEOUT_MS）必须同为短窗——调用方常不显式传参
        val port = freePort()
        val server = startSilentRelay(port)
        try {
            val device = generateStaticIdentity()
            val core = generateStaticIdentity()
            val elapsed = measureTimeMillis {
                val outcome = runBlocking {
                    runCatching {
                        RelayClient().reconnect(
                            "ws://127.0.0.1:" + port,
                            "rSilentRelayTimeoutTest002",
                            core.publicKey,
                            device,
                        )
                    }
                }
                assertTrue(outcome.isFailure, "缺省超时下也必须抛错");
            };
            assertTrue(elapsed < 9_000, "缺省超时过长：耗时 " + elapsed + "ms（应 3s 量级）");
        } finally {
            server.stop(0, 0)
        }
    }
}
