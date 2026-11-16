# 壳协议离 stdio 迁移（方案 E）——实施计划

> 性质：实施计划（-plan）——监护信令（boot 节拍 / 心跳 / run 节拍 / 控制回执）全量迁出 stdout/stdin，stdout/stderr 回归普通进程通道；protocol-spec-envelope-lock-guardian.md D 节的演进承接档。
> 状态：已完成归档 · cr-1123 2026-11-16 立稿 → cr-1125/1126/1127/1128/1129/1130 五批全量落地（V1-V8 达成；V2 双写期断言随批 4 信号退役自然失效，其守护意图由批 4 后的文件面断言承接）。协议规格 D 节改稿在批 5 完成，取代关系已登记（protocol-spec-envelope-lock-guardian.md 头部状态行）。
> 读者：动 boot 链 / 监护链（orchestrate / supervise / takeover / guardian / subagent）的人；实施前通读全文，动工批内回读「分批切分」对应行。

## 一、背景与根因

cr-1122 验证过程暴露：壳内 ctx.logger 输出经 ConsoleExporter → console.log → stdout，而壳 stdout 被 TSV 节拍协议独占——宿主行循环按协议语法解析，未知行静默丢弃。全链排查（cr-1123 调研）确认五环：写端 emitBootSignal（apps/shell/boot.ts L50-52）→ 读端 warden 只认五类前缀（packages/ac-guardian/src/guardian.ts L79-109）→ 其余 fall-through 丢弃 → 三个 sink（控制台 / .runtime/logs/shell-<agent>.log / stderrTail）全零。

这不是单点笔误，是结构性缺陷：**「stdout 属谁」的契约从未显式化**。后续排查还发现另外三类写者同陷：run_code 用户代码（worker 线程共享进程 stdout）、第三方插件 console.log、未来任何行内直接输出。修补方向（logger 行改道 stderr / magic 前缀多路复用 / fd3 专线）都在「专属化」框架内打转——本计划取方案 E：**让协议彻底离开 stdio，专属化不复存在，通道冲突类别本身消亡**。

可行性不是空想，四个部件全部有生产先例：

| 先例 | 出处 | 证明的事 |
|---|---|---|
| 换代接管壳无 stdio 生存 | apps/host/takeover.ts（cr-967） | 锁观察器 + 合成 boot.ready + noteProbe 双源，监护链全量复用 |
| probeIpc 连接探针 | packages/ac-envelope-core/src/ipc.ts L41-58（cr-1115） | 「socket 在即活」的判定已有纯库实现 |
| run-state 探测双源之二 | apps/host/orchestrator.ts peek 面（cr-748） | pull 喂活已在生产，stdout ping 只是第二源 |
| B3 流式旁带走 socket | apps/shell/boot.ts emitStreamFrame（uplinks） | 最大流量的壳→宿主通道早已不经 stdout |

## 二、终态规格

### 2.1 信号面迁移总表

| 信号（现 stdout TSV） | 迁移去向 | 形态 |
|---|---|---|
| boot.lock.acquired | activation.lock 文件（既有，不再发信号） | 锁 O_EXCL 落盘即节拍 1——宿主读锁 readActivationLock |
| boot.rows.ready | agents/<id>/boot-progress.json | 行集装配完成时原子写（temp + rename） |
| boot.ready | ipc listen 成功（listenIpc 回调） | 宿主不再消费行——probeIpc 实连成功 = adopt 判据（transportHint 已在锁内） |
| guardian.ping（30s） | 退役 | 喂活改双源：锁文件 mtime 心跳（壳 30s touch 锁）+ 宿主既有 peek 探测；warden noteProbe 面已存在 |
| run.started / run.settled | peek 数据源（既有 run-state）+ runbeat 落盘改壳侧直写 | 宿主 poller 已消费 run-state 快照（cr-748）；运维日志 runbeat-<agent>.log 由壳直接追加（复用 appendRollingLine 形态） |
| ctrl.done / ctrl.error | manage 通道 request/response（既有） | stdin 控制帧与 stdout 回执对整体退役；control() 已双面服务（cr-675），拉起方改走 handle.control(frame) |
| plugin.load-failed | boot-progress.json 内结构化字段 | 装载失败清单随进度文件持久化——宿主读进度即得，不再需要行事件 |
| fingerprint.root | boot-progress.json 字段 | 宿主 adopt 后读取，verify 语义不变（R-7 对拍） |

### 2.2 拉起时序（终态）

```
spawn → 锁出现（O_EXCL）          节拍 1：宿主轮询/目录观察 readActivationLock
      → boot-progress.json 出现    节拍 2：rows 数 / fingerprint / 装载失败清单
      → ipc listen（probeIpc 通）  节拍 3：adopt——可达表登记（transportHint 取自锁）
常驻：锁 mtime 心跳（30s touch）+ 宿主 peek 轮询——双源喂活 warden
退出：锁消失=正常退出(0)；锁在 pid 死=崩溃(respawn)；锁换代=本代监护终结
      （= takeover.ts 锁观察器既有语义，全量复用）
```

### 2.3 控制面（stdin 退役）

shutdown 与控制帧改走 manage 通道（system/shutdown 帧已存在，cr-675）：

| 现入口 | 终态入口 | 依据 |
|---|---|---|
| stdin shutdown 行 | manage system/shutdown 帧 | takeover.kill 已走此面（takeover.ts L132-151） |
| stdin JSON 控制帧 + stdout ctrl 回执 | handle.control(frame) | AdoptedShellFace.control 已是统一面（orchestrate.ts L408-417） |

--persist（子壳 stdin EOF 不自杀）语义随 stdin 退役自然消亡——owner 失活判定改锁观察（owner 壳死 → 子壳锁照持 → 由各自宿主/监护面处置，R-5 收割显式化不受影响）。

### 2.4 心跳判死（guardian.ping 退役）

- 壳侧：30s fs.utimesSync(lockFile)（touch mtime）——文件心跳，零协议；
- 宿主侧：warden tick 窗口内任一源新鲜即喂活——①锁 mtime（读锁时 stat）②peek run-state 探测成功（既有 noteProbe）③run-state busy 视为活跃（既有）；
- 双源齐断跨窗才判死——与 D1 双源语义同构，只是把 push 源换成文件源；判死后的 respawn 链不变。

### 2.5 stdout / stderr 终态

| 通道 | 终态 | 说明 |
|---|---|---|
| stdout | 自由通道 | 协议零依赖；process.stdout error 事件 EPIPE 兜底保留（无害） |
| stderr | 诊断线（既有 cr-662 面不变） | logger 行去向（留 stdout 或落 stderr）在 stdout 不再专属后降级为纯美学，不在本计划范围 |
| stdin | 退役（不读） | spawn stdio 收敛由批 5 处理；boot 参数错误路径（boot.ts L1327）仍写 stderr，不受影响 |

## 三、分批切分

每批独立可验证、可合入；批内改动面走验证阶梯（见 §五）。批号即实施序。

| 批 | 内容 | 改动面 | 依赖 |
|---|---|---|---|
| 1 | 宿主探测面就位：orchestrate adopt 链加 boot-progress.json 读取 + probeIpc 判据（与行流判据并存，新判据受门控开关 SHELL_PROTO_OFF_STDIO 控制）；warden 增加来自探测面的等价喂入 | apps/host/orchestrate.ts、apps/host/supervise.ts、packages/ac-guardian | 无 | ☞ 落地收窄（cr-1125）：探测面经合成 TSV 行复用 handleLine → warden.feedLine 既有面，supervise / ac-guardian 零改动（noteProbe 面已在）；boot-progress 读写纯库随本批落 ac-envelope-core（宿主读侧需要，批 2 壳接写侧） ☑ cr-1125 2026-11-16 |
| 2 | 壳侧双写期：boot.ts 节拍写点改「写 progress 文件 + 照发 TSV」（过渡双写）；锁 touch 心跳上线；plugin.load-failed 与 fingerprint 入 progress 文件；新增 boot-progress 读写纯库 | apps/shell/boot.ts、packages/ac-envelope-core、packages/ac-shell-subagent/src/service.ts | 批 1 | ☑ cr-1126 2026-11-16（收窄：service.ts 零改动——子壳共用 boot.ts 双写自动覆盖；补 RESERVED_UNIT_NAMES 保留 boot-progress，防 settings 单元合成污染主体指纹） |
| 3 | runbeat 壳侧直写：run 节拍事件落 runbeat-<agent>.log 改由壳侧追加（复用 appendRollingLine 语义），宿主侧 runbeat sink 退役 | apps/shell/boot.ts、apps/host/orchestrator.ts | 批 1（可与批 2 并行） | ☑ cr-1127 2026-11-16（appendRollingLine 上移 ac-envelope-core 双端单源） |
| 3b | 控制面切换：拉起方 ctrl 帧全量走 manage 通道 handle.control；stdin/stdout 帧对停止新增消费；bench-gate / admin-preview 等宿主内控制消费面同步 | apps/host/orchestrate.ts、apps/host/bench-gate.ts、apps/host/admin-preview.ts、packages/ac-shell-subagent/src/service.ts（cr-1125 调研补：子壳 control() 扫 stdout ctrl.done 回执 + shutdown 写 stdin 行——V5 grep emitBootSignal 兜不住此独立消费面；transportHint 经 readActivationLock 可得） | 批 1 | ☑ cr-1128 2026-11-16（收窄：bench-gate/admin-preview 零改动——orchestrator 控制面本就 manage；manageRoundTrip 上移 envelope-core 单源） |
| 4 | 信号退役：emitBootSignal 写点全量删除（boot 三节拍 / ping / run 节拍 emit / ctrl 回执 / plugin.load-failed / revive emit 面）；watchdog 判据改「锁出现 / progress 出现 / probeIpc 通」三事件；e2e 断言全面改写（apps/host/tests/e2e-*.test.ts 等三节拍行）；门控开关退役 | apps/shell/boot.ts、apps/host/orchestrate.ts、apps/host/tests/* | 批 2+3+3b | ☑ cr-1129 2026-11-16（收窄：warden adopt 收口改 supervise 由 events 直接合成——takeover 合成行随之退役，V5b 断言面更新；supervise 增锁 mtime 心跳喂入〔新鲜窗含下界——负龄免疫〕；装载失败回报改读 progress；ac-shell-subagent waitReady 切 waitForShellReady 新纯库） |
| 5 | 协议规格 D 节改稿 + spawn 形态收尾：protocol-spec D1/D2 重写（信号表 / 时序 / 判死双源）；spawn stdio 收敛（stdin → ignore，stdout/stderr 保持 pipe 供诊断）；README 架构段同步 | docs/design/platform/*、apps/host/orchestrate.ts、根 README.md | 批 4 |

### 批间过渡纪律（关键）

- 门控开关全程双态可切：SHELL_PROTO_OFF_STDIO env（宿主读入透传拉起）——on 走新判据，off 走旧行流判据。批 4 退役前恒可回退，出问题秒级回滚。
- 双写期不删旧路：批 2 起壳双写（文件 + TSV），宿主批 1 已能读文件——新旧消费面同时为真，CI 双跑。
- 旧进程兼容（换代接管）：新宿主遇旧壳（progress 文件缺席 + TSV 行在）→ takeover 链天然兼容（旧壳也写锁、也 listen ipc）。批 5 收尾时确认 takeover 对无 progress 文件旧壳的读锁路径不变。
- 开关不是永久机制：批 4 完成即退役（删 env 读取与旧行流分支）——双态可切只为迁移窗口服务，终态无开关（feature flag 反模式防线）。

## 四、与代码的映射点

| 映射点 | 文件 | 动作 |
|---|---|---|
| 协议写点 | apps/shell/boot.ts L50-52 emitBootSignal；L1413-1415 ping；L1240-1250 run 节拍 emit；L1436-1437 ctrl 回执；L688/702 plugin.load-failed；L1400 revive emit 注入 | 批 2 双写 → 批 4 删除 |
| 行消费 | apps/host/orchestrate.ts L360-421 行循环 + warden.feedLine | 批 1 并存喂入 → 批 4 拆除 |
| 判活双源 | apps/host/takeover.ts 锁观察器 + noteProbe；apps/host/supervise.ts L344 | 平移复用（源 ① 加锁 mtime） |
| 控制面 | apps/shell/boot.ts control()（cr-675 双面）；stdin 帧循环 L1422-1439 | 批 3b 切 manage，stdin 循环批 4 删 |
| 子壳拉起 | packages/ac-shell-subagent/src/service.ts L1179-1196（pipe+inherit，等 boot.ready 行）；L1217-1240（control() 扫 ctrl.done 回执 / shutdown 写 stdin 行——cr-1125 调研补） | 批 2 同步双写，批 3b 切控制面，批 4 改 probeIpc 判据 |
| 进度文件读写 | packages/ac-envelope-core 新增 src/boot-progress.ts（读写双端共用纯库） | 批 2 落地 |
| ipc 探针 | packages/ac-envelope-core/src/ipc.ts probeIpc（cr-1115） | 纯复用 |
| 运维日志 | runbeat：apps/host/orchestrator.ts L137-140 sink → 壳侧直写；shell log：cr-662 面不动 | 批 3 迁移 |

## 五、测试标准与验证目标

### 测试标准（过程门，按批改动面走验证阶梯）

| 批 | 必跑 |
|---|---|
| 1-3b | pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 lint；动了守护纯域（ac-guardian）跑定向 npx vitest run packages/ac-guardian |
| 4 | 上行全量 + pnpm test 全量（装配链 e2e 在列）+ pnpm test:integration（子进程链路）；dev 数据根运行时验证（restart_shell 后壳行为不变） |
| 5 | 全量 + 文档引用检查（node scripts/cr.mjs check 路径锁） |

### 验证目标（目的态断言，批 k 做完世界应有的样子）

| # | 断言 | 批 |
|---|---|---|
| V1 | 门控 on：拉起壳（零 TSV 行形态）→ 三节拍经锁/progress/probe 判定 → adopted 达可达表 → 消息直投成功 | 1+2 |
| V2 | 双写期：新旧两消费面同数据（progress 文件内容与行流语义等价） | 2 |
| V3 | runbeat-<agent>.log 由壳侧产出，宿主不再写该文件 | 3 |
| V4 | 拉起方 control() 经 manage 通道往返成功（stdin 帧路径无人用） | 3b |
| V5 | emitBootSignal 调用点全仓为零（grep 断言）；grep boot.ready 于 apps/host 仅剩 takeover 合成行 | 4 |
| V6 | 壳内 ctx.logger 输出到达 shell-<agent>.log 或操作台（cr-1122 黑洞闭合——批 4 后宿主不再解析 stdout，日志行落既有诊断面） | 4 |
| V7 | 协议规格 D 节与实现一致（信号表无 stdout 列） | 5 |
| V8 | takeover 链对无 progress 文件旧壳仍工作（升级窗口兼容） | 4 |

## 六、风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| 锁 mtime touch 在 Windows 的开销/精度 | 低 | 数据根恒 NTFS/现代 fs；touch 失败退化为仅 peek 源仍可判活（双源本就冗余） |
| poller 周期空窗：peek 周期间壳死，判死延迟 ≤ 周期+窗 | 已有 | 现状 stdout ping 同样 30s 粒度，无回归 |
| boot 早窗（spawn→锁）宿主轮询空转 | 低 | 节拍预算沿用 cr-962 分级（45s/15s/15s）；轮询 250ms 起步，锁出现即转事件驱动 |
| 子壳拉起面漏改（subagent service 等行流消费） | 中 | V5 grep 断言兜底；subagent 面批 2 双写、批 4 切判据 |
| 双写期 TSV 行与 progress 文件不一致（写序竞态） | 低 | progress 原子写（temp+rename）；不一致以文件为准（批 1 判据以文件为真源） |
| run_code worker console.log 在双写期仍污染行流 | 中 | 双写期不新增消费者，污染无效果差异；批 4 后无协议消费者，天然无害 |
| 开关长期滞留（feature flag 反模式） | 中 | 批 4 退役点已写入计划；cr-1123 收口检查 |
| 非 persist 壳 stdin EOF 防孤儿自杀退役后的空窗（cr-1125 调研补：宿主永久死且无 supervisor 时孤儿壳 idle 探针被 busy 阻止——窗口可达整个 run 时长） | 低 | 显式接受：run 收束后 idle-exit 15min 收割兜底；host-revive 覆盖宿主可复活场景 |
| ac-host-rows mock spawn（timers-row.test.ts 产 boot.ready TSV 假行）批 4 后需同步改形态（cr-1125 调研补） | 低 | 批 4 改动面一并列入；mock 改产 progress 文件或真开 socket |

## 七、范围外（明确不做）

- logger 行通道配置（ConsoleExporter.stream）——独立 CR；批 4 后 logger 输出自然可见，该 CR 降级为可选优化。
- 宿主侧 stdout 语义（supervisor tee 面不动）。
- run_code worker console.log 重定向——独立小改（批 4 后从必需降为体验优化）。
- mobile/desktop 壳外进程（webui 独立部署面不在 stdio 协议域）。

## 八、开放裁决（动工批 1 前钉）

| 议题 | 备选 | 倾向 |
|---|---|---|
| progress 文件形态 | 单文件覆写 vs 事件追加 | 单文件覆写（temp+rename 原子；宿主读无流语义负担） |
| 锁心跳粒度 | 与现 ping 同 30s vs 加密 | 30s 同值平移（判死窗不变） |
| probeIpc 判活并入 warden 的路径 | noteProbe 复用 vs 新事件 | 复用 noteProbe（takeover 先例——面已存在，零新词表） |
| progress 文件代际防误读（上代残留） | 壳退出清理 vs 宿主校验 | ☞ 已钉（cr-1125 批 1）：bootId 必填 + 宿主只采信与锁同 bootId 的进度（锁同款 pid 代际校验）——无清理方，零竞态 |

## 本档案纪律

- 本档为实施计划（-plan）：批次全部完成且 V1-V8 全达 → 归档 archive/platform/；协议规格 D 节改稿在批 5，本档与规格的取代关系届时登记。
- 实施期间本档是唯一进度事实源：每批完成在 §三 分批表行尾加「☑ cr-<号> <日期>」注记；状态行同步。