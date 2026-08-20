# @agentchat/agent-prompt
> 包路径 `src/agent-prompt/agent-prompt` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

Agent 系统提示词装配扩展。把旧 `agent-session/run.ts` 中的 build-system-prompt 装配
逻辑拆分为独立域插件，以 `runStart` 钩子 `agent-prompt.build-system-prompt` 的形式
注入 `ctx.hooks`，在每次 run 开始时重写 `ctx.systemPrompt`。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`agentchat-agent-prompt`，inject `hooks` |
| `register.ts` | 向 `HooksService` 注册 `agent-prompt.build-system-prompt`（runStart） |
| `prompt-hook.ts` | 钩子工厂：从 `dialogId` 推断 sender/groupId，调用 `buildSystemPrompt` |
| `prompt.ts` | 完整装配链：AGENT.md/环境/术语/标签/指引/存储/对话信息 + SYSTEM.md 覆盖 |
| `index.ts` | 统一 re-export |

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-prompt` | `['hooks']` | runStart 钩子 `agent-prompt.build-system-prompt`（owner = 插件 name） |

## 提供的能力

### 钩子

| 钩子 | 阶段 | 实现 |
| --- | --- | --- |
| `agent-prompt.build-system-prompt` | `runStart` | `makeBuildSystemPromptHook(config, services)`：无 `dialogId` 直接返回；群聊由 `group~<gid>~<aid>` 解析 groupId；1v1 用 `counterpartOfDialog` 反解对话对象；然后 `ctx.systemPrompt = buildSystemPrompt(...)` |

### 默认装配顺序（无 SYSTEM.md 时，`prompt.ts`）

1. **角色**：`<agentDir>/AGENT.md` 存在 → `## 角色\n<persona>...</persona>`。
2. **系统环境**：`## 系统环境`（工作目录 `./files/<agentId>/`、路径穿透白名单、OS/Shell/编码；dev/admin 追加引号提示）。
3. **术语约定**：仅当工具清单含协作工具（`send_agent/list_agents/query_history/read_agent_info/update_agent_profile/send_group/list_groups`）时注入。
4. **标签约定**：`<file path=...>` 文件引用格式，始终注入。
5. **指引**：按工具组合注入行为准则——文件 read→edit 工作流、产出物引用（markdown 行内代码列出产出文件）、多 Agent list→send 协作、timer 主动安排、ask_questions 询问、isSupervised 下的 system_restart 语义。
6. **技能清单**：本包不注入（注释预留，由 `agent-skill.discovered_skills` 独立钩子完成）。
7. **持久化存储**：TODO.md/DONE.md/note/`_tmp`/`memory/<对象ID>.memory.md` 约定。
8. **对话信息**（最后）：1v1 对话对象/群聊成员与简介。（[当前时间] 已拆至 `@agentchat/agent-datetime`：runStart 清单钩子把仅日期行追加到 system prompt，按 Agent 显式启用；独立会话不注入。）

### SYSTEM.md 覆盖路径

若 `<agentDir>/SYSTEM.md` 存在：完全替换默认装配，仅追加术语约定（有协作工具时）+
标签约定 + 对话信息。不读 AGENT.md。

### 配置开关（`agent.prompt` 命名空间）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `guidelines` | `true` | 是否注入“指引”块 |
| `systemEnv` | `true` | 是否注入“系统环境”块 |
| `skills` | `true` | 由 agent-skill 钩子读取同一开关；本包仅声明 |
| `conversationPartner` | `true` | 是否注入对话对象/群聊信息 |

（`datetime` 字段已随时间注入拆分移除：改用 `agent.datetime.enabled`，见 [agent-datetime.md](agent-datetime.md)。）

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `buildSystemPrompt` | `(config: AgentConfig, deps: ToolContext, input: SystemPromptDeps) => string` | 完整装配入口 |
| `SystemPromptDeps` | `{ toolNames?: string[]; sender?: string; groupId?: string }` | 工具清单与对话上下文 |
| `PromptConfig` | `{ guidelines, systemEnv, skills, conversationPartner }` | 每个布尔默认 true |
| `makeBuildSystemPromptHook` | `(config, services: ToolContext) => RunStartHook` | 钩子工厂 |
| `registerPromptHooks` | `(hooks: HooksService, owner: string) => void` | 注册入口 |

`deps: ToolContext` 需要 `agentsDir`、`router?.getGroupManager()`（群成员/群名解析）等；
工具清单取自 `ctx.tools.keys()`，不再在 prompt 中重复注入工具定义。

## 配置

- 命名空间：`agent.prompt`（常量 `NS_AGENT_PROMPT`，来自 `@agentchat/toolkit`）。
- 读取方式：`getNamespaceConfig(config, NS_AGENT_PROMPT)`，字段见上表；`false` 才关闭，缺省全开。

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-config`、`@agentchat/agent-loop`、
  `@agentchat/agents`（`counterpartOfDialog/isGroupDialog/groupIdOfDialog`）、
  `@agentchat/hooks`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/util`。
- **不依赖 `@agentchat/agent-session`**；恰恰相反，`agent-session` 依赖本包的
  `buildSystemPrompt`（原装配代码自 agent-session/run.ts 移入以避免依赖环）。
- 与 `agent-skill` 协同：本包保留 `skills` 开关，技能清单由
  `agent-skill.discovered_skills` 在 runStart 阶段追加到 `ctx.systemPrompt` 末尾。

## 测试

`package.json`：仅 `typecheck`（无 test script）。
测试文件：`tests/prompt-hook.test.ts`。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
