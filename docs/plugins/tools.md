# @agentchat/tools
> 包路径 `src/tools/tools` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
工具注册中心（cordis `Service`）。提供 `ctx.tools`（`ToolsService`），作为工具注册、presets 过滤、requires 解析与卸载的唯一入口。领域工具包（fs/shell/web 等）各自独立成行，经 `ctx.tools.registerFactory/register` 注册；本包不聚合具体工具。工具基础（`defineTool`/命名空间/沙箱/文本）与 edit 引擎已下沉 `@agentchat/toolkit`、`@agentchat/edit`，本包通过 `index.ts` 保留对 `@agentchat/toolkit` 的兼容 re-export。

## 目录（关键源文件）
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`new ToolsService(ctx)` 注册 `ctx.tools` |
| `service.ts` | `ToolsService`：register / registerFactory / unregister / resolveTools / 目录查询 |
| `contracts.ts` | `ToolContext` 与 `PluginServices` 注入面契约（纯类型） |
| `paths.ts` | 会话/记忆文件路径；`chatSessionFile/groupSessionFile` 已下沉并 re-export 自 toolkit |
| `index.ts` | 出口：contracts + service + paths + 兼容 re-export `@agentchat/toolkit` |
| `define-tool.ts` / `namespaces.ts` / `schema.ts` | 迁移期本地副本；`index.ts` 不再从此导出，新代码统一走 toolkit |

## 插件行
| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `src/tools/tools/src/plugin.ts` | `agentchat-tools` | 无（自身是服务提供者） | `new ToolsService(ctx)`；日志打印“工具注册中心就绪” |

## 提供的能力（ctx 服务表）
`ctx.tools: ToolsService`（cordis 模块声明位于 `service.ts` 底部）：

| 方法 | 行为要点 |
| --- | --- |
| `register(owner, tools, opts)` | 注册共享工具；`opts.replace=true` 时先移除已有同名共享注册（后注册者胜）；`opts.always=true` 标记运行时注册、始终启用 |
| `registerFactory(owner, fn)` | 注册 per-Agent 工厂 `(config, services) => Tool[]`（烘焙沙箱路径/命名空间/身份等） |
| `unregister(owner)` | 按 owner 精确卸载全部共享工具与工厂（动态插件 dispose 用），返回移除条数 |
| `clear()` | 清空全部注册（热重载/测试） |
| `listOwners()` | 全部注册 owner（无主注册记空串并过滤），诊断/UI 用 |
| `listAll(config, services)` | 收集全部工具（不过 presets 过滤），供 UI 目录 |
| `listCatalog(config, services)` | 全量目录带 owner；`replace` 共享注册遮蔽同名工厂 |
| `listByOwner(owner, config, services)` | 指定 owner 的工具（manifest.provides 反查用） |
| `resolveTools(names, config, services)` | 按 Agent 配置解析最终工具 `Map`，见下 |

## 工具参考
本包是注册中心，不直接注册业务工具（无工具表）。领域工具见 `@agentchat/fs`、`@agentchat/shell`、`@agentchat/web` 等包文档。

## 关键契约 / API
### 注册条目
| 类型 | 字段 | 语义 |
| --- | --- | --- |
| `ToolEntry` | `tool`, `owner?`, `always?`, `replace?` | `owner` = cordis 插件 name（preset id）；缺省 owner = 无主/内置，始终参与烘焙；`always` 跳过 presets 过滤；`replace` 同名替换 |
| `ToolFactoryEntry` | `factory`, `owner?` | per-Agent 烘焙工厂 |
| `ToolCatalogEntry` | `tool`, `owner?`, `always?`, `replace?` | 目录条目（UI/反查） |

### resolveTools 解析步骤
1. **插件级过滤**：`listEnabled` 按 `config.presets` 过滤 owner——`always` 或 owner 缺省始终启用；`presets` 未声明（`undefined`）时不过滤（旧契约兼容）；否则要求 `presets.includes(owner)`。
2. **requires 权限门禁**：`effectiveCapabilityTags(config.tags)` 隐式包含 `base` 并把旧 `agent` 归一化为 `base`；`tool.requires` 非空且每个标签都命中才可启用（门禁不通过时 include 无效）。受控词汇表 `base/dev/admin/conductor`。
3. **意图覆盖**：`config.tools = { include, exclude }`（旧 `string[]` 与 `disabledTools` 读入时归一化）；优先级 `exclude > include > 默认`——requires 非空的候选默认启用，requires 为空默认关闭。

### ToolContext（工具工厂第二参数，contracts.ts）
| 字段 | 类型/说明 |
| --- | --- |
| `router?` | `AgentRouter`（query_history / 会话工具） |
| `searchProviders?` | `Record<string, Record<string, unknown>>`（web_search 池） |
| `interaction?` | `ToolInteraction.askQuestions({agentId,convKey,questions,timeoutMs?,signal?})` |
| `llm?` | LLM 实例（subagent 工具；延迟占位 `unknown`） |
| `tools?` | `Map<string, Tool>`（当前 Agent 工具集） |
| `timer?` / `subAgent?` | 定时任务 / 子 Agent 管理器（延迟占位） |
| `agentsDir?` | Agent 配置目录 |
| `workspaceDir?` | 工作区根（`<ws>/plugins` 插件库所在） |
| `archiveSession?` / `idleReset?` | 归档编排钩子 / 空闲归档计时器重置（延迟占位） |

### PluginServices（L5 装配注入面，contracts.ts）
`router?`（`AgentRouter`）、`llm?`（`LLMProvider`）、`tools?`（`Map<string, Tool>`）、`timer?`（`TimerManager`）、`subAgent?`（`SubAgentManager`）、`interaction?`（同 `ToolInteraction`）、`searchProviders?`、`agentsDir?`、`workspaceDir?`、`archiveSession?(ctx: CurrentContext, result: RunResult) => Promise<void>|void`、`idleReset?(dialogId, selfId?)`。

### paths.ts 主要路径函数
| 函数 | 路径 |
| --- | --- |
| `sessionFileOf(dialogId)` | `sessions/<dialogId>/messages.jsonl`（1v1） |
| `chatArchiveDir(a, b)` | `sessions/chat~<lo>~<hi>/archive` |
| `groupHistoryFile(gid, aid, date?)` | `sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl` |
| `groupAgentArchiveDir(gid, aid)` / `groupArchiveRoot(gid)` | 群聊 Agent 归档目录 / 群聊归档根 |
| `memoryFile(selfId, counterpart)` | `files/<selfId>/memory/<counterpart>.memory.md` |
| `memoryMarkerFile(selfId, counterpart, kind)` | `.../<counterpart>.memory_<update|review>_needed` |
| `legacyCanonicalSessionFile(a, b)` | 旧格式 `sessions/<lo>/<hi>/messages.jsonl` 回退 |
| re-export | `chatSessionFile` / `groupSessionFile`（下沉自 toolkit）及会话键纯函数（`DIALOG_SEP`/`chatDialogKey`/`groupDialogKey`/`isGroupDialog`/`counterpartOfDialog` 等） |

## 配置
- 本包无自有命名空间；**presets 过滤键就是 cordis 插件 name**（如 `agentchat-fs-tools`）。
- `'base'` 为隐式基础能力层：`resolveTools` 总是把 `base` 加入有效标签（旧 `agent` 读取时归一化为 `base`）。
- `config.tools`（`{ include, exclude }` 意图覆盖）是工具级单一来源；旧 `string[]`/`disabledTools` 为兼容输入，保存时迁移。

## 与其他插件的关系
- 依赖（package.json `@agentchat/*`）：`agent-loop`、`agents`、`llm`、`router`、`cordis`、`edit`、`toolkit`、`timer`、`subagent`、`agent-config`、`fs`。
- 使用方：`fs`/`shell`/`web` 等工具域插件注入 `tools` 后调用 `registerFactory`；装配层/UI 经 `listCatalog`/`listByOwner` 生成插件目录。
- 兼容出口：`index.ts` re-export `@agentchat/toolkit`（`NS_*`、`defineTool`、`ConfigField`、shared 函数等）。

## 测试
- `src/tools/tools/tests/service.test.ts`：注册/卸载、presets 过滤、requires 解析（含旧 agent→base 兼容）。
- `src/boot/boot/tests/tool-requires-inventory.test.ts`：内置工具 requires 能力盘点（受控词汇表 + 快照）。
- 其余：`hashline-dsl.test.ts`、`edit-write-snapshot.test.ts`、`edit-snapshot-line.test.ts`、`estimate-tokens.test.ts`、`lone-surrogate.test.ts`（经 toolkit re-export 覆盖 edit/文本工具行为）。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
