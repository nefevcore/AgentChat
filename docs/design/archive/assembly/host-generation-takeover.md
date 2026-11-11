# 宿主换代完整接管（host-generation-takeover）

> 性质：域深设计 + 三批实施记录——监护权从 spawn 管道改挂 socket manage 通道，宿主换代对活壳完整接管。
> 读者：动 supervise / orchestrator / takeover 监护链、或排查壳判死与换代振荡的人。
> 状态：已实施待归档 · 2026-11-09 设计提案，同日三批全落（cr-966 批1 双源喂活 /
> cr-967 批2 socket-only 句柄 + boot 完整接管 / cr-968 批3 退役面，
> 裁决入 host-shell-decisions.md〈换代接管〉）。本文档取代同日删除的
> 结构评审存档（原 cr-964）。E1/E2 余量按 §8 已重估（cr-969）。cr-1008 2026-11-11 批1 检阅：`adoptLiveShells` / `takeover.ts` 均在位（apps/host）。

## 1. 背景:评审结论摘要(为什么是这个方向)

大骨架(宿主-壳双进程/信封投递/行集插件/会话状态机)无结构错误;
问题集中在「壳的生命周期」域,根因一条:

**监护权的载体(spawn 时的 stdin/stdout 管道)不可继承——「host 管
shell」只在一代宿主内成立。** 宿主换代后:

- 心跳(guardian.ping TSV)/run 节拍走 stdout 管道,随旧宿主消亡;
- 新宿主对盘上活锁壳只能**降级收复**(rescueLiveShells:回登记可达 +
  re-tap;控制面经 socket manage 通道借道——cr-675/659),判死/退避/
  熔断全缺失,「完整 adopt 链归下次拉起」;
- 壳侧因「宿主可能缺席」武装 host-revive + 让路窗 10s(cr-612)——
  反向依赖由此而生。

由此派生的两个次级结构问题(评审存档的 E1/E2,此处只留结论):

- **E1**:可达表 ≥8 写点、双真相源(锁 pid 活 vs pipe 通)互写打架——
  boot 窗口振荡事故族之根(cr-963 现场为症状)。
- **E2**:壳生命周期状态散布五层,五套退避时钟——事故位置分布的
  指纹(cr-547/647/681/805/885/962/963 集中于此域)。

**本方向(E0)落地后**:监护不绑管道 → 换代可完整接管 → rescue 降级
语义、host-revive 让路窗、E1 的大部分写点、E2 的大部分时钟自然失去
存在理由——是断根级别的一手,E1/E2 的余量届时顺手收敛。

## 2. 目标与非目标

**目标**
1. 新宿主 boot 后对盘上活锁壳**完整接管**:可达 + 控制之外的
   心跳判死 / idle 收割 / 崩溃感知 / 按需重拉全部就位;
2. 判活升级为**双源**(stdout ping + socket 探测),单源损伤不误判;
3. 退役三块历史补偿:rescue 降级语义、host-revive 让路窗、
   cr-675 老壳黑名单/降级路径(本机已无存量壳,2026-11-09 确认)。

**非目标**
- 不改信封投递语义(at-least-once 不动);
- 不做生命周期五层状态机的整体收敛(E2 余量另立——本方向落地后
  规模自然缩小);
- 不改壳侧 boot 协议(manage 通道已存在,壳侧零改动或近零)。

## 3. 现状机制盘点(实施的事实基础)

| 机制 | 现状 | 锚点 |
|---|---|---|
| socket manage 通道 | **壳自己 listen**(transportHint = socketPathFor(dataRoot, agentId) 纯函数派生);宿主按呼不持连(每次独立 IpcClient,cr-656) | ac-envelope-core/manage.ts |
| 换代发现 hint | 壳取锁时写进 agents/&lt;id&gt;/activation.lock;新宿主扫锁 + 探活 pid | orchestrator.liveShellLockOf / rescueLiveShells |
| 周期 run-state 探测 | poller peek() 每拍 manageCall run-state——**socket 心跳事实上已在跑**,只是结果未喂判死面 | orchestrator.peek(cr-748) |
| 判死 | warden 仅吃 stdout guardian.ping(supervise.feedLine) | supervise.ts / ac-guardian |
| 控制 | 池内走 stdin 管道;池外活锁壳走 socket(cr-805 借道) | orchestrator.control |
| 崩溃退避/熔断 | supervise 自持(1.5s×2ⁿ cap 60s;活过 30s 归零) | supervise.ts(cr-551) |
| 壳侧复活宿主 | host-revive:宿主缺席判定 + 让路窗 10s | apps/shell/host-revive.ts(cr-612) |

## 4. 设计:socket-only 监护形态

### 4.1 句柄双形态

SuperviseHandle 派生**socket-only 形态**(无 spawn 管道的接管壳):

- **心跳源**:poller peek 的 run-state 探测成功 = 喂活(等价 ping);
- **判死**:探测连续失败跨 warden 心跳窗 → 判死;
- **kill**:经 socket shutdown 帧;不应答 → 按 activation.lock 内
  pid 强杀(锁是壳自写的 kill 凭证——与「绝不扫进程表」纪律一致,
  这是点名 pid 非扫描);
- **重拉**:kill 后锁自然释放 → ensureAgent 常规链(退避档沿用)。

spawn 形态(现状)增加双源:stdout ping 与 socket 探测**任一在喂即判活**,
双源齐断才判死——假死壳(循环挂死)两源同断照杀;管道损伤但循环健康
的壳不再误杀。

### 4.2 接管流程(替代 rescueLiveShells 的降级语义)

新宿主 boot:
1. 扫 agents/*/activation.lock,探活 pid(现链);
2. 活壳 → **建 socket-only 句柄入池**(不再只 markReachable + re-tap);
3. 句柄接管期间探测到的 run-state(在途 run/busy)投 onReconciled——
   in-flight run 的收束对账沿用 cr-748 面;
4. 首次探测失败(壳刚好在退出)→ 句柄立即终结,不重拉(idle 自杀
   语义不因接管而改变)。

### 4.3 通道归属

接管壳的控制帧全部走 socket(与 cr-805 借道同路);spawn 壳维持
stdin 管道优先、socket 兜底——两形态最终在「管道死亡」这一事件上
统一:管道断 = 句柄降级为 socket-only,而非监护终止。

## 5. 三个决策点(已带建议,实施前可复议)

**D1 判死双源策略** — 建议:任一源喂活即活。替代案「socket 单源」
被否:spawn 壳的 stdout ping 是 push、粒度更细,白扔可惜;且双源
让「管道损伤」与「壳假死」两类故障可区分。

**D2 host-revive 退役边界** — 建议:保留为 supervisor 缺席形态
(dev:fg / bundle 前台直跑)的最后兜底,但让路窗条件收紧:新宿主
接管成功(句柄入池)即免除让路——「system 在场」判据从「锁内 pid 活」
升级为「锁内 pid 活 ∧ 该宿主已建接管句柄」。完全退役另裁。

**D3 cr-675 黑名单/降级路径** — 建议:直接退役(本机无存量老壳,
2026-11-09 确认;黑名单 + 「老壳不认控制帧」诊断分支删除)。

## 6. 分批实施(每批独立可验、独立登记 CR)

| 批 | 内容 | 改动面 | 验证 |
|---|---|---|---|
| 批1 | 双源喂活:SuperviseHandle.noteProbe() + peek 接线 | supervise.ts / orchestrator.ts,~50 行 | 判死单测 + 单测/集成全量 |
| 批2 | socket-only 句柄 + boot 完整接管(§4.1/4.2) | supervise.ts / orchestrator.ts / boot.ts,~200 行 | 接管 e2e:杀宿主→活壳→新宿主判死/收割/重拉全链 |
| 批3 | 退役面:让路窗收紧(D2)+ 黑名单退役(D3)+ 降级注释清理 + 裁决簿/README 同步 | host-revive.ts / orchestrator.ts / docs | 回归:振荡/风暴用例 + 全量 |

## 7. 风险与边界

- **run-state 探测延迟**:poll 周期即心跳粒度(现状 poller 拍)——
  判死窗需 ≥ 2 拍,快于壳崩溃退避基档,不冲突;
- **idle 收割归属**:接管壳的 idle 判定以 run-state busy/inbox 探测
  为准(壳侧四条件探针仍在,双保险);
- **E1 残余**:接管后 reach 写点减少(adopted/peek 回登记合并为句柄
  面单写),E1 剩余量在批3 后重估;
- **Windows pipe 语义**:连接被拒 vs 不存在需区分(ENOENT=无监听,
  其它=传输错)——peek 现链已处理,复用。

## 8. 残余评估(2026-11-09,批3 后重估)——cr-969

### 8.1 E1(可达表写点/双真相源)——残余:小

接管前 ≥8 写点、双真相源(锁 pid 活 vs pipe 通)互写。现状生产写点清单
(每处唯一属主):

| 写点 | 属主 | 判定 |
|---|---|---|
| adoptShell adopted 登记 | spawn 链 | 单源正当 |
| adoptLiveShells 登记 | 接管链(cr-967,替代 rescue 散写) | 单源正当 |
| rescueReachableFromLock(ensureHook) | 消息路径前置探活 | **收敛候选 a** |
| peek 比对回登记(cr-748/885) | 对账幂等面 | 边缘窗口兜底,良性 |
| post-office local 登记/摘 | 进程内端点 | 域独立 |
| post-office 直投/转投失败摘(cr-885) | 投递事实 | 语义正当(投递面只记投递经验;摘后由 peek 2s 拍回登记收敛) |
| supervise 退出/idle 摘除 | 监护链 | 单源正当 |

双真相源互写面已拆:接管后 reach 与 lock 在宿主内同源(lock 派生句柄)——
cr-963 振荡族(boot 窗口多写点互写)的结构根因消除。

**收敛项 a(约 20 行,可另立小批)**:ensureHook 的 rescue 命中活锁时只回
登记不入池——与 adoptLiveShells 语义重叠;并源为「命中即建接管句柄」,
rescue 与 peek 的 shell-emerged 写点随之合并为接管面单点。

### 8.2 E2(状态层/退避时钟)——残余:中

状态层从五层收敛为三层主结构:**activation.lock(壳自写,盘上单源)↔
superviseShell 句柄(监护单源,spawn/socket-only 同链)↔ reach(消息路径
投影,可由前两者派生)**。

时钟清单(现状):

| 时钟 | 档位 | 判定 |
|---|---|---|
| supervise respawn 主退避 | 1.5s×2ⁿ cap60 + bootOk 30s | 唯一指数时钟,同链单源 ✓ |
| supervise adoptFailedUntil + orchestrator spawnCooldown(60s) + spawnRetries(3s 翻倍) | 拉起链三段 | **收敛候选 b**(形态重复,各管一段:窗内快速失败/终败冷却/慢启补拉——cr-805/962 防御深度换来的近似形态) |
| host-revive 退避 | 1.5s×2ⁿ cap60 | D2 收紧后仅 supervisor 缺席形态触发,保留正当;完全退役另裁 |
| 壳侧 idle 四条件探针 vs 宿主 warden idle+busy 探测 | 15min | 设计 §7 明示双保险,接受 |
| adopt watchdog 分级预算 | 45/15/15s | 拉起窗辖制,非生命周期时钟 |
| takeover 锁观察器 | 2s | 接管壳退出感知(cr-967 新增,填补「无退出事件」空缺) |

**收敛项 b(约 30 行,中优先)**:拉起链三段时钟并源——supervise 实例随
拉起失败丢弃致 adoptFailedUntil 蒸发(cr-962 已述),把退避门整体上提
编排面与 spawnCooldown 并一。收益:少一处近似形态;风险:动 cr-962 冷启
韧性链,须携回归用例。

### 8.3 结论

断根目标达成:监护不绑管道,换代即完整接管;rescue 降级语义与让路窗的
存在理由已按 D2/D3 收敛。E1 剩 a 一处并源(小);E2 剩 b 一处并源(中)。
两者皆「良性近似」非事故根因,另立小批实施,不与本方向混批。

## 9. 证据索引(承接原评审存档)

- 振荡现场:host-2026-11-09T08-31-01-173Z.log(单秒 600+ W);
- 冷启实测与误杀统计:11 天 44 次(判定法见 cr-962 注释);
- 相关 CR:547/551/612/642/647/675/681/805/885/961/962/963/964(964
  为本方向前身的评审存档,已并入本文档)。
