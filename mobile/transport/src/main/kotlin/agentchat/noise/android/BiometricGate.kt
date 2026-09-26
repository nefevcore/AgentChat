// ============================================================
// BiometricGate —— 生物识别解锁门（M3.4「锁」行）
//
// 方案 §4.4「锁」行原文两条：**生物识别解锁才连 relay**；切后台即断开。
// 后者已在 MainActivity.onStop 落地；本类实现前者。
//
// 设计要点：
//   · **能力探测 + 降级**：设备无生物识别硬件、或用户未录入时，不静默放行——
//     而是明确记日志并放行（否则设备彻底不可用）。降级原因进日志，便于审计。
//   · **不缓存解锁态**：每次进前台重锁（onStop 已断链，回前台自然要重新解锁）。
//   · 认证成功才回调 onUnlocked——调用方在那里起链路（顺序即语义：没解锁就没链路）。
// ============================================================
package agentchat.noise.android

import android.content.Context
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

private const val TAG = "AgentChatBio"

object BiometricGate {

    /** 设备生物识别能力（决定走真门还是降级） */
    enum class Capability {
        /** 有可用生物识别（硬件 + 已录入） */
        AVAILABLE,
        /** 有硬件但用户未录入 */
        NOT_ENROLLED,
        /** 无硬件 / 被设备策略禁用 */
        UNAVAILABLE,
    }

    fun capability(context: Context): Capability {
        val mgr = BiometricManager.from(context)
        // BIOMETRIC_WEAK 起步：本门是「丢机缓解纵深」，不是密钥保护（密钥在 Keystore）
        return when (mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Capability.AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> Capability.NOT_ENROLLED
            else -> Capability.UNAVAILABLE
        }
    }

    /**
     * 请求解锁。
     *
     * 可用 → 弹系统生物识别面板，成功回调 onUnlocked，取消/失败回调 onDenied。
     * 不可用 → **降级放行**并记日志（原因可见，便于审计与排查）。
     */
    /**
     * 请求解锁。
     *
     * 开关关闭（方案 B，用户显式选择）→ 直接放行并记日志（审计可见）。
     * 可用 → 弹系统生物识别面板，成功回调 onUnlocked，取消/失败回调 onDenied。
     * 不可用 → **降级放行**并记日志（原因可见，便于审计与排查）。
     */
    fun request(
        activity: FragmentActivity,
        title: String,
        onUnlocked: () -> Unit,
        onDenied: (String) -> Unit,
        enabled: Boolean = true,
    ) {
        if (!enabled) {
            Log.w(TAG, "生物锁已由用户关闭——直接放行（用户自担丢机风险）")
            onUnlocked()
            return
        }
        when (capability(activity)) {
            Capability.NOT_ENROLLED -> {
                Log.w(TAG, "设备未录入生物识别——降级放行（建议在系统设置中录入以获得丢机保护）")
                onUnlocked()
            }
            Capability.UNAVAILABLE -> {
                Log.w(TAG, "设备无可用生物识别——降级放行")
                onUnlocked()
            }
            Capability.AVAILABLE -> {
                val executor = ContextCompat.getMainExecutor(activity)
                val prompt = BiometricPrompt(
                    activity,
                    executor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            Log.i(TAG, "解锁成功")
                            onUnlocked()
                        }

                        override fun onAuthenticationError(code: Int, msg: CharSequence) {
                            Log.w(TAG, "解锁失败/取消: " + code + " " + msg)
                            onDenied(msg.toString())
                        }

                        override fun onAuthenticationFailed() {
                            // 单次指纹不匹配：系统面板仍在，等用户重试——不当作终止
                            Log.w(TAG, "一次认证未通过（可重试）")
                        }
                    },
                )
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle("解锁后才连接你的电脑")
                    .setNegativeButtonText("取消")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                    .build()
                prompt.authenticate(info)
            }
        }
    }
}

