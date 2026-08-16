# @agentchat/fs
> 包路径 `src/fs/fs` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
文件工具包（read/write/edit），领域独立。`read` 输出目录 JSON 列表或 Hashline v2 文件内容（`[PATH#TAG]` 头 + `行号:内容`），并在读取时记录快照；`write` 覆盖写文件、自动建父目录、写后同步快照；`edit` 由 `@agentchat/edit` 提供（Hashline DSL + JSON edits + 旧格式），随 `makeFileTools` 一并注册。路径一律经 `@agentchat/toolkit` 的 `resolveSafePath` 沙箱校验。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`registerFsTools(ctx.tools, name)` |
| `register.ts` | `registerFsTools`：以 owner 注册 `makeFileTools` 工厂 |
| `tools.ts` | `makeReadTool` / `makeWriteTool` / `makeFileTools`；re-export `makeEditTool` |
| `index.ts` | re-export tools + register |

## 插件行
| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `src/fs/fs/src/plugin.ts` | `agentchat-fs-tools` | `['tools']` | `tools.registerFactory(owner, config => makeFileTools(config))` → **read + write + edit** |

## 提供的能力
| API | 说明 |
| --- | --- |
| `registerFsTools(tools, owner)` | 注册文件工具工厂（owner = cordis 插件 name，presets 过滤依据） |
| `makeReadTool(config)` | read 工具 |
| `makeWriteTool(config)` | write 工具 |
| `makeFileTools(config)` | `[makeReadTool(config), makeWriteTool(config), makeEditTool(config)]` |
| `makeEditTool`（re-export） | 见 `@agentchat/edit`；**已包含在 `makeFileTools` 数组中** |

## 工具参考
| 工具 | name | label | requires | ns | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 读取 | `read` | 读取文件 | `['agent']` | — | `path`（必填）、`lineHash`（bool，默认 true） | `resolveSafePath` 后 stat：目录 → JSON `{path,type:'directory',items:[{name,type}],count}`（目录在前、按名排序）；文件 → 读 UTF-8，`recordSnapshot(file, content)`，输出 `行号:内容`，`lineHash !== false` 时加 `[PATH#TAG]` 头；返回 `{path,content,size,total_lines,file_tag}` |
| 写入 | `write` | 写入文件 | `['agent']` | — | `path`（必填）、`content`（必填） | `resolveSafePath` → `mkdirSync(recursive)` → `writeFileSync` 整体覆盖；写后 `recordSnapshot` 同步快照（避免后续 edit 新 TAG 被误拒）；返回 `{status:'ok',data:{message}}` |
| 编辑 | `edit` | 编辑文件 | `['agent']` | `tool.edit` | `input`（DSL）或 `edits[]`（`filePath`+`newText` 必填）；旧格式 `filePath`+`old_string`/`new_string` | 详见 [edit.md](edit.md)：DSL / JSON edits 归一化后走 `applyEditBatch`，返回 diff、`edits_applied`、`file_tag` 等 |

## 关键契约 / API
```ts
registerFsTools(tools: ToolsService, owner: string): void   // tools.registerFactory(owner, (config) => makeFileTools(config))
makeReadTool(config: AgentConfig): Tool
makeWriteTool(config: AgentConfig): Tool
makeFileTools(config: AgentConfig): Tool[]                  // [read, write, edit]；edit = makeEditTool(config)
export { makeEditTool }                                    // 从 @agentchat/edit re-export，见“重要事实”
```

### read 返回结构
| 目标 | 返回 JSON |
| --- | --- |
| 目录 | `{status:'success', data:{path, type:'directory', items:[{name,type}], count}}`；目录在前、同类型按名排序 |
| 文件 | `{status:'success', data:{path, content, size, total_lines, file_tag}}` |

文件 `content` 格式（Hashline v2）：
```
[<path>#<file_tag>]
1:<line1>
2:<line2>
```
- `lineHash !== false`（默认 true）时输出 `[PATH#TAG]` 头；`lineHash:false` 仅输出 `行号:内容`。
- `file_tag` 始终返回：`computeFileHash(content)`（先归一化 `\r\n→\n`，取 SHA-256 前 4 位 hex）。
- 读取文件时立即 `recordSnapshot(file, content)`，供后续 edit 行号/TAG 校验。

### write 行为
- `resolveSafePath(config, p)` → `fs.mkdirSync(path.dirname(file), {recursive:true})` → `fs.writeFileSync(file, content, 'utf-8')` **整体覆盖**。
- 写后 `recordSnapshot(file, content)`：避免后续 edit 用新 TAG 被误拒（P0-2 回归修复）。
- 返回 `{status:'ok', data:{message:'已写入 <p>'}}`。

### 路径沙箱（resolveSafePath，来自 toolkit）
| 规则 | 说明 |
| --- | --- |
| 根 | `workspaceRoot()` = `path.resolve(cwd, AGENTCHAT_WORKSPACE ?? 'workspace/default')` |
| 白名单 | `security.allowedPaths`（相对项基于 workspaceRoot 解析） |
| 判定 | `path.resolve(root, p)` 必须等于/前缀匹配 root 或白名单根（`startsWith(r + path.sep)`） |
| 黑名单 | 内置 DENY（`~/.agentchat`、`**/.env`、`**/*.pem`、`**/id_rsa*` 等）+ `security.denyPaths`，DENY 优先于 allow |

### 重要事实：edit 随本行注册
`makeEditTool` 从 `@agentchat/edit` re-export，并已纳入 `makeFileTools` 返回值（2026-08-16 修复），因此启用 `agentchat-fs-tools` preset 即自动获得 read/write/edit 三个工具（`requires: ['base']` 命中隐式 `base` 基础能力层）。`src/boot/boot/src/loader.ts` 的 BUILTIN 目录描述 read/write/edit 与注册内容一致。

## 配置
- 无自有命名空间；沙箱配置在 `security.allowedPaths` / `security.denyPaths`（由 toolkit 读取）。
- `read` 的 `lineHash` 为工具参数而非配置项。

## 与其他插件的关系
- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`、`@agentchat/edit`、`@agentchat/agent-config`。
- 使用方：boot/host 装配层把 `agentchat-fs-tools` 加入 presets/目录；`@agentchat/tools` 的 service 测试以本插件名作为 preset 过滤样例。
- 与 `@agentchat/tools` 存在 package.json 相互依赖（tools 依赖 fs；fs 依赖 tools 的 `ToolsService` 类型）。

## 测试
`src/fs/fs/tests/tools.test.ts`：回归验证 `makeFileTools` 返回 read/write/edit 且三者均携带 `requires: ['base']`。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
