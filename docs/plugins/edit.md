# @agentchat/edit
> 包路径 `src/edit/edit` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
文本编辑引擎（领域独立，可脱离 AgentChat 复用）。核心是 Hashline v2 内容哈希定位协议 + 统一编辑管线 `applyEditBatch`：读文件 → 归一化 → TAG/行哈希校验 → 应用 → diff → 写回 → 同步快照。`makeEditTool` 同时支持 Hashline DSL、JSON edits（oldText 模糊匹配 / op+pos 行级定位）、顶层 `filePath + old_string/new_string` 旧格式。迁移自 `src/plugins/builtin/tools/edit`。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `tool.ts` | `makeEditTool` 工具定义 + 参数归一化（DSL/JSON/旧格式 → 统一模型） |
| `hashline.ts` | 行哈希 `hashLine` / 文件 TAG `computeFileHash` / `[PATH#TAG]` 头解析 |
| `hashline-parser.ts` | Hashline DSL patch 解析器（SWAP/INS.* + body 收集，错误显式报错） |
| `hashline-executor.ts` | DSL 薄适配器：op → `LineEdit[]` → `applyEditBatch` |
| `executor.ts` | **统一执行管线** `applyEditBatch` + 可插拔 I/O `EditOperations` |
| `hashline-snapshot.ts` | read/write/edit 间文件快照（TAG 校验、更新、清除） |
| `apply.ts` | `applyLineEdits`（行级，从后往前）+ `applyEditsToNormalizedContent`（oldText） |
| `diff.ts` | `generateIncrementalDiff`（O(edits×context)）+ `generateDiffString`（LCS 兜底） |
| `fuzzy-match.ts` | oldText 三级模糊匹配（精确 / trimEnd / trim）+ 出现次数统计 |
| `file-mutation-queue.ts` | 同文件写操作 Promise 链串行化（realpath 解析锁键） |
| `line-ending.ts` | BOM/行尾检测、LF 归一化、混合换行按行保留 |
| `types.ts` | `ReplaceEdit` / `LineEdit` / `HashPos` / `EditPosition` / `HashUpdateInfo` |
| `edit-diff.ts` / `index.ts` | barrel：旧入口兼容 re-export / 统一出口 |

## 插件行
无插件行。本包是库，只导出 `makeEditTool(config)` 等 API；装配由 `@agentchat/fs` 完成（`makeFileTools` 已包含 `makeEditTool`），调用方也可显式 `tools.registerFactory(owner, (config) => [makeEditTool(config)])`。

## 提供的能力（核心 API）
| API | 说明 |
| --- | --- |
| `makeEditTool(config)` | per-Agent 烘焙 edit 工具 |
| `applyEditBatch(config, filePath, batch, ops?)` | 统一编辑管线，见下 |
| `executeHashlineDSL(config, input, stream)` | 解析 DSL 并逐节走统一管线 |
| `parseHashlinePatch(input)` | DSL → `HashlineSection[]`（`path`/`tag`/`ops`） |
| `hashLine` / `computeFileHash` / `formatHashlineHeader` / `parseHashlineHeader` | v1 行哈希 / v2 文件 TAG / 头部格式化与解析 |
| `recordSnapshot` / `verifySnapshot` / `verifySnapshotDetailed` / `getSnapshot` / `updateSnapshot` / `clearSnapshot` | 快照存取与校验 |
| `applyLineEdits` / `applyEditsToNormalizedContent` | 行级 / 文本级编辑应用 |
| `generateIncrementalDiff` / `generateDiffString` | 增量 / 全量 unified diff |
| `fuzzyFindText` / `normalizeForFuzzyMatch` / `countOccurrences` | 模糊匹配 |
| `withFileMutationQueue(filePath, fn)` | 同文件写串行化 |
| `normalizeToLF` / `stripBom` / `detectLineEnding` / `restoreLineEndingsPreserving` | 行尾处理 |

## 工具参考
| 工具 | name | label | requires | ns | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 编辑 | `edit` | 编辑文件 | `['agent']` | `tool.edit` | `input`（DSL 字符串）；`edits[]`（每项 `filePath`+`newText` 必填，`oldText`/`op`/`pos`/`end` 可选）；顶层 `filePath`+`old_string`/`new_string` | `input` 非空走 DSL；否则 `normalizeEditArguments` 归一化后逐文件走 `applyEditBatch`；返回 `status: success/error` + `data`（单文件扁平，多文件 `files[]`）；含 `diff`、`edits_applied`、`fuzzy_matches`、`updated_hashes`、`file_tag`、`first_changed_line` |

### JSON edits 语义（tool.ts）
| 形态 | 说明 |
| --- | --- |
| `op: 'replace'`（默认） | 有 `pos`+`end` → 范围行替换；仅 `pos` → 单行替换；仅 `lineHash`（纯哈希）→ 管线解析行号 |
| `op: 'append'` | 有 `pos` → 锚点行后插入（`insert-after`）；无 `pos` → 文件末尾插入 |
| `op: 'prepend'` | 有 `pos` → 锚点行前插入（`insert-before`）；无 `pos` → 文件开头插入 |
| `oldText/newText` | 文本匹配（最后执行），`oldText` 必须唯一；支持三级模糊匹配 |
| 顶层旧格式 | `filePath + oldString/newString`（或 `old_string/new_string`）等价 `edits[0].{oldText,newText}` |

### Hashline v2 DSL（parser）
| 元素 | 语法/语义 |
| --- | --- |
| 文件头 | `[PATH#TAG]` 或 `[PATH]`；TAG 来自 read/write 输出（4 位 hex） |
| SWAP | `SWAP N.=M:` 替换第 N~M 行；body 为空 = 删除该范围 |
| INS.PRE | `INS.PRE N:` 第 N 行前插入 |
| INS.POST | `INS.POST N:` 第 N 行后插入 |
| INS.HEAD / INS.TAIL | 文件开头插入 / 末尾追加 |
| body | 每行以 `+` 开头（`+` 后为实际内容） |
| 容错 | 跳过 `*** Begin/End Patch` 与空行；无法识别的 op、CUT/PASTE、INS 缺 body 均显式报错 |

## 关键契约 / API
### 统一管线 `applyEditBatch` 步骤
1. `resolveSafePath` 沙箱解析 → `withFileMutationQueue` 串行化同文件写。
2. `access` 校验存在（不存在提示用 write）→ 读 Buffer → `stripBom` → `detectLineEnding` → `normalizeToLF`。
3. DSL 传入 `tag` 时做文件级 `verifySnapshotDetailed` 校验（失败诊断：`no-snapshot` / `snapshot-mismatch` / `disk-changed`）。
4. `resolvePositions`：清理行尾 `\r`；裸行号（hash 空串）从 read 快照取期望哈希；`lineHashOnly` 从文件内容哈希表解析行号。
5. `applyLineEdits`：行号/哈希基于原始文件校验，按影响位置**从后往前**应用；再执行 `applyEditsToNormalizedContent`（oldText 文本匹配）。
6. diff：纯行级或纯文本用增量 diff；混合/无位置时用全量 LCS 兜底。
7. 写回：`mixed` 行尾文件走 `restoreLineEndingsPreserving`（按行保留原始行尾，新行用主导行尾）；非混合按原风格恢复。
8. `updateSnapshot` 同步新 TAG；返回 `{ diff, firstChangedLine, fuzzyMatches, updatedHashInfo, fileTag }`。

### 行定位与校验
- `pos` 接受 `行号#哈希`（如 `11#a1b2`）、裸行号（如 `20`，执行时用 read 快照解析哈希）、纯哈希（旧 `lineHash`，须含字母 a-f）。
- 行哈希冲突/越界/快照缺失均抛错并提示重新 read。
- `LineEdit` 模型：`kind: replace | insert-before | insert-after | insert-start | insert-end`，`hashes: {start,end,anchor}`，`lineHashOnly?`。

### 并发与安全
- `file-mutation-queue`：`fs.realpathSync.native` 作为锁键（文件不存在回退绝对路径），Promise 链串行化同文件写，自动清理。
- 快照为进程内 `Map`（重启清空，无持久化）；lone surrogate 清洗由 `@agentchat/toolkit`（`sanitizeSurrogates`/`safeTruncate`）提供，edit 管线不重复处理。

## 配置
- 工具 ns：`tool.edit`（当前源码未读该命名空间做参数配置，仅用于工具定义与配置索引）。
- 路径沙箱复用 `@agentchat/toolkit` 的 `security.allowedPaths` / `security.denyPaths`。

## 与其他插件的关系
- 依赖（package.json）：`@agentchat/toolkit`、`@agentchat/agent-config`。
- 使用方：`@agentchat/fs` re-export `makeEditTool` 并纳入 `makeFileTools`（read/write/edit 随 `agentchat-fs-tools` 插件行注册）；`@agentchat/tools` 的测试直接 import `makeEditTool`。

## 测试
package.json 含 `test`（vitest run），但本包内无独立测试文件；相关测试位于 `@agentchat/tools/tests`：`hashline-dsl.test.ts`、`edit-write-snapshot.test.ts`、`edit-snapshot-line.test.ts`。`@agentchat/fs/tests/tools.test.ts` 回归验证 edit 已随 fs 工具族注册。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
