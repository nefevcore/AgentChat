// ============================================================
// archive.ts —— 归档编排行（D11 裁决：archive 全壳内）
//
// 主线 ac-archive 服务编排半边的壳内形态（算法半边复用主线
// ac-archive-core 纯库零改动）：
//   · 阈值检测 = 订阅 loop/after-run（emit 面）——run 收束后估回放
//     token，超阈值触发「先整理后归档」；
//   · 整理 run = conversation.reviewRun（机制投递面——不落账不进
//     上下文，与用户 run 共串行化门）；
//   · 归档重建 = splitForArchive 分割 + ctx.ledger.compactFor（物理
//     面归账本 writer——写权 = 账本所有权 D4，本壳只写自己域）；
//   · 概要 = Agent 亲写 summary.md（D4）——reviewRun 后 mtime 判
//     新鲜，未更新/缺文件回退整理回复文本；
//   · 批量唤醒信（archive-all，timers 机制任务）：枚举本域会话逐桶
//     触发阈值检测（宿主零 archive 职责——A13/D11）；
//   · 失控防线三闸照搬：① maxSteps 硬上限 ② 超时 abort ③ 步级观测。
// pending 标记协议退化：单写者壳内事件驱动 + idle-exit 不收割 busy
// 会话（shellIsIdle 面），崩溃残留无独立扫描兜底的必要——重启后阈值
// 检测自然重触发（幂等）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import {
  DEFAULT_ARCHIVE_BUDGETS,
  DEFAULT_SELF_CONTEXT_TOKENS,
  estimateReplayTokens,
  keepBudgetOf,
  splitForArchive,
  summaryCommittable,
  thresholdOf,
  type ArchiveBudgets,
} from 'ac-archive-core';
import { foldSession, foldStepsOf, foldSummaryOf, readDomainFacts, readLedger, rowShadowedBy, summaryTextOf, type LedgerRow } from 'ac-ledger';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';

export interface ArchiveRowOptions {
  dataRoot: string;
  agentId: string;
  /** 整理 run 步数硬上限（闸①——主线用户裁决 128） */
  reviewMaxSteps?: number;
  /** 整理 run 超时（闸②——超时 abort 后强制归档，概要不动） */
  timeoutMs?: number;
  /** 预算缺省（per-Agent settings['archive'] 覆盖） */
  defaults?: Partial<ArchiveBudgets>;
}

const REVIEW_TIMEOUT_MS = 10 * 60_000;
const REVIEW_MAX_STEPS = 128;
const SOFT_STEPS = 16;

/** 归档编排便（单会话串行——同桶并发触发幂等去重） */
export class ArchiveShellService extends Service {
  private dataRoot: string;
  private agentId: string;
  private reviewMaxSteps: number;
  private timeoutMs: number;
  private defaults: ArchiveBudgets;
  /** 进行中的归档（uuid → AbortController——超时中止整理 run） */
  private pending = new Map<string, AbortController>();

  constructor(ctx: Context, options: ArchiveRowOptions) {
    super(ctx, 'archive');
    this.dataRoot = options.dataRoot;
    this.agentId = options.agentId;
    this.reviewMaxSteps = options.reviewMaxSteps ?? REVIEW_MAX_STEPS;
    this.timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS;
    this.defaults = { ...DEFAULT_ARCHIVE_BUDGETS, ...options.defaults };

    // 阈值检测（run 收束后）：非整理 run 且会话键含本 agent → 估算触发。
    // 会话键门（主线 M19 对桶门同义）：本壳只管自己是端点的会话——
    // uuid 两端（a~b / a~a）或单键 = 本 agent 即检测。
    ctx.on('loop/after-run', (request: LoopRunRequest, result: LoopRunResult) => {
      if (request.agent !== this.agentId) return;
      const uuid = request.conversationId;
      if (uuid === undefined || !uuid.split('~').includes(this.agentId)) return;
      if (request.runId !== undefined && request.runId.includes('-review-')) return; // 整理 run 与会话增长无关
      if (result.finish === 'error') return; // 失败 run 不触发
      void this.maybeArchive(uuid).catch((err: unknown) => {
        this.ctx.logger.warn('[archive] 阈值检测失败（' + uuid + '）: ' + String(err));
      });
    }, { description: '归档阈值检测（run 收束后回放估算）' });
  }

  /** 会话目录（本 agent 域——影子域经 ledger agentDirOf 同源；本行直接拼） */
  private sessionDir(uuid: string): string {
    return path.join(this.dataRoot, 'agents', this.agentId, 'sessions', uuid);
  }

  /** 预算（per-Agent settings['archive'] 覆盖 > 行缺省；直读不缓存——
   * 配置轴 = 文件文集，与 shims settingsOf 同源） */
  private budgetsFor(uuid: string): ArchiveBudgets {
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    let settings: Record<string, unknown> | undefined;
    try {
      const config = JSON.parse(fs.readFileSync(
        path.join(this.dataRoot, 'agents', this.agentId, 'config.json'), 'utf-8',
      )) as { settings?: Record<string, Record<string, unknown>> };
      const s = config.settings?.archive;
      if (s !== undefined && typeof s === 'object') settings = s;
    } catch {
      // 配置缺席 = 行缺省
    }
    const base = {
      maxContextTokens: num(settings?.maxContextTokens, this.defaults.maxContextTokens),
      archiveTokenRatio: num(settings?.archiveTokenRatio, this.defaults.archiveTokenRatio),
      keepRecentRatio: num(settings?.keepRecentRatio, this.defaults.keepRecentRatio),
    };
    // 自会话桶专项（主线 P2 成本治理）：a~a 桶覆盖 maxContextTokens
    if (uuid === this.agentId + '~' + this.agentId) {
      return { ...base, maxContextTokens: num(settings?.maxSelfContextTokens, DEFAULT_SELF_CONTEXT_TOKENS) };
    }
    return base;
  }

  /** 阈值估算（回放口径——estimateReplayTokens 纯库单源：概要头计入
   * 〔cr-424 单口径——注入形状含概要〕；viewer = 本 agent。cr-974：v2
   * 会话步级事实 = 事件行（无 role）——折叠出 steps 合成 v1 段行同形
   * 伪行（face-ops replayTokensOf 同型）；概要源 = 压缩事件优先，
   * summary.md 兼容窗兜底）。
   *
   *  opts.activeOnly（cr-1160 P4）：只计**活跃代**——被任一压缩代边界
   *  shadow 的行剔除（rowShadowedBy 单源谓词：时刻放行前置 → seq 位置维
   *  → 时刻维；无 seq 无数字 ts 的 v1 行由文件位置维兜底——此处无位置
   * 信息，保守放行）。伪行按其 run 的末事实 seq/ts 判（与 foldLlmReplay
   * 的 orphan slot 判定同源）。 */
  private estimateOf(uuid: string, opts: { activeOnly?: boolean } = {}): number {
    const dir = this.sessionDir(uuid);
    const { rows } = readLedger(dir);
    const facts = readDomainFacts(dir, this.agentId);
    const boundaries = opts.activeOnly === true ? facts.compactions : [];
    const shadowed = (seq: number | undefined, ts: number | undefined): boolean =>
      boundaries.some((b) => rowShadowedBy({ ...(seq !== undefined ? { seq } : {}), ...(ts !== undefined ? { ts } : {}) }, b));
    const pseudo: LedgerRow[] = [];
    if (facts.version >= 2) {
      for (const [run, rf] of facts.runs) {
        const steps = foldStepsOf(rf, facts.subcallArchive.filter((s) => s.run === run))?.steps ?? [];
        if (steps.length === 0) continue;
        if (boundaries.length > 0) {
          // run 级判定（foldLlmReplay orphan slot 同源）：末事实 seq + 末 ts
          let runSeq: number | undefined;
          let runTs: number | undefined;
          for (const ev of rf.events) {
            if (ev.kind === 'tool-call-result') continue;
            if (ev.seq !== undefined && (runSeq === undefined || ev.seq > runSeq)) runSeq = ev.seq;
            if (ev.ts !== undefined && (runTs === undefined || ev.ts > runTs)) runTs = ev.ts;
          }
          for (const s of steps) {
            if (typeof s.ts === 'number' && (runTs === undefined || s.ts > runTs)) runTs = s.ts;
          }
          if (shadowed(runSeq, runTs)) continue; // 整 run 属压缩前代——不计
        }
        pseudo.push({ role: 'agent', content: '', agent_id: this.agentId, run, steps, message_id: 'v2-' + run, timestamp: '' } as LedgerRow);
      }
    }
    // 行时刻（v2 事件行数字 ts / v1 行 ISO timestamp——索引入账同谓词）
    const tsOf = (r: LedgerRow): number | undefined => {
      const raw = (r as unknown as Record<string, unknown>).ts;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof r.timestamp === 'string' && r.timestamp !== '') {
        const parsed = Date.parse(r.timestamp);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    };
    const picked = boundaries.length > 0
      ? rows.filter((r) => !shadowed(typeof r.seq === 'number' ? r.seq : undefined, tsOf(r)))
      : rows;
    const summary = foldSummaryOf(foldSession(this.dataRoot, uuid, [dir]))?.text ?? summaryTextOf(dir);
    return estimateReplayTokens([...picked, ...pseudo], this.agentId, summary !== '' ? { summary } : {});
  }

  /** 阈值检测 + 触发（run 收束后异步）：超阈值 → 整理 → 归档重建。 */
  async maybeArchive(uuid: string): Promise<void> {
    if (this.pending.has(uuid)) return;
    const threshold = thresholdOf(this.budgetsFor(uuid));
    if (this.activeTokensOf(uuid) <= threshold) return; // cr-1160：活跃代口径（压缩边界已滤）
    await this.requestArchive(uuid);
  }

  /** 活跃上下文估算（cr-1160 P4 三口径收敛——阈值检测口径）。
   *
   *  **为什么不是直读 sessionIndex**：session-index 是宿主侧行（host.yml），
   *  本行在壳进程（shell.yml）——ctx.get('sessionIndex') 跨进程恒 undefined，
   *  软取即死代码（实施期实证）。壳侧持有账本读面（ac-ledger）足以自算：
   *  boundaries = 本域压缩代 → rowShadowedBy 过滤 → 回放口径估算。与宿主侧
   *  activeContextTokens（索引 est_tokens 累加）同语义、不同实现——两进程各
   *  自算自己需要的那份，不跨进程递话（架构红线：能力间不传引用）。 */
  private activeTokensOf(uuid: string): number {
    return this.estimateOf(uuid, { activeOnly: true });
  }

  /**
   * 请求归档（幂等）：整理 run → 概要（亲写文件优先 / 回退回复文本）→
   * 归档重建。超时（闸②）abort 整理 → 强制归档（概要不动）。
   */
  async requestArchive(uuid: string): Promise<void> {
    if (this.pending.has(uuid)) return;
    const abort = new AbortController();
    this.pending.set(uuid, abort);
    try {
      const requestedAt = Date.now();
      const conv = this.ctx.get('conversation', false) as
        | { reviewRun(uuid: string, prompt: string, opts?: { runId?: string; maxSteps?: number; signal?: AbortSignal }): Promise<{ finish: string; text: string }> }
        | undefined;
      if (conv === undefined) {
        this.ctx.logger.warn('[archive] conversation 服务缺席——整理不可用，直接归档（概要不动）');
        await this.archiveAndRebuild(uuid, undefined, requestedAt);
        return;
      }
      const runId = requestedAt + '-review-' + uuid;
      const timer = setTimeout(() => abort.abort(new Error('整理超时')), this.timeoutMs);
      timer.unref();
      let outcome: { finish: string; text: string };
      try {
        outcome = await conv.reviewRun(uuid, this.reviewPrompt(uuid), { runId, maxSteps: this.reviewMaxSteps, signal: abort.signal });
      } finally {
        clearTimeout(timer);
      }
      // 概要来源（D4）：正常收束（finish='ok'）→ 亲写 summary.md（mtime ≥
      // requestedAt 判新鲜）优先，回退回复文本；**cr-1160 P3 概要提交协议**：
      // 候选文本过 summaryCommittable 形态校验（「此前，」开头 + 上限 + 元文本
      // 黑名单）——不合格 → summary = undefined（本代无新概要，compaction 事件
      // 不带摘要，回放头回落上一代概要）；未正常收束 → 概要不动。
      let summary: string | undefined;
      if (outcome.finish === 'ok') {
        const file = path.join(this.sessionDir(uuid), 'summary.md');
        let fresh = false;
        try {
          fresh = fs.existsSync(file) && fs.statSync(file).mtimeMs >= requestedAt;
        } catch {
          fresh = false;
        }
        const text = fresh ? summaryTextOf(this.sessionDir(uuid)) : '';
        const candidate = text !== '' ? text : outcome.text.trim();
        if (candidate !== '' && summaryCommittable(candidate)) summary = candidate;
      }
      await this.archiveAndRebuild(uuid, summary, requestedAt);
    } finally {
      this.pending.delete(uuid);
    }
  }

  /**
   * 整理提示词（主线 reviewPrompt 平移——Agent 亲自整理语义）：
   * 概要 = Agent 亲写 summary.md（fs 工具在场时）/ 回复即概要；TODO/
   * DONE/note 工作文件同理整理。会话键显式给出（Agent 无从推导键词法）。
   */
  private reviewPrompt(uuid: string): string {
    const budget = Math.max(400, Math.ceil(this.budgetsFor(uuid).maxContextTokens * 0.004));
    const self = uuid === this.agentId + '~' + this.agentId;
    const other = uuid.split('~').find((p) => p !== this.agentId) ?? 'user';
    const subject = self
      ? '此前运行日志（含已有概要覆盖的更早内容）的关键事件、推送结论、失败教训与待跟进事项'
      : '这段会话（含已有概要覆盖的更早内容）的关键决策、重要结论、用户偏好和待办事项';
    const head = self
      ? '[归档整理] 你的自会话运行日志（会话键 ' + uuid + '）需要滚动整理，早期机制触发记录即将移出会话流。请完成以下整理：'
      : '[归档整理] 你与「' + other + '」的会话（会话键 ' + uuid + '）已达到归档阈值，早期消息即将移出会话流。请在归档前完成以下整理：';
    return [
      head,
      '1. 【生成会话总结】把' + subject + '，整理为一段以「此前，」开头的自然语言，控制在 ' + budget + ' 字以内，写入本会话概要文件 summary.md（整文件即总结，重写覆盖——位于会话目录，可用 write/fs_write 工具）。',
      '2. 【整理工作文件】TODO.md / DONE.md / note/ 知识库同理更新：完成的事项移入 DONE、过时内容清理删除，保持精炼。',
      '会话中的 context 注入行（长期记忆快照/增量、技能注入等）是机制材料，不属于会话事实——无需纳入概要。',
      '整理是机制任务：不要发起对话、不要等待用户回复；完成后简短确认即可，系统会自动归档。',
    ].join('\n');
  }

  /**
   * 归档重建：读账本 → splitForArchive 分割（ac-archive-core）→ 落语义
   * 边界（v2：compaction 事件）→ ctx.ledger.compactFor（分段 + 重写 +
   * 概要滚动）。概要缺省（整理失败/降级）= 概要不动。
   * cr-974 v2（§2.3 压缩事件化 + S5 物理回收）：分割在富化行（伪段行
   * 承载步级体积）上计量；shadowed 前缀 = 原 rows 中 seq ≤ boundary 的
   * 全部行（相位/收束行随迁——append-only 真序整体搬移），整段单流 gzip
   * 落 archive/history_N.jsonl.gz（Node 24.18 无 zstdSync，回落 gzip 如实
   * 命名）；主日志保留 = header + compaction 事件（经 B1 窗口 late-merge
   * 自然留存——audit 面永在）+ 尾部行。v1 会话走原 compact 流程不动。
   */
  async archiveAndRebuild(uuid: string, summary: string | undefined, requestedAt: number): Promise<void> {
    const ledger = this.ctx.ledger;
    const dir = this.sessionDir(uuid);
    const { header, rows } = readLedger(dir);
    if (rows.length === 0) return;
    const anchor = ledger.archiveAnchorOf(uuid);
    const budgets = this.budgetsFor(uuid);
    const lastArchived = anchor !== null && anchor.seq !== undefined
      ? { seq: anchor.seq, message_id: anchor.messageId, role: '', content: '' }
      : null;
    if ((header?.version ?? 1) >= 2) {
      // 富化行（估算/水位计量面）——分割边界取回原 rows 的 seq 锚
      const facts = readDomainFacts(dir, this.agentId);
      const pseudo: LedgerRow[] = [];
      for (const [run, rf] of facts.runs) {
        const steps = foldStepsOf(rf, facts.subcallArchive.filter((s) => s.run === run))?.steps ?? [];
        if (steps.length > 0) pseudo.push({ role: 'agent', content: '', agent_id: this.agentId, run, steps, message_id: 'v2-' + run, timestamp: '' } as LedgerRow);
      }
      const enriched = [...rows, ...pseudo] as never[];
      const split = splitForArchive(enriched, budgets, lastArchived);
      // cr-1155 归档对齐口径修正：split 切片是 enriched 数组的引用切片——
      // 用引用集对齐（位置语义）替代 seq 集匹配，无 seq 的 v1 存量行按其
      // 文件位置自然进归档集/保留集，不再被 (seq ?? Infinity) 永久钉在主日志
      // （僵尸行：穿越任意多次 compaction 不离场——ac-memory 锚曾因 v1 行
      // 永踞 recordsFor 投影尾部而 S 冻结、每 run 重注）。
      const archivedSet = new Set<unknown>(split.archive);
      // compaction 事件永留主日志（§2.3 可审计可重建；其 run-end 同留——
      // 机制标记）——归档排除，fold summaryOf 跨轮迭替不受影响
      const compactionRuns = new Set(rows
        .filter((r) => String((r as { type?: unknown }).type ?? '').startsWith('compaction/'))
        .map((r) => (r as { run?: unknown }).run));
      const isCompactionRow = (r: LedgerRow): boolean => {
        const t = String((r as { type?: unknown }).type ?? '');
        return t.startsWith('compaction/') || (t === 'run-end' && compactionRuns.has((r as { run?: unknown }).run));
      };
      const archivedOriginal = rows.filter((r) => archivedSet.has(r) && !isCompactionRow(r));
      const baselineSeq = rows.reduce((m, r: LedgerRow) => Math.max(m, r.seq ?? 0), 0);
      const archivedMaxSeq = split.archive.reduce((m, r: LedgerRow) => Math.max(m, r.seq ?? 0), 0);
      const boundary = Math.max(lastArchived?.seq ?? 0, archivedMaxSeq, 0);
      // 语义边界先 durable（cr-1160 P1 单事件：摘要可空——P3 不合格本代无新
      // 概要；stats 随行审计面。摘要滚动即使零移出也落事件——边界即刻生效）
      await ledger.compactionFor(uuid, requestedAt + '-compaction-' + uuid, {
        ...(summary !== undefined ? { summary } : {}),
        shadowedSeq: boundary,
        stats: { shadowedRows: archivedOriginal.length, estimatedTokens: this.estimateOf(uuid) },
      });
      // cr-1160 物理解耦：逻辑压缩（事件）与物理回收（重写）分离——影子估算
      // 超回收阈（shadowed tokens > keep 水位 × 2）才搬尸骸；未超 = shadowed
      // 行留主日志（回放已滤，不占上下文），下次触发再评估。
      const budgetsNow = this.budgetsFor(uuid);
      const shadowedEst = archivedOriginal.reduce((n, r) => n + estimateReplayTokens([r as never], this.agentId), 0);
      if (shadowedEst <= keepBudgetOf(budgetsNow) * 2) return; // 未超回收阈——只落事件
      if (archivedOriginal.length === 0) return; // 零移出（尾部水位未越）——只滚摘要
      // 尾部保留 = 引用不在归档集的行 + compaction 事件行（永留主日志——
      // 边界前的机制行不随 shadowed 前缀搬移，audit 面跨轮在场）。cr-1155：
      // 引用对齐统一口径——无 seq v1 行按位置进出，与归档集互补成全划分。
      const keepRows = rows.filter((r) => !archivedSet.has(r) || isCompactionRow(r));
      const report = await ledger.compactFor(uuid, {
        archive: archivedOriginal,
        keep: keepRows,
        baselineSeq: baselineSeq > 0 ? baselineSeq : undefined,
        compress: true,
      });
      this.ctx.logger.info(
        '[archive] 已归档 ' + report.archived + ' 条 → ' + (report.segment ?? '') + '（压缩段；保留尾部 ' + report.kept + ' 条）',
      );
      return;
    }
    const split = splitForArchive(rows, budgets, lastArchived);
    const baselineSeq = rows.reduce((m, r: LedgerRow) => Math.max(m, r.seq ?? 0), 0);
    const report = await ledger.compactFor(uuid, {
      archive: split.archive,
      keep: split.keep,
      baselineSeq: baselineSeq > 0 ? baselineSeq : undefined,
      ...(summary !== undefined ? { summary } : {}),
    });
    if (report.archived > 0) {
      this.ctx.logger.info(
        '[archive] 已归档 ' + report.archived + ' 条 → ' + (report.segment ?? '') + '（保留尾部 ' + report.kept + ' 条）',
      );
    }
  }

  // ============================================================
  // 批量唤醒信面（archive-all——timers 机制任务的信面形态，D11）
  // ============================================================

  /**
   * 批量归档本域全部达阈值会话（archive-all 唤醒信到达）：枚举
   * agents/<id>/sessions/ → 逐桶阈值检测（maybeArchive 幂等串行）。
   * 无注册表面（A13）——宿主只发信，判定与执行全在壳内。
   */
  async archiveAll(): Promise<Array<{ conversationId: string; skipped?: boolean; reason?: string }>> {
    const report: Array<{ conversationId: string; skipped?: boolean; reason?: string }> = [];
    const sessionsDir = path.join(this.dataRoot, 'agents', this.agentId, 'sessions');
    let uuids: string[] = [];
    try {
      uuids = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // 域目录缺席 = 无会话
    }
    for (const uuid of uuids) {
      if (!uuid.split('~').includes(this.agentId)) continue; // 非本域端点会话不编排
      if (this.pending.has(uuid)) {
        report.push({ conversationId: uuid, skipped: true, reason: 'pending' });
        continue;
      }
      const threshold = thresholdOf(this.budgetsFor(uuid));
      if (this.activeTokensOf(uuid) < threshold) {
        report.push({ conversationId: uuid, skipped: true, reason: 'below-threshold' });
        continue;
      }
      void this.requestArchive(uuid).catch((err: unknown) => {
        this.ctx.logger.warn('[archive] 批量归档失败（' + uuid + '）: ' + String(err));
      });
      report.push({ conversationId: uuid });
    }
    return report;
  }
}

/** archive 行工厂（boot rowAssemblers 装配——行集含 archive 才挂） */
export function makeArchiveRow(options: ArchiveRowOptions): Plugin {
  return {
    name: 'shell-archive-row',
    inject: ['ledger'],
    apply(ctx: Context) {
      ctx.plugin(class extends ArchiveShellService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
