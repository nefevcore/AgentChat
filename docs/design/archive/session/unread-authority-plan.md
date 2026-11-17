# unread-authority-plan（未读服务端权威源实施计划）

> 性质：实施计划——把前端纯计数未读改为服务端权威源 + 读位持久化 + 对账归一。
> 状态：已实施归档（cr-1146 落地——终态规格并入 session-design.md「未读权威源」节） · cr-1145 2026-11-17。
> 读者：接手本计划的实施者（换会话继续时先读本档 + cr-1144 详情）。

## 一、背景与根因

### 现状（cr-1144 收口后）

未读仍是**纯前端 live 帧计数态**：`feed-core.ts` 的 `bumpUnread`（WS 帧驱动）+
localStorage `agentchat.unread` 快照（cr-1139 写穿，跨刷新恢复）。计数路径已收口为三源：
`run/settled`（一轮回复 = 1）、独立私信（`router/message-received`，cr-1144 起 user 桩
发射）、群消息（`group/message-posted`）。

### 根本缺口

| 现象 | 根因 |
|---|---|
| 页面关闭期间的回复不补计 | 无服务端事实源——帧是投递即弃的瞬态，未投递即丢失 |
| 多端（webui/手机壳/remote-link）读位不互通 | 读位只住浏览器 localStorage，键空间单端 |
| 未读数与实际会话状态可漂移 | 快照是前端自己记的数，无对账、无纠偏 |

结构性原因：**「读了没有」是用户会话域的事实，却由渲染端各自记账**。服务端有全量
会话行（agent 域账本 durable 落盘），唯独没有「用户已读到哪」的持久锚。

## 二、终态规格

### 设计原则

1. **服务端只存读位，不存计数**——未读数 = 「会话最后事实行 vs 已读水位」的派生值。
   计数是投影，永远不落盘（避免双源走散：这就是 cr-1144 前双倍计数的教训面）。
2. **读位 = 会话键 + 行锚**——`readMark(conversationId) = { seq?, message_id?, ts }`。
3. **写口唯一**：进入会话即清（前端既有 `clearUnread` 语义），经 RPC 写服务端。
4. **多端归一**：水位单调取大（后读的端覆盖先读的，不回退）。

### 数据面

```
<dataRoot>/meta/unread.json
{ "version": 1,
  "entries": {
    "<conversationId>": { "seq": 123, "messageId": "m-abc", "ts": 1765xxx }
  } }
```

| 键 | 语义 |
|---|---|
| conversationId | 服务端会话键（1v1 = pairKey；single = sid；群 = gid）——与 feed 分区键同构 |
| seq | 该会话账本已见行级水位（B1 行锚；缺席 = 旧数据，回落 messageId 判定） |
| messageId | 末读行 id（refresh 后行无 seq 变化时兜底身份） |
| ts | 读位落定时刻（诊断/审计用，不参与判定） |

归位：`meta/` 域（用户域源数据——session/settings 同层）。写者 = 宿主 web-api 行
（RPC 面），读者 = history 首屏响应旁带。

### RPC 面（两个）

| RPC | 语义 |
|---|---|
| `session/mark-read` | `{ conversationId, seq?, messageId? }` → 水位单调取大落盘 |
| `session/history`（扩展） | 首屏响应旁带 `{ unreadCount, readMark }`——前端刷新即对账 |

未读计数派生（服务端，纯函数住纯库）：`unreadOf(conversationId) = 账本行数(新于水位)`。
群 = post 行流；1v1/single = agent 域账本发言行。

### 前端消费面（feed-core）

````
初始化：history 首屏 → unreadCount 覆盖分区 unread（替代 localStorage 水合）
live 帧：bumpUnread 维持现状（权威 miss 的乐观增量——对账面纠偏）
进入会话：clearUnread → 改调 session/mark-read RPC（本地即时清 + 服务端落水位）
对账：每次首屏响应用服务端值覆盖（帧丢失页关闭期间的产生在此补计）
````

localStorage `agentchat.unread` 退役：多 tab 收敛面（watchUnreadSnapshot）随之拆除，
对账统一走服务端首屏。

## 三、分批切分

| 批 | 内容 | 文件面 |
|---|---|---|
| 1 | 纯库：读位文件读写 + 未读派生纯函数（`unreadOf`）+ 水位合并语义 | 新包或
`ac-ledger` 内新模块（读面邻居） |
| 2 | RPC：`session/mark-read` 注册 + `session/history` 首屏旁带 unreadCount/readMark | 宿主
web-api 行（`ac-host-webui/src/web-api.ts`）+ 壳侧 history 桥 |
| 3 | 前端：feed-core 水合改服务端对账 + clearUnread 改 RPC + localStorage 退役 |
`ac-client-ui-conversation/client/feed-core.ts`、`unreadStore.ts` 退役 |
| 4 | 多端归一验证：双 tab + 手机壳（若在域）读位互推；水位不回退回归 | e2e |

批间依赖：1 → 2 → 3 串行；4 依赖 3。

## 四、测试标准与验证目标

| 批 | 测试标准（过程门——验证阶梯） | 验证目标（目的态断言） |
|---|---|---|
| 1 | typecheck + 包内单测 + check:deps | 水位合并单调不回退；孤儿会话键（已删会话）读位安全缺席 |
| 2 | typecheck + web-api 单测 + `pnpm webui:typecheck` | mark-read 幂等（重复调用水位不变）；首屏旁带数与账本行数一致 |
| 3 | typecheck + ac-client-ui-conversation 全量 + `pnpm build:channel` | 页面关闭期间的新回复，重开 + 首屏后未读数正确补计；localStorage 键不再写入 |
| 4 | `pnpm test` 全量 + e2e-host-web | 双端读位收敛：A 端读 → B 端刷新后未读为 0；后读不回退先读 |

收官判据：验证目标全达 → 本档归档 `archive/session/`，`session-design.md` 补「未读
权威源」节（域深设计归位——本档只是计划）。

## 五、裁决记录（实施时不再议）

1. **不存计数只存读位**——计数是派生投影，落盘即造双源（cr-1144 双倍计数教训）。
2. **读位住 `meta/` 不住 agent 域**——「用户读了没有」是用户域事实，非 Agent 会话
   事实；agent 域账本是 Agent 的发言记录，写权归壳。
3. **水位合并 = 单调取大**——多端并发读，后读覆盖先读；seq 缺席回落 messageId。
4. **live 帧计数保留为乐观增量**——对账面（首屏覆盖）纠偏，不做帧级权威化（WS
   投递即弃语义不变）。
5. **localStorage 快照退役**——cr-1139 的多 tab 收敛面职责整体移交服务端对账。

## 六、开放问题（实施时裁决）

☐ 群未读读位锚定 post 行流还是成员流？（本计划缺省 post 行流——与前端群分区
   内容源同构）
☐ `unreadOf` 派生的账本扫描成本（长会话）：是否需要 seq 索引旁路（B1 行锚已有
   seq——大概率直扫够用，量级验证留批 1）
☐ 手机壳（mobile/）是否同期接 mark-read——若不在本计划域，记 handoff。
