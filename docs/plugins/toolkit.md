# @agentchat/toolkit
> 包路径 `src/toolkit/toolkit` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
工具执行基础库（领域独立，可脱离 AgentChat 复用）。提供 `defineTool` 工厂（自动补全 `definition`）、配置表单 `ConfigField` 类型、命名空间常量、沙箱路径解析（`resolveSafePath` + 敏感文件黑名单）、token 估算与 UTF-16 安全截断。迁移自 `src/plugins/builtin/tools/{define-tool,schema,namespaces,shared}`，并承接会话文件路径（`chatSessionFile`/`groupSessionFile`）。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `define-tool.ts` | `defineTool` 工厂 + `DefineToolInput`，工具作者只写参数与 execute |
| `schema.ts` | 配置表单元数据类型 `ConfigField`（7 种字段） |
| `namespaces.ts` | 命名空间常量（`security` / `agent.*` / `tool.*`）+ `META_ARCHIVE_REVIEW` |
| `paths.ts` | 会话文件路径（1v1 / 群聊），消除 session-tools→tools 值环 |
| `shared.ts` | `workspaceRoot`、`resolveSafePath`、黑名单、token 估算/安全截断 |
| `index.ts` | 统一 re-export 全部模块 |

## 插件行
无插件行。本包是纯函数/类型库，不注册 ctx 服务；工具域包（fs/shell/web/edit）按需导入其函数。

## 提供的能力（核心 API）
| API | 签名/要点 |
| --- | --- |
| `defineTool(input)` | 见下 |
| `workspaceDir()` | `process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default'`（相对 cwd） |
| `workspaceRoot()` | `path.resolve(process.cwd(), workspaceDir())` |
| `getAllowedPaths(config)` | 读 `security.allowedPaths` 数组；非数组返回 `undefined` |
| `getDenyPatterns(config)` | 内置 DENY + `security.denyPaths` 追加 |
| `isDeniedPath(config, target)` | 黑名单判定（`**/` 文件名模式 / `~` 家目录 / 绝对路径前缀） |
| `resolveSafePath(config, p)` | 沙箱解析，越界或命中黑名单抛错 |
| `estimateTokens(text)` | CJK 0.6 / 其他 0.3，向上取整 |
| `sanitizeSurrogates(text)` | lone surrogate → U+FFFD |
| `safeTruncate(text, maxLen)` | 按 code unit 截断，不切断 surrogate pair |
| `safeClipByTokens(text, budget, keepTail)` | 按 token 预算截取头部/尾部，代理对完整，加 `…` 标记 |
| `chatSessionFile(a,b)` | `sessions/chat~<lo>~<hi>/messages.jsonl` |
| `groupSessionFile(gid)` | `sessions/group~<gid>/messages.jsonl` |

## 工具参考
无（工具定义工厂在此，具体工具在 fs/shell/web/edit 包）。

## 关键契约 / API
### defineTool
```ts
interface DefineToolInput {
  name: string; label: string; ns?: string; requires?: string[];
  description: string; parameters: Record<string, any>;
  execute: Tool['execute']; extractLabel?: (args) => string;
}
```
- 自动生成 `definition = { type:'function', function:{ name, description, parameters } }`。
- 返回 `Tool`：仅当 `ns`/`requires`/`extractLabel` 存在时才附加对应字段。
- `execute` 类型即 `Tool['execute']`，因此天然透传 `(args, stream, signal)`；`extractLabel` 供 UI 显示简短标签。

### resolveSafePath 沙箱规则
1. `root = workspaceRoot()`；白名单 `security.allowedPaths`（相对项基于 root 解析）。
2. `target = path.resolve(root, p)`；必须在 root 或某个白名单根内（`===` 或 `startsWith(r + path.sep)`），否则抛“路径越界（沙箱限制）”。
3. 再经 `isDeniedPath` 校验（DENY 优先于 allow），命中抛“路径被沙箱拒绝”。
4. 内置黑名单（不可覆盖）：`~/.agentchat`、`**/.env`、`**/*.pem`、`**/id_rsa*`、`**/*_rsa`、`**/.npmrc`、`**/.git-credentials`。

### 命名空间常量（namespaces.ts）
| 常量 | 值 | 用途 |
| --- | --- | --- |
| `NS_SECURITY` | `security` | 路径白名单/黑名单 |
| `NS_AGENT_MCP` | `agent.mcp` | MCP 发现注册 |
| `NS_AGENT_PROMPT` | `agent.prompt` | 提示词装配开关 |
| `NS_AGENT_MEMORY` | `agent.memory` | 记忆注入预算 |
| `NS_AGENT_SESSION` | `agent.session` | 会话上下文管理 |
| `NS_TOOL_BASH` | `tool.bash` | bash 命令管控 |
| `NS_TOOL_WEB_SEARCH` | `tool.web_search` | web_search 配置 |
| `META_ARCHIVE_REVIEW` | `archive-review` | 归档整理 run meta 键 |

> 注：源码中无 `NS_AGENT_SKILL`；Agent 领域常量仅上述四个 `agent.*`。

### ConfigField 表单 Schema 类型
`Meta`（`name`/`label`/`description?`/`showWhen?`）派生的 7 种判别联合：
`TextFieldMeta`(`text`)、`PasswordFieldMeta`(`password`)、`NumberFieldMeta`(`number`，`min`/`max`)、`RatioFieldMeta`(`ratio`，`step`/`display`)、`CheckboxFieldMeta`(`checkbox`)、`SelectFieldMeta`(`select`，`options[]`)、`FileFieldMeta`(`file`，`accept`)。

## 配置
- `security.allowedPaths`：额外路径白名单（相对项基于 workspaceRoot 解析）。
- `security.denyPaths`：追加黑名单（内置 DENY 不可覆盖）。
- 环境变量 `AGENTCHAT_WORKSPACE` 覆盖工作区目录（默认 `workspace/default`，相对 cwd 解析）。
- `tool.bash`、`tool.web_search` 等命名空间由本包定义常量，具体读取在对应工具包。

## 与其他插件的关系
- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/agents`、`@agentchat/agent-config`。
- 使用方：`@agentchat/tools`（兼容 re-export）、`@agentchat/edit`（`resolveSafePath`/`defineTool`）、`@agentchat/fs`、`@agentchat/shell`、`@agentchat/web`。

## 测试
package.json 仅 `typecheck`（tsc --noEmit）。存在 `src/toolkit/toolkit/tests/define-tool.test.ts`（工厂补全 definition 测试）。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
