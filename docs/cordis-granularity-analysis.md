# AgentChat 拆分粒度分析：cordis 架构适配

> 日期：2026-08-13 · 状态：调研分析，供评审
>
> 背景：双轨方案已定（preview 以 cordis 4 + DSH vendor 全量重写，稳定后迁 src）。
> 本文回答：**AgentChat 是否需要拆分成更小的粒度？拆到多细？按什么标准拆？**
> 参考实证：DSH（DeepSeek Harness，cordis 4 最大生产用例，160+ 包）与 AgentChat 现有依赖矩阵。

---

## 0. TL;DR

1. **需要拆分，且是两层拆分**：包级（`@agentchat/*` 独立包）+ 插件级（`cordis.yml` 一行一个插件）。**包 ≠ 插件**：一个包可导出多个插件，一个插件 = 一个可独立装卸/热重载的生命周期单元。
2. **当前最大的粒度问题不是"层"，是 `plugins/builtin` 的 47 文件单块**（28 工具 + 4 扩展 + 3 拦截器 + timer + subagent 全塞一个 mod），以及 L5 的**手工装配环**（registry→assembly→router 回填）——这两处正是 cordis 要消灭的。
3. **建议从 ~20 个包起步**（不是 DSH 的 160 个——那是长期演化的结果，且有过度拆分之嫌）；拆分深度按"包就绪标准"（§4）判定，不追求一步到位。
4. **preview 项目形态建议：从第一天起用 pnpm monorepo**（`packages/<domain>/<pkg>`），理由：拆分是确定的（不是要不要，是拆多细），重写期没有历史包袱，工具链切换成本此时最低；DSH 同款结构，参考与迁移零摩擦。
5. **命名冲突预警**：cordis 4 内置 `ctx.registry`（插件注册表），AgentChat 的 Agent 注册表服务不能叫 `registry`，建议 `ctx.agents`；`@deepseek-ai/cordis-plugin-group` 是插件组概念，与 AgentChat 的"群组"不同名，业务群组服务建议 `ctx.agentGroups`。

---

## 1. 现状耦合度盘点（为什么要拆）

### 1.1 依赖矩阵（`src/` 顶层模块，@别名 import 计数，已实测）

```
[agents]  -> core:15   plugins:1
[app]     -> agents:16  core:5   plugins:15  services:4   utils:3
[core]    -> utils:1                          ← 分层铁律的例外（logger/tokens 横切）
[plugins] -> agents:54  core:54  utils:6      ← 插件层对 agents 依赖最重（54 处）
[server]  -> agents:2   core:11  plugins:1   services:22   utils:1   ← 应只依赖 services，有残留
[services]-> agents:25  core:19  plugins:12  shared:9
[shared]  -> （零依赖 ✓）
```

- **分层单向纪律大体成立**（core 零上层依赖、shared 零依赖），但存在三处"架构债"：
  - `core → utils`：违反"core 零外部依赖"（logger 横切）；
  - `server → core/agents` 残留 13 处（应为只 import services）；
  - `plugins → agents` 54 处：大量是类型引用，但说明插件与 Agent 配置模型强耦合。
- **cordis 化的本质变化**：这些**编译期依赖**将变成**运行期服务声明**（`inject`）。拆包后，`plugins` 不再 import `agents`，而是声明 `inject: ['agents']` 后经 `ctx.agents` 访问——依赖图由 cordis 推导，5 层单向纪律从"约定"变为"机制"。

### 1.2 builtin 单块问题（最大粒度债）

`src/plugins/builtin/` 47 个文件，一个 `plugin.json` 容器装下：
- tools/（28 个工具：read/write/edit/bash/web_search/code_search/browser/math/…）
- extensions/（agent-prompt / agent-session / agent-memory / agent-mcp）
- interceptors/（send_agent_from / send_group_from / agent_profile）
- src/（timer 服务 + sub-agent 服务）

问题：**一个插件挂了全部内置能力一起挂**；无法独立启用/关闭/复用某个工具族；热重载粒度 = 整个 builtin。cordis 的哲学是"一个插件一个关注点"，这里需要按扩展/工具族/服务拆开。

### 1.3 手工装配环（cordis 直接消灭的债）

`app/index.ts` bootstrap 中：`makeAgentAssembly` 时 services 是空对象 → 建 `PluginRegistry` → 建 `AgentRouter` → **再回填** router/interaction/archiveSession/idleReset 到 `PluginServices`（引用语义 + 原地合并，防止两份对象）。注释里明写"引用语义：首次调用直接持有调用方对象；后续调用原地合并"——这是**没有依赖图时的手工 DI**。cordis 的 `inject` + Service 注册天然解决：服务就绪即注入，顺序自动推导。

---

## 2. DSH 粒度实证（cordis 4 的生产级答案）

DSH 仓库 `packages/<domain>/<pkg>` 两级结构，160+ 包。关键模式：

### 2.1 三分模式：抽象 / 实现 / 工具暴露

| 域 | 抽象（接口/服务） | 实现（可插拔） | 工具暴露（对 agent 的入口） |
|---|---|---|---|
| fs | `fs/fs` | `fs/fs-local` + `fs/fs-sandbox` + `fs/fs-observation-policy` | `fs/tool-fs`、`fs/tool-fs-search`、`fs/tool-str-replace-editor` |
| shell | `shell/shell` | `shell/bash-local` / `shell/bash-sandbox`、`shell/pwsh-local` / `pwsh-sandbox` | `shell/tool-bash`、`shell/tool-bash-persistent`、`shell/tool-pwsh` |
| llm | `llm/llm` | `llm/llm-deepseek`、`llm/llm-pi-ai`、`llm/llm-retry` | —（token-meter 独立） |
| session | `session/session-persistence` | `session-persistence-jsonl` / `-sqlite` | `session-query/tool-session-query` |
| subagent | `subagent/subagent` | `subagent-in-process-driver`、`subagent-fork-in-process`、`subagent-acp`… | `subagent/tool-subagent`、`tool-subagent-control`、`tool-subagent-report` |

**结论**：DSH 把"接口、实现、工具、策略"四类关注点拆开，实现可以插拔（jsonl ↔ sqlite），工具独立成包（有独立依赖如 puppeteer/SDK 时才必须，但 DSH 普遍这么拆）。

### 2.2 其他模式

- **前端一模块一包**：`client/ui-conversation`、`client/ui-settings`、`client/ui-tool`…（40+ 个），共享 `client/runtime` + `client/modules`，与后端经 `sdk/protocol`（JSON-RPC 契约）连接。
- **组合 = patch 层**：`bundle/base/cordis.patch.yml` 用 `insert` 按 `id` 插入插件行，profile/用户再覆盖；一行 = 一个插件 + config。
- **域内聚合包**：`bundle/base`、`bundle/headless`、`bundle/web-app` 是"预组合 profile"，安装 `dsh-base` 即获得完整插件树。
- **命名**：`@deepseek-ai/dsh-<name>`；启动 glue 独立（`boot/app-boot`）。
- **工具链**：pnpm workspaces + tsdown（esbuild）；每个包 `main: lib/index.js` + `types: lib/types` + `exports` 显式声明。

### 2.3 对 AgentChat 的启示

AgentChat 规模（后端 ~21.5k 行）约为 DSH 的零头——**不需要 160 包，但"抽象/实现/工具"三分 + 可插拔实现 + patch 组合"的模式可以 1:1 借用**，这是 cordis 生态的惯用组织方式。

---

## 3. 拆分判据（"包就绪标准"）

### 3.1 包级拆分判据（独立 `@agentchat/<name>` 包）

满足任一条即应独立成包：

1. **可插拔实现**：存在（或预期存在）多个实现 —— 存储 jsonl/sqlite、LLM deepseek/openai/其他、凭据 file/env/secret。
2. **独立第三方依赖**：某能力引入重型依赖且与主体无关 —— browser 工具(puppeteer)、MCP SDK、加密库。
3. **独立生命周期/可整体关闭**：server（HTTP/WS）、timer、subagent —— 需要能单独停而不影响核心。
4. **独立测试域**：测试量大且独立（agent-loop 的 ReAct 语义测试、server 的协议测试）。
5. **跨端契约**：前后端共用的类型/协议 —— 必须独立（对应现有 `shared/types` → `@agentchat/protocol`）。
6. **对外复用**：未来可能单独发布/被其他项目复用（agent-loop、llm 很典型）。

### 3.2 插件级拆分判据（cordis.yml 一行）

1. 一个关注点一行；**服务 = 一个 `ctx.<key>`**（`ctx.llm`、`ctx.agents`、`ctx.tools`、`ctx.server`）。
2. 工具**按族分组**而非逐个一行：core IO 工具族、协作工具族、管理工具族、math 族——除非某工具需要独立依赖（browser）或独立开关（builtin-math 现已是独立 mod）。
3. 拦截/策略用事件（waterfall），能力调用用服务方法（cordis-primer 实践规则）。
4. 扩展（prompt/session/memory/mcp）各自独立插件——它们现在是 4 个独立 hooks 装配者，天然独立生命周期。

### 3.3 反对过度拆分的护栏

DSH 160 包的管理成本（构建、发布、依赖图复杂度）是真实存在的；AgentChat 起步 **~20 包**，只有满足 §3.1 判据才新增包。**"先单目录边界、后升包"**：迁移中可以先以目录形式存在（物理单包），结构上禁止目录间直接 import，稳定后再机械拆成 workspace 包——拆包是机械动作，难的是边界划分，而边界现在就定。

---

## 4. AgentChat → preview 拆分清单（建议稿）

### 4.1 基建层（依赖 `@deepseek-ai/*`，不拆）

`@deepseek-ai/cordis@4.0.1` + loader/include/hmr/logger-console/timer/group + schemastery + cosmokit（锁精确版本，见 `preview/vendor/README.md`）。

### 4.2 业务包建议（`@agentchat/<name>`，约 20 个）

| 域 | 包 | 来源（现有） | 提供的服务 / 插件行 | 说明 |
|---|---|---|---|---|
| core | `agent-loop` | `core/loop.ts` + `core/interrupt.ts` + `core/context.ts` | `ctx.agents`（或 `ctx.loop`） | ReAct 引擎 + 语义化中断，**业务核心资产，保持自研** |
| core | `llm` | `core/llm/*`（base/openai/deepseek/chat-stream/schemas） | `ctx.llm` | 抽象 + deepseek/openai 实现；对齐 DSH `llm/llm` + `llm-*` |
| core | `token` | `utils/tokens.ts` | `ctx.tokenMeter` | 可选独立（DSH 有 `llm/token-meter`） |
| agents | `agents` | `agents/registry.ts` + `config.ts` + `config-diff.ts` + `virtual-agent.ts` + `credential-store.ts` | `ctx.agents`（注册表/配置/凭据） | **服务名避免 `registry`**（cordis 内置插件注册表占用） |
| agents | `router` | `agents/router.ts` + `group.ts` | `ctx.router` + `ctx.agentGroups` | 消息路由/steer/群组；**`agentGroups` 避免与 cordis-plugin-group 混淆** |
| tools | `tools-core` | builtin tools（read/write/edit/bash/web_search/code_search/…） | 插件行：tools-core | 核心 IO/搜索工具族 |
| tools | `tools-collab` | builtin tools（send_agent/send_group/query_history/list_agents/…） | 插件行：tools-collab | 多 Agent 协作工具（requires: agent） |
| tools | `tools-admin` | builtin tools（reload/inspect_session/…） | 插件行：tools-admin | 管理/运维工具 |
| tools | `tools-math` | `plugins/builtin-math/` | 插件行：tools-math | 沿用独立开关 |
| tools | `tools-browser` | builtin browser 工具 | 插件行（可选） | 若引入 puppeteer 则独立包（判据 #2） |
| ext | `agent-prompt` | builtin extensions/agent-prompt | 插件行 | System Prompt 装配 + MCP 发现 |
| ext | `agent-session` | builtin extensions/agent-session | 插件行 | 会话持久化/历史/归档触发 |
| ext | `agent-memory` | builtin extensions/agent-memory | 插件行 | memory.md 长期记忆 |
| ext | `agent-mcp` | builtin extensions/agent-mcp | 插件行 | MCP 客户端（依赖官方 SDK → 判据 #2 倾向独立） |
| svc | `subagent` | builtin src/sub-agent | `ctx.subAgent` | 对齐 DSH `subagent/*` 三分 |
| svc | `timer` | builtin src/timer | `ctx.timer` | 5 种调度 + chime 自研；评估是否基于 `@deepseek-ai/cordis-plugin-timer` |
| svc | `archive` | `services/archive-service.ts` | `ctx.archive` | 归档编排 |
| svc | `backup` | `services/backup.ts` | `ctx.backup` | 备份 |
| host | `server` | `server/*` + `services/rpc.ts` + `services/interactions.ts` | `ctx.server` | HTTP + WS + JSON-RPC（ask_user 桥并入） |
| host | `webui` | `ui/webui/`（前端产物） | 插件行：静态托管 | 前端基本不动，产物由 server 托管 |
| boot | `app` | `app/index.ts` + `loader.ts` + `shutdown.ts` | — | 启动组合（或直接用 cordis.yml + bin.js，参考 DSH `bundle/base` 模式，可能不需要独立包） |
| sdk | `protocol` | `shared/types/` | — | 前后端 JSON-RPC 契约类型（对齐 DSH `sdk/protocol`） |

> 现有 `services/` 层其余门面（agent-service/group-service/history-service/config-service）在 cordis 化后**多数退化为 `ctx.<key>` 上的方法**，不必保留独立包；其 RPC 暴露由 `server` 包统一处理。

### 4.3 拆分后 cordis.yml 形态（示意）

```yaml
# preview/cordis.yml（或 base.patch.yml + 用户覆盖）
- name: '@deepseek-ai/cordis-plugin-logger-console'
- name: '@deepseek-ai/cordis-plugin-hmr'
- name: '@agentchat/agent-loop'          # 提供 ctx.agents
- name: '@agentchat/llm'
- name: '@agentchat/agents'              # 提供 ctx.agents（注册表/配置）
- name: '@agentchat/router'              # inject: ['agents'] 等
- name: '@agentchat/agent-prompt'
- name: '@agentchat/agent-session'
- name: '@agentchat/agent-memory'
- name: '@agentchat/tools-core'
- name: '@agentchat/tools-collab'
- name: '@agentchat/tools-admin'
- name: '@agentchat/timer'
- name: '@agentchat/subagent'
- name: '@agentchat/server'              # 提供 ctx.server（HTTP/WS/RPC）
- name: '@agentchat/webui'
```

行间顺序无语义（激活由 inject 推导）；未来 Agent 的 plugins 配置（per-Agent 工具/钩子组合）仍由 `ctx.agents` 业务数据管理，**不是** cordis.yml 行。

---

## 5. preview 项目形态建议

### 5.1 建议：pnpm workspaces monorepo，从第一天开始

```
preview/
├── package.json              # private root；workspaces: ["packages/*/*", "vendor/*"]（若本地 vendor）
├── pnpm-workspace.yaml
├── cordis.yml                # 组合（或 packages/boot/base 提供 patch 层）
├── vendor/                   # 目前为空壳说明（依赖 @deepseek-ai/* 已发布包）；未来本地 vendor 落位
└── packages/
    ├── core/agent-loop/  core/llm/  core/token/
    ├── agents/agents/    agents/router/
    ├── tools/tools-core/ tools/tools-collab/ tools/tools-admin/ tools/tools-math/
    ├── ext/agent-prompt/ ext/agent-session/ ext/agent-memory/ ext/agent-mcp/
    ├── svc/subagent/     svc/timer/  svc/archive/  svc/backup/
    ├── host/server/      host/webui/
    ├── sdk/protocol/
    └── boot/base/        # 组合 patch（可选）
```

理由：
- 拆分已定（§4），monorepo 是确定终态，晚拆不如早拆（每个包从第一天就有独立测试/构建）；
- pnpm 是 cordis 生态标准（DSH 同款），workspace link 消除"版本漂移"；
- 双轨期与现有 npm 单包 `src/` 完全隔离，无工具链冲突。

### 5.2 备选：单包 + 目录边界（若团队暂不想切 pnpm）

`preview/src/<domain>/<pkg>/` 目录即包边界，禁跨目录 import（经服务/事件），tsconfig paths 指向目录；稳定后再机械升包。**边界定义（§4.2）现在就生效**，只是物理形态延后。

---

## 6. 命名与冲突规避

| 冲突点 | 说明 | 建议 |
|---|---|---|
| `ctx.registry` | cordis 4 内置插件注册表（RegistryService） | Agent 注册表服务名用 `ctx.agents` |
| `@deepseek-ai/cordis-plugin-group` | 插件组概念（$group） | AgentChat 群组服务名用 `ctx.agentGroups`，包名 `@agentchat/router` 内提供 |
| `ctx.server` | 未来 cordis 生态可能提供 server 服务 | 本项目的 HTTP/WS 服务统一叫 `ctx.server` 并在声明合并中独占；或加前缀 `ctx.acServer`（待评审） |
| `ctx.timer` | `@deepseek-ai/cordis-plugin-timer` 提供 | 若自研 chime 调度，包名 `@agentchat/timer` 并提供同名服务；评估直接扩展现有 vendor timer |

---

## 7. 拆分实施顺序（双轨下的迁移次序）

原则：**从无环、低依赖的包开始，自底向上；每包就位 = 独立测试绿 + cordis.yml 一行启用**。

1. `sdk/protocol`（零依赖，契约先行）→ 2. `core/token` + `core/llm`（无业务依赖）→ 3. `core/agent-loop`（引擎，依赖 llm 服务）→ 4. `agents/agents` + `agents/router`（依赖 agents 服务）→ 5. `tools/*`（依赖 agents/llm 服务）→ 6. `ext/*`（hook 装配者）→ 7. `svc/*`（subagent/timer/archive/backup）→ 8. `host/server` + `host/webui`（最后，契约冻结）→ 9. `boot/base` 组合层 + supervisor（42 重启约定）。

对应现有测试：每包迁移时把相关 vitest 用例搬入该包（60 个测试文件按模块归属分发）。

---

## 8. 风险与待确认问题

### 风险

| 风险 | 缓解 |
|---|---|
| 过度拆分（参考 DSH 160 包教训） | §3.3 护栏：起步 20 包，判据驱动新增 |
| pnpm 切换成本 | 双轨 preview 与现有 npm 隔离，无冲突；重写期切换成本最低 |
| 服务名空间冲突 | §6 命名表先行定稿，声明合并集中管理 |
| 工具族拆分后 tag 注入逻辑分散 | 注入规则（requires AND 匹配）收敛到 `ctx.agents` 或 tools 注册服务，工具包只声明 requires 元数据 |
| WebUI 契约漂移 | `sdk/protocol` 从第一天冻结 REST/WS/JSON-RPC 类型 |

### 待确认问题（评审时拍板）

1. preview 用 **pnpm monorepo（推荐）还是单包+目录边界**？
2. `ctx.agents` vs `ctx.agentRegistry`：注册表服务命名（避免与 cordis `ctx.registry` 混淆）？
3. timer：自研（保留 5 种调度 + chime）还是扩展 `@deepseek-ai/cordis-plugin-timer`？
4. 现有 `services/` 门面哪些并入 `server` 包、哪些保留独立包（archive/backup 已建议独立）？
5. 工具族分 3–4 个包（core/collab/admin/math）是否够细？browser 工具是否立即独立成包？
6. `agent-loop` 服务名：`ctx.agents`（DSH 风格，agent 协调）还是 `ctx.loop`（更贴引擎语义）？

---

## 9. 参考

- [DSH packages 结构（GitHub tree）](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages)
- [DSH vendor/README（vendor 方案）](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)
- [DSH bundle/base cordis.patch.yml（组合形态）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml)
- [cordis-primer（DSH）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/design/cordis-primer.zh.md)
- 本仓库：`docs/cordis-migration-research.md`（总调研）、`preview/`（骨架）、`docs/architecture.md`（现状）
