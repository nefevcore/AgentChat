# 回放契约（replay-contract）

> 性质：设计契约——LLM 回放策略词汇表与其在 fold 单源的落实（第一阶段，只管回放；渲染契约另立计划）。
> 状态：**实施中** · cr-1101 2026-11-15 · 前序探索：`workspace/home/files/__creator__/source-词汇收敛探索草稿.md`（一轮）+ `source-词汇收敛-二轮探索.md`（二轮，含全部实证）。
> 读者：动 fold.ts / events-v2.ts / 注入生产点（ac-skill / ac-ask-questions / 壳 conversation）的人。

## 一、原则（用户裁决，2026-11-15）

1. **once 绝不允许**：任何曾进入 run 运行的「事实」，都必须跨 run 回放（KV 前缀原则：回放缺席 = 跨 run 失忆）。
2. **默认直接回放**：词汇表 `original | wrapper | none`，缺省 `original`（直接回放 content）——只有与默认不一致的才需要声明。
3. **方案 B（包裹归回放）**：落盘裸正文；非 user/agent 发言的回放消息在**回放时**统一包裹。
4. **落盘事实不掺 UI 语义**（渲染契约另立）；**词汇表 owning = ac-ledger**。

## 二、词汇表（封闭枚举 + 默认规则，owning：ac-ledger）

| 值 | 语义 | 现行适用 |
|---|---|---|
| original（缺省） | content 原文回放 | speech 行（message——user/agent 真实发言）天然此档 |
| wrapper | 回放时以系统包裹壳包住 content（`<system-reminder>` 外壳，封闭模板归系统，不开放自定义） | **全部非 user/agent 发言行**：context+event / context+error / inject（skill / durable-interaction / 无源）。存量烘焙行（外壳已写面烘焙）读侧识别原样放行 |
| none | 不进 LLM 回放 | 预留（当前无生产者；未来 UI-only 行显式声明用） |

**判定按行类别,不按词**:speech → original;context/inject → wrapper;none 留给未来显式声明的词(词表开放,枚举封闭)。

已知褶皱(接受):同一条用户消息,空闲到达 → speech 行(original 裸回放),忙时到达 → busy-steer → inject 行(wrapper 包裹)。形态随到达时机不同,但包裹语义忠实转述了事实——「该文本经系统通道中途注入 run」;live 与回放两形态恒一致(消费点中央包裹),无语义漂移。

**外壳统一、内芯开放**：外层 `<system-reminder>` 统一（提示注入防护的单一信号，模型只学一个「系统插入」约定）；内层类型化标签（如 `<skill_content name="…">`）是**数据结构**不是防护——开放为约定（去重锚 / UI 折叠已依赖），各注入源自带。包裹模板导出自 ac-ledger（`wrapForReplay`），唯一实现。

## 三、fold 落实（cr-1101 变更面）

输入事实不变（events-v2 归一化），全部改动在 `packages/ac-ledger/src/fold.ts` 读侧 + 壳调用点：

1. **error 进回放**：foldLlmReplay 时间线从「只收 context+event」扩为「event+error」，error 以 user 语义位回放（wrapper 包裹）。废止「error 不进 LLM」的读侧现状；session-design.md §2.5 的「error 按 user 喂回」旧裁决由此恢复生效（v2 曾分叉）。
2. **孤儿/未收束 run 轨迹进回放**：轨迹展开的锚从「speech 终稿行带 run 键」扩为「任何 run facts」——无终稿行的 run（settle 前崩溃）按其首事实 ts 插入时间线；未收束调用的结果按 interrupted 口径合成（未启动 → TOOL_NOT_STARTED，已发未果 → TOOL_OUTCOME_UNKNOWN——与 resumeStateFor 同语义）。
3. **活动 run 排除（excludeRun）**：driveRun 传当前 runId，foldLlmReplay 排除之——防轮间重派生把在途 run 自己的轨迹喂回自己（双喂）。续跑（resume）前缀与回放由此各管一半：回放管「其他 run 的一切事实」，resume 前缀管「本 run 的前缀」，无交集。
4. **回放时包裹**：inject 事件（轨迹内）与 context 行（时间线）回放统一过 `wrapForReplay`；**存量烘焙识别**——content 已以 `<system-reminder>` 开头的行原样回放（v2 存量 70 条 skill 行、v1 存量不动）。写面新增非 user/agent 落盘裸正文（生产点逐批迁移；skill 的外层烘焙剥离随渲染契约批收口，本批不动写面）。
5. **判重 v1 门控**：cr-713 的 inject/requestId 判重（防入站行与注入行双喂）只在 `fold.version === 1` 时生效。实证：v1 数据根 202 对同 requestId 双写（cr-713 时代遗产），v2 为 0（写面三重幂等：machine 准入 / writer requestId 门 / 恢复面盘面查重——service.ts:310）。判重是全局一次性（非每 step），回放顺序 ≈ 落盘序（timeline 按_timestamp 稳定归并），判重只为双写兜底、非顺序矫正。

## 四、KV 前缀声明（session-design §S-KV 纪律）

- run 内（agentLoop 多步）：history 只在轮首取一次，loop 自持步进数组（流式累积）——run 内前缀天然 append-only；重派生只发生在轮边界（链跑轮 = 每轮独立 run，runId 随信封重赋值）。
- 跨 run：新 run 的回放 = 全量重投影。**KV 命中模型**：投影确定性（同盘同出）⇒ 新数组头部与上一 run 字节一致——provider 命中公共前缀，仅尾部新行（终稿/轨迹/新入站）计费。「自然失效 = 追加触发」指此：失效只发生在公共前缀之后，非破坏。**包裹不引入新失效源**——包裹是投影层确定性函数，每一 run 对同一批行产生相同字节，不存在「上一轮没包、这一轮包了」的漂移；落盘字节不动。
- 非追加式失效源（既有语义，非本批引入）：① 压缩——shadowed 前缀整段消失 + 摘要头置首（显式 replace，头部失效，设计如此）；② 孤儿 run 轨迹在下一 run 首次出现（追加位）。
- **run 自身轨迹时机差（裁决 2026-11-15：最小消除，不全面消除）**：run N 在途时模型看到自己的步 = loop 内存流式形态，settle 后 = 磁盘投影形态。逐项对拍后唯一实质字节差 = **inject 文本**（在途裸文本 vs 回放包裹）——步协议对/终稿让位/reasoning 均字节恒等，未收束调用合成终态是诚实补写（无「当时所见」可对齐）。**最小消除 = live 注入与回放注入字节对齐（已实施，cr-1101）**：包裹模板物理实现下沉 ac-core-utils（wrapSystemReminder——叶子包，注入生产方与回放投影方共享同一字节源防漂移；契约面仍是 ac-ledger wrapForReplay）；agent-loop **steer 消费点中央包裹**（一处覆盖全部 steer 调用方：busy-steer / ask 作答 / 子 Agent 通知；已烘焙文本原样放行）+ ac-memory 工作数组 append 包裹（落盘仍裸文，回放同函数包裹 → 恒等）——轮边界跨 run 前缀字节一致，原则 3 字节级贯彻。不采全面消除（loop 改读侧投影驱动步进）：架构反转代价大、KV 收益集中在单一字节差点、resume 路径已是投影形态消费（在途=内存/事后=投影的分工自洽）。
- 压缩：compaction boundarySeq 语义不变（shadowed 前缀不进回放）。

## 五、resume 是什么（二轮 §3-6 裁决记录）

resume（cr-667）= 原地续跑：中断 run 未收束时，下代 boot 经 recoverPendingInbox 重投信封，resumeStateFor 重建该 run 已见前缀（步协议对 + inject，同 runId 续跑）。`session/context-injected` 的 resume/resume-degraded 帧只是 UI 直播提示，不进模型。**按原则 1**：resume 前缀承载的事实（run 自己的步+inject）已进过 run，必须跨 run 可回放——由 §三-2 孤儿 run 轨迹进回放统一覆盖（settle 前 = 孤儿，settle 后 = 终稿行锚定；两条路都回放）。resume/resume-degraded 帧自身的落盘与否归渲染契约计划裁决。(已收口:cr-1111 起落账 context 行 source='resume',回放档 none——机制词集确定性生效,见 render-contract.md §2.2。)

## 六、event 通道裁决（非残余，保留）

v2 里 context+event 仅两条生产线：机制催办信（inboundRowOf mechanism，如重启「已重启」）与 singles 设置变更通知（syncPrefixSnapshot）。其余一轮统计的 19 处 event 生产点在 v2 壳内都走 deliver → speech 行。event 通道的独占价值 = **无 run 锚点的会话级事实**：通知到达时常无活跃 run（不能挂 inject），且即使后续 run 崩溃不收束，时间线行仍在场——比 run 锚定更抗失忆。词名含糊（杂项桶历史）可随拆桶批再议更名，通道保留。

## 七、验证

1. fold.test.ts 扩：error 回放在场、孤儿 run 轨迹在场且未收束调用合成终态、excludeRun 排除、包裹模板与烘焙识别、v1 判重保留 / v2 跳过。
2. 对拍：改前改后对 v2 数据根真实会话跑 foldLlmReplay，diff 只允许出现在 error/孤儿 run/包裹 四类面。
3. 壳测试：driveRun 链跑轮间无双喂回归锁。

## 八、声明注册制（cr-1104 第二阶段）

词表声明回归各 owning 插件（registerToolMode 范式，cr-1049）：

- **注册面**：`ctx.ledger.registerReplayPolicy({ source, replay })`——纯元数据 Map + `ctx.fiber.effect` 归属（随注册行卸载自动回收，声明退场 → 该词回落缺省 wrapper——插槽-插头降级语义）；撞名 fail-loud；机制词封闭（`REPLAY_BUILTIN_WORDS` = event/error/inject/segment，不可注册）。
- **查值面**：`LedgerService.replayKindOf(word)`（注册优先，缺省 wrapper）；`historyMessagesFor` 经 `FoldLlmOptions.replayOf` 传入 fold——fold 保持纯函数。
- **分档语义**：original = 原文回放（live 亦裸文）；none = 不进 LLM 回放（UI-only 行）；wrapper = 缺省（包裹）。
- **live 半边**：`agentLoop.steer(handle, msg, { replay })`——生产方按其声明档传词（缺省 wrapper）；消费点按档包裹/放行。live 与回放同源恒等。
- **狗粮**：ac-skill（skill）、ac-memory（memory-snapshot / memory-delta）、ac-ask-questions（durable-interaction）各自注册 wrapper——声明即文档，行为与缺省恒等（零漂移验收）。
- **验证**：cr1104-replay-registry.test.ts（注册/查值/撞名/机制词/非法档/fiber 回收）+ fold 分档用例（original 裸 / none 跳过 / 缺省包裹）+ steer 分档用例。

## 九、重写入口裁决（2026-11-15：不引入闭包式 content 重写）

曾议：registerReplayPolicy 增加形如 `(args) => text` 的重写钩子。**裁决不引入**，根因三条：
1. **投影确定性**：回放必须是磁盘的纯函数（同盘同出——KV 命中/对拍/审计的地基）。插件闭包使历史行回放字节随插件代码漂移——比 once 更糟（历史持续滑动、前缀中段失效）。
2. **live/回放恒等**：现为构造保证（两側共用 wrapSystemReminder 单源）。闭包要求 live 热路径（步边界）执行插件代码——抛错/延迟/两处实现漂移皆无良解。
3. **注入防护面**：闭包拿到 content 全权改写，是「外壳不开放自定义」裁决的泛化破坏，且可越权改写他词内容。

替代路径（全覆盖已知需求）：内层结构写面烘焙进 content（内芯本就开放）；结构化数据走 payload + content 双写；存量迁移走一次性脚本。**预留退路**：若将来出现「外层模板按词变化」的硬需求，加声明式静态串 \`wrap: { open, close }\`（可序列化/可对拍/无代码执行，签名前向兼容）——闭包形态任何时候不加。

## 十、foldTextReplay 面裁决（2026-11-15 回顾）

foldTextReplay（只投 speech）的两个消费面**不属**回放契约违背：
- **reviewRun（归档整理机制 run）**：三不语义（不进会话增长）——整理 run 对注入材料系统性失明是设计内行为,非失忆 bug;
- **跨壳委托播种（SessionShim.history → collab send_agent）**:是**新会话的种子决策**（委托对端拿对话转录）,不是同一会话的跨 run 回放——原则 1 管辖的是「同一会话内曾进入 run 的事实」,不管辖种子投影的裁剪。
两者维持现状;若未来委托方需要完整上下文,应显式换读面而非改 foldTextReplay。

## 十一、context 行全量准入 + run 死窗口兜底（cr-1106）

- **全量准入（拆 once 面 #2）**：foldLlmReplay 时间线从「只收 event/error」扩为**一切 context 行**——词 → 回放档由声明分派（none 跳过 / original 裸文 / 缺省 wrapper）。新 source 词从此天生回放,结构坑拆除。v1 存量 skill(482)/memory(274)/durable(111) context 行随之恢复跨 run 回放（原则 1）;数据根实证 context/inject 零双写,无重复喂入风险。
- **recordContext run 死窗口兜底（拆 once 面 #3）**：run 不活跃（收束竞态/迟到注入）不再只发直播帧丢落账——降级 `deliverRow` 直落会话级 context 行（source/label/payload/injectionId 随行,幂等键 = injectionId）,回放经全量准入在场。
- **词表 watchdog**：`scripts/check-replay-vocab.mjs` 扫数据根断言 source/injectSource ∈ 声明词表（机制词 + 内容词 + v1 历史词）——零私生词（2026-11-15 实跑 1312 会话/54511 行通过）。新词未登记即 fail-loud。

## 十二、水位显式化与褶皱裁决（cr-1107 / 2026-11-15）

- **memory 水位显式化**：「记忆基线 seq=N」从 content 寄生迁 `payload.memoryBaseline`（cr-765 起的公共数据面,cr-1107 泛化 payload 键域随 source 词开放）——注入正文对模型是纯记忆内容无水位噪声;锚检测 payload 优先、存量行回落 content 正则（recordsFor 投影 payload 随行,SessionShim 链路打通）。
- **busy-steer 褶皱裁决（用户 2026-11-15）**：正常,接受——「忙时到达 = 当次注入（inject 形态）,新 run 到达 = 发言（speech 形态）」,形态差忠实对应到达事实,无需消除。
