# 会话压缩与概要 V2（compaction-v2 redesign）

> 性质：域深设计（现行压缩机制的重新评估与 V2 设计——取代 cr-974 §2.3 压缩三态的演进稿，实施后并入 session-design.md §3.4）。
> 状态：已实施（B1-B5 落地）；驱动面与提交面已被 [compaction-v3-injection.md](compaction-v3-injection.md) 取代（P1/P2/P4 骨架仍现行） · cr-1160 2026-11-20 · 承接 cr-974（事件日志 v2）/ cr-1155（僵尸行）/ cr-1156（边界时刻维度）；结论已并入 session-design.md §3.4。
> 读者：动 ac-ledger 压缩面 / ac-shell-rows archive 行 / 回放投影 / session-index 的人。

---

## 0. 结论速查

现行压缩机制是 v1 双文件时代的移植：**逻辑压缩**（compaction 事件 + 边界过滤）与**物理回收**（compact 重写主日志）两步耦合在「归档时机」一并发生，以 seq 为唯一边界坐标。这在 v2 单文件事件日志 + 折叠投影 + session-index 的现行架构下产生六处结构性冲突（§1.3）。V2 方案四条支柱：

| # | 支柱 | 一句话 |
|---|---|---|
| P1 | 逻辑与物理分离 | 压缩 = 落一条 compaction 事件（秒级、纯追加、不重写文件）；物理回收 = 独立低频时机搬运 shadowed 行到归档段（唯一重写点，仍受 S5 白名单约束） |
| P2 | 双维边界 | 边界 = (boundarySeq, endTs) 二元组：seq 位置维 + 压缩事件时刻维（cr-1156 已实施半步，V2 定为协议），无 seq 存量行按时刻维与文件位置维裁决 |
| P3 | 概要提交协议 | 摘要以「此前，」开头 + 字数上限 + 元文本黑名单为提交形态校验；回退文本（review 终稿）非此形态即降级为「概要未更新」而非注入元文本 |
| P4 | session-index 首席数据源 | 指针索引含压缩代（generation）列；占用/阈值/仪表口径从索引读边界与活跃代合计，不再全文件扫 |

## 1. 背景与重新评估

### 1.1 现行机制全景（cr-974 §2.3 压缩三态）

```
阈值检测（run 收束）→ 整理 run（reviewRun，Agent 亲写 summary）
  → compactionFor：落 compaction/start·summary·end + run-end 四事件（语义边界先 durable）
  → archiveAndRebuild：splitForArchive 分割（enriched 行 + 尾部水位）
      → compactFor：archive 段落 history_N.jsonl(.gz) + anchor → messages.jsonl tmp+rename 重写（keep 尾部）
回放：foldLlmReplay 按 boundarySeq 过滤 shadowed 前缀 + compaction/summary 摘要置首
仪表：face-ops session/tokens 全量盘读估算（不看边界）
```

### 1.2 实测病灶（news~user 会话，2026-11-19 诊断）

| 口径 | token | 说明 |
|---|---|---|
| 仪表分子（session/tokens 全量盘读） | ~328K（33%） | 不过滤边界 + 113 条 v1 僵尸行 ~78K |
| 压缩前同口径 | ~528K（53%） | 与用户观感一致——同一套虚高口径 |
| LLM 真实注入（run-end usage.prompt） | 144K（14%） | 三口径互不相干 |

### 1.3 为什么「过时」——六处结构性冲突

| # | 冲突 | 现行实现 | 后果 |
|---|---|---|---|
| C1 | 摘要与边界捆绑重写 | compactionFor（语义边界）与 compactFor（物理重写）在 archiveAndRebuild 内先后调用，物理回收永不缺席 | 摘要滚动本可秒级纯追加（零重写、零锁），却被拖进分钟级整理 run + 全文件重写的重流程；压缩不可高频化 |
| C2 | seq 单维边界 | boundarySeq 是唯一坐标 | 无 seq 的 v1 行绕过过滤（恒放行）→ 僵尸行（cr-1155 根因）；compaction 重写后 seq 空间倒挂（cr-1156 打补丁加时刻维）——单维坐标先天不完备 |
| C2b | 多轮压缩边界遗忘 | foldSummaryOf 只保留最新一次 compaction 事实 | 压缩 N 次后，第 1..N-1 次的边界丢失——若物理回收未及时跟上（C1 耦合导致），旧 shadowed 行仅靠最新边界的时刻维兜底，判定面脆弱 |
| C3 | 概要提交协议缺失 | 整理 run 终稿原样充当回退摘要注入 LLM | news 实测三次摘要均为「整理完成。概要：…」元文本，不是会话概要——LLM 上下文里是一段自我汇报，信息量为零且污染前缀 |
| C4 | session-index 零参与 | 指针索引三表（records/journal_lines/subcalls）无 compaction 维度 | 占用/阈值/仪表全部全文件扫描估算；compact 重写后 index 靠 size 倒退触发全量重建（最重的路径）；折叠投影每次全量 fold |
| C4b | 归档段对索引不可见 | history_N.jsonl(.gz) 不入索引 | 跨压缩边界的历史检索/回查需要独立解压路径，与「索引是定位唯一面」的定位矛盾 |
| C5 | 读面三口径 | LLM 注入（fold 过滤）≠ 仪表（全量盘读）≠ 归档阈值（enriched 全量） | 33%/53%/14% 三个数字互不相干；阈值误判会触发无意义整理 run（花钱）或漏压 |
| C6 | enriched 双轨计量 | splitForArchive 在 enriched 行（原行 + v2 折叠伪段行拼接数组）上计量 | 与 fold 投影分轨维护；cr-1155 改引用对齐已是打补丁形态 |

### 1.4 为什么「不好兼容 session index」

session-index 的增量协议（files 表 size/mtimeMs/consumed 对账）假设**单调追加**。现行压缩的两步都会破坏它：

- compactFor 物理重写：size 变小 + mtime 前移 → 触发 DELETE + 整读重插（全量重建）——每次压缩都走最重路径，且重建期间读面无短路可用；
- 更深一层：索引行的 byte_offset 在重写后全部失效，但 size 倒退检测只能发现「变了」，无法区分「重写」与「损坏」；
- compaction/summary 事件全文入 records 表——摘要作为一级行被索引、被 ts_num 聚合进活跃度统计（聚合面语义污染）。

## 2. V2 设计

### 2.0 设计不变量（继承并强化）

- S1 事件是真理：一切状态由事件日志派生；压缩是事件，不是文件操作。
- S5 显式 replace 白名单收窄：V2 下物理回收仍是唯一重写点（S5 不变），但频率与逻辑压缩解耦；summary.md 写面（v1 兼容窗）随 V2 实施**退役**（读兼容保留）。
- 索引纯缓存红线不变：索引只指真源，可全量重建；但「指」的词汇扩展到压缩代（§2.4）。

### 2.1 P1 逻辑压缩：单事件、纯追加

压缩的语义动作收敛为一条判别行：

```
单事件形态（type:compaction）:
  run / boundarySeq / endTs / summary / model / stats{shadowedRows,estimatedTokens} / seq / ts
```

| 设计点 | 裁决 |
|---|---|
| 单事件替代三事件族 | compaction/start·summary·end 三连拆自 v1 两阶段提交遗留（当时物理重写随时可能打断，需要 start/end 分隔）；V2 逻辑压缩是单队列切片原子追加，无需中间态。行级原子性由 append+fsync 保证——要么整行在，要么整行不在，不存在半压缩态 |
| boundarySeq 缺省自动 | 调用方不传时 = 落账时刻主日志尾部 maxSeq（语义同 cr-974，但由 writer 内联计算——调用方不再手工拼） |
| endTs 一等字段 | 即事件 ts——但显式命名，因为它是 P2 双维边界的时刻维坐标（cr-1156 的正式化） |
| stats | shadowedRows / estimatedTokens——审计/仪表直接读，不重扫 |
| model | 生成摘要的模型（审计面：摘要质量退化可追溯） |
| 兼容读 | fold 读侧遇 compaction/* 旧三连 → 照旧归并（存量会话零迁移）；遇 compaction 单事件 → 直接入 CompactionFacts。两代词汇并存于归一化层，不迁移数据 |

summary.md 写面退役：v2 会话概要唯一住事件（现行 archive.ts 已如此，仅补文档裁决）；v1 会话存量 summary.md 读兼容窗保留。

### 2.2 P2 双维边界：位置 + 时刻

回放过滤谓词（foldLlmReplay 的 bounded 过滤）V2 形态：

```
rowShadowed(row, boundary):
  posDim = row.seq 可判 ? (row.seq <= boundary.boundarySeq) : 不可判   // 位置维
  tsDim  = row.ts 可判 ? (row.ts <= boundary.endTs) : 不可判           // 时刻维（v1 role 行缺数字 ts 时不可判）
  裁决优先级：位置维可判则从位置；否则时刻维；
  两者皆不可判 → 文件位置维：该行在 compaction 事件行之前（同文件内前后关系恒可判）
```

| 设计点 | 裁决 |
|---|---|
| 位置维优先 | seq 是 writer 分配的稳定身份锚，最精确；endTs 作为第二维补 seq 缺席/倒挂场景（cr-1156 场景正式化） |
| **边界有效性（boundarySeq ≤ 0）** | 存量老 writer 曾显式写 `boundarySeq: 0`（admin~admin 现场 4 代全 0）。**≤ 0 视为无有效边界** → 回落该 end 行自身 seq（边界 = 事件落账位置，其后行必属新一代）。若按字面 0 判，`seq ≤ 0` 恒假 → 已压缩内容全被当活跃：壳侧阈值反复触发整理压缩（花钱不降账），宿主侧 activeContextTokens 恒 0（阈值永不触发）——两个方向的错都在此。`events-v2` 归并与索引 `boundaryOf` 同判，口径版本 v3 覆盖 |
| 兜底 = 文件位置 | 「同文件内该行在 compaction 事件行之前」——归一化读面天然按文件序遍历，位置关系零成本可判；这一维彻底消灭无 seq 僵尸行的绕过面（cr-1155 类问题在谓词层根治） |
| 多轮压缩 | 边界单调叠加：row 被**任一**已发生 compaction 边界 shadow 即滤除。fold 按文件序遍历，维护已见 compaction 事件集，逐行取判定（§2.2.1） |
| KV 声明 | 每轮逻辑压缩 = invalidate-from-boundary——前缀从边界处重建（摘要 system 头替换被压缩段）。与现行语义一致，仅声明形式化 |

#### 2.2.1 多轮边界算法（fold 归一化层）

```
fold 遍历域文件行序：
  compactions = []                          // 按文件序累积
  for row in rows:
    if row 是 compaction 事件（单事件或旧三连归并）:
      compactions.push(boundaryOf(row))     // boundarySeq/endTs 取该事件（旧三连取 end 行）
    if not compactions.some(b => rowShadowed(row, b)):
      emit(row)                             // speech/context/runs 事实照常累积

旧三连归并（读兼容）: start/summary/end 同 run 三行 = 一个边界（boundarySeq = end 行携带值，
  endTs = end 行 ts）；单遇 summary 无 end（崩溃残留）→ 不建边界（未完成压缩不影响回放；
  摘要已在但边界未定——回放取旧边界继续，下轮压缩重写）
```

### 2.3 P3 概要提交协议

```
commit 约定（整理 run 产出摘要的验收形态）:
  以「此前，」开头（继承 reviewPrompt 既有约定）
  && 全文 ≤ summaryTokenCap（缺省 4k token，estimateTokens 口径）
  && 首行不以元文本黑名单开头（整理完成 / 概要：/ markdown 标题）

提交链：亲写 summary 文件 → archive 行校验形态 → 合格才进 compaction 事件
  → 不合格：摘要不更新（保留上一轮概要），事件照落（边界照滤）——
    「无新概要的压缩」是合法状态：回放头 = 上一轮概要，可能过时但语义完整
```

| 设计点 | 裁决 |
|---|---|
| 黑名单首版词表 | 整理完成、概要：、markdown 标题（井号/粗体星号开头）——从 news 实测病灶归纳，首版保守；误杀面 = Agent 写了以这些词开头的真实概要（可接受，概率极低且只降级不丢数据） |
| 为什么不强制 LLM 结构化输出 | 整理 run 是普通 ReAct run，强结构化输出改 loop 面；形态校验是最小侵入 |
| 摘要驻留 | 摘要全文住 compaction 事件行（不落独立文件）——单一事实源，索引可直接读；超长摘要走 §2.4 索引材料列 |

### 2.4 P4 session-index 首席数据源

records 表增列 + 新 surface：

```
records 表增列: generation INTEGER   // 行所属压缩代（0 = 从未压缩期；N = 第 N 次 compaction 之后落账）
新表 tokens: conv, domain, generation, est_tokens   // 每代每域估算合计（增量维护）
新 surface（SessionIndexService）:
  compactionFactsOf(convId): 压缩代清单（boundarySeq/endTs/generation/摘要指针）
  activeContextTokens(convId, domain): 活跃代估算合计——阈值/仪表直读
```

| 设计点 | 裁决 |
|---|---|
| est_tokens 增量列 | 索引入账时逐行估算并累计——占用/阈值/仪表从索引直读，零盘读零 fold。**口径同源要点（实施期实证修正）**：`step/tool-call-result` 的 `subcall: true` 行不计（与 `replayTokensOf` 的 `if (tc.subcall === true) continue` 一致——run_code 程序内子调用不进回放注入，news~news 现场该口径差 2.7 倍）；估算语义由 `EST_TOKENS_VERSION` 标记，版本不符整库弃重建（纯缓存自愈，不迁数据）。索引仍是纯缓存：est_tokens 可由真源重算 |
| est_tokens 口径 | 与 ac-archive-core replayTokensOf 同源（viewer 视角轨迹展开）——按压缩代分桶：阈值检测读「最新活跃代合计」，不与 shadowed 行混合。**摘要头必须计入**（compactions 表 `summary_tokens` 列，入账时按摘要内容实算；取「最新可用摘要」——summaryOmitted 代跳过，与 foldSummaryOf 回落同判）：漏计会让压缩后只剩 run-end 行的会话仪表显示 0%，而回落路径 `estimateReplayTokens` 是含 summary 的，两路径必须同口径 |
| generation 概念 | 行的 generation 就是它的边界坐标：行 r 落账于第 j 与第 j+1 次 compaction 之间则 gen(r) = j。简化不变量：**compaction 事件自身与其后新落账的行恒属最新活跃代**。generation 由入账时已见 compaction 行数内联推导，无第二事实源 |
| 聚合白名单 | **compaction 事件族一律不进 records**（单事件 + 旧三连 start/summary/end 全族）——摘要/边界是机制产物不是会话活动，进了会污染 sessionMeta.total 与 ts_num 活跃度（实施期实证：admin~admin 4 轮旧三连曾污染聚合）。旧三连摘要长度经 summary→end 回填 compactions 表（per-file pending），供压缩历史展示面 |

### 2.5 物理回收（S5 白名单唯一重写点）

触发时机与现行不同——不再与逻辑压缩同拍：

| 维度 | 现行 | V2 |
|---|---|---|
| 触发 | 每次归档（逻辑+物理一体） | 独立低频：主日志行数或 shadowed 估算 token 超阈（如 shadowed tokens > keep 水位 × 2） |
| 操作 | archive 段 + anchor + tmp+rename 重写 | 机制不变（history_N.jsonl(.gz) + anchor + 原子重写 keep 面） |
| 索引联动 | 无（size 倒退被动全量重建） | 回收前先 index.drop(conv, domain)，回收后 lazy 重建——主动失效，重建窗口内读面回落全扫（索引纯缓存红线，行为等价） |
| 时机约束 | run 收束后异步 | 同现行（run 收束后异步；busy 会话 idle-exit 不收割） |

物理回收不改语义边界（compaction 事件永留主日志——现行已如此），只搬运 shadowed 行尸骸。v1 僵尸行存量出清（cr-1155 遗留）：物理回收首触 v1 会话时按位置出清——cr-1155 引用对齐机制已就位，V2 不改，验证用例锁定。

### 2.6 三口径收敛（C5 根修）

| 消费面 | 现行 | V2 |
|---|---|---|
| LLM 注入（foldLlmReplay） | 边界过滤（seq 单维 + cr-1156 时刻补丁） | §2.2 双维谓词（generation 从 fold 内联推导；索引为加速面非依赖） |
| 归档阈值（archive estimateOf，**壳进程**） | enriched 全量（含 shadowed + 僵尸） | `estimateOf(uuid, { activeOnly: true })`——壳内按压缩代过滤（`rowShadowedBy` 同源谓词）后回放口径估算。**不跨进程读 sessionIndex**（见下方架构注记） |
| 仪表（session/tokens，**宿主进程**） | 全量盘读估算 | `sessionIndex.activeContextTokens` 索引直读（行摘除回落 `replayTokensOf` 全量 fold 口径，行为降级但单源） |
| TokenGauge 前端 | 三档 displayTotal | 不动（口径在后端收敛后自动跟随） |

**架构注记（实施期实证修正）**：阈值/回收住在壳进程（`ac-shell-rows` archive 行，shell.yml），
session-index 住在宿主进程（host.yml）——壳侧 `ctx.get('sessionIndex')` 跨进程恒 undefined，
软取即死代码。故「索引直读」只适用于宿主侧消费面（仪表/压缩史 RPC）；壳侧改用同一谓词的
**壳内分代估算**（`rowShadowedBy` 由 ac-ledger 提供，两进程共享纯函数、不共享实例）——
同语义、各算各的，符合「能力间不传引用」红线。这条也解释了为什么「三口径收敛」不能靠
「都去读索引」实现，而要靠「同一判据 + 各自可用的数据面」。

### 2.7 生命周期总览

```
run 收束（loop/after-run）
  → 阈值检测：activeContextTokens < threshold ? return      // P4 索引直读
  → 整理 run（reviewRun——Agent 亲写摘要）
  → 概要校验（P3 形态校验）
  → compactionFor：落单条 compaction 事件（P1——boundarySeq 缺省自动 + endTs + summary + stats）
  → 索引 refresh（增量：compaction 行入账 + generation 推进 + tokens 分桶）
  → [物理回收条件满足?] → compactFor（§2.5 独立时机）→ index.drop + lazy 重建
回放：fold 双维谓词 + 最新概要置首
仪表：activeContextTokens / compactionFactsOf
```

### 2.8 压缩轮的回顾与分析面

需求形态：压缩轮（整理 run + 摘要 + 边界 + stats）可回溯、可对比、可问询。裁决：**补读面，不做压缩轮会话化**（否决理由见 §4 表与下文摘要）——回顾/分析是读面需求，数据已住原桶（compaction 事件 + 归档段），缺的是检索与展示面。

| 层 | 形态 | 数据源 |
|---|---|---|
| 数据面 | compactionFactsOf(convId, domain)：每代 boundarySeq / endTs / generation / stats / model / 摘要指针（对桶每域独立压缩史——键含 domain） | 索引（B2） |
| 展示面 | TokenGauge 弹层「压缩历史」区：每轮一行（时间 · 压缩前后估算 token · 摘要首行；点开摘要全文）——挂既有 session/tokens 面 | 索引 surface + 既有 RPC |
| 深查面 | 归档段回查（跨压缩边界检索，B2b 索引化）+ 压缩轮 run 轨迹只读视图（run 键取步事件——机制 run 三不只挡「进会话视图」，不挡显式查档） | 归档段 + 主日志步事件 |
| 问询面 | 即席分析会话 + compactionFactsOf 材料注入（context 行既有机制）——按需开，无常驻桶 | 注入机制 |

会话化否决摘要：① 摘要必须留原桶（回放注入取源）→ 会话化 = 双写或跨桶回放依赖（破桶自包含，规约 2 / S1 单一事实源）；② singles 生命周期错配——锁 Agent / 前缀快照 / 自动标题 / 自身也要被归档（递归压缩），全是死重量；③ singles 名册是用户面——压缩轮入册 = 污染列表，或造「隐藏会话类」（cr-1100 幻影会话教训的反面复刻）；④ 机制运行日志的既有归位是 a~a 自会话（Agent 想持续自审压缩是行为层选择，平台不内建）。

## 3. 与代码的映射点（实施批切分草案）

| 批 | 改动面包 | 内容 |
|---|---|---|
| B1 | ac-ledger | writer.compaction 单事件落账 + fold 归一化双词汇兼容读 + 双维谓词替换 bounded 过滤（含多轮边界算法与旧三连归并） |
| B2 | ac-session-index | records 增 generation 列 + tokens 表 + compactionFactsOf/activeContextTokens surface + compaction 事件行不进 ts_num 聚合（语义列白名单） |
| B2b | ac-session-index | 归档段入索引（history_N 指针面——offset/len/seq 指向归档段内，真源可回源） |
| B3 | ac-shell-rows archive 行 | 概要形态校验（P3）+ 阈值检测改活跃代口径（壳内分代估算——不跨进程读索引）+ 物理回收独立触发条件（与逻辑压缩解耦） |
| B3b | ac-shell-rows archive 行 | v1 僵尸行存量出清验证（cr-1155 遗留——机制已就位，验证用例锁定） |
| B4 | ac-host-webui face-ops | session/tokens 改索引直读（回退路径保留，载荷带压缩史）+ TokenGauge 弹层「压缩历史」区（§2.8 展示面）+ 已知前端问题另行处理（cr-1135 锚点面不动） |
| B5 | docs | session-design.md §3.4 改版并入本档结论 + 归档旧裁决叙事 |

## 4. 明确不做（裁决存档）

| 不做 | 理由 |
|---|---|
| 摘要分级/分层记忆 | 单层滚动概要已覆盖会话内连续性需求；分级记忆是 ac-memory 域职责，不与压缩耦合 |
| 压缩可逆化（快照回滚） | append-only 事实源 + 归档段 = 天然可回查（尸骸在 archive/history_N）；「可逆」的额外状态机不成比例 |
| summary.md 双写 | 单一事实源；v1 读兼容窗保留足矣 |
| compaction 事件拆多行（保留 start/end 两阶段） | 行级原子（append+fsync）已够；两阶段是 v1 物理重写随时打断时代的遗留 |
| 按字节区间做谓词 | 字节区间是索引实现细节；谓词用逻辑坐标（seq/ts/文件位置），可跨重写存活 |
| 压缩时清洗/改写行内容 | 行内容永不改写（append-only）；压缩只决定「谁进回放/谁进归档段」 |
| 压缩轮会话化（每轮/每桶一个 single 会话） | 回顾/分析是读面需求，数据已在原桶 + 归档段；会话化引入双事实源或跨桶回放依赖、singles 生命周期错配（含递归压缩）与名册污染——正确解是 §2.8 读面 |

## 5. 测试标准与验证目标

### 测试标准（过程门）

每批按改动面走验证阶梯：pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 lint；涉前端时 pnpm webui:typecheck && pnpm build:channel；契约/行集面 pnpm test 全量。

### 验证目标（目的态断言）

| # | 断言 | 判据 |
|---|---|---|
| V1 | 三口径收敛 | 同会话（压缩后）：session/tokens 返回 ≈ activeContextTokens ≈ 下一 run 实际 prompt（估算系数内，±20%）。**实证**：news~news 701,653 vs prompt 767,206（差 8.5% = system+tools）；news~user 活跃代 3,396 + 固定开销 ≈ 144,216 |
| V2 | 僵尸行免疫 | v1 无 seq 行 + compaction 在场 → 回放/索引/阈值一致判 shadowed（构造夹具：混合 v1/v2 行 + 压缩后落账新行） |
| V3 | 概要形态 | 整理 run 产出「整理完成…」终稿 → 摘要不更新、事件照落、回放头为上一轮概要 |
| V4 | 索引联动 | 逻辑压缩后 index refresh 增量（无全量重建）；物理回收后 drop+lazy 重建（读面无 stale） |
| V5 | 存量兼容 | v1 会话（summary.md + 旧三连）与 v2 会话（单事件）同机读出一致回放（fold.test 夹具双形态） |
| V6 | 物理解耦 | 逻辑压缩 N 次而物理回收 0 次的会话存在且读面正常（shadowed 留在主日志不炸） |
| V7 | 仪表观测 | 压缩前后仪表读数与 LLM prompt 同向变化（不再 33% vs 14% 脱节） |

## 6. 裁决链

| 日期 | 裁决 | 取代关系 |
|---|---|---|
| 2026-11-20 | V2 设计定稿（本文） | 承接 cr-974 §2.3 压缩三态（单事件化 + 双维边界 + 概要协议 + 索引一等公民）；cr-1155/cr-1156 分别根修 C2 僵尸行与时刻维——V2 是其正式化而非推翻 |