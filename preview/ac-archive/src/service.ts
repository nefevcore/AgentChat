// ============================================================
// ac-archive —— 归档编排服务（"先整理后归档"）
//
// src svc/archive 的服务编排半边（算法半边在 ac-archive-core 纯库）。
// M20 通道回归（回归"Agent 亲自整理"的原设计，对齐 src triggerReview）：
//   · 阈值检测 = 订阅 loop/after-run（emit 面，零侵入 loop）
//   · 整理 run = ctx.conversation.deliver 同桶投递（sender:'event' +
//     placement:'next-run'，对齐 src router.trigger 同会话键语义）：
//     与用户 run 共串行化门——忙时排队不并发，steer 覆盖/在途写竞态
//     随并发消失；工具面 = Agent 生效集（router 解析，写文件是任务的一部分）
//   · 不落盘 = 显式标记跳过（非绕开）：信封 meta[ARCHIVE_REVIEW_META]
//     （ac-agent-loop 导出，对齐 src META_ARCHIVE_REVIEW）三消费方各查——
//     ac-session 不入账 / ac-usage 不记账 / ac-conversation 不进上下文视图
//   · 输出物对齐 src：Agent 亲自 write/read summary/<会话>.md（概来源，
//     服务端读文件，D4）+ memory_rewrite 重写记忆 + TODO/DONE/note 同理
//   · 双侧整理（D5）：对桶两端非虚拟已注册端各跑一次（虚拟端仅 owning 侧，
//     对齐 src participants 语义）；done 协议全到齐才归档重建
//   · 收尾事件驱动：订阅 loop/after-run 识别 meta 标记 + agent + convId
//     → 写 done 标记 → 全参与者 done → archiveAndRebuild；
//     pending 超时兜底漏斗保留，兜底先 abort 在途整理 run 再强制归档
//   · 失控防线（M20 三道硬闸，缺一不可——2026-08-26 4GB 堆 OOM 教训）：
//     闸① maxSteps 硬上限（缺省 128，用户裁决；src"不设上限"是根因①）；
//     闸② 超时 abort（兜底超时先中止 run → finish='interrupted' 收束）；
//     闸③ 步级日志观测（source='event' 过滤了流式，日志是唯一观测面）
//   · 落盘全部经 owning service（ADR-5）：会话文件读写走
//     ctx.session.records/compact；归档分段/标记归本服务自有目录
//     <root>/archive/<conversationId>/
//   · 机制任务不过 LLM（规约 3）：archiveAll() 是 Service 方法，
//     timer 机制任务直调（淘汰 __archive_all__ 字符串协议）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import {
  DEFAULT_ARCHIVE_BUDGETS,
  estimateMessagesTokens,
  splitForArchive,
  thresholdOf,
  type ArchiveBudgets,
  type ArchiveMessage,
} from 'ac-archive-core';
import { ARCHIVE_REVIEW_META, type LoopRunResult } from 'ac-agent-loop';
import type { ConversationDeliverOptions, ConversationOutcome } from 'ac-conversation';
import { resolveToolNames } from 'ac-agents';
import type { SessionRecord } from 'ac-session';

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface ArchiveRowOptions {
  /** 归档数据根（缺省 './data'；归档分段 = <root>/archive/<conversationId>/） */
  root?: string;
  /** 预算缺省值（per-Agent 覆盖走 settings['archive']） */
  defaults?: Partial<ArchiveBudgets>;
  /**
   * 整理 run 超时兜底（缺省 10 分钟；超时 = abort 该会话在途整理 run →
   * finish='interrupted' 收束 → 强制归档）。
   */
  timeoutMs?: number;
  /** 残留扫描间隔（缺省 5 分钟） */
  scanIntervalMs?: number;
  /** 闸①：整理 run 步数硬上限（缺省 128——M20 用户裁决；src 不设上限即 OOM 根因①） */
  reviewMaxSteps?: number;
  /** 闸③：整理 run 步数软阈值（超过即告警；缺省 16） */
  reviewSoftSteps?: number;
}

/** 批量归档返回项 */
export interface ArchiveBatchItem {
  conversationId: string;
  skipped: boolean;
  reason?: string;
}

/** pending 标记（磁盘形态；done 协议参与者清单 + 崩溃后超时兜底） */
interface PendingMarker {
  /** owning agent（触发方；预算与概要文件读取基准） */
  agent: string;
  /** 参与整理的端点（对桶非虚拟已注册端；虚拟端折叠为单侧） */
  participants: string[];
  requestedAt: string;
}

/** 整理 run 完成态缓存（概要回退取回复文本；清理随标记回收） */
interface ReviewOutcome {
  finish: LoopRunResult['finish'];
  text: string;
}

/** 归档整理提示词前缀（UI 可据此显示"正在归档…"） */
const ARCHIVE_REVIEW_PREFIX = '[归档整理]';

/** 整理 run 完成态缓存键 */
function reviewKey(conversationId: string, agentId: string): string {
  return `${conversationId}\u0000${agentId}`;
}

/** 会话键 → 文件名安全形（对键/组 id 本就安全；防御外部手工调用） */
function fileNameSafe(conversationId: string): string {
  return conversationId.replace(/[/\\:*?"<>|\s]/g, '_');
}

export class ArchiveService extends Service {
  /**
   * 服务级依赖声明（构造期/事件闭包的 this.ctx 解析依据）：timer =
   * 官方 cordis-timer 的 ctx.interval（超时兜底扫描）；tools = 整理提示词
   * 的生效工具集探测；conversation = 整理 run 投递（方法体内另经
   * ctx.get 取 root-traced 引用，M12 铁律 2——deliver 是深链服务）。
   */
  static inject = ['timer', 'session', 'conversation', 'agents', 'tools'];

  private dataRoot: string;
  private archiveRoot: string;
  private defaults: ArchiveBudgets;
  private readonly timeoutMs: number;
  /** 扫描间隔（行配置；懒扫描周期） */
  private readonly scanIntervalMs: number;
  /** 闸①：整理 run 步数硬上限 */
  private readonly reviewMaxSteps: number;
  /** 闸③：步数软阈值（超过告警） */
  private readonly reviewSoftSteps: number;
  /** 进行中的归档（conversationId → 请求时刻）；幂等第一道闸 */
  private pending = new Set<string>();
  /** 整理 run 完成态（key = reviewKey；概要回退数据源） */
  private reviewOutcomes = new Map<string, ReviewOutcome>();
  /** 懒扫描句柄（有 pending 才存在——空闲零定时器，boot 自退） */
  private scanDispose?: () => void;

  constructor(ctx: Context, options: ArchiveRowOptions = {}) {
    super(ctx, 'archive');
    this.dataRoot = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    this.archiveRoot = path.join(this.dataRoot, 'archive');
    this.defaults = { ...DEFAULT_ARCHIVE_BUDGETS, ...options.defaults };
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.scanIntervalMs = options.scanIntervalMs ?? 5 * 60_000;
    this.reviewMaxSteps = options.reviewMaxSteps ?? 128;
    this.reviewSoftSteps = options.reviewSoftSteps ?? 16;

    // ---- 阈值检测 + 整理 run 完成收尾（订阅即归属：随本服务 fiber 卸载撤销） ----
    this.ctx.on('loop/after-run', (request, result) => {
      // 整理 run 完成 → done 协议收尾（事件驱动，对齐 src completeArchiveReview）
      if (request.meta?.[ARCHIVE_REVIEW_META] === true) {
        if (request.agent && request.conversationId) {
          void this.completeReview(request.conversationId, request.agent, result).catch(
            (err: unknown) => {
              this.ctx.logger.error(`[archive] 整理收尾失败（${request.conversationId}）: ${String(err)}`);
            },
          );
        }
        return; // 机制 run 与会话增长无关，不做阈值检测
      }
      const agentId = request.agent;
      const conversationId = request.conversationId;
      // M19 对桶门：run 的 Agent 是对桶端点之一（直答 user~x / 委托 a~b /
      // 自会话 a~a）即检测；群/独立会话键（无 ~）不自动归档（群另行）。
      if (!agentId || !conversationId) return;
      if (!conversationId.includes('~')) return;
      if (!conversationId.split('~').includes(agentId)) return;
      if (this.pending.has(conversationId)) return;
      void this.maybeArchive(agentId, conversationId).catch((err: unknown) => {
        this.ctx.logger.error(`[archive] 阈值检测失败（${conversationId}）: ${String(err)}`);
      });
    }, { description: '归档阈值检测（按会话消息估算触发整理 run）' });

    // ---- 闸③：整理 run 步级观测（source='event' 过滤了流式，日志是唯一观测面） ----
    this.ctx.on('loop/step-started', (agent, index, messages, envelope) => {
      if (envelope?.source !== 'event' || envelope.conversationId === undefined) return;
      if (!this.pending.has(envelope.conversationId)) return;
      const chars = messages.reduce((n, m) => {
        const c = m.content;
        return n + (typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length);
      }, 0);
      this.ctx.logger.info(
        '[archive] 整理步进 agent=%C conv=%C step=%C/%C 上下文≈%C 字符',
        agent ?? '-',
        envelope.conversationId,
        String(index + 1),
        String(this.reviewMaxSteps),
        String(chars),
      );
      if (index + 1 > this.reviewSoftSteps) {
        this.ctx.logger.warn(
          '[archive] 整理 run 步数 %C 已超软阈值 %C（硬上限 %C）——检查整理提示词与工具面',
          String(index + 1),
          String(this.reviewSoftSteps),
          String(this.reviewMaxSteps),
        );
      }
    }, { description: '整理 run 步级观测（上下文估算 + 软阈值告警）' });

    // ---- 超时兜底（启动即扫一次；周期扫描懒拉起——见 syncScan） ----
    void this.scanPending();
  }

  /**
   * 懒扫描：内存 pending 或盘上残留标记存在时才有周期扫描。
   * 空闲（无归档进行/残留）零定时器——进程可自退。
   */
  private syncScan(): void {
    const need = this.pending.size > 0 || this.hasDiskMarkers();
    if (need && !this.scanDispose) {
      this.scanDispose = this.ctx.interval(() => void this.scanPending(), this.scanIntervalMs);
    } else if (!need && this.scanDispose) {
      this.scanDispose();
      this.scanDispose = undefined;
    }
  }

  /** 盘上是否有 pending 标记（崩溃残留检测） */
  private hasDiskMarkers(): boolean {
    try {
      return fs
        .readdirSync(this.archiveRoot, { withFileTypes: true })
        .some((d) => d.isDirectory() && fs.existsSync(path.join(this.archiveRoot, d.name, '.pending.json')));
    } catch {
      return false;
    }
  }

  /** 预算（per-Agent settings['archive'] 覆盖 > 行缺省；M24 A1 合成全局默认层） */
  private budgetsFor(agentId: string): ArchiveBudgets {
    const settings = this.ctx.agents.settingsOf(agentId, 'archive');
    if (settings && typeof settings === 'object') {
      const h = settings as Partial<ArchiveBudgets>;
      const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      return {
        maxContextTokens: num(h.maxContextTokens, this.defaults.maxContextTokens),
        archiveTokenRatio: num(h.archiveTokenRatio, this.defaults.archiveTokenRatio),
        keepRecentRatio: num(h.keepRecentRatio, this.defaults.keepRecentRatio),
      };
    }
    return this.defaults;
  }

  /** 阈值检测：估算超阈值 → 请求归档（触发依据 = 会话消息估算，非 usage） */
  private async maybeArchive(agentId: string, conversationId: string): Promise<void> {
    const records = await this.ctx.session.records(conversationId);
    const threshold = thresholdOf(this.budgetsFor(agentId));
    if (estimateMessagesTokens(records) <= threshold) return;
    this.ctx.logger.info(
      `[archive] 超阈值触发归档 ${conversationId}（估算 ${estimateMessagesTokens(records)} / 阈值 ${threshold}）`,
    );
    await this.requestArchive(conversationId, agentId);
  }

  // ============================================================
  // 请求归档（标记 + 双侧整理投递 + done 协议收尾）
  // ============================================================

  /**
   * 请求归档（幂等：pending 已存在则跳过）：
   * 写 pending 标记（含参与者清单）→ 逐参与者投递整理 run
   * （conversation.deliver 同桶 next-run，串行化门排队）→ 完成由
   * loop/after-run 事件驱动 done 协议收尾（全参与者 done → 归档重建）。
   * 超时/崩溃残留由 scanPending 兜底（abort 在途 run + 强制归档）。
   */
  async requestArchive(conversationId: string, agentId: string): Promise<void> {
    if (this.pending.has(conversationId)) return;
    this.pending.add(conversationId);
    this.syncScan(); // 整理进行中 → 拉起周期扫描（挂死兜底）
    const participants = this.participantsOf(conversationId);
    const marker = this.markerPath(conversationId);
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(
        marker,
        JSON.stringify({
          agent: agentId,
          participants,
          requestedAt: new Date().toISOString(),
        } satisfies PendingMarker),
        'utf-8',
      );
    } catch (err: unknown) {
      // 标记写失败：done 协议无锚点，直接降级归档（无概要）
      this.ctx.logger.warn(`[archive] pending 标记写入失败（降级直归档）: ${String(err)}`);
      this.pending.delete(conversationId);
      this.syncScan();
      await this.archiveAndRebuild(conversationId, agentId).catch(() => {
        /* 降级归档失败由下次触发重试 */
      });
      return;
    }
    if (participants.length === 0) {
      // 无可整理端点（桶端全虚拟/缺模型/未注册）→ 无整理直接归档
      this.ctx.logger.info(`[archive] ${conversationId} 无可整理端点，直接归档（概要不动）`);
      await this.archiveAndRebuild(conversationId, agentId).catch((err: unknown) => {
        this.ctx.logger.error(`[archive] 归档重建失败（${conversationId}）: ${String(err)}`);
      });
      this.cleanupMarkers(conversationId, []);
      return;
    }
    this.ctx.logger.info(
      `[archive] 归档请求：${conversationId} 参与整理 ${participants.join(', ')}（owning=${agentId}）`,
    );
    for (const p of participants) {
      void this.triggerReview(conversationId, p).catch((err: unknown) => {
        // 投递失败（未知 Agent/构造异常）→ 降级写 done，不阻塞归档漏斗
        this.ctx.logger.warn(`[archive] 整理 run 投递失败（${p}/${conversationId}）: ${String(err)}`);
        void this.completeReview(conversationId, p, {
          steps: [],
          text: '',
          finish: 'error',
          error: String(err),
          usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
        }).catch(() => {
          /* 降级收尾失败由兜底扫描处理 */
        });
      });
    }
  }

  /**
   * 对桶参与者（D5 双侧整理）：两端中已注册、非虚拟且有模型的端点
   * （可跑整理 run 者）；虚拟/未注册端折叠（src：虚拟端仅 agent 侧）。
   * 非 ~ 键（独立会话/旧 agentId 桶）= 键本身可跑则单侧。
   */
  private participantsOf(conversationId: string): string[] {
    const endpoints = conversationId.includes('~')
      ? conversationId.split('~')
      : [conversationId];
    return endpoints.filter((p) => {
      const agent = this.ctx.agents.get(p);
      return agent !== undefined && !agent.virtual && !!agent.model;
    });
  }

  /**
   * 投递单个整理 run（对齐 src triggerReview；fire-and-forget，完成由
   * loop/after-run 事件驱动）。同桶 conversation.deliver：串行化门排队
   * （忙时 next-run，不与用户 run 并发）、信封带 meta 标记（三处不落盘）、
   * maxSteps 硬闸（闸①）。
   */
  private async triggerReview(conversationId: string, agentId: string): Promise<void> {
    const agent = this.ctx.agents.require(agentId);
    if (!agent.model || agent.virtual) {
      throw new Error(`agent "${agentId}" 无可用模型（virtual 或缺 model，不能跑整理 run）`);
    }
    // viewer=整理 Agent（M21/F3）：回放按读者投影——"你与 X 的会话"提示词
    // 天然是整理 Agent 视角（自己的话 assistant）；含既有概要头
    const history = await this.ctx.session.history(conversationId, { viewer: agentId });
    const other = conversationId.split('~').find((p) => p !== agentId) ?? 'user';
    const prompt = this.reviewPrompt(conversationId, agentId, other);
    // M12 铁律 2：deliver 是深链服务（内部还要 router→loop→tools/llm），
    // 经 ctx.get 取 root-traced 无限制引用——受限 fiber 链（本服务 inject
    // 表）解析不到它的传递依赖。
    const conversation = this.ctx.get('conversation') as {
      deliver(
        agentId: string,
        inbound: { role: 'user'; content: string },
        options: ConversationDeliverOptions,
      ): Promise<ConversationOutcome>;
    };
    const outcome = await conversation.deliver(
      agentId,
      { role: 'user', content: prompt },
      {
        conversationId, // 同桶：与用户 run 共串行化门
        sender: agentId, // 机制触发 = 目标自身（自会话语义）
        source: 'event',
        placement: 'next-run', // 忙时排队（对齐 src triggerPlacementOf）
        meta: { [ARCHIVE_REVIEW_META]: true }, // 三处不落盘标记（D2）
        maxSteps: this.reviewMaxSteps, // 闸①：失控防线步数硬上限
        history, // 会话无内存视图时以会话记录播种（继续会话语义）
        timeoutMs: this.timeoutMs, // 等空闲上限 = 兜底超时；等不到交兜底漏斗
      },
    );
    if (outcome.kind === 'timeout') {
      this.ctx.logger.warn(
        `[archive] 整理 run 等待会话空闲超时（${agentId}/${conversationId}）——交由 pending 兜底强制归档`,
      );
    }
  }

  /** 概要字数预算（≈4‰ 上下文；下限 400 防小阈值配置把概要挤成零头） */
  private summaryBudgetChars(agentId: string): number {
    return Math.max(400, Math.ceil(this.budgetsFor(agentId).maxContextTokens * 0.004));
  }

  /**
   * 整理提示词（对齐 src triggerReview 提示词：Agent 亲自整理，机制回归）：
   * 概要 = Agent 亲自 write summary/<会话>.md（D4，服务端读文件）；
   * 记忆 = memory_rewrite 重写（不要只追加）；TODO/DONE/note 同理。
   * 各分支按 Agent 生效工具集自适应（缺 write 回退"回复即概要"）。
   */
  private reviewPrompt(conversationId: string, agentId: string, other: string): string {
    const agent = this.ctx.agents.require(agentId);
    const budget = this.summaryBudgetChars(agentId);
    const registered = this.ctx.tools.list().map((t) => t.name);
    // 工具集解析（对象形态 → string[]；全部已注册 = 不传——与 router 同语义）
    const effective = resolveToolNames(agent.tools, registered);
    const has = (name: string): boolean =>
      effective !== undefined ? effective.includes(name) : registered.includes(name);
    const summaryRel = `summary/${fileNameSafe(conversationId)}.md`;
    const lines: string[] = [
      `${ARCHIVE_REVIEW_PREFIX} 你与 "${other}" 的会话已达到归档阈值，早期消息即将移出会话流。请在归档前完成以下整理：`,
    ];
    let n = 1;
    lines.push(
      has('write')
        ? `${n}. 【生成会话总结】把这段会话（含已有概要覆盖的更早内容）的关键决策、重要结论、用户偏好和待办事项，整理为一段以"此前，"开头的自然语言，控制在 ${budget} 字以内，用 write 工具写入 ${summaryRel}（整文件即总结，重写覆盖）。该文件会整体注入后续会话上下文。`
        : `${n}. 【生成会话总结】把这段会话（含已有概要覆盖的更早内容）的关键决策、重要结论、用户偏好和待办事项，总结为一段以"此前，"开头的自然语言，控制在 ${budget} 字以内，直接作为回复返回（这部分会整体注入后续会话上下文）。`,
    );
    const memoryBudget = this.memoryBudgetOf(agentId);
    if (has('memory_rewrite')) {
      lines.push(
        `${++n}. 【整理记忆】重写长期记忆（不要只追加）：合并重复信息、压缩冗长表述、删除已过时/已被替代的记忆（已完成的计划、失效的临时状态、重复的旧记录），只保留仍有效且重要的内容——调用 memory_rewrite 工具提交整理后的完整记忆` +
          (memoryBudget !== undefined
            ? `（注入预算 ${memoryBudget} tokens，超出部分会被截断丢弃；过时信息应删除而非保留）。`
            : `（记忆有注入预算，过时信息应删除而非保留）。`),
      );
    } else if (has('memory_append')) {
      lines.push(
        `${++n}. 【整理记忆】若对话中出现了值得长期保留的用户偏好、重要决策或约定，调用 memory_append 工具各追加一条（简洁、自包含；不值得就跳过，不要把日常对话写进记忆）。`,
      );
    }
    if (has('write') || has('edit')) {
      lines.push(
        `${++n}. 【整理工作文件】TODO.md / DONE.md / note/ 知识库同理更新：完成的事项移入 DONE、过时内容清理删除，保持精炼。`,
      );
    }
    lines.push(`整理是机制任务：不要发起对话、不要等待用户回复；完成后简短确认即可，系统会自动归档。`);
    return lines.join('\n');
  }

  /** 记忆注入预算（settings['memory'].maxTokens；缺省不提示具体数值） */
  private memoryBudgetOf(agentId: string): number | undefined {
    const settings = this.ctx.agents.settingsOf(agentId, 'memory');
    if (settings && typeof settings === 'object') {
      const v = (settings as { maxTokens?: unknown }).maxTokens;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  }

  // ============================================================
  // done 协议（整理 run 完成收尾，事件驱动）
  // ============================================================

  /**
   * 单个整理 run 完成收尾（loop/after-run 识别 meta 标记后调用）：
   * 记录完成态 → 写 done 标记 → 全参与者 done → 概要（D4：Agent 亲写
   * summary 文件优先，回退整理回复文本）→ archiveAndRebuild → 清理标记。
   * pending 已被兜底清理（超时强制归档先到）→ 自清理 done 即返回
   * （对齐 src L335-346 语义）。关键段全同步（写 done → 查全齐），
   * 并发完成者不会双双触发重建。
   */
  private async completeReview(
    conversationId: string,
    agentId: string,
    result: LoopRunResult,
  ): Promise<void> {
    // 闸③收尾观测：终态与步数（整理 run 无流式面，日志是唯一观测面）
    this.ctx.logger.info(
      '[archive] 整理收束 agent=%C conv=%C finish=%C steps=%C',
      agentId,
      conversationId,
      result.finish,
      String(result.steps.length),
    );
    if (result.steps.length > this.reviewSoftSteps) {
      this.ctx.logger.warn(
        '[archive] 整理 run 步数 %C 超过软阈值 %C（硬上限 %C）',
        String(result.steps.length),
        String(this.reviewSoftSteps),
        String(this.reviewMaxSteps),
      );
    }
    if (!this.pending.has(conversationId)) {
      // pending 已被兜底清理（超时强制归档先到）：自清理 done 标记
      this.removeDoneMarker(conversationId, agentId);
      return;
    }
    this.reviewOutcomes.set(reviewKey(conversationId, agentId), {
      finish: result.finish,
      text: result.text,
    });
    const done = this.donePath(conversationId, agentId);
    try {
      fs.mkdirSync(path.dirname(done), { recursive: true });
      fs.writeFileSync(done, '', 'utf-8');
    } catch {
      /* done 写失败：留给超时兜底强制归档 */
    }
    const marker = this.readMarker(conversationId);
    if (marker === undefined) {
      this.removeDoneMarker(conversationId, agentId); // 标记损坏无法判全齐，留兜底
      return;
    }
    const participants = marker.participants.length > 0 ? marker.participants : [marker.agent];
    const allDone = participants.every((p) => fs.existsSync(this.donePath(conversationId, p)));
    if (!allDone) {
      this.ctx.logger.info(
        `[archive] 整理完成 ${agentId}/${conversationId}，等待其余参与者（${participants.join(', ')}）`,
      );
      return;
    }
    this.ctx.logger.info(`[archive] 整理全部完成，执行归档 ${conversationId}`);
    const summary = this.summaryOf(conversationId, marker);
    await this.archiveAndRebuild(conversationId, marker.agent, summary);
    this.cleanupMarkers(conversationId, participants);
  }

  /**
   * 概要来源（D4）：owning agent 的整理 run 正常收束（finish='stop'）时，
   * 优先读 Agent 亲自写的 summary/<会话>.md（须本次归档请求之后更新——
   * src mtime 语义）；缺文件/未更新则回退整理回复文本（write 不在生效集
   * 时的提示词分支）。未正常收束（max-steps/error/interrupted）→ 概要
   * 降级 undefined（归档照常，既有概要不动——闸①语义）。
   */
  private summaryOf(conversationId: string, marker: PendingMarker): string | undefined {
    const rec = this.reviewOutcomes.get(reviewKey(conversationId, marker.agent));
    if (rec?.finish !== 'stop') return undefined;
    const requestedAt = Date.parse(marker.requestedAt);
    const file = this.reviewSummaryFile(conversationId, marker.agent);
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (!Number.isNaN(requestedAt) && stat.mtimeMs >= requestedAt) {
          const text = fs.readFileSync(file, 'utf-8').trim();
          if (text) return this.clipSummary(text, marker.agent);
          this.ctx.logger.info(
            `[archive] ${marker.agent} 亲写概要文件为空（${file}），回退整理回复文本`,
          );
        } else {
          this.ctx.logger.info(
            `[archive] 概要文件早于本次归档请求（未由 Agent 更新），回退整理回复文本`,
          );
        }
      }
    } catch {
      /* 读失败走回退 */
    }
    return rec.text.trim() || undefined;
  }

  /** Agent 亲写概要的落点（= 提示词 summary/<会话>.md 的绝对路径）：
   *  基准 = workspace.agentWorkdir（Agent 专用空间唯一事实源；未装
   *  workspace 行时回落 <dataRoot>/files/<agentId>/ 同一约定）。 */
  private reviewSummaryFile(conversationId: string, agentId: string): string {
    const ws = this.ctx.get('workspace') as
      | { agentWorkdir(agentId: string): string }
      | undefined;
    const base = ws ? ws.agentWorkdir(agentId) : path.join(this.dataRoot, 'files', agentId);
    return path.join(base, 'summary', `${fileNameSafe(conversationId)}.md`);
  }

  /** 概要截断到预算字数（防 Agent 写超长文件顶爆后续上下文） */
  private clipSummary(text: string, agentId: string): string {
    const budget = this.summaryBudgetChars(agentId);
    if (text.length <= budget) return text;
    this.ctx.logger.warn(`[archive] 概要超预算（${text.length} > ${budget} 字），截断`);
    return `${text.slice(0, budget)}\n\n（已达字数上限截断）`;
  }

  // ============================================================
  // 归档重建：读会话记录 → 去重/截断分割 → 分段落盘 → compact
  // ============================================================

  /**
   * 归档重建：读会话记录 → 去重/截断分割（ac-archive-core）→
   * 写归档分段 history_N.jsonl → session.compact（概要 + 尾部保留重写）。
   * 概要缺省（整理失败/降级）时保留既有概要文件不动。
   */
  async archiveAndRebuild(conversationId: string, agentId: string, summary?: string): Promise<void> {
    const dir = this.conversationDir(conversationId);
    const records: SessionRecord[] = await this.ctx.session.records(conversationId);
    if (records.length === 0) return;

    const budgets = this.budgetsFor(agentId);
    const archiveCount = this.archiveCountOf(conversationId);
    const lastArchived = this.readLastArchived(conversationId, archiveCount);
    const split = splitForArchive(records, budgets, lastArchived);

    let segment: string | undefined;
    if (split.archive.length > 0) {
      fs.mkdirSync(dir, { recursive: true });
      const segmentName = `history_${archiveCount + 1}.jsonl`;
      segment = segmentName;
      const segmentPath = path.join(dir, segmentName);
      fs.writeFileSync(
        segmentPath,
        `${split.archive.map((r) => JSON.stringify(r)).join('\n')}\n`,
        'utf-8',
      );
      // 尾锚 sidecar（M21 步骤 7 / D8）：末段末行的 seq/message_id——
      // 取代"读末 8KB 解析末行"（128KB 大行下窗口解析必败、锚静默丢 null）
      const anchorRow = split.archive[split.archive.length - 1];
      this.writeAnchor(dir, {
        conversationId,
        ...(typeof anchorRow.seq === 'number' ? { seq: anchorRow.seq } : {}),
        ...(anchorRow.message_id ? { messageId: anchorRow.message_id } : {}),
      });
      this.ctx.logger.info(
        `[archive] 已归档 ${split.archive.length} 条 → ${segmentPath}（保留尾部 ${split.keep.length} 条` +
          `${split.cutoff > 0 ? `，去重跳过前 ${split.cutoff} 条` : ''}）`,
      );
    }

    await this.ctx.session.compact(conversationId, {
      ...(summary !== undefined ? { summary } : {}),
      keep: split.keep,
    });
    // 完成通知（M7 WebUI）：唯一归档重建漏斗的收尾 emit
    this.ctx.emit('archive/completed', {
      conversationId,
      agentId,
      archived: split.archive.length,
      kept: split.keep.length,
      ...(segment !== undefined ? { segment } : {}),
    });
  }

  // ============================================================
  // 批量归档（timer 机制任务直调口；archiveAll）
  // ============================================================

  /**
   * 批量归档全部达阈值的会话桶（夜间定时任务直调，不走 LLM 决策）：
   * 未达阈值/进行中跳过（幂等）；达阈值者触发"先整理后归档"流程。
   */
  async archiveAll(): Promise<ArchiveBatchItem[]> {
    const report: ArchiveBatchItem[] = [];
    for (const conversationId of this.ctx.session.ids()) {
      // 对桶判定（M19）：桶的承载 Agent（对键取已注册非 viewer 端；旧
      // agentId 桶直接验注册表）。群/独立会话键无 owning agent，不编排。
      const owningAgent = this.owningAgentOf(conversationId);
      if (owningAgent === undefined) {
        report.push({ conversationId, skipped: true, reason: 'no-owning-agent' });
        continue;
      }
      if (this.pending.has(conversationId)) {
        report.push({ conversationId, skipped: true, reason: 'pending' });
        continue;
      }
      const records = await this.ctx.session.records(conversationId);
      if (records.length === 0) {
        report.push({ conversationId, skipped: true, reason: 'empty' });
        continue;
      }
      const threshold = thresholdOf(this.budgetsFor(owningAgent));
      if (estimateMessagesTokens(records) < threshold) {
        report.push({ conversationId, skipped: true, reason: 'below-threshold' });
        continue;
      }
      void this.requestArchive(conversationId, owningAgent).catch((err: unknown) => {
        this.ctx.logger.error(`[archive] 批量归档失败（${conversationId}）: ${String(err)}`);
      });
      report.push({ conversationId, skipped: false });
    }
    this.ctx.logger.info(`[archive] 批量归档完成：处理 ${report.length} 个会话`);
    return report;
  }

  /** 桶 → 承载 Agent（对键取已注册非 viewer 端，回退任一已注册端；无 → undefined） */
  private owningAgentOf(conversationId: string): string | undefined {
    if (!conversationId.includes('~')) {
      return this.ctx.agents.has(conversationId) ? conversationId : undefined;
    }
    const parts = conversationId.split('~');
    const registered = parts.filter((p) => this.ctx.agents.has(p));
    return (
      registered.find((p) => this.ctx.agents.get(p)?.virtual !== true) ??
      registered[0]
    );
  }

  // ============================================================
  // 超时兜底（残留/挂死 pending：abort 在途整理 + 强制归档）
  // ============================================================

  /**
   * 扫描 pending 标记：超时（> timeoutMs）→ 闸② abort 该会话全部在途
   * 整理 run（signal 在 step 边界生效 → finish='interrupted' 收束，失控
   * run 不越过兜底继续跑）→ 强制归档（概要不动）→ 清理。未超时的可能
   * 是进行中/排队等待——绝不能误清理打断（src 教训）。
   */
  private async scanPending(): Promise<number> {
    let handled = 0;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(this.archiveRoot, { withFileTypes: true });
    } catch {
      return 0; // 根目录不存在 = 无归档
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const conversationId = d.name;
      const marker = path.join(this.archiveRoot, conversationId, '.pending.json');
      try {
        if (!fs.existsSync(marker)) continue;
        const pending = this.readMarker(conversationId);
        if (pending === undefined) {
          // 损坏标记无法判参与者/时刻：清掉（无法完成也无需等待）
          try {
            fs.unlinkSync(marker);
          } catch {
            /* ignore */
          }
          handled++;
          continue;
        }
        const requestedAt = new Date(pending.requestedAt || 0).getTime();
        if (Date.now() - requestedAt <= this.timeoutMs) continue; // 进行中/排队等待
        this.ctx.logger.warn(
          `[archive] 归档整理超时（> ${Math.round(this.timeoutMs / 60000)} 分钟），中止在途整理并强制归档 ${conversationId}`,
        );
        const participants = pending.participants.length > 0 ? pending.participants : [pending.agent];
        // 闸②：先 abort 该会话在途整理 run，再强制归档
        const conversation = this.ctx.get('conversation') as
          | { abort(agentId: string, conversationId?: string): number }
          | undefined;
        if (conversation) {
          for (const p of participants) conversation.abort(p, conversationId);
        }
        await this.archiveAndRebuild(conversationId, pending.agent || conversationId).catch(() => {
          /* 强制归档失败静默（下次扫描重试） */
        });
        this.cleanupMarkers(conversationId, participants);
        handled++;
      } catch {
        /* 单目录失败忽略 */
      }
    }
    this.syncScan(); // 清理后收敛（无残留 → 停扫描，空闲零定时器）
    return handled;
  }

  // ============================================================
  // 归档目录（本服务自有；分段/标记布局）
  // ============================================================

  private conversationDir(conversationId: string): string {
    return path.join(this.archiveRoot, conversationId);
  }

  private markerPath(conversationId: string): string {
    return path.join(this.conversationDir(conversationId), '.pending.json');
  }

  private donePath(conversationId: string, agentId: string): string {
    return path.join(this.conversationDir(conversationId), `.done-${agentId}`);
  }

  /** 读 pending 标记（损坏/缺失 → undefined） */
  private readMarker(conversationId: string): PendingMarker | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.markerPath(conversationId), 'utf-8')) as Partial<PendingMarker>;
      if (typeof raw.agent !== 'string' || !raw.agent) return undefined;
      return {
        agent: raw.agent,
        participants: Array.isArray(raw.participants)
          ? raw.participants.filter((p): p is string => typeof p === 'string' && !!p)
          : [],
        requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : '',
      };
    } catch {
      return undefined;
    }
  }

  private removeDoneMarker(conversationId: string, agentId: string): void {
    try {
      const done = this.donePath(conversationId, agentId);
      if (fs.existsSync(done)) fs.unlinkSync(done);
    } catch {
      /* ignore */
    }
  }

  /** 收尾清理：pending 集合/标记/done 标记/完成态缓存 + 扫描收敛 */
  private cleanupMarkers(conversationId: string, participants: string[]): void {
    this.pending.delete(conversationId);
    try {
      const marker = this.markerPath(conversationId);
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch {
      /* ignore */
    }
    for (const p of participants) this.removeDoneMarker(conversationId, p);
    // 参与者集合变化时的孤儿 done 标记一并扫掉
    try {
      for (const f of fs.readdirSync(this.conversationDir(conversationId))) {
        if (f.startsWith('.done-')) {
          try {
            fs.unlinkSync(path.join(this.conversationDir(conversationId), f));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    for (const key of this.reviewOutcomes.keys()) {
      if (key.startsWith(`${conversationId}\u0000`)) this.reviewOutcomes.delete(key);
    }
    this.syncScan(); // 收敛：无 pending 且无盘上残留 → 停扫描
  }

  /** 已有归档分段数（history_N.jsonl 计数） */
  private archiveCountOf(conversationId: string): number {
    try {
      return fs
        .readdirSync(this.conversationDir(conversationId))
        .filter((f) => f.startsWith('history_') && f.endsWith('.jsonl')).length;
    } catch {
      return 0;
    }
  }

  /** 尾锚 sidecar（<dir>/.anchor.json，原子写；M21 步骤 7 / D8） */
  private writeAnchor(dir: string, anchor: { conversationId: string; seq?: number; messageId?: string }): void {
    try {
      const tmp = path.join(dir, `.anchor.json.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(anchor), 'utf-8');
      fs.renameSync(tmp, path.join(dir, '.anchor.json'));
    } catch (err: unknown) {
      this.ctx.logger.warn(`[archive] 尾锚落盘失败（${anchor.conversationId}）: ${String(err)}`);
    }
  }

  /**
   * 读末段最后一条消息（二次归档去重锚点）。
   * 优先 sidecar 锚（.anchor.json：seq/messageId，零解析——修 128KB
   * 大行下 8KB 窗口解析必败、锚静默丢 null）；旧段无 sidecar 回落
   * 尾读 8KB（src 语义）。
   */
  private readLastArchived(conversationId: string, archiveCount: number): ArchiveMessage | null {
    if (archiveCount <= 0) return null;
    const dir = this.conversationDir(conversationId);
    try {
      const anchorFile = path.join(dir, '.anchor.json');
      if (fs.existsSync(anchorFile)) {
        const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf-8')) as {
          seq?: number;
          messageId?: string;
        };
        if (typeof anchor.seq === 'number' || typeof anchor.messageId === 'string') {
          return {
            role: '',
            ...(typeof anchor.seq === 'number' ? { seq: anchor.seq } : {}),
            ...(typeof anchor.messageId === 'string' ? { message_id: anchor.messageId } : {}),
          };
        }
      }
    } catch {
      // sidecar 损坏 → 回落尾读
    }
    const file = path.join(dir, `history_${archiveCount}.jsonl`);
    try {
      const stats = fs.statSync(file);
      if (stats.size === 0) return null;
      const readSize = Math.min(stats.size, 8192);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buffer.toString('utf-8').split('\n').filter((l) => l.trim());
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]) as ArchiveMessage;
    } catch {
      return null;
    }
  }

  /** 诊断：读取某会话的归档分段名 */
  segments(conversationId: string): string[] {
    try {
      return fs
        .readdirSync(this.conversationDir(conversationId))
        .filter((f) => f.startsWith('history_') && f.endsWith('.jsonl'));
    } catch {
      return [];
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 归档编排服务（ac-archive 提供）：阈值检测 + 整理 run + 归档重建 + archiveAll */
    archive: ArchiveService;
  }
}
