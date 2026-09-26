// ============================================================
// VersionCheck —— 版本清单拉取与更新判定（M3.5）
//
// 方案 §4.6「版本清单与信任锚分离」：客户端**从可信来源取清单**（git raw HTTPS），
// 安装包从下载面取（快），落地前用清单里的 sha256 校验——MITM 换掉下载面的字节
// 也过不了校验。故本类的职责分两块：
//   · 纯函数（可 JVM 单测）：解析清单、挑出可用更新、校验字节 sha256；
//   · I/O（OkHttp fetch）：把清单取回来。
//
// 设计纪律：清单是**外部输入**——缺字段/坏条目的条目跳过而非整体失败；
// 拉取失败一律抛错交调用方决定提示策略（更新检查绝不该阻断启动）。
// ============================================================
package agentchat.noise

import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** 版本清单条目（方案 §4.6：platform / version / url / sha256 / size；versionCode 供 Android 比对） */
data class VersionInfo(
    val platform: String,
    val version: String,
    /** 单调递增的整数版本（Android 用；versionName 字符串比较不可靠） */
    val versionCode: Long,
    val url: String,
    val sha256: String,
    val size: Long,
)

/**
 * 解析版本清单。
 *
 * 坏条目跳过而非整体失败——清单是外部输入，一条脏数据不该让更新检查全瘫。
 * 返回顺序保持清单原序。
 */
fun parseVersionManifest(json: String): List<VersionInfo> {
    val arr = runCatching { Gson().fromJson(json, com.google.gson.JsonArray::class.java) }.getOrNull()
        ?: return emptyList()
    val out = ArrayList<VersionInfo>(arr.size())
    for (el in arr) {
        val o = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
        val platform = o.str("platform") ?: continue
        val version = o.str("version") ?: continue
        val url = o.str("url") ?: continue
        val sha256 = o.str("sha256") ?: continue
        val versionCode = o.get("versionCode")?.takeIf { it.isJsonPrimitive }?.asLong
            ?: deriveVersionCode(version)
        val size = o.get("size")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L
        out.add(VersionInfo(platform, version, versionCode, url, sha256, size))
    }
    return out
}

/** 缺 versionCode 时由 version 派生（与 download-manifest.mjs 同算法：各段 ×1000 累加） */
fun deriveVersionCode(version: String): Long =
    version.split('.').fold(0L) { acc, p -> acc * 1000 + (p.toLongOrNull() ?: 0L) }

/**
 * 挑出可用更新：同平台中 versionCode 最高、且严格大于当前者；无则 null。
 *
 * 「严格大于」而非「不等于」——回滚场景（清单里只有更旧的版本）不该被提示为更新。
 */
fun pickUpdate(currentVersionCode: Long, entries: List<VersionInfo>, platform: String = "android"): VersionInfo? =
    entries.filter { it.platform == platform && it.versionCode > currentVersionCode }
        .maxByOrNull { it.versionCode }

/**
 * 字节 sha256 校验（下载后、安装前）。
 *
 * 方案 §4.6 的核心信任动作：HTTP 无证书完整性，靠这一步把「下载面的字节」
 * 与「可信来源的哈希」绑起来。
 */
fun verifySha256(bytes: ByteArray, expectedHex: String): Boolean {
    val d = MessageDigest.getInstance("SHA-256").digest(bytes)
    val hex = d.joinToString("") { "%02x".format(it) }
    return hex.equals(expectedHex, ignoreCase = true)
}

private fun JsonObject.str(key: String): String? =
    get(key)?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotEmpty() }

/** 版本清单的 I/O 面（拉取 + 判定；UI 只消费结果） */
class VersionChecker(
    private val manifestUrl: String,
    private val client: OkHttpClient = defaultClient(),
) {
    /** 拉取清单（非 2xx / 网络失败 / 空地址一律抛错——由调用方决定降级） */
    fun fetch(): List<VersionInfo> {
        if (manifestUrl.isBlank()) throw IllegalStateException("未配置版本清单地址")
        val req = Request.Builder().url(manifestUrl).get().build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("清单拉取失败: HTTP " + resp.code)
            val body = resp.body?.string() ?: throw IllegalStateException("清单响应为空")
            return parseVersionManifest(body)
        }
    }

    /** 拉取并判定（无更新返回 null） */
    fun checkUpdate(currentVersionCode: Long, platform: String = "android"): VersionInfo? =
        pickUpdate(currentVersionCode, fetch(), platform)

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}

