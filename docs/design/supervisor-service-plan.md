# supervisor 分层监护设计（system 层定位裁决档案）

> 性质：**设计裁决档案**。回答「进程监护体系如何分层、supervisor 在其中的定位」。
> 结论先行：**supervisor ≡ system 层**——不可被模型内任何进程监护的底；常态监护
> 是单向树（system→host/router，host→shells）；system 层 = supervisor 进程 + 盘面
> 约定；监护权威与恢复执行分离——单向性约束的是权威方向（判死/击杀/熔断/退避
> 决策唯一归属上层），不是拉起动作的物理能力（幂等 + 盘面锁仲裁，任何活进程可
> 执行）。本文由 2026-11 五轮设计讨论收敛立档（演进链见 §二）；对 D5/cr-612 语义
> 有重述、对 post-office-detach-plan §三.3 有裁决修订（§四）。

## §零 事实基线（全部代码核实过）

1. **supervisor.mjs 单子监护宿主**：WORKER_ENTRY 硬编码 boot.ts；退出码协议
   0/42/78/其他（ac-supervisor-core decideOnExit：42 固定 1.5s 重拉不计熔断、
   78 不重拉、崩溃指数退避 + 10min/5 次熔断）。纯 JS、不依赖被监护物——红线。
2. **壳的监护在宿主 warden 循环**（supervise.ts + ac-guardian）：idle 收割、按需
   拉起、心跳判死——与 supervisor 是两套机制两个纯库：形态相似、语义不同
   （业务监护 vs 崩溃监护）。§一分层将其命名为不同层的两种监护，非待统一物。
3. **host-revive 常态化**（cr-612 用户裁决）：任意宿主死亡（邮局失联探测），活壳
   拉起宿主；supervised 拓扑让路（cr-647 宽限 10s，AGENTCHAT_SUPERVISED env
   继承链判定——本文 §三.3 判定基础升级为 system 心跳探测）。
4. **activation.lock 只含 pid/bootId/transportHint，不含 boot 配方**：壳的重启
   知识（argv）只在宿主内存——cr-648 监护真空（宿主换代后老壳只回登记不接管）
   的根源。§五配方盘面直接填此缝。
5. **.runtime 单写者锁**（acquireRuntimeLock）：陈锁 pid ESRCH 判死回收、pid
   复用保守视为活——双 supervisor 实例天然仲裁（隐式主备，换代窗口自动收敛）。

## §一 分层模型

```
system 层   supervisor 进程 + 盘面约定（recipes/ 单写者锁 停机戳）
            ——模型内无进程监护它；恢复出路 = 模型外（用户冷启动 /
            未来 OS 服务形态——触发线见 §五.4）
宿主层      host、router——system 直辖（resident 配方，崩溃监护语义）
worker 层   shells——host 直辖（动态生灭，业务监护语义：idle 收割/按需拉起）
```

- **system = 进程 + 盘面的组合**：supervisor 死亡窗口内盘面仍在，恢复执行依据
  照常成立——「宿主由 system 监护」在窗口期语义不断，断的只是值班者。
- **「不可监护」是模型裁决不是物理能力**：物理上任何活进程都能 spawn 它。
  单向性约束权威方向（负向决策必须唯一——分散的「停止重拉/熔断」意见永不
  收敛），不约束拉起动作（正向动作幂等，多执行者经盘面锁收敛为一）。
- **两种监护不通用**：system→host/router 是纯崩溃监护（退避/熔断/退出码）；
  host→shells 是业务监护（idle 是自杀不是崩溃、按需生灭）。supervisor 不理解
  agent 生命周期——「宿主 owns 语义，system owns 存活」，与 router 拆分
  「owner 管生死，信使管送达」同一句式。

## §二 裁决演进链（讨论记录，含被否决形态）

1. **双向星提案**（初版）：supervisor 为中心恢复任意对象 + 任意对象可拉
   supervisor。否决原因：反向监护边制造决策环，恢复风暴风险；底部层不可
   消除只能上移（先例：systemd 底是内核、OTP 底是 heart）。
2. **多 supervisor 议题**：常态多主否决（kill 权唯一性 + 熔断状态碎裂 +
   回归不封顶）；「可存在多份、权威恒唯一」采纳（锁仲裁机制已有）——多实例
   只在换代窗口出现，supervisor 升级走影子模式（只记录决策不执行）+ 配方
   owner 字段移交。
3. **分层裁决**（用户）：system/宿主/worker 三层；底层监护上层、不可反向；
   host→shells 与 system→host 形态相似作用不同。
4. **术语归一**（最终澄清）：supervisor ≡ system——无新实体、无改名、无删除。
   模型在 supervised 形态下**已实现**（restart_shell = warden 链；
   restart_host = 退出码 42 → supervisor 1.5s 重拉，均现状行为）。本文净产出
   = 概念命名 + 边界裁决 + 增量清单，不是新架构。

## §三 监护权威与恢复执行的分离（host-revive 重述）

纯单向规则会禁止 dev 形态的 host-revive（壳拉宿主也是下层动上层）。裁决：
**保留并重述**——host-revive 不是「shell 监护 host」，是「system 权威缺席时，
活对象按盘面配方执行恢复」。分形态：

| 形态 | system 在场 | 宿主死后的恢复执行 |
|---|---|---|
| supervised（pnpm dev，cr-859 起缺省） | supervisor 值班 | supervisor 快路（退出码 42 → 1.5s）；壳让路 10s |
| dev:fg（前台直跑逃生门） | 缺席 | 活壳按盘面配方直拉（host-revive，宽限 0） |
| hostless（CLI/e2e） | 缺席且无宿主 | 无恢复边——按需重开（信等人语义） |

1. 让路判定从 env 继承链（AGENTCHAT_SUPERVISED——第三方重拉壳后失真）升级为
   **system 心跳探测**（活 = 锁内 pid 活 ∧ 心跳文件 mtime 新，双证据）。
2. 监护树描述常态权威；恢复边是缺席降级——树与边不矛盾，约束对象不同。
3. dev 入口已统一 supervised（§六.2 落地 cr-859，`pnpm dev`）——恢复边在
   dev 形态自然退化为纯让路语义（仅 dev:fg 逃生门保留即时恢复边）。

## §四 对既有裁决的对账

1. **D5 相互恢复环**（per-agent-instance-architecture.md）：环论证（rollback-
   not-retry 收敛性）**退役**——常态是树，无环无需论证收敛。边 1（宿主→agent
   升级回退）原样保留；边 2（cr-612 常态化）降格重述为「缺席形态的盘面执行」
   （§三）。保底 supervisor 描述（D5「第三方冷启动通道」）升格为 system 层
   正身。
2. **post-office-detach-plan §三.3**：「拉起留宿主 poller，router 永不拉进程」
   **修订为「拉起归 system 层」**——router 拆分时配方 owner 上收 supervisor。
   比原裁（归宿主管）更自洽：router 与 host 平级，host 不应管其生死。§四
   进程图景相应变为四角色：supervisor（infra 生死）/ router（信使）/ host
   （编排+用户面）/ shells（工人）。
3. **cr-647 让路窗**：语义不变，判定基础升级（§三.1）。
4. **盘面会合（subagent-disk-rendezvous.md）**：无冲突——「宿主即加速器」推广
   为「system 与宿主都是加速器，盘面是正确性」。本文配方盘面与其共享「盘面
   即注册表」哲学。

## §五 工程增量清单（按依赖序）

> **落地状态（2026-11-02，cr-859）**：1、2 已落地（ac-supervisor-core 的
> recipes.ts / system-heartbeat.ts + 双 supervisor 接线 + orchestrate 拉壳
> 配方 + host-revive 双证据让路）；§六.1 根入口纯移动 apps/system/ 与
> §六.2 dev 统一 supervised（dev:fg 逃生门）同批完成。3、4、5 仍在触发线
> 上等。

1. **配方盘面**（前置，独立有价值）：dataRoot/.runtime/recipes/*.json——id /
   boot 命令 / 监护策略 / resident|on-demand / owner / mode(authoritative|
   shadow)。填 cr-648 监护真空（宿主换代后可按配方接管老壳）；router 拆分、
   supervisor 多子化的共同前置。
2. **system 心跳面**：心跳文件周期 touch + 锁内 pid 双证据；对象侧守望统一
   判定（§三.1）。
3. **退出码协议多子化**（router 并入时触发）：解绑「worker 0 退 = supervisor
   一并退」的单子语义；supervisor 自身退出条件重定义（全部 resident 熔断 /
   用户停机）。
4. **router 配方注册**：与 post-office-detach-plan §五三触发线合并——命中时
   owner 上收 system（§四.2）。
5. **OS 服务形态**（触发线：产品走向常驻服务/多用户部署）：届时 system 进
   SCM，Session 0 隔离/安装器/多数据根服务化是彼时必做题。本文分层不变，
   只换 system 的爹。

## §六 补充裁决（2026-11 第二批讨论）

1. **supervisor 不 cordis 化**（否决提案：迁入 apps/ 用 cordis boot）：命运隔离
   铁律是承重墙——cordis 树启动图与被监护宿主重叠 = 坏提交同灭「拉不起来的
   拉起者」，D6 快照回退通道要求外部件依赖面与被监护物不相交。supervisor
   无能力面可组合，system 层是唯一不得与被监护层共享组合框架的进程；
   策略共享走 ac-supervisor-core 纯库（既有形态），同映像经自重 exec 已满足。
   允许的妥协：根入口纯移动至 apps/system/（零 import 变化，**已落地 cr-859**），
   cordis 不行。
2. **dev 入口统一 supervised**（原 §六.1 开放裁决落定；**已落地 cr-859**）：
   `pnpm dev` → apps/system/supervisor.mjs（缺省与原 dev 一致：workspace/home、
   3830、stdio inherit）；前台直跑保留为 `pnpm dev:fg` 逃生门（调 supervisor
   自身 / 无监护形态）。理由：恢复边（§三）在零活壳场景（boot 期崩溃 /
   idle 全收后宿主崩）无执行者，supervisor 是唯一无条件恢复保证；双入口
   心智负担（cr-560）以「默认被监护」消解而非删除。连带清理：boot.ts
   EADDRINUSE 文案、face-ops 版本注释。产品入口（pnpm start）是否同轨 →
   并入 §五.5 触发线。

## §七 开放裁决（未定，后续修订标注）

1. supervisor 自身升级流程细化（影子模式日志面 / owner 移交的时序细节）。
2. supervisor 退避熔断状态换代蒸发：当前轻解（换代归零 = 大故障后宽限）；
   若实战出现恢复风暴再加周期落盘（.runtime/supervisor-state.json）。
3. 产品入口 pnpm start（bin/agentchat.js 前台直跑）是否同轨 supervised——
   与 §五.5 OS 服务形态触发线合并考虑。

一句话：supervisor 不是宿主层的冗余对象，它就是 system 层在项目侧的全部实体——
分层归位后，监护树恒单向、恢复边恒降级、底部永远诚实（模型外保留冷启动出路）。