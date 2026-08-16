# AgentChat 重构前期调研：以 cordis 为基座

> 日期：2026-08-13 · 状态：调研初稿，供方案讨论
>
> 目标：评估"把 AgentChat 重构为以 [cordis](https://github.com/cordiverse/cordis)（Koishi 的底层插件框架）为基座的新项目"的可行性、版本选型、概念映射、迁移策略与风险。
>
> 配套资料：本报告调研期间下载的 cordis/Koishi 官方文档原文已存档在 `docs/research-cordis/`（Koishi 中文文档 7 篇 + cordis 4 教程 3 章）。

---

## 0. 决策记录（2026-08-13 已定）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 迁移方案 | **双轨**：新建 `preview/` 轨道，用方案 A（cordis 基座全量重写）；稳定后一次性迁到 `src/` |
| 2 | cordis 版本 | **4.0.0-rc 线 + DSH vendor 方案**：直接锁版本依赖 DSH 已发布的 vendor 产物 `@deepseek-ai/*`（cordis@4.0.1 等，含其全部 18 条本地修改）；未来如需深度定制再按 DSH 流程本地 vendor（见 `preview/vendor/README.md`） |
| 3 | 拆分粒度 | **需要拆分**：包级（`@agentchat/*` 独立包，~20 个起步）+ 插件级（cordis.yml 一行一个插件）；完整分析见 [cordis-granularity-analysis.md](cordis-granularity-analysis.md) |
| 4 | preview 状态 | 骨架已建：cordis 4 + Loader + Schemastery 全链路跑通（`preview/`，hello 插件验证通过） |

> 双轨要点：preview 与现有 `src/` 完全隔离（独立 npm 项目、独立 node_modules）；数据格式（sessions/*.jsonl、agents/*/config.json 等）两轨共用，新旧进程可并行对照。

---

## 0. TL;DR（结论先行）

- **cordis 是"元框架"（Meta-Framework）**：一个极小的运行时，所有能力——工具、LLM、agent 循环、文件访问——都是挂载到共享 Context 上的**插件**。它解决的核心问题是：**依赖注入（inject）、类型化事件（emit/waterfall/parallel/serial）、可逆副作用（effect/dispose）、配置即代码（loader + cordis.yml + HMR）**。
- **AgentChat 自研的"轮子"与 cordis 高度重合**：插件注册表、插件服务注入、钩子系统、插件域事件总线、配置合并、热重载、优雅关闭、Schema 表单——这些正是 cordis 的一等公民能力。重构后 **自研约 21.5k 行后端代码中，估计有 30–40% 是 cordis 直接替代的基建**，真正需要保留的"业务资产"是 ReAct 引擎、消息路由/steer 模型、工具集、会话/记忆/归档等。
- **版本选型是关键决策点**：
  - `cordis@3.x`（`@cordisjs/core@3.18.1`，**稳定**，Koishi 4 全生态在用，文档齐全）——**建议新项目起步用这条线**。
  - `cordis@4.0.0-rc.8`（latest tag 仍是 RC，README 明示 *"API is not yet stable and may change without notice"*；Koishi 5 预览与 DeepSeek Harness 在用）——适合愿意 vendor 锁版本、跟随 DSH 路线的场景。
- **迁移策略建议：方案 B（渐进式绿地）**——新 repo 以 cordis 为根，按依赖顺序把现有模块一个个包成插件（先 utils/logger → llm → loop → agents → services → server），每完成一个跑一遍现有测试。风险可控、每步可验证、中途可回滚。
- **最大参考实现就是本机正在运行的 DSH（DeepSeek Harness）**：它把 cordis 4 vendor 进仓库，工具/LLM/agent 循环全部插件化，其 `cordis.yml` 组合式配置与"服务/事件"划分与 AgentChat 的目标形态几乎同构。

---

## 1. cordis 是什么：五个核心概念

> 依据：[deepseek-harness/docs/cordis-primer.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/design/cordis-primer.zh.md)（本仓库已拉取，见 `docs/research-cordis/`）与 [Koishi 官方文档](https://koishi.chat/zh-CN/)。

1. **插件 = 实现服务/能力的对象**。三种形态：函数 `apply(ctx, config)`、对象 `{ apply }`、`Service` 子类。插件是 cordis 的基本单元，一个插件只描述"我贡献什么"。
2. **上下文（Context）= 服务的容器**。一个服务占据一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.agents`）；其他插件通过 **key 查找服务，而非 import 具体实现**。`ctx` 也是所有副作用注册的载体（`ctx.on()` / `ctx.effect()` / `ctx.plugin()`）。
3. **`inject` 声明依赖**。插件声明所需服务后，**等这些服务就绪才启动**；加载顺序由服务依赖图推导，而不是手写启动序列。支持 `required` / `optional` 与 `ctx.inject()` 子插件语法糖。服务变化（热重载/卸载）时插件自动回滚并按需重载。
4. **类型化事件**。服务通过 TypeScript **声明合并**注册事件名，以四种分发模式广播：

   | 模式 | await？ | 顺序 | 返回值 | 典型用途 |
   |---|---|---|---|---|
   | `emit` | 否 | 注册序 | 无 | 观察（日志、通知） |
   | `waterfall` | 否 | 注册序 | 有（可短路） | 环绕中间件：`(...args, next)`，调 `next()` 委托下游，不调则短路 |
   | `parallel` | 是 | 并行 | 无 | 扇出（多消费者同时处理） |
   | `serial` | 是 | 注册序 | 有 | 按序执行并收集结果 |

5. **可逆副作用**。提示词片段、工具 schema、监听器、适配器通过 `ctx.effect()` / `ctx.on()` 安装；**reload 与 teardown 时按注册逆序自动撤销**——这是 cordis 支持热重载的根基（对应 Koishi 的 `dispose` 事件与 `Fork` 概念）。

**外围三件套**（DSH vendor 的整套，见 §6）：
- **Loader + Include**：`cordis.yml`（插件条目列表）即应用组合，支持嵌套 include、`!!js` 表达式配置、热重载（HMR）。
- **Schemastery**：配置 Schema 校验（`Schema.object({...})`），坏配置在 `apply` 前就 loud-fail。
- **Cosmokit**：工具库（Logger 等）。

---

## 2. 版本现状与选型（关键决策）

### 2.1 版本事实（2026-08-13 npm/GitHub 实测）

| 包 | 版本 | 状态 | 使用者 |
|---|---|---|---|
| `cordis` | **4.0.0-rc.8**（latest） / 4.0.0-beta.5（next） | RC，README 明示 API 不稳定 | Koishi 5 预览、DSH（vendor rc.7） |
| `@cordisjs/core` | **3.18.1** | 稳定 | Koishi 4（`koishi@4.18.11`） |
| `@cordisjs/plugin-server` | 1.7.0 | 稳定（cordis 3 线） | 轻量 HTTP 服务 |
| `@koishijs/plugin-server` | 3.2.9 | 稳定 | Koishi 4 的 HTTP 服务 |
| `@minatojs/core` / `@minatojs/driver-memory` | 2.9.0 / 4.0.0 | 稳定 | Koishi 数据库层（可选） |
| `schemastery` | 3.18.0（DSH vendor） | 稳定 | 配置 Schema |
| `cosmokit` | 1.8.1（DSH vendor） | 稳定 | 工具库 |

### 2.2 两条线的差异与取舍

- **cordis 3.x（Koishi 4 线）**
  - ✅ 稳定、文档完整（[koishi.chat 中文文档](https://koishi.chat/zh-CN/guide/plugin/index.html)、[cordis.io API 参考](https://cordis.io/zh-CN/)）；生态插件数千个可参考；`@cordisjs/plugin-loader` + `plugin-server` 可直接用 bare cordis（不带 Koishi 的会话/指令体系）。
  - ⚠️ 文档面向 bot 场景（session/command/适配器），bare-cordis 用法需要自己拼装（DSH 教程正是教这个，但其教程基于 4.x）。
- **cordis 4.x（Koishi 5 / DSH 线）**
  - ✅ 更现代的加载器（事务化配置协调、`fiber` 生命周期模型、服务门控懒加载、HMR 强化）；DSH 已完整实践"裸 cordis 构建 harness"路线，`cordis.yml` 即应用组合。
  - ⚠️ **仍无正式版**，API 可能随时变（README 原话）；官方文档少（主要靠 DSH 文档与 [Koishi v5 发布预告帖](https://forum.koishi.xyz/t/topic/7901/25)）；若选用，强烈建议 **vendor 锁版本**（照抄 DSH 的 `vendor/` 模式，见 §6）。

### 2.3 版本决策（2026-08-13 定稿）

> **采用 DSH 路线：cordis 4.0.0-rc 线，以 DSH 已发布的 vendor 产物起步**（`@deepseek-ai/cordis@4.0.1` 等，锁精确版本）——等价于"选 4.0.0-rc.8 + vendor 锁版本"，且 vendor 由 DSH 维护，我们直接用修改后的产物（见 `preview/vendor/README.md`）。
>
> 风险对冲：业务层与 cordis 之间保留**薄适配边界**（服务/事件抽象不直接裸露 cordis 类型），并在 vendor 包升级前核对 DSH 修改日志，控制 API 漂移影响。

---

## 3. AgentChat 现状盘点：要迁移什么

（依据 `docs/architecture.md` 与代码实测）

- **规模**：`src/` 后端 ≈ **21.5k 行 / ~100 文件**（不含 `ui/webui/src` 的 17.8k 行 / 91 文件与归档）；测试 **60 个 vitest 文件**；桌面端 Tauri（独立进程，仅依赖 WS 契约）。
- **5 层单向架构**：`core`（ReAct 引擎/loop/context/中断/llm）→ `agents`（registry/router/group/virtual-agent/credential-store/config-diff）→ `plugins`（builtin：tools 28 个 / extensions / interceptors / timer / sub-agent；builtin-math）→ `services`（registry/rpc/agent/group/history/backup/interactions/archive）→ `app`（bootstrap/loader/shutdown/supervisor）。
- **自研基建清单**（这些正是 cordis 能替代的）：
  1. 插件契约 `PluginDefinition`（meta + tools + hooks + services + configs）与 `PluginRegistry`（resolveTools/resolveHooks/useService/listConfigSchemas）
  2. 插件运行时服务注入 `PluginServices`（router/llm/tools/timer/subAgent/interaction/searchProviders/archiveSession/idleReset —— **L5 手工装配，易漏、有环**：registry→assembly→router 回填）
  3. 钩子系统 7 类（runStart/runEnd/stepStart/stepEnd/toolExecutionStart/toolExecutionEnd/fallback）挂在 `CurrentContext` 上
  4. 插件域事件总线（自建 EventEmitter）+ 流式事件 `chat.*` 20+ 种
  5. 配置三层合并（工具默认值 → workspace/config.json → agent/config.json）+ `ConfigField` 表单 Schema
  6. 热重载（reload self/global/all → 重读磁盘重装配）
  7. shutdown 域化（router 域 → 插件域 → WebUI → exit 42 重启约定）
  8. `ServiceRegistry` + `RPCBridge`（JSON-RPC 2.0 over WS）
  9. `plugin.json` 容器声明 + `AgentConfig.plugins[]` 按名引用钩子/工具
- **业务资产（重构必须保留，cordis 不提供）**：ReAct 循环与语义化中断、会话级并行 + steer 模型、工具 tag 注入规则（`requires` AND 匹配）、记忆/归档/定时/子 Agent 语义、凭据 AES 加密、消息/会话数据格式。

---

## 4. 概念映射表（现有 → cordis）

> 这是本次调研最重要的交付物：**逐项回答"我的 X 到 cordis 里是什么"**。

| # | AgentChat 现有 | cordis 对应 | 迁移要点 |
|---|---|---|---|
| 1 | `PluginDefinition`（四要素容器） | 函数/对象插件 + `inject` | tools/hooks/services 四要素**拆开**：tools→服务或事件；hooks→事件监听；services→`Service` 子类。一个插件一个关注点 |
| 2 | `PluginRegistry`（注册/解析/惰性装载） | `ctx.registry` + Loader + `ctx.inject` | 注册与解析交给 loader 与依赖图；`useService(name)` → 直接 `ctx.<key>`；同名覆盖语义由"后注册者覆盖"变为"同 key 服务替换 + 依赖自动回滚重载" |
| 3 | `PluginServices` 手工注入（router/llm/tools/timer/...） | `Service` 类 + 声明合并 + `inject { required, optional }` | **最大收益点**：消灭 L5 手工装配环（registry→assembly→router 回填），依赖顺序由 cordis 推导 |
| 4 | 钩子 7 类（runStart/runEnd/stepStart/stepEnd/toolExecStart/toolExecEnd/fallback） | 事件：`waterfall` / `serial` / `emit` | runStart/stepStart→`waterfall`（可短路注入）；runEnd/stepEnd→`serial` 或 `emit`；**工具拦截（security-check）→ `waterfall` 短路**（不调 `next()` 即拒绝）——天然对应现有 `ToolExecutionStartResult` 拦截语义 |
| 5 | 插件域 EventBus（自建 EventEmitter）+ `chat.*` 流式事件 | `ctx.emit` / `ctx.parallel` / `ctx.waterfall` + 声明合并 | 20+ 流式事件名直接搬进 `declare module`；流式（不 await）事件用 `emit` 天然吻合 |
| 6 | `ServiceRegistry`（L4 门面）+ `RPCBridge` | Service + `ctx.<key>` | 门面本身也是 Service（如 `ctx.agentService`）；**RPC 层保留为自定义插件**（JSON-RPC 2.0 over WS 与 cordis 无关） |
| 7 | `plugin.json` + `AgentConfig.plugins[]`（磁盘配置、按名引用） | `cordis.yml`（条目列表）+ Schemastery `Schema` | 配置即代码 + 校验 + 默认值 + HMR；`!!js` 表达式支持环境注入 |
| 8 | 热重载（reload self/global/all + 重装配） | Loader HMR + 可逆副作用（`ctx.effect()`/`dispose`） | 现在"重读磁盘重注册"由 cordis 的 fiber 生命周期接管；**插件代码必须可逆**（每个注册配 disposer）——这是 cordis 对插件作者的硬要求 |
| 9 | shutdown 域化（router→插件→WebUI，exit 42） | `ctx.stop()` / 卸载逆序清理 | 资源关闭交给 cordis 生命周期；supervisor（42 重启约定）是进程级策略，保留在启动器 |
| 10 | `TimerManager` / `SubAgentManager` | 普通插件（可参考 `@cordisjs/plugin-timer`） | 直接变成两个插件，`ctx.timer` / `ctx.subAgent` 服务 |
| 11 | `core/loop.ts` ReAct 引擎 + 中断系统 | 一个 Service（如 `ctx.loop` / `ctx.agents`） | **引擎保持自研**（cordis 不提供推理），作为服务暴露，事件外发用 cordis |
| 12 | 会话状态（RunSession/SessionManager/steer/runningMap） | **插件自有状态**（业务数据） | 关键认知：cordis 的 Context 是"插件运行环境"（按插件隔离生命周期），**不是会话容器**；会话并行/steer 是业务逻辑，放进 agent 服务的插件内部，通过事件对外广播 |
| 13 | 工具 tag 注入（`requires` AND 匹配 agent tags） | 保留在自定义 `ctx.tools` 服务内 | cordis 不约束工具的注入策略；现有算法原样搬 |
| 14 | 配置三层合并（默认→workspace→agent） | Schemastery Schema + 插件 config | 全局配置可拆成根插件 config；per-Agent 配置仍由业务服务管理（Agent 不是 cordis 插件，是数据） |
| 15 | `AgentConfig` / `agents/*/config.json` 磁盘形态 | **数据格式建议保留** | 避免数据迁移；cordis.yml 只描述"跑哪些插件"，Agent 数据仍是业务存储 |
| 16 | 日志（`createLogger`） | `ctx.logger(scope)`（cosmokit/reggol） | 可平迁或保留自研 logger（薄适配） |
| 17 | WebUI（Vue3 + REST + WS，express + ws） | 自定义插件（参考 `@cordisjs/plugin-server`） | 前端 17.8k 行基本不动；后端把 server 包成插件，服务经 `ctx.<service>` 取 |
| 18 | 测试（60 个 vitest 文件） | 随模块迁移 + `ctx.mock` 风格测试工具 | 每迁一个模块跑对应测试（见 §7 方案 B） |

**一句话总结**：AgentChat 的 5 层里，**L3 插件体系的"框架部分"和 L5 装配的"胶水部分"被 cordis 吸收；L1 引擎、L2 调度、L4 门面的"业务部分"变成 cordis 插件/服务**。分层单向依赖的纪律 cordis 用依赖图天然保证。

---

## 5. 生态可复用组件

| 组件 | 版本 | 用途 | 采纳建议 |
|---|---|---|---|
| `@cordisjs/core` | 3.18.1 | 框架本体 | ✅ 基座 |
| `@cordisjs/plugin-loader`（+`include`/`hmr`） | 1.0.0-rc.5 等 | cordis.yml 组合 + 热重载 | ✅ 核心 |
| `@cordisjs/plugin-server` / `@koishijs/plugin-server` | 1.7.0 / 3.2.9 | HTTP 服务骨架 | 🔶 参考（现有 express+ws 可先包成插件） |
| `schemastery` | 3.18.0 | 配置 Schema（Standard Schema 兼容） | ✅ 替换 `ConfigField` 表单 |
| `cosmokit` | 1.8.1 | 工具库（logger 等） | 🔶 按需 |
| `@minatojs/core` + `@minatojs/driver-memory` | 2.9.0 / 4.0.0 | 类型驱动数据库层 | 🔶 可选：把 JSONL 会话存储抽象成 minato 驱动（**大改动，二期再议**；driver-memory 4.0.0 与 cordis 4 的兼容性需验证） |
| Koishi 插件市场 | — | 数千个插件可当"参考实现" | 🔶 按需抄模式（如 console、database-*） |

---

## 6. 参考实现：DeepSeek Harness（DSH）—— 本机现成的模板

DSH 是 cordis 路线最完整的生产级样板（[vendor 清单](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)），与本项目形态几乎同构：**工具、LLM 适配器、文件访问、agent 循环全部是挂进共享 Context 的插件**。

- **vendor 模式**：把 `cordis@4.0.0-rc.7`、`loader`、`include`、`group`、`timer`、`hmr`、`logger-console`、`schemastery`、`cosmokit` **源码 vendor 进仓库**并改 `@deepseek-ai` scope（避免 npm 抢占 + 完全可控 + 锁版本）——这是应对 cordis 4 "API 不稳定"的**现成答案**。其 `vendor/README.md` 里的"本地修改日志"展示了如何 fork 修 bug。
- **cordis-primer 的实践规则**（可直接作为新项目的设计原则）：
  - 工具流水线事件 → `ctx.tools`；模型流式输出 → `ctx.llm`；agent 协调 → `ctx.agents`；
  - **拦截与策略优先用事件（waterfall），直接能力调用优先用服务方法**；
  - 每个注册配 disposer（可逆副作用）；teardown 有顺序要求时放同一个 effect。
- **教程**（`docs/cordis-tutorial/`，本机已在运行的环境，直接可实操）：从"第一个插件 + cordis.yml"到"注册模型可调用工具"，是团队上手 cordis 4 的最佳教材（已下载 3 章到 `docs/research-cordis/`）。

---

## 7. 迁移策略：三个方案对比与建议

### 方案 A —— 全量重写（绿地 cordis 项目）
新 repo，cordis 基座，一次性把所有能力包成插件（DSH 模式）。
- ✅ 干净、无中间态、cordis 模型贯穿始终
- ❌ 21.5k 行后端 + 60 测试一次性搬迁，风险最高；cordis 4 未稳定时尤甚

### 方案 B —— 渐进式绿地（**建议**）
新 repo 以 cordis 为 root（一个最小 `cordis.yml` + loader 跑起来），按依赖顺序把现有模块**逐个包成插件**迁移：
1. `utils`/`logger` → 2. `core/llm` → 3. `core/loop`+interrupt（包成 `ctx.agents` 服务）→ 4. `agents/`（registry/router/group，作为服务）→ 5. `plugins/builtin` 工具与扩展（改成事件/服务）→ 6. `services/` 门面 + RPC → 7. `server`/WebUI → 8. timer/sub-agent/backup 等周边。
- 每步"一个插件就位 + 对应测试全绿 + 旧模块停用"，**随时可回滚、每步可验证**；数据格式不变，新旧进程可并行跑同一 workspace 对照。
- ❌ 存在"两套体系并存"的中间态（约几周），需要纪律：新模块只经 cordis 交互，不许回头 import 旧模块。

### 方案 C —— cordis 仅作装配壳
cordis 只做生命周期 + 依赖注入，业务以服务形态平迁，不用事件/可逆副作用。
- ✅ 落地最快
- ❌ 丢掉 cordis 的主要价值（类型化事件/热重载/可逆副作用），等于又造了一个"半 cordis"——**不推荐**。

**最终决策（2026-08-13，见 §0）**：**双轨方案**——新建 `preview/` 以**方案 A（cordis 基座全量重写）**推进（版本 cordis 4.0.0-rc 线 + DSH vendor），等 preview 稳定后**一次性迁到 `src/`**。preview 内部按方案 B 的"自底向上、逐包就位"次序实施迁移（见 `cordis-granularity-analysis.md` §7），但对外表现是"双轨并行、整体切换"：双轨期间新功能只进 preview，旧轨只修 bug，避免两套体系在同一代码库长期并存。**第一个试点插件已跑通**（`preview/src/plugins/hello.ts`，cordis 4 + Loader + Schemastery 全链路验证通过）。

---

## 8. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | cordis 4 API 不稳定（RC + "may change without notice"） | 高 | 起步用 3.x；若用 4 则 vendor 锁版本（DSH 模式） |
| 2 | 文档分散：cordis 4 官方文档少，3.x 文档面向 bot 场景 | 中 | 以 DSH 文档 + 本报告映射表 + Koishi 源码为权威 |
| 3 | 声明合并（`declare module`）的 TS 复杂度，团队不熟悉 | 中 | 先写 1–2 个带服务/事件的示例插件练手（教程第 3/4 章） |
| 4 | 事件分发语义差异：`waterfall` 短路 vs 现有钩子链 | 中 | 逐个钩子对齐（映射表 #4），重点验证 security-check 拦截与 prompt 装配的顺序 |
| 5 | 会话状态 ≠ cordis Context（概念错位风险） | 中 | 团队统一认知：cordis 管插件生命周期，会话是业务数据（映射表 #12） |
| 6 | 60 个测试迁移量大，行为回归 | 中 | 方案 B 每步迁移即跑对应测试；vitest 保留 |
| 7 | WebUI 后端契约（REST/WS/JSON-RPC）适配新服务形态 | 中 | server 最后迁移；契约先冻结，用 RPC 插件包一层 |
| 8 | 桌面端 Tauri 依赖 WS 事件流 | 低 | 事件名保持 `chat.*` 不变，桌面端零改动 |
| 9 | 数据格式（sessions/*.jsonl、agents/*/config.json、memory.md、timer-state.json） | 低 | 全部保留，不引入数据迁移 |
| 10 | 热重载语义差异：cordis 要求所有副作用可逆 | 中 | 新代码遵守"每个注册配 disposer"铁律；现有副作用逐项审计 |

---

## 9. 建议的下一步（可直接开工的清单）

1. **定版本**：3.x 起步 vs 4.0.0-rc+vendor——先开一次评审会（本报告 §2.3 有倾向性建议）。
2. **团队上手**：按 DSH cordis 教程第 1–6 章在 scratch 目录实操（本机环境现成：`node --import tsx <vendor>/cordis/bin.js` + `cordis.yml`）。
3. **试点插件**：把 `TimerManager` 或 `builtin-math` 迁成第一个 cordis 插件（含 Schema + 测试），验证映射表假设。
4. **写映射设计文档**：以 §4 映射表为骨架，细化"事件名清单（`chat.*` 20+）""服务清单（ctx.* 全部）""工具注入策略"三张表。
5. **冻结契约**：REST/WS/JSON-RPC 与 `chat.*` 事件流冻结为对外契约，作为迁移的验收基准。
6. **并行对照**：新旧两进程可同时跑同一 workspace（数据格式不变），做行为对照测试。

---

## 附：参考资料

- [cordis 仓库（cordiverse/cordis）](https://github.com/cordiverse/cordis) —— README：*"Meta-Framework of Spatiotemporal Composability … API is not yet stable"*
- [cordis-primer（DSH）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/design/cordis-primer.zh.md) 与 [cordis 教程（DSH）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/design/cordis-tutorial/index.md)
- [Koishi 官方文档（中文）](https://koishi.chat/zh-CN/guide/plugin/index.html)：认识插件 / 生命周期 / 服务与依赖 / 事件系统 / Context API
- [cordis.io API 参考](https://cordis.io/zh-CN/api/core/context.html)
- [Koishi v5 发布预告（cordis 4 生态动向）](https://forum.koishi.xyz/t/topic/7901/25)
- [socket.dev: cordis 包分析](https://socket.dev/npm/package/cordis/overview/1.5.2)
- 本仓库：`docs/architecture.md`（现状架构）、`docs/research-cordis/`（下载的官方文档原文）
