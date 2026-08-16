// ============================================================
// src/services/archive-service.ts —— 归档编排服务（L4 门面）
//
// 迁移自旧 agent-session/archive.ts + idle-timer.ts（"先整理后归档"方案）：
//   1. runEnd 超阈值检测 → requestArchive：写 .archive_pending（含参与者）+ 触发双方整理 run
//   2. 整理 run（meta['archive-review']=true，target=对方 → sender=对方 → loadHistory 读到正确会话文件）：
//      runEnd 不落盘（save-session 跳过），仅写 .archive_done_<id>（completeArchiveReview），
//      检查所有参与者完成 → 执行 archiveAndRebuild + 清理标记
//   3. 降级：整理 run 失败/触发失败也写 done；全局定时器扫描 .archive_pending
//      超时（10 分钟）→ 强制 idleArchive
//
// 记忆整理：整理 run hint 已要求一并整理记忆（写 SUMMARY.md + 更新 memory.md）。
//   不再维护 .memory_review_needed 审查标记（2026-08-08 移除）——失忆就失忆，
//   Agent 可在会话中用 query_history 重新回忆。
//
// 路径适配（新架构平铺 dialogId）：
//   · 会话文件：<ws>/sessions/chat~<lo>~<hi>/messages.jsonl
//   · 归档目录：<ws>/sessions/chat~<lo>~<hi>/archive/（history_<N>.jsonl + SUMMARY.md）
//   · 标记：    <ws>/sessions/chat~<lo>~<hi>/.archive_pending / .archive_done_<id>
//
// 依赖方向：services → plugins（paths/memory/session/tools）+ agents（router/registry/paths）。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { CurrentContext, RunResult } from '@agentchat/agent-loop';
import type { LLMProvider } from '@agentchat/llm';
import type { LLMRequestMessage, MessageSource } from '@agentchat/types';
import { createLogger } from '@agentchat/util';
import { getNamespaceConfig } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';
import type { AgentRegistry } from '@agentchat/agents';
import { chatDialogKey, counterpartOfDialog, isGroupDialog } from '@agentchat/agents';
import { NS_AGENT_SESSION, META_ARCHIVE_REVIEW } from '@agentchat/toolkit';
import { estimateTokens } from '@agentchat/toolkit';
import { toPersistedRole, stableMessageIdOf } from '@agentchat/agent-session';
import type { PersistedMessage } from '@agentchat/protocol';

const log = createLogger('[services:archive]');

/** 归档整理 run hint 前缀（前端据此显示"正在归档…"提示） */
export const ARCHIVE_REVIEW_PREFIX = '[归档整理]';

/** 归档超时降级阈值（毫秒） */
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

/** 整理 run 触发延迟（毫秒；确保触发轮 runEnd 已落盘） */
const REVIEW_TRIGGER_DELAY_MS = 300;

/** 会话配置默认值（对齐旧 meta.ts） */
interface SessionCfg {
  maxContextTokens: number;
  archiveTokenRatio: number;
  keepRecentRatio: number;
  summaryPreviewLen: number;
  idleArchiveSec: number;
}

const DEFAULT_SESSION_CFG: SessionCfg = {
  maxContextTokens: 1000000,
  archiveTokenRatio: 0.5,
  keepRecentRatio: 0.03,
  summaryPreviewLen: 4000,
  idleArchiveSec: 14400,
};

/** 触发整理 run所需的 router 最小接口（避免对 L2 强耦合） */
export interface ArchiveRouterLike {
  trigger(agentId: string, options?: {
    maxSteps?: number;
    deepThink?: boolean;
    source?: string;
    sourceMeta?: MessageSource;
    hint?: string;
    wrapHint?: boolean;
    target?: string;
    group_id?: string;
    meta?: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<string>;
  emit?(event: string, data: unknown): void;
}

export interface ArchiveServiceOptions {
  /** 工作区根（缺省 workspaceRoot()） */
  wsRoot?: string;
  /** Agent 配置目录（agentLabel 读 name 用） */
  agentsDir?: string;
  /** 路由（触发整理 run + archive.completed 通知） */
  router?: ArchiveRouterLike;
  /** Agent 注册表（isVirtual 判断 + per-Agent session 配置） */
  registry?: AgentRegistry;
}

/** 批量归档返回项 */
export interface ArchiveBatchItem {
  agent: string;
  counterpart: string;
  skipped: boolean;
  reason?: string;
}

// ============================================================
// 路径辅助（新平铺 dialogId）
// ============================================================

/** 会话目录：<ws>/sessions/chat~<lo>~<hi> */
function sessionDirOf(wsRoot: string, a: string, b: string): string {
  return path.join(wsRoot, 'sessions', chatDialogKey(a, b));
}

/** 归档目录：<ws>/sessions/chat~<lo>~<hi>/archive */
function archiveDirOf(wsRoot: string, a: string, b: string): string {
  return path.join(sessionDirOf(wsRoot, a, b), 'archive');
}

/** pending 标记路径 */
function pendingMarkerPath(wsRoot: string, a: string, b: string): string {
  return path.join(sessionDirOf(wsRoot, a, b), '.archive_pending');
}

/** done 标记路径 */
function doneMarkerPath(wsRoot: string, a: string, b: string, who: string): string {
  return path.join(sessionDirOf(wsRoot, a, b), `.archive_done_${who}`);
}

/** 会话文件路径 */
function sessionFile(wsRoot: string, a: string, b: string): string {
  return path.join(sessionDirOf(wsRoot, a, b), 'messages.jsonl');
}

// ============================================================
// 服务
// ============================================================

export class ArchiveService {
  private wsRoot: string;
  private agentsDir: string | undefined;
  private router?: ArchiveRouterLike;
  private registry?: AgentRegistry;
  /** 空闲归档定时器（会话对 → timer） */
  private idleTimers = new Map<string, NodeJS.Timeout>();
  /** 超时扫描定时器 */
  private scanTimer?: NodeJS.Timeout;

  constructor(options: ArchiveServiceOptions = {}) {
    this.wsRoot = options.wsRoot ?? path.join(process.cwd(), 'workspace', 'default');
    this.agentsDir = options.agentsDir;
    this.router = options.router;
    this.registry = options.registry;
  }

  // ============================================================
  // 会话配置（per-Agent 优先，缺省默认值）
  // ============================================================

  private sessionCfg(agentId?: string): SessionCfg {
    let cfg: Record<string, unknown> | undefined;
    if (agentId && this.registry) {
      const agent = this.registry.get(agentId);
      if (agent) cfg = getNamespaceConfig(agent, NS_AGENT_SESSION);
    }
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return {
      maxContextTokens: num(cfg?.maxContextTokens, DEFAULT_SESSION_CFG.maxContextTokens),
      archiveTokenRatio: num(cfg?.archiveTokenRatio, DEFAULT_SESSION_CFG.archiveTokenRatio),
      keepRecentRatio: num(cfg?.keepRecentRatio, DEFAULT_SESSION_CFG.keepRecentRatio),
      summaryPreviewLen: num(cfg?.summaryPreviewLen, DEFAULT_SESSION_CFG.summaryPreviewLen),
      idleArchiveSec: num(cfg?.idleArchiveSec, DEFAULT_SESSION_CFG.idleArchiveSec),
    };
  }

  // ============================================================
  // runEnd 统一入口（L5 装配 services.archiveSession 注入）
  // ============================================================

  /**
   * runEnd 钩子回调：
   *   · meta['archive-review']（整理 run）→ completeArchiveReview（写 done + 检查 → 归档）
   *   · 否则 → 超阈值检测（优先 API 实际 token，估算兜底）→ requestArchive
   */
  async handleRunEnd(ctx: CurrentContext, result: RunResult): Promise<void> {
    if (!ctx.dialogId) return;
    // 群聊：另有周归档机制（save-session 双写），不参与 1:1 编排
    if (isGroupDialog(ctx.dialogId)) return;

    const agent = ctx.agentId ?? '';
    const counterpart = counterpartOfDialog(ctx.dialogId, agent);

    // ---- 整理 run：不落盘，仅写 done + 检查归档 ----
    if (ctx.meta?.[META_ARCHIVE_REVIEW]) {
      const failed = result.messages.some((m) => m.role === 'error');
      await this.completeArchiveReview(ctx, failed);
      return;
    }

    // ---- 超阈值检测 ----
    // 触发依据 = 会话消息估算（estimatedTotal，与 UI gauge 一致），而非 usage.total_tokens：
    //   · usage.total_tokens 是完整请求的 prompt（含系统提示 AGENT.md + 工具定义等固定开销），
    //     大 AGENT.md 会让任何 run 都"超阈值"而频繁误触发归档（实测 test 系统提示 6.9 万 token）
    //   · 归档目的是管理"会话增长"——消息内容才是会话的增量，系统提示固定开销不应触发归档
    // 注意：也不用 accumulated_total_tokens（跨 step 累加的展示用量）——多步 run 轻松百万+
    const sessionCfg = this.sessionCfg(agent);
    const threshold = Math.ceil(sessionCfg.maxContextTokens * sessionCfg.archiveTokenRatio);
    const estimatedTotal = estimateMessagesTokens(ctx.history) + estimateMessagesTokens(result.messages);
    if (estimatedTotal > threshold) {
      log.info(`[archive] 超阈值触发归档 ${agent}/${counterpart}（会话消息估算 ${estimatedTotal} / 阈值 ${threshold}）`);
      this.requestArchive(agent, counterpart);
    }
  }

  // ============================================================
  // 请求归档（写 pending + 触发双方整理 run）
  // ============================================================

  /** 请求归档：写 .archive_pending + 触发双方整理 run（幂等：pending 已存在则跳过） */
  requestArchive(agent: string, counterpart: string): void {
    const pendingPath = pendingMarkerPath(this.wsRoot, agent, counterpart);
    if (fs.existsSync(pendingPath)) {
      log.info(`[archive] requestArchive 幂等跳过（pending 已存在）${agent}/${counterpart}`);
      return; // 已有待归档流程，不重复触发
    }

    const isVirtual = this.isVirtual(counterpart);
    const participants = isVirtual ? [agent] : [agent, counterpart].sort();

    const dir = sessionDirOf(this.wsRoot, agent, counterpart);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify({
      agent, counterpart, participants, requestedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');

    log.info(`[archive] 归档请求：${agent}/${counterpart} 参与者 ${participants.join(', ')}（counterpart虚拟=${isVirtual}，pending=${pendingPath}）`);

    // 触发双方整理 run（虚拟 counterpart 仅 agent 侧）
    this.triggerReview(agent, counterpart, agent);
    if (!isVirtual) this.triggerReview(agent, counterpart, counterpart);
  }

  /** counterpart 是否为虚拟 Agent（user 等） */
  private isVirtual(id: string): boolean {
    try {
      return this.registry?.isVirtual(id) ?? false;
    } catch {
      return false;
    }
  }

  /** 触发单个整理 run（fire-and-forget；trigger 内部错误由 router 记日志，不再依赖 .catch 降级） */
  private triggerReview(agent: string, counterpart: string, who: string): void {
    try {
      if (!this.router?.trigger) {
        log.warn(`[archive] triggerReview 无 router，降级 done ${agent}/${counterpart}`);
        // 无 router（如热加载边界）→ 直接降级：写 done，不阻塞归档
        void this.completeArchiveReviewByPair(agent, counterpart, undefined, true);
        return;
      }

      const other = who === agent ? counterpart : agent;
      const sessionCfg = this.sessionCfg(who);
      const memoryBudget = this.memoryBudgetTokens(who);
      const summaryPath = path.join(archiveDirOf(this.wsRoot, agent, counterpart), 'SUMMARY.md');
      const hint =
        `${ARCHIVE_REVIEW_PREFIX} 你与 "${other}" 的对话达到归档阈值，请在归档前完成两件事：\n` +
        `1. 【生成会话总结】把这段对话的关键决策、重要结论、待办事项总结为自然语言，` +
        `追加写入归档目录的 SUMMARY.md（路径：${summaryPath}，` +
        `用 write/read 读写，保留已有内容，在文末追加新段落）。\n` +
        `注意：SUMMARY.md 会整体注入后续会话上下文，累计请控制在 ${sessionCfg.summaryPreviewLen} 字以内（超出部分会被截断丢弃）。\n` +
        `2. 【整理记忆】重写 memory.md（不要只追加）：合并重复信息、压缩冗长表述、删除已过时/已被替代的记忆（如已完成的计划、失效的临时状态、重复的旧记录），只保留仍有效且重要的信息；TODO.md / DONE.md / note/ 知识库同理更新。\n` +
        `注意：memory.md 每次会话注入预算为 ${memoryBudget} tokens，整理后请控制在预算内——人设、稳定偏好、进行中事项优先保留头部，过时信息应删除而非保留（超出预算的部分会被截断丢弃）。\n` +
        `整理完成后系统会自动归档，无需管理标记。`;

      setTimeout(() => {
        log.info(`[archive] 触发整理 run ${who}（agent=${agent} counterpart=${counterpart}）`);
        void this.router!.trigger(who, {
          hint,
          source: 'archive-review',
          sourceMeta: { kind: 'archive', form: 'hint', summary: ARCHIVE_REVIEW_PREFIX },
          target: other, // sender=对端 → loadHistory 读到正确会话文件
          meta: { [META_ARCHIVE_REVIEW]: true },
          // 归档整理 run 不设步数上限（maxSteps 不传 = 不限制）
        });
      }, REVIEW_TRIGGER_DELAY_MS);
    } catch {
      void this.completeArchiveReviewByPair(agent, counterpart, undefined, true);
    }
  }

  /** 读 memory 预算（NS_AGENT_MEMORY.memoryBudgetTokens，缺省 10000） */
  private memoryBudgetTokens(agentId?: string): number {
    if (agentId && this.registry) {
      const agent = this.registry.get(agentId);
      if (agent) {
        const ns = getNamespaceConfig(agent, 'agent.memory');
        if (typeof ns.memoryBudgetTokens === 'number' && Number.isFinite(ns.memoryBudgetTokens)) {
          return ns.memoryBudgetTokens;
        }
      }
    }
    return 10000;
  }

  // ============================================================
  // 整理 run 完成（写 done + 检查全部完成 → 归档）
  // ============================================================

  /** 整理 run runEnd 完成回调（有 ctx） */
  async completeArchiveReview(ctx: CurrentContext, failed = false): Promise<void> {
    if (!ctx.dialogId) return;
    const agent = ctx.agentId ?? '';
    const counterpart = counterpartOfDialog(ctx.dialogId, agent);
    await this.completeArchiveReviewByPair(agent, counterpart, ctx, failed);
  }

  /** 整理 run 完成核心（ctx 可选：降级路径传 undefined） */
  private async completeArchiveReviewByPair(
    agent: string,
    counterpart: string,
    ctx: CurrentContext | undefined,
    failed = false,
  ): Promise<void> {
    const dir = sessionDirOf(this.wsRoot, agent, counterpart);
    const pendingPath = pendingMarkerPath(this.wsRoot, agent, counterpart);

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(doneMarkerPath(this.wsRoot, agent, counterpart, agent), '', 'utf-8');
      if (failed) {
        log.warn(`[archive] ${agent} 归档整理失败/跳过，已写 done（记忆不整理，会话内可 query_history 回忆）`);
      }

      if (!fs.existsSync(pendingPath)) {
        // pending 已被外部清理（超时兜底/残留处理）：本侧 done 已写，主动清理避免残留
        try { fs.unlinkSync(doneMarkerPath(this.wsRoot, agent, counterpart, agent)); } catch { /* ignore */ }
        return;
      }
      let pending: { participants?: string[] };
      try {
        pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
      } catch {
        // pending 损坏无法解析：同样清理本侧 done 避免残留
        try { fs.unlinkSync(doneMarkerPath(this.wsRoot, agent, counterpart, agent)); } catch { /* ignore */ }
        return;
      }
      const participants: string[] = pending.participants || [agent];
      const allDone = participants.every((p) => fs.existsSync(doneMarkerPath(this.wsRoot, agent, counterpart, p)));
      if (!allDone) {
        log.info(`[archive] 归档整理 ${participants.filter((p) => fs.existsSync(doneMarkerPath(this.wsRoot, agent, counterpart, p))).join(',')} 已完成，等待全部`);
        return;
      }

      // 全部完成 → 归档
      log.info(`[archive] 归档整理全部完成，执行归档 ${agent}/${counterpart}`);
      try {
        if (ctx) {
          await this.archiveAndRebuild(agent, counterpart, ctx);
        } else {
          // 无 ctx（降级路径）→ 强制 idleArchive
          await this.idleArchive(agent, counterpart, 'review-fallback');
        }
      } finally {
        // 归档执行后无论成败都必须清理标记，否则残留 .archive_pending 会让
        // 超时监视器误判"归档整理超时"并再次强制归档（8/4 晚 bug：残留 pending
        // 导致 20:47 把 20:44 的最近对话也归档掉）。归档异常已在内部 log。
        try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
        for (const p of participants) {
          try { fs.unlinkSync(doneMarkerPath(this.wsRoot, agent, counterpart, p)); } catch { /* ignore */ }
        }
      }

      // 通知 WebUI 归档完成（前端刷新消息列表）
      this.notifyArchiveCompleted(agent, counterpart);
    } catch (err: any) {
      log.error(`[archive] 归档整理完成处理失败: ${err?.message ?? String(err)}`);
    }
  }

  /** 归档完成通知：router.emit('archive.completed') → ws 广播 session.archived */
  private notifyArchiveCompleted(agent: string, counterpart: string): void {
    try {
      this.router?.emit?.('archive.completed', { agent, counterpart });
    } catch { /* 通知失败静默跳过 */ }
  }

  // ============================================================
  // 超时扫描（清理残留 pending；启动 + 每 5 分钟）
  // ============================================================

  /**
   * 扫描所有 .archive_pending，处理超时/残留归档请求。
   * 规则：
   *   · 超时（> ARCHIVE_TIMEOUT_MS）→ 强制归档（reason='pending-timeout'）并清理 pending
   *   · 未超时 → 跳过（可能是进行中——整理 run 串行化等待中，误清理会打断归档）；
   *     重启打断的真残留由超时兜底（10 分钟后强制归档）处理
   * @returns 处理数（日志/调试用）
   */
  async scanPendingArchives(): Promise<number> {
    let handled = 0;
    try {
      const sessionsDir = path.join(this.wsRoot, 'sessions');
      if (!fs.existsSync(sessionsDir)) return 0;
      const now = Date.now();
      const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory() || !d.name.startsWith('chat~')) continue;
        const pendingPath = path.join(sessionsDir, d.name, '.archive_pending');
        // 顺带清理孤儿 done 标记（无 pending 配对的残留；旧架构迁移遗留，无害但冗余）
        if (!fs.existsSync(pendingPath)) {
          try {
            const orphans = fs.readdirSync(path.join(sessionsDir, d.name))
              .filter((f) => f.startsWith('.archive_done_'));
            for (const f of orphans) {
              try { fs.unlinkSync(path.join(sessionsDir, d.name, f)); } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          continue;
        }
        try {
          const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
          const requestedAt = new Date(pending.requestedAt || 0).getTime();
          const agent = pending.agent || '';
          const counterpart = pending.counterpart || '';
          if (!agent || !counterpart) { try { fs.unlinkSync(pendingPath); } catch { /* ignore */ } handled++; continue; }
          if (now - requestedAt > ARCHIVE_TIMEOUT_MS) {
            log.warn(`[archive] 归档整理超时，强制归档 ${agent}/${counterpart}`);
            try {
              await this.idleArchive(agent, counterpart, 'pending-timeout');
            } catch { /* 强制归档失败静默（下次扫描重试） */ }
            try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
            handled++;
          } else {
            // 未超时：可能是进行中（整理 run 串行化等待中），绝不能误清理打断；
            // 真残留（重启打断）由超时兜底 10 分钟后强制归档处理
            log.debug(`[archive] pending 未超时，跳过（进行中或重启残留）: ${agent}/${counterpart}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* 扫描失败静默 */ }
    return handled;
  }

  /** 启动超时降级监视（模块加载时一次 + 每 5 分钟） */
  startArchiveTimeoutWatcher(): void {
    void this.scanPendingArchives(); // 启动立即清理残留（防止重启打断整理 run 后的 pending 锁死）
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = setInterval(() => { void this.scanPendingArchives(); }, 5 * 60 * 1000);
  }

  /** 停止监视（关闭时调用） */
  stopArchiveTimeoutWatcher(): void {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = undefined; }
  }

  // ============================================================
  // 批量归档（__archive_all__ 定时 hint 触发）
  // ============================================================

  /**
   * 批量归档所有活跃 1:1 会话。
   * 扫描 sessions/chat~* 目录：
   *   · 跳过不存在的 / 空的 / 已存在 .archive_pending 的（幂等）
   *   · 跳过自对话（lo === hi，B1 不写活跃消息）
   *   · 跳过群聊（group~*，另有周归档机制）
   */
  archiveAllActiveSessions(): ArchiveBatchItem[] {
    const result: ArchiveBatchItem[] = [];
    const sessionsDir = path.join(this.wsRoot, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      log.info('[archive] 批量归档：sessions 目录不存在，跳过');
      return result;
    }

    let archived = 0;
    const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || !d.name.startsWith('chat~')) continue;
      // 目录名 chat~<lo>~<hi>（lo/hi 排序）
      const parts = d.name.split('~');
      if (parts.length < 3) continue;
      const lo = parts[1];
      const hi = parts.slice(2).join('~');
      if (lo === hi) continue; // 自对话（不写活跃消息）

      const msgPath = path.join(sessionsDir, d.name, 'messages.jsonl');
      if (!fs.existsSync(msgPath)) continue;
      let size = 0;
      try { size = fs.statSync(msgPath).size; } catch { continue; }
      if (size <= 0) continue; // 空会话不归档

      // 阈值检查：未达归档阈值的会话跳过（夜间批量归档不打扰未满会话；
      // 达标会话由超阈值自动归档兜底，无需批量重复处理）
      const cfg = this.sessionCfg(lo);
      const threshold = Math.ceil(cfg.maxContextTokens * cfg.archiveTokenRatio);
      let est = 0;
      try {
        const msgs = fs.readFileSync(msgPath, 'utf-8').split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean) as Array<{ content?: string | null }>;
        est = estimateMessagesTokens(msgs);
      } catch { est = 0; }
      if (est < threshold) {
        result.push({ agent: lo, counterpart: hi, skipped: true, reason: 'below-threshold' });
        continue;
      }

      // 幂等：已有 pending（含进行中）则跳过
      if (fs.existsSync(path.join(sessionsDir, d.name, '.archive_pending'))) {
        result.push({ agent: lo, counterpart: hi, skipped: true, reason: 'pending' });
        continue;
      }

      this.requestArchive(lo, hi);
      archived++;
      result.push({ agent: lo, counterpart: hi, skipped: false });
    }

    log.info(`[archive] 批量归档完成：处理 ${result.length} 个会话，触发归档 ${archived} 个`);
    return result;
  }


  // ============================================================
  // 归档与重建（先整理后归档；ctx.history 即完整消息源）
  // ============================================================

  /**
   * 归档并重建 messages.jsonl。
   * 流程：
   *   1. 读取上一次归档的最后一条消息，检测重复（二次归档去重）
   *   2. 将 messages.jsonl 中未被上次归档覆盖的部分写入 archive/history_<N>.jsonl
   *   3. 从尾部保留近期消息至安全水位（≤ maxContextTokens × keepRecentRatio），
   *      重建 messages.jsonl，保证下一步会话加载时无需立即压缩
   *
   * 消息源：整理 run runEnd 的 ctx.history（loadHistory 已加载完整会话文件；整理 run 不落盘，
   * 磁盘仍是归档前完整状态）。降级路径（无 ctx）走 idleArchive 读磁盘。
   */
  async archiveAndRebuild(agent: string, counterpart: string, ctx: CurrentContext): Promise<void> {
    const msgPath = sessionFile(this.wsRoot, agent, counterpart);
    const archiveDir = archiveDirOf(this.wsRoot, agent, counterpart);

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

    // 3. 收集待重建的全部消息（ctx.history = 完整会话文件，整理 run 不落盘）
    const allMessages: LLMRequestMessage[] = ctx.history;

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
    const sessionCfg = this.sessionCfg(agent);
    const maxTokens = sessionCfg.maxContextTokens;
    const keepRecentRatio = sessionCfg.keepRecentRatio;
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
          // 关键：tool/error 结果保持原视角（见 toPersistedRole），
          // 事件消息（原 trigger）落为 event 并保留 source
          role: toPersistedRole(msg.role, msg.source),
          content: msg.content,
          message_id: msg.message_id,
          agent_id: msg.agent_id,
          name: msg.name,
          tool_calls: msg.tool_calls as PersistedMessage['tool_calls'],
          tool_call_id: msg.tool_call_id,
          reasoning_content: msg.reasoning_content,
          label: msg.label,
          ...(msg.source ? { source: msg.source } : {}),
          // 保留原始时间戳（不再批量改写为归档时刻）
          timestamp: msg.timestamp ?? new Date().toISOString(),
        };
        fs.appendFileSync(archivePath, JSON.stringify(p) + '\n', 'utf-8');
      }
    }

    if (archiveMessages.length > 0) {
      log.info(
        dedupCutoff > 0
          ? `[archive] 二次归档去重：跳过前 ${dedupCutoff} 条，归档 ${archiveMessages.length} 条 (${truncStart - dedupCutoff} 区间) → ${archivePath}`
          : `[archive] 已归档：${archiveMessages.length} 条（保留 ${truncated.length} 条近期） → ${archivePath}`
      );
    }

    // 5b. 归档摘要写入 SUMMARY.md（跨会话注入用，防止归档后会话割裂）
    //  归档的早期消息被截断，若不做摘要持久化，下次会话 Agent 将丢失关键决策/待办上下文。
    //  v0.4.6：优先由 Agent 在归档整理 run 亲自写入（基于完整上下文更准确）；
    //  系统自动生成降级为兜底——仅在 SUMMARY.md 不存在或未被 Agent 本次更新（mtime 早于归档请求）时触发。
    if (archiveMessages.length > 0 && ctx.llm) {
      try {
        const summaryPath = path.join(archiveDir, 'SUMMARY.md');
        const dateStr = new Date().toISOString().slice(0, 10);
        const header = `## 归档 ${dateStr}（history_${archiveCount + 1}，${archiveMessages.length} 条）\n\n`;

        // 判断 Agent 是否已在整理 run 写入本次归档的总结：SUMMARY.md mtime > 归档请求时间
        let agentWrote = false;
        try {
          const pendingPath = pendingMarkerPath(this.wsRoot, agent, counterpart);
          if (fs.existsSync(summaryPath) && fs.existsSync(pendingPath)) {
            const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
            const requestedAt = new Date(pending.requestedAt || 0).getTime();
            if (requestedAt > 0 && fs.statSync(summaryPath).mtimeMs > requestedAt) {
              agentWrote = true;
            }
          }
        } catch { /* 判断失败则走自动生成兜底 */ }

        if (agentWrote) {
          log.info(`[archive] SUMMARY.md 已由 Agent 在整理 run 写入，跳过系统自动生成`);
        } else {
          const summaryText = await generateSummary(
            ctx.llm,
            archiveMessages,
            counterpart,
            agent,
            sessionCfg.summaryPreviewLen,
            this.agentsDir,
          );
          if (summaryText && !summaryText.startsWith('(摘要生成失败')) {
            fs.appendFileSync(summaryPath, header + summaryText + '\n\n', 'utf-8');
            log.info(`[archive] 归档摘要已写入 ${summaryPath}（系统自动生成兜底）`);
          }
        }
      } catch (err: any) {
        log.warn(`[archive] 归档摘要处理失败: ${err?.message ?? String(err)}`);
      }
    }

    // 删除旧 messages.jsonl
    if (fs.existsSync(msgPath)) fs.unlinkSync(msgPath);

    // 6. 写入重建后的 messages.jsonl（仅保留尾部近期消息）
    for (const msg of truncated) {
      const p: PersistedMessage = {
        // 同上：tool/error 结果保持原视角（见 toPersistedRole）；事件消息落为 event + source
        role: toPersistedRole(msg.role, msg.source),
        content: msg.content,
        message_id: msg.message_id,
        agent_id: msg.agent_id,
        name: msg.name,
        tool_calls: msg.tool_calls as PersistedMessage['tool_calls'],
        tool_call_id: msg.tool_call_id,
        reasoning_content: msg.reasoning_content,
        label: msg.label,
        ...(msg.source ? { source: msg.source } : {}),
        // 保留原始时间戳（不再批量改写为归档时刻）
        timestamp: msg.timestamp ?? new Date().toISOString(),
      };
      appendPersisted(this.wsRoot, agent, counterpart, p);
    }

    const truncatedCount = allMessages.length - truncated.length;
    if (truncatedCount > 0) {
      log.info(
        `[archive] 归档重建截断 ${truncatedCount} 条早期消息，` +
        `保留 ${truncated.length} 条 (≤ ${safeTarget} tokens / ${maxTokens} 阈值)`
      );
    }
    // 记忆整理已由整理 run 完成：成功归档不写审查标记（机制已移除，失忆就失忆）
  }

  // ============================================================
  // 空闲归档（降级路径：无整理 run ctx）
  // ============================================================

  /**
   * 空闲归档：将 messages.jsonl 移动归档 + 从尾部保留近期消息重建。
   * @param reason 触发原因（日志区分）：'idle' | 'pending-timeout' | 'review-fallback' 等
   */
  async idleArchive(agent: string, counterpart: string, reason = 'idle'): Promise<void> {
    const msgPath = sessionFile(this.wsRoot, agent, counterpart);
    const archiveDir = archiveDirOf(this.wsRoot, agent, counterpart);

    if (!fs.existsSync(msgPath)) return;

    // 1. 在移动前读取所有消息
    let allMessages: PersistedMessage[] = [];
    try {
      const raw = fs.readFileSync(msgPath, 'utf-8').trim();
      if (raw) {
        allMessages = raw
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line) as PersistedMessage; }
            catch { return null; }
          })
          .filter(Boolean) as PersistedMessage[];
      }
    } catch {
      // 读取失败则跳过重建
    }

    // 2. 计算归档编号
    let archiveCount = 0;
    if (fs.existsSync(archiveDir)) {
      const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
      archiveCount = files.length;
    } else {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // 3. 移动当前 messages.jsonl 到归档
    const archivePath = path.join(archiveDir, `history_${archiveCount + 1}.jsonl`);
    fs.renameSync(msgPath, archivePath);

    if (reason === 'idle') {
      const idleMinutes = Math.round((this.sessionCfg(agent).idleArchiveSec * 1000) / 60000);
      log.info(`[archive] 空闲归档 (${idleMinutes} 分钟无活动)：${msgPath} → ${archivePath}`);
    } else {
      log.warn(`[archive] 归档 ${reason}：${msgPath} → ${archivePath}`);
    }

    // 4. 从尾部截取近期消息并重建 messages.jsonl
    if (allMessages.length > 0) {
      const sessionCfg = this.sessionCfg(agent);
      const safeTarget = Math.ceil(sessionCfg.maxContextTokens * sessionCfg.keepRecentRatio);
      const truncated = truncatePersistedMessages(allMessages, safeTarget);

      const jsonl = truncated.map((m) => JSON.stringify(m)).join('\n') + '\n';
      fs.writeFileSync(msgPath, jsonl, 'utf-8');

      const dropped = allMessages.length - truncated.length;
      if (dropped > 0) {
        log.info(
          `[archive] 空闲归档截断 ${dropped} 条早期消息，` +
          `保留 ${truncated.length} 条 (≤ ${safeTarget} tokens / ${sessionCfg.maxContextTokens} 阈值)`
        );
      }
    }
  }

  // ============================================================
  // 空闲定时器（每次 runEnd 重置；到期自动归档）
  // ============================================================

  /** 重置指定会话对的空闲归档定时器（runEnd idle-reset 钩子调用） */
  resetIdleTimer(agent: string, counterpart: string): void {
    const key = pairKey(agent, counterpart);
    const existing = this.idleTimers.get(key);
    if (existing) clearTimeout(existing);
    const ms = this.sessionCfg(agent).idleArchiveSec * 1000;
    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      void this.idleArchive(agent, counterpart);
    }, ms);
    this.idleTimers.set(key, timer);
  }

  /** 清除所有空闲定时器（关闭时调用） */
  clearAllIdleTimers(): void {
    for (const [, timer] of this.idleTimers) clearTimeout(timer);
    this.idleTimers.clear();
  }

  /** 关闭（停止扫描 + 清理空闲定时器） */
  dispose(): void {
    this.stopArchiveTimeoutWatcher();
    this.clearAllIdleTimers();
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 会话对键值（canonical 排序） */
function pairKey(agent: string, counterpart: string): string {
  const [lo, hi] = [agent, counterpart].sort();
  return `${lo}::${hi}`;
}

/** 追加一条持久化消息到 messages.jsonl */
function appendPersisted(wsRoot: string, agent: string, counterpart: string, msg: PersistedMessage): void {
  const filePath = sessionFile(wsRoot, agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 兼容旧数据：无 message_id 的补稳定 ID（保留原始 timestamp 以确保跨读写稳定）
  const withId: PersistedMessage = msg.message_id
    ? msg
    : { ...msg, message_id: stableMessageIdOf(chatDialogKey(agent, counterpart), msg) };
  fs.appendFileSync(filePath, JSON.stringify(withId) + '\n', 'utf-8');
}

/**
 * 估算消息数组的 token 数（仅 content）。
 * 与 toProviderMessages 对齐：历史 reasoning_content 不会发送给模型
 *（DeepSeek 明确其不参与后续推理），统计/阈值判断均不计入。
 */
export function estimateMessagesTokens(messages: Array<{ content?: string | null }>): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? '');
  }
  return total;
}

/** 按 token 预算从尾部截取消息（仅计 content；reasoning 不参与发送，不占预算） */
export function truncateMessagesByTokenBudget<T extends { content?: string | null }>(
  messages: T[],
  tokenBudget: number,
): T[] {
  let accumulated = 0;
  let splitIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content ?? '');
    if (accumulated + msgTokens > tokenBudget * 1.5 && accumulated > 0) break;
    accumulated += msgTokens;
    splitIdx = i;
  }

  splitIdx = Math.max(0, splitIdx);
  return messages.slice(splitIdx);
}

/**
 * 调整截断/归档分割点：若分割点落在 tool 消息上，回退到其配对 agent 消息之前，
 * 保证不拆分 tool-call/response 对。
 */
export function safeSplitIdx(messages: LLMRequestMessage[], splitIdx: number): number {
  while (splitIdx > 0 && splitIdx < messages.length) {
    const atSplit = messages[splitIdx];
    if (atSplit.role !== 'tool') break;
    let found = false;
    for (let j = splitIdx - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.role === 'tool') continue; // 同一批工具结果，继续回找
      if (prev.role === 'assistant' && prev.tool_calls?.length) { splitIdx = j; found = true; break; }
      if (prev.role === 'agent' && prev.agent_id !== 'user' && prev.tool_calls?.length) { splitIdx = j; found = true; break; }
      break; // 入站边界
    }
    if (!found) break;
  }
  return splitIdx;
}

/** 从尾部保留消息至指定 token 预算（不拆 tool-call/response 对） */
export function truncateTail(messages: LLMRequestMessage[], tokenBudget: number): LLMRequestMessage[] {
  const truncated = truncateMessagesByTokenBudget(messages, tokenBudget);
  const splitIdx = safeSplitIdx(messages, messages.length - truncated.length);
  return messages.slice(Math.max(0, splitIdx));
}

/** 从 PersistedMessage 数组尾部保留消息至指定 token 预算 */
function truncatePersistedMessages(messages: PersistedMessage[], tokenBudget: number): PersistedMessage[] {
  const truncated = truncateMessagesByTokenBudget(messages, tokenBudget);
  const splitIdx = safeSplitIdx(messages as unknown as LLMRequestMessage[], messages.length - truncated.length);
  return messages.slice(Math.max(0, splitIdx));
}

/** 读取归档文件最后一条消息（用于二次归档去重） */
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

/** 在 allMessages 中查找与 target 匹配的消息索引 */
function findMessageIndex(messages: LLMRequestMessage[], target: PersistedMessage): number {
  // 优先按 message_id 精确匹配（content 为空的工具 step 消息大量相同，role+content 会错位）
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

// ============================================================
// 摘要生成（迁移自旧 summary.ts）
// ============================================================

/** 读取 Agent 的友好名称（<agentsDir>/<id>/config.json name），失败回退 id */
function agentLabel(id: string, agentsDir?: string): string {
  if (!agentsDir) return id;
  try {
    const configPath = path.join(agentsDir, id, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.name) return config.name;
    }
  } catch { /* 读取失败时回退到 id */ }
  return id;
}

/** 调用 LLM 将早期消息列表压缩为一段自然语言摘要 */
async function generateSummary(
  llm: LLMProvider,
  olderMessages: LLMRequestMessage[],
  counterpart: string,
  agent: string,
  summaryPreviewLen: number,
  agentsDir?: string,
): Promise<string> {
  // 用 provider 的正向转换渲染 LLM 视角（角色已解析为 user/assistant、工具调用已归一化）
  const apiMessages = llm.toProviderMessages(olderMessages, agent);
  const dialogueText = apiMessages
    .map((m: any) => {
      const label = m.name ? ` (${m.name})` : '';
      const toolNames = (m.tool_calls || []).map((tc: any) => tc?.function?.name ?? tc?.name).filter(Boolean);
      const toolCalls = toolNames.length ? `\n  [工具调用: ${toolNames.join(', ')}]` : '';
      // 不截断消息内容，完整传入让 LLM 自行提取关键信息
      return `[${m.role}${label}] ${m.content}${toolCalls}`;
    })
    .join('\n\n');

  const summaryPrompt: LLMRequestMessage = {
    role: 'system',
    content:
      `你是一个对话摘要助手。请用简洁自然的语言，总结以下 ${agentLabel(agent, agentsDir)} 与 ${agentLabel(counterpart, agentsDir)} 之间的早期对话内容。\n\n` +
      `要求：\n` +
      `1. 使用中文、自然流畅的叙述语气，像写日记一样\n` +
      `2. 保留关键决策、重要结论、用户偏好和待办事项\n` +
      `3. 忽略纯工具调用（如文件读写、命令执行）的技术细节，只记录其目的和结果\n` +
      `4. 对话可能很长，请提取核心要点而非逐条复述\n` +
      `5. 控制在 ${summaryPreviewLen} 字以内\n` +
      `6. 以"此前，"开头`,
  };
  const userMsg: LLMRequestMessage = {
    role: 'user',
    content: `请总结以下对话：\n\n${dialogueText}`,
  };

  const resp = await llm.chat({ messages: [summaryPrompt, userMsg] });
  const text = (resp.content ?? '').trim();
  if (text) {
    log.info(`[archive] LLM 摘要生成成功 (${estimateTokens(text)} tokens)`);
    return text;
  }
  log.warn('[archive] LLM 摘要返回空内容');
  return '(摘要生成失败)';
}
