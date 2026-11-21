# TokenGauge 显示算法 P+delta 重设计交接（token-gauge-p-delta-handoff）

> 性质：交接——上下文占用仪表显示算法的重设计动机、方案与实施面，供新会话接力讨论与实施。
> 状态：已实施 · cr-1194 2026-11-21（方案定稿 cr-1193；两态落地——est-since 裁决后端精确值、锚 = 末次 run 在 records 的末行时刻〔纯 records 自足〕、跨代守卫归后端锚面）。
> 读者：接手 TokenGauge 显示算法重构的开发者/会话（本仓前端 ac-client-ui-conversation + 宿主聚合面 ac-host-webui）。

## 一、背景与病灶（为什么重设计）

现行 displayTotal 三态（优先级从上到下）：

| 态 | 触发 | 值 | 来源 |
|---|---|---|---|
| 实时态 | run 进行中 | KV 走势最近带 prompt 的步点 | 每步真实 API prompt（cr-761） |
| 锚点态 | idle 且采过锚 | `E × r`（r = P/E，钳制 [0.5,4]，cr-1191 起超 [0.33,3] 弃样） | cr-1135 锚点校准 |
| 净估算态 | idle 无锚 | `tokenCount + 固定开销实值/0` | session/tokens 盘读 E |

实测病灶（2026-11-21 本会话活体）：压缩归档后 P=451,328（旧代末 run 真实 prompt）与 E=306,145（新代盘读）分属两代，r=1.47 表观合法却被采信；短 run 后 P 是 run **首步** prompt、E 是收束后**含本 run 轨迹**的盘读，r 系统性偏低 20-40%（19% vs 30%）且方向恒定。历史上三态逐层打补丁：净估算（够用）→ KV 实时（更准）→ 锚点比率（抹切换跳变）→ 钳制 → cr-1191 弃样守卫——每层都在给上层的补丁打补丁。

## 二、根因：锚点机制在重新推导 P 已知的答案

`E × r = E × (P/E) = P`——整个机制绕一圈，显示的就是 P 本身。它真正想解的问题是「P 是上次 run 的值、账本又长了，如何外推」，而答案直接写在问题里：

```
下次 run 的 prompt ≈ P（上次真实值）+ delta（自那以后的估算增量）
```

- P 是 API 实测值，天然含 system prompt / 工具定义 / 模板 / 估算系数误差——锚点想吸收的全部「固定开销」都在里面；
- delta 只是上次 run 之后新落的行（新消息、注入行），量小、估算误差小；
- 每个 run 收束自动重新锚定到实测真值——误差永不累积。

三病灶在 P+delta 下全部消失：

| 病灶 | 现行机制 | P+delta |
|---|---|---|
| P 语义漂移（短 run 后恒偏低） | P（首步）与 E（收束后含轨迹）不同拍 | P 保持原值，E 只参与增量——不同拍不存在 |
| 双数据源分叉（索引/回落口径差） | 显示值直接依赖 E 绝对值，差异全量暴露 | E 只算小增量，绝对偏差不进显示值 |
| 三态切换跳变 | 三档口径切换各跳一次 | 两态：收束点按构造连续（livePrompt 末值 = P，delta 从 0 起步） |

cr-1191 的跨代守卫（P/E 超界弃样）也随之简化：归档时 P 作废回落净估算，下轮 run 自然重锚——无需病理界判定。

## 三、方案（两态显示）

```
run 中：displayTotal = livePrompt（不变）
idle：  displayTotal = P + delta
          P     = cache.lastRunPrompt（run 收束时锚定）
          delta = Σ（上次 run 落账后新行的 est_tokens）
```

实施面（两处）：

| 文件 | 改动 |
|---|---|
| `packages/ac-client-ui-conversation/client/header/TokenGauge.vue` | displayTotal 三态改两态；删 anchorRatio/采样/钳制/守卫；新增 delta 累计 |
| `packages/ac-host-webui/src/face-ops.ts` | session/tokens 载荷增 P 锚字段（lastRunPrompt 已有）+ est-since（P 对应 seq 之后的行 est 合计）——或前端按 messageCount 差近似，裁决留给实施 |

刷新时机沿用现有 watch 面（agentId/single 切换、步终值、run 收束双拍、归档）；归档时清 P（回落净估算）+ 清 kvPoints（cr-1191 已加）。

## 四、未竟事项与接力入口（cr-1194 全部裁决实施）

1. **est-since 的取源裁决** → **后端精确值**：session-index 新增 pdeltaAnchorOf 锚面（records 表活跃代 ts_num > 锚 求和，SQL 单源、口径与 activeContextTokens 同源）；
2. **无 P 场景** → pdelta 缺席回落净估算态（原第三态保留为降级路径）——含「从未跑 run」「索引行缺席」「P=0」三形态；
3. **delta 的边界** → est_tokens 白名单现状即与回放注入同口径（estimateRowTokens 单源：机制行 NULL、subcall 0、摘要行计入），不另设判；
4. **四段堆叠条**（工具定义/系统提示/上下文/余量）：P+delta 态下固定开销已含在 P 里，contextTokens = displayTotal - 开销估算的减法语义需复核（可能与 cr-1162 的开销归属键联动）；
5. **KV 走势 sparkline** 不受影响（独立数据面）。

验证锚点：收束瞬间读数 = 末步 livePrompt（连续无跳）；随后每条新消息增量稳定；归档后回落净估算、下轮收束重锚。

## 五、关联档案

- 实施档案：cr-1194（锚面/载荷/两态化/测试）

- 病灶现场与三态演进：cr-1135（锚点校准）、cr-1191（跨代守卫 + 回落路径滤 shadowed）
- 数据链：session/tokens（face-ops.ts）→ TokenGauge.vue displayTotal；session-index est_tokens 口径见 cr-1190 Q2 裁定
- 病灶在压缩场景的另一半（boundary 语义）已由 cr-1192 独立修复，与本档无耦合