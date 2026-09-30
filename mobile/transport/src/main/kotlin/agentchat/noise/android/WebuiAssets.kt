// ============================================================
// WebuiAssets —— 把 APK 内置的 webui dist 释放到文件系统（M3.3）
//
// 为什么需要：回环桥（Ktor）的静态面从**文件系统目录**读资源，而 APK 里
// 的 webui 资源在 assets/public（zip 内，无路径）。故首次运行释放一次。
//
// 幂等策略：以 assets 内的一个版本标记（webui-version.txt，构建时写入）
// 与已释放目录比对，一致即跳过——避免每次启动重复解压 274 个文件。
// ============================================================
package agentchat.noise.android

import android.content.Context
import java.io.File

object WebuiAssets {
    private const val ASSET_ROOT = "public"
    private const val STAMP = ".extracted-version"

    /** 确保 webui 已释放；返回目录（供桥作 staticDir） */
    fun ensure(context: Context): File {
        val dest = File(context.filesDir, "webui")
        val stampFile = File(dest, STAMP)
        // 版本标记在 assets/public/ 下（cr-43 ⑫：原读 assets 根永远 null →
        // 幂等失效每次全量重释放 274 文件 + stamp 恒 unknown，真机实锤）
        val version = readAssetText(context, "$ASSET_ROOT/webui-version.txt")
        if (stampFile.exists() && version != null && stampFile.readText() == version) {
            return dest
        }
        dest.deleteRecursively()
        dest.mkdirs()
        copyAssetDir(context, ASSET_ROOT, dest)
        stampFile.writeText(version ?: "unknown")
        return dest
    }

    private fun copyAssetDir(context: Context, assetPath: String, dest: File) {
        val list = context.assets.list(assetPath) ?: return
        if (list.isEmpty()) {
            // 叶子：是文件
            dest.parentFile?.mkdirs()
            context.assets.open(assetPath).use { input ->
                dest.outputStream().use { input.copyTo(it) }
            }
            return
        }
        dest.mkdirs()
        for (child in list) {
            copyAssetDir(context, "$assetPath/$child", File(dest, child))
        }
    }

    private fun readAssetText(context: Context, path: String): String? =
        runCatching { context.assets.open(path).bufferedReader().readText().trim() }.getOrNull()
}
