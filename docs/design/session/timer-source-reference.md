# 定时器监控源 · 参考事实汇编（timer-source-reference）

> 性质：参考事实汇编——timer v3 监控源（source 行）全域现行事实：采集层 / 触发层 / 授权面 / LLM 面 / 运维排障。**面向消费方编写实施文档的事实底座**——各消费方（webui 面板、采集行开发、订阅方 Agent、运营排障手册）从本档取事实，按各自体裁裁剪成文。
> 状态：现行 · cr-1313 2026-11-25（事实源：[timer-v3.md](timer-v3.md) 域深设计 + cr-1164~1180、cr-1225/1228/1231 实施与坑修裁决；设计 §十一开放项多数已落地，本档按代码现状如实记录）
> 读者：编写 timer/监控源相关实施文档的作者（含 Agent 会话）；实施新采集行 / 接入订阅的 Agent 与开发者。

本档是「事实的搬运与归并」，不是新设计——语义有出入时以 [timer-v3.md](timer-v3.md) 与源码为准。使用规约：

1. **单源纪律**：语义与数字写进你的实施文档时注明出处（本档 + cr 号），不另立口径。
2. **边界钉死**：§六 v1 词汇边界（match 单层字段、glob 后缀匹配等）是防「词汇表癌变」的既定裁决，实施文档不得擅自扩。
3. **代码事实优先**：本档已按代码现状修正设计稿滞后处（cooldown 缺省 5m 实为 `DEFAULT_COOLDOWN` 每触发器缺省，分发时 `DEFAULT_SOURCE_COOLDOWN` 恒 5m 生效；fallbackPoll 已裁决不设——timers 行统一 10s 地板兜底）。你在编写时若发现本档与代码冲突，以代码为准并回报修正。

## 一、架构总览（三段式）

采集与探测正交：采集节奏（源行 cadence）与触发节奏（条目 when）互不绑架；采集失败只导致导出陈旧，不能进 timer 错误退避链。

```
采集层（代码，受信）            触发层（数据，哑）                判定/执行层（代码，全治理）
source rows（宿主侧行）         timers 行                          Agent run
物化 rows.jsonl + seq      →    when ∩ gates → 命中 → 投递  →  唤醒信（budget / 工具 /
emit source/updated 事件         记账 lastSeq / count               授权 / 审计 / 账本在场）
```

| 层 | 职责 | 信任模型 | 事实源 |
|---|---|---|---|
| 采集 | 获取外部状态（解密 DB、带凭据调 API、轮询目录），物化到 `exports/<source>/<view>/` | 用户安装的插件行——install 即授权（`grantSource: install` 现成词汇） | `packages/ac-source-core/src/{index,materialize}.ts` |
| 触发 | 机械变换与匹配（since-seq diff、字段过滤、cooldown 节流、门与终结判定） | 纯数据，set 时静态校验 | `packages/ac-host-rows/src/timers-row.ts` |
| 判定 | 语义判断（值不值得叫醒、做什么） | 全治理语境——唤醒信只是「有事件」，语义归 run | Agent run（全预算/授权/审计在场） |

timer 自身是**哑的事件匹配器 + 排程器**——不采集、不判定、不执行任何用户代码（cr-1161：v2 worker 执行面三病灶——执行面税 / 授权旁路 / 不可静态解释——全砍）。

## 二、采集层：source 行与物化面

### 2.1 物化契约（ac-source-core）

| 件 | 形态 | 要点 |
|---|---|---|
| 物化目录 | `<dataRoot>/exports/<source>/<view>/` | **不放 `agents/<id>/files/` 下**（Agent write 可写域，防投喂伪造数据）；视图 = ACL 粒度 |
| rows.jsonl | 追加式 JSONL，行含单调 `seq` | 快照 diff：新增/变更各一行；**删除不记**（v1 边界——「目录里出现了什么」）；10k 行滚动（→ .old 覆盖保留一代） |
| meta.json | `{ generatedAt, seq, schema, staleAfterMs, seen }` | 零变化也刷 generatedAt（活性心跳——stale 判定锚）；损坏/缺席 = null（源不可用） |
| staleAfterMs | 源按自身 cadence 的 2 倍声明 | fs-source：`cadence × 2` |
| 事件 | `source/updated { source, view, seq }` | emit / host scope；**一次物化一个事件**（批量不逐行）；契约住 owning 包（谁提供谁声明） |

物化纯函数 API（`ac-source-core` 导出）：`readMeta(dir)` / `readRowsSince(dir, sinceSeq)`（先 .old 后当前，跨代读，损坏行跳过）/ `materializeSnapshot(dir, current, staleAfterMs, schema?)`。快照行（fs 形）= `{ path, mtime, size }`（相对 root 的稳定路径键）。

### 2.2 fs-source 行（万能适配器）

- 配置（`config.json` → `source.fs` 域，cr-1168 写面收口）：`{ roots: [{ id, root, glob? }], cadence?: string }`；无 roots = 零定时器（空行）；`config/changed` 热重载（增删源不重启）。
- 扫描：按 cadence 全量扫描 root（递归），快照 diff 物化，**变化即 emit**（appended > 0）；glob v1 = 后缀匹配（`*.md`），前缀/字符类不进 v1。
- 形态：Service（`static inject = [timer, config]`——cr-282 教训：fiber 依赖等待保证构造期就位，禁 start-time 软取）；行 id `fs-source`，物化到 `exports/fs/<view>/`。
- **实例（news，现网在跑）**：`source.fs.roots` 配两个视图 `news-submissions` / `news-briefings`（root 指向 `files/news/{submissions,briefings}`，glob `*.md`，cadence 60s）→ 物化面 `exports/fs/news-briefings/`（meta.seq = 388，staleAfterMs = 120000）。
- 写物化面的是外部工具（news 的 python 脚本写目录）→ fs-source 物化 → timer 可见——**外部代码零进平台**。

## 三、触发层：源触发运行时（timers 行）

### 3.1 词汇

| kind | 字段 | 语义 |
|---|---|---|
| `source` | `source, view, on, match?, cooldown?` | 源事件触发：`on: rows-added`（有新行，可带 match）/ `stale`（源陈旧——监控监控者） |

match v1 算子：`eq / ne / gt / lt / in / contains`，单层字段，字段缺席不命中；gt/lt 仅数值与数值串。

### 3.2 分发链路（push 为主 + pull 兜底）

```
fs-source（或任何 source 行）物化
  → emit source/updated { source, view, seq }            ← push 主通道
  → timers 行构造器订阅（按 entriesByAgent 订阅表）
  → 二道闸：maySubscribe(owner, source, view)             ← 每事件现查授权（吊销即时生效）
  → readRowsSince(dir, lastSeq) 增量取行
  → matchRow 求值（match 缺席 = 新行即命中）
  → cooldown 条目级节流（窗口内不投但 lastSeq 照常推进）
  → fireSource → 复用 dispatch/gates/记账/审计/until 链（cause: source）
```

| 机制 | 值 | 出处 |
|---|---|---|
| cooldown 缺省 | rows-added: 5m；stale 唤醒: 30m | cr-1165（`DEFAULT_SOURCE_COOLDOWN`）；契约层缺省 `DEFAULT_COOLDOWN=5m` 每触发器可覆写 |
| pull 兜底 | 仅源条目在场时起 interval，10s 地板（防风暴）——扫 meta.seq 比 lastSeq 推进多即当一次事件 | cr-1165 裁决：**不设源侧 fallbackPoll 声明**，取简面统一 10s |
| stale 判定 | generatedAt 超 staleAfterMs → on: stale 条目唤醒去修（监控监控者） | 设计 §五 |
| dormant | 源已物化（meta 在场）即活；源行缺席（无 meta）→ `dormantReason: source-unavailable`，事件到达 re-arm 解除 | cr-1165 |
| lastSeq 持久化 | state.json（防宿主重启丢内存同 seq 重投） | cr-1169（news 实测 seq10 双触发修复） |

### 3.3 与时间触发并存（条目内 OR）

when 数组 OR 语义；条目 next = min(各时间触发器 nextFire)，源触发不占刻度（事件驱动 + cooldown 状态）。时间触发词汇（once/daily/weekly/every）本档不展开——见设计 §三/§四。

## 四、授权面（cr-1166）

### 4.1 词汇

InlineAsset spec：`{ kind: "source-view", source, view }`（per-agent inline，**无 GlobalAsset 形态**——源视图是小额直享）。查询单源 `ac-auth-core/src/source-view.ts`：`sourceViewsOf` / `hasSourceView` / `sourceViewDir`（路径组件拒绝，防穿越）。

### 4.2 三道闸

| 闸 | 位置 | 语义 |
|---|---|---|
| set 校验 | timer-face set 分支（`maySubscribe`） | 订阅的每个源视图都须有 inline grant——未授权视图校验拒（错误消息指引 inline grant 配置） |
| 分发二道闸 | timers 行 `onSourceUpdated` 每事件现查 | 防直改 timer.json 绕过 set 校验；授权吊销即时失效 |
| fs 读白名单 | sandbox `sourceAllowed` 前缀（read/glob/grep） | exports/ 双禁表上的授权豁免口——**只开口读路径**，编辑器写路径（str-replace-editor）恒不豁免（防改物化面投喂触发层） |

授权文件形态：`agents/<id>/auth.json` 的 `grants[].inline`（AssetRef 四选一之 inline 形态，见 [../plugin/auth-registry-data-format.md](../plugin/auth-registry-data-format.md) B2）。**auth.json 是授权工件**——运维配置面专管，命令通道与 Agent 侧禁读写（cr-1217 面2），实施文档只述契约不抄实例。

### 4.3 全局条目

owner `__global__`（sys.timer）恒过授权闸——全局条目扇出面是用户配置的 `action.target` 白名单（`,` 分隔，`*`/缺席 = 全部常规 Agent），不经 LLM 面订阅。

## 五、LLM 面（timer 工具）

工具 `timer`（timer-face 贡献行，宿主能力面）五动作：`set / update / list / cancel / test`。

| 动作 | 要点 |
|---|---|
| set | 纯数据写入（validateTimerEntries 单源校验，无 dry-run）；v2 遗留参数 fail-loud（code/mode/time/delay 等 → 报错指路 v3 词汇，cr-1167）；显式 conversationId 需归属校验（cr-1170）；源触发须过授权闸；**不接受 enabled**（恒建启用条目——停用走 update，cr-1180） |
| update | entry_id 定位幂等改写（未传字段继承现值，不丢记账——cr-1171）；enabled 启停 = 停用但保留语义 |
| list | v7（LIST_VERSION）：nextAt / lastAt / triggeredCount / dormantReason / conversationId / 源健康 sources[]（generatedAt/seq/stale 现读——排障不再手读 meta.json，cr-1172）/ pausedAt + schedule 前缀「已停用」（cr-1180） |
| cancel | 按 entry_id 撤单条并归档留痕（timer-archive 可查，cr-1171）；**别误用**——不是停用 |
| test | 静态预览（未来触发点 + match 模拟求值）+ 源未就绪预警 warning（cr-1167）；预览应用 gates（cr-1225） |

语义判断归 Agent：唤醒信只是「时间到 / 有事件」，值不值得做、做什么由 run 内判定——**语义不进触发器**（设计 §一）。

## 六、v1 边界（防词汇表癌变——既定裁决，实施文档不得擅自扩）

| 面 | v1 边界 |
|---|---|
| match 算子 | eq/ne/gt/lt/in/contains，**单层字段**——嵌套路径与正则不进 v1 |
| fs glob | **后缀匹配**（`*.md`）——前缀/字符类不进 v1 |
| source 词汇 | `on` 只有 rows-added / stale 两值 |
| 资产形态 | source-view 只走 per-agent inline，无全局层形态 |
| staleAfterMs | 源按自身 cadence × 2 声明——采集节奏与触发节奏互不绑架 |

## 七、运维与排障

### 7.1 审计与诊断面

| 面 | 落位 | 内容 |
|---|---|---|
| 审计行 | `meta/timer/audit.jsonl`（滚动 1MB→.old 覆盖） | 每投递一行：`{ at, cause: time|source, trigger, seq?, matched?, target, budget }` |
| 记账 | `meta/timer/state.json` | lastFiredAt / firedCount / armedAt / nextAtCache（缓存，重算告警价值）/ lastSeq{source,view} / cooldownUntil / dormantReason / pausedAt |
| 源健康 | timer list sources[]（v6+） | 条目订阅源 → { generatedAt, seq, stale } 现读 |
| 心跳 | 诊断面存活信号 | 不触发任何逻辑 |

### 7.2 运行时坑史（实施文档写「防再发」时直接引）

| 坑 | 现象 | 根因与修法 | cr |
|---|---|---|---|
| 排程静默停摆 2h | 宿主存活、无 audit、无错误行 | ctx.timeout 挂 TimerService effect——timer 行重载清空宿主全域排程而本行 schedules 持陈旧 dispose。修：三道防线——定时器挂本行自有 fiber + 60s 排程看门狗（缺排/到期未动即重排 + warn）+ 投递 30s 上限（dispatch 内 client.connect 挂死）+ fire 链 catch 后退避重排 | cr-1228 |
| jitter 同刻度重投（一格投 5 次） | every + jitter 条目同秒双投/多投 | 抖动负偏可把投递点推到刻度之前，now 仍早于刻度 → 重算返回同刻度。修：刻度生成侧两道——消费判定（lastFiredAt 落在本刻度抖动窗内 ⇒ 取下一格）+ 不得回到过去（越界退化为刻度本身）；**不在 dispatch 层去重**（掩盖症状）。残留：catchup-once + 停机跨刻度的少投/重投边界（默认 missed:skip 不触发） | cr-1231 |
| lastSeq 重启丢失 | 宿主重启后同 seq 重投（news 实测 seq10 双触发） | 内存态 → state.json 持久化 + 读后即占位防并发窗口 | cr-1169 |
| 记账亚秒精度 | once 条目 7ms 循环重投 | 记账时刻字段必须毫秒精度数值（ISO 秒级截断 + catchup 判据亚秒永真） | cr-1164 |
| 停用条目面蒸发 | enabled:false 条目 list/update/cancel 不可达、set 整表写回丢条目、记账被 forget | entriesByAgent 全量装载 + 翻转检测（停用落 pausedAt、恢复基点快进——armedAt 抬升 + lastSeq 快进，不回补） | cr-1180 |

### 7.3 数据根安全（sandbox 边界）

- `exports/` 入 sandbox 双禁表（cr-1165 复查修补）+ 分层契约（[../assembly/data-root-layers.md](../assembly/data-root-layers.md)）：任何持 fs 工具的 Agent 无授权不可读——防「读全量行（绕过视图 ACL）+ 写伪造行投喂触发层（向另一 Agent 语境注入）」两通道。
- 白名单只开口读路径；编辑器写路径恒不豁免。
- Agent 视野外：视图 ACL（哪个 Agent 看哪些行）是源行配置里的用户策略，不在一切 Agent 视野之内。

## 八、实施文档编写指南（消费方裁剪表）

各消费方从本档取事实后按体裁成文（命名与头部三行见 [../../doc-conventions.md](../../doc-conventions.md)）。

| 消费方 | 建议体裁 | 裁剪面（从本档取） | 落位 |
|---|---|---|---|
| 新采集行开发（如 wechat-collector） | 实施计划 -plan | §一（三段架构与信任模型）、§2.1（物化契约 + materialize 纯函数 API）、§4.1（视图与授权）、R0b 三问（[../assembly/host-shell-row-manifest.md](../assembly/host-shell-row-manifest.md)） | `docs/design/session/`（或所属域） |
| wechat-collector 示例行 | 域深设计或 -plan | §2.1 物化契约（行只管采集 + emit，不碰 timer）、§六 v1 边界（match 算子即行内 row 字段语义）、§4.1 视图 ACL（哪个 Agent 看哪些 chat 是行配置策略） | 独立插件包（设计稿 §九「按需」批） |
| 订阅方 Agent（news 类）使用手册 | 指南/规约 | §三（词汇与分发链路）、§五（timer 工具五动作 + 授权指引）、§7.2（坑史——条目 miss/dormant/stale 判读） | `ac-agent-loop` 指南段或 docs/ |
| webui 面板（TimerPane/源健康） | 域深设计或 -plan | §7.1（list sources[] 字段）、§三（词汇表——表单分栏与 v1 边界对齐）、§五 list v7 字段 | `docs/design/webui/` |
| 运维排障手册 | -checklist 或 -handoff | §7.1 诊断面、§7.2 坑史、§7.3 安全边界、cr-1228 看门狗行为 | `docs/design/ops/` |

编排建议（编写实施文档时）：先读设计稿 [timer-v3.md](timer-v3.md)（语义权威）再回本档对代码现状（本档已并修正滞后处），分歧以代码为准；条目契约字段级引用直接指 `packages/ac-timer-core/src/index.ts`（契约单源）。

## 九、与代码的映射点（速查）

| 件 | 位置 | 职责 |
|---|---|---|
| 契约 + 触发推导纯函数 + 迁移编译器 | `packages/ac-timer-core/src/index.ts` | TimerEntry / WhenTrigger / MatchCond 契约单源；nextGridMs / gatesPass / previewFires / matchRow |
| 采集纯库 + fs-source 行 | `packages/ac-source-core/src/{index,materialize,events}.ts` | 物化 + source/updated 事件目录 + 万能适配行 |
| timers 行（源触发运行时） | `packages/ac-host-rows/src/timers-row.ts` | 订阅分发 / cooldown / pull 兜底 / stale / dormant / 记账 / 审计 |
| timer 工具（LLM 面） | `packages/ac-host-face/src/timer-face.ts` | set/update/list/cancel/test + GUIDELINES_TIMER 段 |
| 授权词汇 | `packages/ac-auth-core/src/source-view.ts` | source-view inline asset 三方单源 |
| sandbox 双禁与白名单 | `packages/ac-sandbox-core/src/paths.ts` | exports/ 双禁 + sourceAllowed 读豁免 |
| 基座行单 | `apps/catalog/profile/host.yml` | fs-source / timers / timer-face / timer（fiber 定时基座）行定义 |

## 十、开放决策（截至 cr-1313）

| 状态 | 事项 | 现状 |
|---|---|---|
| ☐ | wechat-collector 示例采集行 | 未实施（设计稿 §十「按需」批）；news 场景已由 fs-source + 外部 python 脚本跑通 |
| ☐ | 「已消费刻度」显式状态（lastFiredTick） | cr-1231 残留：当前从 lastFiredAt 反推，catchup-once + 停机跨刻度时少投/重投一格（默认 missed:skip 不触发） |
| ☑ | 其余设计 §十一开放项 | cooldown 缺省 / pull 兜底声明位 / 审计行落位 / base 三裁决 / exports 封禁 / 视图读授权 均已落地 |

## 十一、CR 索引（源变更史）

| cr | 一句话 |
|---|---|
| cr-1161 | timer v3 设计稿（哑触发层 + 采集分离，取代 cr-1147 探测循环） |
| cr-1164 | 换轨实施：契约/推导 + timers 行哑匹配 + face/UI 换轨 + 迁移 |
| cr-1165 | 采集层实施：ac-source-core + fs-source 行 + 源触发接线 |
| cr-1166 | 视图读授权：source-view inline + set/分发双查 + fs 读白名单 |
| cr-1167 | 体验修补：v2 参数 fail-loud + 预览诚实性 + 源缺位预警 |
| cr-1168 | fs-source 配置写面收口（config 白名单补 source 域） |
| cr-1169 | lastSeq 持久化（重启同 seq 重投修复） |
| cr-1170 | set 补 conversationId + 归属闸 |
| cr-1171 | update 语义 + list 回显 conversationId + cancel 归档留痕 |
| cr-1172 | list 源健康投影（sources[]） |
| cr-1178 | v2 残留死代码清理复查 |
| cr-1180 | 停用但保留（enabled 语义补全） |
| cr-1225 | 预览应用 gates + 校验错误前缀 |
| cr-1228 | 排程停摆三道防线（自有 fiber + 看门狗 + 投递超时） |
| cr-1231 | jitter 同刻度重投修复（刻度生成侧两道） |
