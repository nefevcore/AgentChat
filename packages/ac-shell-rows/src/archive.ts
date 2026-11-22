// ============================================================
// archive.ts —— 归档编排行（D11 裁决：archive 全壳内）
//
// 主线 ac-archive 服务编排半边的壳内形态（算法半边复用主线
// ac-archive-core 纯库零改动）。cr-1189 V3（注入驱动 + 结构化提交）：
//   · 触发检测 = 机制注册式（registerTrigger）——run 收束后遍历注册表
//     （任一命中即触发；token 阈值为缺省注册，现行口径平移）；
//   · 整理轮 = 机制信经 conversation.deliver 唤醒的普通 run（请求注入
//     行 + 机制信封；排队/steer 语义免费），终稿照常落账进会话流；
//   · 总结提交 = session_digest 工具参数（唯一提交面——零格式门槛，
//     长度仅提示引导）；run 收束后从 run 事实捞调用参数落摘要注入行
//     （archive-summary，单一事实源——回放头随 fold 单源置首）；
//   · 无 digest = 「无新总结压缩」（合法态）：边界照落、摘要行不落、
//     回放头沿用上一代——亲写 summary.md 与终稿启发式随 V2 退役；
//   · 归档重建 = splitForArchive 分割 + ctx.ledger.compactFor（物理
//     面归账本 writer——写权 = 账本所有权 D4，本壳只写自己域）；
//   · 批量唤醒信（archive-all，timers 机制任务）：枚举本域会话逐桶
//     触发检测（宿主零 archive 职责——A13/D11）；
//   · 失控防线：maxSteps 硬上限随 run 装配（用户配置）+ 编排超时兜底
//     （等待窗 + 60s 缓冲后落边界）。
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
  SUMMARY_TOKEN_CAP,
  estimateReplayTokens,
  keepBudgetOf,
  splitForArchive,
  thresholdOf,
  type ArchiveBudgets,
} from 'ac-archive-core';
import type { ToolCall, ToolResult } from 'ac-tools';
import { estimateTokens } from 'ac-text-budget';
import { ARCHIVE_SUMMARY_SOURCE, foldDigestOf, foldSession, foldStepsOf, foldSummaryOf, readDomainFacts, readLedger, rowShadowedBy, summaryTextOf, type LedgerRow } from 'ac-ledger';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 归档完成广播（emit；cr-1188）：归档编排（整理 run + 逻辑压缩/物理回收）
     * 全部收束。壳 boot 侧监听转 event 帧上行，宿主直转同名前端帧——前端
     * 归档 pending 收口（pendingArchiveConv 复位）与会话流刷新唯一驱动源。
     * 载荷与主线 archive/completed 前端帧同形（chat-core onSessionArchived
     * args[0]）。
     * @mode emit
     * @scope archive
     */
    'archive/completed'(payload: { agentId: string; conversationId: string; archived: number }): void;
  }
}

/**
 * 归档触发器（cr-1189 V3 机制注册式）：run 收束后逐会话求值，任一命中
 * 即进入压缩流程（OR 语义）。注册沿 registerPromptSection 范式——
 * ctx.archive.registerTrigger，随行 fiber 归属自动回收；缺省注册
 * token-threshold（V2 现行口径平移）。
 */
export interface ArchiveTrigger {
  /** 触发器 id（诊断/去重） */
  id: string;
  /** 触发器描述（诊断面） */
  description?: string;
  /** 适用面谓词（缺省全适用）；触发器自声明——如 run-count 只 appliesTo 自会话桶 */
  appliesTo?: (uuid: string) => boolean;
  /** 触发判定（ctx 字段随注册面扩展） */
  shouldTrigger: (ctx: { uuid: string; activeTokens: number; runCountSinceCompaction: number; lastRunAt: number; ledgerBytes: number }) => boolean;
}

export interface ArchiveRowOptions {
  dataRoot: string;
  agentId: string;
  /** 整理轮编排等待窗（超时后宽限即兜底落边界——不 abort，run 自然收束） */
  timeoutMs?: number;
  /** 预算缺省（per-Agent settings['archive'] 覆盖） */
  defaults?: Partial<ArchiveBudgets>;
}

const REVIEW_TIMEOUT_MS = 10 * 60_000;
/** 编排等待窗超时后的缓冲（run 自然收束的宽限——超时兜底不 abort，只等） */
const REVIEW_GRACE_MS = 60_000;
/** 整理轮 runId 前缀（机制信封 requestId 'archive-run-*' → run-*）——触发检测跳过自身 */
const REVIEW_RUN_PREFIX = 'run-archive-run-';

/**
 * 账本字节硬上限系数（cr-1206 失控防线）：token 估算是启发式，任何一行
 * 未被估算面覆盖（未知 type 大载荷 / 未来新行型）都会让它系统性偏低。
 * 落盘字节是硬事实——按 8 字节/token 的宽松上界折算，超 thresholds×该
 * 系数即视为超阈，保证「估算漏计」不会让归档失去入口（news~news 现场：
 * 估算 12.7 万 / 真实 105 万，14.2MB 账本连续 6 天不触发直至 400）。
 * 8 的取法：回放 JSON 行实测 5~13 字节/token（CJK 3 字节/字 × 0.6 token
 * 或 ASCII 转义膨胀），取上界更宽的 8 → 只会「更早触发」，不会误伤小额会话。
 */
const LEDGER_BYTES_PER_TOKEN = 8;

/** 归档编排便（单会话串行——同桶并发触发幂等去重） */
export class ArchiveShellService extends Service {
  private dataRoot: string;
  private agentId: string;
  private timeoutMs: number;
  private defaults: ArchiveBudgets;
  /** 进行中的归档（uuid → 机制信封 requestId——编排等待窗 + 幂等去重） */
  private pending = new Map<string, string>();
  /** 触发器注册表（cr-1189 机制注册式——token 阈值缺省注册，V2 口径平移） */
  private triggers: ArchiveTrigger[] = [
    {
      id: 'token-threshold',
      description: '活跃上下文 token 超阈值（V2 缺省口径）',
      shouldTrigger: (t) => t.activeTokens > thresholdOf(this.budgetsFor(t.uuid)),
    },
    {
      id: 'ledger-bytes',
      description: '账本落盘字节超硬上限（估算兜底——token 估算漏计不得让归档失去入口）',
      shouldTrigger: (t) => t.ledgerBytes > thresholdOf(this.budgetsFor(t.uuid)) * LEDGER_BYTES_PER_TOKEN,
    },
  ];
  /** digest 调用登记簿（uuid → text；工具观察面填、收束捞取消费——
   * 键控会话防多桶并发归档时串味） */
  private digestCommits = new Map<string, string>();

  constructor(ctx: Context, options: ArchiveRowOptions) {
    super(ctx, 'archive');
    this.dataRoot = options.dataRoot;
    this.agentId = options.agentId;
    this.timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS;
    this.defaults = { ...DEFAULT_ARCHIVE_BUDGETS, ...options.defaults };

    // 触发检测（run 收束后，cr-1189 机制注册式）：非整理 run 且会话键含本
    // agent → 遍历触发器注册表（任一命中即触发）。会话键门（主线 M19
    // 对桶门同义）：本壳只管自己是端点的会话——uuid 两端（a~b / a~a）
    // 或单键 = 本 agent 即检测。
    ctx.on('loop/after-run', (request: LoopRunRequest, result: LoopRunResult) => {
      if (request.agent !== this.agentId) return;
      const uuid = request.conversationId;
      if (uuid === undefined || !uuid.split('~').includes(this.agentId)) return;
      if (request.runId !== undefined && request.runId.startsWith(REVIEW_RUN_PREFIX)) return; // 整理轮与会话增长无关
      // 失败 run 同样进入阈值检测（2026-11-22 P1）：LLM 上下文超限后每次 run
      // 都以 400 收束——若失败 run 不触发，归档永无入口，上下文只增不减且
      // 不可自愈。阈值是资源事实（activeTokens 估算），与 run 成败无关；
      // 压缩轮自身失败也有「无 digest 压缩」合法路径兜底。
      void this.maybeArchive(uuid).catch((err: unknown) => {
        this.ctx.logger.warn('[archive] 触发检测失败（' + uuid + '）: ' + String(err));
      });
    }, { description: '归档触发检测（run 收束后——机制注册式）' });

    // session_digest 工具注册（cr-1189 §2.2——工具随 archive 行装配，
    // 全 Agent 恒有）：压缩轮 pending 标记在场时接收总结（唯一提交面），
    // 否则无副作用提示返回（防会话内被名字诱骗误调用）。长度不设硬闸
    // ——超建议值仅提示引导（per-Agent settings['archive'] 可调）。
    ctx.tools.register({
      name: 'session_digest',
      description: '仅在归档整理轮调用——收到压缩请求注入后，把整理结果作为唯一参数提交。会话内其他场景勿调用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '总结全文（自然语言；建议精炼覆盖关键决策、结论与待办）' } },
        required: ['text'],
      },
      execute: async (args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> => {
        const uuid = call.conversationId ?? '';
        if (uuid === '' || !this.pending.has(uuid)) {
          return { ok: false, error: 'session_digest 仅在归档整理轮可用（当前无进行中的压缩请求）。会话内请直接把总结写在回复正文里。' };
        }
        const text = typeof args.text === 'string' ? args.text : '';
        if (text.trim() === '') return { ok: false, error: 'text 不能为空——把整理结果全文作为参数提交。' };
        this.digestCommits.set(uuid, text);
        const cap = this.digestCapOf(uuid);
        if (estimateTokens(text) > cap) {
          return { ok: true, output: { committed: true, note: '总结已收录（偏长，下次可更精炼——建议 ' + cap + ' token 内）。' } };
        }
        return { ok: true, output: { committed: true } };
      },
    });
  }

  /**
   * 总结长度建议值（per-Agent settings['archive'].digestTokenCap 覆盖
   * 行缺省——提示引导面，非硬闸）。
   */
  private digestCapOf(uuid: string): number {
    const settings = this.archiveSettingsOf(uuid);
    const v = (settings as { digestTokenCap?: unknown } | null)?.digestTokenCap;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : SUMMARY_TOKEN_CAP;
  }

  /** 会话目录（本 agent 域——影子域经 ledger agentDirOf 同源；本行直接拼） */
  private sessionDir(uuid: string): string {
    return path.join(this.dataRoot, 'agents', this.agentId, 'sessions', uuid);
  }

  /** settings['archive'] 原值读面（缺省 undefined；直读不缓存——配置轴 =
   * 文件文集，与 shims settingsOf 同源） */
  private archiveSettingsOf(_uuid: string): Record<string, unknown> | undefined {
    try {
      const config = JSON.parse(fs.readFileSync(
        path.join(this.dataRoot, 'agents', this.agentId, 'config.json'), 'utf-8',
      )) as { settings?: Record<string, Record<string, unknown>> };
      const s = config.settings?.archive;
      if (s !== undefined && typeof s === 'object') return s;
    } catch {
      // 配置缺席 = 行缺省
    }
    return undefined;
  }

  /** 预算（per-Agent settings['archive'] 覆盖 > 行缺省；直读不缓存——
   * 配置轴 = 文件文集，与 shims settingsOf 同源） */
  private budgetsFor(uuid: string): ArchiveBudgets {
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const settings = this.archiveSettingsOf(uuid);
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
    // 版本判据 = 行面而非头行（archiveAndRebuild 同源，cr-1190 续修）：混合
    // 会话头行 version=1 永不重写，而行面已是 v2 事件行——按头行守门会让
    // 伪行（轨迹体积的全量载体）整代缺席。实测 news~news：估算 12.7 万 vs
    // 真实回放 105 万 token，阈值（自会话 20 万）恒不命中 → 归档永不触发。
    const hasV2Rows = (rows as unknown as Array<Record<string, unknown>>).some(
      (r) => r.type !== undefined || r.seq !== undefined,
    );
    if (facts.version >= 2 || hasV2Rows) {
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
    const fold = foldSession(this.dataRoot, uuid, [dir]);
    // cr-1191 V3 摘要单源：digest 行在场时其正文已在 picked 内（行计一次），
    // 不再加 summary 头——防双计（digest 行 agent_id=本域 agent，viewer 口径
    // 计入）；v2 存量代（事件摘要头单发）/v1（summary.md）才作头。
    const digest = foldDigestOf(fold);
    const summary = digest !== null ? '' : (foldSummaryOf(fold)?.text ?? summaryTextOf(dir));
    return estimateReplayTokens([...picked, ...pseudo], this.agentId, summary !== '' ? { summary } : {});
  }

  /** 触发检测 + 触发（run 收束后异步，cr-1189 机制注册式）：遍历触发器
   *  注册表（appliesTo 过滤后 OR 求值）——任一命中即进入压缩流程。
   *  ctx 数据面：activeTokens（V2 现行口径）/ runCountSinceCompaction
   *  （fold 压缩代边界后的 run-end 计数）/ lastRunAt。token-threshold
   *  缺省注册 = V2 阈值口径平移（行为等价回归锚）。 */
  async maybeArchive(uuid: string): Promise<void> {
    if (this.pending.has(uuid)) return; // 同拍去重（同一会话同拍至多一次）
    const ctx = this.triggerCtxOf(uuid);
    const hit = this.triggers.some((t) => (t.appliesTo?.(uuid) ?? true) && t.shouldTrigger(ctx));
    if (!hit) return;
    await this.requestArchive(uuid);
  }

  /** 触发器 ctx 数据面（首版字段——新字段按需加，注册式扩展点即在此） */
  private triggerCtxOf(uuid: string): { uuid: string; activeTokens: number; runCountSinceCompaction: number; lastRunAt: number; ledgerBytes: number } {
    const facts = readDomainFacts(this.sessionDir(uuid), this.agentId);
    // 最新压缩代边界（多域取最大 endTs——本域单写者视角取本域代即可）
    const lastGen = facts.compactions.at(-1);
    let runCount = 0;
    let lastRunAt = 0;
    for (const rf of facts.runs.values()) {
      const endTs = rf.end?.ts ?? 0;
      if (lastGen !== undefined && lastGen.endTs > 0 && endTs > 0 && endTs <= lastGen.endTs) continue; // 压缩前代 run 不计
      runCount += 1;
      if (endTs > lastRunAt) lastRunAt = endTs;
    }
    return {
      uuid,
      activeTokens: this.activeTokensOf(uuid),
      runCountSinceCompaction: runCount,
      lastRunAt,
      ledgerBytes: this.ledgerBytesOf(uuid),
    };
  }

  /** 触发器注册（registerPromptSection 范式——随行 fiber 归属自动回收） */
  registerTrigger(trigger: ArchiveTrigger): void {
    this.triggers.push(trigger);
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

  /** 账本落盘字节（ledger-bytes 触发器口径——估算兜底的硬事实面） */
  private ledgerBytesOf(uuid: string): number {
    try {
      return fs.statSync(path.join(this.sessionDir(uuid), 'messages.jsonl')).size;
    } catch {
      return 0; // 文件缺席 = 无账本
    }
  }

  /** cr-1188 完成广播（前端 pending 收口 / 会话流刷新驱动源） */
  private completedOf(uuid: string, archived: number): void {
    this.ctx.emit('archive/completed', { agentId: this.agentId, conversationId: uuid, archived });
  }

  /**
   * 请求归档（幂等，cr-1189 V3 注入驱动 + 结构化提交）：
   * ① 落请求注入行（context + source=archive-review-request——机制材料
   *     非 shadowed 面待压缩边界出清；wrapper 档进回放，压缩轮复读即见指令）
   *  → ② 机制信封经 conversation.deliver 投递（plan=run/queue/steered 随机
   *     器自判——busy 时 next-turn 排队不抢用户 run；requestId 同键幂等）
   *  → ③ 等待整理轮收束（等待窗 = 超时 + 宽限；不 abort——自然收束语义）
   *  → ④ 从 run 事实捞 session_digest 调用参数（digestCommits ∪ run 事实
   *     回捞）→ 捞到落摘要注入行（archive-summary，单一事实源）；没捞到
   *     = 无新总结压缩（合法态）
   *  → ⑤ archiveAndRebuild（边界 + stats 落 compaction 事件——无 summary 字段）
   *  → ⑥ 完成广播。
   * pending 标记生命周期：① 置位（uuid → requestId）、⑤ 前消费清除；
   * 工具守卫据它判定压缩轮上下文。
   */
  async requestArchive(uuid: string): Promise<void> {
    if (this.pending.has(uuid)) return;
    const requestId = 'archive-run-' + Date.now();
    this.pending.set(uuid, requestId);
    try {
      const requestedAt = Date.now();
      const conv = this.ctx.get('conversation', false) as
        | { deliver(agentId: string, inbound: string, options?: { sender?: string; source?: string; conversationId?: string; requestId?: string; timeoutMs?: number; notice?: boolean; mechanism?: boolean; budget?: number }): Promise<unknown> }
        | undefined;
      // 请求注入行落账（压缩轮指令的 durable 面——run 上下文复读自带）
      await this.ctx.ledger.deliverRow(uuid, [this.agentId], 'user', {
        role: 'context',
        source: 'archive-review-request',
        content: this.reviewPrompt(uuid),
        label: '归档整理请求',
        agent_id: this.agentId,
        requestId,
        uuid,
      });
      let runId = 'run-' + requestId;
      if (conv !== undefined) {
        try {
          await conv.deliver(this.agentId, this.reviewPrompt(uuid), {
            sender: this.agentId,
            source: 'event',
            conversationId: uuid,
            requestId,
            timeoutMs: this.timeoutMs,
            mechanism: true,
            budget: 3,
          });
        } catch (err: unknown) {
          this.ctx.logger.warn('[archive] 整理轮投递失败（' + uuid + '）: ' + String(err));
        }
        await this.waitForReviewRun(uuid, runId, requestedAt);
      } else {
        this.ctx.logger.warn('[archive] conversation 服务缺席——整理不可用，直接归档（总结不动）');
      }
      // digest 捞取：登记簿（壳内观察面）∪ run 事实回捞（跨重启/多路径兜底）。
      // cr-1192 调序：摘要行不在此落——编排内 compaction 事件先落（分界线锚
      // 自身位置），摘要随后落新代首行（详见 archiveAndRebuild）。
      const digest = this.takeDigestOf(uuid, runId);
      const archived = await this.archiveAndRebuild(
        uuid,
        requestedAt,
        digest !== undefined ? { text: digest, requestId: requestId + '-summary' } : undefined,
      );
      this.completedOf(uuid, archived); // cr-1188 完成广播——前端 pending 收口 / 会话流刷新
    } finally {
      this.pending.delete(uuid);
    }
  }

  /**
   * 等待整理轮收束（自然收束语义——不 abort）：等待窗 = timeoutMs + 宽限；
   * 每 500ms 轮询 run 事实的 run-end。收束/超窗/异常都放行（超窗 = 兜底
   * 落边界——run 若仍在途，其后落账的 digest 行属下一代语境，回放头由
   * 边界时刻维保护不误入）。
   */
  private async waitForReviewRun(uuid: string, runId: string, requestedAt: number): Promise<void> {
    const deadline = requestedAt + this.timeoutMs + REVIEW_GRACE_MS;
    const file = path.join(this.sessionDir(uuid), 'messages.jsonl');
    let seenMtime = 0;
    while (Date.now() < deadline) {
      // stat 门：mtime 未变不重解析账本（readDomainFacts 全文件解析，
      // 等待窗内 500ms 轮询 × 分钟级窗口的读放大闸）
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* 文件缺席 = run 未起步 */ }
      if (mtime !== seenMtime) {
        seenMtime = mtime;
        const facts = readDomainFacts(this.sessionDir(uuid), this.agentId);
        if (facts.runs.get(runId)?.end !== undefined) return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.ctx.logger.warn('[archive] 整理轮等待超窗（' + uuid + ' ' + runId + '）——兜底落边界');
  }

  /**
   * digest 捞取（cr-1189 唯一提交面）：① 登记簿命中（工具 execute 直写
   * ——守卫已保证 ok 调用必属 pending 中的该会话，消费即清）；② run 事实
   * 回捞（step/tool-call-result 行里 name='session_digest' 的结果 ok 面
   * → 同 run 的 tool-call 参数 + 结果 JSON 内嵌 text 取回——崩溃重启/
   * 登记簿缺席的兜底）。多取按 run 内序取最后一次（末次为终态）。
   */
  private takeDigestOf(uuid: string, runId: string): string | undefined {
    const committed = this.digestCommits.get(uuid);
    if (committed !== undefined) {
      this.digestCommits.delete(uuid);
      return committed;
    }
    // run 事实回捞兜底：run 的步级事件里找 session_digest 调用对
    const facts = readDomainFacts(this.sessionDir(uuid), this.agentId);
    const rf = facts.runs.get(runId);
    if (rf === undefined) return undefined;
    const calls = new Map<string, string>();
    for (const ev of rf.events) {
      if (ev.kind === 'tool-call' && ev.name === 'session_digest') calls.set(ev.toolCallId, ev.arguments);
    }
    let last: string | undefined;
    for (const ev of rf.events) {
      if (ev.kind !== 'tool-call-result' || ev.name !== 'session_digest') continue;
      if (ev.result.ok !== true) continue;
      const text = this.digestTextOf(ev.result, calls.get(ev.toolCallId));
      if (text !== undefined) last = text;
    }
    return last;
  }

  /** digest 文本提取（结果 output 内嵌优先；缺参数结果面回落） */
  private digestTextOf(result: { ok: boolean; output?: unknown }, argsJson: string | undefined): string | undefined {
    const out = result.output as { text?: unknown } | undefined;
    if (typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string') {
      const text = (out as { text: string }).text;
      if (text.trim() !== '') return text;
    }
    if (argsJson !== undefined) {
      try {
        const parsed = JSON.parse(argsJson) as { text?: unknown };
        if (typeof parsed.text === 'string' && parsed.text.trim() !== '') return parsed.text;
      } catch { /* 坏参数 JSON——如实缺席 */ }
    }
    return undefined;
  }

  /**
   * 归档整理指令（cr-1189 V3 注入行正文——措辞按术语分层用「归档整理」
   * 「总结」；§2.6 首轮膨胀缓解：写明基于当前上下文与既有总结整理，不必
   * 逐条回读）。会话键显式给出（Agent 无从推导键词法）。
   * cr-1190 续修：删「整理工作文件」（TODO.md/DONE.md/note/）条目——主线
   * ac-archive 时代遗物：TODO 归 todo 工具、知识库归 memory 行，归档轮插手
   * = 双事实源 + 每轮固定 2-3 步开销（DONE.md 实测滚至 268KB 无出清机制）。
   */
  private reviewPrompt(uuid: string): string {
    const budget = Math.max(400, Math.ceil(this.budgetsFor(uuid).maxContextTokens * 0.004));
    const cap = this.digestCapOf(uuid);
    const self = uuid === this.agentId + '~' + this.agentId;
    // 对话方称呼（cr-1192 续修）：对桶键取对端 agent；single 会话键 = uuid
    // 形（无 ~、不含 agentId）——split('~') 单元素命中自身，此前把整段
    // uuid 当「对方」嵌进文案（现场：你与「01a1fe79-…」的会话）。single
    // 的对话方恒为用户，直呼「用户」。
    const pair = uuid.split('~');
    const other = !uuid.includes('~') ? '用户' : (pair.find((p) => p !== this.agentId) ?? '用户');
    const subject = self
      ? '此前运行日志（含已有总结覆盖的更早内容）的关键事件、推送结论、失败教训与待跟进事项'
      : '这段会话（含已有总结覆盖的更早内容）的关键决策、重要结论、用户偏好和待办事项';
    const head = self
      ? '[归档整理] 你的自会话运行日志（会话键 ' + uuid + '）需要滚动整理，早期机制触发记录即将移出会话流。请完成以下整理：'
      : '[归档整理] 你与「' + other + '」的会话（会话键 ' + uuid + '）已达到归档阈值，早期消息即将移出会话流。请在归档前完成以下整理：';
    return [
      head,
      '1. 【提交会话总结】基于当前上下文与既有总结整理（不必逐条回读），把' + subject + '，整理为一段自然语言（建议 ' + Math.min(cap, budget) + ' token 内），调用 session_digest 工具提交——text 参数即总结全文，这是唯一提交面（不写文件、不必贴在回复正文）。',
      'context 注入行（记忆快照/技能注入等）是机制材料，不属于会话事实，无需纳入总结。',
      '这是机制任务：不要发起对话、不要等待回复；提交总结后简短确认即可，系统会自动归档。',
    ].join('\n');
  }

  /**
   * 归档重建：读账本 → splitForArchive 分割（ac-archive-core）→ 落语义
   * 边界（v2：compaction 事件）→ ctx.ledger.compactFor（分段 + 重写 +
   * 概要滚动）。概要缺省（整理失败/降级）= 概要不动。返回归档条数
   *（逻辑 shadow 域行数——未回收路径行留主日志但回放已排除；cr-1188
   * 完成广播载荷）。
   * cr-974 v2（§2.3 压缩事件化 + S5 物理回收）：分割在富化行（伪段行
   * 承载步级体积）上计量；shadowed 前缀 = 原 rows 中 seq ≤ boundary 的
   * 全部行（相位/收束行随迁——append-only 真序整体搬移），整段单流 gzip
   * 落 archive/history_N.jsonl.gz（Node 24.18 无 zstdSync，回落 gzip 如实
   * 命名）；主日志保留 = header + compaction 事件（经 B1 窗口 late-merge
   * 自然留存——audit 面永在）+ 尾部行。v1 会话走原 compact 流程不动。
   */
  async archiveAndRebuild(uuid: string, requestedAt: number, summary?: { text: string; requestId: string }): Promise<number> {
    const ledger = this.ctx.ledger;
    const dir = this.sessionDir(uuid);
    const { header, rows } = readLedger(dir);
    if (rows.length === 0) return 0;
    const anchor = ledger.archiveAnchorOf(uuid);
    const budgets = this.budgetsFor(uuid);
    const lastArchived = anchor !== null && anchor.seq !== undefined
      ? { seq: anchor.seq, message_id: anchor.messageId, role: '', content: '' }
      : null;
    // 版本判据 = 行面而非头行（cr-1190 续修：v1 头行会话后续追加 v2 判别行合法
    // ——writer.ts「头行永不重写」。按头行分流会让 v1 分支拿到 90% content 空的
    // v2 事件行：content-only 截断把全表当零成本尾部吃尽 → archive 恒空、边界
    // 恒不落（user~writer 实锤：734 行 662 空 content，整理轮跑了两次零归档）。
    // 行面出现任一 v2 判别行（type/seq）即走 v2 语义——与 events-v2 归一化
    // 「按行判别」同源；纯 v1 行（无 type 无 seq）才留 v1 分支。
    const hasV2Rows = rows.some((r) => r.type !== undefined || r.seq !== undefined);
    if ((header?.version ?? 1) >= 2 || hasV2Rows) {
      // 富化行（估算/水位计量面）——分割边界取回原 rows 的 seq 锚。
      // cr-1206：伪行按 run 末事实 seq 插入**时间序**（不是尾部追加）——
      // 尾部追加会让 keep 预算被伪行整块吃尽：最近的真实会话行全部进归档段，
      // 而伪行本身不可持久（物理回收后由 run 事实重建，事实已随段搬走）→
      // 回放只剩旧摘要、整段历史蒸发（news~news 实测：keep 63 行全伪行，
      // 回收后回放 1 条 1390 字旧摘要）。时间序下 keep 保留的是真实尾行，
      // 其 run 事实随之留在主日志，伪行可在回放时自然重建。
      const facts = readDomainFacts(dir, this.agentId);
      const pseudoByRun = new Map<string, LedgerRow>();
      const lastSeqByRun = new Map<string, number>();
      for (const [run, rf] of facts.runs) {
        const steps = foldStepsOf(rf, facts.subcallArchive.filter((s) => s.run === run))?.steps ?? [];
        if (steps.length === 0) continue;
        pseudoByRun.set(run, { role: 'agent', content: '', agent_id: this.agentId, run, steps, message_id: 'v2-' + run, timestamp: '' } as LedgerRow);
        let last = 0;
        for (const ev of rf.events) if (ev.seq !== undefined && ev.seq > last) last = ev.seq;
        if (last > 0) lastSeqByRun.set(run, last);
      }
      const runsEndingAt = new Map<number, string[]>();
      for (const [run, seq] of lastSeqByRun) {
        const bucket = runsEndingAt.get(seq);
        if (bucket !== undefined) bucket.push(run);
        else runsEndingAt.set(seq, [run]);
      }
      const enriched: LedgerRow[] = [];
      const flushed = new Set<string>();
      for (const r of rows) {
        enriched.push(r);
        if (typeof r.seq !== 'number') continue;
        for (const run of runsEndingAt.get(r.seq) ?? []) {
          const pseudoRow = pseudoByRun.get(run);
          if (pseudoRow !== undefined && !flushed.has(run)) {
            enriched.push(pseudoRow);
            flushed.add(run);
          }
        }
      }
      for (const [run, pseudoRow] of pseudoByRun) {
        if (!flushed.has(run)) enriched.push(pseudoRow); // 无 seq 事实的 run：尾部兜底
      }
      // viewer 必传（cr-1190 续修 2）：缺省 content-only 会让伪行（content=''
      // 轨迹全在 steps）est=0——truncateTail 零成本吃完全表 → archive 恒空、
      // boundary=0（user~writer 实锤：伪行真实体积 32.5 万 token 全漏计）。
      // 传 viewer 后尾部预算按回放口径（轨迹展开）计量，与 estimateOf 同源。
      const split = splitForArchive(enriched as never[], budgets, lastArchived, { viewer: this.agentId });
      // cr-1155 归档对齐口径修正：split 切片是 enriched 数组的引用切片——
      // 用引用集对齐（位置语义）替代 seq 集匹配，无 seq 的 v1 存量行按其
      // 文件位置自然进归档集/保留集，不再被 (seq ?? Infinity) 永久钉在主日志
      // （僵尸行：穿越任意多次 compaction 不离场——ac-memory 锚曾因 v1 行
      // 永踞 recordsFor 投影尾部而 S 冻结、每 run 重注）。
      const archivedSet = new Set<unknown>(split.archive);
      // compaction 事件 + archive-summary 行永留主日志（§2.3 可审计可重建；
      // cr-1189：摘要行是回放头事实源——foldDigestOf 读主日志 contexts，物理
      // 搬走 = 下一代刷新后回放头蒸发。请求行/机制信行照常随代出清）。
      // 其 run-end 同留——机制标记）
      // cr-1192 同源补充：单事件形态（cr-1160 起现行写法）type='compaction'
      // 不被 'compaction/' 前缀匹配——旧谓词只认三连形态（compaction/start|summary|end），
      // 致单事件行可能被计入 archivedOriginal（推高 boundary → 无提交代时
      // 盖过上一代摘要行 = 回放头蒸发）或随归档段搬离主日志（边界事实丢失，
      // fold.compactions 少代）。机制行谓词按词汇全族收口。
      const compactionRuns = new Set(rows
        .filter((r) => {
          const t = String((r as { type?: unknown }).type ?? '');
          return t === 'compaction' || t.startsWith('compaction/');
        })
        .map((r) => (r as { run?: unknown }).run));
      const isCompactionRow = (r: LedgerRow): boolean => {
        const t = String((r as { type?: unknown }).type ?? '');
        if ((r as { source?: unknown }).source === ARCHIVE_SUMMARY_SOURCE) return true;
        return t === 'compaction' || t.startsWith('compaction/') || (t === 'run-end' && compactionRuns.has((r as { run?: unknown }).run));
      };
      const archivedOriginal = rows.filter((r) => archivedSet.has(r) && !isCompactionRow(r));
      const baselineSeq = rows.reduce((m, r: LedgerRow) => Math.max(m, r.seq ?? 0), 0);
      // boundary 从 archivedOriginal（真行、机制行已排除）取 max——不从
      // split.archive 取（cr-1190 续修 3）：split 集含伪行与刚落账的摘要行
      //（伪行尾部追加使摘要行位置落进归档段），boundary 盖过摘要行 = 自
      // shadow、回放头蒸发。排除后 boundary ≤ 摘要行 seq-1，天然不 shadow。
      // cr-1192 小会话兜底（调序版）：估算 < 尾部保留预算（keep 覆盖全表）时
      // archivedOriginal 为空 → V2 残留语义给 boundary=0 = 零 shadow，V3 下
      // 事件已落即逻辑生效，宣称归档却不出清（现场 01a1fe79 两代 boundary=0，
      // 回放全量且请求行/摘要行逐代堆积）。修：有新摘要时 boundary = 事件前
      // 全表 max seq（baselineSeq）——摘要即将落于事件之后（新代首行），全部
      // 旧内容（含请求行、旧代摘要行、整理轮轨迹）出清；无摘要可锚（无提交
      // 退化）保持 archivedMaxSeq 只滚事件——强行出清会丢记忆。分界线语义：
      // 锚自身位置（事件行落点前的末行），不回读事件之后的行。
      const archivedMaxSeq = archivedOriginal.reduce((m, r: LedgerRow) => Math.max(m, r.seq ?? 0), 0);
      const boundary = Math.max(
        lastArchived?.seq ?? 0,
        archivedMaxSeq,
        summary !== undefined && archivedOriginal.length === 0 ? baselineSeq : 0,
      );
      // 语义边界先 durable（cr-1160 P1 单事件 + cr-1189 V3：**不携带 summary
      // 字段**——摘要全文住 archive-summary 注入行，单一事实源；无新总结压缩
      // 时摘要行缺席、回放头沿用上一代。stats 随行审计面。摘要滚动即使零移出
      // 也落事件——边界即刻生效）
      await ledger.compactionFor(uuid, requestedAt + '-compaction-' + uuid, {
        shadowedSeq: boundary,
        stats: { shadowedRows: archivedOriginal.length, estimatedTokens: this.estimateOf(uuid) },
      });
      // cr-1192 调序：compaction 事件先落（分界线就位），摘要行随后落账——
      // 新代首行，seq 天然 > boundary（时刻维双保险：ts > endTs 恒 kept），
      // 分界线不再回读摘要行位置。
      if (summary !== undefined) {
        await ledger.deliverRow(uuid, [this.agentId], 'user', {
          role: 'context',
          source: ARCHIVE_SUMMARY_SOURCE,
          content: summary.text,
          label: '归档总结',
          agent_id: this.agentId,
          requestId: summary.requestId,
          uuid,
        });
      }
      // cr-1160 物理解耦：逻辑压缩（事件）与物理回收（重写）分离——影子估算
      // 超回收阈（shadowed tokens > keep 水位 × 2）才搬尸骸；未超 = shadowed
      // 行留主日志（回放已滤，不占上下文），下次触发再评估。
      const budgetsNow = this.budgetsFor(uuid);
      const shadowedEst = archivedOriginal.reduce((n, r) => n + estimateReplayTokens([r as never], this.agentId), 0);
      if (shadowedEst <= keepBudgetOf(budgetsNow) * 2) return archivedOriginal.length; // 未超回收阈——只落事件（行已逻辑 shadow，回放排除）
      if (archivedOriginal.length === 0) return 0; // 零移出（尾部水位未越）——只滚摘要
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
      return report.archived;
    }
    const split = splitForArchive(rows, budgets, lastArchived);
    const baselineSeq = rows.reduce((m, r: LedgerRow) => Math.max(m, r.seq ?? 0), 0);
    const report = await ledger.compactFor(uuid, {
      archive: split.archive,
      keep: split.keep,
      baselineSeq: baselineSeq > 0 ? baselineSeq : undefined,
    });
    if (report.archived > 0) {
      this.ctx.logger.info(
        '[archive] 已归档 ' + report.archived + ' 条 → ' + (report.segment ?? '') + '（保留尾部 ' + report.kept + ' 条）',
      );
    }
    return report.archived;
  }

  // ============================================================
  // 批量唤醒信面（archive-all——timers 机制任务的信面形态，D11）
  // ============================================================

  /**
   * 批量归档本域全部达阈值会话（archive-all 唤醒信到达）：枚举
   * agents/<id>/sessions/ → 逐桶触发检测（maybeArchive 幂等串行——
   * cr-1189 机制注册式，token 阈值为缺省注册之一）。
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
      if (!this.triggers.some((t) => (t.appliesTo?.(uuid) ?? true) && t.shouldTrigger(this.triggerCtxOf(uuid)))) {
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
    // tools 硬依赖（cr-1189）：session_digest 随行注册——构造器访问
    // ctx.tools，无 inject 声明的属性访问直接 throw（cr-639 同款教训）
    inject: ['ledger', 'tools'],
    apply(ctx: Context) {
      ctx.plugin(class extends ArchiveShellService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
