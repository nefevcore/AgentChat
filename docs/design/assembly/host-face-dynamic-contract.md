# 宿主能力面真动态契约（host-face-dynamic-contract）

> 性质：域深设计——host-face 宿主契约从写死清单换为注册面聚合的终态规格（cr-1121）。
> 状态：现行 · cr-1121 2026-11-16（承接 cr-886 懒装配 → cr-1114 承诺面/工具源统一）
> 读者：为宿主新增远程工具/远程段的行作者；排查壳侧 timer/update_agent_profile 可见性问题的人。

## 一、设计目标

cr-886 的 host-face 契约是**写死清单**：tools/sections 常量住
`ac-host-face-core/promise.ts`（cr-1114 下沉产物），宿主执行面写死在
`ac-host-face/src/tools.ts`——新增一个宿主远程工具要同时改 core 常量 + 宿主行
两处，第三方宿主行无入口。真动态化的不变量：

**宿主契约 = 装配期注册面的实时聚合**——任何宿主行向 `hostFaceRegistry` 自报
（tools/sections/executor），discover 即聚合返回；摘行 = 该面从契约消失。

## 二、终态规格

| 件 | 归属 | 内容 |
|---|---|---|
| 协议词汇 | `ac-host-face-core/src/contract.ts` | 契约形状 + `HostToolExecutor` + 段 `promise` 标记（零常量、零 cordis） |
| 注册面 | `ac-host-face` `HostFaceRegistry`（服务键 `hostFaceRegistry`） | `contribute(caller, key, {tools, sections, executor})`——注册即归属（cleanup 挂 caller fiber effect，行卸载自动回收 + 契约收敛 + invalidate 广播）；撞名 fail-loud |
| ipc 端点 | `ac-host-face` | discover = 现算聚合契约并落契约缓存；execute = 按 tool 名路由贡献行 executor；facts 恒宿主全集 `['singles','group']` |
| 契约缓存 | `<dataRoot>/meta/host-face-contract.json` | 宿主单写（discover 处理器 + sync）、壳只读——**壳侧 boot 静态面数据源**；写失败不阻断 discover（缓存缺席 = 壳盲窗，prepare 缝对账收敛） |
| 内置贡献行 | `ac-host-face` timer-face / profile-face | timer 工具 + GUIDELINES_TIMER 段（promise）/ update_agent_profile；executor 内宿主闸（timers 软取 / admin 复查） |
| 壳侧行 | `ac-host-face-client` | boot 静态面 = 读契约缓存（全量 tools + promise 段）；prepare 缝对账语义与 cr-1114 相同（diff → 重建 → `tools/source-changed`） |

## 三、段词汇：promise 标记

`HostFaceSectionSpec.promise: true` = 恒真静态文本段——可安全进壳 boot 静态面。
非 promise 段（可能与壳内本地段撞名的补位段，如 TERMINOLOGY）仅经 discover 活拉——
boot 占位会饿死本地 owner 的 fail-loud 注册（cr-1114 实测事故语义保持）。

## 四、与代码的映射点

- 注册面 API：`packages/ac-host-face/src/index.ts` `HostFaceRegistry.contribute`
- 内置贡献行：`packages/ac-host-face/src/{timer-face,profile-face}.ts`（新宿主远程能力的样板）
- 契约缓存读写：`contractCachePath` / `readContractCache`（`ac-host-face` 写侧 / `ac-host-face-client` 读侧）
- 行集：`apps/catalog/profile/host.yml` host-face + timer-face + profile-face（ac-base-version 4）

## 五、语义变更记录（相对 cr-886/cr-1114）

| 项 | 旧 | 新 |
|---|---|---|
| 契约内容源 | core 静态常量（宿主行回引） | 注册面聚合（always-live 现算） |
| 壳 boot 静态面 | core 常量直取（零 I/O） | 宿主写契约缓存（首 boot 后零盲窗；从未起宿主的冷数据根如实盲窗） |
| timers 条目变更 | `currentHostFace().invalidate()` 广播 | 退役——契约恒基线（工具 schema 不随条目变），壳侧 list 恒读现值 |
| TERMINOLOGY / GUIDELINES_COLLAB | 宿主契约补位段（discover 提供） | 退役——collab 语义段归壳内 ac-collab-tools 本地 owner，宿主不再兜底供给 |
| execute 路由 | tools.ts if-chain 写死 | 贡献行 executor 按名路由（宿主闸随贡献行） |

> 缓存寄居 meta/（第二层）——可重建派生物，已在 data-root-layers.md meta 表登记。
