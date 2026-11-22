# 会话键词法学与 run 起源计划（conv-key-lexicon-plan）

> 性质：实施计划——会话键词法学单源纯库（键形解析/身份拆解）+ run-origin 契约词汇化，收口键词 5 案与 run 身份反推 5 案。
> 状态：已实施待归档（B0~B5 + 收官全达 cr-1238~1242 2026-11-22——3437 单测 + 99 集成 + webui:build + 守门 ✓；词汇表已移交 session-design.md §「会话键词法学」）· cr-1236 2026-11-22（立项分析：cr-1237 对 cr-1116~1234 七活跃日聚类）
> 读者：新会话设计讨论与实施者——动手前先加载 agentchat-dev 技能；先读 §一/§二，裁决 §五，再按 §六 分批执行。

## 一、背景与根因

### 1.1 键词 5 案（词法判定 = 身份判定的四面手工副本）

| cr | 症状 | 失守点 |
|---|---|---|
| cr-1120 | listIds 无差别并入 agent~agent/sub_/subcalls 键，118/1220 条脏清单，前端幻影分区 | 键形词法（uuid 形 vs 对桶 vs sub）无判词 |
| cr-1137 | presence 未就绪窗口 uuid/sub 形帧误落 direct 对桶 | 同上（路由对称收口） |
| cr-1179 | uuid 判词单源 packages/ac-ledger/src/user.ts（壳行与宿主 singles 行同源） | 只统一了 uuid **判词**，未统一**解析** |
| cr-1186 | isAgentIdentity 词法多义误伤 user 虚拟身份 | 保留字判词单义化 |
| cr-1192 | single 键（uuid 形）split('~') 单元素命中自身，uuid 串被当「对话方」嵌进归档文案 | 解析在无 ~ 键上的行为未定义 |

### 1.2 run 身份反推 5 案（run 的语义身份靠行特征猜）

| cr | 症状 | 反推面 |
|---|---|---|
| cr-1133 | 盲区 run（空终稿/伪 run）误投为 user 发言 | 从行完整性反推 run 性质 |
| cr-1140 | 无 ts 孤儿 run 双投致 live agent 侧幻影 | 从 ts 有无反推盲区 |
| cr-1179 | 机制注入触发的 run 也是 user source，title.set 噪音 | 从 source 反推发起方 |
| cr-1187 | 机制触发 run 计时锚陈旧 viewer 消息，数十小时读数 | 从最近行反推计时锚 |
| cr-1192 | single 会话「对话方」称呼 | 从键形反推对端（与 1.1 同案两面） |

### 1.3 分散度实测（2026-11-22）

| 面 | 量 |
|---|---|
| split('~')/键形解析 | 12 包 107 处（宿主 ac-agents/ac-conversation/ac-session-index… + 前端 ac-client-ui-* 三包） |
| 键词法判定（startsWith('sub_')/~user 等字面量） | 511 处命中（宿主/前端双面） |
| 已单源 | uuid 判词 packages/ac-ledger/src/user.ts；保留字 packages/ac-agents-core/src/tree.ts isReservedEndpointId（cr-1175 D6） |
| run 元数据 | packages/ac-envelope-core/src/stream.ts runMeta?: Record<string, unknown>——弱类型袋子，无 origin 词汇 |

## 二、现状锚点

| 实体 | 位置 | 说明 |
|---|---|---|
| uuid 判词 | packages/ac-ledger/src/user.ts | cr-1179 单源（uuid 形会话键判别） |
| 保留字/身份谓词 | packages/ac-agents-core/src/tree.ts | isReservedEndpointId（cr-1175 D6）/isAgentIdentity（cr-1186 词法单义） |
| 前端解析副本 | packages/ac-client-ui-conversation/client/（chatOps/feed-core/routeDialog 词法闸 cr-1137）、packages/ac-client-ui-agents/client/ | 判据与宿主各写各的 |
| run 契约 | packages/ac-envelope-core/src/stream.ts | runMeta 弱类型；StreamMeta 全程携带先例（cr-1188） |
| run 生命周期现行档 | docs/design/session/run-status-state-machine.md、run-lifecycle-checkpoints.md | origin 字段落点需与其对齐 |
| unread 锚先例 | cr-1141（锚归 runId）、cr-1157（三源事件 bump） | origin 消费面的既成方向 |

## 三、终态设想（cr-1238 落锤稿）

架构骨架 = **三层权威 + 一个地址投影**——每类问题只有一个合法可问处：

| 层 | 职责 | 形态 |
|---|---|---|
| 词法层（键库 ac-conv-keys） | string → KeyShape「这串字符长什么样」——纯语法、总函数、闭集 | parseKey() 判别联合 + 谓词族派生 |
| 登记层（registry，cr-1213 既成） | key → 会话语义「这个会话是什么」——创建点单写，只读 | 语义消费问登记层，键形只做存量降级 |
| 溯源层（run-origin） | run → 成因「为何存在」——触发面盖章 | origin/source 正交双维 + 账本行持久化 |
| 地址层（保持现状） | shape → bucket 路径投影 | 键形当地址（可读可 grep），不咨询语义 |

设计检验三问（任何代码写完过一遍）：问「这串字符长什么样」→ 只准问 parseKey；问「这个会话是什么」→ 只准问登记层；问「这个 run 为何存在」→ 只准读 origin。**任何用上一层答案回答下一层问题的代码 = 未来 cr**（1.1/1.2 十案无例外）。

要点：
1. **键库**：parseKey 返回纯 shape 判别联合（uuid/pair/group/sub/plain），总函数任何串有档（cr-1192 类未定义行为在类型上不可能）；pair 不携带语义主张（gid~member 键面不可辨——cr-1213 公理）；谓词族派生自 parse（语法糖）。
2. **run-origin**：LoopRunRequest.origin 一等字段（闭集枚举，终表 B1 触发面盘点后定——bench 已证草案有漏）；origin 与 source 正交（机制 × 拓扑，cr-1179 病根）；**origin 随账本 run 行持久化**（读侧消费面——归档文案/计时锚/回放——从行读，不从直播管道读）；旧 run 反推降级保留兼容路径。
3. **守门**：全仓键形解析收敛到键库单点，白名单外 grep 零命中（check 守门先例 cr-1196）；re-export 兼容层迁移期内保留，收官清零。

## 四、非目标

- 不改键形本身（不发明新键形、不改 post-office 登记制——cr-1213 已收口）。
- 不重构 routeDialog/名册架构——只换判词源，行为不变。
- run-origin 不追溯补写历史 run（旧 run 走反推降级）。

## 五、设计裁决（cr-1238 2026-11-22 落锤）

| # | 题 | 裁决 | 依据 |
|---|---|---|---|
| D1 | 键库宿主 | **新纯库包 ac-conv-keys**（ac-wire-format 形态：零依赖零 node:、前后端同源直 import）；core-utils 四函数（runAddress/pairKey/participantsOfKey/memberStreamKey）迁入并 re-export 兼容 | core-utils 桶导出被 4 文件 node:fs 污染（groups/persona/unread/workspaces），前端 barrel import 必撞 build:channel 纯度门；27 个既有消费方全为宿主行包；其收录判据「会成环的那一小块」不适配整族词法 |
| D2 | 词汇面 | **parseKey() 纯 shape 判别联合（uuid/pair/group/sub/plain）+ 谓词族派生自 parse**；pair 不带 kind/scope 语义字段（两段拆分是语法事实，可携 left/right） | 消费面两类：分类型（session-index/chatOps 要 kind）与拆解型（feed-core 要 [a,b]）——纯谓词满足不了拆解；语义字段入词法层 = 越权（cr-1213 不可辨公理）；总函数消灭 cr-1192 类未定义行为 |
| D3 | 保留字谓词迁址 | **isReservedEndpointId/isAgentIdentity 本体迁入键库**，agents-core re-export 兼容；三处创建闸调用点不动 | 依赖方向唯一可行：键库 re-export agents-core 会拖 fs+rowset 重量入纯库；谓词概念本属端点/键词法域；本体纯谓词零 fs 耦合（寄居 tree.ts 而已），消费面实测仅 5 文件 |
| D4 | run-origin 词汇 | **LoopRunRequest.origin 一等字段（闭集枚举）**；各触发面自带声明 + loop 入口对缺席者按 source 盖缺省章；StreamMeta 不加字段（runMeta 管道 cr-1188 已通，前端经键库 helper 读）；**origin 随账本 run 行持久化**；枚举终表待 B1 触发面盘点 | loop 入口无法分辨 timer/archive/bench（只有触发面知道）；meta 弱类型袋子正是本计划要收口的病；只进直播管道则读侧（归档/回放/计时锚）仍反推——同族 bug 在归档路径复活 |
| D5 | 存量收敛 | **渐进 + check 白名单守门**（cr-1196 先例）：新代码强制 + B3/B4 批次即渐进单元 + B4 完白名单清零转硬门 | 实测迁移面 ~70 处 ~25 包（单源消费 131 处零改动）；全量一炸不可审；每包行为不变重构、现有用例即回归网 |

裁决时核实增量（相对 §二 锚点）：键词法半成品已在 core-utils（cr-318/376/1213 下沉）但前端不可达；origin 管道已通（runMeta 全程透传）；bench 为草案枚举漏掉的第 6 个已存触发面。

## 六、分批切分

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|
| B0 | 设计裁决会：§五 落锤记回本档 | 无代码 | 五题各有裁决与理由 |
| —— | 执行实况（cr-1239~1242）：B3 迁移 13 包 + apps 双 boot + 守门补扫（QueueDockHost/RunStatusDockHost 两 .vue、collab-tools:239）；B5 origin 提取判据 = payload.meta.origin 声明优先 → payload.mechTask 在场 → viewer 兜底（信封层无 source 字段）；守门 scripts/check-conv-lexicon.mjs（白名单 14 文件）；B4 注：build:channel 已演进为 webui:build/build:bundle | | |
| B1 | 三表盘点进本档附录：①键形态全仓盘点（uuid / a~b / sub_ / g- 群 / 保留字 / 大小写与特殊字符规则）②调用点分类表（每个 split/startsWith 判词点标注问形状/问语义/问地址 → 迁移去向）③run 触发面盘点（origin 枚举终表依据）；词汇面定稿 | 无代码（盘点脚本可留 sandbox/） | 三表覆盖全部实际键形态与触发面，无「未见过键形」盲区；每个迁移点有分类无悬空 |
| B2 | 键库实现 + 回归用例（1.1 五案 + 盘点新边界案） | 验证阶梯（typecheck/test:unit/check:deps + 定向 lint） | 五案回归锁绿；词法单义（cr-1186 类误伤不再可能） |
| B3 | 宿主侧迁移：ac-ledger/ac-agents/ac-conversation/ac-session-index/ac-host-rows（按 B1 盘点表逐包） | 同上 + 契约面全量 pnpm test | 行为不变（现有用例全绿）；迁移包内 split('~') 清零 |
| B4 | 前端迁移：ac-client-ui-conversation/ac-client-ui-agents/ac-client-ui-runview | 同上 + pnpm webui:typecheck + pnpm build:channel | routeDialog 行为不变（cr-1137 用例仍绿）；前端键解析单源 |
| B5 | run-origin 契约化：ac-envelope-core 字段 + 发起点写入 + 消费面切换（cr-1133/1140/1187 判据改读 origin） | 同上 + test:integration | 三源（viewer/timer/archive）真实数据根 origin 可查；反推降级路径有用例 |

## 七、收官判据

验证目标（§六）全达 → 本档迁 docs/design/archive/session/；键库词汇表移交现行档（session-design.md 补节或键库包内文档）；re-export 兼容层清零（core-utils/agents-core/ledger 旧入口下线）。

——与 ledger-invariants-plan（cr-1235）独立可并行；键库 B1 盘点可先行（无代码风险）。

## 八、B1 盘点附录（cr-1238 2026-11-22，扫描脚本 sandbox/b1-inventory/）

### 表 A：键形态全集（无「未见过键形」盲区）

| 键形 | 词法 | 签发源 | 消费面（代表） | 备注 |
|---|---|---|---|---|
| uuid（singles） | `[0-9a-f]{8}-…-{12}` v4/v7 | ac-envelope-core issueConversationId（宿主）/前端 issueLocalConversationId | singles-row/listIds/routeDialog | 判词现 3 副本：ac-ledger user.ts、前端 dialogIdLex.ts、session-index、wire-format/unread-axis |
| pair `a~b` | 两段非空（含 `a~a` 对角线） | pairKey(a,b)（44 调用） | feed-core/unreadStore/usage/fold | **键面不可辨**：`gid~member` 群成员流与群 runAddress `gid~aid` 同形——语义归登记层（cr-1213 公理） |
| 群 `g-<gid>` | 单段 g- 前缀 | 群创建面（assertGid 不强制前缀，运行面恒 g-） | session-index/memory/wire-format/chatOps | g- 是否入 assertGid 属群行裁决，键库只判形 |
| sub `sub_*` | 单段前缀 | ac-shell-subagent spawn 铸造 | collab-tools/chatOps/jobs | 子 Agent 会话键 |
| plain | 单段其余（裸 agent id 回退） | runAddress 缺省 | runview 直答桶 | 总函数兜底档（cr-1192 防线） |
| 保留字端点 | `host`/`user`/`@` 前缀 | —— | 创建闸 3 处 + 名册投影 | isReservedEndpointId/isAgentIdentity/isMechanismEndpointId（D3 迁入键库） |
| src convKey（计划外发现） | `chat~a~b` / `group~gid(~aid)` / `single~uuid` | 前端 runs 视图派生（runview convKeyOf） | runview convKeyToId | **前端视图命名空间，非会话键族**——不迁键库；B4 在 runview 内局部单源 parseConvKey 并注释声明异族 |

### 表 B：71 判定点分类（33 文件；问题类型 → 迁移去向）

| 类 | 点（代表） | 数量 | 迁移去向 |
|---|---|---|---|
| 问形状 → 谓词/parseKey | chatOps:78-92、feed-core:188-500、unreadStore、conversation-block:29、goal:183、timers-row:803、host-web:144、agents/service:129-142、shell-conversation:116、usage:580-642、memory:342、session-index:131-136、import/legacy+writer、collab-tools:136、wire-format/bridge-events+unread-axis、agents-core/tree:81、core-utils/groups:35 | 51 | B2 键库谓词/parseKey（core-utils 两处 = 本体随 D1 迁移） |
| 形状 + 段成员资格混合 | fold:340、web-api:172（`split('~').includes('user')` 判 viewer 端点）；archive:142/860（pair 两段找 this.agentId 域归属） | 6 | parseKey + 键库导出 pairIncludes(key,id) 类谓词（段成员资格 = 形状事实，非语义） |
| 非会话键用途（误收编警戒） | llm-pool session-affinity（requestId 哈希同形）、envelope-core issue.test（uuidv7 签发自测） | 2 | 不迁移；check 白名单注明同形不同义 |
| 测试断言 | singles-row.test:479-482、wakeup.test:31、session-query.test:57 | 5 | 改用键库谓词写断言 |
| src convKey 前缀解析 | runview:511-513 | 3 | B4 runview 内 parseConvKey 局部单源 |
| 前端 uuid 正则副本 | dialogIdLex:11（+3 处引用） | 4 | B4 删副本改 import 键库 |

### 表 C：run 触发面盘点（origin 枚举依据；source:'event' 声明点 10 包）

| 触发面 | 包 | 现 source | origin 候选 | 备注 |
|---|---|---|---|---|
| viewer 直答 | shell-conversation（chat 入口） | 'user' | viewer | 缺省对照面 |
| 归档整理 | shell-rows/archive、ledger/fold | 'event'+ARCHIVE_REVIEW_META | archive | B5 改读 origin，meta 兼容期保留 |
| 评测跑批 | bench | 'event'+ARCHIVE_REVIEW_META+'bench-case' | bench | 草案枚举漏掉的第 6 面 |
| 定时唤醒 | timers-row | 待核（唤醒信经投递面） | timer | B5 核 source 实值 |
| 子 Agent | shell-subagent | 'event'（部分） | subagent | sub_* 键族关联 |
| goal 自动轮 | goal | 'event' | goal | |
| 后台任务唤醒 | jobs/wakeup | 'event' | job | |
| 交互回投 | ask-questions | 'event' | interaction | |
| 机制注入（上下文/技能/记忆/终端） | shell-conversation、memory、collab-tools | 'event' | mechanism | cr-1179 病根面——auto-title 消费 origin 后静音 |

origin 枚举候选终表（B5 定稿）：`viewer | timer | archive | subagent | bench | goal | job | interaction | mechanism`；loop 入口缺省章：origin 缺席时按 source 盖（'user'→viewer、'agent'→viewer（委托方视角）、'event'→mechanism）。