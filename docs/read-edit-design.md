# read & edit 工具设计来源与演进

## 关键设计者对话 — 2026/07/31

来源：与 VS Code Copilot Chat 的对话（`_tmp/about edit and read design.md`），讨论了 AgentChat 与 pi (Copilot Chat) 两种 edit 工具设计哲学的差异。

---

## Copilot Chat (pi) 的设计：文本优先

```
read_file(filePath, startLine, endLine)
  ↓ 返回带 lineHash 的文本
edit(oldString, newString)
  ↓ 精确文本匹配 → 失败则 hash 模糊定位
```

**核心哲学**：`oldString` 是主路径，hash 是兜底。认为 LLM 能生成准确的 `oldString` 片段，3-5 行上下文的文本匹配几乎总是唯一的。

| 优势 | 风险 |
|------|------|
| `oldString` 自包含，不依赖预先 read | 需要 LLM 准确引用原文 |
| 文本匹配对微小差异容错（格式化不改语义） | 大文件全文扫描 O(n) |
| hash 仅 fallback，不影响 99% 路径 | 无法脱离 oldString 单独工作 |

---

## AgentChat 的设计：Hash 优先

```
read(filePath, lineHash=true)
  ↓ 每行返回 hash 前缀 (a1b2c3d4|内容)
edit({edits: [{filePath, lineHash, newText}]})
  ↓ O(1) hash 定位 → 返回 updated_hashes → 下次编辑无需重新 read
```

**核心哲学**：hash 是主路径，`oldText` 是兼容 fallback。LLM 通过一次 read 拿到所有行的 hash，后续编辑用 hash 精确定位，无需再次 read。

**关键创新：`updated_hashes` 反馈循环**

```
第一次 edit → 返回 { updated_hashes: [{old_hash: "abc", new_hashes: ["def"]}] }
第二次 edit → 直接用 new_hashes 定位，无需重新 read
```

这让 Agent 可以在一个 ReAct 循环中连续编辑同一文件而不需要中间 read。

---

## 两种哲学的倒置对比

| 维度 | Copilot Chat (pi) | AgentChat |
|------|-------------------|-----------|
| **主路径** | oldString 文本匹配 | lineHash O(1) 定位 |
| **fallback** | hash 模糊定位 | oldText 文本匹配 |
| **read 角色** | 可选（oldString 自包含） | 必须（获取 hash） |
| **连续编辑** | 每次需重新 read | updated_hashes 自动传递 |
| **容错来源** | 文本模糊匹配（NFKC 归一化） | 模糊分三级 + hash 降级到 oldText |
| **性能特征** | O(n) 正常路径 | O(1) 正常路径 |
| **适用场景** | LLM 生成 oldString 可靠 | 确定性高、大量编辑、迭代开发 |

---

## AgentChat edit 工具完整架构

### 流水线 (11 步)

```
normalizeEditArguments  →  参数归一化（filePath 分组、hashEdits/oldTextEdits 分类）
      ↓
executeEditPipeline  →  单文件编辑流水线
      ↓
  1. resolveSafePath
  2. readFile
  3. stripBom
  4. detectLineEnding (CRLF/LF)
  5. normalizeToLF
  6. applyHashBasedEdits     ← O(1) hash 定位，先执行
  7. applyEditsToNormalizedContent ← oldText 匹配，在上一步结果上执行
  8. generateIncrementalDiff / generateDiffString
  9. restoreLineEndings
 10. writeFile
 11. 返回 { diff, firstChangedLine, fuzzyMatches, updated_hashes }
```

### 三级模糊匹配 (oldText fallback)

| Level | 策略 | 用途 |
|-------|------|------|
| 0 | 精确子串匹配 | 正常路径 |
| 1 | NFKC + trimEnd + 特殊字符归一化 | smart quotes、全角空格等 |
| 2 | NFKC + trim（去行首行尾空白） | 缩进差异 |

### 文件突变队列

`withFileMutationQueue` 保证同一文件的并发编辑串行化，防止竞态。

---

## read 工具设计

### 核心约束

- **双重截断**：行数上限 (2000) + 字节上限 (50KB)，先触发者生效
- **首行超限保护**：首行即超限时不截半行
- **续读提示**：截断后告知剩余行数/字节 + startLine 参数引导增量读取
- **目录支持**：传入目录路径时列出文件清单

### hash 机制

```
sha256(normalizedLine) → 前 8 位 hex
例：import * as fs from 'fs'  →  c80bf39c
```

行末 `\r` 剥离后再 hash，保证跨平台一致。

---

## 两种批量编辑 API

AgentChat 同时支持新旧两种 API，通过 `normalizeEditArguments` 自动识别：

| API | 格式 | 定位方式 |
|-----|------|----------|
| **v2 (推荐)** | `edit({edits: [{filePath, lineHash, newText}]})` | hash O(1) |
| **v1 (兼容)** | `edit({filePath, oldString, newString})` | 文本匹配 |

v2 中 `filePath` 已移入每个条目内部，支持一次调用编辑多个文件。
