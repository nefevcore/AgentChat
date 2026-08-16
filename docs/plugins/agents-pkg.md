# @agentchat/agents
> 包路径 `src/agents/agents` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

Agent 配置与注册域的运行库（非 cordis 插件）。提供单 Agent 装配依赖注入接口
`AgentAssembly`、装配工厂 `createAgentContext`、cordis 服务 `AgentsService`
（`ctx.agents = registry + router`）、配置注册表 `AgentRegistry`、差异合并工具
`deepMerge/computeDiff`、API Key 加密存取 `credential-store`、会话键纯函数 `paths`。
本包保持纯运行时，不读全局配置、不加载插件、不落盘（凭据与 pending 路径除外）。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `config.ts` | `AgentAssembly` 装配接口 + `createAgentContext` 装配工厂（含虚拟 Agent 空 LLM） |
| `service.ts` | `AgentsService`：`ctx.agents` 聚合 registry 与 router |
| `registry.ts` | `AgentRegistry`：只存 `AgentConfig`，不持有 Agent 实例 |
| `config-diff.ts` | `deepMerge` / `computeDiff` 纯函数，Agent 差异配置加载与保存 |
| `credential-store.ts` | AES-256-GCM 加密凭据文件读写（本机绑定） |
| `paths.ts` | `~` 分隔会话键构造与解析纯函数 |
| `index.ts` | 统一 re-export |

## 插件行

无插件行，作为运行库由 boot 装配使用。

## 提供的能力

### AgentAssembly（L2 装配依赖注入）

| 成员 | 类型/语义 |
| --- | --- |
| `engine` | `AgentLoopEngine`，ReAct 引擎入口（`ctx.agentLoop`） |
| `createLLM` | `(config: LLMConfig \| string) => LLMProvider` |
| `resolveTools` | `(names \| undefined, config) => Map<string, Tool>`，per-Agent 烘焙 |
| `loadHistory` | `(convKey) => LLMRequestMessage[]`，空数组=新会话 |
| `resolveHooks?` | `(names: HookNames, config) => Partial<Pick<CurrentContext, 7 类钩子>>` |
| `emit?` | 事件发射，缺省走 loop 非流式 fast-path |
| `systemPrompt?` | `(config) => string`，缺省为空串 |
| `reloadAgents?` | `(scope, config) => void \| Promise<void>`，热重载执行体（reload interruptHandler 调用） |
| `requestRestart?` | `(reason?) => void`，请求后端重启 |
| `workspaceDir?` | 工作区根（router pending 落盘等） |

### createAgentContext 装配流程

1. `config.virtual` → `makeVirtualLLM()`（model=`virtual`，chat/stream 返回空响应），否则 `assembly.createLLM(config.llm ?? {})`。
2. 工具名：新契约 `config.tools` 优先，缺省回退 `collectToolNames(config.plugins)`。
3. 钩子名：新契约 `config.hooks` 优先，缺省回退 `collectHookNames(config.plugins)`（含旧名归一化）。
4. 历史：`input.dialogId` 存在才调用 `loadHistory`；工具：`resolveTools`；钩子：`resolveHooks`。
5. `engine.createContext({ llm, systemPrompt, history, currentMessage, tools, agentId, deepThink: input.deepThink ?? config.deepThink, maxSteps: input.maxSteps ?? config.maxSteps, dialogId, signal, emit, meta, correlationId, ...hooks })`（AgentConfig 显式字段，不再继承 CurrentContext）。
6. 若注入 `reloadAgents`，装配 `context.interruptHandlers`：`reload-requested` → 执行热重载 → 返回 `{ action:'continue', patch:{ tools, systemPrompt } }` 供 loop 应用后继续推理。

### 其他能力

- `AgentsService(ctx, router, registry?)`：`ctx.agents.registry` / `ctx.agents.router`；契约化避免
  agents↔router package 环。
- `AgentRegistry`：`register/unregister/get/getAgentName/isVirtual/has/listIds/list/size`；
  只存配置无实例，每次投递由 router 按需 `createAgentContext`。
- `credential-store`：文件 `~/.agentchat/credentials.json`（`AGENTCHAT_CREDENTIALS_FILE` 可覆盖）；
  Key 格式 `<agentId>_<provider>_API_KEY`、全局 `__GLOBAL___<provider>_API_KEY`；
  AES-256-GCM + PBKDF2（600k 次，salt `AgentChatCredentialStore:v1`），密钥材料
  `os.hostname() + os.userInfo().username` 绑定本机；存储格式 `v1:<iv+tag+ciphertext base64>`，
  明文兼容旧数据且写入时自动升级加密。
- `paths`：`chatDialogKey(a,b)`（排序共享）、`groupDialogKey(gid,aid)`、`isGroupDialog`、
  `groupIdOfDialog`、`counterpartOfDialog`、`yearWeek`。

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `createAgentContext` | `(config: AgentConfig, assembly: AgentAssembly, input?: AgentContextInput) => CurrentContext` | 每次投递调用一次 |
| `AgentContextInput` | `{ currentMessage?, dialogId?, signal?, maxSteps?, deepThink?, meta? }` | 单次投递输入 |
| `deepMerge` | `<T>(target: T, source: Partial<T>) => T` | 普通对象递归合并；数组/基本类型 source 覆盖；source 为 `undefined` 保留 target |
| `computeDiff` | `(agent, base) => Record<string, unknown>` | 只检出差异；`agent_id`/`name` 始终保留；普通对象递归；值比较用 JSON |
| `credKey` | `(agentId, provider) => string` | `<AGENTID>_<PROVIDER>_API_KEY` 大写 |
| `get/setCredential` | `(agentId, provider[, value])` | Agent 级凭据读写 |
| `get/setGlobalCredential` | `(provider[, value])` | 全局默认凭据 |
| `chatDialogKey` | `(a: string, b: string) => string` | `chat~<lo>~<hi>` |
| `groupDialogKey` | `(groupId, agentId) => string` | `group~<gid>~<aid>` |

## 配置

本包不声明插件配置命名空间。`AgentConfig` 契约由 `@agentchat/agent-config` 定义并 re-export：
`agent_id`、`name` 必填；`virtual?`、`tags?`、`llm?: LLMConfig | string`、
`presets?`（启用插件名列表）、`tools?`（`{ include, exclude }` 工具意图覆盖）、`hooks?`（钩子启用清单）、
`plugins?`（旧契约兼容输入）、以及任意 `[key: string]: any` 扩展命名空间（如
`"tool.bash"`、`"security"`、`"agent.prompt"`、`"agent.session"` 等）。

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-config`、`@agentchat/agent-loop`、
  `@agentchat/llm`、`@agentchat/util`、`@agentchat/cordis`。
- 使用方：`@agentchat/router` 消费 `AgentAssembly`/`createAgentContext`/`AgentRegistry`/`paths`；
  `agent-prompt`/`agent-session`/`agent-memory` 等通过 `paths` 解析会话键；
  boot/host 层装配 `AgentsService` 与 `AgentAssembly`。

## 测试

`package.json`：`typecheck`（tsc --noEmit）、`test`（vitest run）。
测试文件：`tests/config.test.ts`、`tests/registry.test.ts`、
`tests/config-diff.test.ts`、`tests/credential-store.test.ts`。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
