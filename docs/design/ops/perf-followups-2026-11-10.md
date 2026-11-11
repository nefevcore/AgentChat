# 首屏性能遗留清单（cr-978 余量）

> 性质：活清单——cr-978 修主根因后的首屏性能遗留项诊断记录与待办（#1-#4 已修，余数据卫生与打点去留两项）。
> 状态：现行（待 [switch] 打点观察一个版本后回收）· cr-979 2026-11-10 登记，#1-#4 由 cr-980/cr-982 同日修复。
> 读者：处理首屏性能遗留项、或读 rpc-slow/boot-wire 打点的人。
>
> 证据：[switch] 打点日志（rpc-slow/boot-wire/singles-boot——cr-978 随附，localStorage 开关启用）+ WS 帧日志（ws-log 抓法：DevTools → Network → WS → Messages）。
> 基线：2026-11-10 首屏 17-30s → cr-978 后 11.6s 冷 → #1-#4 修后预期 <2s 冷 / <1s 温。

## 已修（背景，勿重复处理）

1. **runs/snapshot 恒崩**（v1 裸行缺 message_id——`sub_*` 早期子 Agent 会话 ×16）：
   `projectUserReplay` 判别面容错 + `seen.add(undefined)` 判重塌缩修复
   （packages/ac-ledger/src/project.ts，回归测试 cr978-legacy-rows.test.ts）。
2. **全根重扫风暴**：展开阶段按会话指纹 memo 化 + 分批让出 + 单会话降级
   （packages/ac-host-webui/src/face-ops.ts）。

## 遗留（按优先级）

### 1. ✅ 已修（cr-980，2026-11-10）：runs/snapshot 并发冷启动重复扫描

实测：页面装载期 5 个并发 runs/snapshot 调用（roster fetchAgents / runview
轮询 / group 面板 / resync）各自 **~8s**——memo 未预热时并发调用各自全量展开
（无在途共享），在单线程宿主上串行叠加 ~8s×5 的扫描波，把 singles/list
（7.8s）与首批轻 RPC（全体 ~2s）一起拖住。

修法（已落地，face-ops.ts）：single-flight——在途 Promise 共享（并发调用等
同一趟，逐调用方 digest 对账）＋ boot 注册即预热一趟（首屏 RPC 直接 join
预热航班，冷填充在页面前完成）。

### 2. ✅ 已修（cr-980）：冷首扫的同步段仍拖首批 RPC ~2s

interaction/list、system/version 等轻 RPC 首批全体 ~1990ms——宿主事件循环被
冷扫描独占的排队特征。已落地：展开段与回落 stat 扫段全部批粒度计数 →
**~12ms 墙钟时间片**让出（face-ops.ts SLICE_MS）。

### 3. ✅ 已修（cr-980）：runs/snapshot 每拍 ~750ms 同步 stat 全扫

已落地：sessionIndex 行在场 → 指纹源 = files 表账面聚合（ac-session-index
新增 refreshStats/catalog/drop——stat 面入账不读内容，零盘 IO 读面）；
变更面定向入账 = running 集 ∪ 近期 running 余温（30s）∪ 未入账新会话；
目录消失清账（drop）；60s 周期空闲全量对账兜底外部写（crash 壳收束尾部 /
绕过通知的写——digest 新鲜度上限 = 对账周期 + 一拍）。行摘除回落全量
stat 扫（时间片让出，同构降级）。

### 4. ✅ 已修（cr-980 + cr-982）：singles/list 三路并发 + stat 段无让出

前端 PrimarySidebarHost / SessionList / resync 三处并发 refresh。已落地：
SingleBoardService.refresh 在途共享（三路并发 = 一趟 RPC）；服务端 list
指纹复验段（cr-982 根修）：sessionIndex 在场 → messages 账面一次读
（messagesCatalog——与 ledgerFingerprint 同公式，零盘 IO；实测千级条目
~1.1s/次 → ~2ms；账面新鲜度由 runs/snapshot 变更面定向入账 + 60s 对账
维护），行缺席回落逐条目 stat 复验（同构降级）。

### 5. 存量数据清理（可选）

- 16 个 `sub_*` 会话的裸行缺 message_id/timestamp——可经 ac-backup-core 快照
  通道择机补齐行身份（读容错已在 cr-978 兜底，此项纯数据卫生）。
- workspace/home 下 subcalls.jsonl 合计 ~900MB（news 19.9MB / writer 13.8MB…）
  ——归档压缩时机（cr-974 的 S5 白名单）未对这些自会话桶执行过，可择机归档。

### 6. 诊断打点去留

rpc-slow（>1s RPC）/ boot-wire / boot-row（>300ms 行）/ singles-boot 均走
[switch] 轨道（localStorage 开关，零默认噪音）。观察一个版本后决定常驻或回收。

## 验收基线（#1-#4 已修——待 [switch] 打点观察一个版本后回收本清单）

冷启动：singles-boot refresh < 2s、rpc-slow 零出现；温启动（memo 热）：< 1s。
