// ============================================================
// ac-noise-transport —— Noise 协议 Kotlin 实现（XK / KK + AEAD 帧）
//
// src/ac-noise-core/src/index.ts 的逐函数移植（M3.1）。实现纪律：
//   · 严格照 Noise spec rev34 消息模式表实现，不发明自有步骤；
//   · DH 输出全零（低阶点）→ 立即终止（spec §7.1）；
//   · x25519 / ChaCha20-Poly1305 / SHA-256 / HKDF 全部走 JDK 原语。
//
// 模式表（与 TS 蓝本一致——本仓精简 KK：无 s/ss token，双向身份靠
// 预置公钥 + es/ee 派生密钥隐式认证；roomId 前缀 p/r 区分配对/重连）：
//   XK: [e] [e,ee,s,es] [s,se]
//   KK: [e,es] [e,ee]
// ============================================================
package agentchat.noise

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

private const val HASH_LEN = 32
private const val TAG_LEN = 16
private const val NONCE_LEN = 12
private const val DH_LEN = 32

private const val PROTOCOL_XK = "Noise_XK_25519_ChaChaPoly_SHA256"
private const val PROTOCOL_KK = "Noise_KK_25519_ChaChaPoly_SHA256"

/** RFC 7748 X25519 PKCS8/X509 DER 头（32B raw 密钥的固定包装） */
private val X25519_PKCS8_PREFIX = hex("302e020100300506032b656e04220420")
private val X25519_X509_PREFIX = hex("302a300506032b656e032100")

/** 本实现全部异常类型（wire 上区分截断/篡改/低阶点/状态误用） */
class NoiseException(message: String) : Exception(message)

// ---- 基础工具 ----

internal fun concat(parts: List<ByteArray>): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) { System.arraycopy(p, 0, out, off, p.size); off += p.size }
    return out
}

internal fun sha256(vararg parts: ByteArray): ByteArray {
    val md = MessageDigest.getInstance("SHA-256")
    for (p in parts) md.update(p)
    return md.digest()
}

/** HKDF(salt=ck, ikm, info=empty, 2×32B) —— spec §4.3（JDK 无 hkdf，手写 extract+expand） */
internal fun hkdf2(ck: ByteArray, ikm: ByteArray): Pair<ByteArray, ByteArray> {
    val prk = hmacSha256(ck, ikm)
    val t1 = hmacSha256(prk, byteArrayOf(1))
    val t2 = hmacSha256(prk, t1 + byteArrayOf(2))
    return Pair(t1, t2)
}

internal fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = javax.crypto.Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

/** AEAD nonce：4 零字节 + n 小端 64-bit（spec §12.3 ChaChaPoly） */
internal fun nonceOf(n: Long): ByteArray {
    val nonce = ByteArray(NONCE_LEN)
    for (i in 0 until 8) nonce[4 + i] = (n ushr (8 * i)).toByte()
    return nonce
}

/** ChaCha20-Poly1305 AEAD（tag 后置 16B）——RFC 8439 §2.8 */
internal fun aeadEncrypt(k: ByteArray, n: Long, ad: ByteArray, plaintext: ByteArray): ByteArray {
    val c = Cipher.getInstance("ChaCha20-Poly1305")
    c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(k, "ChaCha20"), IvParameterSpec(nonceOf(n)))
    c.updateAAD(ad)
    return c.doFinal(plaintext) // JCE 输出 = ct || tag
}

internal fun aeadDecrypt(k: ByteArray, n: Long, ad: ByteArray, ciphertext: ByteArray): ByteArray {
    if (ciphertext.size < TAG_LEN) throw NoiseException("noise: ciphertext too short")
    val c = Cipher.getInstance("ChaCha20-Poly1305")
    c.init(Cipher.DECRYPT_MODE, SecretKeySpec(k, "ChaCha20"), IvParameterSpec(nonceOf(n)))
    c.updateAAD(ad)
    return try {
        c.doFinal(ciphertext)
    } catch (e: AEADBadTagException) {
        throw NoiseException("noise: AEAD authentication failed")
    }
}

// ---- x25519 ----

/** RFC 7748 §6.1 使用前 clamp（幂等——已 clamp 的值不变） */
internal fun clampScalar(priv: ByteArray): ByteArray {
    val b = priv.copyOf()
    b[0] = (b[0].toInt() and 0xf8).toByte()
    b[31] = (b[31].toInt() and 0x7f).toByte()
    b[31] = (b[31].toInt() or 0x40).toByte()
    return b
}

/** RFC 7748 §6.1 basepoint（u = 9，其余 31 字节零） */
private val X25519_BASEPOINT = ByteArray(DH_LEN).also { it[0] = 9 }

/**
 * 平台 X25519 能力探测（结果缓存一次）。
 *
 * 为什么要探测：JDK 与 Android（Conscrypt）的算法名注册集不同——
 *   · JDK 17：KeyPairGenerator("X25519") 可用；
 *   · Android API 28–32：**没有** X25519/XDH 的 KeyPairGenerator
 *     （实测 NoSuchAlgorithmException: X25519 KeyPairGenerator not available），
 *     但 KeyFactory/KeyAgreement("X25519") 自 API 28 起可用；
 *   · Android 13+：KeyPairGenerator 可用（名字视实现，故两个都试）。
 *
 * 探测失败不抛错——留给调用方走 basepoint 路径。
 */
internal object X25519Platform {
    private fun firstWorking(get: (String) -> Any): String? =
        X25519_ALGORITHM_NAMES.firstOrNull { alg -> runCatching { get(alg) }.isSuccess }

    val keyPairAlgorithm: String? by lazy { firstWorking { java.security.KeyPairGenerator.getInstance(it) } }
    val keyFactoryAlgorithm: String? by lazy { firstWorking { java.security.KeyFactory.getInstance(it) } }
    val keyAgreementAlgorithm: String? by lazy { firstWorking { javax.crypto.KeyAgreement.getInstance(it) } }
}

/**
 * 生成 X25519 静态身份密钥对（首次运行一次；亦作握手临时密钥生成器）。
 *
 * 两条路径等价产出（测试用 RFC 7748 向量锚定公钥派生正确性）：
 *   1. 平台有 KeyPairGenerator → 直接生成；
 *   2. 没有（真机 Android API ≤ 32 全系缺席）→ 随机私钥 + basepoint DH 求公钥
 *      （pub = X25519(priv, 9)），dh() 内部落 X25519Pure 纯实现，不自写未验证密码学。
 */
fun generateStaticIdentity(random: SecureRandom = SecureRandom()): StaticIdentity {
    val alg = X25519Platform.keyPairAlgorithm
    if (alg != null) {
        val viaKpg = runCatching {
            val kg = java.security.KeyPairGenerator.getInstance(alg)
            // NamedParameterSpec 的规范化名（部分实现只认 "X25519"，不认别名）
            kg.initialize(java.security.spec.NamedParameterSpec("X25519"), random)
            val kp = kg.generateKeyPair()
            val pubEnc = kp.public.encoded // X509 DER：头 12B + 32B
            val privEnc = kp.private.encoded // PKCS8 DER：头 16B + 32B
            StaticIdentity(
                pubEnc.copyOfRange(pubEnc.size - DH_LEN, pubEnc.size),
                privEnc.copyOfRange(privEnc.size - DH_LEN, privEnc.size), // JCE 生成已 clamp
            )
        }.getOrNull()
        if (viaKpg != null) return viaKpg
    }
    val priv = clampScalar(ByteArray(DH_LEN).also(random::nextBytes))
    return StaticIdentity(dh(priv, X25519_BASEPOINT), priv)
}

/**
 * DH(priv, pub) —— RFC 7748；全零输出（低阶点）抛错（spec §7.1）。
 *
 * 两条等价路径：平台 JCA（API 33+ Conscrypt / JDK——硬件加速）优先；
 * 探测不到（真机 Android API ≤ 32 实况：三算法名全无，BC 裁剪版亦无 XDH）
 * 落 X25519Pure 纯实现（M3 真机验证 §1.3 闪退修复）。向量测试锚定两路径一致。
 */
fun dh(priv: ByteArray, pub: ByteArray): ByteArray {
    val out = X25519Platform.keyAgreementAlgorithm?.let { kaAlg ->
        runCatching {
            val kfAlg = X25519Platform.keyFactoryAlgorithm ?: throw NoiseException("noise: 平台 KeyFactory 缺席")
            val kf = KeyFactory.getInstance(kfAlg)
            val agreement = javax.crypto.KeyAgreement.getInstance(kaAlg)
            agreement.init(kf.generatePrivate(PKCS8EncodedKeySpec(X25519_PKCS8_PREFIX + clampScalar(priv))))
            agreement.doPhase(kf.generatePublic(X509EncodedKeySpec(X25519_X509_PREFIX + pub)), true)
            agreement.generateSecret()
        }.getOrNull()
    } ?: x25519ScalarMult(priv, pub)
    if (out.size == DH_LEN && out.all { it == 0.toByte() }) {
        throw NoiseException("noise: DH all-zero output (low-order point)")
    }
    return out
}

// ---- Wire 序列化 ----

private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** 二进制 → base64url（无 padding）——与 TS b64u 一致 */
fun b64u(bytes: ByteArray): String {
    val sb = StringBuilder(bytes.size * 4 / 3 + 4)
    var i = 0
    while (i + 3 <= bytes.size) {
        val v = ((bytes[i].toInt() and 0xff) shl 16) or ((bytes[i + 1].toInt() and 0xff) shl 8) or (bytes[i + 2].toInt() and 0xff)
        sb.append(B64URL[(v ushr 18) and 63])
        sb.append(B64URL[(v ushr 12) and 63])
        sb.append(B64URL[(v ushr 6) and 63])
        sb.append(B64URL[v and 63])
        i += 3
    }
    val rem = bytes.size - i
    if (rem == 1) {
        val v = (bytes[i].toInt() and 0xff) shl 16
        sb.append(B64URL[(v ushr 18) and 63])
        sb.append(B64URL[(v ushr 12) and 63])
    } else if (rem == 2) {
        val v = ((bytes[i].toInt() and 0xff) shl 10) or ((bytes[i + 1].toInt() and 0xff) shl 2)
        sb.append(B64URL[(v ushr 12) and 63])
        sb.append(B64URL[(v ushr 6) and 63])
        sb.append(B64URL[v and 63])
    }
    return sb.toString()
}

/** base64url → 二进制（无 padding；宽容输入，与 node 行为一致） */
fun unb64u(s: String): ByteArray {
    val rev = IntArray(128) { -1 }
    for ((idx, c) in B64URL.withIndex()) rev[c.code] = idx
    val out = ArrayList<Byte>(s.length)
    var acc = 0
    var bits = 0
    for (c in s) {
        if (c.code >= 128) throw NoiseException("noise: bad base64url char")
        val v = rev[c.code]
        if (v < 0) throw NoiseException("noise: bad base64url char")
        acc = (acc shl 6) or v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.add(((acc ushr bits) and 0xff).toByte())
        }
    }
    return out.toByteArray()
}

internal fun hex(s: String): ByteArray =
    ByteArray(s.length / 2) { i -> ((Character.digit(s[2 * i], 16) shl 4) or Character.digit(s[2 * i + 1], 16)).toByte() }

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

// ---- CipherState（spec §5.1）----

/** 握手期与传输期共用的一方向密码状态（k 空时恒等透传） */
class CipherState {
    internal var k: ByteArray? = null
        private set
    private var nonce: Long = 0

    internal fun initializeKey(key: ByteArray) {
        this.k = key
        this.nonce = 0
    }

    internal fun hasKey(): Boolean = k != null

    internal fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
        val key = k ?: return plaintext.copyOf()
        if (nonce > MAX_NONCE) throw NoiseException("noise: nonce exhausted")
        return aeadEncrypt(key, nonce++, ad, plaintext)
    }

    internal fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        val key = k ?: return ciphertext.copyOf()
        if (nonce > MAX_NONCE) throw NoiseException("noise: nonce exhausted")
        return aeadDecrypt(key, nonce++, ad, ciphertext)
    }
}

// ---- SymmetricState（spec §5.2）----

internal class SymmetricState(protocolName: String) {
    private var h: ByteArray
    private var ck: ByteArray
    internal val cipher = CipherState()

    init {
        val name = protocolName.toByteArray(Charsets.UTF_8)
        h = if (name.size <= HASH_LEN) name + ByteArray(HASH_LEN - name.size) else sha256(name)
        ck = h.copyOf()
    }

    internal fun mixHash(data: ByteArray) {
        h = sha256(h, data)
    }

    internal fun mixKey(ikm: ByteArray) {
        val (newCk, temp) = hkdf2(ck, ikm)
        ck = newCk
        cipher.initializeKey(temp)
    }

    internal fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val ct = cipher.encryptWithAd(h, plaintext)
        mixHash(ct)
        return ct
    }

    internal fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val pt = cipher.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return pt
    }

    internal val handshakeHash: ByteArray get() = h.copyOf()

    /** Split()（spec §4.2）：ikm = HASH_LEN 零字节，输出两把传输密钥 */
    internal fun split(): Pair<ByteArray, ByteArray> = hkdf2(ck, ByteArray(HASH_LEN))
}

// ---- 消息模式（spec §7 子集；与 TS 蓝本一致）----

internal enum class Token { E, S, EE, ES, SE }

internal val PATTERN_XK: List<List<Token>> = listOf(
    listOf(Token.E),
    listOf(Token.E, Token.EE, Token.S, Token.ES),
    listOf(Token.S, Token.SE),
)
internal val PATTERN_KK: List<List<Token>> = listOf(
    listOf(Token.E, Token.ES),
    listOf(Token.E, Token.EE),
)

/** 静态身份（X25519） */
class StaticIdentity(val publicKey: ByteArray, val privateKey: ByteArray)

/** 传输 phase 密码对（send/recv 已按角色定向）+ 握手哈希（SAS 派生） */
class TransportPair(
    val send: TransportCipher,
    val recv: TransportCipher,
    val handshakeHash: ByteArray,
)

/**
 * Noise 握手状态机（XK/KK，单一类覆盖两角色）。手机端恒为 initiator：
 *   XK（配对）  writeMessage(空) → readMessage → remoteStaticMatches(二维码 pk)
 *               → writeMessage(设备信息 JSON) → split
 *   KK（重连）  writeMessage() → readMessage() → split
 */
class NoiseHandshake(
    pattern: NoisePattern,
    role: NoiseRole,
    identity: StaticIdentity,
    remoteStaticPub: ByteArray? = null,
) {
    private val ss = SymmetricState(if (pattern == NoisePattern.XK) PROTOCOL_XK else PROTOCOL_KK)
    private val patterns = if (pattern == NoisePattern.XK) PATTERN_XK else PATTERN_KK
    private val myStatic = identity
    private val remoteStaticKnown = remoteStaticPub
    private var e: StaticIdentity? = null
    private var re: ByteArray? = null
    private var rsSeen: ByteArray? = null
    private var step = 0
    private val role: NoiseRole = role

    val complete: Boolean get() = step >= patterns.size
    val handshakeHash: ByteArray get() = ss.handshakeHash

    /** 读到的对端静态公钥（XK 在处理完第 2 条消息后非空；KK 无 s token 恒 null） */
    val remoteStatic: ByteArray? get() = rsSeen

    /** 对端静态公钥是否与已知值一致（XK 发起方校验二维码 pk） */
    fun remoteStaticMatches(expected: ByteArray): Boolean = rsSeen?.contentEquals(expected) ?: false

    /** 写下一条握手消息（token 段 + 加密载荷；载荷可为空） */
    fun writeMessage(payload: ByteArray = ByteArray(0)): ByteArray {
        if (complete) throw NoiseException("noise: handshake already complete")
        val tokens = patterns[step]
        if (step % 2 != (if (role == NoiseRole.INITIATOR) 0 else 1)) {
            throw NoiseException("noise: not our turn to write")
        }
        val parts = ArrayList<ByteArray>()
        for (token in tokens) {
            when (token) {
                Token.E -> {
                    e = generateStaticIdentity()
                    parts.add(e!!.publicKey)
                    ss.mixHash(e!!.publicKey)
                }
                Token.S -> parts.add(ss.encryptAndHash(myStatic.publicKey))
                Token.EE -> ss.mixKey(dh(requireLocalEphemeral(), requireRemoteEphemeral()))
                Token.ES -> if (role == NoiseRole.INITIATOR) {
                    ss.mixKey(dh(requireLocalEphemeral(), requireKnownRemoteStatic()))
                } else {
                    ss.mixKey(dh(requireLocalStaticPriv(), requireRemoteEphemeral()))
                }
                Token.SE -> if (role == NoiseRole.INITIATOR) {
                    ss.mixKey(dh(requireLocalStaticPriv(), requireRemoteEphemeral()))
                } else {
                    ss.mixKey(dh(requireLocalEphemeral(), requireSeenRemoteStatic()))
                }
            }
        }
        parts.add(ss.encryptAndHash(payload))
        step += 1
        return concat(parts)
    }

    /** 读对端握手消息（返回载荷明文；格式错/解密失败抛错） */
    fun readMessage(message: ByteArray): ByteArray {
        if (complete) throw NoiseException("noise: handshake already complete")
        val tokens = patterns[step]
        if (step % 2 != (if (role == NoiseRole.INITIATOR) 1 else 0)) {
            throw NoiseException("noise: not our turn to read")
        }
        var off = 0
        for (token in tokens) {
            when (token) {
                Token.E -> {
                    if (message.size - off < DH_LEN) throw NoiseException("noise: truncated e")
                    re = message.copyOfRange(off, off + DH_LEN)
                    off += DH_LEN
                    ss.mixHash(re!!)
                }
                Token.S -> {
                    val sLen = if (ss.cipher.hasKey()) DH_LEN + TAG_LEN else DH_LEN
                    if (message.size - off < sLen) throw NoiseException("noise: truncated s")
                    rsSeen = ss.decryptAndHash(message.copyOfRange(off, off + sLen))
                    off += sLen
                }
                Token.EE -> ss.mixKey(dh(requireLocalEphemeral(), requireRemoteEphemeral()))
                Token.ES -> if (role == NoiseRole.INITIATOR) {
                    ss.mixKey(dh(requireLocalEphemeral(), requireKnownRemoteStatic()))
                } else {
                    ss.mixKey(dh(requireLocalStaticPriv(), requireRemoteEphemeral()))
                }
                Token.SE -> if (role == NoiseRole.INITIATOR) {
                    ss.mixKey(dh(requireLocalStaticPriv(), requireRemoteEphemeral()))
                } else {
                    ss.mixKey(dh(requireLocalEphemeral(), requireSeenRemoteStatic()))
                }
            }
        }
        val payload = ss.decryptAndHash(message.copyOfRange(off, message.size))
        step += 1
        return payload
    }

    /** Split()：传输密钥对（initiator 发 k1 收 k2；responder 反之——spec §5.2） */
    fun split(): TransportPair {
        if (!complete) throw NoiseException("noise: handshake not complete")
        val (k1, k2) = ss.split()
        val send = TransportCipher(if (role == NoiseRole.INITIATOR) k1 else k2)
        val recv = TransportCipher(if (role == NoiseRole.INITIATOR) k2 else k1)
        return TransportPair(send, recv, handshakeHash)
    }

    private fun requireLocalEphemeral(): ByteArray = e!!.privateKey
    private fun requireLocalStaticPriv(): ByteArray = myStatic.privateKey
    private fun requireRemoteEphemeral(): ByteArray = re!!
    private fun requireKnownRemoteStatic(): ByteArray = remoteStaticKnown
        ?: throw NoiseException("noise: internal: known remote static required")
    private fun requireSeenRemoteStatic(): ByteArray = rsSeen
        ?: throw NoiseException("noise: internal: seen remote static required")
}

enum class NoisePattern { XK, KK }
enum class NoiseRole { INITIATOR, RESPONDER }

/** 传输 phase 单调计数上限 */
const val MAX_NONCE: Long = Long.MAX_VALUE

/**
 * 传输 phase 帧密码。wire 帧 = { n, ct }：n = 发送方单调计数；解密侧强制 n 严格递增
 * （重放/乱序拒绝——本产品无并发帧，严格递增即充分）。
 */
class TransportCipher(val key: ByteArray) {
    private var nonce: Long = 0
    private var lastRecv = -1L

    /** 加密一帧 → Pair(n, ct) */
    fun write(payload: ByteArray): Pair<Long, ByteArray> {
        if (nonce > MAX_NONCE) throw NoiseException("noise: nonce exhausted")
        val n = nonce++
        return Pair(n, aeadEncrypt(key, n, ByteArray(0), payload))
    }

    /** 解密一帧（重放/乱序拒绝） */
    fun read(n: Long, ct: ByteArray): ByteArray {
        if (n <= lastRecv) throw NoiseException("noise: replay/out-of-order frame")
        val pt = aeadDecrypt(key, n, ByteArray(0), ct)
        lastRecv = n
        return pt
    }
}

/**
 * SAS 短认证串（上游方案 §4.2 第 5 步）：SHA256(handshake_hash) 前 4 字节
 * → 8 位数字，两端各自显示人工比对。
 */
fun sasFromHandshakeHash(handshakeHash: ByteArray): String {
    val d = sha256(handshakeHash)
    val v = ((d[0].toLong() and 0xff) shl 24) or
        ((d[1].toLong() and 0xff) shl 16) or
        ((d[2].toLong() and 0xff) shl 8) or
        (d[3].toLong() and 0xff)
    return (v % 100_000_000L).toString().padStart(8, '0')
}
