package agentchat.noise

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * X25519Pure —— RFC 7748 公开向量锚定（§5.2 两例 + §6.1 两例）+ 低阶点边界。
 * 这些向量同时锚定 node:crypto 互操作（核心端 ac-noise-core 走 node:crypto，
 * 与本实现须逐字节一致）。
 */
class X25519PureTest {

    private fun hex(h: String): ByteArray =
        ByteArray(h.length / 2) { i -> ((Character.digit(h[i * 2], 16) shl 4) + Character.digit(h[i * 2 + 1], 16)).toByte() }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    @Test
    fun rfc7748_5_2_vector1() {
        val k = hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
        val u = hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
        assertEquals(
            "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
            x25519ScalarMult(k, u).toHex(),
        )
    }

    @Test
    fun rfc7748_5_2_vector2() {
        val k = hex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d")
        val u = hex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493")
        assertEquals(
            "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
            x25519ScalarMult(k, u).toHex(),
        )
    }

    @Test
    fun rfc7748_6_1_dh_vector() {
        // Alice 私钥 → 公钥（basepoint 自乘）
        val alicePriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        assertEquals(
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
            x25519PublicKey(alicePriv).toHex(),
        )
        // Bob 私钥 × Alice 公钥 = 共享密钥
        val bobPriv = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        assertEquals(
            "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
            x25519ScalarMult(bobPriv, x25519PublicKey(alicePriv)).toHex(),
        )
    }

    @Test
    fun dh_falls_back_to_pure_and_matches_vector() {
        // dh() 在 JVM（KeyFactory/KeyAgreement 可用）走 JCA；结果须与纯实现一致
        val k = hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
        val u = hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
        assertEquals(x25519ScalarMult(k, u).toHex(), dh(k, u).toHex())
    }

    @Test
    fun identity_generation_via_basepoint_path() {
        // 无 KeyPairGenerator 平台的生成路径：随机私钥 → 公钥 = X25519(priv, 9)
        val id = generateStaticIdentity(java.security.SecureRandom())
        assertEquals(x25519PublicKey(id.privateKey).toHex(), id.publicKey.toHex())
    }
}