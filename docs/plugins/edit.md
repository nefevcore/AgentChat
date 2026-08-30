# @agentchat/edit
> 包路径 `src/edit/edit` · 版本 0.1.0 · 文档对应 2026-08-20 简化后形态

## 概述
文本编辑引擎（领域独立，可脱离 AgentChat 复用）。`edit` 工具收敛为 **`file_path + old_string/new_string` 单一文本匹配形态**：读文件 → 归一化 → 三级模糊匹配（唯一性校验）→ 增量 diff → 写回（行尾保留）。

> 2026-08-20 简化（基于 5035 次真实调用统计，见 CHANGELOG）：
> - 移除 **Hashline DSL**（`input` patch 语言、`[PATH#TAG]` 头、TAG 校验）——7.4% 用量 / 62% 成功率，协议摩擦大
> - 移除 **行级定位**（`op`/`pos`/`end`、行哈希验证、read 快照解析）
> - 移除 **`edits[]` 批量**——LLM 原生并行 tool_call 等价（83% 调用本就是单条目）
> - 移除 **快照机制**（`recordSnapshot` 等，无消费方后整链删除）
> - 保留：三级模糊匹配、唯一性校验、重叠检测、增量 diff、混合行尾按行保留、`withFileMutationQueue` 同文件并发串行化
> - 兼容：顶层 camelCase 入参（`filePath`/`oldText`/`newText`）在读取层兜底；DSL/edits/pos 传入时返回明确迁移引导错误

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| tool.ts | `makeEditTool`：三参数 schema + 执行（含旧形态迁移引导） |
| executor.ts | 统一管线 `applyEditBatch`：读 → 归一化 → 文本替换 → diff → 写回 |
| apply.ts | `applyEditsToNormalizedContent`：三级模糊匹配 + 唯一性 + 重叠检测 + 从后往前替换 |
| fuzzy-match.ts | 模糊匹配（精确 / trimEnd+NFKC / trim+NFKC）+ 出现次数统计 |
| diff.ts | 增量 diff / 全量 LCS 兜底 |
| line-ending.ts | BOM 剥离 / CRLF 检测 / LF 归一化 / 行尾恢复（混合换行按行保留） |
| file-mutation-queue.ts | 同文件写串行化（realpath 锁键） |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| 编辑 | `edit` | 编辑文件 | `['base']` | `file_path`（必填）、`old_string`（必填，须唯一）、`new_string`（必填，空 = 删除） | `resolveSafePath` → `applyEditBatch`：三级模糊匹配（引号/空白归一化）+ 唯一性校验 + 增量 diff + 行尾保留；多处修改由 Agent 并行发多个 edit 调用承担 |

返回：`{status, data:{path, file, edits_applied, fuzzy_matches, first_changed_line, diff}}`。

## 关键契约 / API
```ts
makeEditTool(config: AgentConfig): Tool
applyEditBatch(config, filePath, { textEdits: ReplaceEdit[] }, ops?): Promise<EditBatchResult>
applyEditsToNormalizedContent(normalized, edits, filePath): AppliedEditsResult
```
- `ReplaceEdit = { oldText, newText }`；执行器内单元素列表（一次调用一处替换）。
- 旧形态迁移引导：`input`（DSL）/ `edits[]` / `op`/`pos`/`end` 传入时返回 `{status:'error', message:'…已移除，请改用 old_string/new_string…'}`，不抛异常。
- 并发与安全：`file-mutation-queue` 按 `realpath` 锁键串行化同文件写；路径走 `resolveSafePath`（工作区 + `security.allowedPaths` 白名单 + 敏感黑名单）。
- fuzzy 三级：0 精确 → 1 NFKC+trimEnd（smart quotes/全角空格）→ 2 NFKC+trim（缩进差异）。

## 配置
- 无自有命名空间；路径沙箱复用 `@agentchat/toolkit` 的 `security.allowedPaths` / `security.denyPaths`。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-config`、`@agentchat/toolkit`、`@agentchat/cordis`。

使用方：`@agentchat/fs` 的 `makeFileTools` re-export `makeEditTool`（随 `agentchat-fs-tools` 行注册）；`@agentchat/str-replace-editor` 不再依赖本包（快照机制移除后无引用）。

## 测试
`@agentchat/tools/tests/edit-simple.test.ts`（13 例）：正典三参数替换 / 多行块 / 空串删除 / 唯一性与未找到报错 / 模糊匹配 / camelCase 兜底 / CRLF 保留 / 旧形态迁移引导 ×3 / write→edit 衔接 / read 无 TAG 头。`@agentchat/edit/tests/fuzzy-newline-offset.test.ts`（5 例）覆盖模糊匹配偏移映射。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [fs 工具族](./fs.md) · [工具开发](../tool-dev-guide.md)
