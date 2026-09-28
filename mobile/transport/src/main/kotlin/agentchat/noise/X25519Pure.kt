// ============================================================
// X25519Pure.kt —— 纯 Kotlin X25519（RFC 7748 Montgomery ladder，BigInteger）
//
// 为什么需要：真机 Android API ≤ 32 的 JCA 完全没有 X25519——
// KeyFactory / KeyAgreement / KeyPairGenerator 对 X25519/XDH/X25519DH 全部
// NoSuchAlgorithmException（M3 真机验证实录：Redmi K20 / API 30 连 BC provider
// 也没有——Android 平台裁剪版 BouncyCastle 不带 XDH；API 33+ Conscrypt 才有）。
// 模拟器（API 33+）掩盖了这一缺口，真机 §1.3 首配即闪退（crash 栈直达本点）。
//
// 选型：BigInteger ladder（RFC 7748 §5 伪代码逐行直译）而非 limb 表示——握手是
// 每链路一次性的低频运算，可读性与正确性优先；常数时间性由 JCA 路径承担
//（X25519Platform 探测优先平台实现，本实现仅兜底）。正确性由 RFC 7748 §5.2/§6.1
// 公开向量锚定（X25519PureTest），与 node:crypto（核心端 ac-noise-core）互操作。
//
// 边界语义与 Noise.kt 的 dh() 一致：低阶点全零输出交调用方判（spec §7.1 抛错）。
// ============================================================
package agentchat.noise

import java.math.BigInteger

private val PRIME = BigInteger.valueOf(2).pow(255).subtract(BigInteger.valueOf(19))
private val A24 = BigInteger.valueOf(121665)

/** RFC 7748 §6.1 basepoint（u = 9） */
private val BASEPOINT = ByteArray(32).also { it[0] = 9 }

private fun modP(v: BigInteger): BigInteger = v.mod(PRIME)

private fun toLEBigInteger(b: ByteArray): BigInteger {
    val le = b.copyOf().also { it.reverse() }
    return BigInteger(1, le)
}

private fun toLEBytes(v: BigInteger): ByteArray {
    val be = v.toByteArray() // 可能带前导零或符号位字节
    val out = ByteArray(32)
    for (i in be.indices) out[be.size - 1 - i] = be[i]
    return out
}

/** RFC 7748 §5 Montgomery ladder——k 任意（内部 clamp）、u 原样（内部掩码高位） */
internal fun x25519ScalarMult(k: ByteArray, u: ByteArray): ByteArray {
    val kBuf = clampScalar(k) // decodeScalar25519（clamp 幂等）
    val uBuf = u.copyOf()
    uBuf[31] = (uBuf[31].toInt() and 0x7f).toByte() // decodeUCoordinate
    val x1 = toLEBigInteger(uBuf)
    var x2 = BigInteger.valueOf(1)
    var z2 = BigInteger.valueOf(0)
    var x3 = x1
    var z3 = BigInteger.valueOf(1)
    var swap = 0
    for (t in 254 downTo 0) {
        val kt = (kBuf[t / 8].toInt() shr (t and 7)) and 1
        swap = swap xor kt
        if (swap == 1) {
            var tmp = x2; x2 = x3; x3 = tmp
            tmp = z2; z2 = z3; z3 = tmp
        }
        swap = kt
        val a = modP(x2.add(z2))
        val aa = modP(a.multiply(a))
        val b = modP(x2.subtract(z2))
        val bb = modP(b.multiply(b))
        val e = modP(aa.subtract(bb))
        val c = modP(x3.add(z3))
        val d = modP(x3.subtract(z3))
        val da = modP(d.multiply(a))
        val cb = modP(c.multiply(b))
        val dacb = da.add(cb)
        val dmscb = da.subtract(cb)
        x3 = modP(dacb.multiply(dacb))
        z3 = modP(x1.multiply(modP(dmscb.multiply(dmscb))))
        x2 = modP(aa.multiply(bb))
        z2 = modP(e.multiply(modP(aa.add(A24.multiply(e)))))
    }
    if (swap == 1) {
        var tmp = x2; x2 = x3; x3 = tmp
        tmp = z2; z2 = z3; z3 = tmp
    }
    if (z2.signum() == 0) return ByteArray(32) // 低阶点：调用方判全零
    return toLEBytes(modP(x2.multiply(z2.modPow(PRIME.subtract(BigInteger.valueOf(2)), PRIME))))
}

/** 由 basepoint 派生公钥：pub = X25519(clamp(priv), 9)——KeyPairGenerator 缺席时的生成路径 */
internal fun x25519PublicKey(privRaw: ByteArray): ByteArray = x25519ScalarMult(privRaw, BASEPOINT)