# 归档调度机制（Archive Orchestration）

> 版本：v0.4.x（2026-08-01 重构）
> 状态：已实现并实测验证（1:1 会话 + 群聊）

## 核心思想：先整理后归档

阈值归档不再"先归档后让 Agent 检索"，而是**先让 Agent 在完整上下文里整理记忆，再归档**。

为什么：
- 归档是物理单次操作，但**记忆整理是语义双边需求**
- 1:1 会话：归档发生在接收方 postHook，发送方上下文已释放——若先归档，发送方只能靠检索
- 共享 messages.jsonl 使得双方整理轮 preHook 都能读到**完整文件**（尚未归档），天然解决"发送方无法自然分析"

```
触发 → 写标记 → 双方/多参与者整理轮（完整上下文）→ 全部完成 → 归档
```

## 标记体系（系统管理，Agent 不碰）

| 标记 | 位置 | 含义 |
|------|------|------|
| `.archive_pending` | canonical 会话目录 | 待归档（含参与者 + 时间戳）|
| `.archive_done_<agentId>` | canonical 会话目录 | 该侧整理完成 |

**canonical 路径**：`sessions/<lo>/<hi>/`（排序后）——归档标记是会话级状态，双方共享。
**方向敏感路径**（memory.md / .memory_review_needed）：`sessions/<agent>/<counterpart>/`——各自视角独立。

## 1:1 会话流程

```
① B postHook 检测超阈值（actualTotal 或 estimatedTotal > maxContextTokens × archiveTokenRatio）
   → requestArchive(agent, counterpart)
   → 写 .archive_pending（含 participants：[agent] 或 [agent, counterpart]）
   → trigger 双方整理轮（archiveReview=true, target=对方）

② 整理轮（特殊 ctx.archiveReview）：
   preHook:  正常 loadHistory → 完整文件（尚未归档）
   ReAct:    整理 memory.md / TODO.md / note/
   postHook: 不落盘（跳过持久化/用量/定时器）
             → 写 .archive_done_<自己的ID>（completeArchiveReview）
             → 检查所有参与方完成 → 归档

③ 最后完成的 postHook → archiveAndRebuild + 清理标记
```

关键点：
- **target=对方** → sender=对方 → preHook loadHistory 读到正确会话文件
- 单边（user↔agent）：只 trigger agent，1 标记齐即归档
- 双边（agent↔agent）：双方都整理，2 标记齐才归档
- **不落盘**：整理轮的消息不写会话（archiveReview 分支跳过持久化）

## 群聊流程（多参与者泛化）

```
① GroupManager.deliverGroupMessage 持久化消息后
   → maybeRequestGroupArchive（token > groupArchiveTokens）
   → 或 preHook 加载超限（token > groupLoadLimitTokens）
   → requestGroupArchive(groupId)
   → 写 groups/<id>/.archive_pending（含参与者）
   → trigger 所有真实参与者整理轮（archiveReview=true, group_id）

② 每个参与者整理轮：
   preHook:  loadGroupHistory → 完整群聊历史
   ReAct:    整理自己对群聊的独立记忆
             sessions/<agent>/group__<id>/memory.md
   postHook: completeGroupArchiveReview（写 .archive_done_<agent>）

③ 全部完成 → archiveGroupMessages：归档 history_N + 保留近期 + 摘要锚点 summary_N
```

## 群聊双阈值（token 消耗控制）

群聊是共享历史 + 多参与者，每个 Agent preHook 全量加载，必须双保险：

| 阈值 | 默认 | 作用 |
|------|------|------|
| `groupArchiveTokens` | 50K | 消息总量超此值 → 投递时触发归档 |
| `groupLoadLimitTokens` | 30K | 单 Agent 加载超此值 → preHook 立即触发归档 + 截断本次加载 |

即使 groupArchiveTokens 配高，加载超限也会触发——双保险防 token 爆炸。

## 降级与兜底

| 场景 | 处理 |
|------|------|
| 整理轮触发失败 | catch → 写 done(failed=true) + markMemoryReviewNeeded（每日审查兜底）|
| 整理轮执行失败（LLM error）| postHook 检测 loopMessages 含 error → 同上 |
| 部分参与者不完成 | 全局 watcher 每 5 分钟扫描 .archive_pending，超 10 分钟强制归档 |
| 小会话（token < 保留预算）| keepRecentRatio 全保留，不写 history_N（设计行为）|

## 配置项（extension.agent_session）

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxContextTokens` | 1000000 | 1:1 上下文硬上限（preHook 压缩兜底）|
| `archiveTokenRatio` | 0.5 | 1:1 归档触发比例（× maxContextTokens）|
| `keepRecentRatio` | 0.03 | 归档后保留的最近消息比例 |
| `groupArchiveTokens` | 50000 | 群聊归档触发阈值 |
| `groupLoadLimitTokens` | 30000 | 群聊单次加载上限（安全阀）|

## Agent 提示词（agent-prompt）

- 收到以 `[归档整理]` 开头的 trigger → 基于完整上下文整理记忆，**系统自动归档，无需管理标记**
- 每日定时审查 → 检查 `.memory_review_needed` 标记（降级兜底产生）→ query_history 检索 → 更新记忆 → bash 删除标记
- 群聊记忆位于 `sessions/<agent>/group__<id>/memory.md`

## 测试与验证（2026-08-01）

1:1 会话：compress marker → requestArchive → 双边整理（双方 memory.md 产出）→ done 凑齐 → 归档 → 标记清理 ✅

群聊：群消息 → maybeRequest（token 超阈值）→ requestGroupArchive → 4 参与者整理群聊记忆 → 4 done → 归档 + 清理 ✅

发现的 bug（已修复）：
- AppState 未注入 GroupManager（二次 setAppState 覆盖）→ 参与者读不到
- postHook group_id 分支在 archiveReview 之前 → 群聊整理轮被提前 return

## 调试

`read_logs` 工具（autoInject）可直接查链路日志：
- `read_logs({keyword: 'group-archive'})` — 群聊归档全链路
- `read_logs({keyword: 'archive'})` — 1:1 归档
- `read_logs({level: 'warn'})` — 降级/失败
