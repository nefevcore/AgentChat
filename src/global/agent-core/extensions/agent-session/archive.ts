// ============================================================
// agent-session archive —— 归档与重建
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, LLMRequestMessage } from '@core/types';
import { getAppState } from '@core/app-state';
import { getGlobalConfig } from '@core/config';
import { resolveMessagePath, resolveArchiveDir } from './paths';
import { cfg } from './meta';
import { appendJSONL, truncateMessagesByTokenBudget, safeSplitIdx } from './history';
import { generateSummary } from './summary';
import { markMemoryReviewNeeded } from '../agent-memory/memory';
import { logger } from '../../../../utils/logger';
import { PersistedMessage } from './types';

// ============================================================
// 归档编排（v0.4.x 归档重构）—— 先整理后归档
//
// 背景（2026-08-01 二次设计）：阈值归档不应"先归档后让 Agent 检索"，
// 而应"先让 Agent 在完整上下文里整理，再归档"。因为：
//   · 单边（user ↔ agent）：归档发生在接收方 postHook，发送方上下文已释放；
//   · 双边（agent ↔ agent）：归档是物理单次操作，但双方都需要基于完整
//     上下文整理记忆——共享 messages.jsonl 使得双方整理轮 preHook 都能
//     读到完整文件（尚未归档），天然解决"发送方无法自然分析"的问题。
//
// 流程：
//   1. postHook 检测超阈值 → requestArchive()：写 .archive_pending（含参与者），
//      trigger 双方整理轮（archiveReview=true，target=对方 → sender=对方 →
//      preHook loadHistory 读到正确会话文件）
//   2. 整理轮：preHook 正常加载完整历史；ReAct 整理 memory/TODO/note；
//      postHook 不落盘，只写 .archive_done_<id>（completeArchiveReview），
//      检查所有参与方完成 → 执行 archiveAndRebuild + 清理标记
//   3. 降级：整理轮失败/触发失败也写 done（记忆由 .memory_review_needed 兜底）；
//      全局定时器扫描 .archive_pending 超时（10 分钟）→ 强制 idleArchive
//
// 标记语义（系统管理，Agent 不再碰）：
//   .archive_pending       待归档（含参与者 + 时间戳）
//   .archive_done_<agentId> 该侧整理完成
// ============================================================

/** 归档整理轮 hint 前缀（前端据此显示"正在归档"提示） */
export const ARCHIVE_REVIEW_PREFIX = '[归档整理]';

/** 归档超时降级阈值（毫秒） */
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Message（内存/持久化）→ PersistedMessage 的 role 转换。
 *
 * 2026-08-02 重构：trigger/agent 为一等角色，此处角色判定一律依据 role 字段，
 * 不再嗅探正文 <trigger> 子串 —— 否则正文讨论/引用 "<trigger>" 的 agent 回复
 * 会被误存成 trigger。
 */
export function toPersistedRole(msg: LLMRequestMessage): PersistedMessage['role'] {
  // 2026-08-02：trigger/agent 为一等角色（持久化格式），直接映射（不做正文内容嗅探）
  if (msg.role === 'trigger') return 'trigger';
  if (msg.role === 'agent') return 'agent';
  if (msg.role === 'tool' || msg.role === 'error') return msg.role;
  // user → agent（入站提示）；assistant → agent；system → system
  if (msg.role === 'user') return 'agent';
  return msg.role === 'assistant' ? 'agent' : (msg.role as 'tool' | 'system' | 'error');
}

/** 持久化格式 tool_calls 原样透传（loadHistory/pending 均保持 OpenAI 原生格式 LLMToolCall[]） */
function persistedToolCallsOf(msg: LLMRequestMessage): PersistedMessage['tool_calls'] {
  return (msg.tool_calls as PersistedMessage['tool_calls'] | undefined);
}

function archiveDirOf(agent: string, counterpart: string): string {
  // 归档标记（.archive_pending/.archive_done_*）是会话级状态，双方共享 → canonical 排序
  // 注意：memory.md / .memory_review_needed 是方向敏感的（各自视角），不在此路径
  const [lo, hi] = [agent, counterpart].sort();
  return path.join(getGlobalConfig().sessionsDir, lo, hi);
}
function pendingMarkerPath(agent: string, counterpart: string): string {
  return path.join(archiveDirOf(agent, counterpart), '.archive_pending');
}
function doneMarkerPath(agent: string, counterpart: string, who: string): string {
  return path.join(archiveDirOf(agent, counterpart), `.archive_done_${who}`);
}

/** counterpart 是否为虚拟 Agent（user 等） */
function isVirtualCounterpart(counterpart: string): boolean {
  try {
    const registry = (getAppState() as any).registry as { isVirtual?: (id: string) => boolean } | undefined;
    return registry?.isVirtual ? registry.isVirtual(counterpart) : false;
  } catch {
    return false;
  }
}

/** 触发单个整理轮（fire-and-forget；触发失败 → 写 done 降级） */
function triggerReview(
  agent: string, counterpart: string, who: string,
): void {
  try {
    const router = (getAppState() as any).router as
      | { trigger: (id: string, opts: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    if (!router?.trigger) {
      // 无 router（如热加载边界）→ 直接降级：写 done，不阻塞归档
      completeArchiveReview(agent, counterpart, undefined, true);
      return;
    }

    const other = who === agent ? counterpart : agent;
    const hint =
      `${ARCHIVE_REVIEW_PREFIX} 你与 "${other}" 的会话达到归档阈值，请在归档前完成两件事：\n` +
      `1. 【生成会话总结】把本段对话的关键决策、重要结论、待办事项总结为自然语言，` +
      `追加写入归档目录的 SUMMARY.md（路径：${resolveArchiveDir(agent, counterpart)}/SUMMARY.md，` +
      `用 write/read 读写，保留已有内容，在文末追加新段落）。` +
      `2. 【整理记忆】把重要信息更新到 memory.md / TODO.md / note/ 知识库。\n` +
      `整理完成后系统会自动归档，无需管理标记。`;

    setTimeout(() => {
      router.trigger(who, {
        hint,
        source: 'archive-review',
        target: other, // sender=对端 → preHook loadHistory 读到正确会话文件
        archiveReview: true,
        // 2026-08-03：归档整理轮不设轮次上限（maxTurns 不传 = 无限制）。
        // 此前硬编码 12 导致复杂整理被截断（neko 21:17 归档整理到第 12 轮被强制终止）。
      }).catch(() => {
        // 触发失败 → 写 done 降级（该侧记忆由每日审查兜底）
        completeArchiveReview(agent, counterpart, undefined, true);
      });
    }, 300);
  } catch {
    completeArchiveReview(agent, counterpart, undefined, true);
  }
}

/**
 * 请求归档：写 .archive_pending + 触发双方整理轮。
 * postHook 检测超阈值时调用。幂等（pending 已存在则不重复触发）。
 */
export function requestArchive(agent: string, counterpart: string): void {
  const pendingPath = pendingMarkerPath(agent, counterpart);
  if (fs.existsSync(pendingPath)) return; // 已有待归档流程，不重复触发

  const isVirtual = isVirtualCounterpart(counterpart);
  const participants = isVirtual ? [agent] : [agent, counterpart].sort();

  const dir = archiveDirOf(agent, counterpart);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pendingPath, JSON.stringify({
    agent, counterpart, participants, requestedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  logger.info(`[agent-session] 归档请求：${agent}/${counterpart} 参与者 ${participants.join(', ')}`);

  // 触发双方整理轮
  triggerReview(agent, counterpart, agent);
  if (!isVirtual) triggerReview(agent, counterpart, counterpart);
}

/**
 * 整理轮完成：写 .archive_done_<id>，若所有参与方完成 → 归档。
 * 由整理轮 postHook 调用。failed=true 表示本侧整理失败（仍写 done，记忆由标记兜底）。
 */
export async function completeArchiveReview(
  agent: string, counterpart: string, ctx?: AgentContext, failed = false,
): Promise<void> {
  const dir = archiveDirOf(agent, counterpart);
  const pendingPath = pendingMarkerPath(agent, counterpart);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(doneMarkerPath(agent, counterpart, agent), '', 'utf-8');
    if (failed) {
      markMemoryReviewNeeded(agent, counterpart); // 本侧整理失败 → 每日审查兜底
      logger.warn(`[agent-session] ${agent} 归档整理失败/跳过，已写 done + 审查标记`);
    }

    if (!fs.existsSync(pendingPath)) return;
    let pending: { participants?: string[] };
    try {
      pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    } catch {
      return;
    }
    const participants: string[] = pending.participants || [agent];
    const allDone = participants.every(p => fs.existsSync(doneMarkerPath(agent, counterpart, p)));
    if (!allDone) {
      logger.info(`[agent-session] 归档整理 ${participants.filter(p => fs.existsSync(doneMarkerPath(agent, counterpart, p))).join(',')} 已完成，等待全部`);
      return;
    }

    // 全部完成 → 归档
    logger.info(`[agent-session] 归档整理全部完成，执行归档 ${agent}/${counterpart}`);
    try {
      if (ctx) {
        await archiveAndRebuild(agent, counterpart, ctx);
      } else {
        // 无 ctx（降级路径）→ 用 idleArchive 强制归档
        const { idleArchive } = await import('./idle-timer.js');
        idleArchive(agent, counterpart, 'review-fallback');
      }
    } finally {
      // 归档执行后无论成败都必须清理标记，否则残留 .archive_pending 会让
      // 超时监视器误判"归档整理超时"并再次强制归档（8/4 晚 bug：残留 pending
      // 导致 20:47 把 20:44 的最近对话也归档掉）。归档异常已在内部 log。
      try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
      for (const p of participants) {
        try { fs.unlinkSync(doneMarkerPath(agent, counterpart, p)); } catch { /* ignore */ }
      }
    }

    // 通知 WebUI 归档完成（前端刷新消息列表）
    notifyArchiveCompleted(agent, counterpart);
  } catch (err: any) {
    logger.error(`[agent-session] 归档整理完成处理失败: ${err.message}`);
  }
}

/**
 * 归档完成通知：router.emit('archive.completed') 供 WebUI 广播 session.archived。
 * 归档（整理轮完成触发）后调用，让前端刷新消息列表。
 */
export function notifyArchiveCompleted(agent: string, counterpart: string): void {
  try {
    const state = getAppState();
    const router = (state as any).router as { emit?: (ev: string, data: unknown) => void } | undefined;
    router?.emit?.('archive.completed', { agent, counterpart });
  } catch { /* AppState 未就绪时静默跳过 */ }
}

/**
 * 扫描所有 .archive_pending，处理超时/残留归档请求。
 * 返回处理数（日志/调试用）。
 *
 * 规则：
 *  - 超时（> ARCHIVE_TIMEOUT_MS）→ 强制归档（reason='pending-timeout'）并清理
 *  - 未超时（重启前刚写入、整理轮上下文已丢失）→ 清理 pending + 写审查标记，
 *    不强制归档（避免误归档刚请求时的"新"对话；下次 postHook 超阈值会重新请求）
 */
export async function scanPendingArchives(): Promise<number> {
  let handled = 0;
  try {
    const sessionsDir = getGlobalConfig().sessionsDir;
    if (!fs.existsSync(sessionsDir)) return 0;
    const now = Date.now();
    for (const agentDir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue;
      const agentPath = path.join(sessionsDir, agentDir.name);
      for (const cpDir of fs.readdirSync(agentPath, { withFileTypes: true })) {
        if (!cpDir.isDirectory()) continue;
        const pendingPath = path.join(agentPath, cpDir.name, '.archive_pending');
        if (!fs.existsSync(pendingPath)) continue;
        try {
          const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
          const requestedAt = new Date(pending.requestedAt || 0).getTime();
          if (now - requestedAt > ARCHIVE_TIMEOUT_MS) {
            logger.warn(`[agent-session] 归档整理超时，强制归档 ${agentDir.name}/${cpDir.name}`);
            try {
              const { idleArchive } = await import('./idle-timer.js');
              idleArchive(agentDir.name, cpDir.name, 'pending-timeout');
            } catch { /* 强制归档失败静默（下次扫描重试） */ }
          } else {
            // 未超时残留：整理轮上下文已丢失（重启打断），直接清理 + 审查标记
            markMemoryReviewNeeded(agentDir.name, cpDir.name);
            logger.warn(`[agent-session] 清理残留归档请求 ${agentDir.name}/${cpDir.name}（整理轮已中断），写审查标记兜底`);
          }
          try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
          handled++;
        } catch { /* skip */ }
      }
    }
  } catch { /* 扫描失败静默 */ }
  return handled;
}

/**
 * 全局超时降级：扫描所有 .archive_pending，超时 → 强制归档。
 * 模块加载时启动：立即扫描一次（清理重启残留），此后每 5 分钟。
 */
function startArchiveTimeoutWatcher(): void {
  void scanPendingArchives(); // 启动立即清理残留（防止重启打断整理轮后的 pending 锁死）
  const interval = 5 * 60 * 1000;
  setInterval(() => {
    void scanPendingArchives();
  }, interval);
}

// 启动超时降级监视（模块加载时一次）
startArchiveTimeoutWatcher();

// ============================================================
// 全局批量归档（2026-08-04 新增）
//
// 背景：缓存定价下跨天首轮未命中历史按高价计费。23:30 定时批量归档
// 所有活跃 1:1 会话 → 跨天首轮历史恒为重建后的小文件（未命中成本固定低），
// 且归档在深夜空闲时段不打断白天对话。
//
// 由 timer-manager 的 __archive_all__ 特殊 hint 触发（不走 LLM，纯机制）。
// 每个会话走 requestArchive → 先整理后归档（双方整理轮 + notifyMemoryReview
// 自动触发记忆审查），无需 Agent 手动干预。
// ============================================================

/**
 * 批量归档所有活跃 1:1 会话。
 *
 * 扫描 sessions/<agent>/<counterpart>/messages.jsonl：
 *  - 跳过不存在的 / 空的 / 已存在 .archive_pending 的（幂等）
 *  - 跳过自对话（agent === counterpart，B1 不写活跃消息）
 *  - 跳过群聊参与目录（group__*，群聊独立归档机制）
 *
 * 返回处理清单（供日志/调试）。
 */
export function archiveAllActiveSessions(): Array<{ agent: string; counterpart: string; skipped: boolean; reason?: string }> {
  const sessionsDir = getGlobalConfig().sessionsDir;
  const result: Array<{ agent: string; counterpart: string; skipped: boolean; reason?: string }> = [];
  if (!fs.existsSync(sessionsDir)) {
    logger.info('[agent-session] 批量归档：sessions 目录不存在，跳过');
    return result;
  }

  let archived = 0;
  for (const agentDir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!agentDir.isDirectory()) continue;
    if (agentDir.name.startsWith('group__')) continue; // 群聊共享目录（另有归档机制）
    const agentPath = path.join(sessionsDir, agentDir.name);

    for (const cpDir of fs.readdirSync(agentPath, { withFileTypes: true })) {
      if (!cpDir.isDirectory()) continue;

      const counterpart = cpDir.name;
      // 跳过群聊参与目录、归档子目录、异常目录
      if (counterpart.startsWith('group__')) continue;
      if (counterpart === 'archive') continue;
      if (counterpart === agentDir.name) continue; // 自对话（不写活跃消息）

      const msgPath = path.join(agentPath, cpDir.name, 'messages.jsonl');
      if (!fs.existsSync(msgPath)) continue;

      let size = 0;
      try { size = fs.statSync(msgPath).size; } catch { continue; }
      if (size <= 0) continue; // 空会话不归档

      // 幂等：已有 pending（含进行中）则跳过
      if (fs.existsSync(path.join(agentPath, cpDir.name, '.archive_pending'))) {
        result.push({ agent: agentDir.name, counterpart, skipped: true, reason: 'pending' });
        continue;
      }

      requestArchive(agentDir.name, counterpart);
      archived++;
      result.push({ agent: agentDir.name, counterpart, skipped: false });
    }
  }

  logger.info(`[agent-session] 批量归档完成：处理 ${result.length} 个会话，触发归档 ${archived} 个`);
  return result;
}

// ============================================================
// 归档后即时记忆整理触发
//
// 背景（2026-08-01 修复）：归档只写 .memory_review_needed 标记，
// 依赖 Agent 每日定时审查消费。但归档可能发生在任意时刻，
// 定时审查（如 03:00）可能 14+ 小时后才跑，期间 Agent 对归档
// 内容"失忆"（如不记得曾有 clean-sessions.py 脚本）。
//
// 修复：归档完成后立即 trigger Agent 一次，让它马上检索归档
// 内容并更新 memory.md / TODO / note，不等定时任务。
// ============================================================

/**
 * 归档后立即触发 Agent 记忆整理（异步，不阻塞归档流程）。
 * @param agent          归档所属 Agent（receiver）
 * @param counterpart    会话对端
 * @param archivedCount  本次归档消息数（用于 hint 提示规模）
 */
export function notifyMemoryReview(agent: string, counterpart: string, archivedCount: number): void {
  if (archivedCount <= 0) return;
  try {
    const state = getAppState();
    const router = (state as any).router as
      | { trigger: (id: string, opts: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    if (!router?.trigger) return;

    const hint =
      `[记忆审查] 你与 "${counterpart}" 的会话刚归档了 ${archivedCount} 条早期消息（已存入 archive/）。` +
      `请立即用 query_history 检索归档内容，把重要信息整理进 memory.md / TODO.md / note/ 知识库，` +
      `完成后用 bash 删除审查标记（rm .memory_review_needed）。`;

    // 延迟 800ms 触发，确保归档文件写完后再启动整理轮
    setTimeout(() => {
      router.trigger(agent, {
        hint,
        source: 'archive-review',
        target: agent, // 自对话整理，不污染与用户的会话
        // 2026-08-03：归档后记忆整理不设轮次上限（maxTurns 不传 = 无限制）
      }).catch((err: Error) => {
        logger.warn(`[agent-session] 归档后记忆整理触发失败: ${err.message}`);
      });
    }, 800);
  } catch {
    /* AppState 未就绪时静默跳过（归档本身不受影响） */
  }
}

// ============================================================
// 本轮消息暂存区
//
// 用于在 preHook → postHook 之间传递本轮新产生的消息。
// 归档时 (archiveAndRebuild) 也会读取此数组以追加本轮消息。
//
// 使用 WeakMap<AgentContext, PersistedMessage[]> 替代模块级变量：
// 每个 Agent.run() 调用持有独立的 AgentContext 引用，WeakMap 以
// 此为键自然隔离不同会话的暂存消息。AgentContext 回收时自动清理。
// ============================================================

/** 按 AgentContext 隔离的本轮暂存消息 */
const sessionPendingMessages = new WeakMap<AgentContext, PersistedMessage[]>();

/** 获取当前会话的暂存消息数组（不存在则自动创建） */
export function getPendingMessages(ctx: AgentContext): PersistedMessage[] {
  let msgs = sessionPendingMessages.get(ctx);
  if (!msgs) {
    msgs = [];
    sessionPendingMessages.set(ctx, msgs);
  }
  return msgs;
}

/** 清理本轮缓存 */
export function clearPendingMessages(ctx: AgentContext): void {
  sessionPendingMessages.delete(ctx);
}

// ============================================================
// 归档与重建
//
// 由 postHook 在 token 超阈值时调用。流程：
//   1. 读取上一次归档的最后一条消息，检测重叠
//   2. 将 messages.jsonl 中未被上次归档覆盖的部分写入 archive/history_<N>.jsonl
//   3. 从尾部保留近期消息至安全水位（≤ 80% maxContextTokens），
//      重建 messages.jsonl，保证下一轮会话加载时无需立即压缩
//
// 二次归档去重：
//   truncateTail 每次保留尾部消息，导致相邻归档文件之间有重叠。
//   为避免 WebUI 回溯时出现重复消息，二次及后续归档时会读取上一次
//   归档的最后一条消息作为分界点，仅将新消息写入本次归档文件。
//
// 设计意图：
//   归档负责"物理保障"（重建文件 ≤ 安全水位），
//   preHook 压缩仅在异常长单轮消息时作为兜底触发。
//   两者互不依赖，各司其职。
// ============================================================

/**
 * 读取归档文件最后一条消息，用于二次归档去重。
 * 从文件末尾读取最多 8KB，解析最后一行完整 JSON。
 */
function readLastArchiveMessage(archiveDir: string, archiveIndex: number): PersistedMessage | null {
  const archivePath = path.join(archiveDir, `history_${archiveIndex}.jsonl`);
  if (!fs.existsSync(archivePath)) return null;

  const stats = fs.statSync(archivePath);
  if (stats.size === 0) return null;

  const readSize = Math.min(stats.size, 8192);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(archivePath, 'r');
  fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
  fs.closeSync(fd);

  const tail = buffer.toString('utf-8');
  const lines = tail.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * 在 allMessages 中查找与 target 匹配的消息索引。
 * 匹配策略：优先 message_id（唯一可靠），fallback role + content（兼容无 id 的旧消息）。
 * @returns 匹配的索引，未找到返回 -1
 */
function findMessageIndex(messages: LLMRequestMessage[], target: PersistedMessage): number {
  // 优先按 message_id 精确匹配（content 为空的工具轮次消息大量相同，role+content 会错位）
  if (target.message_id) {
    const byId = messages.findIndex((m) => m.message_id && m.message_id === target.message_id);
    if (byId >= 0) return byId;
  }
  const targetContent = target.content ?? '';
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === target.role && messages[i].content === targetContent) {
      return i;
    }
  }
  return -1;
}

export async function archiveAndRebuild(
  agent: string,
  counterpart: string,
  ctx: AgentContext,
): Promise<void> {
  const msgPath = resolveMessagePath(agent, counterpart);
  const archiveDir = resolveArchiveDir(agent, counterpart);

  if (!fs.existsSync(msgPath)) return;

  // 1. 计算归档编号（已有归档文件数 + 1）
  let archiveCount = 0;
  if (fs.existsSync(archiveDir)) {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
    archiveCount = files.length;
  } else {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // 2. 读取上次归档的最后一条消息，用于二次归档去重
  let lastArchivedMsg: PersistedMessage | null = null;
  if (archiveCount > 0) {
    lastArchivedMsg = readLastArchiveMessage(archiveDir, archiveCount);
  }

  // 3. 收集待重建的全部消息（压缩后历史 + 本轮缓存）
  //    均为持久化格式（role=agent/tool/trigger/error/system），保持原样
  const pendingAsMessages: LLMRequestMessage[] = getPendingMessages(ctx).map((p) => ({
    role: p.role,
    content: p.content ?? '',
    tool_calls: p.tool_calls,   // 保持 OpenAI 原生格式
    agent_id: p.agent_id,
    name: p.name,
    tool_call_id: p.tool_call_id,
    reasoning_content: p.reasoning_content,
    label: p.label,
    message_id: p.message_id,
    // 保留原始时间戳，归档时不再批量重写
    timestamp: p.timestamp,
  }));
  let allMessages: LLMRequestMessage[] = [...ctx.history, ...pendingAsMessages];

  // 4. 二次归档去重：移除上次归档已覆盖的消息
  //    ctx.history 即当前 messages.jsonl 的全部内容；
  //    通过匹配上次归档的最后一条消息，定位重叠分界点。
  let dedupCutoff = 0;
  if (lastArchivedMsg) {
    const matchIdx = findMessageIndex(ctx.history, lastArchivedMsg);
    if (matchIdx >= 0) {
      dedupCutoff = matchIdx + 1; // 跳过该消息及之前所有（已被上次归档覆盖）
    }
  }

  // 5. 先计算截断点，保证归档与 messages.jsonl 不重叠
  const maxTokens = cfg(ctx.runtimeConfig).maxContextTokens;
  const keepRecentRatio = cfg(ctx.runtimeConfig).keepRecentRatio;
  const safeTarget = Math.ceil(maxTokens * keepRecentRatio);
  const truncated = truncateTail(allMessages, safeTarget);
  const truncStart = allMessages.length - truncated.length;

  // 5a. 归档区间: [dedupCutoff, truncStart) —— 即被截掉且未被上次归档覆盖的消息
  const archiveMessages = allMessages.slice(dedupCutoff, Math.max(dedupCutoff, truncStart));
  const archivePath = path.join(archiveDir, `history_${archiveCount + 1}.jsonl`);

  if (archiveMessages.length > 0) {
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    for (const msg of archiveMessages) {
      const p: PersistedMessage = {
        // 关键：tool/error 结果保持原角色（见 toPersistedRole），
        // 防止内容含 <trigger> 的 tool 结果被误改写为 trigger
        role: toPersistedRole(msg),
        content: msg.content,
        message_id: msg.message_id,
        agent_id: msg.agent_id,
        name: msg.name,
        tool_calls: persistedToolCallsOf(msg),
        tool_call_id: msg.tool_call_id,
        reasoning_content: msg.reasoning_content,
        label: msg.label,
        // 保留原始时间戳（不再批量改写为归档时刻）
        timestamp: msg.timestamp ?? new Date().toISOString(),
      };
      fs.appendFileSync(archivePath, JSON.stringify(p) + '\n', 'utf-8');
    }
  }

  if (archiveMessages.length > 0) {
    logger.info(
      dedupCutoff > 0
        ? `[agent-session] 二次归档去重：跳过前 ${dedupCutoff} 条，归档 ${archiveMessages.length} 条 (${truncStart - dedupCutoff} 区间) → ${archivePath}`
        : `[agent-session] 已归档：${archiveMessages.length} 条 (保留 ${truncated.length} 条近期) → ${archivePath}`
    );
  }

  // 5b. 归档摘要写入 SUMMARY.md（跨会话注入用，防止归档后会话割裂）
  //  归档的早期消息被截断，若不做摘要持久化，下次会话 Agent 将丢失关键决策/待办上下文。
  //  v0.4.6：优先由 Agent 在归档整理轮亲自写入（基于完整上下文更准确）；
  //  系统自动生成降级为兜底——仅当 SUMMARY.md 不存在或未被 Agent 本次更新（mtime 早于归档请求）时触发。
  if (archiveMessages.length > 0 && ctx.llm) {
    try {
      const summaryPath = path.join(archiveDir, 'SUMMARY.md');
      const dateStr = new Date().toISOString().slice(0, 10);
      const header = `## 归档 ${dateStr}（history_${archiveCount + 1}，${archiveMessages.length} 条）\n\n`;

      // 判断 Agent 是否已在整理轮写入本次归档的总结：SUMMARY.md mtime > 归档请求时间
      let agentWrote = false;
      try {
        const pendingPath = pendingMarkerPath(agent, counterpart);
        if (fs.existsSync(summaryPath) && fs.existsSync(pendingPath)) {
          const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
          const requestedAt = new Date(pending.requestedAt || 0).getTime();
          if (requestedAt > 0 && fs.statSync(summaryPath).mtimeMs > requestedAt) {
            agentWrote = true;
          }
        }
      } catch { /* 判断失败则走自动生成兜底 */ }

      if (agentWrote) {
        logger.info(`[agent-session] SUMMARY.md 已由 Agent 在整理轮写入，跳过系统自动生成`);
      } else {
        const summaryText = await generateSummary(
          ctx.llm,
          archiveMessages,
          counterpart,
          agent,
          cfg(ctx.runtimeConfig).summaryPreviewLen,
        );
        if (summaryText && !summaryText.startsWith('(摘要生成失败')) {
          fs.appendFileSync(summaryPath, header + summaryText + '\n\n', 'utf-8');
          logger.info(`[agent-session] 归档摘要已写入 ${summaryPath}（系统自动生成兜底）`);
        }
      }
    } catch (err: any) {
      logger.warn(`[agent-session] 归档摘要处理失败: ${err?.message ?? String(err)}`);
    }
  }

  // 删除原 messages.jsonl
  if (fs.existsSync(msgPath)) fs.unlinkSync(msgPath);

  // 6. 写入重建后的 messages.jsonl（仅保留尾部近期消息）
  for (const msg of truncated) {
    const p: PersistedMessage = {
      // 同上：tool/error 结果保持原角色（见 toPersistedRole）
      role: toPersistedRole(msg),
      content: msg.content,
      message_id: msg.message_id,
      agent_id: msg.agent_id,
      name: msg.name,
      tool_calls: persistedToolCallsOf(msg),
      tool_call_id: msg.tool_call_id,
      reasoning_content: msg.reasoning_content,
      label: msg.label,
      // 保留原始时间戳（不再批量改写为归档时刻）
      timestamp: msg.timestamp ?? new Date().toISOString(),
    };
    appendJSONL(agent, counterpart, p);
  }

  const truncatedCount = allMessages.length - truncated.length;
  if (truncatedCount > 0) {
    logger.info(
      `[agent-session] 归档重建截断 ${truncatedCount} 条早期消息，` +
      `保留 ${truncated.length} 条 (≤ ${safeTarget} tokens / ${maxTokens} 阈值)`
    );
  }

  // 8. 写入记忆审查标记，由 Agent 定时 trigger 消费
  markMemoryReviewNeeded(agent, counterpart);

  // 8a. 归档后即时触发 Agent 记忆整理（不等定时审查）
  notifyMemoryReview(agent, counterpart, archiveMessages.length);
}

/**
 * 从尾部保留消息至指定 token 预算，丢弃早期消息。
 * 保证不切割 tool-call ↔ tool-response 对。
 *
 * @returns 截断后的尾部消息数组
 */
/**
 * 截断到 token 预算（保留尾部近期），不拆分 tool-call/response 对。
 * 支持持久化格式（role=agent 等），安全分割点由 safeSplitIdx 结构判定（无需视角）。
 */
export function truncateTail(
  messages: LLMRequestMessage[],
  tokenBudget: number,
): LLMRequestMessage[] {
  const truncated = truncateMessagesByTokenBudget(messages, tokenBudget);
  const splitIdx = safeSplitIdx(messages, messages.length - truncated.length);
  return messages.slice(Math.max(0, splitIdx));
}
