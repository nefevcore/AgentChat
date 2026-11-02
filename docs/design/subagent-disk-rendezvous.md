# subagent 盘面会合通信设计（脱离 host 的 agent 间通信）

> 性质：**设计裁决档案**。回答「parent↔subagent 及 agent 间沟通如何脱离 host 成立」。
> 结论先行：**盘面即注册表、锁即路由、信箱即兜底、账本即回音、宿主即加速器**。
> 正确性（送达、幂等、防自激、仲裁）全部落在数据根盘面与纯协议层，宿主/邮局
> 提供的只是延迟优化与增值服务，缺位 = 退化「信等人」，不是故障。本文是
> subagent 重构（ac-shell-subagent 换轨：物化 + 寄信 + 读账本）的通信层总纲，
> 与 subagent-recovery-matrix.md（恢复面边界）互为正反面：矩阵记录补丁现状，
> 本文给出让多数恢复面失去存在理由的目标形态。2026-11-02 立（cr-858）。
> 2026-11 修订（supervisor-service-plan.md 立档）：加速器家族扩编——system 层
> （supervisor）与宿主同列，boot 配方入盘面（.runtime/recipes/）补齐「进程怎么
> 被拉起」的注册表缺项；「拉起无人兜底」的形态光谱定形，见 §四.2 修订。

## §零 事实基线（推导前提，全部代码核实过）

1. **无 host 形态已在跑**：e2e-subagent.test.ts 的 startParent 直接 spawn
   boot.ts 拉父壳，全程无宿主进程，测试恒绿——「脱 host」不是假设是现实。
2. **路由器是纯函数、拓扑在盘上**：routeEnvelope（router.ts）零 IO；可达表
   只是「谁最近应答过」的缓存；群拓扑在数据根（router 注释原话「邮局只持
   执行期快照」）。
3. **锁即路由表**：activation.lock 含 transportHint（socket 地址），写在
   agents/<id>/（或 children/<parent>/<id>/）盘面，任何进程可读；死进程
   陈锁由「重拉 acquire 自然获锁」接管（supervise 既有语义）。
4. **幂等面在接收方**：.deliver-seen.json + requestId 去重住接收方盘上
   （cr-250），不经邮局。
5. **协议层恒一（D2）**：信封协议（requestId 幂等 / budget 防自激 / uuid 登记）
   住 ac-envelope-core 纯库，从未假设宿主存在。
6. **账本是 append-only 事件流**：终稿行/段行/注入行带 run 键，watchLedger
   增量 watch 原语已存在（ac-webui-core）。

## §一 双层会合机制（本设计的核心）

把「找到对方并送达」定义成两级，全部以数据根为媒介：

```
deliver(envelope):
  1) 活体会合：lock = readActivationLock(对端目录)
     lock 在 → connect(transportHint) → send → 等 ack（fresh=false 即幂等命中）
     连接失败/陈锁 → 落第 2 层，不猜
  2) 离线会合：原子写 对端 sessions/<对桶>/inbox/<requestId>.json
     （tmp+rename，与 materializeChild 同款原子性）
```

- **信箱地址是路径代数**：agent id + 对键桶模型 ⇒ 目录路径纯函数可推，零目录
  服务。寄信不需要邮局，只需要收件人的信箱地址。
- **回程对称**：子回父读 agents/<parent>/activation.lock 直投，父不在则落父的
  会话 inbox；终稿/提问走账本 watch。每个壳都写自己的锁、都有自己的信箱，
  会合机制天然双向对称。
- **宿主/邮局的增值面（全部可缺位）**：拉起（ensureHook——信不丢只是等），
  连接池与重试调度（性能），观测聚合（poller/runbeat）。「等」是合法状态：
  at-least-once + requestId 幂等 + budget 保证晚到的信不重复、不放大。看板与
  await 报 pending 而非 error——现有词汇已支持。

## §二 逐面映射（hostful 形态 vs 盘面自有）

| 沟通需求 | hostful（今天） | hostless（盘面自有） |
|---|---|---|
| 寻址 | 邮局可达表（内存缓存） | 路径代数：id → agents/<id>/，会话 → 对键桶 |
| 活体发现 | 可达表 hint | activation.lock（活壳自写，死进程锁自陈） |
| 离线送达 | 邮局 outbox 滞留 + flush | **inbox 直投**（优于 outbox：落盘即完成送达， |
| | | 只剩「接收方何时来取」） |
| 幂等/去重 | 邮局转发 + 接收方落账 | 接收方 .deliver-seen.json——本来就在接收方 |
| 防自激/预算 | 信封 budget 字段 | 纯协议语义随信走（任务信=2、代答信=0 已在用） |
| 群播展开 | 邮局 MulticastTable | 群拓扑在数据根，发送方读拓扑自行扇出 |
| 身份防冒用 | 邮局 uuid 登记全局 fail-loud | 降级接收方局部校验（会话账本史核对）； |
| | | 全局校验降为纵深防御层 |
| 串行化仲裁 | —— | 接收方会话状态机（三层架构第一层），host 从不仲裁 |

## §三 工程形态：deliver() 对等投递纯库

按「最少抽象」判据，此处出现了真资格的新纯库：**deliver(dataRoot, envelope)
** 双层会合算法（锁读→直连→失败落 inbox；群地址先读拓扑展开）。零 cordis、
零进程假设，每个壳内嵌一份。邮局改为该库的第一个增值消费者（叠加连接池、
重试、ensureHook 拉起、uuid 全局校验）。

hostless 不是一个需要单独建设的模式，而是**同一投递函数去掉可选钩子的自然
退化**——与 ensureHook「拒绝/缺钩子不阻塞投递」（post-office.ts）严格同构。

## §四 诚实的边界（没有 host 真不行的）

1. **同数据根内的去中心**：单机或多机共享盘。跨数据根（无共享盘）必须有中继，
   而中继无论叫什么，形态上就是某种 host——这是物理不是缺陷：无共享媒介则无
   会合点。独立 router 进程（见 post-office-detach-plan.md）是该中继的本地雏形。
2. **拉起无人兜底时延迟不可控**：信件正确但可能等到天荒地老；产品语义显式承认
   「信等人」是合法状态。
   > **2026-11 修订（supervisor-service-plan §三）**：「无人兜底」光谱已定形——
   > supervised 形态 system 层无条件兜底（零活壳场景的唯一恢复保证）；dev 形态
   > 恢复边（host-revive）按盘面配方顶班；本项边界收窄为 hostless 形态专属
   > （按需重开，信等人）。
   >
   > **2026-11-02 落地（cr-859）**：dev 入口已统一 supervised（`pnpm dev`）——
   > 常态 dev 形态本项边界不再适用（system 兜底在场）；即时恢复边仅存于
   > `dev:fg` 逃生门与 hostless 形态。配方盘面（.runtime/recipes/）与 system
   > 心跳双证据已落地，「盘面即注册表」的「进程怎么被拉起」缺项已补齐。
3. **无全局观测与全局身份警察**：每会话账本可独立回放（审计不缺），但无跨会话
   聚合仪表盘；uuid 冲突检测从全局 fail-loud 退化为接收方局部校验，冒用检测
   变弱。互信要求高的场景宿主值得在场。
4. **时钟与并发写**：inbox 原子写靠 rename，文件名即 requestId，一个 requestId
   只有一个发送方——多发送方并发写同一信箱不冲突。此点盘面方案比内存路由表
   更稳。

## §五 对恢复矩阵的消解（与 subagent-recovery-matrix.md 对账）

矩阵 §二的共同根因是「谁负责把运行时态收敛回盘上事实没有单一 owner，于是每个
窗口长出一个面」。盘面会合给出一致答案：**owner 缺位不再产生窗口，只产生延迟**。
对账：R2（recoverPendingInbox）从「恢复面」升格为常驻投递语义的一部分；R7
（outbox flush）的滞留职责被 inbox 直投取代大半；R5/R6（ask 对账/await 合成
回执）随 subagent 重构换轨自然收敛；R8/R9（usage/runs 对账）与通信无关，不动。
矩阵文档仍是对账面——本表落地时同步更新其 §一/§三。

## §六 落地次序（与 subagent 重构共用底座）

> **落地状态（2026-11-02，cr-861/862/863）**：第 1 步已落地——deliver 双层会合纯库
> （ac-envelope-core/deliver.ts，单测覆盖活体直投/幂等命中/无锁落 inbox/
> 陈锁降级/回程对称）；ipc 传输（IpcClient/listenIpc，接口正名 IpcServer）
> 自 ac-post-office 移入协议库断「deliver → post-office」循环依赖。第 2 步
> 已落地（cr-862）——subagent 投递换轨：sendViaLock/answerOp/deliverToChild
> 三处内联锁直投退役，统一走 deliver()（children 域路径代数）；死子语义
> 从 fail-loud 升级为落 inbox + owner 重拉（reviveChild——父 owns 子，重拉
> 壳 boot recoverPendingInbox 消费落盘信；代答/回信面维持原语义）。第 3 步
> 已落地（cr-863）——回程对称换轨：子壳终稿回执（postReply 对 to=parentId）
> 走 deliver()（无邮局/hostless 形态也回执，父缺席落父 inbox 由其
> recoverPendingInbox 消费）；子域提问双通道——子壳订阅 durable-interaction/
> opened 推 childAsk 信封（载荷仅 interactionId，正文以父侧盘读为准），父侧
> receiveEnvelope 拦截转 subagent 行 notifyChildAsk 单源（盘校验 + askNotified
> 幂等门），盘 watch 保持第一通道；reconcile 对活锁子重建 watch（S2 断根）。

deliver 纯库独立先行（零装配面，单测覆盖双层路径）→ subagent 投递换轨（三段式
退役，sendViaLock 形态转正）→ ask 通知/终稿回执统一走信封 → 每步走验证阶梯
（动了通信链路：pnpm test 全量 + e2e）。行为语义（回执、归档、幂等键）全保持。
