// ============================================================
// M3.5 版本检查测试：清单解析（坏条目容错）/ 更新判定（严格大于）
// / sha256 校验 / versionCode 派生——纯函数，真机无关。
// ============================================================
package agentchat.noise

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val MANIFEST = """
[
  { "platform": "android", "version": "1.0.0", "versionCode": 1,
    "url": "https://dl.example.com/android/a-1.0.0.apk",
    "sha256": "aa11", "size": 100 },
  { "platform": "android", "version": "1.0.2", "versionCode": 1002,
    "url": "https://dl.example.com/android/a-1.0.2.apk",
    "sha256": "bb22", "size": 200 },
  { "platform": "win", "version": "0.9.0", "versionCode": 900,
    "url": "https://dl.example.com/win/s.exe", "sha256": "cc33", "size": 300 },
  { "platform": "android" },
  { "platform": "android", "version": "1.0.1", "versionCode": 1001,
    "url": "https://dl.example.com/android/a-1.0.1.apk", "sha256": "dd44", "size": 150 }
]
"""

class VersionCheckTest {

    @Test
    fun parse_skipsBadEntriesAndKeepsOrder() {
        val list = parseVersionManifest(MANIFEST)
        // 4 条有效（缺 url/sha256 的那条被跳过）
        assertEquals(4, list.size)
        assertEquals("1.0.0", list[0].version)
        assertEquals("1002", list[1].versionCode.toString())
        assertEquals("win", list[2].platform)
        assertEquals("1.0.1", list[3].version)
    }

    @Test
    fun parse_toleratesGarbage() {
        assertEquals(0, parseVersionManifest("not json").size)
        assertEquals(0, parseVersionManifest("{}").size)
        assertEquals(0, parseVersionManifest("[]").size)
        assertEquals(0, parseVersionManifest("").size)
    }

    @Test
    fun pick_updateIsHighestGreaterThanCurrent() {
        val list = parseVersionManifest(MANIFEST)
        // 当前 1001 → 最高且更大的是 1002
        assertEquals("1.0.2", pickUpdate(1001, list)?.version)
        // 当前 1002（已最新）→ 无更新
        assertNull(pickUpdate(1002, list))
    }

    @Test
    fun pick_neverSuggestsDowngrade() {
        val list = parseVersionManifest(MANIFEST)
        // 当前 9999（比清单里全高）→ 无更新（回滚不该被提示为更新）
        assertNull(pickUpdate(9999, list))
        // 当前 0 → 1002
        assertEquals("1.0.2", pickUpdate(0, list)?.version)
    }

    @Test
    fun pick_filtersByPlatform() {
        val list = parseVersionManifest(MANIFEST)
        // win 平台只有 900，当前 1 → 提示 0.9.0；当前 900 → 无
        assertEquals("0.9.0", pickUpdate(1, list, platform = "win")?.version)
        assertNull(pickUpdate(900, list, platform = "win"))
    }

    @Test
    fun versionCodeDerivation() {
        // 每段 ×1000 累乘（语义 = 把版本号按 3 位一组读：1.0.0 → 001|000|000）
        // 与 download-manifest.mjs 的 reduce 同算法——两边必须一致，否则
        // 「清单里的 versionCode」与「客户端派生的」对不上，更新判定就失灵。
        assertEquals(1000000L, deriveVersionCode("1.0.0"))
        assertEquals(1000002L, deriveVersionCode("1.0.2"))
        assertEquals(1000000000L, deriveVersionCode("1.0.0.0"))
        // 非数字段按 0 计（不抛错——清单是外部输入）
        assertEquals(0L, deriveVersionCode("bad"))
        assertEquals(1L, deriveVersionCode("1"))
        // 缺 versionCode 的条目走派生
        val list = parseVersionManifest("[{\"platform\":\"android\",\"version\":\"2.0.0\",\"url\":\"u\",\"sha256\":\"s\"}]")
        assertEquals(2000000L, list[0].versionCode)
    }

    @Test
    fun sha256Verification() {
        val bytes = "agentchat".toByteArray()
        // 锚定值：node 的 crypto.createHash('sha256').update('agentchat')
        // （与 download-manifest.mjs 同一算法——跨语言一致性靠真值钉住）
        val expected = "882408ee85dd7192492979c09515d2bd74535645550bd15efb06fc4c6f078754"
        assertTrue(verifySha256(bytes, expected))
        // 大小写不敏感（清单可能由不同工具链生成）
        assertTrue(verifySha256(bytes, expected.uppercase()))
        assertFalse(verifySha256(bytes, "deadbeef"))
        assertFalse(verifySha256(bytes, ""))
        assertFalse(verifySha256("别的字节".toByteArray(), expected))
    }
}
