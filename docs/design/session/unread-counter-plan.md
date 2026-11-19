# unread-counter-plan（未读计数器方案实施计划）

> 性质：实施计划——cr-1152 下线后的未读重设计：事件计数器 + 同步清零（未读语义降级为 hint）。
> 状态：已实施（批 1–4 落地；session-design.md §11 为现行规格） · cr-1157 2026-11-19。
> 读者：接手实施的会话（本档 + cr-1157 详情为完整上下文）。

## 一、背景与裁决

cr-1146/1150/1151 的精准对账路线（读位位置锚 + 账本行集派生 + 索引 SQL 聚合）在 cr-1152 整体下线：成本模型错配（每次页面打开全树对账 1.3–2.1s）、语义深度（SQL 影子复刻 fold 语义）与需求（一个徽章提示）严重失衡。

cr-1157 裁决：**未读语义降级为 hint**——不与账本行对账，独立事件计数。四项实施裁决：

| 裁决 | 内容 |
|---|---|
| D1 | host 缺席窗口漏计接受（多为 single 会话；壳补发闭环属新需求不做） |
| D2 | 事实源可扩展注册表形态（run/settled + 独立私信 + 群消息三源起步） |
| D3 | 同步时机 = 重连对齐 + 慢周期兜底（严格高频 take 被否） |
| D4 | 幂等键要有（内存 LRU 记 runId/messageId，挡 at-least-once 重投双计） |

语义基线：**消息本体永远落账不丢，徽章只是提示**——错计不致命，roster 活动面（cr-1142）照常反映动静。多端吞没（一端 take 全局清零）为接受的行为。

## 二、终态规格

### 数据面（meta/unread.json 语义换血，version 1 读位数据作废）

```
{ "version": 2, "entries": { "<conversationId>": { "n": 3, "lastTs": 1765xxx, "lastKey": "run-abc" } } }
```

| 面 | 设计 |
|---|---|
| 写口 bump | 事件到达 +1，幂等键（runId/messageId/post requestId）去重，+1 即写盘 |
| 全量清零 takeAll | webui 对齐用——取走全部计数并清零（原子写） |
| 定向清 markRead | 点开会话即清（不等周期）——徽章即时消 |
| 持久化 | 原子写沿用（tmp+rename），损坏留档同款 |
| 防腐化 | take/markRead 时 n<0 拒写；孤儿键（会话已删）随清零自然消亡 |

### 源注册表（可扩展，三源起步）

| 源 | 挂点 | 幂等键 | 会话键 |
|---|---|---|---|
| run 收束 | tap 桥 run/settled 帧路径（host-web.ts tapAgent 桥 send 包装） | runId | 会话键由帧载荷 conversationId 归一（single uuid / pair 对桶） |
| 独立私信 | user 桩 onStandalone（host-web.ts:138 同位） | requestId | pairKey(agent,user) 对桶 |
| 群消息 | ctx.on('group/message-posted')（groups-row emit；载荷入参化——入参缺席回落既有单参形态） | post requestId（g- 前缀） | gid |

扩展方式：新源 = 宿主装配点 ctx.on(事件) → counter.bump(conv, key)——源语义（过滤/键提取）住各源挂点，计数器不知源。

### RPC 面（web-api 注册）

| RPC | 语义 |
|---|---|
| session/unread | takeAll：返回全表 {conv: {n, lastTs}} 并清零落盘 |
| session/mark-read | 定向清：{conversationId} → n=0 落盘 |

前端 live 事件帧（run/settled · router/message-received · group/message-posted）照常广播——前端徽章实时 +1 不依赖同步周期；take 与 live +1 的时序竞争由前端「live 键集吸收」处理（take 返回后清 live 键集，其后到达的帧重新计）。

### 前端显示面

| 行为 | 设计 |
|---|---|
| 启动/重连对齐 | feed init + WS 重连 → session/unread take → 水合徽章 |
| 慢周期兜底 | 在线期间每 10min take 一次（帧丢失兜底） |
| live +1 | 三事件帧到达且非当前会话 → 本地 +1（乐观增量，cr-1139 语义） |
| 点开即清 | setActive* → session/mark-read + 本地清 |
| 群徽章 | gid 轴（群分区键同构） |

## 三、分批切分

| 批 | 内容 | 文件面 |
|---|---|---|
| 1 | 纯库换血：unread.ts → 计数器（bump/takeAll/markRead + 幂等） | ac-core-utils |
| 2 | host 三源挂点 + RPC（session/unread take-all + session/mark-read 定向清） | ac-host-webui |
| 3 | 前端徽章面重建（store + take 对齐 + live +1 + 点开即清 + 组件角标） | ac-client-ui-conversation |
| 4 | 收尸：session-index 未读派生面退役 + 文档重写 | ac-session-index + docs |

批间依赖：1 → 2 → 3 串行；4 独立（可与 3 并行）。

## 四、测试标准（过程门）与验证目标（目的态）

| 批 | 测试标准 | 验证目标 |
|---|---|---|
| 1 | typecheck + 包内单测 + check:deps | bump 幂等（同 key 重复事件不双计）；takeAll 清零落盘；markRead 定向清；损坏留档；version 1 旧文件作废（读为空表） |
| 2 | typecheck + web-api 单测/e2e | 三源各触发一次 → 计数各 +1；重投不双计；take RPC 返回并清零；mark-read 落盘 |
| 3 | typecheck + conversation 包全量 + build:channel + webui:typecheck | 重连后徽章水合离线累积；live 帧 +1；点开即清；慢周期 take 不回退本地清零 |
| 4 | 同上 + pnpm test 全量 | session-index 无未读词汇残留；session-design §11 重写为计数器方案；归档注记 |

收官判据：验证目标全达 → 本档归档 archive/session/，session-design.md §11 重写。
