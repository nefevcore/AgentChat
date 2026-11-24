# 会话渲染管线结构优化实施计划（session-render-pipeline-plan）

> 性质：实施计划——前端会话渲染管线的结构性优化总计划：身份键贯通后的消费面收敛（签名系统退役 / 对齐机制单源 / 投影分组 / 帧调度归一）+ v1 存量全量迁移。
> 状态：现行 · cr-1265 2026-11-23 立档（审计基线 cr-1260；分析草稿已吸收：三轮管线分析 + `sandbox/v1-migration-analysis.md`）· 群链 R2 缺口按裁决搁置（§八）。
> 读者：实施本计划的开发者（含 Agent 会话）——按阶段顺序读对应节；每批动手前先登记该批 CR，收官只认验证目标。

## 一、背景与根因

### 1.1 现状管线（五段）

```
WS 帧 ──① ingest──▶ rawMessages（分区唯一真相源，append-only）
        ──② derive──▶ Turn[]（getTurns computed ← per-dialog 版本号；buildTurnsIncremental 签名复用）
        ──③ display──▶ DisplayItem[]（useTurnDisplayItems：稳定 key / 分隔符 / midRun）
        ──④ mount ──▶ TranscriptList（首载窗口 24 + 上翻分帧补挂）→ TurnDisplayItem → Message/*
        ──⑤ paint ──▶ useChunkedMarkdown（前缀提交 + 尾部纯文本）+ useChatShell（rAF 跟随/缓动）
```

历史路径共用 ② 以下：`session/history` → `foldViewRecords`（ViewRow 时间全序 + anchor）→ `toHistoryMessages` → `mergeHistoryPage` → 同一 `rawMessages`。

### 1.2 根因（三轮分析汇聚）

**V3 投影已把权威身份键铺满（message_id / runId / stepId / injectionId / anchor / seq），但消费侧仍在用内容猜测补身份课。**

性能全靠「对象身份不变 → Vue props 短路」，而身份复用的正确性依赖手工失效契约：

| # | 层 | 复用机制 | 失效判定 | 已翻车（源码注释实录） |
|---|---|---|---|---|
| 1 | 消息 | `msgSig`（各字段**长度**） | 手工枚举 | 漏 toolCalls result → 工具卡永转圈；漏 textBeforeTools → 步序错 |
| 2 | 轮 | `turnContentSig` 前缀比对 | 第二份枚举 | 漏 injects → 注入卡丢失（cr-61） |
| 3 | 结构 | `invalidateTurns` 显式失效 | 散在 5+ mutator | 漏调一处 → 过期 turns |
| 4 | key | `turn-<agent>-<ts>` | 启发式 | 同刻碰撞；收束物化整轮重挂（设计内跳变） |
| 5 | 合并对齐 | 同锚吸收 → 键控 → coveredAnchors → 内容互验 + 配额抵扣 | 四代层积 | 每修一 bug 加一层，互相重叠 |
| 6 | 挂靠 | anchor + 窗口有效性 + 位置启发 | 边界态 | 窗口切锚 → 瞬时降级卡（cr-1132 接受） |

表现 = 偶发 stale（转圈 / 吞文 / 折叠弹回）且被「run/settled 重拉权威行」兜底掩盖——刷新前可见、刷新后消失。五个独立节拍（feed 写 / markdown rAF / idle-commit 定时器 / 滚动 rAF / refill setTimeout）交错，闪烁节律不齐。

### 1.3 审计基线（cr-1260，数据根 `workspace/home`）

| 事实 | 数据 | 对计划的影响 |
|---|---|---|
| 会话 1414：v2 头 212 / 过渡态 41（v1 头混 v2 行）/ 纯 v1 1161（92% mtime 止于 2026-10） | v1 基底 85% 在场 | P2 多数退役项被 v1 挡住 → 新增 P2-M 迁移批 |
| v2 行：message_id / seq 100%；stepId（除 tool-call-result）100% | 键贯通完好 | **P3 前提确认** |
| inject 731 行中 227（31%）无 injectionId | cr-707 前行 | 迁移边内补齐（§四 M-A） |
| group/history RPC 只投 id/from/content/at | steps/reasoning 服务端丢弃 | 群链 R2 缺口，裁决搁置（§八） |
| 性能探针（cr-258 `sandbox/wv-*.mjs`）已不在位 | 基线失传 | P0 补采 |

## 二、终态

| 维度 | 现状 | 终态 |
|---|---|---|
| 失效正确性 | 手工签名枚举 | 键原生（turnId 键 diff）——构造性正确 |
| 合并对齐 | 四重机制层积 | 键控单机制 + 一条显式兜底（探针挂靠，归零即删） |
| 轮分组 | 前端窗口局部启发（六段判据） | 投影层 TurnNode 分组（全会话视野）→ 前端按键装配 |
| 帧节拍 | 五个独立调度 | 单 rAF 流水线（ingest → derive → markdown → scroll） |
| 视角转换 | 三份平行转换器 | 一份 ViewRow 消费器 |
| v1 存量 | 读兼容层常驻 | 全量迁 v2，读兼容退役（仅迁移边引用） |

依赖图：

```
P0 基线 ──┬──▶ P2 退役清扫 ◀── P2-M v1 迁移（解锁条件退役项）
          │           ▲
P1 加固 ──┴───────────┴──▶ P3 键控收敛（核心刀）──▶ P4 投影分组 + 帧调度
```

## 三、护栏（不做清单）

- 不引入虚拟滚动库 / 通用 diff 引擎（换语义、比签名系统更重）——虚拟滚动条件项 P4-3 经实测判读后**不做**（cr-1298 用户裁决：瓶颈在补挂渲染成本非 DOM 体量，单向窗口化已覆盖）。
- 不动落盘 schema 语义（全部读侧投影；迁移批只做形态归一，不改行含义）。
- 不建全局 seq 逻辑时钟（同刻边界由语义位裁决覆盖，cr-1132）。
- 不做双端分叉组件实现（媒体查询 / 运行时探测的渐进降级唯一路径）。
- 不加 boot 惰性迁移边（归一化层对运行时已透明；离线批工具 + 幂等重入即可——cr-1036「入口恰两处」）。
- `isInjectEvent` 兜底链**不退役**：服务「owning 行未装载」降级（插槽-插头架构特性），仅存量词部分随迁移缩。

## 四、分批切分

### 批次状态板（cr-1266——多会话接力进度事实源）

接力会话开工三件事：`load_skill agentchat-dev` + `load_skill cr` → 读本档对应批 → 更新本表。每批开工标 ◐ + 登记该批 CR，收口标 ☑ + 回填 CR 号。

| 批 | 状态 | CR | 落笔 | 备注 |
|---|---|---|---|---|
| P0-A 数据根审计 | ☑ | cr-1260 | 2026-11-23 | 正本 cr/logs/cr-1260.md |
| P0-B 性能探针重沉淀 | ☑ | cr-1296 | 2026-11-24 | 真机 K20（MIUI 浏览器 Chrome 135 容器）+ CDP 采集；四组数字成文 §九（空闲/滚动/流式全 60fps 档、零长任务）；探针收编 scripts/perf-probe/（cdp.mjs + probe.mjs）；副产物两修：frameStats 生产读面 + frameScheduler 共享面分裂（真 bug）；详情 cr/logs/cr-1296.md |
| P1-1 签名单源化 | ☑ | cr-1267 | 2026-11-23 | 覆盖锁 = MSG_RENDER_SHAPE 词表（36 字段）+ AssertNever 编译断言；详情 cr/logs/cr-1267.md |
| P1-2 签名滚动哈希 | ☑ | cr-1268 | 2026-11-23 | strSig len:djb2 值缓存（WeakMap）+ 前缀增量；详情 cr/logs/cr-1268.md |
| P1-3 稳定 key 消歧 | ☑ | cr-1269 | 2026-11-23 | pass 内 (agent,ts) 计数序数；已随 P4-1（cr-1286）降位为键缺席域兜底（turnId 在场时键生即稳） |
| P1-4 mergeHistory 排序收口 | ☑ | cr-1269 | 2026-11-23 | 交叉用例绿；详情 cr/logs/cr-1269.md |
| M-A 迁移边纯函数+注册 | ☑ | cr-1270 | 2026-11-23 | 边住 ac-ledger-core session-chain（facts 往返恒等）；详情 cr/logs/cr-1270.md |
| M-B migrate-sessions-v2 工具 | ☑ | cr-1271 | 2026-11-23 | 真实根 --dry：1518 全覆盖错误 0（可迁 1284/v2 228/残留 5/空 1）；详情 cr/logs/cr-1271.md |
| M-C 真实数据根执行 | ☑ | cr-1272 | 2026-11-23 | 1517 全 v2 归零；fold 对拍 1274 恒等 + 10 例定性零回归；备份 sandbox/ledger-backup-2026-11-23T22-29-24 |
| P2-A 死代码直删（3 处） | ☑ | cr-1275 | 2026-11-23 | onToolEnd 位置回退 / mergeResume 镜像剔除 / legacyRc 零命中直删 |
| P2-B v1 依赖项删（7 处） | ☑ | cr-1273/1274 | 2026-11-23 | 删 name 兼容 + 判重门控（1273）；摘要载体全量升 V3 + summaryTextOf/foldSummaryOf/概要窗退役（1274，用户裁决路径）；aggOrder/restarted/quota 实测仍服役留观 |
| P2-C 兜底探针化 | ☑ | cr-1276 | 2026-11-23 | 三链挂计数（inject-heuristic/event-quota/content-prefix）；观察窗归零即删 |
| P3-1 对齐机制收敛 | ☑ | cr-1281 | 2026-11-24 | 键控单机制 + coveredAnchors 探针化显式兜底（anchor-cover，归零即删）；影子 oracle fail-loud + 真实数据根扫描残差 0；详情 cr/logs/cr-1281.md |
| P3-2 keyed store | ☑ | cr-1282 | 2026-11-24 | 不可变化身（freeze+reviseMsg，A 案）+ deriveTurns 引用 diff；签名系统零残留（grep 证）；详情 cr/logs/cr-1282.md |
| P3-3 转换器并轨 | ☑ | cr-1283 | 2026-11-24 | 单源 historyRowToChatMessage + HistoryRow 词表；三视角恒同 ChatMessage、键族全量透传（pair 只读视角键控打通、group id 稳定化、第四份本地 toChat 退役）；群链仅转换并轨；详情 cr/logs/cr-1283.md |
| P3-4 直播挂靠并轨 | ☑ | cr-1285 | 2026-11-24 | context-injected 帧 + 投影 event 行补 run 键，挂靠降级链 run>anchor>位置启发（inject-run-miss 探针）；双拍同形测试锁三路径恒同；详情 cr/logs/cr-1285.md |
| P4-1 投影分组 | ☑ | cr-1286 | 2026-11-24 | ViewRow.turnId 增量词 + buildTurns 键控拆轮（同值恒并/异值恒拆，MERGE_GAP_MS 降位存量兜底）；turn-gap-fallback 探针；真实数据根三路径轮边界 0 不一致；详情 cr/logs/cr-1286.md |
| P4-2 统一帧调度器 | ☑ | cr-1287 | 2026-11-24 | 单 rAF 四阶段流水线（ingest→derive→commit→scroll）+ 调度器级静默判据 + 提交探针（每帧恰一次）；P0-B 口径复测维持搁置（用户裁决——真机场景暂缺，§九 数字待补）；详情 cr/logs/cr-1287.md |
| P4-1c 观察窗启动 | ☑ | cr-1289 | 2026-11-24 | 探针读面接线（window.__AC_FALLBACK_PROBES__）+ 直播步行 runId/turnId 落位（解锁 turn-gap-fallback 归零路径；附带修纯直播窗口 run 键挂靠不命中缺口）；剩余缺席面 = 无键域行/旧后端帧/旧投影行；详情 cr/logs/cr-1289.md |
| P3-1c anchor-cover 删除 | ☑ | cr-1294 | 2026-11-24 | coveredAnchors 同锚覆盖兜底 + shadowAssertNoKeyGuess 影子一并退役（既定第三步；双静态扫描零命中——275+1440 会话生产形态 0 候选）；键控单机制终态收敛——缺键行统一「保留 + 收束重拉」；详情 cr/logs/cr-1294.md |
| 质量评估 + 补缺 | ☑ | cr-1295 | 2026-11-24 | 14 个已收口批逐批实证核验（声明属实：测试抽样 32 例绿 / v1 头全根复扫 0 / 键贯通三层在位 / 调度器四接线在位）；补缺三处：render-contract ViewRow turnId 契约勾销 + feed-core P3-1 注释块收敛 + merge-final-anchor 头注释校准；详情 cr/logs/cr-1295.md |
| 质量评估 + 补缺（第二轮） | ☑ | cr-1297 | 2026-11-24 | cr-1296 后增量核验（cr-1295 结论复认：退役零残留 / 共享面冻结清单同步 / v1 头全根复扫 0——1698 文件 6 个 v1 全为手工副本非管线路径）；**补测上翻补挂**（K20 真机 CDP，designer~user 1754 行）——§九 ☐ 项成文：补挂窗 53.8fps + 20 长任务 50-220ms，纯滚动 59.1fps；遗留疑点链路定位（taps 重建唯一触发面）；P2-B 留观项升格开放项 §八/5-7；详情 cr/logs/cr-1297.md |
| P4-3 虚拟滚动（条件项） | ✕ 不做 | cr-1298 | 2026-11-24 | 用户裁决（2026-11-24）：实测瓶颈 = 补挂批渲染成本（markdown/hljs 组件挂载），虚拟滚动无收益面——DOM 稳定 4229 / 堆 40MB / 纯滚动 59.1fps 全健康；单向窗口化（首载窗口 + 分帧补挂）已覆盖其解决面。遗留小杠杆未做：REFILL_BATCH 调小 / 补挂提前量（几行改动，另批裁决） |
| 质量评估 + 补缺（第三轮） | ☑ | cr-1299 | 2026-11-24 | 观察窗 14 采样时间线判读（四页面世代重建 + 断链窗暴增定位 + 计数语义 = derive 重扫）；**世代 D 零 turn-gap-fallback = 历史路径键贯通硬实证**（designer~user 1754 行全挂载，cr-1301 补注：该页彼时为 hidden，读数为末次渲染时点快照）；探针双指标升级（rows 去重口径解锁「归零即删」判读）+ probe.mjs 窗增量；§六判据口径/§九流式基线校正成文；详情 cr/logs/cr-1299.md |
| aggOrder 存量归一化 | ☑ | cr-1306 | 2026-11-24 | 段行 → v2 事件行等价映射（相位序由行序表达 / meter 经 reasoning-content 承载 / subcall 只产 result 行）+ 工具 scripts/normalize-segment-rows.mjs（staging→verify→原子换名）；218 文件 16262 行全转换、fold 投影对拍恒等 0 失败、复扫段行归零、doctor error 0、全仓 3632 例绿；备份 sandbox/segment-normalize-backup-2026-11-24T15-42-25；读侧退役待迁移边同批；详情 cr/logs/cr-1306.md |
| aggOrder 读侧退役（收口） | ☑ | cr-1307 | 2026-11-25 | 迁移边直产 v2 相位行（段行 v1 词形删除；aggregated 复用 cr-1306 映射逐步 slot 展开——注入按 ts 与步块交错；步面互斥防双投）+ aggOrder 全链删除（键/记账/消费）+ sessionFactsEqual 对拍面升级（seq 豁免 + aggregated 投影恒等；synthNullResults 提升库面）；全仓 3632 例 + integration 99 例绿；§八/5 收口；详情 cr/logs/cr-1307.md |
| 遗留疑点复测定性（收口） | ☑ | cr-1304 | 2026-11-24 | 串台根修后重做 e2e：restart_host + 不刷新 + 发消息 → 落账/拉壳/上屏/回落 <30s 全通——原疑点不成立（cr-1302 ②为串台单因）；附带记录 post-office 拉壳窗瞬时转投告警（自愈形态）；§八/10 收口；详情 cr/logs/cr-1304.md |
| contextBusy 跨会话串台根修 | ☑ | cr-1303 | 2026-11-24 | 无活跃会话时回落全局 turnInProgress → 任何其他会话 run 让输入框误显「停止」，点发送走 interrupt（消息压根没发）；真机双向因果实证 + 回归锁 3 例 + 双构建 + 真机复验；连带修正 cr-1302 实验②结论（受此污染，不作断链证据）；详情 cr/logs/cr-1303.md |
| 真机重测 + 遗留疑点 e2e 复现 | ☑ | cr-1302 | 2026-11-24 | 链路重建（adb 位置反查 + 浏览器重拉）→ 可见页采集全通过（可见性门 + 双指标读面上线）；流式基线真机首采：40s 窗 60fps/零长任务（v5，§八/8 补齐）；**遗留疑点确定性复现**：restart_host + 不刷新 → busy 卡死/消息不落账（epoch reload 未触发），reload 即愈——cr-1297 tap 假说不成立；详情 cr/logs/cr-1302.md |
| 采集口径修正（hidden 页无效） | ☑ | cr-1301 | 2026-11-24 | 手机页 `visibilityState=hidden` 实证 → §九「frameStats 恒 0 = 帧没到前端」推断作废；双指标对照实验 {hits 4560 / rows 5} 实证判读轴；§八/10 遗留疑点降级「待复测」；详情 cr/logs/cr-1301.md |
| fallback-probes 实例分裂根修 | ☑ | cr-1300 | 2026-11-24 | 探针单例入共享面（59 说明符）+ 冻结清单同步；cr-1296 frameScheduler 同族第三例；详情 cr/logs/cr-1300.md |

### P0 基线（审计 ☑ cr-1260 / 探针 ☐）

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|
| P0-A | 数据根审计 | 只读扫描、sandbox 跑完清理 | ☑ 存量形态 + 兜底命中计数成文（cr-1260） |
| P0-B | 性能探针重沉淀：真机 CDP（rAF 直方图 / longtask / CPU profile / 首载与切换耗时），探针收编 `scripts/perf-probe/`（cr-258 §五 既定去向） | 探针在 desktop + Android WebView 各跑一遍可复现 | 基线数字成文进本档 §九；P3/P4 后同口径复测可对比 |

### P1 快速加固（独立 CR 链，与迁移无依赖，可并行）

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|
| P1-1 | 签名单源化：`msgSig` / `turnContentSig` 从同一份 render-shape 字段清单派生 | 包内测试 + `webui:typecheck`；字段覆盖测试锁（新增字段未入清单即红） | 两份枚举物理合一；覆盖锁用例存在且绿 |
| P1-2 | 签名长度 → 增量滚动哈希（djb2，O(1) 可增量） | 同上 + 等长异容替换用例 | 等长异容替换触发重建（用例断言） |
| P1-3 | 稳定 key 同刻消歧（`turn-<agent>-<ts>-<n>`） | 快照测试 | 同 agent 同 ts 多轮场景 key 唯一 |
| P1-4 | `mergeHistoryPage` 前插后稳定 ts 排序（与 `toHistoryMessages` 同款） | 构造用例：直播中上翻续拉、incoming/existing ts 交叉 | 交叉输入合并后局部有序（用例断言）；「拼接假设」变构造保证 |
| P1-5 | ~~群历史透传 run 键~~ → 升格群链 R2（§八搁置） | — | — |

### P2-M v1 存量全量迁移（新增批；解锁 P2 条件退役项）

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|
| M-A | 迁移边纯函数 + 注册：`ac-migration-core` 链注册 v1→v2 会话格式边（函数体 = `domainFactsOf` 归一化 → v2 行序列化；复用 writer 序列化，不平行实现）；injectionId 补齐（= message_id 回填）；混合文件原地升头（新头继承旧头全字段 + `version:2` + `migratedFrom:1`）；坏行恒等携带 | 临时数据根（`AGENTCHAT_DATA_ROOT` 独立目录）单测：纯 v1 / 过渡态 / 坏行 / subcalls 档案 / 语义收窄点（段行相位序 → textBeforeTools）各有点名用例；typecheck + check:deps | 四断言（严格相邻 / from 无重复 / 链完整 / 未来拒绝）注册即过；边对夹具投影恒等（归一化读旧 == 直读新，fold 四投影逐项对拍） |
| M-B | 工具 `scripts/migrate-sessions-v2.mjs`：链驱动（`runChain`，工具内零换算代码）+ `--dry` 对账预演 + `--agent/--conv` 过滤 + 幂等重入（v2 头跳过）+ 逐会话报告；staging 写入 → verify → 原子换名 | 构造多代夹具全量迁移对拍；真实数据根 `--dry` 预演零异常 | `--dry` 报告：1414 会话全部可处理或显式「跳过原因」；无静默兜底 |
| M-C | 真实数据根执行：数据根备份 → 宿主 idle 窗口跑迁移 → journal/subcalls 转 `.migrated`（agent.patch 批 3 同款先例） | 迁移后：真实管线断言（admin~user / neko~user 夹具，cr-1132 同款）+ 重跑 cr-1260 扫描 + `pnpm test` 全量 | 重跑扫描：v1 头 + 过渡态 = 0；fold 四投影对旧文件（备份）与新文件输出恒等；管理面（删行/截断/分支）在迁后会话上行为不变 |

### P2 退役清扫（M-C 收口后；每处独立小 CR，cr-1108 样板）

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|
| P2-A 死代码直接删 | `onToolEnd` 位置匹配回退（feed-core.ts:1518）；`mergeResumeSnapshot` 镜像剔除（:1724）；`legacyRc` 行级 reasoning 挂首步（historyApi.ts:156，全数据根零命中） | 定向包内测试 + `webui:typecheck` | 三处物理删除；对应包测试绿且无行为变化断言 |
| P2-B v1 依赖项删 | `name` 兼容读取（historyApi.ts:33）；restarted 判别（fold.ts:278 / project.ts:70）；注入判重 v1 门控（fold.ts:394）；v1 概要窗（service.ts:456）；fold v1 聚合双路径（fold.ts:545/580）；`legacyEventQuota` 配额抵扣（feed-core.ts:750，~60 行）；events-core v1 分支与 journal/subcalls 读面缩减 | 每处独立 CR；`pnpm test` 全量（契约面）+ 快照测试锁 | 迁后数据根零命中（探针/扫描证明）；删除后 fold 四投影快照与迁前一致 |
| P2-C 兜底探针化 | 保留的兜底链（`isInjectEvent` 启发 / 内容前缀互验）挂命中计数探针 | 探针单测 | 观察期内命中归零 → 后续批删；非零 → 定位新来源 |

### P3 键控收敛（核心刀；依赖 P1-1 过渡保险、P2 腾空间）

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|
| P3-1 | 合并对齐收敛：四重机制 → 键控单机制 + 一条显式兜底 | 双写期影子对比（新旧路径输出 diff）；`pnpm test` + `pnpm test:integration` | 影子期零 diff；删除三重旧机制后真实数据根管线断言无回归（cr-1132 夹具：无降级轮、卡全挂锚轮） |
| P3-2 | keyed store：rawMessages → `Map<id,msg>` + 有序 id 表；轮复用 → turnId 键 diff；`msgSig` / `turnContentSig` / `invalidateTurns` 整体退役 | 同上 + 身份贯通回归（identity-throughput / b2-frame-seq 测试族） | 手工失效契约零残留（grep 断言）；流式期 stale 复用类缺陷归零（构造：中段 tool result 更新 / 注入卡后到 / 步边界） |
| P3-3 | 三份视角转换器 → 一份 ViewRow 消费器（historyMsg / pairMessage / groupMessage 并轨；群链仅做转换并轨、不动投影扩字段） | `webui:typecheck` + `build:channel` + conversation-row 测试 | 转换器单源；pair / group / single 三视角刷新渲染与并轨前快照一致 |
| P3-4 | 直播挂靠并轨 run 归口：直播帧补 run 键 → `curOwner` 位置启发退役 | 直播帧契约测试 + 双拍（刷新 vs 直播）同形断言 | 注入卡挂靠三路径（刷新 / 直播 / 上翻）恒同 |

### P4 架构归一（依赖 P3 键控基座；两刀可分批）

| 批 | 内容 | 测试标准 | 验证目标 |
|---|---|---|---|
| P4-1 | 轮分组上移投影：`foldViewRecords` 输出 TurnNode 分组树（turnId = runId 或首行 message_id；步带 stepId），`buildTurns` 六段启发坍缩为按键装配；双写过渡 | fold 快照测试 + 真实数据根三路径断言 | 直播 / 刷新 / 上翻三路径轮边界跨窗口恒同；`MERGE_GAP_MS` 降位为纯存量兜底 |
| P4-2 | 统一帧调度器：ingest → derive → markdown commit → scroll 单 rAF 流水线；idle-commit 升为调度器级静默判据（cr-258 P3 原始提案） | 流式回归（useChatShell / useChunkedMarkdown 测试族）+ P0-B 口径复测 | 每帧恰一次提交（探针断言）；流式期 fps / 长任务较基线不劣化、闪烁节律不齐消失（走查） |
| P4-3 | ~~虚拟滚动原型（**条件项**）~~ **✕ 不做**（cr-1298 用户裁决 2026-11-24：实测 DOM/堆/纯滚动全健康，瓶颈为补挂批渲染成本——虚拟滚动无收益且引入可变高度/滚动锚定复杂度；单向窗口化已覆盖） | — | — |

## 五、横切纪律（每批必过）

| 项 | 要求 |
|---|---|
| CR | 每批动手前 `node cr/cr.mjs append` 取号；代码注释引用 cr 号；台账攒批独立 chore 提交 |
| 验证阶梯 | `packages/` / `apps/` → `pnpm typecheck && pnpm test:unit && pnpm check:deps` + 定向 lint；前端行 → + `pnpm webui:typecheck`（client 面 + `pnpm build:channel`）；契约 / 行集 → + `pnpm test` 全量；会话链路 → + `pnpm test:integration` |
| 运行时生效 | 改 fold / web-api / groups-row（宿主侧）→ `restart_host`；前端 → `build:channel` 重构建后验证 |
| 数据根 | 测试 / 验证实例 `AGENTCHAT_DATA_ROOT` 独立临时目录；探针脚本住 `sandbox/` 跑完清理；M-C 前备份 |
| 文档收口 | 每批完成更新本档状态列；render-contract / session-design / cr-258 性能档随批勾销；动 docs 先读 `docs/doc-conventions.md` |
| 写完即精简 | 每批验证阶梯前后过一遍精简（行为分毫不变；回头信号出现即回退） |

## 六、成功判据（总）

| 原问题 | 判据 |
|---|---|
| 表现不稳定 | 流式期 stale 复用类缺陷归零；三路径同构夹具常绿；P0-B 基线复测流式 fps 达标 |
| 顺序缝隙 | 「直播中上翻续拉」构造用例常绿；三路径轮边界恒同 |
| 层积债务 | 净减估算：配额兜底 ~60 + 签名系统 ~150 + 对齐层 ~150 + 转换并轨 ~200 + v1 读兼容层；兜底探针分探针判据（cr-1289 口径校准；cr-1299 双指标判读口径）：anchor-cover ☑ 已删（cr-1294，双静态扫描零命中）；turn-gap-fallback / inject-run-miss 归零即删——**判读按 rows（去重行数）口径**（hits = derive 重扫次数，含流式期每帧重评估存量行——累计口径永不可归零）；inject-heuristic 终态 = 保留机制、存量词命中归零（§三 护栏：owning 行未装载降级不退役） |
| v1 存量 | 重跑 cr-1260 扫描：纯 v1 + 过渡态 = 0 |

## 七、节奏建议

P0-B → P1（当周，并行 M-A/M-B）→ M-C（idle 窗口）→ P2（按探针滚动）→ P3（专注批次，双写过渡）→ P4（收官）。P1 / P2 为纯减法随时可停；P3 是结构主轴——三轮分析的病灶在此一点收口。

## 八、搁置与开放项

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 群链 R2：`group/history` 投影扩字段（steps/reasoning/run） | 搁置（用户裁决 2026-11-23） | 并行 run 时序穿插（两 Agent 同时推理，run 时序互穿）——需先解决跨流 run 排序语义，非小改；群成员思维链/工具卡刷新即丢为已知现状 |
| 2 | 227 条存量 inject 无 injectionId | ☑ M-C 已覆盖 | 迁移边回填完成（cr-1272） |
| 3 | 虚拟滚动 | ✕ 不做（用户裁决 2026-11-24，cr-1298） | cr-1297 实测判读：瓶颈 = 补挂批渲染成本（组件挂载/markdown），非 DOM 体量（4229 节点/40MB 堆稳定）——虚拟滚动无收益面；纯滚动 59.1fps 健康。单向窗口化（renderFrom：首载 24 + 分帧补挂）已覆盖其解决面。后续 hitch 优化走小杠杆：REFILL_BATCH 调小 / 补挂提前量（另行裁决） |
| 4 | 全局 seq 逻辑时钟 | 不做 | 同刻边界语义位裁决已覆盖 |
| 5 | `aggOrder` v1 聚合词（fold.ts:545 + events-core.ts:131/290/299） | ☑ **读侧已退役（cr-1307）** | cr-1305 判据核实（写面归零）+ cr-1306 存量归一（218 文件 16262 段行 → v2 相位行，盘上段行归零）后，cr-1307 完成收口双件：**迁移边直产 v2 相位行**（`segmentRow` v1 词形删除；aggregated 复用 cr-1306 映射逐步 slot 展开——注入行按 ts 与步块交错，还原段行间插位；步面互斥：aggregated 在场时跳过 journal 步相位事件重放防双投）+ **aggOrder 全链删除**（RunFactsV2 键 + events-core 段行/注入行记账 + fold.ts trajectoryOfFacts 消费分支）。`aggregated` 读分支保留（迁移边输入面——v1 外部导入读侧归一化入口不撤）。配套：产物行 seq 改统一重排（ts 全序 + 逐行重分配——foldStepsOf 相位序推导依赖 ev.seq）；`sessionFactsEqual` 对拍面升级（seq 全面豁免 + 空数组归一 + aggregated 投影恒等 + events 步面互斥；`synthNullResults` 提升库面，normalize 工具 import 单源）；测试判据单源（expectFactsEqual 委托库面；fold.test v1/v2 等价改「归一化读旧 == 直读新」）。全仓 3632 例绿 + integration 99 例绿。详情 cr/logs/cr-1306.md / cr-1307.md |
| 6 | `restarted-*` 存量通知行（fold.ts:283 读侧判别） | ☐ 留观 | P2-B 留观项——cr-1297 全根扫描：5960 行在盘（creator 5822 / admin 134 / standard 3 / tester 1），全部 cr-946 前落形；现行机制已改 context+event 行。退役判据：读侧判别分支保留至盘上存量无消费价值（或一次性数据根归一化裁决） |
| 7 | `legacyEventQuota` 前端配额抵扣语义 | ☐ 留观 | P2-B 留观项——cr-1295 确认机制已删（cr-1281 event-quota 探针关闭）；「quota」残留仅注释。**判读：已终态**——§四 P2-B 状态板「quota 实测仍服役留观」为滞留表述，无行动项 |
| 8 | ~~真机流式基线缺口~~ | **☑ cr-1302 已采** | 真机流式 40s 窗（v5，可见页 + 生成中）：60fps / p99 16.8ms / 零长任务 / DOM 3388 稳定——**桌面节拍流结论（59.8fps）在真机节拍下同样成立**（cr-1299 曾判该缺口未采） |
| 9 | 构建面根因：rollup `external` 按说明符字面匹配 | ☐ 开放 | cr-1300 实证三例同族（frameScheduler / feed-core〔cr-1296〕、fallback-probes〔cr-1300〕）——共享面模块内部的**相对引用链**不被外部化 → 单例副本随 bundle 内联。治标 = 逐例入清单（现有做法）；治本 = external 按**解析后路径**匹配（共享面源文件绝对路径集合）。当前残留实例：`chatOps.ts`（`historyCursor` 会话分页游标）——调用方全在共享面故运行时一致，任何非共享模块接入即分裂。属构建机制改造，待裁决 |
| 10 | ~~遗留疑点（宿主重启后流式帧不续）~~ | **☑ cr-1304 复测定性：疑点不成立** | 串台根修后重做 e2e：restart_host（23:33:18 新代）+ 页面不刷新（pageAge 连续实证）+ 发消息 → **全链路健康**——消息落账（正本 165→170 行）、designer 壳按需拉起（pid 42296）、回复「13。」上屏、busy 正常回落，全程 <30s。cr-1302 实验②的失败确系 contextBusy 串台单因（cr-1303），无宿主侧断链；「壳被拉起但零写入」系壳由更早拉壳事件遗留（消息本未发出，无消息即无 run，空转属预期）。附带记录：post-office 在壳 boot 窗的瞬时转投告警（ipc 并发限制/连接关闭，同秒双发后自愈）——瞬态形态，非缺陷 |

## 九、性能基线（P0-B cr-1296 采集 · 2026-11-24）

采集环境：Redmi K20（Android 11，骁龙 855）· MIUI 浏览器 = Chrome 135.0.7049.79 · CDP 经 adb forward；宿主 PC 同机（pnpm dev，webui 3830）。口径注记：**容器为 MIUI 浏览器而非 System WebView**（AgentChat app 未安装——用户裁决浏览器直连路线）；与 cr-258 基线（WebView Chrome 122 debug 构建）不可直接对比，作 P3/P4 后同口径复测的前置基线。desktop 数字待采（可后补）。

| 指标 | K20 MIUI 浏览器 | 采集日 |
|---|---|---|
| 空闲 fps（会话页静止 10s） | **60 fps**（p50/p99 均 16.7/16.8ms，零长任务，DOM 984，堆 28MB） | 2026-11-24 |
| 滚动/上翻 fps（15s 持续滚动） | **59.9 fps**（p99 16.8ms；1 次 56ms 长任务；DOM 794，150 次滚动事件） | 2026-11-24 |
| 流式 fps（其他 Agent 回复期间 40s） | **59.8 fps**（p99 16.8ms，零长任务，DOM 1238，堆 40MB）——口径注记（cr-1299）：桌面节拍流（~1 帧/s 增量）；**真机节拍流已补采**（cr-1302 v5：60fps / p99 16.8ms / 零长任务 / DOM 3388） | 2026-11-24 |
| 会话切换（点击→首变/稳定） | 首变 **63ms** / 稳定 2.7s（含 loadMore 链，524 次 DOM 变更） | 2026-11-24 |
| 大会话首载（首屏装配） | ~3s（导航→会话列表可交互，含 WS 握手） | 2026-11-24 |
| 上翻补挂手感（≥500 条） | 已测（cr-1297 补采）：1754 行会话（designer~user）驱动上翻 15s×2 轮——**补挂窗 53.8 fps**（p50 16.7ms）但 **20 个长任务 50-220ms**（补挂批挂载 DOM +835 节点 / scrollHeight +34K px）；滚到顶后纯滚动窗 **59.1 fps**（3×~55ms 长任务，DOM 稳定不增长 = 窗口化挂载在位） | 2026-11-24 |
| 补挂批最大长任务 | **220ms**（补挂批挂载窗；P4-3 启动判读输入——百 ms 级长任务多次出现，见 §八/3） | 2026-11-24 |

探针观察窗判读（cr-1299 时间线重建，14 份采样 + 14:12 实时读数；旧单累计口径数字仅存证）：早期三空闲样本（12:17-12:20，8.6/10/12 fps）系探针注入自身 rAF 循环伪影，非管线退化；12:53 首报数字 15044/2407/18 中 +14307/+2407 暴增集中于 12:31→12:53 断链窗（宿主 restart_host ×2 期间——帧驱动高密度重扫 + 断连收口重挂），非新缺陷形态。**计数语义 = derive 重扫次数**（每次 buildTurns 重跑对存量注入行重复计数）——「归零即删」在累计口径下不可判读，cr-1299 起探针双指标（hits/rows），判读以 rows（去重行数）为准。**世代 D（14:12，refill 采样页续用，designer~user 1754 行全挂载）零 turn-gap-fallback** = 历史路径轮分组键贯通的硬实证（M-C 迁移 + P4-1 键落位联合效果，真实数据验证）；流式样本（12:30/12:31 两窗，+27/+16 hits）为桌面流节拍——**该机流式 60fps 档结论仅对桌面节拍成立，真机流式基线缺口未采**（下一轮真机采集补）。

**双指标对照实验（cr-1301，本地可见页 × 同一宿主）**：重载后 3.5s → `{hits: 10, rows: 5}`；再静置 2.5s → `{hits: 30, rows: 5}`（≈8 hits/s，无用户操作——后台 WS 帧驱动 derive 重跑）；持续观察数分钟 → `{hits: 4560, rows: 5}`（**912 倍虚增**）。**rows 全程恒定 5**（行身份稳定）而 hits 随渲染轮次线性增长——两轴语义与设计意图完全吻合，直接实证「累计 hits 不可作缺陷计数、rows 才是判读轴」。

**P0-B 副产物（采集过程实锤的两个缺口，均已修）**：
1. `frameStats` 生产读面缺位（P4-2 探针只挂了测试面）→ 已挂 `window.__AC_FRAME_STATS__`（feed-core 装配点，cr-1289 同款接线）；
2. **frameScheduler 模块实例分裂**（真 bug）：frameScheduler 不在 shared-modules 共享清单 → main/channel bundle 双实例 → P4-2「单 rAF 流水线」在生产行星被破坏（stats 分裂、双 rAF 链）→ 已入共享清单（+ feed-core 装配点）+ 冻结清单同步 + 双构建 + 宿主重启。
3. **fallback-probes 同族分裂**（cr-1300，cr-1299 产物核实中发现）：兜底探针是模块级计数单例，被 feed / feed-core（两者均在共享面）引用但自身未入清单 → 双 bundle 各内嵌一份；当前因引用方全在共享面而未爆，属隐式前提——已入共享清单（59 说明符）+ 冻结清单同步 + 双构建 + 宿主重启。**教训：共享面判断不能只看「引用方在不在」，被引用的单例状态模块本身必须同列**。

**遗留疑点（另开排查，不阻塞基线结论）**：宿主重启后手机页面流式帧疑似不续（消息送达、回复落账，但页面 markdown 不再上屏）。cr-1297 链路分析：客户端恢复面完备（epoch 换代钩子 → reload + agents/list / feed onOpen → loadHistory 对账 + resyncRetry 重试），疑点收敛到宿主侧 tap 链——**宿主重启（taps Map 蒸发）后 taps 重建的唯一触发面是 ensureAgent 的 onAdopted 钩子**（cr-967 adoptLiveShells boot 扫活锁接管可覆盖多数形态；shell idle-exit 后的下一次发消息走 ensureHook → ensureAgent → tap 重建）。缺确定性 e2e：宿主重启 + 页面不刷新 + 断连窗口后发消息 → 恢复的流式帧。

**采集口径修正（cr-1301，实证推翻上一行的推断）**：14:12 与之后对该手机页的全部读数均取自 `document.visibilityState === 'hidden'` 的**后台页面**——`hidden` 页 rAF 不回调（async eval 等待 rAF 挂死 60s 实证）、`setTimeout` 受 intensive throttling、Vue computed 不被渲染求值 → **frameStats 与探针双双冻结是必然结果，不能作为「帧没到前端」的证据**。该页冻结值（frames 57 / commits 30 / probes 98-3）恰等于 cr-1297 补挂测试结束时的状态，即此后页面从未渲染过一帧。故：①「frameStats 生产 commit 恒 0 与疑点耦合」的推断**作废**；②本档所有源于该页的冻结读数（含零增长复核）只证明「页面被置于后台」，不证明帧投递链路。遗留疑点定性必须**页面置前台**复测——在此之前不得归因宿主 tap 链。

**终判（cr-1302，前台页确定性 e2e）**：三连实验闭合——①正常链路发送 ✓（9+9=18/6+7=13 上屏 + 落账，触发正常 compaction 归档）；②restart_host + 页面不刷新 + 发消息 → ✗ **确定性复现**：busySend 跨重启卡死、点「发送」走 interruptGeneration 分支（onPrimary 忙态语义）、消息不落账、看门狗不自愈；③reload 后重发 → ✓ 立即恢复。**定性：宿主重启后页面不自愈——epoch 换代通知未触发 reload（pageAge 跨重启持续增长实证）**，且宿主侧 dispatch 后信封未达壳（designer 壳 22:45:26 被 dispatch 拉起、boot.ready 完成，但正本/inbox/journal 零写入——cr-1297「taps 重建 = onAdopted 唯一触发面」推断不成立）。修复方向另批：页面侧 epoch 检测链（onEpoch 注册 / WS onclose 触发）+ 宿主侧 dispatch→tap 环节。

**复测终判（cr-1304，推翻本段 cr-1302 定性）**：cr-1303 串台根修后重做同款 e2e——restart_host（23:33:18 新代）+ 页面不刷新（pageAge 连续实证）+ 发消息：**消息落账（正本 165→170 行）、designer 壳按需拉起（pid 42296）、回复「13。」上屏、busy 正常回落，全程 <30s**。原疑点不成立——cr-1302 实验②的「失败」由 contextBusy 串台单因解释（点发送实为 interrupt，消息从未进发送链）；「壳被拉起但零写入」系壳由更早拉壳事件遗留、当时消息本就未发出（无消息即无 run，空转属预期）。宿主重启后链路无断链；post-office 在壳 boot 窗的瞬时转投告警（ipc 并发/连接关闭，同秒双发后自愈）为瞬态形态非缺陷。

## 十、相关档案

- 渲染契约：`docs/design/webui/render-contract.md`；注入卡锚定：`docs/design/webui/inject-card-anchoring-plan.md`
- 回放契约：`docs/design/session/replay-contract.md`；会话域事实源：`docs/design/session/session-design.md`
- 迁移链立法：`docs/design/assembly/migration-chain-completeness.md`
- 移动端性能：`docs/design/webui/webui-mobile-render-perf-plan.md`；ui 树：`docs/design/webui/ui-tree.md`
- 审计正本：`cr/logs/cr-1260.md`