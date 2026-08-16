# @agentchat/archive
> 包路径 `src/svc/archive` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
归档编排服务（L4 门面）。实现“先整理后归档”：runEnd 超阈值触发双方归档整理 run，双方完成后把早期消息移入 `archive/history_<N>.jsonl`、从尾部保留近期消息重建 `messages.jsonl`；空闲计时与超时扫描做降级兜底。服务由插件行构造并持有，写入 boot 契约共享的 `PluginServices`。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `src/svc/archive/src/plugin.ts` | 插件行：构造 `ArchiveService`，写回 `services.archiveSession/idleReset`，注册 `ctx.archive` |
| `src/svc/archive/src/index.ts` | `ArchiveService` 全部逻辑：超阈值检测、整理 run编排、归档重建、空闲/超时降级、批量归档、摘要生成 |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| `src/svc/archive/src/plugin.ts` | `agentchat-archive-service` | `['bootstrap']` | `ctx.archive = ArchiveHostService`（`.manager = ArchiveService`）；`core.services.archiveSession`（runEnd 入口）与 `core.services.idleReset`（空闲计时重置）；dispose 回调 `archiveService.dispose()` |

## 提供的能力

| 位置 | 符号 | 说明 |
| --- | --- | --- |
| `ctx.archive.manager` | `ArchiveService` | 归档编排管理器 |
| `core.services.archiveSession` | `(runCtx, result) => handleRunEnd()` | runEnd 钩子统一入口（L5 装配 `save-session` 等钩子顺序时读取） |
| `core.services.idleReset` | `(dialogId, selfId) => resetIdleTimer()` | 空闲计时重置；群聊/无对端时静默跳过 |

`ArchiveService` 核心 API：

| 方法 | 语义 |
| --- | --- |
| `handleRunEnd(ctx, result)` | 整理 run（`meta['archive-review']`）→ `completeArchiveReview`；否则按 `estimateMessagesTokens(ctx.history)+result.messages` 与阈值比较，超阈值 → `requestArchive` |
| `requestArchive(agent, counterpart)` | 幂等写 `.archive_pending`；参与者 = 虚拟对端 ? `[agent]` : `[agent, counterpart].sort()`；延迟 300ms 触发双方整理 run |
| `triggerReview(agent, counterpart, who)` | `void router.trigger(who, { hint, source:'archive-review', target:other, meta:{'archive-review':true} })`（fire-and-forget）；meta 为 run 级选项 → 会话繁忙时默认 `next-run`（后台等待空闲后新开 run）；无 router 才降级写 done |
| `completeArchiveReview(ctx, failed)` | 写 `.archive_done_<id>`；全部参与者 done 后执行 `archiveAndRebuild`（有 ctx）或 `idleArchive`（降级），随后清理 pending/done 标记并 `emit('archive.completed')` |
| `archiveAndRebuild(agent, counterpart, ctx)` | 计算归档编号；按上次归档最后一条消息去重；截断尾部保留 `≤ maxContextTokens × keepRecentRatio`；归档区间写 `archive/history_<N>.jsonl`；必要时系统自动生成 `SUMMARY.md`；重建 `messages.jsonl` |
| `idleArchive(agent, counterpart, reason)` | 降级路径：`messages.jsonl` 整体 rename 为 `history_<N>.jsonl`，再从原消息尾部重建近期 `messages.jsonl` |
| `resetIdleTimer(agent, counterpart)` | 每个会话对一个 `setTimeout`（`idleArchiveSec` 秒）触发 `idleArchive` |
| `scanPendingArchives()` | 扫描 `sessions/chat~*/.archive_pending`：超时（10 分钟）→ 强制 `idleArchive`；未超时跳过；顺带清理孤儿 `.archive_done_*` |
| `startArchiveTimeoutWatcher()` | 启动立即扫描一次 + 每 5 分钟 `setInterval`；`stopArchiveTimeoutWatcher()` 停止 |
| `archiveAllActiveSessions()` | 批量归档：遍历 `sessions/chat~*`，跳过不存在/空文件/自对话/群聊/已有 pending/未达阈值，对达标会话调 `requestArchive`，返回 `ArchiveBatchItem[]` |
| `dispose()` | 停止 watcher + 清理全部空闲定时器 |

## 关键契约 / API

```ts
// 路径约定
<ws>/sessions/chat~<lo>~<hi>/messages.jsonl
<ws>/sessions/chat~<lo>~<hi>/archive/history_<N>.jsonl + SUMMARY.md
<ws>/sessions/chat~<lo>~<hi>/.archive_pending | .archive_done_<agentId>

// 服务构造
new ArchiveService({ wsRoot?, agentsDir?, router?, registry? })
// router 最小接口
interface ArchiveRouterLike {
  trigger(agentId, options?, signal?): Promise<string>;
  emit?(event, data): void;
}
// 批量归档返回项
interface ArchiveBatchItem { agent: string; counterpart: string; skipped: boolean; reason?: string }
```

常量：`ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000`；`REVIEW_TRIGGER_DELAY_MS = 300`；`ARCHIVE_REVIEW_PREFIX = '[归档整理]'`。

## 配置
读取 Agent 配置命名空间 `agent.session`（`NS_AGENT_SESSION`），默认值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `maxContextTokens` | `1000000` | 会话上下文 token 阈值 |
| `archiveTokenRatio` | `0.5` | 触发归档的阈值比例（阈值 = maxContextTokens × ratio） |
| `keepRecentRatio` | `0.03` | 重建后保留的近期消息 token 水位 |
| `summaryPreviewLen` | `4000` | SUMMARY.md 注入/生成字数上限 |
| `idleArchiveSec` | `14400` | 空闲归档秒数（4 小时） |

整理 run hint 中的记忆预算读 `agent.memory.memoryBudgetTokens`，缺省 `10000`。

## 与其他插件的关系
- 依赖：`@agentchat/agent-loop`、`@agentchat/agents`、`@agentchat/cordis`、`@agentchat/llm`、`@agentchat/protocol`、`@agentchat/util`、`@agentchat/toolkit`、`@agentchat/agent-session`、`@agentchat/agent-config`。
- 使用方：`@agentchat/boot`（finalize 启动 watcher）、`@agentchat/server`（service-plugin inject `archive`，`HistoryService` 经回调转发 `requestArchive`）、`@agentchat/timer`（service-plugin inject `archive`，`__archive_all__` 调 `archiveAllActiveSessions`）。
- 方向约束：只依赖 boot 契约结构，不 import `@agentchat/boot`。

## 测试
package.json 的 test 脚本为 `vitest run`。测试文件：`tests/archive.test.ts`。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
