# 宿主-壳独立后读面搬迁审计与实施文档

> 性质：宿主-壳进程独立架构下全部 RPC 读接口的分类审计 + 三批改造实施文档（host-shell-decisions.md 同族的**实施**侧沉淀，后续修复以此为实施基准）。
> 来源：2026-10-31 会话分析（读面稳定性追问三轮收敛）；登记 cr-822。
> 评审回填（2026-10-31，cr-823）：E 类 stats 空集定性修正、批一形状兼容验收项、2-1 补 poller 注入桥、零壳侧改动口径、工时总账。
> 实施回填（2026-10-31，cr-824）：批一/批二已落地。实施期事实修正：C′ 类 interaction 落盘非全局单文件，而是 per-agent 域（agents/<id>/interactions.jsonl + children 嵌套域，A8 数据化）——1-3 读面为域文件聚合（interactionFiles 枚举）。批二落形态：poller 镜像经 FaceOpsDeps.pollerSnapshot 惰性端口注入（boot pollerRef 回填，shellPort 同模式），消费侧收敛 runningOf() 单源（镜像优先/现探退路）；collectRunning 保留为退路（独立 web 面形态）。
> 批三实施回填（2026-10-31，cr-825）：声明面定形为「生成器真装配 dump + 入库快照 + 对账锁」——ExtensionMeta.tools 行包自述方案否决（宿主 cordis 树不装壳行包，运行时读不到声明；宿主静态导入则 ac-host-webui 拖入全部工具行包依赖）。物理形态：scripts/gen-tool-catalog.mjs 以 row-catalog 寻址全点名 bootShell（临时数据根、零 spawn），dump listWithOwner() → apps/catalog/tool-catalog.json（68 工具，注册代码单源派生物零人工维护）；对账锁 apps/shell/tests/tool-catalog-parity.test.ts（真装配 vs 快照逐字段对拍——catalog↔装配漂移测试同构）。消费端：tools/list = 静态底座 ∪ 活壳增量（__standard__ 冷拉起链退役）；agents/tool-defs = 活壳真值优先、壳缺席 staticToolDefs（config.rows 盘读 × 快照 + ac-agents mode 收窄纯函数复用）。顺手修 row-catalog 两处 stale 词形（harness-tools 的 hello、datetime 行的 tools 字段——行已不注册该工具）。
> 批三续（cr-826，同日）：快照方案推广至事件目录（rpc-audit B1/B2/A3）——生成器扩展 dump _hooks 注册面（events 段，含 computeRowAggregates 聚合行名）+ 行包顶层 extension.listeners 声明（eventDescs 段，按 row path 动态 import）；events/listeners = 快照 ∪ 宿主树活态并集、events/descriptions = 静态声明目录、events/policy-list = EventPolicyService.disabledKeys + 两树 live 交叉。快照适用判据沉淀：truth 住壳行包静态注册代码且宿主树读不到——全仓仅工具/事件两目录命中，其余读面已按各自 truth 位置处置完毕，读面搬迁三批收口。
> 审计基线：commit 工作区现状（apps/host / apps/shell / packages/ac-host-webui 等逐文件实读，非纸面推断）。

## 一、背景与问题形状

壳模型统一（S2，shell-model-unification.md）后宿主与壳进程独立、壳 idle-exit 生灭。
审计动机：部分依赖壳的读取功能（上下文占用、subagent 清单等）不稳定。

不稳定不是实现缺陷，而是**读面隐含假设「truth 的持有者进程活着」**——单进程时代该假设免费成立，进程拆分后每个跨边界读面都被迫回答「truth 住在哪」。
已回答的读面成了稳定面（A 类），没回答的成了不稳定面（D/E 类）。
三次先例（tag-registry 退役、agents 活注册表解体、conv-settings 垫片）是**主动**拆解；本审计审出的问题是**被动遗留**的同类病。

根因矩阵（三条）：

| # | 根因 | 症状 |
|---|---|---|
| 1 | 进程内瞬态无「出壳」通道，宿主只能拉、不能推 | 观测路径可用性 = 被观测进程存活率 |
| 2 | idle-exit 让「壳不在场」成常态，读面把它当异常 | 交互面板蒸发 / 读操作带拉起副作用 |
| 3 | 观测态与事实态混在同一投影 | 整投影可用性被瞬态半边拖垮 |

## 二、读接口分类全景（审计结论）

判定式：**分类 = truth 住在哪**，与工程努力无关。

### A 类：纯盘读/宿主自有——壳不在场 100% 可靠（终态，无需动）

| 面 | 数据源 |
|---|---|
| session/history、subagents/history、session/delete-message、session/truncate | ledger / children 树盘直读（JSONL） |
| agents/list、agents/presets | agents-core config 直读 |
| usage/tokens | 宿主 usage 行（journal 计量） |
| timer/* | 宿主 timers 行 |
| skills/list | 数据根技能目录直读 |
| config/*、llm/providers、llm/models | config.json + 凭据 |
| conv-settings/* | 宿主 conv-settings 行（D12：写者单源归宿主，壳侧垫片只读） |
| workspace/*、fileSnapshots/*、system/*、plugin/catalog | 宿主自有 |

### B 类：盘读基底 + 活壳增强（可用，徽章降级）

| 面 | 盘读部分（可靠） | 活壳增强部分 |
|---|---|---|
| subagents/list | task/runs/createdAt（children 树） | busy/exited 徽章（叠加通道不一致，见五-3） |
| runs/snapshot | 会话目录扫描 digest | 活跃 run（collectRunning 现探，见五-2） |

### C 类：只查活壳（语义正确）——空集就是物理真相

| 面 | 壳不在场时 | 语义依据 |
|---|---|---|
| jobs/list、jobs/kill | 空面板 | 〈jobs 归属〉裁决：壳死 = 其 job 随之蒸发，生命周期归 activation |
| conversation/queue、queue-remove、queue-steer | 空队列/not-found | 队列在壳内存，壳死必空 |
| runs/interrupt | aborted 0 | 没有在跑的 run 就没有中断目标 |

### C′ 类：只查活壳但**通道错配**——数据在盘上，读面却按活壳枚举

| 面 | 问题 |
|---|---|
| interaction/list | durable-interaction 落盘 = 数据根全局单文件 interactions.jsonl（append-only + fsync，宿主直读零成本），读面却按活壳枚举——pending 提问在壳死/换代窗口不可见 |

### D 类：读操作带拉起副作用（ensureAgent）

| 面 | 壳不在场时 | 判定 |
|---|---|---|
| goal/get、todo/get | 拉起壳（200ms + 50-80MB）再答 | **假依赖**：数据在 agents/<id>/entries/{goal,todo}.json（agentStore，writeJsonAtomic 原子写）——盘上就有 |
| agents/tool-defs | 拉起 | 半假依赖：行集派生是纯函数（ac-rowset-core），静态部分可离线算；动态插件工具注册面才是真壳内态 |
| tools/list | 冷启动拉起 __standard__ 代表壳 | 同上 |
| subagents/stop、session/archive、conversation/interrupt | 拉起 | **合理**（D″）：动作面要执行体，拉起即语义 |

### E 类：现探未接既有机制

| 面 | 问题 |
|---|---|
| conversation/stats、runs/snapshot 活跃集 | collectRunning 每次 RPC 现探活壳——观测抖动根因。消费点两处已是**分化裁决而非疏漏**：runs/snapshot digest 侧观测失败沿用末值（face-ops.ts:770），stats 侧 web-api.ts:441 的 `?? []` 保守清空系 cr-802 显式取舍（判死面携带陈旧值的误判风险 > 清空闪烁，前端 20s 静默豁免窗兜底）。换 poller.snapshot()（宿主内存镜像、无观测失败态）后该两难自然消解，stats 裁决无需翻案 |

## 三、判定式与不可提升面

一个接口能否到 A 类，取决于 truth 的物理位置：

| truth 位置 | 可提性 | 手段 |
|---|---|---|
| 已在盘上（agentStore/ledger/children/jsonl） | 可提且该提 | 读面改盘直读（垫片模式） |
| 可静态派生（行集/工具 schema/目录） | 可提 | 元数据数据化 + 纯函数派生 |
| 壳内存真瞬态（busy/queue/meta） | **物理不可提** | 换语义：读宿主内存镜像（poller），非盘读 |

不可提升面（提升 = 倒退）：

- jobs/queue 空集——数据生命周期归 activation，空就是真相；宿主缓存死壳 job = 展示不存在的数据。
- archive/stop/interrupt 动作面——D″ 合理形态。
- run-state 硬做盘快照——peek/poller（cr-748）已建成，再建是影子状态。

## 四、终态图景

```
RPC 读路径 = 盘直读（批一）∪ 宿主内存镜像（批二）∪ 静态派生（批三）
           —— 三者都不阻塞、不拉起、不依赖壳应答：可用性 100%
观测新鲜度 = 静态面 0s；活跃态 ≤ 2s（poller 拍）；壳死后确定性清空（锁判定）
壳交互只剩：写动作（合理拉起）+ 动态增强（活壳在场才有的精度加分）
```

## 五、实施批次

### 批一：读面换数据源（假依赖根除，零新机制）

均沿用既有垫片模式（ConvSettingsShim 同构：物理单副本、写口在一侧、读面两侧直读）。

| # | 改造 | 要点 | 规模 |
|---|---|---|---|
| 1-1 | goal/get RPC | face-shell.ts 的 call(agentId, {op:goal-get}) 改为 agents-row 同款 entries/goal.json 盘直读（readEntry 语义：损坏/缺席 = undefined 零值兜底）；goal-update/delete **保持控制帧**（写面留壳，agentStore 写口是壳内 ctx） | 半天 |
| 1-2 | todo/get RPC | 同 1-1（entries/todo.json） | 半天 |
| 1-3 | interaction/list RPC | 改 interactions.jsonl 直读（owning 实现 = JsonlDurableInteractionStore 读面；pending 过滤沿用现 filter 语义）；interaction/reply 留控制帧 | 1 天 |
| 1-4 | subagents/list 叠加通道 | port.handles() → liveShells()（与 jobs/interaction 对齐，宿主换代免疫） | 1 小时 |

批一验收项（验证阶梯之外）：goal/todo/interaction 三个读面 RPC **响应形状逐字段不变**——前端 ac-client-ui-goal/todo 直接消费，形状漂移即断。盘直读拿到的是单 entry 全桶原始形态（readEntry 语义），须复刻壳内按 conversationId 的桶投影；投影逻辑复用 owning 包实现（ac-goal/ac-todo 未导出纯函数则补导出），禁止 webui 侧重写第二份——双源漂移病批三已识别，批一不得提前引入。

### 批二：消费既有机制（光环根除）

| # | 改造 | 要点 | 规模 |
|---|---|---|---|
| 2-1 | collectRunning/stats 接 poller | 读改 poller.snapshot()（宿主内存镜像，永阻塞不了、无观测失败态——`?? []` 两难随失败态一起消解，stats 保守清空裁决无需翻案）。接线含宿主侧桥：poller 住 apps/host、消费方住 packages/ac-host-webui（包不可依赖 app），须经 deps 注入面扩展（现仅 port 通道；boot.ts:335 poller 创建后未注入消费面）。poller 已在宿主 boot 接线 | 1 天 |

### 批三：静态化派生（需一个声明面设计决策）

| # | 改造 | 要点 | 规模 |
|---|---|---|---|
| 3-1 | ExtensionMeta.tools 声明面 | 行包自述工具（name/description/schema/固定开销）——与 rpc-audit B1/B2「事件/扩展目录数据化」同族、共用同一声明面机制 | 2-3 天（含 25 行包补数据） |
| 3-2 | tools/list、agents/tool-defs 消费端 | 静态离线算（rowset 派生闭包 + ExtensionMeta.tools）+ 活壳在场时真值覆盖；冷启动不拉 __standard__ | 与 3-1 共享 |

批三风险：双源漂移（自述 vs 真实注册面）——必须加静态测试锁（与 catalog↔装配漂移测试同构）。

### 验证阶梯（每批跑）

pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 lint；批二动 web-api 消费链，批三动声明面（契约族）→ 全量 pnpm test；批一涉及宿主-壳边界（AClass 行为契约）→ 建议跑 pnpm test:integration 定向。

工时总账：批一 2.25 天（0.5+0.5+1+0.25）+ 批二 1 天 + 批三 2-3 天 ≈ **5-6 人日**（各批含验证阶梯；批三另含声明面设计决策门槛，非纯工时）。

## 六、依赖与裁决对齐

- 本方案全部为读面接线，零新机制、零跨进程请求-应答通道（不违 D10——这是审计的证伪哨兵，未触发）。
- 垫片模式承 R-11③/conv-settings 先例；poller 消费承 cr-748 已建成机制；工具目录静态化承 tag-catalog 静态化同族思路。
- 涉及面：face-shell.ts、face-ops.ts、web-api.ts（宿主 web 面）；ExtensionMeta（ac-extension-core 契约，批三）。改动口径：批一/批二零壳侧改动；批三零壳侧**逻辑**改动——含约 25 个行包 ExtensionMeta.tools 数据面补全（契约 + 数据，非逻辑）。

## 七、裁决簿回填建议

本审计的三条结构性根因（§一）与「不可提升面」（§三）建议在 host-shell-decisions.md 增补一篇〈读面搬迁〉短裁（含 D10 证伪哨兵未触发的记录），时机 = 批一落地时随批登记。

## 八、教训（原裁决代价清单补记）

原拆分裁决的代价清单记了内存地板、idle-exit 谹参、children 探查开销,但漏记一类：**进程拆分对每个跨边界 RPC 读面产生一次性搬迁债**。拆分时不响（旧读面照常工作——壳多半活着），idle-exit 让「壳不在场」成常态、宿主换代让「句柄池失忆」成现实后才开始计息。这类延迟显现的成本最易漏记：验收测试跑的那一刻，壳往往恰好活着。

## 附：审计方法

- 逐读面实读实现：face-shell.ts / face-ops.ts / web-api.ts（宿主 RPC 注册面全量）、admin-frame.ts（壳侧帧面全量）、orchestrator.ts（control 三级链/peek）、shell-state-poller.ts、ac-shell-subagent/service.ts、ac-shell-conversation/service.ts（runState）、ac-durable-interaction（存储形态）、ac-goal/ac-todo（agentStore 持久化）。
- 三轮收敛轨迹（盘快照 → 收缩 run 观测域 → 收缩到零）留档于此：早期方案过度设计的主因 = 未发现 cr-748 peek/poller 已建成。
