# @agentchat/hooks
> 包路径 `src/core/hooks` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
钩子注册中心包（由 `@agentchat/ext` 更名）：提供 cordis 服务 `ctx.hooks`（`HooksService`），以“有名映射 + owner 归属 + 顺序表驱动”的方式把插件注册的钩子工厂解析为 L1 `CurrentContext` 的七类钩子数组。builtin 钩子实现已按扩展域拆分为独立行注册（agent-prompt/agent-skill/agent-session/agent-memory/agent-mcp/security），本包插件行只内联一个轻量工具日志钩子。

## 目录
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | 服务插件行：`ctx.hooks = HooksService`，内联注册 `hooks.log-tool` |
| `service.ts` | `HooksService`：`register/unregister/collect` 及目录查询 |
| `contracts.ts` | `PluginHooks`（钩子名 → 实现的有名映射）与钩子类型 re-export |
| `hooks/index.ts` | `BUILTIN_HOOK_CATALOG`：前端“可用钩子”列表数据源 |

## 插件行
| 模块文件 | 插件 name | inject | 提供的 ctx 服务 / 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-hooks` | —（无依赖） | `ctx.hooks = HooksService`；注册 `toolExecutionEnd` 内联钩子 `hooks.log-tool`（owner=`agentchat-hooks`） |

## 提供的能力
### ctx.hooks（HooksService）
| 成员 | 语义 |
| --- | --- |
| `register(kind, name, factory, owner?, automatic?)` | 注册钩子工厂；同名后注册者覆盖；owner = cordis 插件名（preset id）；`automatic` = 基础设施钩子，不受 `config.hooks` 清单控制（仍受 owner preset 过滤） |
| `unregister(owner)` | 按 owner 精确卸载全部注册（动态插件 dispose/更新），返回移除条数 |
| `collect(config, services)` | 按 `config.hooks` 启用清单解析为 L1 钩子数组，并追加 automatic 基础设施钩子（见下；旧 `(names, config, services)` 调用兼容） |
| `find(kind, name)` | 查询注册条目（UI 归属展示） |
| `listNames(kind)` / `listOwners()` / `listCatalog()` / `listByOwner(owner)` | 钩子目录/诊断查询；`listCatalog()` 按注册顺序返回并携带 `order` 与 `automatic`（UI 徽章/禁 toggle 依据） |

### collect 解析语义
1. `config.hooks` 缺省 → 旧 `plugins` 聚合回退（否则无钩子）。
2. 逐 kind 遍历 `config.hooks[kind]` **启用清单**，**数组顺序即执行顺序；不在清单里 = 停用**。
3. 每个名字先 `normalizeHookName`（`builtin.*` 旧别名归一化）。
4. 未注册名字跳过（允许先配置、后安装插件）。
5. owner 过滤：无主注册始终启用；`config.presets` 未声明（旧契约兼容）不过滤；否则 owner 必须在 presets 内。
6. `factory(config, services)` 返回非 null 才推入；最终按 `HOOK_FIELD` 写入 `CurrentContext` 钩子数组字段。
7. **automatic 钩子**：不要求出现在启用清单，追加在显式钩子之后；同名已在清单中时去重；owner preset 未启用时同样跳过。

### 七类钩子 → CurrentContext 字段映射
| HookKind | CurrentContext 字段 | L1 事件对齐 |
| --- | --- | --- |
| `runStart` | `runStartHook` | `chat.start` |
| `runEnd` | `runEndHook` | `chat.end` |
| `stepStart` | `stepStartHook` | `chat.step.start` |
| `stepEnd` | `stepEndHook` | `chat.step.end` |
| `toolExecutionStart` | `toolExecutionStartHook` | `chat.tool_execution.start` |
| `toolExecutionEnd` | `toolExecutionEndHook` | `chat.tool_execution.end` |
| `fallback` | `fallbackHook` | 失败路径兜底 |

## 关键契约 / API
```ts
export type HookKind = keyof HookNames;   // 上述 7 类
export type HookFactory = (config: AgentConfig, services: ToolContext) => unknown;
export interface HookEntry { factory: HookFactory; owner?: string; }
export type ResolvedHooks = Partial<Pick<CurrentContext,
  | 'runStartHook' | 'runEndHook' | 'stepStartHook' | 'stepEndHook'
  | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'>>;

// contracts.ts：插件钩子实现的有名映射（按名引用）
export interface PluginHooks {
  runStart?: Record<string, RunStartHook>;
  runEnd?: Record<string, RunEndHook>;
  stepStart?: Record<string, StepStartHook>;
  stepEnd?: Record<string, StepEndHook>;
  toolExecutionStart?: Record<string, ToolExecutionStartHook>;
  toolExecutionEnd?: Record<string, ToolExecutionEndHook>;
  fallback?: Record<string, FallbackHook>;
}
```
- 内置内联钩子：`hooks.log-tool`（`toolExecutionEnd`）——日志记录工具名/耗时/异常。
- `BUILTIN_HOOK_CATALOG`（15 条，前端可用钩子列表）：`agent-mcp.open-mcp`、`agent-skill.discovered_skills`、`agent-prompt.build-system-prompt`、`agent-memory.load-memory`、`agent-session.load-history`、`agent-session.recover-history`、`security.security-check`、`agent-session.tool-persist`、`hooks.log-tool`、`agent-session.step-persist`、`agent-session.save-session`、`agent-memory.update-memory`、`agent-session.idle-reset`、`agent-session.archive-session`、`agent-session.log-usage`；元数据含 `kind/label/description/configNs?/security?`，automatic 由注册条目透出并在前端显示徽章。

## 配置
- `config.hooks`（`HookNames`）为钩子**启用清单**：数组顺序即执行顺序，停用 = 从清单移除。
- `config.presets` 决定 owner 过滤；缺省 = 旧契约兼容（不按 owner 过滤）。
- 旧 `disabledHooks` 为兼容输入：读入时从清单剔除，写盘时删除。
- 旧 `plugins` 声明中的 `builtin.*` 钩子名由 `normalizeHookName` 归一化。

## 与其他插件的关系
- 工作区依赖：`@agentchat/agent-loop`（钩子类型）、`@agentchat/tools`（`ToolContext`）、`@agentchat/cordis`、`@agentchat/agent-config`（`normalizeHookName`/`AgentConfig`）。
- 典型使用方：`@agentchat/agents`（`AgentAssembly.resolveHooks` 调用 `collect`）、各扩展域插件行（agent-prompt/agent-session/agent-memory/agent-mcp/security/agent-skill 注册钩子）、UI 钩子目录。

## 测试
- `tests/service.test.ts`：collect 顺序表驱动 / presets 过滤 / 未注册名跳过、presets 缺省旧契约兼容、`unregister(owner)` 精确回收、`find` 归属查询。

## 相关文档
[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
