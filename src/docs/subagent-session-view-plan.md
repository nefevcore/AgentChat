# subagent 会话展示（运行跟踪点击 → 主区子 Agent 会话）实施计划

> 2026-12 制定。需求两条：①「运行跟踪」面板点击 subagent 调用行 → 主区展示该子
> Agent 会话；②子 Agent 落盘完整消息（思维链/工具调用与结果），支撑展示。
> 本计划是一次完整现状勘探的产物——所有锚点（函数名/行为/行号）经源码核对。
## 后记：三文件化落盘（2026-12，sessions 域 journal 裁决对齐）

sessions 域三文件拆分（messages/partials/subcalls，skill-injection-and-storage-vocab
§7/§10/§11）后，subagents 域单文件 <subId>.jsonl 的「收束一次性落盘」形态成为
仅存的例外——本计划 R2 的裁决（不做 partial）在单文件时代成立，但与 sessions 域
的 run journal 语义分叉：run 进行中无中间态（崩溃丢思维链）、run_code 子调用无档
案（子 Agent 开 programmatic 时子调用卡片永久消失）。对齐改造（service.ts 全面
三文件化）：

- **目录形态**：<root>/subagents/<subId>/（messages / partials / subcalls），
  与 sessions 同构；迁移 v3 subagents-dir（单文件 rename 入目录，读侧另有回退）。
- **run journal（partials.jsonl）**：loop/after-step 步行（result:null）/
  journal-inject（steer 消费点，ts 快照）/ tool-result 直调补行——事件订阅
  按 agent=<subId> 寻址（runLogKey 语义在子会话 = agent 单轴）。
- **settlement（executeRun 收束）**：journal 切段物化提升进 messages（注入行 =
  切分点，段行全带 run 键；无切分 = 整 run 单行 + run 键，与三文件化前同形）+
  partials 剔除；run-settled 判别行做原子提交标记。
- **subcalls.jsonl**：runCodeSubcall=true 的补行分流（UI 回放面，永不清理）。
- **崩溃恢复**：ensureMessages 触达时 recoverJournal（孤儿 run 投影为中断段行，
  补行并入 result；幂等）。
- **错误/中断收束一等化**：journal 物化使 run 做过的推理是会话事实（对齐 §10
  「全终态 settle」）；错误行 role=user + source=error（词汇 v2）。
- 展示面零改动：SubagentMessageLine 全形兼容（新增 run/injected/source 键可选，
  toHistoryMessages 照常消费）；subagents/history RPC 不动。

### 实测两连修（2026-12，会话 9dbcd3be）

1. **程序化传播失效**：injection 轴重构后 run_code 是 mode 工具（不进常规
   能力面），旧守卫 allowed.includes('run_code') 恒 false → 子 Agent 静默
   全量传统面。修复 = effectiveToolMode/narrowToolsByMode 单源化（与 router
   同口径）+ 常规面过滤补 injection 分流。
2. **沙箱数据根分叉**：子 run 无会话键（账本归 subagents 域——runLogKey
   契约），sandboxWorkdir fallback preset→数据根 ≠ 父会话工作区。修复 =
   spawn 快照工作区根进 SubagentRecord.workdir（持久化）→ 派生身份
   settings.security.workdir（沙箱链显式档）。request.conversationId 透传
   方案被否：会污染 ac-session 父账本簿记、usage 对账与前端 feed 分区
   （routeDialog 按 sid 命中——子步流串台父视图）。

## 零、前置：本轮行为更新对方案的影响（2026-12 工作树改动）

工作树含一批未提交改动（send_agent 修复 + run_code P0），与本方案直接相关的判定：

| 改动 | 对方案的影响 |
|---|---|
| 子 Agent 发信身份归一（send_agent 对桶 = `pairKey(parent, to)`；user 虚拟端点 = 父直答桶；兄弟直投按父判定） | 子的对外发言落**父口径 session 桶**（父会话视图已可见，`agent_id=sub`）。子会话文件 `subagents/<subId>.jsonl` 仍是"任务对话"单一事实源——**展示口径不受扰动，无需跨桶投影** |
| send_agent wait=false 空闲直达回复直返（`reply` 字段） | reply 在子的工具卡（ToolResult.output）里——steps 落盘后自然进子会话视图，零额外处理 |
| run_code P0（子 Agent 派生身份继承 code-exec——STRIPPED_TAGS 只剥 delegation/admin） | 子会话会出现 run_code 工具卡（摘要 + programHash）。落盘行 `steps[].toolCalls[].result` = ToolResult 原样（`unknown`），自然兼容 |

## 一、现状事实（关键锚点）

**落盘现状**（`src/ac-subagent/src/service.ts`）：

- `MessageLine` = `{ role: 'user'|'assistant', content, ts: number }`（L193）。
- `executeRun` 只写两处：run 开始时 user 行（L595-596，`frameTask` 包装首条）；
  收束后 `result.text` 非空才写 assistant 行（L699-702）。**无 reasoning、无
  steps、无工具调用记录**——展示面数据不够，即需求②。
- 但 `LoopRunResult.steps: LoopStepRecord[]`（ac-agent-loop contract L110-141）
  信息全量在场：text / reasoning / toolCalls+toolResults（一一对应）/
  textBeforeTools / reasoningMs / ts。**缺的只是落盘投影**。
- `ensureMessages`（L866）：jsonl → `LlmMessage[]`，回放口径 = 纯 user/assistant
  文本对；`history(id)`（L467）返回该回放形。
- 消息缓存 run 收束即回收（L546，磁盘为事实源）；单 run 串行（runLoop
  consuming 门）→ **无并发写风险**。
- `appendMessage` 同步 `fs.appendFileSync`，先于 `settle()` 内 `jobDone` 回调
  → **job/settled 帧到达时文件已写完**（视图刷新时序安全）。

**展示管线现状（可整体复用的渲染链）**：

- `toHistoryMessages(records: PSessionRecord[], conversationId)` 
  （`ac-client-ui-conversation/client/historyApi.ts` L89）：SessionRecord 形 →
  前端消息行；`steps[]` 按步展开（每步 agent 气泡 + 工具卡 + thinking 折叠栏
  + 步级 ts 稳定排序）。**只要子会话落盘行对齐 PSessionRecord 形，整套渲染
  零改动复用**。
- 后续链全现成：`pairMessageToChatMessage`（feed.ts L540）→ `buildTurns`
  （feed.ts L214）→ `useTurnDisplayItems` → `TranscriptList`（四视角共用
  消息区组件，B 路线抽取产物）。
- PSessionRecord 关键字段（historyApi.ts L26-62）：`role ∈ user|agent|assistant
  |error|tool|event`、`message_id`、`timestamp`（ISO 字符串）、`agent_id`、
  `steps[]`（content/reasoning/ts/textBeforeTools/reasoningMs/toolCalls[{id,
  name,arguments,result}]）。

**入口与主区视角现状**：

- 面板「子Agent 调用」树：`RunTrackingPanel.vue`（ac-client-ui-runview 行），
  数据 = jobBoard（`jobs/list` RPC + `job/started`/`job/settled` 帧驱动）；
  `subagentMeta(j)` 已解出 `subagentId/name/parentId`。行当前无点击行为。
- 主区视角选举：`main:perspective` 席位（order 小者胜 + active 谓词 + props
  工厂，`ac-client-ui-layout/client/perspectives.ts`）。pair 只读视角
  （runview 行注册，order 10，`uiStore.pairView` 态）是**同款需求的现成模板**。
- 让位兜底：runview 行 apply 内 watch 选中三元组（activeAgentId/activeGroupId/
  activeSingleId 非空变化）→ `closeTrackingView() + closePairView()`
  （owning 行自理，壳零域知识）。

**一个已确认的既有事实（本方案不依赖但记录在案）**：sub run 是
`agentLoop.run` 直连、conversationId 缺省 → 信封 source = undefined →
ws-bridge `isHiddenRun` 判 false → **子 run 的 llm/delta-\*、loop/step-\* 帧
今天就在全量广播**；前端 `routeDialog`（chatOps.ts L60：无 `~` 键回退
`directDialog(agent)`）把它们路由进 `pair:user|sub_*` 幽灵分区（preset 身份
不可选所以不可见，但流式管线完整写入）。这是 P1 live 流式的现成数据面。

## 二、设计裁决

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| R1 | 落盘行形 | **对齐 SessionRecord 中性格式**：`role: 'user'|'agent'`（agent 行带 `steps[]`/`reasoning`/`message_id`/`timestamp`(ISO)/`agent_id`）；旧 assistant 行宽容读取 | 一次落盘，前端 `toHistoryMessages` 整链复用（工具卡/思维链/步级时序全现成）；与主会话同词汇，不为子会话发明第二格式 |
| R2 | 步落盘时机 | **run 收束一次性落整行**（agent 行含全量 steps）。**不做** partial 步级落盘（ac-session 的部分行+补行+吸收机制不复刻） | partial 机制复杂度（收束行吸收、工具结果补行覆盖、中断恢复）远超 P0 收益；运行中视图显示已落盘 user 行 + "运行中"态即可。子 run 通常分钟级 |
| R3 | 视角组件 | **独立 `SubagentConversationView`**（复用 TranscriptList/useTurnDisplayItems），**不并入** ConversationView 第五形态 | 子会话不是对桶（a/b 端点语义不成立），历史寻址也不同（`subagents/<id>.jsonl` 非 session 桶）——ConversationView pair 模式的 `fetchPairHistory` 会拼错桶。复用渲染内核已拿到全部共享价值 |
| R4 | live 流式 | **P0 不接**：纯历史 + `job/settled` 帧驱动刷新（+ 手动刷新钮）。P1 接 `pair:user\|sub_*` 幽灵分区（与 pair 视角同构合并） | live 与历史的合并去重（收束行 vs 分区流式尾部）有时序毛刺，P0 不吞；数据面已确认存在（§一），P1 升级路径清晰 |
| R5 | 历史入口跨重启 | **P0 即做** `subagents/list` RPC + 面板子 Agent 区数据源扩展（jobBoard 运行态 ∪ subagents/list 历史，by subId 去重、运行态以 jobBoard 为准） | jobBoard 重启即空——不做则重启后历史子会话永不可达，与"落盘完整消息"的初衷矛盾。RPC 是 `SubagentsService.list`（已有）纯透传，前端合并 ~半天 |
| R6 | 墓碑可读 | `subagents/history` 对已 delete 的 id **照常返回**（会话文件保留语义——remove 只打墓碑）；send/await 等触达面仍拒 | 展示是只读面；"delete 后会话文件保留"的既有语义本就隐含可回看 |
| R7 | 让位协议 | `uiStore.subagentView` 态；open 时清 pairView/trackingView（反向同）；ac-client-ui-subagent 行自持让位 watch（三元组选中 → close，runview 行同款姿势） | 让位协议随 owning 行（技能纪律）；uiStore 是 layout 件共享布局态，pairView 同款 |
| R8 | error run 落盘 | 与主会话口径一致：`result.text` 非空才落 agent 行（interrupted/stopped 常有末步 text，自然覆盖）；错误详情走注册表 `lastRun.error` → 视图头部状态徽章。**不做** error 行（P1 可加） | 先保持与 ac-session 口径一致；错误可见性经头部已解决 |

## 三、分域改动明细

### 3.1 ac-subagent（落盘扩展 + 展示投影）

**行形**（`MessageLine` 演进，新旧行共存宽容解析）：

```ts
interface SubagentMessageLine {
  role: 'user' | 'agent';            // 新行；旧行 'assistant' → 读侧归一为 agent
  content: string;
  /** epoch ms（旧行字段；新行仍写，展示投影换算 ISO） */
  ts?: number;
  /** 新行字段 */
  message_id?: string;               // msg-<ts>-<rand>（对齐 ac-session genMessageId）
  timestamp?: string;                // ISO（toHistoryMessages 直读）
  agent_id?: string;                 // user 行 = parentId（任务发送方）；agent 行 = subId
  reasoning?: string;                // agent 行末步 reasoning（无 steps 时的折叠栏兜底）
  steps?: SessionStepRecord[];       // agent 行：全量步记录（R2 收束一次性）
}
```

- **写入点 1（user 行）**：`executeRun` 现有 `appendMessage(rec.id, 'user',
  content)` 处补 `message_id/timestamp/agent_id: rec.parentId`。
- **写入点 2（agent 行）**：现有收束 `if (result.text)` 处，改写 agent 行：
  `content = result.text`、`steps = result.steps.map(toStepRecord)`、
  `agent_id = rec.id`。`toStepRecord`：`LoopStepRecord → SessionStepRecord`
  （content/reasoning/ts/textBeforeTools/reasoningMs 透传；
  `toolCalls = step.toolCalls.map((tc,i) => ({ id, name, arguments,
  result: step.toolResults[i] ?? null }))`——一一对应是 LoopStepRecord 契约，
  收束时终值全在，无补行需求）。
- **读侧**（`ensureMessages`）：`role==='assistant'` → `{role:'assistant'}`；
  `role==='agent'` → `{role:'assistant', content}`——**steps 不进回放**
  （子上下文语义保持现状：任务对话纯文本对；工具轮次不跨 run 复放）。
- **新增服务面 `historyRecords(id): SubagentMessageLine[]`**：读 jsonl 全量行
  宽容解析（损坏行跳过，同现有姿势）后原样返回（含 steps）；**墓碑可读**
  （R6：`records.get(id)` 命中即返，不查 deleted；文件不存在 = 空数组）。
  现有 `history()`（回放口径）保留不动。
- `SubagentInfo` 不动（list 已含 displayStatus/runs/lastRun/task）。

**测试**（tests/subagent.test.ts 增补）：
- 带工具任务收束 → jsonl agent 行含 steps（toolCalls id/name/arguments/result
  一一对应）+ message_id/timestamp/agent_id。
- 旧行（assistant/ts:number）读写兼容：回放不炸、historyRecords 归一。
- 墓碑 historyRecords 可读；send 仍拒。
- interrupted/stopped 收束：有 text 落行、无 text 不落（R8 口径锁定）。
- ensureMessages 回放不含 steps（上下文不变量）。

### 3.2 ac-web-api（两个 RPC，可选能力模式）

对齐 `requireJobs()` 姿势（L1218：`ctx.get('subagents', false)`，未装载抛
面级错误，前端归一 null 静默）：

```
subagents/list   { query?, running_only?, limit? } → { subs: SubagentInfo[] }
subagents/history { id, limit?, offset? } → { id, records, total, hasMore? }
```

- history 分页形状对齐 `session/history`（L735：limit/offset 从尾部往回取 +
  total + hasMore）——前端上翻分页管线可照抄 pair 视角的
  `loadOlderPairHistory` 形态。
- records = `historyRecords()` 透传（已是展示友好形）。

**测试**（web-api.test.ts 增补）：两 RPC 正常/分页/墓碑/服务未装载
fail-closed（对齐 jobs/list 用例族）。

### 3.3 ac-client-ui-layout（uiStore 态）

`pairView` 旁新增（同款三件套：态 + open + close）：

```ts
const subagentView = ref<{ subId: string; name?: string; parentId?: string } | null>(null);
function openSubagentView(subId: string, name?: string, parentId?: string) {
  pairView.value = null;              // 互斥（R7）
  trackingViewVisible.value = false;  // 面板入口时矩阵可能开着
  subagentView.value = { subId, ...(name ? { name } : {}), ...(parentId ? { parentId } : {}) };
}
function closeSubagentView() { subagentView.value = null; }
```

`closeTrackingView` 不动（subagentView 不是矩阵的附属）；`openPairView` 加
`subagentView.value = null`（反向互斥）。

### 3.4 ac-client-ui-subagent（视角注册 + 组件 + 让位 watch）

该行从"工具卡行"扩容为"subagent 域前端行"（工具卡 + 会话视角同域）：

- **`SubagentConversationView.vue`**（新增，client/ 下）：
  - 头部：子名 + `· 父 <parentName>` + subId + 状态徽章（jobBoard 运行态 →
    running；否则 list 的 displayStatus——P0 简化：props 带 name/parentId，
    状态经 jobBoard 查 `meta.subagentId === subId` 的条目）+ 手动刷新钮
    （WS 断线兜底）。
  - 数据链（全现成纯函数）：
    `rpc.call('subagents/history')` → `toHistoryMessages(records, subId)` →
    逐条 `pairMessageToChatMessage(m, subId)` → `buildTurns` →
    `useTurnDisplayItems` → `TranscriptList`。
  - 刷新驱动：watch jobBoard 中该 subId 条目状态变化（job/settled 帧已由
    jobBoard 订阅，零新增订阅面）；user 行 run 开始即落盘 → 运行中打开可
    见最新任务消息。
  - 上翻分页：`onTopThreshold` → offset 推进（照抄 ConversationView
    `loadOlderPairHistory` 的滚动补偿形态）。
  - 只读：无输入框/无 dock/轮内动作关（`showActions: false`）。
  - 左右对齐基准 `settingsAgentId = subId`（子回复与任务消息分侧，视觉区
    分"发起方 vs 子"）。
- **视角注册**：行 client 半边 `ctx.slots.inject('main:perspective', ...)`
  注册 `{ id: 'subagent', order: 9, active: () => !!ui.subagentView,
  component: SubagentConversationViewAsync, props: () => ui.subagentView ?? {} }`
  （order 9 显式居 pair(10) 前；互斥置位下不会同时 active，order 只是防御）。
- **让位 watch**：行 apply 内 `ctx.effect + watch` 三元组（runview 行
  index.ts L376-397 同款姿势，经 `clientRuntime()?.roster/groups/singleBoard`
  可选探测）→ 选中即 `closeSubagentView()`。
- 行 ExtensionMeta description 同步（会话视角面）。

**测试**（对齐 subagent-card-row.test.ts 模式）：视角注册/卸载级联回收；
active 谓词随 subagentView；让位 watch 三元组选中关闭。

### 3.5 ac-client-ui-runview（面板点击入口 + 历史清单）

- **点击入口**：`RunTrackingPanel.vue` 子 Agent 树行（subRunning + subSettled）
  加 click → `ui.openSubagentView(subagentMeta(j).subagentId ?? '', name, parentId)`；
  无 subagentId 不响应（防御）；行样式 `jumpable`（同运行中会话行）。
- **历史清单合并**（R5）：子 Agent 区数据源 = `jobBoard.jobs`（运行态权威）∪
  `subagents/list`（跨重启历史）——by subId 合并去重，运行中/终态展示以
  jobBoard 为准，jobBoard 缺席的（重启后）以 list 条目渲染（displayStatus
  → 徽章词汇映射：done/error/timeout/stopped/idle）。拉取时机：面板
  onMounted 一次 + job/settled 帧刷新时一并重拉 list（或 30s 低频轮询，
  实现时取简）。
- 终止按钮仍走 jobBoard kill（job id 只在 jobBoard 有）。

### 3.6 组合根与文档

- **无新包/无新行**——全部改动落在既有五包（ac-subagent / ac-web-api /
  ac-client-ui-layout / ac-client-ui-subagent / ac-client-ui-runview），
  cordis.yml 与 ac-app TREE **不动**。
- `src/README.md`：ac-subagent 节落盘格式注记（SessionRecord 兼容形 +
  回放不含 steps）；ac-web-api 节 RPC 面清单补 subagents/\*；布局图
  ui-subagent 行描述扩容。

## 四、实施顺序（可暂停的 6 步）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | ac-subagent 落盘扩展 + historyRecords（§3.1 全部） | 域测试（新增 5 用例族）|
| 2 | ac-web-api 两 RPC（§3.2） | web-api.test 增补用例 |
| 3 | uiStore subagentView 态 + 互斥/让位接口（§3.3） | layout 既有测试面回归 |
| 4 | SubagentConversationView + 视角注册 + 让位 watch（§3.4） | 行测试（注册/让位）|
| 5 | 面板点击入口 + 历史清单合并（§3.5） | 手动冒烟（下）|
| 6 | README 注记 + 全量验收 | §六清单 |

每步独立可停；步 1-2 是后端独立交付物（前端未接时零影响——新 RPC 无人
调用、新落盘字段旧读侧宽容）。

## 五、手动冒烟脚本（步 5/6 验收）

1. 与任一 Agent 对话派 subagent（带工具任务，如读文件+搜索），等待收束。
2. 运行跟踪面板 → 子Agent 调用 → 点击行 → 主区展示子会话：任务消息
   （父侧）+ 回复（子侧，含工具卡/思维链折叠栏/已思考耗时）。
3. 运行中点击 → 已落盘任务消息 + 运行中徽章；收束后（job/settled 帧）
   自动补全回复。
4. 删除该子 Agent → 面板消失；重启宿主 → 面板历史区仍列出（subagents/list）
   → 点击仍可回看会话（墓碑可读）。
5. 旧数据兼容：用改前版本产生的 subagents/*.jsonl（assistant 行）→ 视图
   正常渲染纯文本对话。
6. 子会话含 send_agent / run_code 工具卡（本轮新行为联测）。

## 六、验收标准

- `pnpm typecheck` 通过。
- `pnpm --filter ac-subagent test` / `ac-web-api` / `ac-client-ui-subagent` /
  `ac-client-ui-runview`（若有测试面）/ `ac-client-ui-layout` 相关域全绿。
- §五冒烟 6 条全过。
- 既有行为回归：subagent 域测试全量（落盘格式变更不动 spawn/send/await/
  stop/delete 语义）；collab-tools 测试全量（本轮行为更新不被冲掉）。

## 七、P1 展望（本批不做，预留路径）

- **live 流式**：接 `pair:user|sub_*` 幽灵分区（§一已确认数据面）——与 pair
  视角同构合并（feed 分区承载流式尾部，历史承载落盘行；after-run 帧时重拉
  历史替换）。需处理收束窗口的双份数据毛刺。
- **步级 partial 落盘**：对齐 ac-session 部分行机制（运行中刷新可见已完成
  步）——依赖收束行吸收语义，复杂度独立成期。
- **error 行**：失败 run 落 `role:'error'` 行（视图错误分隔符，对齐主会话
  D12/F7 形态）。
- **嵌套导航**：子会话工具卡中的 sub_ id（孙 Agent）点击递归进入——视角
  栈或面包屑。
- **历史分页 UI 完整化**：limit 批拉 + hasMore 上翻（RPC 面已就位，P0 只做
  简单全量/首屏）。

## 八、工作量估算

后端（步 1-2）~1 天；前端（步 3-5）~1 天；测试补强 + 文档 + 冒烟 ~0.5-1 天。
合计 **2.5-3 天**。
