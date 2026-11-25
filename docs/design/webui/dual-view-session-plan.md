# 多 Agent 会话双视图设计（dual-view-session-plan）

> 性质：实施计划——多 Agent 会话前端展现的形态泛化与双视图（IM 投递事实投影 × 轨迹 run 因果投影）设计：背景根因 / 终态规格 / 分批切分。
> 状态：已立项 · cr-1324 2026-11-25（设计提案落档；实施批次待逐批登记 CR）。
> 读者：动会话读面 / feed 前端 / send_agent 工具面 / user 桩的开发者。

## 一、背景与根因

### 1.1 问题

多 Agent 会话（群聊、agent⇄agent、subagent）的前端展现有两个结构性病灶：

1. **形态特判层积**：存储 / 投递 / 键词法 / fold 投影四层已形态无关（single / pair / 群成员流全是标准桶），但读面三口分立（`session/history`、`fetchPairHistory`、`group/history`——各持合并逻辑），前端 `DialogKind` 三态特判散布（`convergeDialog` / `scheduleSettlementReload` / `showInbound` 的 `kind === 'group'` 早退）。泛化缺口不在地基，在读面与分区。
2. **并行 run 交错**：群聊消息并行投递到各成员流，run 在时序上相互交错。线性时间流把 N 条无因果关系的 run 链压扁成一条伪因果链（A 的第 3 步与 B 的第 2 步之间无因果关系，却按 wall-clock 交织）——混乱是投影选择的失败，不是数据的失败。

### 1.2 关键裁决（设计立场）

群现状 = **IM 视图的原型**：`group/history` 消费投递事实（入站行 + post 行），是「最初的群聊构想」的残余形态——它不是残缺的轨迹视图，是被当成唯一形态的另一种合法投影。由此终态不是「把轨迹塞回群的线性流」，而是**同一日志 × 两档投影可切换**。

### 1.3 深挖实证（2026-11-25，cr-1324）

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| `send_agent(to:'user')` 已放行（M18）——工具不拒绝、返回引导语 | `ac-collab-tools/src/index.ts` L277-299 | 无需改工具校验面 |
| 出站行落 **agent 域账本**（`deliverRow`，`agent_id=sender`，requestId 锚） | `ac-shell-conversation/src/service.ts` L471-499 | agent 侧事实已在盘——IM 读面 user 侧无需新落盘 |
| user 桩收信面纯通知（cr-973 起 viewer 停写——「本桩不再写任何消息文件」） | `apps/host/user-stub.ts` 头注 | **消息本体零落 user 侧** = 唯一真实存储缺口 |
| 非回信信封（`payload.run` 缺席）已发 `router/message-received` 直播帧 + 未读 | user-stub `receive` + host-web L167-181 | IM 直播与未读机制已有雏形 |
| `projectUserReplay`（cr-973）user 视角投影：双端账本并读、行时间戳归并——**会吐出 `send_agent(to:'user')` 的出站行** | `ac-ledger/src/project.ts` L77-93（`agent_id !== 'user'` 的 agent 自著行全投） | IM 读面挂点 = 现有单源投影，不是新写 |
| singles 注释与 user-stub 注释矛盾（「写同类目录」vs「不再写」） | `singles-row.ts` L395 vs user-stub 头注 | 注释陈旧面，实施批顺手校准 |

## 二、终态规格

### 2.1 双视图定义

| | IM 视图（缺省·居民视角） | 轨迹视图（上帝视角·开发者） |
|---|---|---|
| 消费行族 | 入站行 / 出站行 / post 行 / error 行 | 步相位行 + run-end + 终稿行 + tool-call 行 |
| 语义 | 投递事实流（谁在何时对谁说了什么） | run 因果轨迹 |
| 收敛协议 | **天然无临时态**（投递行 durable 即事实） | 现行全套（run/settled 重拉 + 探针） |
| 交错 | 无（离散消息事件） | run 折叠块收纳（见 2.3） |
| 前端 | 事件到达即追加（群分区现状同款） | 现行 feed 管线不动 |

### 2.2 IM 语义闭环清单（现状 → 缺口）

| IM 语义 | 对应物 | 状态 |
|---|---|---|
| 对等身份 | user 虚拟端点（cr-1175） | ✓ |
| 消息一等 | send_agent(user) 出站行 + user 入站行（镜像投递模式） | ✓ 盘上已有 |
| 1v1 / 群 / sub | pair 桶 / 群扇出 / sub 直投 | ✓ |
| 未读 / 失败 / 撤回 | unreadStore / error 行 / deleteMessage | ✓ |
| IM 读面 | `view:'im'` 档（fold 第五投影，与 chat/plain/lite 并列） | **缺**——分批补 |
| IM 视图切换 | display 层参数 | **缺** |
| 已读回执 / 在线状态 | — | 可选缺（非阻塞） |

### 2.3 轨迹视图的并行 run 排序语义（R2 搁置项的正面回答）

1. **run 是折叠单元**：跨流排序只发生在锚点级（发言行 / run 开始 / 终稿）；步级事件收纳进块内（块内序 = 成员流内序，天然全序）。交错被限制在块级，块级交错可读（如群里多人同时说话）。
2. **展示排序确定性**：终稿行落账 timestamp 跨壳进程有毫秒抖动——排序锚定法：发言/终稿按时间粗排，**同触发（同扇出 requestId）的兄弟终稿按成员稳定序（成员表序）定序**，消解毫秒抖动。
3. **去重域与排序域分离**：跨流重复的入站行去重保留一份；成员 run 行永不去重、各归各块（现有 `byKey` 逻辑显式化）。

### 2.4 形态 × 视图补齐矩阵

| | IM 视图 | 轨迹视图 |
|---|---|---|
| single / 1v1 | **缺**——补 user 侧 IM 读面（消息本体已在 agent 账本，读面挂点 = projectUserReplay） | 已有 |
| 群 | 已有（group/history 原型） | **缺**（R2）——补成员流轨迹读口 |

### 2.5 行为契约

- **1v1 IM 契约**：IM 视图开（缺省）时注入「回复用户请调用 send_agent(user)」——机制同 GROUP_CONTRACT_TEXT（M26 注入历史尾部触发消息之前）；打扰纪律（频率约束）同 cr-1291 教训入契约。
- **可靠性兜底**：run 收束且零 send_agent(user) → 终稿自动回投为 IM 消息（兼容旧 run）+ 探针监测缺席率；缺席率收敛前不撤兜底。
- **终稿语义重分工**：终稿 = run 工作总结（轨迹回放对象）；消息 = 选择说的话。契约里显式说明，否则轨迹视图读到空壳终稿会怪。

## 三、护栏（不做清单）

- 不改存储 schema 语义（全部读侧投影；user 侧零新落盘——复用 agent 域出站行）。
- 不建全局 seq 逻辑时钟（2.3 排序锚定法已覆盖）。
- 不动 LLM 回放形状（`replayTrajectory` 是上下文开关，与视图投影不同名不同义，勿共享词汇）。
- 不做虚拟滚动 / 双端分叉组件（承 cr-1298 裁决）。
- 机制注入（timer/技能/压缩轮）按 `injectSource`/`origin` 判别分流：不进 IM 消息流（防 timer 风暴淹没消息流、机制 run 终稿混入对话）。

## 四、分批切分

### 批次状态板（多会话接力进度事实源——每批开工标 ◐ + 登记该批 CR，收口标 ☑ + 回填 CR 号）

| 批 | 状态 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|---|
| P1 `group/history` fold 投影扩展 | ☑ cr-1325 2026-11-25 | 群读面成员终稿行经 fold 单源挂 steps/turnId/run/runMs（与 1v1 ViewRow 同构）；入站行恒终稿 | groups-row 新增回归例 + 定向 141 例 + typecheck/lint/deps + 双构建配对 | 群成员思维链/工具卡刷新不丢（cr-1265 §1.3 清账）；im 档/origin 分流归 P2/P4 深化 |
| P2 1v1 IM 读面 | ☑ cr-1326 2026-11-26 | fold 投影档 `view:'im'`（终稿剥 steps/剔注入卡与在途步，键族保留）+ web-api 白名单 + 前端 viewMode/toggleViewMode/头部切换按钮 + pair/single 全链路透传 | fold im 档测试 + feed-view-mode 2 例 + 全包测试 + 双构建 | 1v1 侧 IM 视图可切换；行键族同源（run/turnId 保留——双视图行身份恒同） |
| P3 IM 行为契约 | ☑ cr-1327 2026-11-26 | DIRECT_IM_CONTRACT 段（1v1 viewer 对桶 + send_agent 在场时注入——mid-run 主动通报教育，双轨并存：普通回复仍走终稿直出）；段位 356 登记 SECTION_ORDER；缺席探针裁决不加（契约效果属产品观测非正确性，兜底 = 现状 postReply 机制天然在场） | 契约段判定 3 例 + 全量 3756 例 | 零 send_agent 的 run 终稿仍达 user（postReply 现状保证）；契约教育增量能力不破坏现状回复 |
| P4 群轨迹读口（R2 解冻） | ☑ cr-1328 2026-11-26（P4a）；P4b 群直播过程流留观 | P4a：fetchPairHistory convKey 原序键 + openMemberStream + 群头「成员轨迹…」下拉 → openPairView(gid, member) 只读视角（思维链/工具卡/折叠栏全套复用）；P1 已解历史面（steps 随 group/history 刷新不丢） | member-trace 2 例 + 411 例 + 双构建 | 群成员思维链/工具卡下钻可见（历史面 + 下钻面）；P4b（群内直播过程流）按裁决留观——串台史风险 + P1 历史面已解主诉求 |
| P5 读口泛化收口 | ☑ cr-1329 2026-11-26（定界裁决：本批不做） | 核对结论：pair 读口已并 session/history（fetchPairHistory = 薄包装）；group 合并器保持独立（多流合并语义——不是待并债务）；DialogKind 群特判保留 = P4b 留观的正确事实表达（群无 run 临时态，早退仍正确） | 定界裁决记录 | 群特判退役的前置条件 = P4b；为做而做的泛化违反体量克制（写完即精简原则） |

顺序依赖：P1 → P4 可并行；P2 → P3 顺序；P5 最后（P1-P4 稳定后收口）。

## 五、风险与开放项

| # | 项 | 说明 |
|---|---|---|
| 1 | 直播帧广播面 | 群成员过程帧的服务端过滤口径（`isBackgroundSender`/self-pair）需 P4b 时逐帧核对（P4b 留观 cr-1328：P1 历史面已解 R2 主诉求——群成员思维链/工具卡经历史刷新与下钻两路径可见；直播过程流解封涉串台史〔2026-09-04 幽灵消息事故〕，需求实证再做） |
| 2 | mid-run 主动通报 | send_agent(user) 解锁的纯增量能力（agent 中途说话）——行为面红利，契约纪律同步立 |
| 3 | 双轨终稿/消息内容漂移 | 定义为特性（终稿=内部结论，消息=选择说的话）+ UI 互跳；不是对账问题 |
| 4 | 同触发兄弟视觉归因 | 线性轴上「谁在回应哪句话」的线索（回应标记/聚拢提示）留给交互设计裁决 |
| 5 | ~~注释矛盾校准~~ | ☑ cr-1329 已校准（singles-row 头注改述 cr-973 后的事实：元数据写者 = 本行，消息流写者 = 壳侧 agent 域账本） |

## 六、运行时验证记录（2026-11-26 走查）

宿主 23:58/00:07 两次换代（P1/P2 读面）+ 壳 00:16 换代（P3 契约段）后，浏览器实测（dev 数据根 `workspace/home`，端口 3830）：

| 项 | 观测 | 判定 |
|---|---|---|
| 前端产物装载 | 页面 200 / 控制台零 error / 零失败请求 | ☑ 双构建产物正确 |
| 视图切换控件 | `.thinking-switch` 两枚（思维链 + 视图档），轨迹态标签「轨迹视图」 | ☑ P2 控件上屏 |
| 切换真实生效 | 点切换：标签 → 「IM 视图」，`.chain-icon` 6 → 2（轨迹折叠链按 im 档剥 steps 归并）；切回：标签复原、链恢复 6 | ☑ im 档投影端到端成立（含双向可逆） |
| 群成员下钻下拉 | 仅群会话内渲染（`isGroup && members`）——走查会话为 1v1，未实地点击；键路径由 `member-trace.test.ts`（convKey 原序 vs pairKey 排序）+ 群行 141 例锁定 | ◐ 待群会话实地验观感 |
| 源码装载面 | `fold.ts` im 档 / `groups-row.ts` memberViewOf / `ac-collab-tools` DIRECT_IM_CONTRACT 三处均在活源码 | ☑ 装载无漂移 |

**IM 视图观感观察**（供后续调优，非缺陷）：切档后「轨迹视图」档内 6 条折叠链在 im 档归并为 2 条——终稿正文与用户行保留，说明 im 档把「同 run 的多步」正确坍缩为单条消息；若产品希望 IM 档保留「一次 run 一条气泡」的严格对应，需在 P4b 一并裁决（当前按 fold 行族投影，未做 run → 单气泡的重聚合）。

## 七、附录：本设计的深挖证据链

| 证据 | 文件 |
|---|---|
| send_agent 虚拟端点分支（M18 放行） | `packages/ac-collab-tools/src/index.ts` |
| 壳侧 deliver 跨壳分支（出站行落 agent 域账本） | `packages/ac-shell-conversation/src/service.ts` L448-500 |
| user 桩（收信纯通知 + 非回信直播帧） | `apps/host/user-stub.ts` |
| user 视角投影单源（吐出出站行） | `packages/ac-ledger/src/project.ts` |
| 群读面合并器原型 | `packages/ac-host-rows/src/groups-row.ts` L317-344 |
| 群分区早退特判 | `packages/ac-client-ui-conversation/client/feed-core.ts` L538/552/1996 |
| R2 搁置裁决原文 | `docs/design/archive/session/session-render-pipeline-plan.md` §八/1 |
