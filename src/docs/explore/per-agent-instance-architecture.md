# Per-Agent 实例架构 —— 设计探索（未裁决）

> 性质：探索草稿，非实施裁决。2026-10-13 会话沉淀（与 cell-runtime 档案同批思路、主线不同：
> 那份谈执行面外移，本份谈会话结构的视角主义重构 + 宿主退化为邮局/监护人；两者兼容——
> cell 是 activation 的物理容器，per-agent 账本是状态层）。状态：留档待议，未过任何评审。
> 仓内相关：cell-runtime-and-architecture-evolution.md（CR-316）、ac-session（writer 队列 +
> 数据根独占锁）、ac-conversation（inbox 双队列 + steer-stash durable）、ac-group（群转录
> 流扇出 cr-4）、ac-workspace（agentWorkdir / 授权目录 = workspace 信任域雏形）。
> 配图：per-agent-instance-architecture.html（五张图，含裁决依赖图）。

# 第一部分 · 设计

## D0. 动机与一句话

现架构：全部 Agent 共享一个 cordis host，会话集中、Agent 是数据。痛点：

| 痛点 | 现状 |
|---|---|
| 隐私/回放 | 账本集中，无 per-agent 视角的一等公民身份；群聊只有转录流是 per-viewer 的 |
| 扩展形态 | pairKey 把恰好两方烧进文件名，新拓扑（agent~device、agent~cron）要改键结构 |
| 解耦 | Agent 离开 AgentChat 无法存在——会话必经宿主，CLI 直连不可能 |
| 故障域 | 单 host，一处 in-flight run 全灭（cell 档案 §1 同款问题） |

一句话：**Agent = 自治实例（账本 + 会话状态机 + 工具面），AgentChat = 邮局 + 监护人 + 可选 UI**。
Agent 拥有 per-agent 账本（agents/<id>/sessions/<uuid>/），投递不经许可，激活不依赖宿主在线。

## D1. 对象模型

```
Agent 实例 = {
  账本    agents/<id>/sessions/<uuid>/    一等事实源，单写者（实例自身或其代理 writer）
  激活    activation（无常进程/子树）：同一 agent 同时只有一个激活实例（单例锁）
  工具面  AgentConfig.tags / include / exclude + 信封展开（resolveEffectiveTools 语义不变）
  身份    注册表数据（agents/ 树）：模型引用、人格、记忆、档案——数据身份与运行身份分离
}
```

- **user = 虚拟 agent**：无 loop、无模型，但有账本（见 D2 写入对称）。user 账本 = webui 数据源。
- **锁的两层语义**：per-agent 锁 = activation 单例锁（防同 agent 双进程）；run 串行仍 per-
  conversation（ac-conversation 串行化门语义不变，activation 内多 run 并行）。现状数据根
  独占锁退役降粒度——多 agent 进程共存从此合法。

## D2. 通信原语与投递

投递原语只有一种，传输通道可有多种：

```
send(msg)    写自己账本（own 发言）→ 投递
             通道选择是下层实现细节：邮局中继 / 对端直投 / 本地发件箱滞留待转投
receive(msg) 恒为：幂等检查（requestId）→ 写自己账本（peer 包装）→ 激活 run
             run 内部与终稿全部写自己账本；终稿回复 = 一次普通 send；对端收回复 = 一次普通 receive
```

- **行为一致性由协议层保证**（信封 + requestId 幂等 + 落账即确认——恒一套），与通道无关。
- **邮局 = 默认通道，非必经关卡**（增值 = 路由 / 群播扇出 / durable 中继）；点对点直投是合法
  备选；宿主缺席 = 默认通道不可用降级直投，**降级不改变语义只改变路径**。「宿主在场」不得
  成为 agent 间会话的隐形依赖——否则宿主一重启全部 agent~agent 会话停摆。
- **传输与授权分离**：邮局是传输服务（纯基础设施）；门禁/审批/凭据授予是授权服务（控制面
  本义）。传输不需要许可；新授权才需要宿主在场。
- 1v1 时序：a.send → b.receive → b.run（内部写 b 账本）→ b.send(终稿) → a.receive。
- 防自激 budget（MAX_AUTO_WAKES 同款）随消息信封携带（类 TTL / hop-count）——账本分裂后
  per-conversation 计数器无处安放，字段进信封是分布式正解。

## D3. 子树信任边界

**积极定义：子树 = 无需授权即可执行的能力全集**——读写自己账本、纯计算、模型调用。凡需
授权的动作（全局 FS / shell / 网络 / 花钱 / 装载代码）天然在线外；行枚举清单只是物化，
清单本身不构成定义。

- **统一原理：离线时「控制面」退化为「数据根里已授权的资产面」**——宿主进程缺席时，它
  授权过的东西（凭据 / 已装插件 / 已配置服务器）以数据形态留在数据根，子树直读即用；
  新授权动作一律离线不可。
- 边界不对称性：宿主在线 = 子树内嵌宿主树（逻辑边界，门禁按调用身份裁决）；CLI 直连 = 
  独立进程（物理边界）——此不对称约束工具代理协议的形状。
- agent 子树内不 boot 承重行（ac-security / plugin-gates / durable-interaction / usage /
  credentials）——门禁链不出控制面，工具执行恒回宿主（代理 stub + RPC），子树内只跑纯
  计算工具。
- CLI 形态 = agent 子树独立进程（cordis 树可裁剪先例：MINIMAL_CORE_ENTRY_IDS 截树、
  bootTree 程序化组合）；与宿主内激活经单例锁互斥（跨形态生效）。两形态共享同一棵子树
  定义（同源 boot 产物），会话能力完整——只缺宿主侧服务（webui / 定时唤醒 / 群播扇出 /
  usage 计费）。

## D4. sessions 架构

### D4.1 统一会话形态

```
agents/<id>/sessions/<uuid>/
  header.json      participants（端点集合，含自身）+ 形态标记（user/agent/group/… 开放词汇）
  messages.jsonl   行协议不变：role + agent_id + content（viewer 投影已内建于行协议）
  journal/         partials.jsonl（run 期间台账）+ subcalls.jsonl（子调用档案）——机制照搬
  inbox/           durable 收件箱（投递未消费消息；activation 消费后清）
```

- **uuid 全局共享、不编码拓扑**：a 侧与 b 侧同一 uuid（否则投递 / #会话 引用 / 跨方定位
  全部要翻译层）；participants 进 header 元数据，pairKey 退役。全部形态统一为 agent ~ 端点
  （端点 = user / agent / group / subagent / 未来 device、cron、workflow…）：新拓扑零改键结构。

### D4.2 本体消解：双写不是 bug，是视角

a 账本与 b 账本不是同一份数据的两个副本，是两个视角，互不需要共识，只需要投递语义。
先例：Matrix federation（每 homeserver 持房间事件自己的副本，房间无单一事实源）、Email/SMS。

- 写权 = 账本所有权：a 的账本只有 a 的进程能写；b 发消息 = 投递进 a 的收件箱，a 侧写入。
  每账本单写者队列——ac-session writer/journal/settlement 机制实例 ×N，不发明新科学。
- 群从对象降级为端点：group = multicast 地址表，扇出 = 逐成员投递写各自账本。群转录流
  own/peer 投影从群特例推广为全形态通例——最大的一块现状复用。
- **投影分层**：账本分两层——run 内部记录（思考 / 工具调用参数与结果，字量大头）归产生方
  独占，对外投递的只有终稿（peer = 包装后的终稿文本）。回放性与经济性是同一条投影规则的
  两侧。可见性是读侧投影的事：webui 展示工具卡/思考 = 经宿主只读 agent 账本投影，不是
  写侧复制。
- 仲裁无客观记录 → 弱需求（本地单机产品）；要对抗否认，消息带哈希链即可（双方账本互存
  对方发言副本，互为证据）。

## D5. 相互恢复环

相互重启成环是设计意图。环的处置语义 = **rollback 不是 retry**——每次回退指向 last known
good，路径有限步终结（retry 环才不收敛）。

```
边 1（宿主 → agent）：agent 升级坏 → 宿主拉起失败 → 回退 per-agent 快照 → 拉起旧版 → 注入回退回执
边 2（agent → 宿主）：宿主自进化坏 → agent 探测邮局失联 → 回退宿主快照 → 拉起 → 收新宿主观察回执
```

- 安全性结构前提：两侧死亡互不传染（per-agent 进程 + 独立账本）。同时死 = 环两边均无
  执行者 → 落保底（用户手点 / supervisor.mjs 冷启动），不属环的职责。
- 权限面：单机本地产品，能改宿主代码的 agent 必有 full/dev 档（本就能跑任意 shell，软闸
  一行 spawn 即绕）——拉起宿主是既有权限面内的普通操作；唯一保留 = 并发拉起仲裁
  （数据根独占锁 fail-loud）。
- 保底：supervisor.mjs 为第三方冷启动通道（进程层脚本，不经组合根）——环失效时的最后
  手段，与环并存不冲突。

## D6. 逃生门 = 快照链（两原子形态）

逃生门不采「承重件禁区清单」形态（清单会漂移、会挡正当迭代、要人工维护），采**快照链**形态。
四个性质：

1. **快照点 = last known good**：只在验证过健康的状态拍（boot 成功 + 冒烟过）——不是任意
   时刻备份，是健康检查点。
2. **覆盖面分层**：代码（git/backupDir）+ 结构状态（cordis.patch.yml / registry.json / 熔断
   计数）+ agent 包（per-agent 快照）。回退代码不回退结构会出现新代码读旧结构的错位。
3. **配套纪律 = 盘上格式 additive-only**：回退即「旧代码读新数据」——行协议 / 配置格式只加
   不改，旧版读新版数据必须不炸（cell 档案 §6 宪法层同款）。
4. **最小守护件 = 两个原子**：快照链本身 + 回退通道（拉起/重装机制）不可被迭代改掉，物理
   外置于变更面（快照目录 + supervisor 拉起脚本）。「进化器不能进化逃生门」精神不变，
   形态从枚举变为原子外置。

## D7. cordis 的角色

cordis 是当前非常契合的工具、必要时可改动 vendors：

1. 核心 API 恰好就是本架构需要的形状：ctx.plugin() / registry.delete() = 运行时插拔原语，
   fiber 树 + effect LIFO = 所有权模型，isolate / intercept = per-agent 作用域，Reflect 服务
   模型 = 服务晚绑定。per-agent 子树 boot、activation 单例、跨进程投递全建在这上面。
2. 三层注册表嵌套（源码勘察）：ctx.registry（callback→runtime）→ runtime.fibers →
   fiber._disposables（DisposableList：有序 + O(1) 按值删）。子 fiber 的 dispose 本身是父
   effect 表的条目——插件树 = 注册表套注册表物化。
3. vendor 不需要大动：多 agent 子树 = 多 EntryTree 挂 root 下（零改动）；include 行已支持
   多级子树；hmr 行 root 数组可按 workspace 过滤（一行 config 改动）。必要时可动 vendors
   的清单穷举两处（include 多级子树路径解析 / hmr root 过滤），均不触核心三红线
   （fiber 状态机 / registry 键控 / effect LIFO）。

## D8. 热插拔能力阶梯（现状盘点）

动态能力进出的正解不是换代码，是换注册项（数据）。三层阶梯：

| 层 | 动作 | 粒度 | 生命周期 | 现状 |
|---|---|---|---|---|
| L0 注册表面 | defs.set/delete（tools 服务） | 单工具 / 单 provider | fiber 归属 effect | 已实现 |
| L1 插件实例 | ctx.plugin / fiber.dispose | fiber（插件实例） | fiber 树 LIFO | 已实现 |
| L2 代码热换 | 动态 import + ?t= bust / hmr loadCache 驱逐 | 模块图子集 | reload + 回滚 | 部分实现 |

## D9. 落地路径（每步独立可验收）

1. **会话形态统一 spike**：群转录流机制推广到 1v1 + user 账本喂 webui 群视图。不依赖进程
   模型，单宿主内验证语义。验收：单宿主内 1v1 双视角账本 + webui 群视图跑通。
2. **activation 单例锁 + agent 子树 CLI 形态**：最小 agent 子树独立 boot + 直连对话。MVP
   裁剪：离线禁装 + 不含 subagent + memory/persona 直读 + 承重代理仅同步请求-应答（流 /
   审批回合后补）；前置 R-11（凭据供给，否则验收不成立）。验收：宿主不在线完成多轮会话；
   同 agent 双方抢锁互斥。
3. **宿主邮局化**：投递面经宿主路由 + per-agent durable 收件箱；跨进程对话跑通。验收：
   跨进程 1v1 与群播 fan-out。

## D10. 代价总表

| 代价 | 处置 |
|---|---|
| journal / compaction / 归档 per-agent 实例化 | 机制照搬，工程 ×N 实例 |
| 新成员入群无历史（极端沉默权） | 要历史 = 从老成员账本投影回填（一次性导入语义）；隐私上甚至是 feature |
| 跨 agent 能力改写 | session-query（多根搜索或收敛为 agent 只搜自己）、backup/archive 枚举 agents/*/sessions/ |
| webui 读面迁移 | user 账本 = webui 唯一数据源（会话列表 / 群视图 / 回放） |
| 与现状单向兼容 | 存量 sessions/<pairKey>/ 迁移：一次性脚本 + 恒等门测试（仓里 migrate 三件先例） |
| 消息丢失模型 | 投递 at-least-once + 接收方幂等（requestId 准入去重，cr-250 机制复用） |

# 第二部分 · 裁决记录

> 编号规则：R-<族号><序号> 对应讨论中的 OPEN-<序号>（R-2a 对应 OPEN-2a，同族追加项顺延编号）。
> 状态：✓ 已裁决 · ✗ 出局（伪问题）· ◐ 待裁决。日期均为 2026-10-13。

## 族一 · 会话与投递核（全部闭合）

### R-1 uuid 签发权 ✓（对应 OPEN-1）

**发送方签发 + 邮局登记校验制**。首条消息的发送方生成 UUIDv7（时间有序——会话列表排序 /
文件局部性友好），随首消息投递，零往返零回写；续聊在投递前即有稳定键。

- 理由链：邮局签发与宿主可缺席（CLI 直连）内在矛盾——签发必须是不需要许可的动作；
  uuid = 会话出生证明，第一条记录写在发送方账本，按写权=所有权归发送方。
- 邮局角色 = 登记 / 一致性校验：首次见 (uuid, participants) 登记，再见校验，不一致
  fail-loud（防身份冒用）；纯直连期间双方账本各自为真，邮局在场时对账。
- 「发送方」实例化：webui → 宿主代 user 签发 · CLI 直连 → agent 进程 · 群 → 创建者 ·
  subagent spawn → 父 · 存量迁移 → 脚本 hash(pairKey) 确定性代签（幂等，脚本即事实发送方）。
- 已排除：接收方签发（时序最劣）；hash(participants) 确定性派生（与同 participants 多会话
  能力冲突，加序号即回中心化）。
- 双方同时互发 = 两会话并存（特性非故障，回复按信封 uuid 路由不串）。首条消息原子性：
  生成 → 写本地账本 → 投递（at-least-once + requestId 幂等），任意点崩溃无孤儿。

### R-2 写入时点与职责对称 ✓（对应 OPEN-2）

写入职责跟着通信原语走，不跟主体身份走（见 D2 时序）：send = 写自己账本（own 发言）+
投递；receive = 写自己账本（对端来函 peer 包装）+ 激活 run，run 内部与终稿全部写自己
账本；终稿回复 = 一次普通 send（终稿已在账本，send 只投递）；对端收回复 = 一次普通
receive。没有中心写者，每账本的写者恒为本端点的原语调用；「回复」不是特殊事件。双通道
同构。

- user 端点无进程 → 必须有壳：webui 形态 = 宿主进程内极薄 user 壳；CLI 直连形态 = agent
  子树内的 user 端点桩。**user 账本的写者 = 当下与 user 通信的 agent 实例（的 user 端点
  桩）——每会话本地写者，非全局唯一写者**。

### R-2a 双壳并发写 user 账本 ✗（伪问题出局）

两壳 = 两个生产者，落账一律经 user 账本单写者队列，inbox / steer / next-turn 排队语义
原样适用；写单元是消息行，行间只有顺序没有冲突，顺序正是队列本职。残余仅体验语义
（webui 与 CLI 同活时界面刷新）= UI 订阅问题（session/run-settled 事件驱动重拉机制已有），
非架构裁决。

### R-3 收件确认协议 ✓（对应 OPEN-3）

**落账即确认**。三合一：

- ack = 账本行落盘（journal/partials 台账——run 期间 messages 静默的既有机制）；
- 幂等 = requestId 对账（重投到达先查已落账：重复即丢 + 补发 ack，不重复入账不重复触发
  run——cr-250 准入去重机制照搬）；
- 重投 = 投递方未收 ack 超时重试（缺省 30s 量级），**传输层重投与会话层排队正交**——run
  期间到达的消息走 inbox 的 steer / next-turn 语义，两层职责分离互不纠缠。

为什么不是「run 收束才确认」：确认边界 = 消息在收件箱的滞留时长，run 收束确认 ⇒ 长跑 run
期间投递方超时连环重投、收件箱膨胀、消费停摆，且 run 中途崩溃时「已消费未确认」语义直接
歧义（要不要重跑？）；落账即确认把崩溃恢复收敛为单问「journal 里有没有这行」（recoverJournal
惰性收口机制已有）。边界注记：落账即确认保证消息不丢不重复入账，不保证一定触发 run——
账本有行但 run 未跑（激活失败等）的窗口由收件箱未消费标记 / settlement 事件兜底，与
steer-stash 崩溃窗口处理同构。

## 族二 · 子树边界（外部推演采纳 + 两处修正）

### R-4 子树边界 = 信任边界；离线不可装载 ✓（对应 OPEN-4）

积极定义见 D3。推论：**离线不可装载**——装载 = 引入新代码 = 授权动作，按定义必然在域外。
装载请求 = 一封信（agent → 宿主），收件箱 durable 滞留，宿主回归过完整授权管道（全系统
唯一异步语义：信封 + durable + requestId 幂等，装载不设第二套）。装载回执进 agent 经验流
（与 R-12 观察回执同构；静默生效是反自治的）。

### R-4b 投递与授权分离 ✓（修正——「宿主投递与 CLI 投递行为不一致」质疑的消解）

R-4 原推论（外部）把「经邮局投递」也划进了授权面，混淆了宿主两个角色——邮局 = 传输服务
（纯基础设施无价值判断）；门禁/审批/凭据授予 = 授权服务（含价值判断，控制面本义）。离线
不可的是**新授权**，不是**传输**：装载引代码需要授权故离线不可；把消息从 b 送到 a 不涉及
授权决策，传输不需要许可。修正后统一模型见 D2（投递原语一种、通道多种、协议层恒一）。
「全系统一个异步通信语义」的准确含义 = 协议层一套（信封/durable/幂等），不含通道层。

### R-6 memory / persona 三层直读 ✓（对应 OPEN-6）

| 层 | 写权 | 依据 |
|---|---|---|
| 身份数据（人格/模型引用/档案） | user 的编辑面（宿主在线 = webui），实例只读、每 run 前重读 | 谁塑造谁写 |
| 经验数据（memory timeline） | 激活实例 | 经验 = run 产物的跨 run 蒸馏，归产生方 |
| 会话账本 | 激活实例 | R-2 既裁 |

- 直读理由（修正表述）：CLI 形态下 RPC 对端根本不存在——RPC 读自己的身份 ⇒ 宿主缺席即
  失忆，违反自治。activation 单例锁第二重语义 = 记忆单写者守护。
- 注记：CLI 形态 persona 编辑面缺席——编辑推迟到宿主回归（用户可直改文件）。只读影子实例
  不破坏模型；双活先撞单例锁墙。

### R-9 承重工具代理协议 ✓（对应 OPEN-9，外部推演 + 修正）

跨边界调用语义四类：请求-应答（信封携带完整裁决语境，裁决单源在宿主，协议只搬调用不搬
裁决）；流/进度（纯工程件）；中断（**不设独立协议**——中断 = run 收束的 finish 原因〔现状
finish='interrupted' 同款〕，run 生命周期事件本就必须跨进程可见，并入即得）；审批（**不是
新协议，是 user 端点的消息形态**——审批卡 = 投给 user 的带选项问题信封〔ask_questions
字面同构〕，回答 = user 回信，R-1/2/3 原样适用；CLI 时 user 端点桩在终端承接。现状
approval 与 ask_questions 两套相似机制由此统一）。

**第五组成：在途认领（lease/claim）**——子树发请求 → 宿主执行长工具 → 子树崩溃重启 →
journal 见「已发出无结果」；解 = 在途回执按 call.id 索引 + 重连认领（宿主侧 TTL 保留）。
与 R-3 对称：防重复消费 vs 防结果失联。**修正：机制同构但 id 分域**——认领用 call.id、
消息去重用信封 requestId，两域独立编号防撞名。**残余（双方皆重启）**：结果物理丢失 →
journal 标记该步失败/中断，agent 自行重试（LLM 循环天然处理）。形状约束：transport 可
插拔，同进程退化为直调——否则两形态两套代码，共享子树定义名存实亡。

### R-5 subagent 双形态 ✓（对应 OPEN-5）

判据 = 是否需跨 activation 存活：

- **run 内嵌**（并行探查，生命周期 ≤ 父 run）：父实例内嵌套会话（run 中的 run），账本归
  父树，工具面同进程裁剪，父停子停。
- **durable 委托**（长任务）：spawn 创建派生 agent（进注册表）+ 投递任务信封；子成为真
  实例（自己的树 / 激活 / 通信走投递）。剥权在创建时——**继承是快照不是镜像**（父此后改
  配置不传播，与现状 STRIPPED_TAGS 语义同构）。

spawn 显式声明 lifecycle: 'run' | 'durable'，不靠隐式推断。账本归属：内嵌 → 父树；durable
→ agents/<subid>/，uuid 照 R-1（父 = 发送方签发）。代价诚实：双 spawn 语义是认知成本，
但「并行探查」与「长任务委托」本不同质；durable 救回委托本义——委托物在父 run 结束、
父去激活后仍独立存活。

### R-11 LLM 凭据供给 ◐（新增——外部推演捕获的档案内在矛盾）

矛盾：D7 条 4（原 §4 条 4）把 credentials 列入承重件，D3 又宣称 CLI 形态会话能力完整——
子树内模型直连的凭据来源无裁决，两项相抵；不裁决则落地第 2 步验收不成立。候选：

- ① 受权副本下发 agents/<id>/（凭据盘上扩散 N 份）；
- ② user 端点桩现场供给（每次激活仪式化）；
- ③ **共享数据根直读**（凭据库 = 数据根资产物理单副本，同盘同用户宿主与子树皆可直读；
  注入 = 纯库两侧共用；授予/轮换 = 授权动作离线不可——由 R-4 积极定义直接推出）。

倾向 ③：零副本零仪式、与边界定义自洽。

## 出局问题（裁决不复发）

- **webui 群视图合并 ✗**：user 虚拟 ≠ 无账本——user 是群成员，扇出天然把每条发言投进
  user 账本（own/peer 投影通例适用），webui 群视图 = 读一份账本的单读者单投影，不存在
  N 方合并步骤。推论：可见性 = 成员资格（user 不在场的群在 user 账本中不存在 = 正确的
  不可见）。残余：全知视角（审计/调试）唯一正当消费者是宿主——邮局经手全部投递，需要时
  留投递台账（运营日志，非会话账本）；N 方合并只在多宿主联邦才是真问题（远期）。
- **存储 ~2x（1v1）✗**：重复的只有对话终稿层；字量大头（思考 / 工具调用与结果）归产生方
  独占（投影分层）。agentic 会话中终稿通常是个位数百分比占比。群聊现状已是 N+1 份（本体+
  N 转录）、新模型 N 份反而少一份；群转录流现行经济学（cr-4 扇出不复制各成员 run 内部）
  即先证。
- **亚插件粒度热换非框架缺口 ✗（定性改判）**：cordis 源码勘察（fiber.effect / DisposableList /
  Fiber 构造器）证实三层注册表嵌套（见 D7 条 2）。「拔」半边原生闭合：dispose 单个 effect
  条目 = 调 wrapper disposer，O(1)，不重启 fiber。「装/换」半边三个精确缺口全在属主侧：
  ① effect 无名寻址（label 仅诊断，键 = 插入序号 + 对象身份）——按名替换需属主持有
  disposer；② 无「重执行第 N 个 effect」——effect 是闭包不是数据，重注册 = 属主重调注册
  函数；③ ESM 绑定——新代码仍需动态 import + 缓存驱逐。模式 = dispose 旧条目 → 动态
  import（?t= bust）→ register 新条目，零新原语、零 vendor 改动；剩余裁决只是行要不要
  长成「薄壳 + 能力模块 + 持有 disposer / 暴露 reload 入口」形态（模式选择非缺口）。

## 待裁决清单

| # | 问题 | 状态 | 备注 |
|---|---|---|---|
| R-7 | 版本指纹规范形态（三元组？暴露位置？） | ◐ | 五步闭环第 0/4 步前置（cell 档案 §5 点名现缺） |
| R-8 | 健康检查点判定标准 · 快照频率 / 保留 | ◐ | 逃生门质量前置；与 ac-backup 轮转机制关系待钉 |
| R-10 | 存量迁移窗口 · 双读 · 恒等门测试范围 | ◐ | 落地第一步前置；additive-only 纪律已定（D6 条 3） |
| R-11 | LLM 凭据供给 | ◐ 倾向③ | 落地第 2 步前置（见族二） |
| — | 新成员入群回填 | ◐ | 一次性导入语义待细化 |
| — | MCP 服务器归属 | ◐ | 倾向由 R-4 覆盖（连新服务器 = 授权动作离线不可）；已配置服务器的连接归属待钉 |

## 五步闭环（自进化最小工程量——待 R-7/R-8 补全）

朴素三步（backup → 卸载 → 装载）中，cordis 已把 2、3 焊成原子：Entry.update / fiber.update
是事务化的 dispose+start（失败自动 restore 旧 fiber），reloadFiles 带模块级回滚。真正缺的
是前后各一步：

| 步 | 内容 | 形态 | 现状 |
|---|---|---|---|
| 0. 版本指纹 | 我现在跑的是什么 | git commit + dirty + 行集 hash（cordis.yml ∪ patch） | 缺 → R-7 |
| 1. 快照 | 失败可退 | 快照链 last known good（见 D6；结构回滚 = 行 disable 已自动化是第一道闸） | 部分 → R-8 |
| 2+3. 换装 | 卸载→装载 | cordis 事务原子（Entry.update / reloadFiles） | 已实现 |
| 4. 观察回执 | 变化已生效/失败 | 双向：成功 = 新宿主向存活 agent 注入指纹+行状态+熔断态（context-injected 机制复用）；失败 = 回退快照后注入「升级失败，已回退至 <指纹>」 | 缺 → R-7 |
| 5. 验收/回滚判定 | 新版本好不好 | agent 自判（会话续跑 + bench 门，cell 档案 §8 同款） | 缺 |

裁决：**backup 减负**——自进化不要求每次变更前全量快照；supervisor 只守结构回滚机制本身
（patch 文件 + 熔断）不可被热插拔触碰。内容回滚是 agent 的活，走普通工具调用。

## 本档案纪律

- 探索档案（explore/）：非裁决、未评审；立项时迁 src/docs/ 正式目录并过评审。
- 编号映射：R-n ↔ OPEN-n（讨论稿配图 HTML 用 OPEN-n；本文 R-n 为准，R-4b 为族二追加修正）。
- 裁决可被后续讨论推翻（附理由与日期），但不删除——保留推理链。