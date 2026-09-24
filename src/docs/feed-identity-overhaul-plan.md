// ============================================================
// feed-identity-overhaul-plan.md —— 会话流「身份贯通」根治方案
//（2026-12 诊断：渲染重复卡片 / subcall 挂靠异常 / 流式性能三类问题的
//  共同根源与一次性根治路径）
// ============================================================

## 一、诊断：为什么每修一批还会再来

feed-core.ts 里带日期的补丁注释（2026-08-28 → 2026-11-28 共 20+ 处）呈现出同一模式：
每次反馈都是在「事件帧 → rawMessages 载体猜测」这条地基上再加一层启发式：

- 2026-09-04 「重复 step.start 不追加第二个空占位」「同名并行只认未被认领的 preparing」
- 2026-09-17 「run_code 子调用平铺：恒建新条目 → 同 tool_call_id upsert」
- 2026-09-21 「断线重连 journal 行与直播占位并存：按内容前缀对齐、长度取胜不回卷」
- 2026-11-28 「重连历史对账：只重拉活跃对话」
- 2026-12    「settlement 无条件重拉」「event 行锚点抵扣配额」「viewer 消息保护拷贝」…

这些补丁全部在对抗同一个结构性缺陷：**事件帧没有稳定身份，前端只能靠位置/名字/
内容前缀猜「这帧该落在哪条消息上」**。猜测就有猜错的时候；猜错的修复又引入新的
猜测边界条件。这是打不完的地鼠，不是修不好的代码。

## 二、根因：无身份事件流 × 双表示对齐

### 2.1 事件载荷缺身份键（后端事实）

| 事件 | 现有身份字段 | 缺失 |
|---|---|---|
| loop/run-started(request) | agent/conversationId/sender/source | **无 runId**（LoopRunRequest 无 id 字段，contract.ts:26） |
| loop/step-started(agent, idx, msgs, envelope) | 同上 | **无 runId/stepId**（只有序号 idx，跨 run 不唯一） |
| llm/delta(input, chunk, meta) | meta.{agent,conversationId,sender,source} | **无 runId/stepId**（LlmStreamMeta 仅 4 键，contract.ts:93） |
| tool/started·after-execute·progress(call) | agentId/conversationId/toolCallId | **无 runId**；run_code 子调用 id 形如 `<runId>#<seq>` 却被注释为「提示不是判据」 |
| loop/after-step(agent, step, envelope) | 同上 | **无 runId/stepId** |
| loop/after-run(request, result) | 同 run-started | **无 runId** |

### 2.2 前端载体猜测状态机（feed-core 事实）

每个 on* 处理器都在做同一类事——在 rawMessages 数组里**猜**目标载体：

- `onMessageUpdate/onThinkingUpdate`：`lastStreaming(msgs, 'agent')` 位置扫描；
- `onToolStart`：按 `preparing && name ===` 认领占位（同名并行靠「find 不回头」约定）；
- `onSubcallStart/End`：`lastStreaming ?? reverse-find(role=agent && toolCalls.length)`
  ——run_code 执行期其宿主步已收口，lastStreaming 落空回退反向扫描，**群聊/event 插行/
  跨轮消息在场时挂错宿主**（「subcall 卡片挂靠异常」的直接机理）；
- `mergeHistory`（140 行）：直播行 vs journal 行对齐 = tool_call_id 匹配 + agent 行
  **内容前缀互验** + event 行锚点抵扣 + viewer 消息拷贝保护——任何一条启发式失配
  就是「同一内容两张卡」。

### 2.3 双表示同源竞争

同一 run 有两份表示：直播流（rawMessages 内存态）与 journal 投影（history 首屏/settlement
重拉/resume 快照）。两者的行对象没有共享键，靠内容猜测对齐——这是**所有**「刷新前后
不一致 / 重复合并 / 双卡」类问题的公共根源。

### 2.4 性能根源

- 每个 delta：`bump()` → 版本号自增 → `buildTurnsIncremental` → `msgs.map(msgSig)` 全表
  O(n) 签名计算（500 条会话 = 每 token 500 次字符串拼接）；
- 步边界（onStepEnd 关闭 + onStepStart 新开）一次变两条消息 → `onlyLast=false` →
  **全量重建 turns** → 所有 Turn 对象换新 → 全列表 TurnDisplayItem 重渲染
  （增量 memo 只救了「仅最后一条消息变化」的窄路径）；
  streaming 标志翻转（步间窗口）同样触发全量。
- 多步 run 每步都走一遍全量重建——「步越多越卡」的实测来源。

## 三、方案：身份贯通 + run 键控前端状态

### 3.1 后端：给 run 和 step 发身份证（改动极小）

1. `LoopRunRequest` 增 `runId?: string`（调用方不传则 service 生成 `crypto.randomUUID()`
   短形，塞回 request 后再 emit run-started）；
2. loop 组装每步时生成 `stepId = runId + ':' + index`，随 envelope 透传：
   - step-started / after-step 的 envelope 增 `runId`/`stepId`；
   - 每步 llm.chat 的 `input.meta`（LlmStreamMeta 增 `runId?/stepId?` 两键）——delta
     全系帧自动携带；
   - 每步 ToolCall 增 `runId`（ac-tools 契约加可选键，loop 装配）——tool/started·
     after-execute·progress 全系携带；run_code 子调用沿用 `<runId>#<seq>` 且**升格为
     判据**（前缀即宿主 runId，不再需要扫描猜宿主）。
3. ac-session：journal 行（步行/partials/subcalls）落盘时带 runId/stepId；records() 投影
   原样透出。subcalls 投影的宿主定位从「toolCallId 前缀扫描」升级为 runId 直配（机制
   不变，只是键更权威）。
4. ac-ws-bridge：零改动（帧载荷直转 args，新增字段自动过桥）。

### 3.2 前端：rawMessages → run 键控状态（feed-core 换地基）

分区状态从 `rawMessages: ChatMessage[]` 迁为：

```ts
interface RunState {
  runId: string;
  steps: Map<stepId, StepState>;          // StepState: thinking/content/toolCalls(Map)
  status: 'live' | 'settled' | 'error';
  liveTail?: ChatMessage[];               // 兼容期：无身份帧的回落载体
}
interface DialogFeed { runs: Map<runId, RunState>; /* … */ }
```

- **delta 处理 O(1)**：`feed.dialogs[id].runs.get(meta.runId).steps.get(meta.stepId)`
  直接定位——lastStreaming 扫描、preparing 认领、name 匹配全部退役；
- **turn = run**：turn 边界即 run-started/after-run（现 buildTurns 的 sender 分组/gap
  阈值/solo 规则全部是 run 边界的启发式近似）；渲染管线 turns = runs 的轻适配；
- **历史合并 = 键控 upsert**：journal 行带 runId/stepId/toolCallId，与直播态按键合并，
  live-wins（进行中内容）/journal-wins（收束终值）两条规则即全部——mergeHistory 的
  前缀对齐/锚点抵扣/配额兜底/streamingTail 拼接整体退役；**键相同则同一张卡，
  重复在结构上不可能**；
- **性能**：delta 只触碰单个 step 的响应式槽——完成 run 冻结为不可变对象，无签名
  扫描、无全量 turns 重建、无全列表重渲染；步边界只是开一个新 StepState 条目。

### 3.3 兼容与迁移（四步，每步独立可回退）

1. **后端发证**（无行为变化）：runId/stepId 进事件与 journal；契约字段全部可选，
   旧消费方零感知。
2. **前端双轨读**：feed-core 识别帧带 runId 走键控快路径（旁路 Map），不带走既有
   启发式路径；两轨在 turns 派生处汇合——用生产流量验证键控态与启发式态一致性
   （可加 dev 断言对拍）。
3. **历史投影切键**：session/history 响应带 runId/stepId 后，mergeHistory 切键控
  upsert；resume/settlement/重连三条对齐路径随之简化。
4. **拆旧**：确认无双轨差异后，删 lastStreaming 认领/前缀对齐/配额抵扣全族与
   buildTurnsIncremental 签名机制（turns 直接从 run 树派生）。

单测策略沿用现有 tests/ 目录（feed 双轨对拍、merge 键控、subcall 宿主直配各一组）；
集成冒烟 `pnpm smoke`。

## 四、收益清单（对应本次两类问题）

**渲染**：重复卡片 = 双载体/猜测失配，键控后结构性不可能；subcall 挂靠 = 反向扫描
猜宿主，runId 直配后消失；重连/settlement/refresh 三条对齐路径合一。

**性能**：delta 路径 O(n)→O(1)；步边界全量重建 → 单步条目新建；每 token 的全表
签名扫描退役；长会话/多步 run 的卡顿源头消除。

## 五、风险

- 事件目录扩字段属兼容扩展（可选键），无 breaking；
- 前端换地基是最大工作量（feed-core ~2200 行的主体重写），双轨期可控；
- 群聊/矩阵只读视角的事件路由仍按 agent/conversationId，不受影响；
- 旧 journal 无 runId：读侧缺键回落现有启发式（保留为 legacy 路径，只读旧数据用）。