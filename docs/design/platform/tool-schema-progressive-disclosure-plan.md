# 工具 schema 渐进披露（tool-schema-progressive-disclosure-plan）

> 性质：实施计划——模型可见工具 schema 的瘦身（摘要面）+ `tools_help` 按需披露全文，压低每请求常驻的 schema 占比。
> 状态：现行 · cr-1284 2026-11-24（plan；本档只做方案与测量，未改代码）。
> 读者：实施 superagent E1 前半（工具面渐进披露）的人；动 `ac-core-utils` / `ac-tools` / `ac-run-code-core` / `ac-shell-conversation` 的工具面投影前先读本档。

## 〇、结论速查

| 问 | 答 |
|---|---|
| 根因是什么 | 工具描述把「选型信息（何时用）」与「用法信息（参数格式、边界、纪律）」混写在同一段常驻文本里；schema 又位于请求前缀 `[system][tool schema][history]` 中，每个 run 每一步都重付，新会话首请求全价命中缓存 miss |
| 现状多大 | 典型 Agent 面 14–16 KB ≈ 4.3–4.8K tok（本机真实面测量，§二）；最小实体 `__standard__` 首请求 miss 9.1K 中约一半是 schema |
| 做什么 | ① 模型面只留摘要（`summary`，≤110 字）+ 参数结构（`type/required/enum` 恒保，描述分级截断）；② 新增 `tools_help` 工具按需回全文；③ 程序化模式的 SDK 投影块同源瘦身 |
| 收益 | 真实面 4.76K → 3.46K（P1，只改工具描述，−27%）→ 3.26K（P3 参数描述分级，−31%）；删净参数描述可到 1.97K（−59%，不采纳）；SDK 块 −29%（§二） |
| 不做什么 | 不做工具面的动态解锁/收窄（`tool_search`）：实测每 run 至少 3 次面增长 × 每次 `(M−1)·P̄·hit` 的整段历史失效 = 11–197 倍亏损；判据 `ΔS > P̄/N` 现行全部 Agent 不满足（§2.5） |
| 行为面变不变 | 不变——工具名集合、参数 JSON Schema 结构、门禁（`discover` / `formDeniedBy`）全部原样；变的只有文字面 |
| 多跑一轮值不值 | **只有偶发才值**：单次 help 往返 = 该步整份 prompt，约等于一个 run 全部 schema 收益的 5–66 倍；盈亏平衡调用率 1.5%（`news`）～22%（`creator` mean）/ 中位约 9–15%（§2.4）。实测参数类失败仅 0.01% → 真需求远低于门槛；一旦当常规前置步骤就净亏 |
| 那主修复路径是什么 | **报错即文档**：校验失败的错误文本内联该工具参数表 + 摘要（零额外轮次，只在真错时付），`tools_help` 退为主动深查补通道（§3.5） |
| 真 `tool_search`（动态面）呢 | **现行数据上无盈利区间**：每 run 至少 3 次面增长，每次失效整段历史（`(M−1)·P̄·hit`）= 34–197 倍亏损；判据 `ΔS > P̄/N` 全部 Agent 不满足（§2.5） |
| 只剩改描述吗 | 不是。还剩：① 面裁剪（实测从未调用的工具占面 35–92%，单位收益最大，但属 Agent 职责决策）② 工具合并（`adt_*` 32 个 → 单工具 + `action` 枚举，数量级收益）③ 参数 schema 结构化简 ④ provider 显式 cache 断点（§2.6） |
| 天花板 | schema 占稳态 prompt 0.4–1.0%、占锚定 18–37%；全做满也只是个位数全局降幅。更大降幅在历史（`pwsh`/`read` 结果占 80%），属 compaction 线 |
| per-tool `help` 参数呢 | 比全局 `tools_help` 好，因为**收益与成本相关**（省的钱所有请求享受，付的钱只在用该工具时）。但只在长 run Agent 成立：`standard` 1.7×、`creator` 1.3×、`tester` 5.7×；`news` 0.5% 门槛 vs 9.0% 使用率 = **亏 18×**。且 `browser` 一半体积是结构、移不走（§2.8） |
| 能否预测「改完还会正确用工具」 | **不能整体预测**，拆三层：选对工具（静态可测，近重复仅 1 对）｜填对参数（按工具分级，C 档 4 个高危）｜遵守纪律（只能实测）。且朴素派生会产出 **9/68 个破损摘要**，必须在 `deriveSummary` 里修（§2.7） |

## 一、背景与根因

**结构性事实一：schema 是前缀。** 请求前缀解剖 = `[system][tool schema][history]`（`session-design.md` §9.1）；schema 在历史之前 ⇒ 任何中途变化都把历史一起推出缓存。因此「按需添加工具到面」是全局代价，而「按需取文档进历史」是纯追加、零失效。这一条决定本档取「静态瘦身 + 文档追加」，不取「动态解锁」。

**结构性事实二：工具描述是唯一没有分层的信息面。** 技能侧已有分层先例——目录只给 name/description/location，正文经 `load_skill` 按需注入（cr-1249：目录走 before-run 指纹注入，正文走 context 行）。工具侧至今只有一层：`ToolDefinition.description` 既是选型说明又是完整用法手册，全部常驻。

**根因：选型面与用法面被压在同一字段。** 选型信息（一句话「这是什么、何时用」）必须在场；用法信息（参数语义、边界条件、历史踩坑叮嘱）只在真要调用时需要。混写导致长尾工具（`subagent` / `browser` / `run_code` / `restart_*`）把大量只在 1% 调用里用得上的文字，付在 100% 的请求上。

**旁证。** dsh 侧 `dev_tool_search` 实测（issue #6）：全量 catalog 常驻注入时目标工具锚定 0/9，去掉后约 81%——长 catalog 不只是 token 成本，也是注意力成本。

## 二、现状测量（2026-11-24，本机数据根 `workspace/home`）

口径：`estimateTokens`（`ac-text-budget` 启发式，ASCII 0.3 tok/char、CJK 0.6）；只用于同口径相对比较，不等于具体 provider 分词。源码面 = `apps/catalog/tool-catalog.json`（bootShell 真装配 dump，含 MCP/SAP 长尾）；Agent 面 = `workspace/home/agents/<id>/boot-graph.json` 的 `tools`；请求面 = `workspace/home/usage/*.jsonl` 的 `stepCache[0]`。探针脚本住 `sandbox/`（`measure-real-face.mjs` / `face-share.mjs` / `usage-stats3.mjs`，不入库）；P1 落地时收编为 `scripts/measure-tool-schema.mjs`。

### 2.1 静态体量

| 测量对象 | 描述 | 参数 schema | 合计 | ≈tok |
|---|---|---|---|---|
| 全量注册面（68 工具） | 26.7 KB | 45.7 KB | 72.3 KB | 21.7K |
| 非 SAP 面（36 工具，全仓注册面去掉 ADT） | 7.8 KB | 14.3 KB | 22.1 KB | 6.6K |
| SAP/ADT 面（32 工具） | 18.9 KB | 31.4 KB | 50.2 KB | 15.1K |
| 真实 Agent 面（19–30 工具） | — | — | 14.2–15.9 KB | 4.3–4.8K |
| 程序化 SDK 块（`__creator__` 面 18 工具） | — | — | 14.7 KB | 4.4K |

要点：参数 `description` 占 schema 体量的 **63%**（45.7/72.3），但收益集中在少数工具——`__creator__` 面里 `subagent`（939+2185）、`browser`（587+2143）、`run_code`（622+482）三者即占 60%。

### 2.2 首请求代价（真实 usage 中位）

| Agent | run 数 | 中位步数 | 首步 prompt | 首步 cacheMiss | miss 率 | schema 占首步 prompt |
|---|---|---|---|---|---|---|
| `__standard__`（19 工具） | 101 | 3 | 24.6K | 9.1K | 43% | ≈18%（4.4K / 24.6K） |
| `__creator__`（20 工具） | 1274 | 10 | 90.8K | 11.0K | 13% | ≈5% |
| `news`（28 工具） | 1135 | 2 | 178.8K | 0.8K | 0% | ≈2% |
| `editor`（29 工具） | 143 | 3 | 230.4K | 8.1K | 7% | ≈2% |

读法：`__standard__` 的首步 miss（9.1K）≈ 全量锚定（首步 prompt 的三分之一强），其中 4.4K 就是 schema——**最小实体的锚定成本里约一半是工具面**。`__creator__` / `news` / `editor` 是续跑会话，首步大半命中缓存、miss 只含增量，schema 主要按缓存价计费并占用窗口（2–5%）。子 Agent 每次 spawn 都重付一次锚定，收益按 spawn 次数放大。

### 2.3 压缩变体（`__creator__` 真实面，18 个在目录内的工具）

| 变体 | chars | ≈tok | 相对现状 |
|---|---|---|---|
| A 现状（全文） | 15 850 | 4 756 | — |
| B 工具描述 → 首句（≤110 字） | 11 541 | 3 463 | −27% |
| C B + 参数描述截 80 字 | 10 865 | 3 260 | −31% |
| D C + 删净参数描述 | 6 550 | 1 965 | −59% |
| 程序化 SDK 块（B/C 同口径） | 14 658 → 10 459 | 4 398 → 3 138 | −29% |

### 2.4 额外轮次的成本核算（`tools_help` 值不值）

口径：一次 help 往返 = 多一次 LLM 请求（该步整份 prompt，现按步均值 `P̄` 计）+ 输出工具调用 + help 正文 `H` 追加进历史（此后每一步与后续 run 都重付，`replayTrajectory` 缺省展开）。收益 = `ΔS × N`（步数）。盈亏平衡调用率 `f* = ΔS·N / (P̄ + H·N_remaining)`。

| Agent | 步数均值 | 每步 prompt | 每 run 节省（P1，ΔS=1.3K） | 单次 help 成本 | `f*`（P1） | `f*`（P1+P3） | 节省占 prompt |
|---|---|---|---|---|---|---|---|
| `__creator__` | 21.6 | 136.6K | 28.1K | 146.9K | 19.1% | 22.1% | 1.0% |
| `admin` | 13.7 | 172.8K | 17.8K | 179.1K | 9.9% | 11.4% | 0.8% |
| `tester` | 8.4 | 167.1K | 10.9K | 170.8K | 6.4% | 7.4% | 0.8% |
| `editor` | 4.2 | 209.4K | 5.4K | 211.0K | 2.6% | 3.0% | 0.6% |
| `news` | 3.4 | 289.1K | 4.4K | 290.2K | 1.5% | 1.8% | 0.4% |
| `__standard__`（首请求口径） | 3 | 24.6K | 3.6K | 24.6K | 15.2% | 17.6% | 4.9% |
| `__creator__`（中位 run，10 步） | 10 | 136.6K | 13.0K | 141.1K | 9.2% | 10.6% | 1.0% |

读法三条：

1. **单次 help 往返 ≈ 一个 run 的 schema 收益的 5–66 倍**（长上下文 Agent 尤甚：`news` 一次 help 抵 66 个 run 的收益）。因此 help 只能是**偶发**行为——每个 run 允许的调用率门槛 1.5%–22%，中位约 6–10%。
2. **收益的真实归属是锚定**，不是稳态：schema 只占稳态步 prompt 的 0.4–1.0%，但在新会话 / 新子壳首请求里占 18–37%（§2.2）。所以这笔投资要按「锚定次数 × ΔS」算账，不按「轮数 × ΔS」算。
3. 除 token 外还有两项非计量成本：每步墙钟（`__creator__` 均值 16.5 s/步，一次纯 LLM 往返量级数秒到十几秒）与 `maxSteps` 预算一格。

**实证旁证（10.3 万次子调用的历史）**：`run_code` 子调用落盘共 103 111 条，失败 2 549 条（2.47%），其中**参数/schema 类失败只有 10 条（0.01%）**——绝大多数失败是语义错（`edit` 的 `old_string` 未命中 763 条、`pwsh` 命令失败 767 条）。也就是说：模型填参本来就极少需要查文档，help 的真需求率大概率远低于上面的 `f*` 门槛；反过来说，**一旦 help 变成常规前置步骤，成本立刻反超收益**。

**结论**：`tools_help` 值不值完全取决于调用率。设计上必须让它「罕见且有用」，而不是「顺手可查」——据此把主路径改成 **报错即文档**（失败时才内联该工具的参数表与描述全文，零额外轮次），`tools_help` 只承担「调用前主动深查」与「报错指引的下一步」。

### 2.5 真 `tool_search`（动态工具面）的成本核算

定义：常驻面只留 `tool_search` 桩（≈150 tok），模型搜索后把命中的工具**加进请求面**（`request.tools`）再调用。与 §2.4 的 help 往返相比，多出两笔专属成本：

| 成本项 | 计量 | 说明 |
|---|---|---|
| ① 搜索往返 | ≈ 该步整份 prompt `P̄`（多数按缓存价） | 与 help 相同，多一步 |
| ② **前缀失效** | `(M−1) × P̄ × hitRatio` | 工具面在 `[system]` 之后、历史之前——改它等于把整段历史重编码为 miss；`M` = 命中/未命中单价比（DeepSeek 系 ≈10，敏感度见下） |
| ③ 面增长 | k 个工具的 schema 常驻 | 本来就是要付的成本，不算额外 |
| ④ 选错面的返工 | 一次失败调用 + 重试 | 未见实测数据，按下界 0 计 |

**解锁次数的实测下界**：每 run 实际用到的**不同工具数**（4486 个 run 的子调用日志）：中位 **3**，p75 5，p90 7，p10 1；分布 1 个 1638 run、2 个 595、3 个 568、4–5 个 878、6–9 个 765、10+ 个 42。哪怕搜索完美命中、且一次搜索解锁全部所需工具，每 run 也至少要有 1 个「面增长时刻」。

**单次面增长的成本（真实 usage 口径，`M=10`）**：

| Agent | 步数 | `P̄`/步 | 命中率 | 一次性失效 | 一次增长总成本 | 每 run 全量面节省（ΔS≈4.4K） | 倍数 |
|---|---|---|---|---|---|---|---|
| `__creator__` | 21.6 | 149.6K | 98% | 1.32M | 1.50M | 130.2K | **11.5×** |
| `admin` | 13.7 | 174.6K | 98% | 1.54M | 1.75M | 96.4K | 18.1× |
| `tester` | 8.4 | 170.5K | 97% | 1.48M | 1.70M | 73.9K | 23.1× |
| `editor` | 4.2 | 181.1K | 97% | 1.58M | 1.81M | 56.1K | 32.3× |
| `news` | 3.4 | 345.1K | 98% | 3.05M | 3.45M | 52.6K | **65.6×** |
| `writer` | 9.5 | 433.1K | 99% | 3.86M | 4.33M | 78.5K | 55.2× |

按实测下界（每 run ≥3 次增长，而非 1 次）：`__creator__` 34.5×、`admin` 54.4×、`news` 197×——**收益比成本低 1.5 个数量级**。价格比敏感度（`__creator__`）：`M=5` 时 3 次增长已 20.6×，`M=20` 时 52×——要翻盘得假设缓存几乎不省钱，与实测 98% 命中率矛盾。

**判据（与实现无关的干净形式）**：一次额外往返只能由「当面省下的 schema」支付，即

```
ΔS × N  >  P̄        （N = 每 run 步数）
⇔  ΔS > P̄ / N       （每步上下文按步数摊薄）
```

| Agent | `P̄/N` | 面 ΔS | 判据 | 可负担的额外往返/run |
|---|---|---|---|---|
| `__creator__` | 6 898 | 4 761 | ✗ | 0.67 |
| `__standard__` | 7 718 | 4 451 | ✗ | 0.56 |
| `admin` | 12 769 | 4 658 | ✗ | 0.35 |
| `tester` | 20 338 | 4 270 | ✗ | 0.20 |
| `editor` | 43 235 | 3 884 | ✗ | 0.09 |
| `news` | 102 450 | 4 270 | ✗ | 0.04 |
| （假设 SAP/ADT 大面） | 6 898–12 769 | ≈15 069 | ✓ | 1.2–2.2（仍不含失效成本） |

**结论三条**：

1. **现行全部 Agent 都不满足判据**：工具面 4–4.8K，而每步上下文摊薄后是 6.9K–102K。一个额外往返就吃掉整个 run 的 schema 收益，还要倒贴 0.5–25 倍。
2. **前缀失效才是杀手**：`(M−1)×P̄×hitRatio` 是随机上下文线性增长的（`news` 一次失效 = 3.0M hit-token 当量 ≈ 58 个 run 的全部收益），而省下的 schema 是常数。上下文越长，动态面越亏——恰好与「长会话最需要省 token」的直觉相反。
3. **唯一可能划算的形态 = 大面 × 冷边界 × 一次定面**：面 ΔS 需 >15K（SAP/ADT、MCP 重装载面），且面变更只发生在**本来就要 miss 的边界**（新会话首请求 / 归档重写 / 压缩后），并把变更次数压到「每会话 ≤1 次」。此时失效成本≈0，成本只剩一次搜索往返，`__creator__` 类 Agent 可负担 2.2 次/run。

**四种摊销形态对照**：

| 形态 | 面变更频率 | 每次成本 | `__creator__` 盈亏 | 判定 |
|---|---|---|---|---|
| 逐步增长（每条消息按需解锁） | 每 run 3–7 次 | 1.50M | 34–80× 亏损 | ✗ |
| 每 run 一次（run 开始搜一轮） | 每 run 1 次 | 1.50M | 11.5× 亏损 | ✗ |
| 每会话一次（会话开始定面） | 每会话 1 次（实测中位 2 run/会话、均值 5.8；855 会话中 573 个 ≤2 run） | 1.50M/会话 | 会话需 ≥11 run 才回本，实测仅 26/855 会话 ≥21 run | ✗（除超长会话） |
| 冷边界一次（新会话/压缩后定面） | ≈0 额外失效 | 一次搜索 ≈ `P̄` | 0.67 次/run 预算内 | ◐ 仅大面成立 |

**给后续立项的边界条件**（写进 §五 裁决 4）：只在 ① `ΔS > 15K`（SAP/MCP 重面）且 ② 面变更落在冷边界（失效≈0）时立项；否则不做。tc-base 模式下「搜索即改 `request.tools`」的形态在本仓数据上没有任何盈利区间。
### 2.6 除描述瘦身外的杠杆（实测空间）

**面裁剪**：把各 Agent 真实面（`boot-graph.json`）与历史实际调用（`messages.jsonl` 的 `step/tool-call` + `subcalls.jsonl.migrated`）对拍——「从未调用的工具」占面比例普遍很高：

| Agent | 面工具数 | 从未调用 | 极少（≤2 次） | 从未调用工具占面 schema | 极少调用再占比 |
|---|---|---|---|---|---|
| `quant` | 28 | 27 | 0 | 92% | 0% |
| `abap-dev` | 28 | 15 | 5 | 64% | 7% |
| `admin` | 30 | 18 | 1 | 60% | 1% |
| `impc-consultant` | 28 | 13 | 7 | 54% | 15% |
| `neko` | 28 | 10 | 2 | 44% | 1% |
| `designer` | 28 | 7 | 8 | 36% | 23% |
| **`__creator__`** | 20 | 6（goal / session_digest / subagent / submit_issue / update_agent_profile / web_search） | 5 | **35%** | 17% |
| `news` | 28 | 7 | 1 | 21% | 0% |
| `__standard__` | 19 | 1 | 1 | 2% | 6% |

读法：**面裁剪的单位收益（一裁 35–92%）远大于描述瘦身（压 27–31%）**，但它卖的是能力可达性。`__creator__` 的六个「从未调用」里 `subagent` / `web_search` 属于「该用而没用」，不能机械按频次裁——裁剪必须由人按 Agent 职责定，属配置层决策（行集），不是机制层优化。

其他机制层杠杆（不动行为面）：

| 杠杆 | 空间 | 风险 | 归位 |
|---|---|---|---|
| **工具合并（同域归一）** | SAP/ADT 面 32 个 `adt_*` ≈ 50 KB schema → 合成「单工具 + `action` 枚举」可降到 10 KB 级 | 中高：模型对工具名的选择先验强于枚举值；Schema 校验、UI 目录、权限矩阵全要跟 | 但它是**数量级**收益，且只影响 SAP 类重面 |
| **参数 schema 结构化简** | 每层 `additionalProperties:false`、重复 `type` 包装、内联 `anyOf` 合并 | 低：语义零变化，但要重跑 `validateInvoke` 全测 | `ac-sap-adt` / `ac-mcp` 的 schema 生成处 |
| **provider 显式 cache 断点** | Anthropic 系支持 `cache_control` 标记；本仓未打（grep 零命中） | 低 | `ac-anthropic-completions`；DeepSeek/OpenAI 自动前缀缓存，无此口 |
| **锚定次数** | 每次 spawn 子壳 / 新会话都全价重付 schema | 属产品行为 | 子 Agent 数量与颗粒度 |

**天花板（必须一起说）**：schema 只占稳态步 prompt 的 0.4–1.0%、占新会话锚定的 18–37%。即便把上述全做满，**全局 token 降幅仍是个位数百分比**。要更大的降幅只能动历史——`__creator__` 工具结果构成：`pwsh` 45%、`read` 35%、`grep` 8%（共 984 条子调用、均值 2.3 KB/条）。那属于 compaction（master plan H1）与结果预算线，不是工具面。
### 2.7 「改造后还能不能正确用工具」的可预测性分级

**总判断：不能整体预测。** 但可以把它拆成三个可判性完全不同的子问题，分别用不同手段把关：

| 子问题 | 静态判据 | 可预测性 | 把关手段 |
|---|---|---|---|
| ① 选对工具 | 工具名 + 摘要的区分度（近重复检测） | **高**（确定性） | 单测：摘要两两 Jaccard ≤0.45；名字不变 |
| ② 填对参数 | 结构（`type/required/enum`）逐字节等价 + 参数描述首句是否够用 | **中**（按工具分级） | 结构等价断言 + `paramDesc` 分级策略 |
| ③ 遵守行为纪律 | 无静态判据（依赖语义理解） | **低** | 只能实测：BFCL 两臂 + 上线失败率 |

#### 2.7.1 静态分析已抓到的两个必现问题

1. **朴素「取首句」会产出破损摘要**：按句末标点切首句后，68 个工具里有 **9 个**首句以未闭合的括号/引号结尾（`glob` 截在 `"**/*.`、`read` 截在 `output: { pa`、6 个 `adt_*` 截在参数枚举中段）。55/68 会被截断，其中 9 个是语法破损——不是「信息变少」而是「文本坏掉」。**`deriveSummary` 必须做括号/引号内的安全断点**（先按顶层标点切，再在括号内坐标上退到最近的完整分句）。
2. **`summary ⊆ description` 的朴素实现会撞上多行描述**：`restart_host`/`restart_shell` 摘要 Jaccard = 0.47（两者首句都是「改了本壳装载的代码…」）——这是唯一一对近重复，但恰好落在一对**高危误用组合**（重启宿主 vs 重启壳）。这两个必须 authored summary 显式区分。

#### 2.7.2 参数描述依赖度分级（68 工具）

| 档 | 工具数 | 参数描述合计 | 特征 | 策略 |
|---|---|---|---|---|
| **A 安全** | 37 | 4 280 chars（均 116/工具） | 无 action 映射、无单位/格式 | 可走 `first-clause`，甚至 `none` |
| **B 分级** | 27 | 11 861 chars | SAP 系为主，单位/格式密集（`unit` 标记 1–4 个/工具） | `first-clause` 但**单位/格式子句必须保留** |
| **C 高危** | 4 | 6 130 chars | `browser`（19 参数，16 个带 `[open]/[click]` action 前缀）、`subagent`（13 参数，12 个带 `[spawn]/[send]` 前缀）、`goal`（6 参数 5 个带前缀）、`adt_create_destination`（30 参数） | **参数描述不得截断**；`action↔参数` 映射只存在于这些描述里，截断 = 毁掉「哪个 action 配哪个参数」 |

结论：`paramDesc` 不能全局一刀切。**按工具判档**（`[xxx]` 前缀计数 + 参数描述总长）在 P3 落地，C 档豁免。

#### 2.7.3 为什么「预测」只能到这一步

静态分析能判「信息是否还在文本里」，判不了「模型会不会用」。三个具体不可预测项：

- **纪律句的价值**：`web_search`/`browser` 的「外部内容不可信」、`subagent` 的「返回值只有回执」都住在尾注（实测 7/20 个工具尾注含纪律或单位关键词）。模型是否**真的**因为这句话改变行为，无静态判据。
- **同族工具互斥**：`restart_host` vs `restart_shell`、`write` vs `edit` vs `str_replace_editor`，摘要区分度可以算，但模型在具体语境下会不会选错，只与训练分布有关。
- **单位/格式的兜底**：`pwsh.timeout` 只靠描述说毫秒，模型猜成秒的代价是一次 300 秒卡死。这类错误在历史里出现频率极低（参数类失败 0.01%），但一旦发生代价不对称。

#### 2.7.4 唯一能给出真实答案的路径

`pnpm bench --model <m> --base-url <u>` 跑 BFCL 单轮两臂（full vs compact），把两个指标**分开看**：

| 指标 | 对应子问题 | 门槛 |
|---|---|---|
| 工具选择准确率（选错名即为失败） | ① | 两臂差 ≤1 题/类目 |
| 参数完全匹配率（同名但参数不符即为失败） | ② | 两臂差 ≤1 题/类目 |

成本估算：BFCL 单轮 simple/multiple 各约 100–400 题，每题请求含工具面 ≈4.4K token（两臂差 ≈1.3K）+ 输出数百 token；两臂全跑约 **3–4M prompt token** 量级。这是唯一需要真花钱的验证环节，建议在 P3 之前跑一臂基线、P3 后跑对照臂（而不是每批都跑）。

**不推荐**的做法：拿 mock 模式（`--mock`）当验证——它是脚本化回放（把期望调用编码进 prompt 再由 mock 吐出），零 LLM，只能验证链路，不能验证模型行为。
### 2.8 逐工具 `help` 参数（per-tool help）的成本面

形态：给「文档重」的工具在参数表里加一个 `help: boolean`，`help:true` 时返回该工具完整参数用法、不执行。与 §2.4 全局 `tools_help` 的**本质差异**：省下的钱所有请求都享受，付的钱只在真正用到该工具时才付——**收益与成本相关**，这是它唯一的结构性优势。

#### 2.8.1 先纠正一个直觉：`browser` 并不是「描述最重」的那个

| 工具 | 结构 | 参数描述 | 工具描述 | help 可移走 | 占该工具 |
|---|---|---|---|---|---|
| `adt_create_destination` | 329 | 1 406 | 637 | 2 043 | **86%** |
| `subagent` | 185 | 648 | 420 | 1 068 | **85%** |
| `browser` | **344** | 348 | 219 | 567 | 62% |
| `goal` | 62 | 152 | 40 | ≈165 | 65% |

`browser` 的体积一半是**结构**（19 个参数 + 4 个 enum 数组），结构不能移走——移走模型就无法构造参数、只能每次都 help，反而更贵。真正能移到 help 的只有描述文本。全目录口径：结构 4 792 tok、参数描述 9 592、工具描述 9 111（合计 23 495）——**help 最多能动 80% 的描述部分，碰不到结构**。

#### 2.8.2 三项成本

| 成本项 | 量级 | 说明 |
|---|---|---|
| ① 常驻 schema 开销 | **30 tok/工具**（87 chars） | `help: { type: boolean, description: … }`。全量注入 20 工具 = +579 tok（吃掉摘要收益的 44%）；按需注入 2 工具 = +60 tok |
| ② 轮次成本 | 一次整步 prompt（同 §2.4） | 与 `tools_help` 完全相同——**这一项 help 参数没有优势** |
| ③ 实现与行为风险 | 见 §2.8.5 | 权限门误拦、required 校验、`additionalProperties:false`、模型误传 |

#### 2.8.3 分 Agent 盈亏（真实 usage，C 档三件套 `browser`/`subagent`/`goal`）

| Agent | 步数 | `P̄`/步 | 可移走 | 省/run | `f*` | C 档实际使用率 | 判定 |
|---|---|---|---|---|---|---|---|
| `__creator__` | 21.6 | 149.5K | 1 295 | 28.0K | 17.5% | 13.3% | ◐ 微盈 1.3× |
| `__standard__` | 12.5 | 96.5K | 1 295 | 16.2K | 15.8% | 9.5% | ✓ 1.7× |
| `tester` | 8.4 | 170.5K | 492 | 4.1K | 2.4% | 0.4% | ✓ 5.7× |
| `news` | 3.4 | 345.1K | 492 | 1.7K | **0.5%** | 9.0% | ✗ **亏 18×** |
| `writer` | 9.5 | 433.1K | 492 | 4.7K | 1.1% | 2.1% | ✗ 亏 2× |

读法：判定完全由**「步数 × 上下文规模」**决定，与工具本身无关。长 run（`standard`/`creator`/`tester`）刚过线或有余；短 run + 大上下文的 `news`/`writer` 明确亏损——那里一次 help 抵 18 个 run 的收益。

注：表中的「C 档实际使用率」是**上界**（假设每次用到该工具都需要 help）。若模型只在半数调用里需要，实际率减半 → `__creator__` 变为 2.6× 盈利。

#### 2.8.4 注入范围：按「文档重」判据，不按 C 名单

判据（可自动判定，不手写白名单）：`参数描述 tok ≥ 120` 或 `参数数 ≥ 10` → **18/68 个工具**命中（14 个 `adt_*` + `browser`/`subagent`/`send_agent`/`run_harness`）。

| 面 | 命中工具 | 注入开销 | 可移走 | 净省/请求 |
|---|---|---|---|---|
| `__creator__` / `__standard__` | `browser`, `subagent` | +60 tok | 1 398 | **−1 058 tok** |
| `news` / `admin` | `browser`, `send_agent` | +60 tok | 636 | −449 tok |
| （普通面几乎不含 `adt_*`） | — | — | — | — |

#### 2.8.5 实现形态：投影期注入 + execute 中心拦截（零工具改动）

关键设计：**不改任何工具实现**。

| 环节 | 改动 | 理由 |
|---|---|---|
| 投影（`normalizeToolSpecs`） | 对命中判据的工具，在参数 schema 里**追加** `help` 属性 | 只改模型可见面，注册面 `ToolDefinition` 不脏 |
| 执行（`ToolsService.execute`） | `args.help === true` → 格式化返回该工具的 `description` + 参数表，**不调 execute** | 一处拦截覆盖全部工具，**含 MCP / 第三方**（§3.4 的 `tools_help` 方案做不到这点） |
| 前置校验（`validateInvoke`） | 识别注入的 `help` 键，且 `help:true` 时跳过 `required` 检查 | 否则 `browser({help:true})` 会被「缺 `action`」拦掉 |

**必须拦在 waterfall 之前**：`browser` 是 `needPermission: true`，若 help 请求走 `tool/before-execute`，用户会收到一张「批准执行 browser」的卡——荒谬且危险。拦截点放在 `execute()` 入口、`ctx.waterfall` 之前，并 emit 一个轻量事件记账。

#### 2.8.6 风险清单

| 风险 | 表现 | 处置 |
|---|---|---|
| 模型误传 | 以为 `help` 是业务参数，传 `help:true` 想执行 → 拿到文档没执行，浪费一轮 | 描述写明「传 true 只返回文档、不执行」；返回文本首行强调「未执行任何动作」 |
| 权限门误拦 | help 请求触发审批卡 | 拦截点前置到 waterfall 之前（§2.8.5） |
| 注入污染注册面 | `ToolDefinition.parameters` 被改写 → 管理面/UI 显示多余参数 | 注入只发生在投影层（`normalizeToolSpecs` 输出），注册面不动 |
| 一致性困惑 | 部分工具有 `help`、部分没有 | 判据确定（文档重才有），与「部分工具有 enum」同性质；`tools_help` 目录态可列出全部，弥补落差 |
| 把 help 当惯例 | 每次都先 help | 同 §2.4 风险 7：调用率设阈值，超线即判定摘要不足 |

#### 2.8.7 结论：它值不值得做，取决于两件事

1. **是否已经做了「错误即文档」**（§3.5）。若校验错误已经把参数表内联返回，`help` 的边际价值只剩「调用前不确定、又不敢试」这一窄场景——而 `browser` 恰是这种（action↔参数组合多、试错成本高）。
2. **目标 Agent 的形态**。`news`/`writer` 类必须关闭；`standard`/`creator`/`tester` 类可开。**按面开关**（判据：`ΔS·N > P̄` 是否成立）而非全局配置。

优先级排序（C 档）：**重写压缩（零风险，省 210–270 tok）→ 错误即文档 → per-tool `help`（可选增强）**。三者不重复：重写压缩去掉冗余措辞，错误即文档兜住真错，`help` 覆盖「调用前想确认」。
## 三、终态规格

### 3.1 三面分离（本档的核心裁决）

| 面 | 内容 | 消费者 | 是否变 |
|---|---|---|---|
| 注册面 | `ToolDefinition` 原文（name/description/parameters/risk/discover…） | `ctx.tools.list()`、`tools_help`、门禁 | 不变 |
| 模型面 | name + `summary`（≤110 字）+ 参数结构 + 分级参数描述 + `tools_help` 一行定义 | provider `tools[]`、程序化 SDK 块 | **瘦身** |
| 管理面 | 全文 description + 完整 parameters | `toolsCatalog()` / `assemblyToolsView` / plugin-registry / UI | 不变 |

单源纪律：`description` 仍是唯一文档真相；`summary` 只是模型面的**覆盖值**，不是第二份文档。

### 3.2 契约扩展（`ac-tools/src/contract.ts`）

```ts
/** 模型常驻面摘要（建议 ≤110 字，一句话说清「是什么 / 何时用 / 一条硬约束」）。
 * 缺省由 description 首句派生（投影期现算，不落注册面）。 */
summary?: string;
```

- 不新增 `help` 字段：全文与参数表由注册面现算，避免同一文档两份存储。
- 可测约束：`summary` 必须是 `description` 首段的子串（防覆盖值与正文走散，测试锁）。
- `deriveSummary` 三条硬要求（§2.7.1 实测驱动）：① **括号/引号内不断句**（朴素切分会产出 9/68 个破损摘要）；② 截断点须是完整分句，不留 `…` 悬空；③ 同族工具（`restart_host`/`restart_shell`）由 authored `summary` 显式区分，不依赖派生。

### 3.3 投影单源（`ac-core-utils`）

`normalizeToolSpecs(defs, names)` 已是模型面的唯一构造点（`ac-agent-loop` §898 调用；M21/D4 字典序单源）。扩展为：

```ts
normalizeToolSpecs(defs, names, {
  summary?: 'derive' | 'off',                       // 缺省 'derive'：模型面 description = summary ?? 首句
  paramDesc?: 'full' | 'first-clause' | 'none',     // 缺省 'full'（P1），P3 评估后翻 'first-clause'
})
```

- 两档独立开关：**摘要档**（工具级）与**参数描述档**（schema 级）分开上，回滚粒度小；首期只开摘要档。
- `first-clause`：参数 `description` 只留首个分句（`；`/`。` 切分）且 ≤80 字；`full` = 原样。
- 恒保：`type` / `required` / `enum` / `additionalProperties` / 嵌套结构；只截 `description` 文本。
- 三处消费同一函数，不得各写一套：① loop 真面（`ac-agent-loop`）② 估算面 `conversation.toolDefs()`（Token 仪表四段条的工具定义段据此计算，必须与真 run 同口径）③ 程序化 SDK 块（`buildSdkProjection` 的 `projectTool` 改用同一 `deriveSummary` + 同一参数描述档）。
- 档位缺省值住 `ac-core-utils` 单点常量；**例外 = §2.7.2 的 C 档工具豁免**（`browser`/`subagent`/`goal`/`adt_create_destination` 的参数描述不得截断）——豁免名单按「`[action]` 前缀参数 ≥3 或参数描述总长 >1.5K」自动判定，不手写白名单。

### 3.4 `tools_help` 工具（注册于 `ac-tools` 骨架行）

注册位置 = `ac-tools`（`shell.yml` 骨架行 `tools`，恒在菜单 ⇒ 恒在任意 Agent 的行集；`rowToolFace` 由 fiber 归属自动派生 `tools → [tools_help]`），不新建行、不加 `ac.rows`。例外条件：若 Agent 的 `rows` 被显式收成白名单而剔除骨架行（测试播种形态），自述入口随面消失——真实装配态菜单恒含骨架行，不构成缺口。

依赖口径（防环）：`ac-agents` 依赖 `ac-tools`（类型面 + 服务），故 **`ac-tools` 不得依赖 `ac-agents`**。落地路径——`resolveToolNames` 本就住 `ac-agents-core`（纯库）；`formDeniedBy` 现住 `ac-agents/src/service.ts` 且只依赖 `conversationFormOf`（纯），下沉 `ac-agents-core` 后由 `ac-agents` 兼容 re-export；`ac-tools` 只新增对 `ac-agents-core` 的依赖，Agent 行集经 `ctx.get('agents', false)` 在 execute 期软取（use-time 软取合法）。备选落点 `ac-shell-tools`（已依赖 `ac-agents`）——代价是无 `shell-tools` 行的 Agent 失去自述入口，不取。

| 形态 | 入参 | 返回 |
|---|---|---|
| 目录 | 无参 | 当前生效面内全部工具的 `name` + `summary`（可选 `owner`），按名字典序 |
| 单/批量全文 | `names: string[]` | 每个工具的 `description` 全文 + 参数表（名/类型/必填/枚举/描述全文）+ `owner` |
| 未知名 | — | 可读错误 + 编辑距离最近名（复用 `ac-run-code-core` 的 `nearestName` 口径） |

- 可见面口径必须与真实面同源（`discover === undefined` + `formDeniedBy` + `resolveToolNames(agent.rows)` 展开），绝不泄露未装载工具——否则模型会去调用不可达的工具。
- 输出预算：单工具 ≤4 KB、单次 ≤12 KB（`ac-text-budget` 截断并附「已截断」提示）；超限时优先保参数表、截描述尾段。
- 程序化模式：作为 `tools.tools_help(...)` 出现在 SDK 块里，**不进** `PROJECTION_EXCLUDE`（它不是 `list_tools` 那种纯回显，它是文档源）。
- 工具自身 `description` 一句带用法纪律（「按需取全文；仅在**将要调用一个不熟的工具**时用，不要为常规工具先取文档」）。
- **结果不进跨 run 重放**：help 正文是临时参考，进历史后被永久重付（§2.4）——落账时带 `meta.injectSource='tool-help'`，`replayTrajectory` 展开时跳过该行（同 `ARCHIVE_REVIEW_META` 一类机制标记的处理方式）。这一条不做到，help 的成本从「一次」变「永久」。

### 3.5 主路径是「报错即文档」，不是「先查后调」

成本账（§2.4）决定分工：

| 路径 | 何时付成本 | 实测频率 | 判定 |
|---|---|---|---|
| ① 摘要 + 参数结构（常驻） | 每请求（已优化到最小） | 100% | 主承载 |
| ② **报错内联文档**：参数校验失败时，错误文本直接带该工具的参数表 + 相关描述段 | 只在真失败时 | 参数/schema 类 0.01%；`additionalProperties`/`required` 类已内联字段名 | **主修复路径（新）** |
| ③ `tools_help` 主动深查 | 每次调用 = 一整个往返 | 应 <5%/run | 补充通道（长尾工具首次使用） |

落地要点：

1. `validateInvoke`（`ac-run-code-core`）与工具侧 `additionalProperties:false` / `required` 校验的错误文本，从「字段名 + 已知参数名」（现状）扩到「该工具参数表 + 摘要 + 一句指向 `tools_help`」。错误文本本身进历史，模型下一步直接可修，零额外轮次。
2. `tools_help` 的 `description` 常驻一句（何时取）——不另开 system prompt 段（v3 分工红线：提示词只放工具描述教不了的）。
3. 摘要保留「一条硬约束」：`web_search`/`browser` 的「外部内容不可信」、`load_skill` 的「返回只有回执」这类纪律属于**每次调用都必须知道**的，进 `summary` 而非只进 help。
4. **调用率是验收指标**：P6 端到端统计 `tools_help` 调用率；>5%/run 即判定「摘要信息不足」，处置是补 `summary`（P2），不是放任模型求助。

### 3.6 与代码的映射点

| 文件 | 角色 | 改动 |
|---|---|---|
| `packages/ac-tools/src/contract.ts` | 工具域契约 | 加 `summary?` |
| `packages/ac-tools/src/help.ts`（新） | `tools_help` 注册与渲染 | 目录/全文/错误面；可见面 = `resolveToolNames`（`ac-agents-core`）+ `formDeniedBy`（下沉后）+ `ctx.get('agents')` 软取 |
| `packages/ac-tools/src/index.ts` | 行装配 | `apply` 内注册 `tools_help`；`package.json` 增 `ac-agents-core` 依赖（禁 `ac-agents`，防环） |
| `packages/ac-agents-core/src/config.ts` | 纯函数单源 | `formDeniedBy` 下沉（`ac-agents` 兼容 re-export） |
| `packages/ac-core-utils/src/index.ts` | 跨行协议词汇单源 | `deriveSummary` / `compactParameters` / `normalizeToolSpecs` 选项 |
| `packages/ac-agent-loop/src/service.ts` | 模型面构造 | 传 `{disclosure}`（缺省 compact，可配） |
| `packages/ac-shell-conversation/src/service.ts` | 估算面 | `toolDefs()` 同口径（否则 Token 仪表读数与真 run 分叉） |
| `packages/ac-run-code-core/src/index.ts` | 程序化 SDK 块 | `projectTool` 用同源摘要 + 参数描述分级 |
| `packages/ac-run-code-core/src/index.ts`（`validateInvoke`） | 参数硬校验 | 报错内联该工具参数表 + 摘要 + `tools_help` 指引（主修复路径） |
| `scripts/measure-tool-schema.mjs`（新） | 体量对拍 | 按 `boot-graph.json` × `tool-catalog.json` 输出各面 full/compact 两列 |

## 四、分批切分

| 批 | 内容 | 测试标准（过程门） | 验证目标（目的态） |
|---|---|---|---|
| P1 投影单源（摘要档） | `summary` 契约 + `deriveSummary` + `normalizeToolSpecs` 选项 + 估算面同口径 + 测量脚本 | typecheck / test:unit / check:deps / 定向 eslint；`ac-core-utils`、`ac-shell-conversation`、`ac-run-code-core` 定向 vitest | 模型面字节下降 ≥20%，**`parameters` 逐字节等价**（本批不动参数描述）；管理面（`toolsCatalog`）全文不变；空描述工具不产空摘要 |
| P2 摘要覆盖 | 15 个高频工具写 `summary`（subagent / browser / run_code / pwsh / read / write / edit / ask_questions / todo / goal / web_search / restart_* / submit_issue / load_skill） | 同上 + `summary ⊆ description` 断言测试 | 高频工具摘要含「一条硬约束」；派生摘要与覆盖摘要混用不产生双轨叙事 |
| P3 参数描述分级 | 按 §2.7.2 三档分级（A 可截 / B 保单位格式子句 / C 豁免）+ `compactParameters` + **BFCL 基线臂（P3 前）与对照臂（P3 后）** | 同上 + `ac-core-utils` 定向 vitest（截断边界：分句、嵌套、`enum`、单位子句保留）+ BFCL 两臂分开看「选择准确率 / 参数匹配率」 | 字节再降 ≥4 个百分点；两臂**选择准确率与参数匹配率各自差 ≤1 题/类目**，否则回滚该档（C 档豁免已验证生效：`browser`/`subagent` 参数描述逐字节不变） |
| P4 报错即文档 + `tools_help` | ① `validateInvoke` / 工具侧校验错误内联参数表 + 摘要（主路径）；② `tools_help` 注册 + 目录/全文/未知名 + 输出预算；③ help 结果标记 `injectSource` 不进跨 run 重放 | 同上 + `ac-tools` 定向 vitest + `apps/shell` 面级 e2e（可见面不泄露未装载工具、help 行不回放） | 参数类失败后**无需额外轮次**即可自修（错误文本自带参数表）；无参一次调用拿到面内全部摘要；help 正文不进入下一 run 的请求 |
| P4b per-tool `help`（可选） | 投影期给「文档重」工具注入 `help` + `execute` 前置拦截 + `validateInvoke` 豁免；**按面开关**（`ΔS·N > P̄` 成立才开） | 同上 + 三专项测试：help 不触发权限门、help:true 跳过 required、注入不进注册面 | 命中工具参数描述可再移走 ≤80%；`news`/`writer` 类面**默认关闭**且验证确实关闭 |
| P5 SDK 块 | `projectTool` 同源瘦身 + `tools.tools_help` 进 SDK | 同上 + `ac-run-code-core` 定向 vitest（投影快照更新） | 程序化块字节下降 ≥25%，签名与运行时桥接仍同名同构 |
| P6 端到端评估 | 真实任务面两臂（瘦身前后）各跑一组编码/调研任务，比 promptTokens、工具误用次数与 **`tools_help` 调用率** | 人工观察 + usage / 子调用日志对拍 | `promptTokens` 中位下降 ≥20%；误用（未知工具/缺参）次数不增；**help 调用率 <5%/run**（超线即判定摘要不足，回补 `summary` 而非放任） |
| P7（不做） | 工具面动态解锁 / `tool_search` | — | 本仓数据上无盈利区间（§2.5、§五 裁决 4）；仅「大面 + 冷边界」场景可另立项 |

批间依赖：P1 → P2 → P3（含通过率门槛）→ P4 → P5 → P6。P1 单独可发布（纯瘦身、无新工具、参数 schema 零变化），是回滚粒度最小的一步；P3 与 P4 互不依赖，可先 P3 验证「参数描述也能截」再上 `tools_help`。

## 五、风险与开放裁决

| # | 风险 | 表现 | 处置 |
|---|---|---|---|
| 1 | 参数错误率上升 | 参数描述被截后模型猜格式（时长单位、枚举、嵌套键），多一轮往返 | P1 不动参数描述；P3 才截到首句 ≤80 字并以 BFCL 通过率设门槛；结构（type/required/enum）恒保；报错面指引回 help |
| 2 | 摘要丢关键纪律 | 「外部内容不可信」「返回只有回执」这类不读就会错的行为约束被截掉 | 高频工具走 authored `summary`（P2），纪律句进摘要；派生模式只保首句，不做智能摘要 |
| 3 | KV 一次性失效 | 部署后所有会话首请求整段 miss（schema 在历史之前） | 已知的一次性迁移成本，与 M2b 字典序一次性失效同性质；tool help 走历史追加，不构成第二处破坏 |
| 4 | 动态解锁的代价被低估 | 中途往面里加工具 ⇒ 整段历史重建（不是只丢新增部分）；实测每 run 至少 3 次增长 = 34–197 倍亏损（§2.5） | 本档不做。再立项须同时满足：`ΔS > 15K`（SAP/MCP 重面）+ 面变更只落在冷边界（新会话/压缩/归档重写，失效≈0）+ 每会话 ≤1 次；见 §2.5 边界条件 |
| 5 | 双源漂移 | `summary` 与 `description` 各自演化，模型读到的与真实文档不一致 | 测试锁 `summary ⊆ description 首段`；派生为缺省、覆盖为例外 |
| 6 | 第三方工具不可控 | MCP / SAP 描述由外部提供、可能超长或含格式噪声 | 一律派生截断（不依赖作者配合），全文留 help；`MCP` 工具的 `parameters` 结构原样保留 |
| 7 | help 沦为常规前置步骤 | 模型养成「先 help 再调」的习惯 → 每次一整个往返，成本 5–66 倍于收益，且多占 `maxSteps` 与墙钟 | `description` 明写「常规工具不要先取」；报错内联承担修复路径；P6 以调用率 <5%/run 为否决线 |
| 8 | help 正文常驻化 | 正文进历史后被每一步与后续 run 重付（`replayTrajectory` 缺省展开）——「一次成本」变「永久成本」 | 落账标记 `injectSource`，跨 run 重放跳过；输出预算单工具 4 KB / 单次 12 KB |

开放裁决（实施前定，缺省取向给在右）：

1. 参数描述档位：C（保首句 ≤80，**建议**）vs D（删净，收益 +28 个百分点但错误率不可控）——实测参数类失败 0.01%，D 档风险比原判低，可在 P3 用 BFCL + 失败率双门槛试一次。
2. 摘要来源：派生为主 + 高频覆盖（**建议**）vs 全量 authored（成本高、易漂移）。
3. `list_tools` 去留：保留（**建议**，轻量、前端 `toolIcon` 与门控在消费） vs 被 `tools_help` 目录态吸收。
4. 动态解锁是否立项：**建议不做**（§2.5 实测 34–197× 亏损）；仅「`ΔS > 15K` + 面变更落在冷边界 + 每会话 ≤1 次」可另立项。
5. 面裁剪（§2.6）是否进本档：建议**不进**——它是 Agent 职责决策（行集配置），本档只提供测量脚本与数据；`quant`/`admin`/`abap-dev` 这类面尤其值得人为复核。
6. per-tool `help` 是否立项：建议**作为 P4b 可选增强**，先 P4 的「错误即文档」上线并观察真实错参率，再决定是否需要（§2.8.7）；开关按面判定，不做全局配置。

## 六、与既有裁决的关系

| 既有裁决 | 关系 |
|---|---|
| [superagent-master-plan.md](superagent-master-plan.md) E1（工具/技能渐进披露） | 本档 = E1 的前半（静态瘦身 + 按需文档，可做）；后半（工具面解锁）实测在当前面对/价格比下无盈利区间（§2.5），建议在 master plan 标「实测否决（除非大面+冷边界）」 |
| `session-design.md` §9（KV 纪律） | schema 变化即前缀破坏：本档只改一次，工具文档走历史追加 |
| `ac-skill` cr-1249（目录摘要 + 正文按需） | 同构先例：技能侧已分层，工具侧补齐 |
| cr-953 / cr-1049（授权与发现轴） | 不动：能力面 = 装载面，`discover` 谓词与 `formDeniedBy` 原样 |

## 七、同步义务

| 动作 | 同步点 |
|---|---|
| 立项 | `cr/cr-log.md`（cr-1284，plan）；`superagent-master-plan.md` E1 行挂本档链接 |
| P1–P5 落地 | 壳侧行源码改动 → `restart_shell`；本档批次表注 cr 号；`session-design.md` §9.3 补一句「schema 瘦身属一次性前缀变更」 |
| P3 / P6 完成 | BFCL 与端到端两臂数据回写本档 §二；master plan E1 状态翻 doing/done |
| 全部实施且验证目标达成 | 本档归档 `archive/platform/` |

> 变更登记：cr-1284 2026-11-24 立项（plan，调研 + 方案）。
