# Preview 契约化重建方案：包清单 + inject 矩阵 + 迁移步骤

> 目标：在不丢失现有 318 测试行为的前提下，把 preview 从“包依赖图”视角切换为“契约 + 插件”视角。
> 核心分层：**Loop 循环 → 单 Agent → 多 Agent 路由 → 实现 → 宿主/UI**。
>
> ✅ **状态（2026-08-15）：已全部落地，且按“不考虑兼容”执行收尾** ——
> `@agentchat/ext` 已删除、`agents` 不再 re-export 配置契约、`AgentMessage` 为唯一消息契约（无 `Message` 别名）、路由协议消息命名为 `RouterMessage`、未使用依赖已清理。验证：typecheck 零错误 / 318 测试全绿 / `pnpm dev` Ready。
> P0~P3 已完成：依赖图图 2 最终态、gen-deps 误报修复、真实 DeepSeek LLM 验证通过、agents↔router 类型级环消除、WebUIServer.start 幂等、BootstrapResult.webui 强类型。
> cordis 全家桶已本地 vendor：`@agentchat/cordis` / `-loader` / `-include` / `-hmr` / `-logger` + `@agentchat/cosmokit` / `@agentchat/schemastery`。

---

## 1. 目标分层

```text
0  基础设施          logger
1  契约 / LLM        types · protocol · llm
2  Loop 循环         tools · hooks · agent-loop
3  单 Agent          agent-config · agents
4  多 Agent          router
5  实现              fs/shell/web/dev/session-tools/app-tools/math/timer/subagent
                    agent-prompt/agent-session/agent-memory/agent-mcp/security/agent-tools
                    agent-skill
6  宿主 / UI         server · boot · ui
```

关键原则：

- `types` / `protocol` / `agent-config` 是**契约包**，不参与 cordis，不进 `inject`。
- `llm` / `tools` / `hooks` / `agent-loop` 是**服务提供插件**，提供 `ctx.llm` / `ctx.tools` / `ctx.hooks` / `ctx.agentLoop`。
- `agents` / `router` 是**单 Agent / 多 Agent 运行时库**，由宿主层（boot）装配成 `ctx.agents` / `ctx.router`，避免工具实现（timer/subagent 等）与路由层形成环。
- 工具 / 钩子实现是**服务消费者插件**，各自 `inject` 注册中心并注册能力。

---

## 2. 包清单

### 2.1 契约包（无插件、无 inject）

| 包名 | 层 | 角色 | 归属契约 |
|---|---|---|---|
| `@agentchat/types` | 1 | 核心域契约 | `AgentMessage`、`MessageRole`、`ToolCall`、`ToolDefinition`、`ToolStream`、`LLMRequestMessage` |
| `@agentchat/protocol` | 1 | 跨端/持久化契约 | `PersistedMessage`、`PersistedRole`、`GroupPersistedMessage`、`AgentInfo`、`GroupInfo`、`PluginMeta` |
| `@agentchat/agent-config` | 3 | 单 Agent 配置契约 | `AgentConfig`、`AgentPlugin`、`HookNames`、`collectToolNames`、`collectHookNames`、`getNamespaceConfig` |

### 2.2 核心服务插件（提供运行时服务）

| 包名 | 层 | 插件 | 提供服务 | inject |
|---|---|---|---|---|
| `@agentchat/llm` | 1 | `src/plugin.ts` | `ctx.llm`（适配器工厂/注册表） | 无 |
| `@agentchat/llm` | 1 | `src/plugin-deepseek.ts` | 注册 deepseek 适配器 | `['llm']` |
| `@agentchat/llm` | 1 | `src/plugin-openai.ts` | 注册 openai/default 适配器 | `['llm']` |
| `@agentchat/agent-loop` | 2 | `src/plugin.ts` | `ctx.agentLoop`（ReAct 引擎入口） | 无 |
| `@agentchat/tools` | 2 | `src/plugin.ts` | `ctx.tools`（工具注册中心） | 无 |
| `@agentchat/hooks` | 2 | `src/plugin.ts` | `ctx.hooks`（钩子注册中心） | 无 |

### 2.3 单 Agent / 多 Agent 运行时库（无插件，由 boot 装配）

| 包名 | 层 | 角色 |
|---|---|---|
| `@agentchat/agents` | 3 | `AgentAssembly`、`createAgentContext`、`AgentRegistry`、`AgentsService` 包装 |
| `@agentchat/router` | 4 | `AgentRouter`、`GroupManager`、`RouterMessage`（路由协议消息）、虚拟 Agent |

> 说明：`agents` / `router` 在目标态不直接写 `plugin.ts`。原因是 `AgentAssembly` 需要工具实现、timer/subagent、archive 等宿主级服务注入；若把它们做成插件，会形成 `agents → timer → router → agents` 的运行环。所以由 `boot` 作为装配插件统一构建。

### 2.4 工具实现插件（服务消费者）

| 包名 | 层 | 注册内容 | inject |
|---|---|---|---|
| `@agentchat/fs` | 5 | read/write/edit | `['tools']` |
| `@agentchat/shell` | 5 | bash | `['tools']` |
| `@agentchat/web` | 5 | web_search/browser | `['tools']` |
| `@agentchat/dev` | 5 | code_search/reload/register_tool 等 | `['tools']` |
| `@agentchat/session-tools` | 5 | 会话工具 | `['tools']` |
| `@agentchat/app-tools` | 5 | 应用管理工具 | `['tools']` |
| `@agentchat/math` | 5 | math 沙箱工具 | `['tools']` |
| `@agentchat/timer` | 5 | timer 工具 | `['tools']` |
| `@agentchat/subagent` | 5 | subagent 工具 | `['tools']` |

### 2.5 钩子实现插件（服务消费者）

| 包名 | 层 | 注册内容 | inject |
|---|---|---|---|
| `@agentchat/agent-prompt` | 5 | build-system-prompt | `['hooks']` |
| `@agentchat/agent-skill` | 5 | discovered_skills（技能发现/解析/注入） | `['hooks']` |
| `@agentchat/agent-session` | 5 | load-history / save-session / idle-reset / archive-session / log-usage | `['hooks']` |
| `@agentchat/agent-memory` | 5 | load-memory / update-memory | `['hooks']` |
| `@agentchat/agent-mcp` | 5 | open-mcp | `['hooks']` |
| `@agentchat/security` | 5 | security-check / 输出脱敏 | `['hooks']` |
| `@agentchat/agent-tools` | 5 | 多 Agent 协作工具 | `['tools']` |

### 2.6 宿主 / 装配插件

| 包名 | 层 | 插件 | 提供服务 | inject |
|---|---|---|---|---|
| `@agentchat/boot` | 6 | `src/plugin.ts` | `ctx.agents` / `ctx.router` / `ctx.server` / `ctx.timer` / `ctx.subagent` | `['agentLoop', 'llm', 'tools', 'hooks']` |
| `@agentchat/server` | 6 | 库（由 boot 构造） | WebUIServer / L4 门面 / RPC | 无（经 boot 注入） |
| `@agentchat/ui` | 6 | 静态资源 | WebUI 前端产物 | 无 |

> 可选演进：后续若要把 `timer` / `subagent` / `server` 独立成服务行，可分别增加插件：
> - `timer` 插件：`inject: ['tools', 'router']`，提供 `ctx.timer`
> - `subagent` 插件：`inject: ['tools', 'agentLoop']`，提供 `ctx.subagent`
> - `server` 插件：`inject: ['router', 'agents']`，提供 `ctx.server`
> 但这需要先把 `ToolContext` 的 timer/subagent 注入从“boot 组装”改为“agents 经 ctx 服务读取”，属于第二轮优化，不在首轮迁移范围。

---

## 3. 契约包归属说明

### 3.1 `@agentchat/types` —— 核心域契约

所有包都要说“同一种语言”的地方：

- `AgentMessage`：**唯一**领域消息契约（已无 `Message` 别名）。
- `MessageRole`：`system/user/assistant/tool/error/trigger/agent`。
- `ToolCall`：内存态工具调用（arguments 为对象）。
- `ToolDefinition`：OpenAI 兼容工具定义（LLM 与工具共同使用）。
- `ToolStream`：工具执行流式回调。
- `LLMRequestMessage`：LLM 请求消息（与 `AgentMessage` 同构）。

原则：**不包含任何运行时实现，不 import 任何模块**。

### 3.2 `@agentchat/protocol` —— 跨端 / 持久化契约

面向 UI、WS、JSON-RPC、会话文件：

- `PersistedMessage` / `PersistedRole` / `GroupPersistedMessage`
- `AgentInfo` / `GroupInfo` / `PluginMeta`
- 后续新增 WS/RPC DTO 也放这里。

原则：**只描述跨边界的数据形状**，不依赖业务实现。

### 3.3 `@agentchat/llm/contracts.ts` —— LLM 域契约

- `LLMConfig` / `LLMProvider` / `LLMRequest` / `LLMResponse` / `LLMUsage` / `StreamToken` / `ChatStream`。
- 消息转换由 `LLMProvider.toProviderMessages` / `fromProviderMessages` 承担（`AgentMessage` ↔ provider 原生消息）。
- 依赖 `types`（消息/工具定义），但不依赖 `tools` / `hooks`，不再 re-export `types`。

### 3.4 `@agentchat/tools/contracts.ts` —— 工具执行契约

- `Tool`：可执行工具接口。
- `ToolContext`：工具工厂运行时注入面（router/llm/timer/subagent/interaction/searchProviders 等）。
- `ToolsService` 接口（注册/收集/注销）。
- 依赖 `types` 与 `agent-loop` 的 `Tool` 相关类型。

### 3.5 `@agentchat/hooks/contracts.ts` —— 钩子注册契约

- `HooksService`：`register(kind, name, factory)` / `collect(names)`。
- `HookNames`：七类钩子名集合。
- 钩子函数签名（`RunStartHook` / `StepStartHook` / `ToolExecutionStartHook` 等）为避免与 `agent-loop` 成环，**继续由 `agent-loop` 定义，`hooks` 包 re-export**。

### 3.6 `@agentchat/agent-loop/contracts.ts` —— 引擎契约

- `CurrentContext`：单次执行输入快照（llm/tools/hooks/steer/emit 等）。
- `RunResult` / `InterruptReason` / `CoreEventType`。
- `AgentLoopEngine`：`run` / `createContext` / `pushSteer`。
- 这是 `agent-loop` 的“纯引擎契约”，不依赖 `tools` / `hooks` 的运行时服务。

### 3.7 `@agentchat/agent-config` —— 单 Agent 配置契约

- `AgentConfig`：Agent 的声明式配置。
- `AgentPlugin`：工具名 + 各阶段钩子名的聚合声明。
- `HookNames`：由 `hooks` 契约 re-export。
- 纯函数工具：`collectToolNames` / `collectHookNames` / `getNamespaceConfig` / `resolveAgentDir`。
- 无兼容模式：`@agentchat/agents` **不再** re-export 上述配置契约，一律从本包直连导入。

### 3.8 `@agentchat/agent-skill` —— 技能域契约与实现

- `SkillManifest`：技能清单（name/description/dirName）。
- `parseSkillFrontmatter` / `discoverSkills` / `buildSkillsBlock`：技能发现与渲染。
- `makeInjectSkillsHook`：把技能注入 `CurrentContext.systemPrompt` 的 runStart 钩子工厂。
- 作为第 5 层实现包，同时拥有自己的领域类型与注册入口（`inject: ['hooks']`）。

---

## 4. inject 矩阵（目标 cordis.yml）

```text
行                                          提供/注册                          inject
────────────────────────────────────────────────────────────────────────────
logger                                      ctx.logger                          -
@agentchat/llm/src/plugin                    ctx.llm                             -
@agentchat/llm/src/plugin-deepseek           注册 deepseek 适配器                 ['llm']
@agentchat/llm/src/plugin-openai             注册 openai/default 适配器           ['llm']
@agentchat/agent-loop/src/plugin             ctx.agentLoop                        -
@agentchat/tools/src/plugin                  ctx.tools                            -
@agentchat/hooks/src/plugin                  ctx.hooks                            -
@agentchat/fs/src/plugin                     注册 fs 工具                         ['tools']
@agentchat/shell/src/plugin                  注册 shell 工具                      ['tools']
@agentchat/web/src/plugin                    注册 web 工具                        ['tools']
@agentchat/dev/src/plugin                    注册 dev 工具                        ['tools']
@agentchat/session-tools/src/plugin          注册会话工具                         ['tools']
@agentchat/app-tools/src/plugin              注册应用工具                         ['tools']
@agentchat/math/src/plugin                   注册 math 工具                       ['tools']
@agentchat/timer/src/plugin                  注册 timer 工具                      ['tools']
@agentchat/subagent/src/plugin               注册 subagent 工具                   ['tools']
@agentchat/agent-prompt/src/plugin           注册提示词钩子                       ['hooks']
@agentchat/agent-skill/src/plugin            注册技能注入钩子                     ['hooks']
@agentchat/agent-session/src/plugin          注册会话钩子                         ['hooks']
@agentchat/agent-memory/src/plugin           注册记忆钩子                         ['hooks']
@agentchat/agent-mcp/src/plugin              注册 MCP 钩子                        ['hooks']
@agentchat/security/src/plugin               注册安全钩子                         ['hooks']
@agentchat/agent-tools/src/plugin            注册协作工具                         ['tools']
@agentchat/boot/src/plugin                   ctx.agents/router/server/timer/subagent
                                             ['agentLoop', 'llm', 'tools', 'hooks']
```

注意：

- `types` / `protocol` / `agent-config` **不进 cordis.yml**。
- `agents` / `router` **不进 cordis.yml**，由 `boot` 构造。
- `boot` 是唯一同时消费四个核心服务的装配行。

---

## 5. 依赖方向与环约束

```text
types/protocol          （根，零依赖）
  ↑
llm                     （依赖 types）
  ↑
agent-loop              （依赖 types/llm 类型）
  ↑
tools / hooks           （依赖 types/agent-loop 类型）
  ↑
agent-config            （依赖 types/llm/agent-loop 类型）
  ↑
agents                  （依赖 agent-config/agent-loop/llm/tools/hooks 类型）
  ↑
router                  （依赖 agents/agent-loop/llm 类型）
  ↑
工具/钩子实现             （依赖 tools/hooks 服务 + 各自领域类型）
  ↑
boot                    （装配所有）
```

约束：

1. 值级依赖保持单向无环。
2. `agents` / `router` 对 `timer` / `subagent` 只允许 `import type`，运行期经 `ToolContext` 注入。
3. 工具领域包对 `tools` 只允许 `import type`，注册动作走插件 `inject: ['tools']`。
4. 钩子实现包对 `hooks` 只允许 `import type`，注册动作走插件 `inject: ['hooks']`。

---

## 6. 迁移步骤

### Step 0：✅：基线固化

- 跑 `pnpm typecheck` / `pnpm test` / `pnpm dev`，确认 318 测试全绿。
- 以当前 `docs/preview-knowledge-base.md` 为基线。

### Step 1：✅：抽出 `@agentchat/types`

- 新建 `preview/packages/core/types`。
- 把消息/工具契约迁入，`AgentMessage` 成为唯一消息类型（无 `Message` 别名）。
- `llm` / `agent-loop` 直连 `types`，不再 re-export 消息/工具契约。
- 验证：typecheck + 测试全绿。

### Step 2：✅：抽出 `@agentchat/protocol`

- 保留现有 `protocol` 包，明确为跨端契约。
- 将 `PersistedMessage` 等与 `types` 对齐（可 `import type`）。
- 验证：typecheck + 测试全绿。

### Step 3：✅：`ext` → `@agentchat/hooks`

- 新增 `preview/packages/core/hooks`。
- `HooksService` 迁入；`HookNames` 迁入；钩子函数签名从 `agent-loop` re-export。
- 所有 `@agentchat/ext` 引用改为 `@agentchat/hooks`；**ext 包已删除**。
- 验证：typecheck + 测试全绿。

### Step 4：✅：抽出 `@agentchat/agent-config`

- 从 `agents` 包中拆出 `AgentConfig` / `AgentPlugin` / `HookNames` / `collectToolNames` / `collectHookNames` / `getNamespaceConfig` / `resolveAgentDir`。
- 无兼容模式：`agents` 不 re-export，所有消费方直连 `@agentchat/agent-config`。
- 验证：typecheck + 测试全绿。

### Step 5：✅：抽出 `@agentchat/agent-skill`

- 新建 `preview/packages/agent-skill`。
- 从 `agent-prompt` 迁出技能逻辑：`SkillManifest`、`parseSkillFrontmatter`、`discoverSkills`、`buildSkillsBlock`、`makeInjectSkillsHook`。
- `agent-prompt` 只保留 `build-system-prompt`；`discovered_skills` 钩子改由 `@agentchat/agent-skill` 注册（`inject: ['hooks']`）。
- 若 `resolveAgentDir` 仍被两边共用，把它下沉到 `agent-config` 或 `toolkit` 路径助手，避免 `agent-prompt → agent-skill` 反向依赖。
- 验证：typecheck + 测试全绿。

### Step 6：✅：明确 `agents` / `router` 为运行时库

- 保持 `agents` 提供 `AgentAssembly` / `createAgentContext` / `AgentRegistry`。
- 保持 `router` 提供 `AgentRouter` / `GroupManager` / 虚拟 Agent。
- 不新增 `plugin.ts`，明确由 boot 装配。
- 验证：typecheck + 测试全绿。

### Step 7：✅：梳理 `AgentAssembly` 注入面

- 把 `makeAgentAssembly` 的 `services` 注入面整理为 `AgentAssemblyDeps`：
  - 必须：`engine`、`createLLM`、`resolveTools`、`resolveHooks`、`loadHistory`
  - 可选：`emit`、`systemPrompt`、`performReload`、`requestRestart`、`redactResult`、`workspaceDir`
- 移除 `agents` 对 `timer` / `subagent` 的值依赖，只保留 `ToolContext` 类型。
- 验证：typecheck + 测试全绿。

### Step 8：✅：统一工具/钩子实现注册

- 所有工具实现行统一 `inject: ['tools']`。
- 所有钩子实现行统一 `inject: ['hooks']`（`agent-tools` 保持 `['tools']`）。
- 把 `ext` 内联的 log-tool 钩子移到 `hooks` 服务或对应实现包。
- 验证：typecheck + 测试全绿。

### Step 9：✅：重写 `cordis.yml`

- 按第 4 节矩阵重排。
- `boot` 行保持 `inject: ['agentLoop', 'llm', 'tools', 'hooks']`。
- 移除任何不存在的服务名（如 `types`）。
- 验证：`pnpm dev` 全行激活，WebUI Ready。

### Step 10：✅：契约类型收敛

- 统一 `AgentMessage` 命名，**旧 `Message` 别名已删除**，路由协议类型独立为 `RouterMessage`。
- 清理 `protocol` / `types` 重复类型；`llm` / `agent-loop` 不再 re-export 下层契约。
- 跑依赖图脚本，确认值级 DAG。

### Step 11：✅：全量验证

- `pnpm typecheck` 零错误。
- `pnpm test` 全绿（保持 318+）。
- `pnpm dev` Ready。
- 更新 `docs/preview-knowledge-base.md` 与依赖图。

---

## 7. 验收标准

1. `types` / `protocol` / `agent-config` 不进 cordis.yml，不参与 inject。
2. `agent-loop` 行无 inject，保持纯引擎。
3. `boot` 行是唯一装配行，inject 四个核心服务。
4. 工具/钩子实现全部经 `ctx.tools` / `ctx.hooks` 注册。
5. 值级依赖无环。
6. 无兼容残留：`@agentchat/ext` 不存在，`Message` 别名不存在，配置契约不经 `agents` re-export。
7. 318 测试全绿，`pnpm dev` Ready。
