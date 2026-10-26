# M3.5 实施实况：APK 自托管分发 + 版本更新提醒

> 上游：remote-link-remaining-plan.md §二 M3.5「APK 自托管分发（下载面 + manifest +
> App 内版本检查）」，验收「下载面装 APK；版本更新提醒走通」。**M3 阶段收口。**

## 1. 落点

| 文件 | 职责 |
|---|---|
| scripts/download-manifest.mjs | 版本清单生成与校验（add / check）——服务器数据源与 git 信任锚同一份 |
| scripts/download-gate.mjs | 下载面：公开静态 + 全局配额门（持久化计数）+ X-Accel-Redirect 模式 |
| scripts/m35-download-verify.mjs | 端到端验证（18 项：sha256 逐字节 / 配额 / 穿越 / 方法闸） |
| mobile/transport/.../VersionCheck.kt | 客户端：清单解析 / 更新判定 / sha256 校验（纯函数可 JVM 测） |
| mobile/transport/.../tests/VersionCheckTest.kt | 7 例：坏条目容错 / 严格大于 / 平台过滤 / 派生 / 校验 |
| mobile/app/android/.../MainActivity.kt | 更新检查 + 顶部提示条（任何启动形态都检查） |

## 2. 关键设计（照方案 §4.6）

### 2.1 版本清单与信任锚分离

manifest.json = 条目数组（platform / version / versionCode / url / sha256 / size），
**同一份文件进两处**：服务器 /downloads/manifest.json（数据源）+ git 仓库（信任锚）。
HTTP 无证书完整性，故**git 存哈希、服务器存字节**：客户端从可信来源取清单、从下载面
取字节，落地前用清单 sha256 校验——MITM 换掉下载面的字节也过不了校验，故公网 IP
免备案 HTTP 分发即可成立。（App 侧 UPDATE_MANIFEST_URL 因此**不必**与下载面同源。）

### 2.2 全局配额门（流量费硬顶）

- Nginx 做不了跨重启的全局计数 → Node download-gate 计数并**持久化磁盘**
  （count-<YYYYMM>.json，按月分片自动归零，无需定时任务）；
- **只计安装包**（apk/exe/dmg/zip/appimage/msi）——主页/manifest 是浏览行为不计；
- --behind-nginx 模式回 X-Accel-Redirect，由 Nginx 直接发字节，**大文件不过 Node 手**
  （90MB 包不占进程内存/CPU）；本地验证用直接发字节模式；
- GET /api/quota 供主页展示剩余次数；
- 方案的成本数学：200 次 × ~18MB ≈ 3.6GB/月——配额门本身就是出流量费的硬顶。

### 2.3 versionCode 单一派生规则

版本号「每段 ×1000 累乘」（1.0.0 → 1000000）——download-manifest.mjs 与 Kotlin
deriveVersionCode **同算法**。两端不一致会让「清单里的 code」与「客户端派生的」对不上，
更新判定直接失灵，故用跨语言真值测试钉住（sha256 同理，用 node 算出的锚定值）。

## 3. 验收结果

| 验收点 | 证据 |
|---|---|
| **下载面装 APK** | 经下载面取回 APK：HTTP 200、application/vnd.android.package-archive、字节数 18932145 与清单一致、**sha256 校验通过** |
| **版本更新提醒走通** | 日志「本地 versionCode=1000000 (1.0.0) … 结论=有新版本 1.0.2 (code 1000002)」；界面出现「有新版本 1.0.2 · 点击下载」 |
| 配额门 | 安装包计入（已用 1/200）、manifest/主页不计——脚本 18 项断言全过 |

## 4. 本轮缺陷（4 处）

### 4.1 下载面静态根与 URL 路径差一层 → 清单 404

原用 --root .../downloads，而清单 URL 是 /downloads/manifest.json → 实际查找
downloads/downloads/manifest.json。**修法**：静态根取 www 根（与方案 §4.6 的服务器
布局一致），下载面路径 /downloads/<platform>/<file> 自然对齐。

### 4.2 App 侧静默吞错（违反项目纪律）

runCatching 后 getOrNull 把失败与「已是最新」混为一谈——而真实原因可能是清单地址错/
明文被拦/网络不通，**排查方向完全不同**。**修法**：显式捕获并分类打日志
（检查失败（原因） / 有新版本 / 已是最新），失败可见。

### 4.3 gate 的 404 无日志

静默 404 让「客户端为什么拿不到清单」变成瞎猜（4.1 的现象正是靠补日志才定位）。
**修法**：404 也打一行。

### 4.4 测试里 as never 造成 emit 重载失配

ctx.emit(event as never, ...) 会把实参推断成 never 元组，tsc 报 No overload matches。
**修法**：转成 (...a: unknown[]) => void 的函数类型再调——表达的是「只关心有没有转发，
载荷形状无所谓」，比逐个 as never 更贴语义。

### 4.5 管道会掩盖 Gradle 退出码（工程教训）

gradlew ... | Select-String BUILD 时 PowerShell 报的是 **Select-String 的退出码**，
构建失败被当成成功——本轮因此误判一轮（设备装的还是旧 APK）。**纪律**：构建要
重定向到日志后用 $LASTEXITCODE 判定，再单独检索日志。

## 5. 验证命令

    # 下载面端到端（18 项）
    node scripts/m35-download-verify.mjs

    # 清单生成与校验
    node scripts/download-manifest.mjs add <apk> --platform android --version 1.0.2 --base-url <url>
    node scripts/download-manifest.mjs check <apk> --manifest <manifest.json>

    # 下载面（本地）
    node scripts/download-gate.mjs --root <www> --port 18080 --quota 200 --state <dir>

    # 客户端单测
    cd mobile/transport 且 gradle.bat test

## 6. 部署面（生产：方案 §4.6 四件套剩两件）

本仓交付的是 **Node 那两件**（配额门 + 清单工具链）。另两件属服务器/云侧，未在本仓实现：

1. **同 IP 限流**（Nginx）：limit_req（1r/m + burst 3，只对安装包扩展名）+ limit_conn
   单 IP 2 + limit_rate ~2MB/s；
2. **账单告警**（云监控）：月流量阈值 ~20GB——配额门之上的第二道网。

另需：下载面与 relay **双面分离**（下载面 80/443 公开可扫，relay 面 8443 默认拒绝扫描），
以及 CI 分发链（desktop.yml 改 --publish never + rsync 上传 + 跑本仓的 manifest 脚本）。

## 7. M3 收口：遗留项（不阻塞阶段验收）

- **生物识别解锁才连 relay**（方案「锁」行）——当前实现了「切后台即断」，解锁门未做。
- **桥的大载荷分片**（6MB/8MB 单帧上限只是缓解）。
- M4 可选：多设备并发验证、按设备审计日志、登录提醒、30 天未活跃提醒。
