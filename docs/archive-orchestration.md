# 归档调度机制（Archive Orchestration）

> 版本：v0.5.x（2026-08-08 迁移到 5 层架构）
> 状态：已迁移并实测验证（1:1 会话；群聊走 save-session 周归档，不参与 1:1 编排）

## 核心思想：先整理后归档

阈值归档不再"先归档后让 Agent 检索"，而是**先让 Agent 在完整上下文里整理记忆，再归档**。

为什么：
- 归档是物理单次操作，但**记忆整理是语义双边需求**
- 1:1 会话：归档发生在接收方 runEnd，发送方上下文已释放——若先归档，发送方只能靠检索
- 共享 messages.jsonl 使得双方整理轮 loadHistory 都能读到**完整文件**（尚未归档），天然解决"发送方无法自然分析"

```
触发 → 写标记 → 双方/多参与者整理轮（完整上下文）→ 全部完成 → 归档
```

## 实现位置（5 层架构）

- **核心编排**：`src/services/archive-service.ts`（L4 ArchiveService；runEnd 超阈值 / 手工归档 / 批量 / 超时扫描 / 空闲归档统一入口）
- **整理轮标志**：`CurrentContext.meta` 通用扩展通道（`src/core/context.ts`，L1 不解释键）+ `TriggerOptions.meta`（`src/agents/router.ts`）
- **常量键**：`META_ARCHIVE_REVIEW = 'archive-review'`（`src/plugins/builtin/namespaces.ts`）
- **runEnd 钩子**：`makeArchiveSessionHook`（`src/plugins/builtin/hooks/run.ts`）经 `PluginServices.archiveSession` 委托 `ArchiveService.handleRunEnd`
- **会话持久化跳过**：`saveSession`（`src/plugins/builtin/hooks/session.ts`）检测 `ctx.meta?.[META_ARCHIVE_REVIEW]` → 整理轮不落盘
- **装配注入**：`src/app/index.ts`（L5）创建 ArchiveService → 注入 `services.archiveSession` / `services.idleReset` / `HistoryService({archive})` / `setupPlugins.archiveAll` / shutdown `dispose`

## 标记体系（系统管理，Agent 不碰）

| 标记 | 位置 | 含义 |
|------|------|------|
| `.archive_pending` | 会话目录 `sessions/chat~<lo>~<hi>/` | 待归档（含参与者 + 时间戳）|
| `.archive_done_<agentId>` | 会话目录 | 该侧整理完成 |

**新平铺路径**：`sessions/chat~<lo>~<hi>/`（排序后）——归档标记是会话级状态，双方共享。

> 记忆审查标记（`.memory_review_needed`）已移除（2026-08-08）：失忆就失忆，
> Agent 可在会话中用 `query_history` 重新回忆。记忆更新统一由整理轮完成
> （整理轮提示要求「重写」memory.md：合并/压缩/删除过时记忆）；另有
> `agent.memory.memoryMaxTokens` 文件硬上限兜底（超限自动剪除中间过时内容）。

## 1:1 会话流程

```
① B runEnd 检测超阈值（actualTotal 或 estimatedTotal > maxContextTokens × archiveTokenRatio）
   → requestArchive(agent, counterpart)
   → 写 .archive_pending（含 participants：[agent] 或 [agent, counterpart]）
   → trigger 双方整理轮（meta['archive-review']=true, target=对方）

② 整理轮（特殊 meta['archive-review']）：
   runStart: 正常 loadHistory → 完整文件（尚未归档）
   ReAct:    整理 memory.md / TODO.md / note/ + 写 SUMMARY.md
   runEnd:   save-session 跳过（不落盘，不污染会话文件）
             → archive-session 写 .archive_done_<自己的ID>（completeArchiveReview）
             → 检查所有参与方完成 → 归档

③ 最后完成的 runEnd → archiveAndRebuild + 清理标记 + notifyArchiveCompleted
```

关键点：
- **target=对方** → sender=对方 → loadHistory 读到正确会话文件
- 单边（user↔agent）：只 trigger agent，1 标记齐即归档
- 双边（agent↔agent）：双方都整理，2 标记齐才归档
- **不落盘**：整理轮的消息不写会话（saveSession 的 meta['archive-review'] 分支跳过）

## 超时降级与批量

- `scanPendingArchives`：启动 + 每 5 分钟扫描 `sessions/chat~*/.archive_pending`
  - 超时（> 10 分钟）→ 强制 `idleArchive`（reason='pending-timeout'）
  - 未超时残留（重启打断整理轮）→ 清理，不强制归档
  - 顺带清理孤儿 `.archive_done_*`（无 pending 配对的迁移遗留）
- `archiveAllActiveSessions`：`__archive_all__` 定时特殊 hint 触发，遍历所有活跃 1:1 会话逐 `requestArchive`

## 降级与兜底

| 场景 | 处理 |
|------|------|
| 整理轮触发失败 | catch → 写 done(failed=true)（记忆不整理，会话内 query_history 可回忆）|
| 整理轮执行失败（LLM error）| runEnd 检测 messages 含 error → 同上 |
| 部分参与者不完成 | 全局 watcher 每 5 分钟扫描 .archive_pending，超 10 分钟强制归档 |
| 小会话（token < 保留预算）| keepRecentRatio 全保留，不写 history_N（设计行为）|

## 配置项（agent.session）

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxContextTokens` | 1000000 | 1:1 上下文硬上限（归档触发基数）|
| `archiveTokenRatio` | 0.7 | 1:1 归档触发比例（× maxContextTokens）|
| `keepRecentRatio` | 0.03 | 归档后保留的最近消息比例 |
| `summaryPreviewLen` | 4000 | SUMMARY.md 摘要生成/注入字数上限 |
| `idleArchiveSec` | 14400 | 空闲归档等待时间（秒）|

> 注：群聊（`groupArchiveTokens` / `groupLoadLimitTokens`）在新架构由 `saveSession` 双写周归档
> （`sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl`）承载，不参与 1:1 编排。

## Agent 提示词（agent-prompt）

- 收到以 `[归档整理]` 开头的 trigger → 基于完整上下文整理记忆，**系统自动归档，无需管理标记**
- 记忆更新统一由整理轮完成（写 SUMMARY.md + memory.md）；失忆场景在会话中用 `query_history` 重新回忆

## 测试与验证（2026-08-08 迁移后）

`tests/services-archive.test.ts`（11 用例）：
- requestArchive：写 pending + 触发双方整理轮 / 幂等 / 虚拟 counterpart 单侧 ✅
- archiveAllActiveSessions：批量触发（跳过空/自对话/群聊/已有 pending）✅
- scanPendingArchives：超时强制归档 / 未超时清理 + 审查标记 ✅
- handleRunEnd：整理轮全完成 → 归档 + 清理标记 / 未全完成仅写 done / 超阈值触发 / 未超阈值跳过 ✅
- archiveAndRebuild 二次归档去重（跳过上次归档最后一条）✅

已知差异（相对旧实现）：
- `getPendingMessages/clearPendingMessages`（WeakMap 本轮缓存）不再需要——新架构 runEnd 的
  `saveSession` 已把整轮消息落盘，归档时 `ctx.history` 即完整消息源
- 归档目录用 ArchiveService 注入的 wsRoot 计算（不依赖全局 workspaceRoot，测试可隔离）
- `notifyArchiveCompleted` 走 `router.emit('archive.completed')` → ws 广播 `session.archived`（与旧一致）

## 调试

- 日志前缀 `[services:archive]`（createLogger）——1:1 归档全链路
- `read_logs({keyword: 'archive'})` — 归档
- `read_logs({level: 'warn'})` — 降级/失败
