# @agentchat/agent-config
> 包路径 `src/core/agent-config` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
单 Agent 配置契约包：定义“一个 Agent 的设置”（`AgentConfig`）与插件 manifest 声明/校验。仅含类型与纯函数（校验、聚合、归一化），不 import 运行时服务。新契约以 `presets / tools{include,exclude} / hooks` 三字段表达装配意图，同时保留 `plugins`、`tools:string[]`、`disabledTools`、`disabledHooks` 作为迁移期兼容输入；manifest 契约供全局插件库（workspace/plugins）与动态加载共用。

## 目录
| 文件 | 职责 |
| --- | --- |
| `index.ts` | `AgentConfig`/`AgentPlugin`/`HookNames`、`LEGACY_HOOK_ALIASES`、聚合与配置命名空间纯函数 |
| `manifest.ts` | `PluginManifest`/校验 `validatePluginManifest`、`UI_SLOT_IDS`、`KNOWN_PERMISSIONS` |

## 插件行
无插件行（纯契约/运行库）。由装配层 `createAgentContext`（消费 `AgentConfig`）、插件加载/registry（消费 `validatePluginManifest`）、`@agentchat/hooks`（`normalizeHookName`）使用。

## 提供的能力
### AgentConfig（正式配置）
`AgentConfig` 只显式声明配置文件可持久化的设置字段，不再继承 `CurrentContext`。运行时字段（`llm` 实例、`tools` Map、`history`、`inbox`、`emit`、`signal`、`dialogId`、`systemPrompt`、`currentMessage`、七类钩子数组、`interruptHandlers` 等）由 `createAgentContext` 显式映射进 `CurrentContext`：

| 字段 | 类型 / 语义 |
| --- | --- |
| `agent_id` | Agent 唯一标识（必填） |
| `name` | 昵称（必填） |
| `virtual?` | 虚拟 Agent（无 LLM，仅路由端点） |
| `tags?` | 身份/权限标签；受控能力词汇表 `base/dev/admin/conductor`（`base` 隐式，旧 `agent` 自动归一化）；工具 `requires` 为 AND 门禁 |
| `avatar?` | 头像文件名 |
| `llm?` | `LLMConfig \| string`：池引用 / 内嵌配置 / 引用+覆盖 |
| `deepThink?` | 深度思考开关（单次投递 input 优先） |
| `maxSteps?` | ReAct 最大步数（单次投递 input 优先） |
| `presets?` | 启用哪些插件（cordis 插件 name 列表，候选过滤；顺序无意义） |
| `tools?` | `ToolOverrides { include?, exclude? }` 工具意图覆盖（exclude 优先）；旧 `string[]` 为兼容输入 |
| `disabledTools?` | **@deprecated** 旧停用集合：读入并入 `tools.exclude`，写盘删除 |
| `hooks?` | `HookNames` 钩子启用清单（数组顺序即执行顺序；不在清单里 = 停用） |
| `disabledHooks?` | **@deprecated** 旧停用集合：读入时从 `hooks` 剔除，写盘删除 |
| `plugins?` | **@deprecated** 旧插件装配单元（迁移期兼容输入） |
| `[key: string]: any` | 扩展/工具/安全命名空间配置（如 `"tool.bash"`、`"security"`） |

### HookNames / HookDisabled（七类，与 L1 钩子一一对齐）
`HookNames`：`runStart / runEnd / stepStart / stepEnd / toolExecutionStart / toolExecutionEnd / fallback`，每类均为 `string[]` 启用清单。
`HookDisabled`：同七类的 `string[]` 停用集合，**仅作旧契约兼容输入**；新契约停用 = 移出 `hooks` 清单。

### LEGACY_HOOK_ALIASES（全部 12 条）
```ts
'builtin.open-mcp'           → 'agent-mcp.open-mcp'
'builtin.discovered_skills'  → 'agent-skill.discovered_skills'
'builtin.build-system-prompt'→ 'agent-prompt.build-system-prompt'
'builtin.load-memory'        → 'agent-memory.load-memory'
'builtin.load-history'       → 'agent-session.load-history'
'builtin.security-check'     → 'security.security-check'
'builtin.log-tool'           → 'hooks.log-tool'
'builtin.save-session'       → 'agent-session.save-session'
'builtin.update-memory'      → 'agent-memory.update-memory'
'builtin.idle-reset'         → 'agent-session.idle-reset'
'builtin.archive-session'    → 'agent-session.archive-session'
'builtin.log-usage'          → 'agent-session.log-usage'
```
- `normalizeHookName(name)`：命中别名返回新名，未命中原样返回（保留插件自定义名）。
- `collectHookNames(plugins)`：按七类分别合并、`normalizeHookName`、去重、保序。
- `collectToolNames(plugins)`：聚合 `plugins[].tools`，去重保序；无插件或空返回 `undefined`。
- `getNamespaceConfig(config, ns)`：读取 `config[ns]` 命名空间对象，缺省返回 `{}`。
- `resolveAgentDir(agentId, agentsDir)`：按 `config.json` 的 `agent_id` 在目录中解析 Agent 目录，失败返回 `null`。

## 关键契约 / API
### PluginManifest 全字段
| 字段 | 类型 | 校验规则 |
| --- | --- | --- |
| `name` | `string` | 必填；`/^[a-z0-9][a-z0-9-]*$/`（小写字母/数字/连字符，字母数字开头） |
| `version` | `string` | 必填；`/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/`（semver） |
| `entry?` | `string` | 默认 `index.ts`；非空、不含 `..`、不以 `/` 开头 |
| `inject?` | `string[]` | 必须是字符串数组 |
| `config?` | `Record<string, unknown>` | 必须是对象（缺省 `{}`） |
| `permissions?` | `PluginPermission[]` | 白名单：`fs / network / process / shell / ui` |
| `provides?` | `{ tools: string[]; hooks: string[] }` | 必须是 `{tools,hooks}` 对象；两者均为字符串数组并去重，字段缺省补 `[]`（仅当 `provides` 存在时） |
| `ui?` | `PluginUIManifest` | 见下 |
| `description?` / `author?` | `string` | 可选；未知字段丢弃 |

### PluginUIManifest 与 UI_SLOT_IDS
```ts
export const UI_SLOT_IDS = [
  'perspective', 'tool-result', 'message-view', 'ws-event',
  'settings-tab:global', 'settings-tab:agent', 'sidebar-action', 'global-style',
] as const;   // 8 个白名单
```
`ui` 字段校验：`entry?`/`styles?` 必须是插件目录内相对路径（非空、不含 `..`、不以 `/` 或 `盘符:` 开头）；`slots?` 必须在 `UI_SLOT_IDS` 内（去重）；`isolated?` 必须是 boolean。

### KNOWN_PERMISSIONS 与 P5 权限 gate
```ts
export const KNOWN_PERMISSIONS = ['fs', 'network', 'process', 'shell', 'ui'] as const;
```
- `process/shell` 需宿主显式授予；`ui` 执行期 gate 在 P5 接入。
- **P5 gate**：`manifest.ui` 存在时，`permissions` 必须包含 `'ui'`，否则校验失败（整包原子装载）。

### 其他接口
`AgentPlugin extends HookNames`（`name?`、`tools?`）；`InstalledPluginRecord`、`PluginRegistryDoc`（`version:1`）、`PluginStagingRecord`、`ManifestValidation`（`{ok, errors, manifest?}`）。

## 配置
本包定义配置契约本身，不声明运行时命名空间默认值。约定扩展命名空间示例：`"tool.bash": { "defaultTimeout": 30000 }`、`"security": { "allowedPaths": [...] }`。

## 与其他插件的关系
- 工作区依赖：`@agentchat/agent-loop`、`@agentchat/llm`（仅 `import type`）。
- 典型使用方：`@agentchat/hooks`（`normalizeHookName`/`AgentConfig`）、`@agentchat/agents`（re-export 契约 + `createAgentContext` 消费）、插件加载器/registry（`validatePluginManifest`）、UI 目录（`UI_SLOT_IDS`）。

## 测试
无独立测试（package.json 仅 `typecheck`）。

## 相关文档
[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
