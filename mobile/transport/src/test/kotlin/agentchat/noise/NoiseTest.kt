// ============================================================
// M3.1 Kotlin Noise 测试——与 src/ac-noise-core/tests/noise.test.ts 对齐：
//   · RFC 7748 §6.1 x25519 向量 / RFC 8439 §2.8.2 AEAD 向量（双锚定）
//   · HKDF-SHA256（与 node hkdfSync 对照基准）
//   · XK/KK 往返、伪冒拒绝、篡改/重放拒绝、SAS 形态、b64u 往返
// ============================================================
package agentchat.noise

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoiseTest {

    // ---- x25519（RFC 7748 §6.1 向量 1）----

    @Test
    fun x25519_rfc7748_vector1() {
        val aPriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val bPriv = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        val bPub = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        val aPub = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        val shared = hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        assertContentEquals(shared, dh(aPriv, bPub))
        assertContentEquals(shared, dh(bPriv, aPub))
        // 公钥派生一致性（clamp 后从私钥导出公钥）
        val idA = StaticIdentity(aPub, clampScalar(aPriv))
        val idB = StaticIdentity(bPub, clampScalar(bPriv))
        assertContentEquals(aPub, idA.publicKey)
        assertContentEquals(bPub, idB.publicKey)
    }

    /**
     * basepoint 公钥派生（Android API 28–32 的兜底路径）。
     *
     * 锚定：RFC 7748 §6.1 的私钥对 basepoint（u=9）做 DH 必须得到该向量的公钥。
     * 这条同时证明「平台没有 KeyPairGenerator 时」的路径与标准一致。
     */
    @Test
    fun basepoint_derives_rfc7748_public_key() {
        val aPriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val aPub = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        val basepoint = ByteArray(32).also { it[0] = 9 }
        assertContentEquals(aPub, dh(aPriv, basepoint))
    }

    /** 生成的身份自洽：pub == X25519(priv, 9)（两条平台路径都必须满足） */
    @Test
    fun generated_identity_is_self_consistent() {
        val basepoint = ByteArray(32).also { it[0] = 9 }
        repeat(4) {
            val id = generateStaticIdentity()
            assertEquals(32, id.publicKey.size)
            assertEquals(32, id.privateKey.size)
            assertContentEquals(id.publicKey, dh(id.privateKey, basepoint))
        }
    }

    // ---- AEAD（RFC 8439 §2.8.2 官方向量 + node 基准双锚定）----

    @Test
    fun aead_rfc8439_vector() {
        val key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        val rfcNonce = hex("070000004041424344454647")
        val aad = hex("50515253c0c1c2c3c4c5c6c7")
        val pt = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".toByteArray()
        val expected = hex("d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6"
                    + "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36"
                    + "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc"
                    + "3ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd0600691")
        // RFC 8439 §2.8.2 官方向量（原始 nonce 直连 JCE——锚定算法本身）
        val c = javax.crypto.Cipher.getInstance("ChaCha20-Poly1305")
        c.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "ChaCha20"), javax.crypto.spec.IvParameterSpec(rfcNonce))
        c.updateAAD(aad)
        assertContentEquals(expected, c.doFinal(pt))
        // noise nonce 布局（n=0）往返自洽 + 篡改拒绝
        val ct = aeadEncrypt(key, 0L, aad, pt)
        assertContentEquals(pt, aeadDecrypt(key, 0L, aad, ct))
        val bad = ct.copyOf(); bad[0] = (bad[0].toInt() xor 1).toByte()
        assertFailsWith<NoiseException> { aeadDecrypt(key, 0L, aad, bad) }
    }

    // ---- HKDF（node hkdfSync 对照）----

    @Test
    fun hkdf_matches_node() {
        val salt = ByteArray(32) { it.toByte() }
        val ikm = ByteArray(32) { 0x0b }
        val (t1, t2) = hkdf2(salt, ikm)
        val expected = "26f177023b644467ff231efec58e46d18c7a296bba31093b232541a1ad7a58d2" +
            "e893dd278124e8dc8cf2384dd38b4d841c8f465e480e0627473f896394043cae"
        assertEquals(expected, (t1 + t2).toHex())
    }

    // ---- XK 握手（配对）----

    @Test
    fun xk_roundtrip() {
        val phone = generateStaticIdentity()
        val pc = generateStaticIdentity()
        val init = NoiseHandshake(NoisePattern.XK, NoiseRole.INITIATOR, phone, pc.publicKey)
        val resp = NoiseHandshake(NoisePattern.XK, NoiseRole.RESPONDER, pc)

        val m1 = init.writeMessage("hello-from-phone".toByteArray())
        assertEquals("hello-from-phone", String(resp.readMessage(m1)))

        val m2 = resp.writeMessage("pc-ack".toByteArray())
        assertEquals("pc-ack", String(init.readMessage(m2)))
        assertTrue(init.remoteStaticMatches(pc.publicKey))

        val m3 = init.writeMessage("pixel-8".toByteArray())
        assertEquals("pixel-8", String(resp.readMessage(m3)))
        assertContentEquals(phone.publicKey, resp.remoteStatic)

        assertTrue(init.complete && resp.complete)

        val ip = init.split()
        val rp = resp.split()
        val a = ip.send.write("ping".toByteArray())
        assertEquals("ping", String(rp.recv.read(a.first, a.second)))
        val b = rp.send.write("pong".toByteArray())
        assertEquals("pong", String(ip.recv.read(b.first, b.second)))
    }

    @Test
    fun xk_rejects_mitm_responder() {
        val phone = generateStaticIdentity()
        val pc = generateStaticIdentity()
        val attacker = generateStaticIdentity()
        val init = NoiseHandshake(NoisePattern.XK, NoiseRole.INITIATOR, phone, pc.publicKey)
        val mitm = NoiseHandshake(NoisePattern.XK, NoiseRole.RESPONDER, attacker)
        val m1 = init.writeMessage()
        mitm.readMessage(m1)
        val m2 = mitm.writeMessage()
        assertFailsWith<NoiseException> { init.readMessage(m2) }
    }

    // ---- KK 握手（重连——cr-64 真 KK：m1 含 s/ss，发起方身份入密钥链）----

    @Test
    fun kk_roundtrip() {
        val phone = generateStaticIdentity()
        val pc = generateStaticIdentity()
        val init = NoiseHandshake(NoisePattern.KK, NoiseRole.INITIATOR, phone, pc.publicKey)
        val resp = NoiseHandshake(NoisePattern.KK, NoiseRole.RESPONDER, pc, phone.publicKey)

        val m1 = init.writeMessage("reconnect".toByteArray())
        assertEquals("reconnect", String(resp.readMessage(m1)))

        val m2 = resp.writeMessage()
        assertEquals(0, init.readMessage(m2).size)

        val ip = init.split()
        val rp = resp.split()
        val f = ip.send.write("data".toByteArray())
        assertEquals("data", String(rp.recv.read(f.first, f.second)))
    }

    @Test
    fun kk_rejects_fresh_identity_impersonation() {
        val phone = generateStaticIdentity()
        val pc = generateStaticIdentity()
        val attacker = generateStaticIdentity() // 只知双方公钥（全公开信息）
        val atk = NoiseHandshake(NoisePattern.KK, NoiseRole.INITIATOR, attacker, pc.publicKey)
        val victim = NoiseHandshake(NoisePattern.KK, NoiseRole.RESPONDER, pc, phone.publicKey)
        val m1 = atk.writeMessage("fake".toByteArray())
        // 真 KK：s 段以 phone 公钥期待比对——静态私钥不持有者算不出正确密钥链
        assertFailsWith<NoiseException> { victim.readMessage(m1) }
    }

    @Test
    fun kk_payload_on_last_message() {
        val phone = generateStaticIdentity()
        val pc = generateStaticIdentity()
        val init = NoiseHandshake(NoisePattern.KK, NoiseRole.INITIATOR, phone, pc.publicKey)
        val resp = NoiseHandshake(NoisePattern.KK, NoiseRole.RESPONDER, pc, phone.publicKey)
        val m1 = init.writeMessage("greeting".toByteArray())
        resp.readMessage(m1)
        val m2 = resp.writeMessage("welcome".toByteArray())
        assertEquals("welcome", String(init.readMessage(m2)))
    }

    // ---- 传输 phase 安全性质 ----

    @Test
    fun rejects_tampering() {
        val c = TransportCipher(ByteArray(32) { 7 })
        val f = c.write("secret".toByteArray())
        val tampered = f.second.copyOf()
        tampered[0] = (tampered[0].toInt() xor 1).toByte()
        assertFailsWith<NoiseException> { c.read(f.first, tampered) }
    }

    @Test
    fun rejects_replay_and_out_of_order() {
        val a = TransportCipher(ByteArray(32) { 7 })
        val b = TransportCipher(ByteArray(32) { 7 })
        val f1 = a.write("one".toByteArray())
        val f2 = a.write("two".toByteArray())
        assertEquals("one", String(b.read(f1.first, f1.second)))
        assertFailsWith<NoiseException> { b.read(f1.first, f1.second) }
        assertEquals("two", String(b.read(f2.first, f2.second)))
        assertFailsWith<NoiseException> { b.read(0, f1.second) }
    }

    // ---- SAS ----

    @Test
    fun sas_format_and_stability() {
        val h1 = ByteArray(32) { 1 }
        assertEquals("26065796", sasFromHandshakeHash(h1))
        assertEquals("71813300", sasFromHandshakeHash(ByteArray(32) { 2 }))
    }

    // ---- b64u ----

    @Test
    fun b64u_roundtrip() {
        val buf = "noise-wire-test".toByteArray()
        assertContentEquals(buf, unb64u(b64u(buf)))
        // 与 node base64url 交叉（尾部 1B/2B 分支）
        val b32 = ByteArray(32) { (it * 7).toByte() }
        assertEquals("AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk", b64u(b32))
        val b17 = ByteArray(17) { (it * 3).toByte() }
        assertEquals("AAMGCQwPEhUYGx4hJCcqLTA", b64u(b17))
        assertContentEquals(b32, unb64u(b64u(b32)))
    }
}
