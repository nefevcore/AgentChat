// 目标读者：处理下列遗留性能项的人/Agent。本文是诊断记录 + 待办清单
//（cr-978 已修主根因后的余量，2026-11-10 首屏 17-30s → 11.6s 冷/预期 <2s 温）。
// 证据：[switch] 打点日志（rpc-slow/boot-wire/singles-boot——cr-978 随附，
// localStorage 开关启用）+ WS 帧日志（ws-log 抓法：DevTools → Network → WS → Messages）。

# 首屏性能遗留清单（cr-978 余量）

## 已修（背景，勿重复处理）

1. **runs/snapshot 恒崩**（v1 裸行缺 message_id——`sub_*` 早期子 Agent 会话 ×16）：
   `projectUserReplay` 判别面容错 + `seen.add(undefined)` 判重塌缩修复
   （packages/ac-ledger/src/project.ts，回归测试 cr978-legacy-rows.test.ts）。
2. **全根重扫风暴**：展开阶段按会话指纹 memo 化 + 分批让出 + 单会话降级
   （packages/ac-host-webui/src/face-ops.ts）。

## 遗留（按优先级）

### 1. runs/snapshot 并发冷启动重复扫描（当前最大余量：~8s）

实测：页面装载期 5 个并发 runs/snapshot 调用（roster fetchAgents / runview
轮询 / group 面板 / resync）各自 **~8s**——memo 未预热时并发调用各自全量展开
（无在途共享），在单线程宿主上串行叠加 ~8s×5 的扫描波，把 singles/list
（7.8s）与首批轻 RPC（全体 ~2s）一起拖住。

修法：single-flight——在途 Promise 共享（并发调用等同一趟）；可选：宿主 boot
后空闲预热 memo 一次（首屏前完成冷填充）。

### 2. 冷首扫的同步段仍拖首批 RPC ~2s

interaction/list、system/version 等轻 RPC 首批全体 ~1990ms——宿主事件循环被
冷扫描独占的排队特征。修 #1 后应大幅消解；若仍有，把展开批粒度 16 → 时间片
（每 ~16ms 让出）并核查 stat 扫描段（见 #3）是否同步。

### 3. runs/snapshot 每拍仍有 ~750ms 同步 stat 全扫（1240 会话 × 每目录 3 文件）

digest 指纹靠 stat 全扫收集——每拍（digest 变化时）都付。正解 = 走
ac-session-index 查询（cr-973 已就位的指针索引行：size/mtime/计数入索引，
快照读索引不触盘；摘行降级回落 stat 扫）。工作量中等，收益：快照读面零盘 IO。

### 4. singles/list 三路并发 + stat 段无让出

前端 PrimarySidebarHost / SessionList / resync 三处并发 refresh（实测 3 路）。
修法：前端侧 refresh 单飞（board 内在途共享）；服务端 list 的指纹复验段
（1049 条目 ~751ms 同步）加分批让出（cr-843 同款）。

### 5. 存量数据清理（可选）

- 16 个 `sub_*` 会话的裸行缺 message_id/timestamp——可经 ac-backup-core 快照
  通道择机补齐行身份（读容错已在 cr-978 兜底，此项纯数据卫生）。
- workspace/home 下 subcalls.jsonl 合计 ~900MB（news 19.9MB / writer 13.8MB…）
  ——归档压缩时机（cr-974 的 S5 白名单）未对这些自会话桶执行过，可择机归档。

### 6. 诊断打点去留

rpc-slow（>1s RPC）/ boot-wire / boot-row（>300ms 行）/ singles-boot 均走
[switch] 轨道（localStorage 开关，零默认噪音）。观察一个版本后决定常驻或回收。

## 验收基线（修 #1/#2 后应达）

冷启动：singles-boot refresh < 2s、rpc-slow 零出现；温启动（memo 热）：< 1s。
