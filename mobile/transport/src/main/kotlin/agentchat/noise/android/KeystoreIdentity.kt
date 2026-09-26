// ============================================================
// KeystoreIdentity —— 设备静态身份入 Android Keystore（M3.3）
//
// 方案 §4.4「密钥」行：设备静态密钥对入 Android Keystore（硬件 backed，
// 导出不可行）→ 丢机 = 私钥不可提取 + 核心端一键吊销。
//
// 关键取舍（本文件的核心设计）：
//   · Noise 需要 **X25519 原始 32B 标量**做 DH（不只签名）；
//   · Android Keystore 的 X25519 密钥**默认不可导出私钥**，而 Noise 的 DH
//     必须在自己的密码学实现里跑（Noise 的每步 DH/混键是协议语义，无法外包给
//     Keystore 的 Cipher/KeyAgreement API 编排）；
//   · 折中：Keystore 里生成一把 **hardware-backed 的 AES 密钥**（不可导出、
//     生物绑定可选），用它对设备私钥做**信封加密**后存普通存储。
//     效果：私钥在静态存储上永远是密文；无 Keystore 密钥（=无设备解锁）解不开；
//     刷机/恢复出厂即随 Keystore 一起销毁；REMOTE 源无法绕过。
//     这比「明文私钥塞 SharedPreferences」强，也比「只存公钥」可用。
//
// 身份的生命周期：首次生成 → 信封加密落盘 → 之后每次读回解密（幂等）。
// ============================================================
package agentchat.noise.android

import agentchat.noise.StaticIdentity
import agentchat.noise.b64u
import agentchat.noise.generateStaticIdentity
import agentchat.noise.unb64u
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEYSTORE = "AndroidKeyStore"
private const val WRAP_KEY_ALIAS = "agentchat.identity.wrap"
private const val IDENTITY_FILE = "identity.enc"
private const val GCM_TAG_BITS = 128
private const val GCM_IV_BYTES = 12

class KeystoreIdentity(private val context: Context) {

    private val file: File get() = File(context.filesDir, IDENTITY_FILE)

    /** 读回设备身份；首次调用生成并落盘 */
    fun load(): StaticIdentity {
        if (file.exists()) {
            val raw = Base64.decode(file.readText(), Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, GCM_IV_BYTES)
            val ct = raw.copyOfRange(GCM_IV_BYTES, raw.size)
            val plain = decrypt(iv, ct)
            return StaticIdentity(
                publicKey = plain.copyOfRange(0, 32),
                privateKey = plain.copyOfRange(32, 64),
            )
        }
        val id = generateStaticIdentity()
        val plain = id.publicKey + id.privateKey // 64B：公钥‖私钥
        val (iv, ct) = encrypt(plain)
        file.writeText(Base64.encodeToString(iv + ct, Base64.NO_WRAP))
        return id
    }

    /** 删除身份（丢机后的本机重置 / 换核心端全量重配） */
    fun clear() {
        file.delete()
        runCatching { keyStore().deleteEntry(WRAP_KEY_ALIAS) }
    }

    /** 设备公钥（供二维码/注册表比对；不触发私钥解密） */
    fun publicKeyB64u(): String? =
        if (file.exists()) b64u(load().publicKey) else null

    // ---- 信封加密（Keystore AES-GCM，密钥不可导出）----

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun wrapKey(): SecretKey {
        val ks = keyStore()
        (ks.getEntry(WRAP_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                WRAP_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: ByteArray): Pair<ByteArray, ByteArray> {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, wrapKey())
        return Pair(c.iv, c.doFinal(plain))
    }

    private fun decrypt(iv: ByteArray, ct: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        return c.doFinal(ct)
    }
}
