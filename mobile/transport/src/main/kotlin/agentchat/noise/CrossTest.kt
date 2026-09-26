// ============================================================
// M3.1 跨端验证驱动器——stdin/stdout JSON 行协议与 Node 对端互通：
//   Kotlin 进程持 phone（initiator），Node 进程持 pc（responder）。
// 帧词汇：pair / xk.start / xk.m2 / frame.in / frame.send / kk.start / kk.m2 / done
// ============================================================
// hs / pcPub 是跨 when 分支共享的可变状态，分支内的 !! 为必要断言（部分位置
// 编译器已能智能转换，故报 UNNECESSARY 警告）——文件级抑制，零行为影响。
@file:Suppress("UNNECESSARY_NOT_NULL_ASSERTION")

package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter

private val gson = Gson()

private fun json(vararg pairs: Pair<String, Any>): String {
    val o = JsonObject()
    for ((k, v) in pairs) when (v) {
        is String -> o.addProperty(k, v)
        is Number -> o.addProperty(k, v)
        is Boolean -> o.addProperty(k, v)
    }
    return gson.toJson(o)
}

fun main() {
    val stdin = BufferedReader(InputStreamReader(System.`in`))
    val stdout = PrintWriter(System.out, true)
    val send: (String) -> Unit = { stdout.println(it) }

    var phone = generateStaticIdentity()
    var pcPub: ByteArray? = null
    var hs: NoiseHandshake? = null
    var pair: TransportPair? = null

    while (true) {
        val line = stdin.readLine() ?: break
        if (line.isBlank()) continue
        val obj = gson.fromJson(line, JsonObject::class.java)
        when (obj.get("op").asString) {
            "pair" -> {
                pcPub = unb64u(obj.get("pub").asString)
                send(json("op" to "pair.ok", "pub" to b64u(phone.publicKey)))
            }
            "xk.start" -> {
                hs = NoiseHandshake(NoisePattern.XK, NoiseRole.INITIATOR, phone, pcPub!!)
                send(json("op" to "xk.m1", "hs" to b64u(hs!!.writeMessage())))
            }
            "xk.m2" -> {
                hs!!.readMessage(unb64u(obj.get("hs").asString))
                if (!hs!!.remoteStaticMatches(pcPub!!)) {
                    send(json("op" to "error", "v" to "static mismatch"))
                } else {
                    val info = json("name" to "kotlin-device", "pubkey" to b64u(phone.publicKey))
                    send(json("op" to "xk.m3", "hs" to b64u(hs!!.writeMessage(info.toByteArray()))))
                    pair = hs!!.split()
                    send(json("op" to "sas", "v" to sasFromHandshakeHash(pair!!.handshakeHash)))
                }
            }
            "frame.in" -> {
                val pt = pair!!.recv.read(obj.get("n").asLong, unb64u(obj.get("ct").asString))
                send(json("op" to "frame.ack", "v" to String(pt)))
            }
            "frame.send" -> {
                val f = pair!!.send.write(obj.get("v").asString.toByteArray())
                send(json("op" to "frame.out", "n" to f.first, "ct" to b64u(f.second)))
            }
            "kk.start" -> {
                hs = NoiseHandshake(NoisePattern.KK, NoiseRole.INITIATOR, phone, pcPub!!)
                send(json("op" to "kk.m1", "hs" to b64u(hs!!.writeMessage())))
            }
            "kk.m2" -> {
                hs!!.readMessage(unb64u(obj.get("hs").asString))
                pair = hs!!.split()
                send(json("op" to "kk.done"))
            }
            "identity.reset" -> phone = generateStaticIdentity()
            "done" -> send(json("op" to "done", "ok" to true))
        }
    }
}
