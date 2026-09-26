// ============================================================
// PairingStore —— Android 侧配对/连接状态（SharedPreferences 持久化）
//
// 存的是**非机密**信息：核心端公钥、最后 relay 地址、配对标记、设备名。
// 设备私钥走 KeystoreIdentity（信封加密），两者分工明确。
//
// 为什么核心端公钥可以明文存：它是**公开**值（二维码上就有），改它只会让
// 握手对端校验失败（rx 校验 + KK 隐含认证），不构成降级攻击面。
// ============================================================
package agentchat.noise.android

import android.content.Context

class PairingStore(context: Context) {
    private val prefs = context.getSharedPreferences("agentchat.remote", Context.MODE_PRIVATE)

    var corePubkey: String?
        get() = prefs.getString("corePubkey", null)
        set(v) { prefs.edit().putString("corePubkey", v).apply() }

    var relayUrl: String?
        get() = prefs.getString("relayUrl", null)
        set(v) { prefs.edit().putString("relayUrl", v).apply() }

    var deviceName: String
        get() = prefs.getString("deviceName", null) ?: android.os.Build.MODEL
        set(v) { prefs.edit().putString("deviceName", v).apply() }

    /**
     * 本机在核心端的设备 id（dev-<rand>，配对确认时核心端下发）。
     * KK 重连房间号派生的必需输入——手机无从自算，故必须持久化。
     */
    var deviceId: String?
        get() = prefs.getString("deviceId", null)
        set(v) { prefs.edit().putString("deviceId", v).apply() }

    /** 核心端授予的权限档 */
    var scopes: List<String>
        get() = prefs.getStringSet("scopes", emptySet())?.toList() ?: emptyList()
        set(v) { prefs.edit().putStringSet("scopes", v.toSet()).apply() }

    /**
     * 生物锁开关（默认开启 = 方案 A；用户可关闭 = 方案 B，自担丢机风险）。
     * 存 SharedPreferences 而非 Keystore：它是偏好不是机密，且用户要能自由切换。
     * 关闭时仅记日志（UI 侧展示确认弹窗，见 MainActivity 设置区）。
     */
    var biometricLockEnabled: Boolean
        get() = prefs.getBoolean("biometricLockEnabled", true)
        set(v) { prefs.edit().putBoolean("biometricLockEnabled", v).apply() }

    /** 配对完成标记（有核心端公钥即已配对） */
    val paired: Boolean get() = !corePubkey.isNullOrEmpty()

    /** 落 deviceId 与权限档（配对确认时） */
    fun saveDevice(deviceId: String, scopes: List<String>) {
        prefs.edit().putString("deviceId", deviceId).putStringSet("scopes", scopes.toSet()).apply()
    }

    fun savePairing(corePubkey: String, relayUrl: String) {
        prefs.edit().putString("corePubkey", corePubkey).putString("relayUrl", relayUrl).apply()
    }

    fun clearPairing() {
        prefs.edit().remove("corePubkey").remove("relayUrl").remove("deviceId").remove("scopes").apply()
    }
}
