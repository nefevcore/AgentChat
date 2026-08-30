# 群聊投递单通道化设计（group single-channel delivery）

> 状态：定稿 v3（方案已确认，待实施）
> 日期：2026-08-17
> 背景：8/4、8/8、8/16、8/17 四次「消息重复」事件；8/16 修复（末尾字符串去重）在 8/17 被「合并块头部」场景击穿。本文档论证：内容对账式修复只能打地鼠，根治方案是让群消息内容只走一条通道。
>
> 方案演化（决策记录）：
> - v1：持久化游标（Kafka offset 模式匹配）→ **否决**：参与者每个 run 全量重读日志尾部，"消费位置"由重读自动确立，持久账本无真实职责；
> - v2：纯通知 + run 作用域锚点 → 保留骨架；
> - v2.1：触发点信封（全文+契约随消息同行）→ 契约位置实测价值被确认，但信封绑定契约导致 busy 重复携带；
> - **v3（定稿）：契约机制化（runStartHook 注入）+ 触发消息位置作为 A/B 变量**。契约从 router 文案升级为钩子注册表一等公民；信封读回路径删除；busy steer 免契约。

---

## 1. 问题回顾：为什么去重修不完

### 1.1 现行架构是「双内容通道 + 事后对账」

```
send_group / WebUI group.message
        │
        ▼
GroupManager.deliverGroupMessage (group.ts:208)
        │
        ├─① emit group.message.received ──→ GroupService.saveGroupMessage (group-service.ts:74)
        │                                      └─ appendFileSync 追加 sessions/group~<gid>/messages.jsonl 【通道 A：持久历史】
        │
        └─② 对每个参与者 emit group.trigger ──→ Router._wireGroupTriggers (router.ts:267)
                                                  └─ 构造含全文的 hint <msg …>payload</msg>+时间+契约文案
                                                     → trigger() → steer / pending              【通道 B：即时投递】
参与者 run 启动：
  loadGroupHistory 读通道 A（合并相邻对方发言）
  + 通道 B 的 hint 注入
  = 同一条消息两次进入 LLM 上下文
  → run.ts makeLoadHistoryHook 用【字符串匹配】把 B 已带的段从 A 剔除   【对账层】
```

### 1.2 对账层的固有脆弱性（打地鼠记录）

| 不变量 | 维护方式 | 已被击穿方式 |
|---|---|---|
| router 的 `<msg>` 封装与 loadGroupHistory 封装逐字一致 | 跨文件注释约定 | 任一侧改格式即静默失配 |
| hint 消息位于历史可匹配边界 | 假设"新消息=历史末条" | 8/17：接收方 run 迟到，他人回复先落盘，合并块把 hint 段挤到块首 |
| 两次 getName 解析一致 | 注册表即时查询 | 改名/查询失败 → 封装漂移 |
| 内容等价 = 同一消息 | 字符串比较 | 用户真的连发同文（8 月初群聊测试"晚上好"×22）无法区分 |

**只要内容进两条通道、靠字符串合流，这类修复就没有终点。**

### 1.3 现有的 ID 已经在铸造，但在最后一米丢弃

- `GroupService.saveGroupMessage`（group-service.ts:83）：`message_id = correlation_id ?? genMessageId()` ——持久行有身份；
- WebUI 入群路径（ws/handler.ts:1412）已铸造 `webui-group-*`；
- **send_group 工具（agent-tools/tools.ts:69）没传 correlation_id**；
- `deliverGroupMessage` 把 `correlation_id` 传进了 group.trigger（group.ts:233），但 `_wireGroupTriggers` 调 `trigger()` 时**没有带进 RunStartMeta**（router.ts:290-300）——身份在 trigger 边界被丢弃。

### 1.4 落盘时机（v3 的事实基础）

`deliverGroupMessage` 两步 emit 均为 Node EventEmitter **同步调用**：`group.message.received` → `appendFileSync`（同步写）→ 完成后才 `group.trigger`。**通知到达时消息必然已在盘上**——"通知后取历史"在时序上无条件成立。已知边角：空 payload 跳过落盘但 trigger 照发（极 edge，新方案下成员不可见）；落盘失败仅 warn 不阻断（下次消息自然补齐视角，无需特殊处理）。

---

## 2. 目标架构：内容单通道 + 纯通知 + 契约钩子（v3）

### 2.1 核心原则

> **群聊本体文件是群消息内容的唯一事实源。trigger 只携带"该去读了"的通知，不携带内容。群聊行为契约（怎么回/直接输出无效/沉默权/不刷屏）由 runStartHook 机制化注入——有迹可循，重构不可无声丢弃。**

### 2.2 为什么不需要持久化游标（v2 推导，保留）

| | Kafka 消费者 | AgentChat 参与者 |
|---|---|---|
| 消费者重读日志吗 | 否（状态在应用侧，位置必须持久记账） | **每个 idle run 都全量重读日志尾部**（loadGroupHistory，30k 限额保留最新） |
| "消费位置"存在哪 | 必须持久化 | **由每次重读自动重新确立**，无需账本 |

逐路径验证：

| 路径 | 需要什么 | 持久游标？ |
|---|---|---|
| idle 收通知 → 新 run | loadGroupHistory 现有全量尾部加载即包含新消息（§1.4 顺序保证）；通知只需唤醒 | ❌ |
| busy 收通知 → run 运行中 | 增量 =「本 run 上下文构建之后新落盘的部分」→ 需要**锚点**，跟着 ctx 走：runStart 记录、steer 后推进、run 结束即弃 | ❌（run 作用域内存态，ctx.meta['group.sync']） |
| run 崩溃 | 内存锚点丢失无妨——下次触发新 run，全量加载重新对齐 | ❌ |
| 重启 pending 重放 / 重复触发 | pending flush → idle 全量加载自对齐；重复触发 busy → 锚点已过 → 读空跳过；重复触发 idle → 唤醒新 run，历史里只有一份（最坏良性空转，内容不重复） | ❌ |

### 2.3 数据流（v3）

```
deliverGroupMessage
  ├─ mint correlation_id（唯一铸造点，入口处，缺省生成）
  ├─① emit group.message.received → appendFileSync 本体（带 id）          【唯一内容通道】
  └─② 对每个参与者 emit group.trigger —— 载荷只含 {gid, from, message_id, summary60}
        │
        ▼
Router 通知处理器：
  ├─ idle：trigger() 开 run
  │     ├─ runStart（按 meta['chat.start'].source.kind === 'group' 识别群聊触发）：
  │     │     ① loadGroupHistory 加载尾部（现有逻辑，含触发消息）
  │     │     ② 【契约钩子】注入群聊行为契约到 history 尾部（不落盘）：
  │     │        收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——
  │     │        直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，
  │     │        请注意不要刷屏。（逐字保留实测文案）
  │     │     ③ 记录锚点 ctx.meta['group.sync'] = {gid, message_id, line}
  │     │        （与历史读取同钩子内完成 → 原子，无竞态）
  │     └─ currentMessage = 按 deliveryVariant（见 2.4）
  │
  └─ busy：从 running map 取 activeCtx（契约已在其上下文）→ 读锚点 → GroupFeed.readSince(锚点)
        ├─ 空 → 跳过注入（双发通知天然幂等）
        └─ 非空 → steer = <msg>增量</msg>（共用构造器，【不带契约】）
              → 推进锚点（同 ctx 内存操作）
```

### 2.4 契约钩子与触发消息位置（A/B 变量）

**契约机制化（定案）**：契约文案从 router.ts 的字符串拼接迁移为 runStartHook（如 `agent-session.group-contract`），注册表自带 label/description，与 build-system-prompt / load-history 同族可见。注入位置：history 尾部之后、currentMessage 之前（上下文倒数第二区）。role='user' + source={kind:'group', form:'notice'}（与消息契约类型一致；不落盘——history 数组操作，不经 writer；不用裸 system role，Anthropic 系不接受 messages 中段 system）。

**契约可配置（2026-08-17 增补）**：`agent.group.groupContractText`（per-Agent，config.json 命名空间或 UI 钩子面板编辑）覆盖正典；空串/缺省回落 `GROUP_CONTRACT_TEXT`（contracts 正典，I11 快照锁定默认值）。helper `groupContractTextOf(config)`（@agentchat/agent-config）为 group-contract 钩子与 router legacy hint 共用——两路径、每 Agent 独立文案，支持"更好的文本提示"实验（建议按 Agent 分组做 A/B，观察沉默率/回复质量）。独立命名空间 `agent.group`（GROUP_CONFIG_SCHEMA 单字段）：钩子弹窗只显示本域字段，不与 agent.session（归档/上下文管理）混排。

**注入条件**：`meta['chat.start'].source.kind === 'group'`（kind+source 识别）。busy steer 不重复携带契约（该 run 上下文已有一份，同 run 内几百 token，注意力衰减轻微）；next-turn 连跑新建 ctx 时 meta.source 透传 → hook 照常注入，自洽。

**触发消息位置（A/B 变量，实测裁决）**：三个排布理论上无法裁定（当年"放消息内"是实测结论，现在契约与内容拆开，排布重新开放）：

```
今天/legacy：  [历史][<msg>全文</msg> + 契约]              ← 契约绝对末位
variant tail： [历史-剔除触发id][契约][<msg>全文</msg>]      ← 内容末位、契约倒数第二
variant history：[历史(含触发消息)][契约][极简通知]          ← 契约末位、内容在历史尾部
```

- `group.deliveryVariant = 'tail' | 'history'`（配置开关，默认建议 `history`——构件最少）；
- `tail`：currentMessage = `<msg>全文</msg>+[当前时间]`；历史加载时按 **id 集剔除**触发消息（构造时路由决策，非事后字符串对账）；
- `history`：currentMessage = 极简通知（from + summary60 +「全文见上下文最新历史」）；触发消息只经历史进入，**连剔除逻辑都不需要**——上下文天然恰好一份；
- 验收：真实群 A/B 各跑 ~1 周，指标 = 沉默率（无价值消息不回复）/ 回复质量 / token 消耗；赢家定稿后删另一 variant。

### 2.5 格式单一事实源

`<msg from name group>` 包装、own 消息跳过、相邻合并——从 loadGroupHistory（session.ts）抽成独立构造器（`groupMessageView()`），消费方：

| 消费方 | 输入段 | 输出 |
|---|---|---|
| loadGroupHistory | 全量尾部（tail variant 时剔除信封 id 集） | 历史上下文（含合并） |
| busy steer / tail currentMessage | 锚点之后 / 触发消息 | 注入内容（无契约） |
| read_history 等工具 | 任意窗口 | 展示 |

从此"router 封装与 session 封装逐字一致"不再是不变量——**只有一个封装函数**。

### 2.6 分层与接口

Router（agents 层）不直接读文件（L4 才碰磁盘）。接口由 host/server 侧 GroupService 实现、boot 装配注入：

```ts
// contracts 层
export interface GroupFeed {
  /** 锚点之后的增量（已按共用构造器包装）。空增量 injected='' */
  readSince(gid: string, anchor: { message_id?: string; line?: number }): Promise<GroupFeedPage>;
  /** 当前文件尾锚点（最新一行 message_id + 行号） */
  currentAnchor(gid: string): Promise<{ message_id?: string; line: number }>;
}
```

锚点定位：优先 message_id 找行，失配回退 line，再失配回退时间戳窗口（为 Phase 2.5 本体轮转预留）。

### 2.7 与 1v1 的关系（明确不动的部分）

1v1 已是事实上的单通道：入站消息作为 currentMessage 进入 run（一次性），writer 在 run 内持久化（幂等性已修复：toPersisted 固化 id + writer 引用守卫）。不纳入本次改造。

---

## 3. 迁移路径（每步可独立发布、可回滚）

### Phase 1 — ID 贯通（解锁步，独立有价值）

| 改动 | 位置 |
|---|---|
| `deliverGroupMessage` 入口统一铸造 `correlation_id`（缺省 genMessageId()），所有路径（send_group 工具/WebUI/未来入口）都带 id | group.ts:208 |
| `_wireGroupTriggers` 把 message_id 带进 RunStartMeta.sourceMeta | router.ts:290 |
| makeLoadHistoryHook 去重键从「字符串段」升级为「message_id 集合」（字符串匹配降级为兜底） | run.ts |

**回滚**：单点还原三处，行为退回字符串去重。

### Phase 2 — 通知化 + 契约钩子 + A/B 开关（核心）

| 改动 | 位置 |
|---|---|
| `GroupFeed` 接口 + GroupService 无状态实现（readSince/currentAnchor） | contracts / group-service.ts |
| boot 装配注入 Router | boot/loader.ts |
| **契约钩子**：`agent-session.group-contract`（kind=group 注入，文案逐字保留，不落盘） | agent-session + hooks 注册表 |
| `groupMessageView()` 构造器抽取（三处共用） | session.ts |
| `_wireGroupTriggers`：载荷去内容化；idle → currentMessage 按 variant；busy → readSince → steer（无契约）→ 推进锚点 | router.ts |
| runStart：锚点记录 ctx.meta['group.sync']；（tail variant）历史剔除信封 id 集 | run.ts |
| `group.deliveryVariant` 配置 + `group.delivery = 'notify' | 'legacy'` 总开关 | 配置 |
| 增量 token 上限：超限保留最新 + 头部「另有 N 条更早消息，可用 read_history 查看」 | GroupFeed 实现 |

**回滚**：`group.delivery='legacy'` 一键回到现状 hint 路径（保留一个发布周期）。

### Phase 2.5 — 恢复群本体轮转（✅ 2026-08-17 已实施：轮转+摘要；记忆整理编排为后续增量）

| 改动 | 状态 |
|---|---|
| 阈值检测（group.archiveTokens，默认 50 万，config.json group 节）+ 本体轮转：旧消息 → sessions/group~<gid>/archive/history_N.jsonl（temp+rename 原子重建，全程同步 fs 与落盘同 tick 无交错）| ✅ GroupService.maybeArchiveBody |
| summary_N.md 机械摘要锚点 + loadGroupHistory 头部注入（截断后注入，始终在场；超压时正文先丢、摘要保留） | ✅ withArchiveSummary |
| 归档前全员记忆整理编排（pending/done 标记，复用 1v1 归档模式） | ⏳ 后续增量（memory.md 自发更新仍在，非阻塞） |

### Phase 3 — 拆除与定稿

| 改动 | 位置 |
|---|---|
| A/B 定稿，删输家 variant 及 tail 的 id 剔除逻辑（若 history 胜） | router.ts / run.ts |
| 删除 `stripHintSegmentsFromHistory` 字符串对账层；去重测试转译（块首/块中/块尾场景 → 「上下文恰好一份」断言） | run.ts / group-hint-dedup.test.ts |
| pending 队列群通知存无内容形态；redeliverPendingTrigger 走通知路径 | router.ts |
| read_history / 群管理工具文案补充通知语义 | session-tools / agent-tools |

### 工作量

| 阶段 | 规模 | 主要风险 |
|---|---|---|
| Phase 1 | ~0.5 天 | 低 |
| Phase 2 | ~1.25 天（钩子 + readSince + 双 variant + 开关 + 测试） | 低-中：busy 注入时序（锚点与历史同钩子完成，竞态面已消除）；A/B 期间行为回归观察 |
| Phase 2.5 | ~0.5 天 | 低（旧实现可参考） |
| Phase 3 | ~0.5 天 + A/B 观察 ~2 周 | 低 |
| 合计 | ~2.75 天（不含观察期） | |

---

## 4. 新不变量与测试矩阵

| # | 不变量 | 验证 |
|---|---|---|
| I1 | 每条群消息恰好一个 correlation_id，在 deliverGroupMessage 铸造 | 单元：send_group/WebUI/直调三路径落盘行均带同源 id |
| I2 | LLM 上下文中的群消息只能源自本体文件读取（trigger 载荷不含群消息正文） | 结构测试：group.trigger 载荷 schema 无 payload 字段 |
| I3 | 锚点初始化与历史加载原子（同一钩子内）；busy 增量不含已加载消息 | 单元：runStart 后注入 M2 → 上下文 M1（历史）+ M2（steer）各一次 |
| I4 | 空增量不注入（双发通知幂等） | 单元：同消息两次通知 → 第二次 readSince 空 → 无 steer |
| I5 | run 崩溃 → 下次触发全量加载重新对齐（无持久化状态可损） | 集成：kill -9 后重启触发 → 上下文各消息恰好一次 |
| I6 | 8/17 现场不再复现 | 回归：速递+迟到回复场景 → 上下文单份 |
| I7 | steer 注入不丢尾（末轮非空继续） | 已有 loop 行为保证 + 单元断言 |
| I8 | 增量超限截断 + 提示行 | 单元：注入含「另有 N 条」且 token 有界 |
| I9 | own 消息在增量中不包装、与历史行为一致 | 对齐 loadGroupHistory 行为快照 |
| I10 | pending 重放幂等（重启 flush → idle 全量加载自对齐） | 集成：shutdown 入队 2 通知 → 重启各消息恰好一次 |
| I11 | 契约由钩子注入：kind=group 触发、文案与 legacy 逐字一致、位置在历史尾部之后；busy steer 不携带契约 | 单元：kind 判定注入/不注入；快照：契约文本逐字节对比；busy steer 无契约段 |
| I12 | 上下文中每个群消息 id 恰好出现一次：history variant 天然成立（无剔除逻辑）；tail variant 经 id 集剔除成立 | 单元：两 variant 各断言触发消息 id 计数 = 1 |
| I13 | 契约注入不落盘（不进 messages.jsonl / 周归档） | 单元：run 后本体文件无契约文本 |
| I14 | A/B 验收：两 variant 沉默率/回复质量/token 对照，定稿后删输家 | 真实群 ~1 周/variant，观察记录进本文档附录 |

---

## 5. 风险与开放问题

1. **本体文件无限增长（迁移回归，非原设计）**：v0.4.x 旧架构有完整群聊归档（group-archive.ts，随五层重构删除）：deliverGroupMessage 检测总 token 超 groupArchiveTokens（默认 50 万）→ .archive_pending → 触发全体真实 Agent 整理轮（要点写 memory.md）→ 全员完成 → 旧消息移入 groups/<gid>/archive/history_N.jsonl + summary_N.md 摘要锚点 + 重建本体保留 ~30k。迁移后替代物"周归档"只承载分析复盘（每 Agent 全量含思考/工具、append-only），**本体轮转、摘要锚点、归档前整理编排三项被静默丢弃**——ArchiveService 显式跳过群聊（index.ts:462"另有周归档机制"），注释把两种功能混为一谈。现状本体 897KB/2650 行持续增长。v3 锚点协议（id → line → 时间戳回退）已按轮转就绪设计；Phase 2.5 恢复（~0.5 天），归档移到 sessions/group~<gid>/archive/（与周归档同根，享受群删除清理）。
2. **多 Agent 并发读同一本体**：只读 + append-only，无锁安全；锚点在各自 ctx，无共享状态。
3. **通知与落盘顺序**：同步 emit 保证通知到达时行已在盘（§1.4）。
4. **WebUI 展示**：meta.hint 降级为摘要后，前端事件条显示摘要——视觉变化，发布说明提及。
5. **重复触发最坏代价**：一次良性空转（LLM 调用无新内容可答），内容不重复；实测频繁再评估投递侧按 message_id 去重（优化项，非正确性依赖）。
6. ~~中途入群回灌~~ 已定：默认即"入群后从当前尾部开始"（新 run 全量加载带最近 30k，天然有限），不 backfill。
7. **凡走 deliverGroupMessage 皆同协议**；无旁路写本体的代码（已核查）。

---

## 6. 结论

- 现行"双内容通道 + 字符串对账"是 8/4→8/17 全部重复事件的共同根因结构，逐场景修补不可收敛；
- v3 单通道化（本体=唯一内容源、trigger=纯通知）使重复**构造性不可能**；
- **契约机制化**（runStartHook，kind=group 识别）：实测行为契约（沉默权/不刷屏/怎么回）从 router 文案升级为注册表一等公民，busy 免重复携带，重构不可无声丢弃；触发消息位置（tail/history）作为 A/B 变量由真实行为裁决；
- 无持久化游标：参与者每个 run 全量重读尾部，消费位置由重读自动确立；唯一状态是 run 作用域锚点（ctx.meta），随 run 生灭；
- 四阶段迁移（1 → 2 → 2.5 → 3）每步可独立发布与回滚，总投入 ~2.75 天 + A/B 观察期；
- 1v1 已是单通道形态，不纳入改造。
