# 注入卡挂靠结构修复计划（inject-card-anchoring-plan）

> 性质：实施计划——消除「前端注入卡降级为独立上下文」问题的结构方案（ViewRow 全序 + 投影层锚定）。
> 状态：**已实施完毕** · cr-1132 2026-11-16（← 计划 cr-1131；批 1-5 全落：foldViewRecords 时间全序 / anchor 派生 / viewer 域归一 / buildTurns 坍缩 / face-shell 收编单源；验证目标 1-4 达成——真实数据根 admin~user / neko~user 管线断言无降级轮、卡全挂锚轮）
> 读者：实施本计划的人/Agent——先读「一、背景与根因」（含复现方法与实锤数据），再按「三、分批表」动手。

## 一、背景与根因（实证 2026-11-16）

### 1.1 症状

长会话（非 single 短会话）前端底部一直挂着一条「memory-snapshot 独立上下文」注入卡，刷新不消失。

### 1.2 复现（真实数据根 + 真实前端管线，已验证）

实锤会话：`admin~user`、`neko~user`（数据根 `workspace/home`）。管线：`assembleSessionView` → `toHistoryMessages`（含稳定时间排序）→ `buildTurns` → 出现 system 空轮 degraded inject。

验证脚本形态（node 直载 TS 源，仓库相对导入；曾住 sandbox/ 已清理）：

```js
import { assembleSessionView } from '../packages/ac-ledger/src/view.ts';
import { toHistoryMessages } from '../packages/ac-client-ui-conversation/client/historyApi.ts';
import { buildTurns } from '../packages/ac-client-ui-conversation/client/feed.ts';
// 取投影末 50 条（= 前端首屏分页窗口），跑管线，断言 turns 中存在
// agent_id==='system' && steps.length===0 && !final && injects.length 的降级轮
```

### 1.3 根因（两层结构缺陷叠加）

**缺陷一：投影输出无全序，分页在无序数组上切窗。**

`foldViewRecords`（packages/ac-ledger/src/fold.ts）输出 = 终稿层主投影（时间序）+ 三段尾段追加（error 红条 / 无 run 锚直落 context / event 分隔符；fold.ts:400 附近注释明言「位次不敏感——前端按 ts 排序」）。但 `session/history` 的分页 slice（packages/ac-host-webui/src/web-api.ts:241-243）恰发生在这个数组上：**全部历史注入卡与 event 行恒堆在数组尾部**。长会话首屏 50 行 = 最近若干发言 + 全部陈旧注入行——窗口取样系统性偏斜；陈旧 memory 卡永远挤进首屏，真正的旧发言被挤出窗口。同文件 `foldLlmReplay`（fold.ts:503-533）已实现正确的 speech ∪ context 按 ts 稳定归并时间线，读面投影未同构。

**缺陷二：注入卡归属由前端在分页窗口局部猜测，锚定信息在投影层本可确定。**

`buildTurns`（packages/ac-client-ui-conversation/client/feed.ts，头挂/归属判定约 388-397 与 461-468、尾挂与降级 524-531）用窗口局部启发式重建归属。两个实锤失败例：

| 会话 | 卡 | 失败链 |
|---|---|---|
| admin~user | memory-snapshot 直落行（message_id `ctx-1791162028569`，ts 2026-10-05T01:00:28.569Z，agent_id=user，v1 形态） | 窗口第一行即此卡；窗内 agent 轮 sender 全是 admin ≠ user → 头挂 ownable（feed.ts:462）永不命中；viewer 轮显式排除（feed.ts:461 senderId !== VIEWER_ID）；窗口尾部两条 viewer 轮 → 尾挂失败 → 降级 |
| neko~user | memory-snapshot（ts 2026-10-05T18:16:31.314Z，同形态） | 同构 |

关键事实：v1 存量直落行的 `agent_id` 是 **viewer 域落账恒值**（user），不承载真实归属语义，却被前端当真实归属参与判定。锚定（卡属于哪个 run/轮）是数据问题，交给了渲染层在残缺信息（单页窗口）下推断——猜错是必然不是意外。

### 1.4 影响面（2026-11-16 数据根扫描实证）

| 形态 | 是否受影响 | 说明 |
|---|---|---|
| v1 存量直落行（agent_id=user 的 memory-* 行） | 受影响 | 实锤 admin~user / neko~user；其余 pair 会话取决于窗口切点 |
| v2 现行注入（inject 事件带 run 键） | 不受影响 | 走 run 归口，稳定挂在对应 run 终稿前 |
| cr-1106 兜底直落（run 死窗口） | 边缘受影响 | 归属匹配正常，但「之后无同归属 agent 轮 + 尾部 viewer 轮」时降级 |
| agent 自会话（无 viewer 轮） | 不受影响 | 尾挂总能命中 agent 轮 |
| 直播路径（agent_id=system） | 不受影响 | — |

### 1.5 相关契约档

- docs/design/session/replay-contract.md——回放契约（foldLlmReplay 时间线归并先例、cr-1106 context 全量准入）。
- docs/design/webui/render-contract.md——渲染契约（§2.1 ViewRow 类型化、§五行为变化点第 3 条与本计划交叉）。

## 二、方案 S：ViewRow 全序契约 + 投影层锚定

设计原则（对齐仓库既定哲学）：**落盘事实不动，读侧投影处理**；顺序与锚定从「域块启发式」升为投影契约。

### 2.1 foldViewRecords 输出时间全序

- 三段尾段（error / 直落 context / event）并入 `foldLlmReplay` 同款 slot 归并（ts 主序 + seq/输入序稳定 tiebreak）——尾段追加结构退役。
- run 归口注入保持「run 终稿行前」语义位（其 ts 本就早于终稿）。
- 位次升为契约：**分页窗口 = 时间窗**。web-api.ts 的 slice 不改一行，自动变对。

### 2.2 锚定归一在投影层完成（全会话视野）

- 无 run 锚的直落 context 行随时间线自然落位；投影派生 `anchor`：时间线上**最近的后续 agent 发言行 message_id**（无后续则前向最近 agent 行；全会话无 agent 发言行 → 无锚，前端维持降级卡）。
- v1 存量 viewer 域恒值归属归一：投影时按域目录判别（conversationDirs 已知各域），viewer 域行的 agent_id 归一为**无归属**——落盘不动，读侧归一。
- anchor 随 ViewRow 携带（增量字段，不动 schema、不迁移数据）。

### 2.3 前端 buildTurns 启发式坍缩

- ownable / pending / 尾挂三段猜 → 「按 anchor 挂 → anchor 被窗口边界切掉时挂窗口内下一 agent 轮头 → 全会话无 agent 轮才降级」。
- 降级语义保留：只服务「会话首条即注入、无任何 agent 轮」场景。

### 2.4 face-shell 子会话视图收编

face-shell.ts:422-467 现自持第四份判据（对齐主投影语义）+ 文件序尾段——随本计划切到 fold 单源，消除判据复制。

## 三、分批切分

| 批 | 改动 | 文件 | 测试标准（过程门） | 验证目标（目的态断言） |
|---|---|---|---|---|
| 1 | foldViewRecords 时间全序（尾段并入 slot 归并） | fold.ts | npx vitest run packages/ac-ledger；fold 快照更新 | 投影输出按 ts 全序；对真实数据根 admin~user 断言首屏窗口头部不再出现 2026-10-05 卡 |
| 2 | anchor 派生 + viewer 域归属归一 | fold.ts、view.ts | 同上 + view.test.ts 扩 | v1 存量 user 归属行投出无归属；每张直落卡携带 anchor |
| 3 | 前端 buildTurns 坍缩 + historyApi 透传 | feed.ts、historyApi.ts、types.ts | pnpm webui:typecheck、pnpm build:channel、conversation-row 测试 | admin~user / neko~user 首屏 50 行窗口管线断言：无 degraded system 空轮；注入卡挂在锚轮链内 |
| 4 | face-shell 收编单源 | face-shell.ts | npx vitest run packages/ac-host-webui | 子会话视图判据复制清零（grep 断言无第二份 source 判据） |
| 5 | 文档与收官 | render-contract.md §五-3 勾销、session-design.md 如涉及 | node cr/cr.mjs check、pnpm lint 定向 | 验证目标 1-4 全达；快照测试锁新契约 |

## 四、验证目标（收官判据，全达才归档本计划）

1. 任意会话任意分页窗口，不再出现「注入卡在窗内、其归属轮被系统性切在窗外」的确定性降级；
2. 长会话首屏不再包含与当前时间无关的陈旧注入卡（时间窗取样）；
3. 注入卡视觉归属跨刷新/直播/上翻三路径恒同；
4. 结构性残余（接受，非缺陷）：窗口边界恰切在卡与锚之间 → 该卡页首瞬时降级，上翻一页恢复；会话首条即注入且无任何 agent 轮 → 降级卡是正确语义。

## 五、注意事项

1. 动手前登记 CR（红线）；批 1-5 各批独立 CR 或合一个 CR 分批提交，按当时习惯。
2. 回归夹具：admin~user 的 ctx-1791162028569、neko~user 的 2026-10-05T18:16:31.314Z 行是天然测试素材——数据根 workspace/home 是开发态数据根，验证脚本一律只读、住 sandbox/、跑完清理。
3. foldLlmReplay（LLM 回放投影）不在本计划范围——它已正确，不动。
4. toHistoryMessages（historyApi.ts）末尾有稳定时间排序，输入序变化不改变其输出序；批 1 后该排序从「必依赖」变「恒等」，快照测试需覆盖此点。
5. 运行时生效判定：改 web-api/face-shell（宿主侧）→ restart_host；前端 bundle 经 build:channel 重构建生效。
6. 与 render-contract.md §五-3（v1 存量 skill context 行升 inject-card）交叉：批 3 使这些行自然走卡通道，实施时在该档补一笔互引。
7. 行号均为 2026-11-16 快照时点，实施时以当时代码为准（文件可能已漂移）。

