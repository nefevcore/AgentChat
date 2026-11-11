# 协作投递缺口报告（send_agent / send_group，cr-711 附带核查）

> 性质：~~待办报告，不是裁决~~ → **已收口（cr-712，见 §6）**。发现于 cr-710/711 修「子 Agent 完成回执」
> 时的同族核查；本轮只修 subagent，collab 两工具按用户指示留待后续讨论。
> 核查基线：2026-10-26 工作树（cr-710 + cr-711 已落）。
> 复现探针：`sandbox/probe-collab.ts`（隔离数据根，现役壳装配）。

## 0. 结论（一句话）

`send_agent` 与 `send_group` 目前**都送不出去**（不是「有回声」，而是投递面
没接通）；一旦接上，它们会与 subagent **同病**——对端终稿按 R-2 回信唤醒
双方对桶会话，LLM 有消息必回 → 互答链（cr-710 后由信封 budget 限流，
但不是消因）。正确的完成语义已在 cr-711 为 subagent 落地：**完成回执不进
会话机，结果转投发起会话（self 发起、replyTo=user）**。

## 1. send_agent：三处断点（按命中顺序）

| # | 断点 | 位置 | 实测/推演 |
|---|---|---|---|
| 1 | `ctx.agents.has` 不存在 | 壳侧 `AgentsShim` 只有 `get/settingsOf/list/reassign`（`packages/ac-shell-rows/src/shims.ts:17-73`）；工具调 `ctx.agents.has(to)`（`packages/ac-collab-tools/src/index.ts:149`） | 探针实测：`{"ok":false,"error":"ctx.agents.has is not a function"}` |
| 2 | `session.history` 不存在 | 壳侧 `SessionShim` 只有 `recordContext`（`shims.ts:319-337`）；工具调 `session.history(convKey,{viewer})`（`ac-collab-tools/src/index.ts:243`） | 补上 #1 后必抛 `history is not a function` |
| 3 | 跨壳投递被自己消费 | `ConversationService.deliver` **不看 `to`**：构造 `to=目标` 的信封后直接喂本壳 `receiveEnvelope`（`packages/ac-shell-conversation/src/service.ts:216-257`） | 消息只写进**发送方**账本并让发送方自己跑一轮；对端壳永远收不到 |

旁证：现役数据根里顶层 Agent 的对桶会话（如 `designer/sessions/admin~designer`）
**只在一侧存在**，与「自己消费自己」一致（子 Agent 对桶两侧都在，因为那是
两条独立的子壳/父壳账本，不是同一条投递）。

接上之后（设计层面的必做项，与 cr-711 同款）：

1. 对端终稿不得走「唤醒发送方 pair 会话 → 再回信」；应转投 `call.conversationId`
   （发起会话），并令其 `replyTo=user`（本壳终稿面向用户，不回投对端）。
2. 若对端忙：完成通知走 steer/queue，不得顶掉当前 run 的会话键。
3. 对端失败（`finish=error`）要带失败文案（沿用 `notifyLateReply` 的失败分叉）。

## 2. send_group：壳内不可用 + 接上后的两个语义缺口

- `group` 是 **host 行**（`apps/catalog/row-catalog.json` tree=host，实现
  `packages/ac-host-rows/src/groups-row.ts`）；壳侧无 `group` 服务、无 shim。
  探针实测：`群服务（ac-group 行）未装载——send_group 不可用`。
- 接上后（host `group/send` 扇出，`groups-row.ts:298-325`）：
  1. **串键**：扇出信封 `uuid = gid~member`；成员终稿经通用 `postReply`
     回给 `sender`，但信封 `uuid` 仍是**被回复成员**的成员流键——发送方账本
     会多出一个本属于该成员流的会话目录（跨成员流键污染）。
  2. **回声链**：该回信唤醒发送方 run，其 R-2 终稿再回给成员 → 群内互答。
     主线对此有 group 桶预算规则（`packages/ac-conversation/src/service.ts:746-750、797-808`：
     群桶内 agent 来源不重置预算），壳侧没有等价物。
- 需要裁决的语义（三选一或组合）：
  - **A** 成员终稿只落自己的成员流（`gid~member`），不回投 sender——群内容
    由全成员流合并读面（`group/history`）呈现，最贴合「群是广播、不是 1v1」；
  - **B** 成员终稿经 host `group/send` 以「成员身份」扇出回群——最像真人群聊，
    但需要群级预算/收敛规则（防 A、B 互答）；
  - **C** 保持 1v1 回投 sender，但把完成语义按 cr-711 处理（通知回发起会话，
    不在群成员流里起新 run）。

## 3. 与 subagent 的关系

- 三者共用同一条「完成回执」语义缺口；cr-711 已把 subagent 的路径收紧为
  「对桶只落账 + 结果转投发起会话」。
- `send_agent` 的子 Agent 分支（`to=sub_*`）走的是 `ctx.subagents.send`（旧主线
  服务面），与当前 `ac-shell-subagent` 的 `sendOp` 不同形——这个分支也随
  send_agent 一起待裁决（本轮未动）。

## 4. 复现与验收命令

```powershell
# 壳内 collab 面现状（应看到 has 缺失 / 群未装载）
node --experimental-strip-types sandbox/probe-collab.ts

# subagent 完成回执（cr-711，应 PASS：子1 / 对桶父0 / 发起会话父1 / 无幽灵身份）
$env:AGENTCHAT_NO_BRANDED_EXE='1'
node --experimental-strip-types sandbox/repro-subagent-completion.ts
```

## 5. 备注

- 探针与脚本都在 `sandbox/`（gitignore），只服务本地验证，不入库。
- 上述断点均为**现役代码**事实，不是历史主线行为的推演；修复时任选一处
  都会立刻暴露下一处（#1 → #2 → #3 顺序已按调用链排列）。

## 6. 修复裁决与落点（cr-712，2026-10-27）

> 本节把 §1–§5 的待办收口为裁决记录；§1–§5 保留为发现时的现场。

### 6.1 send_agent 三处断点全接通

1. **断点 #1**：`AgentsShim` 补 `has(id)`（'user' 保留虚拟端点放行——主线
   workspace 恒注册、盘上无目录）。
2. **断点 #2**：`SessionShim` 补 `history(conv, { viewer })`——转发壳 ledger
   读面；`LedgerService.historyFor` 加 `viewer` 参（replayView 投影单源，
   缺省仍 = 本壳 agent）。
3. **断点 #3（根因）**：`ConversationService.deliver` **看 `to`**——目标非
   本壳 agent 时信封经邮局 dispatch（新公开 `sendEnvelope`：与 postReply
   共用断链重试单源），本壳只落自己的出站行；不再喂本壳 receiveEnvelope
   （「构造 to=目标 的信封后自己消费」的根因消除）。outcome 新词 `sent`
   （受理即返——跨壳无同步回复通道，wait 语法糖对跨壳自然退化为异步）。
   无邮局形态（CLI 直连）fail-loud。owned-child 目标拒绝走此面（子 Agent
   任务消息归 subagent 工具直投分支）。

### 6.2 完成语义（cr-711 泛化到跨壳委托）

- 任务信封带 `replyConversation`（发起会话键，collab-tools 从
  `call.conversationId` 传入；主线 `ConversationDeliverOptions` 增词汇但不
  消费）；对端 postReply 回信**原样回带并打 `completion: true` 标记**。
- 发起方壳收到带标记回信 → 与子 Agent 回执同款：对桶只落账 + 结果转投
  发起会话（通知文案 `[Agent X 回复]`，replyTo=user——本壳终稿面向用户，
  不回投对端）。
- **标记只在回信上打，任务信封只带 replyConversation 不带标记**——判据
  混用会把委托任务当回执吞掉（对端根本不执行；测试已锁定两形态）。
- 对端忙：完成通知走 machine.plan 的 steer/queue（不顶当前 run 会话键）。
- 对端失败：error 收束常无终稿文本，跨壳 Agent 收信人此前被空文本跳过 =
  发起方永远不知道委托失败——现合成 `[执行失败：…]` 随回信（user 收信人
  维持空文本 run 键行语义不变）。
- sub_ 分支（§3）：`ac-shell-subagent` 补主线消费面 `get`/`send`
  （sendOp 薄包装；conversationId 即回执发起会话键；elevation 无落点忽略）。

### 6.3 send_group 裁决：方案 A（群是广播，不是 1v1）

- 壳侧新增 **`GroupShim`**（ctx.group，随 shell-data-root-shims 装配，
  makeShimsRow 增 postOfficeAddress）：读面走群配置纯读单源
  （`GroupConfig/readGroupConfig/listGroupConfigs/assertGid` 从
  ac-host-rows/groups-row **下沉 ac-core-utils**——垫片 import 宿主行包即
  壳→宿主反向依赖）；send 面 = 发送方自留言（自己成员流，群读面 =
  全成员流合并，缺此行自己发言不可见）+ 逐成员信封扇出（同 requestId =
  合并读面去重锚，与宿主 group/send 同形）。
- 扇出信封带 **`broadcast: true`** → `replyTargetOf` 返回 null：成员终稿
  只落自己成员流、**不回投发送方**。§2 的两个语义缺口（串键：发送方账本
  多出成员流目录；回声链：回信唤醒发送方再回群）同因消除，无需群级
  预算规则。群内容呈现归全成员流合并读面（group/history）。
- **与主线验证流程的一致性（2026-10-27 复核补全）**：A 禁的是 R-2 通道的
  **自动**回投（正是 §2 两缺口之因），从不禁成员主动发言——主线 M26
  验证有效的形态是「成员被唤起后**主动调用 send_group** 回群、回声靠
  提示调控」，A 下该链完整保留（send_group 对任何成员可用）。补齐缺失的
  提示半边：
  - `GROUP_CONTRACT_TEXT` 正典自退役 src/ac-group（git f2d89cd2~1）单源
    复活，落 ac-core-utils 群词汇模块（文案冻结——修改需过真实群沉默率/
    回复质量验收）；per-Agent 覆盖 `settings['group'].contractText`
    （主线 contractFor 同语义）。
  - collab-tools 在群会话 run（成员流键 gid~自己 / 本体键 gid）且
    send_group 在场时，经 loop/before-run 注入决策点：
    `[群聊 gid「name」]` + 契约（回复走 send_group——方案 A 下「直接
    输出文本不会发送到群聊」是字面事实；无话可说保持沉默、不刷屏）。
  - 系统提示指引 #6（「群聊协作：先 list_groups 再 send_group」）本就在
    现役 ac-system-prompt 随行注入（list_groups+send_group 门控）——两处
    合力即主线「提示调控回声」的完整形态。

### 6.4 验证

- 单测：ac-shell-conversation（跨壳 deliver / 完成回执泛化 / 任务信封非
  回执 / broadcast 不回投 / 失败文案，6 例）、ac-shell-rows（has / history /
  GroupShim 读写面与扇出）、ac-shell-subagent（get/send 适配面）。
- e2e 探针：`sandbox/probe-collab.ts` 升级双壳（alpha/beta）+ 邮局真 ipc——
  send_agent 全链（beta 一轮 run、alpha 对桶零 run、回执落发起会话、无
  互答）+ send_group 方案 A（自留言 + 成员流终稿 + wire 无回投帧）。
- 回归：cr-711 复核脚本（repro-subagent-completion.ts）PASS；全仓
  typecheck / lint / 相关 38 测试文件 204 例全绿。
