# IM 白名单方案交接（im-delivered-flag-handoff）

> 性质：交接——排除法 IM 过滤改白名单（投递标记行集）的方案裁决、事实清单与实施入口。
> 状态：已实施并真机验证 · cr-1332 2026-11-26 done（§2.3 终稿裁决：打标、值 = delivered:'final' 独特标记；验证记录见 dual-view-session-plan.md §六）。
> 读者：后续维护 IM 白名单词汇的开发者（回退判据与风险清单索引）。

## 一、背景与裁决

### 1.1 排除法的结构性缺陷（用户裁决 2026-11-26）

dual-view P2 的 IM 视图（`view:'im'`）现行实现是**排除法**：`foldViewRecords` 的 `imRow` 逐类剔除
（partial 步行 / context 注入卡 / 机制 event / 机制 run 终稿〔origin 字段 ∪ runId 词形兜底〕 / subagent-done-reply 转发副本）。
这是**不断增长的开放集合**：每引入一个新机制类型（未来新的系统 run 种类）都要追加排除判据，
漏一个就污染 IM 流——cr-1331 三次追加修复（origin 分流 → 词形兜底 → 转发剔除）就是这个循环的实证。

### 1.2 白名单方案（用户提案，已论证可行）

**改取特定消息行**：给「用户经 deliver / send_agent / send_group 通道发出的真实消息」在落账时打标，
前端 IM 视图只取**打了标的行集**。新机制类型缺省不打标 → 天然不进 IM——封闭集合，零长期维护。

## 二、关键事实（实施前必读——本会话已核实的链路）

### 2.1 通道投递在账本上的真实形态

一切经邮局/通道的真实投递，**在收件方账本上都是入站行**（壳侧 `receiveEnvelope → deliverRow`）：

| 发送路径 | 收件方账本上的行 | 构造点 |
|---|---|---|
| user 直答 deliver | agent 账本入站行（`agent_id='user'`） | `ac-shell-conversation/src/service.ts` `inboundRowOf`（L1270-1280） |
| user 群发 send_group | 各成员流入站行（`agent_id=from`） | 同上（groups-row 扇出信封 → 成员壳 receiveEnvelope） |
| agent→agent send_agent | 对端账本入站行（`agent_id=sender`） | 同上 |
| agent→user send_agent | **user 域入站行**（cr-1344 起由 user 桩落账 `agents/user/sessions/<uuid>/`——`agent_id=sender`、`delivered:true`；出站行已退役，存量经 `scripts/migrate-outbound-user-rows.mjs` 一次性迁入） | `apps/host/user-stub.ts` receive（宿主进程——user 域唯一写者） |
| run 终稿回信 postReply | 对端账本入站行（回信信封） | postReply L1676+ → 对端 receiveEnvelope |

### 2.2 打标方案（推荐落点）

**`inboundRowOf` / 出站行构造点加 `delivered: true` 字段**（词汇增量，读侧可见）：

- 位置 A（入站行）：`ac-shell-conversation/src/service.ts` `inboundRowOf` 的非机制分支（L1279）——
  覆盖 deliver / send_group 扇出 / send_agent 入站 / postReply 回信入站四路（它们全走 `receiveEnvelope`）；
- 位置 B（出站行）：同文件 deliver 跨壳分支 L492-498（`agent_id=sender` 出站行）——**已随 cr-1344 退役**（agent→user 方向出站行退役：user 桩是 user 域唯一写者，IM 从 user 域入站行读；agent→agent 委托出站行维持打标——「IM 语义应有自己发出的消息」风险 #4 注记对其仍成立）；
- 位置 C（群 send_group 本地回显）：`ac-host-rows/src/groups-row.ts` group/send 的 post 行——group/history 已是该流，标记主要服务前端直播行识别；

机制行（`payload.mechanism === true`）**不打标**（它走 context+event 分支，天然漏过——白名单的封闭性由此成立）。

### 2.3 终稿行要不要打标？（裁决已落定——cr-1332 实施）

<!-- cr-1333 扩围注记：用户参与注入行（steer 插话/ask 作答）另行打标进 IM——见 §三风险 1 翻转记录 -->

**裁决（用户 2026-11-26）：打标，但值用独特标记 `delivered: 'final'`**（区别于通道投递行的
`delivered: true`）——便于观察打标/不打标的效果。

实施语义：终稿 = run 对触发者的正式回信——settle 写面按 origin 门控（`viewer`/`interaction`
交互成因打标；机制成因缺省不打，宁漏不误）；前端终稿气泡带「已投递 · 终稿」徽标（观察面）。
当初的选项 1/2 之争由独特值 + origin 门控收口——单一判据 `delivered` 字段。

### 2.4 存量数据（关键约束）

打标是**写面增量**——存量行（含用户正在看的 admin~tester 等历史会话）没有 `delivered` 字段。读侧策略必须裁决：

- 读侧 `delivered === true` 直取（新行）∪ **存量回退排除法**（`imRow` 现行逻辑作为 fallback，delivered 字段缺席的会话）——渐进迁移，两法并存期间排除法代码不删（判据见 2.5）；
- 或一次性数据迁移（migrate 工具给存量行补标——判定规则 = 排除法逆运算，工作量大且有误标风险，**不推荐**）。

推荐前者：读侧判据 `row.delivered === true || (会话内无任何 delivered 行 → 回退 imRow)`——按会话级切换，
新会话天然纯白名单，老会话维持现状（排除法），零迁移。

### 2.5 判据落位（读侧）

- `foldViewRecords` 的 im 档分支（`ac-ledger/src/fold.ts`，cr-1331 改造处）：先扫会话是否含 `delivered` 行
  （fold facts 或直接行扫一次），有 → 白名单模式（`delivered === true` 的行，含 error 行〔失败须可见〕）；
  无 → 现行 `imRow` 排除法兜底；
- ViewRow 类型（`ac-ledger/src/view.ts`）增 `delivered?: boolean` 词——与 turnId 同款「读侧派生不落盘」例外相反，
  **本字段是落盘词**（写面打标），类型住 LedgerRow（`ac-ledger-core/src/records.ts`）+ ViewRow 透传；
- 前端 `historyApi.toHistoryMessages` / 群 `expandGroupRecord` 透传（`PGroupRecord` 增词）。

### 2.6 前端直播（P2 已做的抑制逻辑保留）

im 档直播抑制（llm/delta / tool/started 早退——feed-core cr-1331）与白名单正交，不动：
直播期 IM 只显示 streaming 态，终稿由 run/settled 重拉补——重拉走读侧判据（2.5），自动进入白名单模式。
入站消息的直播行（router/message-received / group/message-posted）天然是「通道投递」——前端直播行可直判 `delivered`
（帧载荷透传该字段需在 wire 桥 `ac-host-webui/src/host-web.ts` message-received 广播处补——次要，可后补）。

## 三、风险清单

| # | 风险 | 缓解 |
|---|---|---|
| 1 | ~~steer 注入行（busy 用户的插话）也是通道投递但走 inject 行~~ **已翻转（cr-1333，用户裁决 2026-11-26）：steer 插话与 ask 作答（用户参与消息）并入 IM 档**——`loop/inject-consumed` 落账点按 `injectSource ∈ {steer, durable-interaction[answered]}` 词表打 `delivered:true`；材料类注入（skill/memory/datetime）与超时通知（outcome=timeout）不打标。词表开放规约住 `ac-ledger/src/service.ts` USER_PARTICIPATION_INJECT。 |
| 2 | 机制 run 终稿在选项 1 下 settle 按 origin 门控——origin 缺席的存量壳（第三方写面不知道约定）误打标 | 写面缺省**不打标**（opt-in 语义）：settle 仅在 origin ∈ 交互成因或缺席且 replyTo 为 user 时打标；宁可漏（回退排除法兜底）不可误 |
| 3 | 群成员流的入站行打标后，group/history 合并读面（P1 已带 steps）也要透传 | `GroupMessageView` 增词——小改 |
| 4 | `deliver` 出站行（agent→agent）在发送方账本也打标 → 发送方 IM 视图显示自己发的话（合理——IM 语义应有自己发出的消息） | 语义正确，非风险，记录即可 |

## 四、验证目标（收官判据）

1. 新会话（有 delivered 行）：IM 档 = 纯 `delivered` 行集（含终稿、入站、出站、error）——grep 确认排除法分支零命中（该会话）；
2. 存量会话（无 delivered 行）：行为与 cr-1331 现状**分毫不变**（回退排除法）；
3. 轨迹档（chat）不受影响（delivered 字段对 chat 投影透明）；
4. 前端直播：im 档下新消息（打标行）正常出现，过程流照旧抑制；
5. 测试：ledger fold im 白名单/回退双模式用例 + 壳写面打标用例（deliver/inboundRowOf/settle 三点）。

## 五、实施入口（新会话从这里开始）

```
1. load_skill agentchat-dev + load_skill cr → 读本档
2. 登记 CR（本档 cr-1332 已立 plan——沿用号，set doing）
3. 写面三刀：
   a. ac-shell-conversation/src/service.ts inboundRowOf L1279 非机制分支 + deliver 出站行 L492-498 → + delivered: true
   b. 同文件 settle 调用 L777：origin 交互成因（viewer/interaction）或缺席且 replyTo=user → 终稿行打标（选项 1；风险 2 的 opt-in 缺省）
   c. ac-ledger-core/src/records.ts LedgerRow + view.ts ViewRow + 前端 PSessionRecord/PGroupRecord → delivered?: boolean 透传链
4. 读侧一刀：fold.ts im 档分支 → 会话级 delivered 在场探测 + 白名单模式 / imRow 回退
5. steer 注入行裁决（风险 1）：读 ac-ledger 注入行写面后定（注入行打标 or 判据补充）
6. 验证阶梯：pnpm typecheck && pnpm test:unit + ledger/conversation 定向 + 双构建配对 + restart_host（宿主侧 fold）
7. 真机走查：新会话发消息 → 切 IM 档验白名单；开 admin~tester 验回退不变
8. 收口：cr-1332 set done + 状态板 + 本档归档
```

## 六、相关档案

- 设计档：`docs/design/webui/dual-view-session-plan.md`（P1-P5 + cr-1330/1331 全记录——§六 运行时验证记录）
- 现行排除法实现：`packages/ac-ledger/src/fold.ts` imRow（cr-1331 双源判据）
- 打标写面：`packages/ac-shell-conversation/src/service.ts`（inboundRowOf L1270 / deliver 出站 L491 / settle L777）
- CR：cr-1324~1331（dual-view 全链）
