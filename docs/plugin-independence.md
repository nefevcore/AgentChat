# AgentChat 插件独立性分析报告

> 版本：v0.6.x（2026-08-19） · 范围：composition.base.yml + composition.web-app.yml 全部 51 个组合行
> + 动态插件（PluginHost/market） · 方法：静态扫描 `inject` / `super(ctx, '…')` / `ctx.get` / 包值导入，
> 结合 cordis fiber 语义（vendor/cordis/src/reflect.ts、fiber.ts）逐行核实
> 目标口径：**卸载一个插件后，其他插件的运行不受影响**（进程不崩、无级联卸载、无运行期死引用）

---

## TL;DR

| 分级 | 数量 | 占比 | 说明 |
|------|------|------|------|
| **A 级：已完全独立** | **33 / 51** | **65%** | 卸载零级联，可放心摘行 |
| B 级：平台承重行 | 12 / 51 | 24% | 卸载 = 平台功能塌陷，属设计使然（tools/hooks/llm/bootstrap…） |
| **C 级：可解放行** | **6 / 51** | **12%** | 当前卸载会级联，但改造成本低，可升入 A 级 |

完成 §6 的 P0+P1 改造后，**A 级可达 ~40/51（78%+）**，承重行只剩真正的平台核心。
主要拦路虎不是显式 `inject`，而是三处**账实不符**：server-l4 的 inject 清单比实际代码硬、
boot-finalize 的"全都要"接线、`PluginServices` 侧信道写后不清（卸载残留死引用）。

---

## 1. 卸载语义与分析口径

本系统"插件"有三个卸载层级，影响面不同：

| 层级 | 操作 | 影响机制 |
|------|------|----------|
| **行级**（组合行） | 补丁层按 id `disable`/删行 | cordis fiber 语义：`inject` 缺失 → 依赖方 **PENDING（进程不崩）**；运行期服务消失 → 依赖方 fiber **级联卸载**，服务恢复后自动重载（`reflect.ts` provide disposer → `notify()` → `fiber._setEpoch(INACTIVE)` → `_unload()`）。diagnostics 行 5s 后告警装配缺口（`plugin-diagnostics.ts` REQUIRED_SERVICES） |
| **包级**（删目录） | 删除 `src/*/*` 包 | 所有**值导入**该包的代码编译/加载失败（见 §5；类型边 `import type` 不阻断运行） |
| **动态插件** | `PluginHost.unload()` | owner 回收已完备：tools/hooks 注册撤销 + UI 扩展卸载 + fiber dispose（`host.ts` `cleanupOwner`/`disposeRecord`）——**动态插件的独立性机制是三者中最好的** |

本报告以**行级**为主线（这是"卸载插件"的日常语义），包级耦合单独在 §5 讨论。

---

## 2. 服务依赖矩阵（提供 ← 注入）

横读：卸载左侧服务提供行，右列全部停。

| 服务 | 提供行 | 注入方（= 卸载级联面） |
|------|--------|------------------------|
| `tools` | tools | **15**：fs-tools、fs-search、str-replace-editor、shell、web、dev、dev-admin、session-tools、restart、interaction、math、agent-tools、timer-tools、subagent-tools、boot-core |
| `hooks` | hooks | **15**：agent-prompt/persona/datetime/skill/session/memory/mcp、security（8 行）+ agent-tools、timer-tools、restart、subagent-tools（4 行）+ archive、server-l4、boot-core |
| `bootstrap` | boot-core（另提供 `agents`） | **6**：workspace-init、archive、timer-service、subagent-service、server-l4、boot-finalize |
| `http` | http-host | **5**：market-http、http-routes、plugins-http、webui、server-l4 |
| `llm` | llm | 4：llm-deepseek、llm-glm、llm-openai、boot-core |
| `agentLoop` | agent-loop | 2：subagent-service、boot-core |
| `jobs` | jobs | 3：shell-tools、subagent-service、boot-core |
| `l4` | server-l4（另提供 4 个门面） | 2：boot-finalize、http-routes |
| `workspace` | workspace-init | 2：server-l4、boot-finalize（**均为排序型依赖**，见 §4.4） |
| `archive` | archive | 3：timer-service、server-l4、boot-finalize |
| `timerManager` | timer-service | 2：server-l4、boot-finalize（+ timer-tools 软读 `services.timer`） |
| `subagent` | subagent-service | 2：server-l4、boot-finalize（+ subagent-tools 软读 `services.subAgent`） |
| `durableInteraction` | durable-interaction | 1：server-l4 |
| `agentPresets` | agent-presets | 1：server-l4 |
| `pluginManager` | boot-finalize | 1：plugins-http |
| `webServerHost` | boot-finalize | 1：webui |
| `market` | market | 1：market-http（成对行） |
| `pluginHost` | plugin-host | market 桥行（但 boot-core 兜底 `getOrCreatePluginHost`，见 §4.5） |
| `timer`（vendor）、`hmr`、`logger` | 框架行 | hmr 注入 timer；hmr/logger 无硬依赖方（消费方全部 `ctx.get` 软读） |

逆向上看：**每个"叶子行"（工具/钩子/适配器/HTTP 表面行）没有任何人依赖它** —— 这就是 65% 独立率的来源。

---

## 3. 独立性分级清单

### A 级：完全独立（33 行）—— 卸载零级联 ✅

| 组 | 行 |
|----|----|
| 工具行（注入 tools[+jobs/hooks]，无人依赖） | fs-tools、fs-search-tools、str-replace-editor-tools、shell-tools、web-tools、dev-tools、dev-admin-tools、session-tools、restart、interaction、math-tools、agent-tools、timer-tools、subagent-tools |
| 钩子行（注入 hooks，无人依赖） | agent-prompt、agent-persona、agent-datetime、agent-skill、agent-session、agent-memory、agent-mcp、security |
| LLM 适配器行（注入 llm） | llm-deepseek、llm-glm、llm-openai（行级独立；包级互相耦合见 §5） |
| HTTP 表面行 | market-http、http-routes、plugins-http、webui（摘行仅摘对应 `/api/*` 或表面） |
| 零依赖行 | diagnostics、hello、hmr（消费方全部软读降级）、logger（框架配置行） |

注：卸载 A 级行当然会**功能性**退化（少一组工具/钩子/路由），但没有任何**其他插件**停止运行——符合目标口径。

### B 级：平台承重行（12 行）—— 卸载 = 平级塌陷，设计使然 ⚠️

`tools`、`hooks`、`llm`、`agent-loop`、`jobs`、`http-host`、`boot-core`(bootstrap)、`server-l4`(l4)、
`plugin-host`、`market`（与 market-http 成对）、`timer`(vendor，fiber 定时器)、`boot-finalize`*。

\* boot-finalize 特殊：它自己是接线行，卸载它只级联 plugins-http + webui（2 行）——但它**阻碍 6 个服务行独立**（见 C 级与 §4.2），故归入改造对象。

这些行是"平台"而非"插件"：没有 `tools` 就没有工具体系，没有 `bootstrap` 就没有应用。
它们的不可卸载是**合理**的，不应为独立而独立。

### C 级：可解放行（6 行）—— 当前卸载有级联，但可低成本升 A 🎯

| 行 | 当前级联面 | 解放路径 | 成本 |
|----|-----------|----------|------|
| `agent-presets` | server-l4 | server-l4 运行期 `ctx.get('agentPresets')`，空则回退内置空预设 | 低 |
| `durable-interaction` | server-l4 | server-l4 降级内存后端（包本身默认即 memory，服务内已有降级日志先例） | 低-中 |
| `timer-service` | server-l4、boot-finalize | 两处 inject 瘦身（运行期代码**已是** `?.manager` 可选访问）+ boot-finalize reloadAll 加守卫 | 低 |
| `subagent-service` | server-l4、boot-finalize | 同上 + 补 dispose 清理 | 低 |
| `archive` | timer-service、server-l4、boot-finalize | timer-service 去 `inject: archive`（archiveAll 回调已 `?? {length:0}` 兜底）+ 另两处守卫 | 低-中 |
| `workspace-init` | server-l4、boot-finalize | 两处 inject 的 `workspace` 均为**排序型**（§4.4），去硬依赖后靠 diagnostics 兜底告警 | 低 |

---

## 4. 隐藏耦合点（行级独立的暗礁）

### 4.1 `PluginServices` 侧信道：写入后不清理 → 卸载残留死引用

三个服务行把管理器写进 boot 契约的共享对象，但 **dispose 时不清槽位**：

- `subagent/service-plugin.ts:32` `core.services.subAgent = manager` —— **完全无 disposer**（行尾没有 return 清理函数）
- `timer/service-plugin.ts:51` `core.services.timer = manager` —— return `manager.dispose()` 但**不清槽位**
- `archive/plugin.ts:76-84` 写入 `archiveSession`/`idleReset` —— return `archiveService.dispose()` 但**不清槽位**

后果：运行期卸载服务行后，工具行读到的 `services.timer` / `services.subAgent` 仍是 truthy 死引用
（timer/subagent/interaction 工具的空态检查 `if (!timer)` 挡不住已 dispose 的实例），
下一次工具调用打到已停摆的管理器上，产生难以诊断的运行期错误——这正是"卸载影响其他插件"的隐蔽形态。

**修法**：三个服务行的返回 disposer 统一补 `core.services.xxx = undefined`；
`subagent-service` 补完整 disposer（`manager.stopAll?.()` + 清槽位）。

### 4.2 server-l4：inject 清单与运行时代码"账实不符"（最大单点）

`service-plugin.ts:50` 硬声明 9 个 inject，但 `apply` 体内对
`timerManager`/`subagent`/`archive`（L127-129）全部 `?.manager` 可选访问、
`agentPresets` 也只在物化预设时使用。**代码事实上已按可选写，声明却把它们变成硬依赖** ——
导致卸载 agent-presets / durable-interaction / timer-service / subagent-service / archive 中任意一行，
整个 L4（= WebUI 后端）连带 boot-finalize、http-routes、plugins-http、webui 全部下线。

**修法**：inject 收敛为真正必需的 `['bootstrap', 'http', 'hooks', 'durableInteraction']`
（durableInteraction 若按 C 级路径降级则也移除），其余改 `ctx.get` 运行期取 + 空态分支
（空预设表、无 archive 时 HistoryService 传 null 回调——L218 已是可选形态）。

### 4.3 boot-finalize："全都要"接线 → 二级级联放大器

`plugin-finalize.ts:24` inject 6 个服务。任何服务行（workspace/archive/timerManager/subagent/l4）卸载
→ boot-finalize 卸载 → `pluginManager` + `webServerHost` 消失 → plugins-http + webui 再级联。
一个服务行的摘除被放大成 4 行下线。接线步骤本身（reloadAll、startArchiveTimeoutWatcher、
setShutdownDeps）对缺失服务全部可以安全跳过/传 null。

### 4.4 排序型依赖：`workspace` 的 inject 无人消费服务本体

`ctx.workspace` 全库只有定义处注释（`workspace.ts:183`"boot-finalize 判读 firstRun"），当前
boot-finalize/server-l4 实际代码**均未读取**该服务——inject 仅为保证 `core.loadAgents()`
（workspace 行副作用）先于 L4 物化。这是"用硬依赖表达顺序"的典型，可改为
server-l4 自查 registry 空则延迟/告警，或保留依赖但知其性质。

### 4.5 plugin-host 行：与 boot-core 幂等冗余（可卸载但意义有限）

boot-core 同样调用 `getOrCreatePluginHost(ctx)`（`plugin.ts:52`，WeakMap 单例），plugin-host 行
只是"尽早提供"。摘除该行后 market 桥行会等待 boot-core 创建的实例，**不产生破坏**——
严格说它已独立，但因 boot-core 属 B 级，实际收益为零。

---

## 5. 包级（代码级）独立性

行级卸载不删代码，包级才是"卸载即删目录"。依据 `docs/dependencies.md`（40 包 175 边：值边 106 / 类型边 65）：

**已经是包级独立的**：types、protocol、util、cosmokit 等零依赖层，以及只被 boot 聚合的叶子域包
（fs/fs-search/str-replace-editor/shell/web/math/session-tools/interaction/restart/agent-* 钩子域等）——
它们对别人的值导入为零，删除不破坏任何其他包的编译。

**包级耦合簇**（删这些包会破坏别人）：

| 被依赖包 | 值导入方 | 性质 |
|----------|----------|------|
| `llm-openai` | llm-deepseek、llm-glm | OpenAI 兼容客户端复用 → 三适配器不互相独立 |
| `agent-prompt` | agent-persona、agent-session | 钩子域共享 prompt 组装 |
| `agents` | archive、router、security、server、web | 对话键/路由原语 |
| `agent-session` | archive、workspace、server | 会话读写 |
| `archive`/`timer`/`subagent`/`backup`/`router`/`durable-interaction`/`agent-presets`/`agent-persona` | server（L4 聚合根） | L4 门面按域 import——server 是包级耦合的汇聚点 |
| `tools` | hooks 及全部工具域 | 注册中心模式（聚合根，合理） |

包级解耦只在目标是"删包不破坏编译"时才需要做，优先级建议放最后（§6 P2）。

---

## 6. 改造路线图（按收益/成本排序）

### P0 —— 每个 C 级行升 A（预计 A 级 33 → 39+）

1. **server-l4 inject 瘦身**（§4.2）：移除 `archive`/`timerManager`/`subagent`/`agentPresets`，
   `durableInteraction` 降级内存兜底 → 一次解放 5 行；`webui`/`plugins-http` 不再受服务行摘除波及。
2. **boot-finalize 降级接线**（§4.3）：各接线步骤按服务存在性跳过/传 null → 解放
   timer-service、subagent-service、archive、workspace-init 对它的束缚。
3. **timer-service 去 `inject: archive`**（§4 C 级表）：回调已兜底，一行改动。

### P1 —— 卫生与防回归

4. **PluginServices 槽位清理**（§4.1）：三个服务行 disposer 补 `core.services.xxx = undefined`；
   subagent-service 补完整 disposer。这是"运行期卸载不炸别人"的必要条件。
5. **diagnostics REQUIRED_SERVICES 可配置化**：解放服务行后，8 项硬编码清单会误报缺口；
   改为按 profile/存在性声明（或随 P0 同步增删）。
6. **回归验证**：为每个"可卸载"行补一条组合测试（复用 `boot/tests/composition.test.ts` 迷你树模式）：
   摘行后启动 → 断言其余行 ACTIVE + 无 ERROR 日志。

### P2 —— 包级独立（仅当需要"删包"语义时）

7. 抽 OpenAI 兼容客户端公共层（llm-openai 内部实现下沉 `@agentchat/llm`），三适配器互不导入。
8. server 聚合根瘦身：跨域调用（persona/ presets/ archive/ timer/ subagent）改经 ctx 服务面
   （多数已有服务）而非直接值导入——与 §4.2 的软化方向一致，可顺势做。

### 改造后预期状态

- A 级（可卸载）：**39~40 行（≈78%）**——全部工具/钩子/适配器/HTTP 表面行 + 5 个原 C 级服务行
- B 级（平台核心）：tools/hooks/llm/agentLoop/jobs/http-host/bootstrap/l4/plugin-host/market 成对/timer(vendor)
- 动态插件（market 安装）：unload 语义已完备，无需改动

---

## 附：证据索引

| 结论 | 位置 |
|------|------|
| inject 缺失 → PENDING 不崩 | `plugins/src/host.ts:240-247` 注释 + `plugin-diagnostics.ts` |
| 服务消失 → 依赖方级联卸载 | `vendor/cordis/src/reflect.ts:297-304`（provide disposer → notify → await fibers）；`fiber.ts:611-639`（_refresh → _unload） |
| server-l4 inject 硬声明 vs 体内可选访问 | `server/src/service-plugin.ts:50` vs `:127-129` |
| boot-finalize 全都要 | `boot/src/plugin-finalize.ts:24` |
| 侧信道写后不清 | `subagent/src/service-plugin.ts:32`（无 disposer）；`timer/src/service-plugin.ts:51,55`；`archive/src/plugin.ts:76-84,90` |
| 工具空态检查（良好示范） | `timer/src/tool.ts:27`；`subagent/src/tool.ts:30`；`interaction/src/tools.ts:38` |
| 动态插件 owner 回收 | `plugins/src/host.ts:391-421`（disposeRecord/cleanupOwner） |
| 排序型 workspace 依赖 | `svc/workspace/src/plugin.ts:23`（core.loadAgents 副作用）；`workspace.ts:183`（ctx.workspace 仅注释提及） |
| plugin-host 幂等兜底 | `boot/src/plugin.ts:52` + `plugins/src/host.ts:475-490`（getOrCreatePluginHost 单例） |
| 包级值边统计 | `docs/dependencies.md`（gen-deps-graph.mjs 自动生成） |
