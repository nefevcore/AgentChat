// ============================================================
// X25519Probe —— 平台 X25519 能力诊断（M3.3 真机排障沉淀）
//
// 起因：Android 上 generateStaticIdentity 崩 NoSuchAlgorithmException。
// jvmToolchain 编译期一切正常、JVM 单测全绿——但 Android 的 JCA 算法名
// 注册集与桌面 JDK 不同，"能不能用" 只能实测。本类把探测结果一次性打全，
// 免得每换一台设备/一个 API 级别就重新猜。
//
// 实测结论（Android 14 / API 34 模拟器）：
//   KeyFactory(X25519) = NO     KeyFactory(XDH) = OK
//   KeyAgreement(X25519) = NO   KeyAgreement(XDH) = OK
//   KeyPairGenerator(X25519) = NO   KeyPairGenerator(XDH) = OK
// 即 Android 用规范名 **XDH**（X25519 是它的曲线参数），桌面 JDK 反过来。
// 修法不是特判平台，而是**多名字探测**——两个平台都走同一条代码路径。
//
// 跑法（真机/模拟器，APK 已装）：
//   adb shell "CLASSPATH=$(pm path <pkg> 去掉 package:) app_process /system/bin \
//     agentchat.noise.X25519ProbeKt"
// 或看 App 崩溃日志里的同名输出（Probe 也被 dh() 的失败信息引用）。
// ============================================================
package agentchat.noise

import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Security
import javax.crypto.KeyAgreement

/**
 * 候选算法名：X25519 在不同实现下注册名不同。
 *
 * 为什么是这三个：JCA 规范名是 "X25519"→"XDH"→（旧实现）"X25519DH"。
 * 刻意**不含 "EC"**——EC 在 Android/JDK 上都存在，拿它当后备会探测出假阳性，
 * 而真正的 X25519 DER 解析随后才失败（把「平台不支持」误报成「支持」）。
 */
val X25519_ALGORITHM_NAMES: List<String> = listOf("X25519", "XDH", "X25519DH")

/** 一次性探测：返回人类可读的多行报告（不含敏感信息） */
fun probeX25519Support(): String {
    val sb = StringBuilder("X25519 平台能力探测：\n")
    for (name in X25519_ALGORITHM_NAMES) {
        sb.append("  KeyFactory(").append(name).append(") = ")
        sb.append(runCatching { KeyFactory.getInstance(name); "OK" }.getOrElse { "NO" }).append("\n")
        sb.append("  KeyAgreement(").append(name).append(") = ")
        sb.append(runCatching { KeyAgreement.getInstance(name); "OK" }.getOrElse { "NO" }).append("\n")
        sb.append("  KeyPairGenerator(").append(name).append(") = ")
        sb.append(runCatching { KeyPairGenerator.getInstance(name); "OK" }.getOrElse { "NO" }).append("\n")
    }
    sb.append("  可用 provider：")
    sb.append(Security.getProviders().joinToString(", ") { it.name })
    return sb.toString()
}

fun main() {
    println(probeX25519Support())
}
