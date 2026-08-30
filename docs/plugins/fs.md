# @agentchat/fs
> 包路径 `src/fs/fs` · 版本 0.1.0 · 文档对应 2026-08-20 简化后形态

## 概述
文件工具包（read/write/edit），领域独立。`read` 输出目录 JSON 列表或带行号的文件内容（`行号:内容`，edit 的 old_string 可直接复制）；`write` 覆盖写文件、自动建父目录；`edit` 由 `@agentchat/edit` 提供（old_string/new_string 文本匹配），随 `makeFileTools` 一并注册。路径一律经 `@agentchat/toolkit` 的 `resolveSafePath` 沙箱校验。

> 2026-08-20 简化：read 移除 `[PATH#TAG]` 头、`line_hash` 参数与 `file_tag` 返回；read/write 不再记录 hashline 快照（edit 文本匹配化后无消费方）。

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
| 读取 | `read` | 读取文件 | `['agent']` | — | `file_path`（必填）、`offset`（1 基，默认 1）、`limit`（默认 2000，最大 5000） | `resolveSafePath` 后 stat：目录 → JSON `{path,type:'directory',items:[{name,type}],count}`（目录在前、按名排序）；文件 → 读 UTF-8，分段输出全局行号的 `行号:内容`，超限返回 `truncated`+`next_offset`；返回 `{path,content,size,total_lines}` |
| 写入 | `write` | 写入文件 | `['agent']` | — | `file_path`（必填）、`content`（必填） | `resolveSafePath` → `mkdirSync(recursive)` → `writeFileSync` 整体覆盖；返回 `{status:'ok',data:{message}}` |
| 编辑 | `edit` | 编辑文件 | `['agent']` | — | `file_path`+`old_string`+`new_string`（均必填） | 详见 [edit.md](edit.md)：文本匹配（三级模糊归一化 + 唯一性校验）走 `applyEditBatch`，返回 diff、`edits_applied`、`fuzzy_matches` 等 |

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
| 文件 | `{status:'success', data:{path, content, size, total_lines}}` |

文件 `content` 格式：
```
1:<line1>
2:<line2>
```
- `行号:内容` 格式，edit 的 old_string 可直接从输出复制。

### write 行为
- `resolveSafePath(config, p)` → `fs.mkdirSync(path.dirname(file), {recursive:true})` → `fs.writeFileSync(file, content, 'utf-8')` **整体覆盖**。
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

## 与其他插件的关系
- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`、`@agentchat/edit`、`@agentchat/agent-config`。
- 使用方：boot/host 装配层把 `agentchat-fs-tools` 加入 presets/目录；`@agentchat/tools` 的 service 测试以本插件名作为 preset 过滤样例。
- 与 `@agentchat/tools` 存在 package.json 相互依赖（tools 依赖 fs；fs 依赖 tools 的 `ToolsService` 类型）。

## 测试
`src/fs/fs/tests/tools.test.ts`：回归验证 `makeFileTools` 返回 read/write/edit 且三者均携带 `requires: ['base']`。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
