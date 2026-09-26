# M3.4 实施实况：宿主 HTTP 面通用代理 + 断线自动重连

> 上游：remote-link-remaining-plan.md §二 M3.4。本文记录**通用 HTTP 代理**（替 M3.2/M3.3
> 的逐端点 bridge）、退避重连循环，以及本轮 6 处真机缺陷——M3.5 开工前必读。

## 1. 核心决策：为什么不逐端点 bridge

M3.2 补了 `/api/ui/boot-graph`，M3.3 发现 `/api/ui/extensions`、`/api/workspace/*`、
`/api/workspaces` 也缺——**同一模式连续两次**。webui 的 HTTP 依赖是开放集合，
逐端点追是必输的。故改为**通用转发**：任意 `/api/*` 原样投到核心端自身 web-server。

```
WebView ──HTTP──▷ 回环桥 ──rpc: http/read|http/write──▷ relay ──▷ 核心端
                                                                      │
                                        核心端 fetch 自己的 127.0.0.1:<自身端口>
                                                                      │
            响应（状态码/Content-Type/字节）◁──────────────────────────┘
```

**为什么是「向自己发一次回环 HTTP」而非直接调路由处理器**：
`RouteCall` 需要真实的 Node `IncomingMessage`/`ServerResponse`，伪造它们比一次回环请求
更重且更易与真实行为分叉；回环请求复用**完全同一条**代码路径（路由匹配、body 解析、
二进制直出、错误码），远程与本地行为不可能走散。

## 2. 安全（远程可控输入的三道闸）

| 闸 | 内容 |
|---|---|
| 路径前缀 | 只放行 `/api/`——webui 的动态面在此，静态资源由壳自带 |
| 目标主机 | 由**核心端自己**决定（127.0.0.1 + 自身监听口），远程无法指定目标——**结构性排除 SSRF** |
| 形态校验 | 路径含 `://`、反斜杠一律拒绝（防拼接逃逸）；方法白名单外拒绝 |

**权限分档**：GET → `http/read`（read 档）；其余 → `http/write`（**files 档，须显式开启**）。
读权限不该能写——这是 scopes 闸门的直接复用，不是新机制。

**体积闸**：请求体/响应体 > 6MB 一律 413 并说明（relay 单帧 8MB + base64 膨胀 4/3 +
JSON 包装的余量）。大文件分片是已知后续项。

## 3. 离线恢复（M3.4 第二项）

- **配对完成后接管 onClose**：配对房随任一方离线销毁，此前 onClose 只打日志——
  配对完成后的断线就**永久掉线**了（静默）。
- **退避重连循环**：1s 起、上限 60s、±20% 抖动（与核心端 `scheduleReconnect` 同参数）；
  幂等防重入；`manualStop` 置位后退出（切后台/ dispose 语义）。
- **一次失败不停在 ERROR**：手机切回前台、核心端刚开机、relay 抖动都要求自动恢复——
  这是「断线语义」的产品要求（真相源在核心端，离线期间消息入账，重连补齐）。

## 4. 真机验收（Android 14 / API 34 模拟器）

| 项 | 证据 |
|---|---|
| **HTTP 面补齐** | 桥日志：`/api/ui/boot-graph`、`/api/ui/extensions`、`/api/workspaces`、`/api/agents/user/avatar` **全部 ← 200** |
| `not bridged` 消失 | 该错误此前（M3.3）必现，现**零出现** |
| 应用完整装配 | 463 条真实会话、往返 1118ms、`loading(false) hasMore=true` |
| 构建可辨识 | `AgentChatMobile build 1790343170636`（真实时间戳） |

## 5. 本轮真机缺陷（6 处，全部修复）

### 5.1 base64 vs base64url —— 代理全线失败（最隐蔽）

- **现象**：`/api/*` 全部空体 500；桥日志 `代理 ← 200` 后紧跟 `bad base64url char`。
- **根因**：核心端用 Node 的 `toString('base64')` 输出，而协议侧（Kotlin `unb64u`）
  只认 **base64url** 字符集——`+`/`/`/`=` 被拒。
- **修法**：全部改 `base64url` + 补回归断言（断言编码结果不含 `[+/=]`，用必然产生
  `+/` 的字节序列 `FB FF BF FE FD` 锚定）。

### 5.2 AGP 8 默认不生成 BuildConfig —— 构建失败

- **现象**：clean 构建报 `Unresolved reference: BuildConfig`。
- **根因**：AGP 8 起 `buildConfig` 特性默认关闭；且 `BuildConfig` 在 `com.agentchat.mobile`
  包下，跨包使用需**显式 import**。
- **修法**：`buildFeatures { buildConfig = true }` + `import com.agentchat.mobile.BuildConfig`。
- **更大价值**：它让「设备上跑的到底是哪次构建」可被一眼确认——直击 §5.3 的坑。

### 5.3 增量构建+安装的三个叠加陷阱（消耗排障时间最多）

三个坑叠在一起，症状都是「改了代码但真机行为不变」：

1. **Gradle 对外部 sourceSets 的增量编译不可靠**——`mobile/transport` 经
   `sourceSets.main.java.srcDirs` 引入，改动它时 `assembleDebug` 可能不重编，
   而 BUILD 仍显示 SUCCESSFUL。**必须 clean**。
2. **`adb install` / `pm install -r` 在 Windows+模拟器下静默不替换**——报 Success，
   设备 APK 与本地**大小相同但 md5 不同**，dex 里还是旧符号（M3.3 已记一次，本轮
   复现两次）。**必须 uninstall → push → `pm install`（不带 -r）**。
3. **校验必须查 dex 内容而非只看安装成功**——「md5 一致」只证明 APK 文件对，
   不证明 dex 里有你要的符号；本轮先用字节比对才定位到第 1 条的编译问题。

> 已固化为 `.dsh/tmp/m34-oneshot.ps1`（clean 构建 → 严格安装 → md5 校验 → 全链路驱动）。

### 5.4 Ktor 未捕获异常是「空体 500」

- **现象**：`/api/*` 返回 500 但 body 为空、无日志（SLF4J 被 `slf4j-nop` 静音）。
- **修法**：`proxyApiSafely()` 包装所有 `/api/*` 入口，异常转成带原因的 JSON +
  `println`（`android.util.Log` 在共享模块不可用——JVM 轨排除了 android 子包）。
- **教训**：空体错误在现场等于零信息，任何入口都该有异常出口。

### 5.5 深链 URI 的 `&` 被 shell 截断

- **现象**：应用报 `IllegalArgumentException: 二维码缺 relay`。
- **根因**：`adb shell am start -d <uri>` 未加引号时，URI 里的 `&` 被 shell 当命令分隔符，
  URL 被截成 `agentchat://pair?v=1`。
- **修法**：整条 shell 命令作为**单一参数**、URI 用单引号包裹。

### 5.6 `reconnect()` 的未用参数

顺带清理：`devicePubkeyB64u` 参数无用途（房间派生已在调用方完成）——删除。

## 6. 验证命令

```
# 核心端单测（17 例：10 转发 + 6 服务 + 1 base64url 回归）
npx vitest run src/ac-remote-link

# 桥单测（含多段路径 /api/ui/boot-graph、/api/workspace/tree/a/b 的路由匹配）
cd mobile/transport && ../../mobile/.dsh-gradle/gradle-8.14/bin/gradle.bat test

# 真机一键（clean → 严格安装 → 校验 → 全链路）
pwsh -File .dsh/tmp/m34-oneshot.ps1
```

## 7. 事件下行接线（M3.4 补齐）

**发现的缺口**：broadcastEvent 在生产代码里**零调用方**（只有测试调用）——即
「PC 到手机流式」这条验收项从未真正接线。M1 时预留了入口与白名单，但没人订阅。

**修法**（照 ws-bridge 同款姿势）：

    // index.ts 的 apply 里，白名单是单一事实源
    for (const event of REMOTE_DOWNLINK_EVENTS) {
      ctx.on(event, (...args) => remote().broadcastEvent(event, args));
    }

- 白名单从模块私有常量改为**导出**（service.ts 的 REMOTE_DOWNLINK_EVENTS）——
  订阅侧与闸门侧读同一份，两处各写一份必然走散；
- 载荷统一 { args }（与前端帧同构，桥与 WebView 都不必理解各事件签名）；
- 单个连接失败不影响其余（断链设备不至于拖垮整条下行）。

**验证**：单测 3 例——白名单内单播且载荷形状正确、白名单外不发、单连接失败不影响
其余；另有 1 例直接 `apply` 后 `emit` 验证订阅接线本身。

**真机端到端的限制（诚实记录）**：`conversation/deliver` 在 loopback 测试数据根下
失败于 `Cannot read properties of undefined (reading usage)`——**该数据根没有配置
LLM 凭据**，任何需要真实模型调用的验收项（含「发消息看流式」）都无法在本机闭环。
接线正确性由上述单测锚定；真机流式需在配好 provider 的核心端上复验。

### 7.1 顺带补齐：remote/* 事件 ws-bridge 转发（P1 尾巴 §1.2）

设备页此前每 2s 轮询 remote/devices；现已桥接四条事件
（device-paired / revoked / online / offline）供前端 onEvent 驱动刷新。

## 8. 待办（后续）

- M3.5：APK 自托管分发（下载面 + manifest + 版本检查）。
- 生物识别解锁才连 relay（方案「锁」行；当前仅实现「切后台即断」）。
- 桥的大载荷分片（6MB 圆整只是缓解）。
- 事件下行流式（`remote/*` 事件经 ws-bridge 转发——P1 尾巴遗留项）。
