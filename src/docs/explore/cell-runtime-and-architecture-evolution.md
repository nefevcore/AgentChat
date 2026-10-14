# Cell 运行时与架构迭代 —— 设计探索（未裁决）

> 性质：探索草稿，非实施裁决。五轮讨论（2026-10-10）沉淀：现状分析 → cell 架构 →
> 启动模型实测 → 开源对标 → 理论轮廓 → 契约分层 → in-process 重启可行性。CR-316。
> 状态：作者本人留档，后续再考虑；本文不代表任何已定决策，与 src/docs/ 正式档案不同，
> 未过任何评审。数字均为本机实测（Windows / Node 24.18 / 本仓库工作区），非基准承诺。
> 后续（2026-10-14 增补）：per-agent-instance-architecture.md（2026-10-13 留档）已将本文定位
> 为 activation 的物理容器层（cell = 容器，per-agent 账本是状态层）；本文若干前提已被该档案
> 裁决演进，见节内「增补」尾注与文末「开放张力」小节，其余保持留档时原样。

## 1. 问题：单实例共享运行时

当前全部 Agent 共享一个 cordis host：

| 层 | 现状 | 炸点 |
|---|---|---|
| 数据 | 已隔离（conversationId / agentId 落盘） | 无（盘上可恢复） |
| 编排 | ac-agent-loop 进程内单例，共用 loop / 工具注册表 / 连接池 | in-flight run 全灭 |
| 进程 | 单 host + supervisor.mjs（42/78/0 协议） | 故障域 = 整宿主 |

已有隔离先例（本仓库）：run_code worker（子进程 + PROTOCOL_VERSION 握手）、harness 委托
（外部 CLI 进程 + 会话续接）、supervisor 42/78/0（进程级生命周期纯库）。

## 2. Cell 架构：隔离单元 = 版本×插件集×租户，非 Agent 个体

```
控制面（现宿主，不动）                执行面（新增，可选）
┌──────────────────────┐     ┌─ cell A: v1.2 树 ── Agent x, y
│ ac-conversation 状态机 │     ├─ cell B: v1.3 树 ── Agent z（新版尝鲜）
│ ac-router 信封投递     │ ──> ├─ cell C: RSI 候选树 ── Agent w'（影子）
│ ac-agents 注册表       │     └─ (默认) 本机 loop ── 其余全部 Agent
│ web-server / ws-bridge │
└──────────────────────┘
```

- `AgentConfig.runtime?: cellId`（可选字段，缺省 = 进程内 loop，存量行为分毫不变）。
- cell = 独立进程，boot 独立 cordis 树（可不同 commit / 插件版本 = 多版本共存）。
- 炸一个 cell 只死该 cell 的 in-flight run；控制面标失败，按 42/78/0 重拉。
- seam 现成：router → loop 传 LoopRunRequest 信封（纯数据），进程内服务调用换成
  「远程 loop 适配行」即可，loop 契约不动。

### 四个硬问题

1. 交互式工具调用跨进程回合（审批卡 / ask_questions）：before-* waterfall 要回控制面；
   底子 = ac-durable-interaction，但跨进程串联是新活。
2. 数据根独占锁：cell 不能 boot 完整树（ac-session 拒同根双启）——cell 只 boot
  「loop-only 运行时」（L2+L1，无 ac-session），信封流入 / 事件流出 / 状态不落 cell。
   本质 = harness 模式泛化：一次性外部 CLI → 常驻自有运行时。
   增补（2026-10-13）：per-agent 档案 D1 裁决数据根独占锁退役降粒度（per-agent 账本单写者 +
   activation 单例锁替代整根独占）——本条绕行方案的前提计划被拆除，届时 cell 可承载账本
   boot，不必再 loop-only；现方案保留为锁退役前的过渡与最小裁剪选项。
3. 工具面解析归 cell 侧（信封带 AgentConfig 原文，各版本展开各的工具集——
   版本差异是特性不是 bug）。
4. usage / memory / persona 等横切服务：归属不变（数据在控制面），cell 经 RPC 调用，
   cell 不做第二宿主。
   增补（2026-10-13）：per-agent 档案 R-9 已细化为四类跨边界调用语义（请求-应答 / 流 /
   中断并入 run 生命周期事件 / 审批 = 投给 user 的带选项问题信封）+ lease/claim 在途回执
   认领 + transport 可插拔（同进程退化为直调），可作本条的展开参照。

### 与 RSI 的关系

RSI 基础设施需求 = 并行现任 + 流量可切 + 可度量 + 回滚便宜，逐项对应：cell 并存（进程边界
= 唯一可信硬边界，参 gap-backlog A1：Agent 间唆使链路无硬边界）、runtime 字段即路由开关
（conv-settings 可做会话级覆盖，机制现成）、ac-bench 即选择压力、kill + 改字段 = 秒级回滚。
蓝绿式自我迭代：w（现任 cell A）→ w'（影子 cell C 跑 bench）→ 达标切流量 → 现任降级为影子。

## 3. 启动延迟实测（2026-10-10，Windows / Node 24.18 / 本机）

| 探针 | 结果 |
|---|---|
| 裸 `node -e ""`（pwsh 计时，含包装开销） | 127–137ms |
| 加载 TS 文件（strip-only 边际成本） | +30ms |
| 进程内 `import('ac-agent-loop')`（模块图净耗时） | 49–57ms |
| 冷 spawn → loop 可用（推算） | ~200ms |
| worker_threads 空 worker（对照） | 22–25ms |

结论：
- 冷启动 10ms 物理不可能（fork/exec + V8 isolate 初始化 ~100ms 是地板）；
NaN
- worker_threads 数字最好但同进程 —— native crash / OOM 带倒宿主，只隔离版本不隔离故障，
  不适用于故障隔离场景；
- V8 user snapshot（Node 22+ --build-snapshot）可省 ~50ms 模块图加载，省不掉进程创建地板；
  快照 hash 天然 = 版本指纹；
- 需求拆解后 10ms 多为伪需求：cell 首建一次性 200ms / 流量切换 0ms（控制面字段）/
  bench 分钟级 / 首 token 本身几百 ms 起。唯一真需求 = 高频短命弹性 cell → warm pool。
- 核心裁决：cell 生命周期与 run 生命周期解耦——cell 常驻可预热、数量少（版本×租户组合数，
  非 Agent 数）；run 短命。10ms 指派 + 进程级故障隔离同时成立。

## 4. 开源对标（2026-10-10 检索）

结论：无项目完整覆盖「多版本 Agent 运行时 + RSI」组合，各层有先例：

| 项目 | 隔离单元 | 多版本 | RSI | 可借鉴 |
|---|---|---|---|---|
| AgentScope Runtime（阿里，已并入 2.0） | 会话/沙箱 | ✗ | ✗ | 控制面/执行面协议、弹性部署 |
| OpenHands | 会话 runtime | ✗ | ✗ | 事件流跨进程语义 |
| E2B（Apache 2.0 核心） | microVM/次 | ✗ | ✗ | warm pool、Firecracker 底座 |
| Darwin Gödel Machine（Sakana，开源） | 实验环境/次 | ✓（档案） | ✓ | 版本 archive + bench 门 + 护栏 |
| Orleans / Durable Objects / BEAM | actor/进程 | 部分 | ✗ | virtual actor 寻址、supervision |

血统：BEAM 证明「spawn 微秒级才配谈每实体一进程」，V8 做不到 → warm pool 是正确替代；
Orleans virtual actor（稳定身份 + 按需 activation）= runtime 字段的理论背书。
注意：领域迭代快，检索有时效性；立项前精读 DGM（ICLR 2026）与 AgentScope Runtime cookbook。

## 5. 理论轮廓

- **Agent = 模型 + 架构**。模型黑盒（不可内省/局部修改/归因），架构白盒（可 diff/回滚/归因）。
  迭代对象的真正理由 = 架构可归因，非「模型不能更新」。
- **架构定义扩容**：一切决定「模型如何被使用」的确定性逻辑——不止 loop+tool_use，还包括
  prompt 装配链、上下文压缩策略、steer 语义、工具面定义。DGM 实证：改 prompt 频次与收益
  远高于改代码（prompt 是对模型的编程）。
- **迭代梯度**（风险与粒度递增）：prompt 装配 → 装配链配置 → loop 代码 → 工具实现 →
  安全承重件（禁区：权限门/审批卡/沙箱边界——留控制面，永不进可变异范围）。
- **最小可运行单元五件**：loop 编排 / 工具注册与执行 / prompt 装配器 / 模型连接（协议库）/
  版本指纹（自描述快照——RSI 档案寻址键，现缺，Node snapshot hash 可作半份）。
- **数据三分与归属**：会话账本→conversationId（中立）、Agent 资产（记忆/人格/档案）→
  agentId（中立）、运行态（in-flight run/装配中间态）→ 架构实例（随 cell 生死）。
  增补（2026-10-13）：per-agent 档案 D4 把会话账本迁至 agents/<id>/sessions/<uuid>/（按
  端点归属，uuid 不编码拓扑）——与本条不冲突但词汇撞车：本条「中立」= 架构维度（数据不
  绑定运行环境版本），per-agent「归属」= 当事方维度（谁的视角谁的账本），引用时按维度区分。
  关键裁决：「数据不再集中管理」的精确含义 = 数据不绑定运行环境版本（身份键寻址，环境是
  临时宿主）；数据不得跟随架构各自管理——变异-选择需要对照实验，数据漂移 = 选择压力失效，
  反噬 RSI。数据 = 中立资产，架构 = 无状态可替换执行策略（Orleans 同构）。

## 6. 契约分层：宪法 / 方言 / 内脏

问题起源：架构迭代会改契约（新增 seam），「契约做边界」与「迭代架构」互咬。解法 = 契约
显式分三层：

| 层 | 内容 | 演进方式 |
|---|---|---|
| 宪法层（kernel） | 身份寻址、run 生命周期、审批回合、预算中断、审计流 | 极小、版本化、additive-only、人工 CR |
| 方言层（dialect） | 随架构版本走的新数据形状 | 不透明载荷通道透传（不认识 = 落账不执行） |
| 内脏层（internal） | cell 内 seam（注册者与消费者都在 cell 内） | 根本不过边界，cell 私有 |

- 握手：cell 声明「内核 vN + 扩展集 [...]」，控制面对照注册表；同版本全理解 / N-1 降级翻译
  （新原语不发给它）/ N+1 或改宪法 = fail-closed 拒收（bench 都不给跑）。
- 钉子：RSI 候选若修改宪法层，生产控制面物理上无法与之通讯——修宪权从 RSI 能力面物理
  剥离。候选要试新宪法 = 评估沙箱配影子控制面；生产只认人工 CR 批准的宪法版本。
- seam 三问定位法：①注册者与消费者都在 cell 内吗→内脏；②产生新形状数据流出吗→方言
  （不透明通道）；③需要控制面做不认识的事吗→先问能否用通用原语拼（审批本质 = 通用 ask
  原语），真需要新原语才是宪法修正案（控制面先升、cell 后用、只加不改）。
- 经验分布：80%+ 的 loop 演化落内脏层。边界原语应设计得足够通用（ask / emit / grant-deny /
  budget），让多数演化被既有原语覆盖；宪法层小到人工全审——这是配得上人工演进的原因。
- 先例：Erlang dist_proto（稳定内核+握手协商+不匹配拒连）、protobuf/avro（additive-only +
  unknown fields）、浏览器渐进增强、本仓 run_code PROTOCOL_VERSION 互认。

### 残余风险（诚实清点）

1. 语义漂移：additive-only 防不住字段语义悄悄变化——宪法层必须小到人工逐字审得动。
2. 不透明通道对抗性滥用：透传数据只落账永不执行；工具执行仍走宪法层审批门，与数据形状无关。
3. 宪法修正案成本是真实的：控制面需同时理解 N 与 N-1（滚动淘汰），双端协调工程——
   但这成本恰是闸门：改宪法应该难。

## 7. In-process 树重启可行性（cordis 源码勘察，2026-10-10）

问题：能否不 exit 42，在进程内 dispose 整树再从同一份 cordis.yml 重建？

### cordis 给的原语

- fiber 状态机（vendor/cordis/src/fiber.ts L139-154）：PENDING → LOADING → ACTIVE →
  UNLOADING → DISPOSED（终态不可重启）。fiber.restart() = dispose + 当前 config 立即重载；
  fiber.update(config) = 校验 → internal/update waterfall（HMR 可否决/替换）→ 重启。
  「dispose(ctx)+apply(ctx)」在 cordis 中真实存在，挂 fiber 不挂 ctx。
- root fiber 特例（L339-351）：普通 fiber dispose 即终态；root 的 dispose() = restart()，
  根永活，dispose 根 = 排空根上全部 effect（传递性含整棵插件树）。
- loader 持有行树：每 Entry（yml 一行）自带重载语义（loader/partial-dispose 事件）；
  hmr 插件做模块缓存驱逐（dispose+re-apply 只重跑 apply()，模块实例仍是旧的——
  换代码必须驱逐 ESM 缓存，boot --expose-internals 即为此）。
- 仓库先例：reload_modules 工具（语义化中断 → include.refresh / hmr.reloadFiles → 回投续跑
  通知）= 单行换码全链路已走通，会话不断流。

### 三坑（按严重度）

1. 进程级状态不被 fiber 系统管辖：模块单例 / 闭包缓存 / 第三方库全局（连接池、undici agent）
   dispose 后存活；「作者零 dispose」纪律意味着大多数行干净，但泄漏静默——第一次重启正常，
   第三次漂移。
2. 进程绑定资源：run_code worker 子进程、ws 长连接需显式排空；数据根锁反而是好消息
   （进程不死锁不换手，语义不变）。
3. boot.ts 进程级兜底（uncaughtException 记日志不退出）在 in-process 重启无对应物：
   进程事件面被污染的崩溃，重启树救不回。

### 硬界限

in-process 重启覆盖「版本」切换，覆盖不了「故障」隔离：native segfault / V8 OOM / 事件面
污染 = 进程自身死亡，进程内无物可接。BEAM 能在 VM 内监督是因为故障域在语言层以下；
V8 不管——**Node 世界进程 = 最小故障容器，supervisor.mjs = Node 版 supervision tree 的
诚实形态，42/78/0 是结构必然非技术妥协**。

### 三层阶梯（收敛结论）

| 层 | 形态 | 覆盖动机 | 会话/socket |
|---|---|---|---|
| L1 行级 HMR（已有） | reload_modules | 单行换码 | 不断流 |
| L2 树级 in-process（可新建） | quiesce → dispose 树 → loader 重建 | 版本整体切换 | socket 不断 |
| L3 进程级 supervisor（已有） | exit 42 | 故障兜底 | 必断 |

### 对 cell 架构的反哺：轻 / 重两档

信任域内变体（版本隔离）= in-process 子树 cell（根下子树 + isolate 服务组 + hmr 驱逐），
省每 cell ~130ms 冷启动与 ~50MB RSS，10ms 级指派延迟直接达成；信任域外候选（故障隔离）
= 进程 cell。按 bench 结果渐进升档：子树起步 → 证明稳定 → 升进程。比「一律进程」务实。

### 未验证项（诚实声明）

L2 拼法存在 = 基于 fiber/loader/hmr 各自能力的推断；loader 重建路径细节（Entry 树重建的
id 稳定性、watcher 交接）未读透。最小 spike：boot 后 dispose 全树 → 同一份 cordis.yml 重建 →
webui 不断线 → 重复三次状态无漂移。该 spike 同时是行级状态卫生的最好审计。

## 8. 增量落地路径（每步独立可验收）

1. AgentConfig.runtime 字段 + 远程 loop 适配行（缺省不改变任何行为）；
2. loop-only 运行时 boot + 每 cell supervisor（复用 ac-supervisor-core）；
3. 交互式工具调用跨进程回合（最难，可先声明「cell 内工具不带交互轴」缩水上线）；
4. bench 门 + 流量切换推广流。

配套裁决（若立项）：安全承重件清单（禁区）成文；版本指纹规范（snapshot hash 或显式元组
commit+插件集+配置 hash）；宪法层最小原语集（ask/emit/grant-deny/budget）草案评审。
增补（2026-10-13）：per-agent 档案 D6 已否决「承重件清单（禁区）成文」形态（清单会漂移、
会挡正当迭代、要人工维护），改采快照链两原子（快照点 = last known good + 回退通道物理
外置于变更面）——本条配套裁决按新形态执行。

## 9. 本档案纪律

- 探索档案（explore/）：非裁决、未评审、数字为本机实测非基准承诺；立项时迁 src/docs/ 正式
  目录并过评审。检索结论（第 4 节）时效截至 2026-10-10。

## 开放张力（2026-10-14 增补——per-agent 档案 join 后的待议项）

两档案宣称兼容（join point：cell 是 activation 的物理容器，per-agent 账本是状态层），但
兼容是宣称而非论证——以下映射规则两档案均无裁决，记为待议：

1. **cell × activation 映射**：cell = 版本×插件集×租户（一 cell 可承载多 agent，
   AgentConfig.runtime 字段指派）；activation = per-agent 单例（锁跨形态生效）。一 cell
   承载 N 个 activation 的锁语义、activation 可否跨 cell 迁移、runtime 字段与单例锁的
   互斥关系——均待裁决。
2. **会话账本归属词汇撞车**：本文 §5「数据不绑定运行环境（中立）」与 per-agent D4「账本
   按端点归属」维度不同但字面冲突（见 §5 增补尾注），立项前须统一词汇表。
3. 两条建议并入 per-agent 档案「待裁决清单」一并裁决。
