// ============================================================
// ac-conversation/src/service.ts —— 会话状态机服务（cordis Service）
//
// KV Cache effect（M21/D9 声明纪律）: Append-only —— 会话上下文视图 =
// 文件事件的按读者增量投影（与 history(conv,{viewer}) 重派生字节等价，
// S3）：每 run 信封 = 此前视图 + 纯追加后缀。显式失效：stale 重派生
// （archive/completed 归档联动 / D7）= invalidate-from-head（低频）。
//
// 本包是会话状态机域的 owning package（ADR-1）：src router 的有状态
// 调度全部移入此处，ac-router 保持"纯转发、零会话状态"。
//
//   · 串行化门：handle（= runAddress(agent, conversationId)）→ 活跃 run；
//     同一会话同一 Agent 至多一个 run，忙时按 placement 决策
//   · inbox 双队列：next-step = steer 注入活跃 run（经
//     ctx.agentLoop.steer，能力调用）；next-turn = 跨 run 队列，
//     当前 run 结束后作为独立 run 消费（含 MAX_AUTO_WAKES 防自激）
//   · 会话上下文视图 = **文件事件的按读者派生投影**（M21 步骤 2/D2）：
//     订阅 router/message-received / router/reply-completed /
//     conversation/steered，把每个文件事件（说话人 = sender / 回复
//     Agent，即存储行的 agent_id）经 session 域唯一投影函数 projectRecord
//     按 `agent_id === viewer ? assistant : user` 投影进**该桶全部 handle**
//     的视图——行形态 {role, content, name} 与 history(conv,{viewer}) 文件
//     派生逐字节一致（S3）；进程内视图只是增量缓存，重启/stale = 重派生
//     （同一函数，golden 对拍）。归档联动（D7）：archive/completed →
//     该桶全部 handle stale → 下次 startRun 重派生（stale-惰性，天然避开
//     在途 run 竞态）。机制标记 run（整理，M20）不投影。
//
// M15 待投持久化（src pending-resume 的最小闭环）：行配置 root 给定
// 即启用——next-turn 队列入队即落盘（<root>/conversation/pending-
// <handle>.jsonl，先记账后受理）；消费后重写剩余；启动回放恢复
// （崩溃/42 重启后待投消息不丢。进行中 run 的消息已由 ac-session
// 入账，不属本队列职责）。
//
// 投递通知：新 run 走 router/message-received + router/reply-completed
// （经 ctx.router.send）；steer 注入不经 router → 广播
// conversation/steered（./events.ts）让 ac-session 等订阅方入账。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { runAddress, pairKey, ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import { GROUP_HINT_META } from 'ac-group';
import { projectRecord } from 'ac-session';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopSource } from 'ac-agent-loop';
import type {} from 'ac-archive'; // archive/* 事件目录（type-only）
import type {
  ConversationDeliverOptions,
  ConversationLane,
  ConversationOutcome,
  ConversationRunInfo,
} from './contract.ts';

/** 机制标记 run（归档整理等）判定：见标记即不投影（M20 三消费方之一） */
function isArchiveReviewRun(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[ARCHIVE_REVIEW_META] === true;
}

/** 群 hint 投递触发判定（M21/F6①）：事实行已入群本体，视图不重复投影
 *  （群桶视图内容由 ac-group 的 per-member 派生种子供给） */
function isGroupHint(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[GROUP_HINT_META] === true;
}

/** run 结束后因自主来源（source='event'）自动连跑的上限（防"完成→自触发→再完成"自激） */
const MAX_AUTO_WAKES = 3;

/**
 * 缺省发送方端点（单 viewer 常量）：sender 未给出时的对键推导与队列
 * 回落基准。多 viewer 未来由投递边界（web-api 连接层）显式传 sender，
 * 本常量仅作最后兜底——不承重身份判定。
 */
const DEFAULT_SENDER = 'user';

/** placement='next-run' 等待会话空闲的缺省上限（对齐 LLM 180s 超时兜底 + 余量） */
const NEXT_RUN_TIMEOUT_MS = 190_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** next-turn 队列条目 */
interface QueuedTurn {
  message: LlmMessage;
  sender: string;
  source: LoopSource;
}

/** 串行化门条目（活跃 run） */
interface RunEntry {
  agentId: string;
  conversationId: string;
  controller: AbortController;
  startedAt: number;
}

/** 待投落盘行（pending-<handle>.jsonl） */
interface PendingLine {
  message: LlmMessage;
  sender: string;
  source?: LoopSource;
}

/** handle 文件名安全校验（runAddress 产物仅含 [a-z0-9-_.~]，防御性校验） */
function assertHandleSafe(handle: string): boolean {
  return /^[^/\\]+$/.test(handle) && !handle.includes('..');
}

/** 会话上下文视图（M21/D2 派生投影缓存）：文件事件按读者投影的增量积累 */
interface ContextView {
  /** 归属会话桶（投影目标筛选：该桶全部 handle 都收到每个文件事件） */
  conversationId: string;
  /** 读者端点 = 本 handle 的 Agent（视角变换基准，§2.4） */
  viewer: string;
  /** 投影行 {role, content, name}——与 history(conv,{viewer}) 派生逐字节一致 */
  messages: LlmMessage[];
  /** 显式 replace（归档重建）后标记：下次 startRun 从文件重派生（D7） */
  stale: boolean;
}

export class ConversationService extends Service {
  /** handle → 活跃 run（串行化门；set 先于任何 await——deliver 同步前缀内完成） */
  private runs = new Map<string, RunEntry>();

  /** handle → next-turn 队列（跨 run 存活） */
  private turns = new Map<string, QueuedTurn[]>();

  /** handle → 会话上下文视图（文件事件的按读者派生投影缓存；stale = 待重派生） */
  private views = new Map<string, ContextView>();

  /** 待投持久化目录（undefined = 内存态，测试/演示兼容） */
  private readonly pendingDir: string | undefined;

  constructor(ctx: Context, options: { root?: string } = {}) {
    super(ctx, 'conversation');
    // 待投持久化根缺省跟随宿主数据根（AGENTCHAT_DATA_ROOT；未设 = 内存态）
    const persistRoot = options.root ?? process.env.AGENTCHAT_DATA_ROOT;
    this.pendingDir =
      persistRoot !== undefined ? path.resolve(persistRoot, 'conversation') : undefined;
    if (this.pendingDir !== undefined) this.replayPending();

    // ---- 视图投影通道（M21 步骤 2：文件事件 → 按读者增量投影）----
    // 视图 = 文件事件的派生缓存（S1/S3）：行由 session 域唯一投影函数
    // projectRecord 产出——与 history(conv,{viewer}) 重派生逐字节一致；
    // 投影目标 = 该桶全部 handle 的视图（说话人/回复 Agent 即存储行
    // agent_id，与 ac-session 入账同词汇同顺序）。
    const project = (conversationId: string, speaker: string, content: string, role: 'agent' | 'event' | 'error') => {
      for (const view of this.views.values()) {
        if (view.conversationId !== conversationId || view.stale) continue;
        view.messages.push(
          projectRecord({ role, content, message_id: '', timestamp: '', agent_id: speaker }, view.viewer, conversationId),
        );
      }
    };
    this.ctx.on('router/message-received', (agentId, message, conversationId, sender, source, meta) => {
      if (isArchiveReviewRun(meta)) return; // 机制 run 不进视图（M20）
      if (isGroupHint(meta)) return; // 群 hint 触发不进视图（事实行在群本体；M21/F6①）
      if (source === 'event') {
        // 机制触发行：agent_id = 目标自身（§2.3，与 ac-session 入账同构）
        project(conversationId, agentId, message.content, 'event');
        return;
      }
      project(conversationId, sender ?? 'user', message.content, 'agent');
    }, { description: '入站消息并入上下文视图' });
    this.ctx.on('conversation/steered', (agentId, message, conversationId, _handle, sender, _source, meta) => {
      if (isArchiveReviewRun(meta)) return;
      if (isGroupHint(meta)) return; // 群 hint 的 busy 注入不进视图（同上）
      project(conversationId, sender ?? agentId, message.content, 'agent');
    }, { description: 'steer 消息并入上下文视图' });
    this.ctx.on('router/reply-completed', (agentId, text, result, conversationId, _sender, _source, meta) => {
      if (isArchiveReviewRun(meta)) return;
      // 错误收束（D12）：error 行语义位 = user（§2.4）；与 ac-session 落盘同构
      if (result.finish === 'error') {
        project(conversationId, agentId, String(result.error ?? '循环失败'), 'error');
        return;
      }
      if (!text) return; // 中断/空回复不入账（同 ac-session）
      project(conversationId, agentId, text, 'agent');
    }, { description: '回复并入上下文视图' });
    // 归档联动（D7）：compact 重写消息流后旧视图失准——标记该桶全部
    // handle stale，下次 startRun 从文件重派生（stale-惰性：在途 run 的
    // 信封快照不受影响，天然避开竞态；归档后视图收缩、上下文回落 keep 预算内）
    this.ctx.on('archive/completed', (payload) => {
      for (const view of this.views.values()) {
        if (view.conversationId === payload.conversationId) view.stale = true;
      }
    }, { description: '归档完成后重建上下文视图' });
    // D3 残余观测：before-run veto 窗口内被吞的注入（消息已入账/进视图，
    // 下一条自然 run 可见——自愈）。只告警不重投（重投经
    // router/message-received 二次入账）；收束判定后的迟到注入由
    // steer() 封口拒绝、本事件不出现。
    this.ctx.on('loop/steer-dropped', (agent, conversationId, handle, dropped) => {
      this.ctx.logger.warn(
        '[conversation] %C 条注入在 run 收尾窗口未被消费（已入账，下次自然 run 可见；conv=%C handle=%C）',
        String(dropped.length),
        conversationId ?? agent ?? '-',
        handle,
      );
    }, { description: '收尾窗口残余注入观测' });
  }

  // ============================================================
  // 待投持久化（M15 最小闭环：入队即落盘、消费即重写、启动回放）
  // ============================================================

  private pendingPath(handle: string): string {
    return path.join(this.pendingDir!, `pending-${handle}.jsonl`);
  }

  /** 启动回放：pending-*.jsonl → turns 队列恢复 */
  private replayPending(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.pendingDir!);
    } catch {
      return; // 目录不存在 = 无残留
    }
    let restored = 0;
    for (const file of files) {
      const m = /^pending-(.+)\.jsonl$/.exec(file);
      if (!m) continue;
      const handle = m[1];
      if (!assertHandleSafe(handle)) continue;
      try {
        const lines = fs.readFileSync(this.pendingPath(handle), 'utf-8').split('\n');
        const queue: QueuedTurn[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as PendingLine;
            if (parsed && parsed.message && typeof parsed.message.role === 'string') {
              queue.push({
                message: parsed.message,
                sender: typeof parsed.sender === 'string' && parsed.sender ? parsed.sender : DEFAULT_SENDER,
                source: parsed.source ?? 'user',
              });
            }
          } catch {
            /* 损坏行跳过 */
          }
        }
        if (queue.length > 0) {
          this.turns.set(handle, [...(this.turns.get(handle) ?? []), ...queue]);
          restored += queue.length;
        }
      } catch {
        /* 单文件读失败跳过 */
      }
    }
    if (restored > 0) {
      this.ctx.logger.info('[conversation] 已恢复 %C 条待投消息（崩溃/重启残留）', String(restored));
    }
  }

  /** 队列变更落盘（全量重写该 handle 的文件；空队列删除文件） */
  private persistQueue(handle: string): void {
    if (this.pendingDir === undefined) return;
    try {
      const file = this.pendingPath(handle);
      const queue = this.turns.get(handle) ?? [];
      if (queue.length === 0) {
        if (fs.existsSync(file)) fs.rmSync(file);
        return;
      }
      fs.mkdirSync(this.pendingDir, { recursive: true });
      const body = queue
        .map((q) => JSON.stringify({ message: q.message, sender: q.sender } satisfies PendingLine))
        .join('\n');
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${body}\n`, 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err: unknown) {
      // 待投落盘失败不阻塞投递（内存语义照常；持久化尽力而为）
      this.ctx.logger.warn(`[conversation] 待投落盘失败（${handle}）: ${String(err)}`);
    }
  }

  /**
   * 投递一条入站消息（唯一入口；busy 决策点）。
   *   · 空闲 → 开新 run（经 ctx.router.send，事件面照常发射）
   *   · 忙 + next-step + placement steer → ctx.agentLoop.steer 注入活跃 run
   *   · 忙 + next-step + placement next-run → 等会话空闲后作为独立 run
   *   · 忙 + next-turn → 入队，当前 run 结束后消费（MAX_AUTO_WAKES 预算）
   * 投递错误（未知 Agent 等）由 router.send 原样抛出。
   */
  async deliver(
    agentId: string,
    inbound: string | LlmMessage,
    options: ConversationDeliverOptions = {},
  ): Promise<ConversationOutcome> {
    const message: LlmMessage =
      typeof inbound === 'string' ? { role: 'user', content: inbound } : inbound;
    const sender = options.sender ?? DEFAULT_SENDER;
    const source = options.source ?? 'user';
    // 对桶缺省（M19）：直答 = pairKey(sender, agentId)——user 只是端点之一；
    // 群/独立/委托/机制路径由调用方显式传键（web-api 边界显式算直答键，D3）。
    const conversationId = options.conversationId ?? pairKey(sender, agentId);
    const handle = runAddress(agentId, conversationId)!; // agentId 必填 → 恒有地址
    const lane: ConversationLane = options.lane ?? 'next-step';
    // M18 调试可见性：投递入口（谁 → 哪个会话 → 走向）
    const busy = this.runs.has(handle);
    this.ctx.logger.info(
      '[conversation] deliver %C（conv=%C sender=%C/%C lane=%C %C）',
      agentId,
      conversationId,
      sender,
      source,
      lane,
      busy ? '会话忙' : '会话空闲',
    );

    if (this.runs.has(handle)) {
      if (lane === 'next-turn') {
        this.turnsFor(handle).push({ message, sender, source });
        this.persistQueue(handle); // 先记账后受理（M15 待投持久化）
        return { kind: 'queued', handle };
      }
      if ((options.placement ?? 'steer') === 'steer') {
        if (this.ctx.agentLoop.steer(handle, message, { sender, source })) {
          // 机制标记 run（归档整理等）不进上下文视图（M20：剔除点在入口
          // 分流而非事后回滚——投影通道同款 meta 判定）
          // steer 不经 router：广播本事件让持久化/视图投影方看到这条消息
          this.ctx.emit(
            'conversation/steered',
            agentId,
            message,
            conversationId,
            handle,
            sender,
            source,
            options.meta,
          );
          return { kind: 'steered', handle };
        }
        // steer 落空（活跃 run 收尾竞态 / 收束封口后迟到）→ 退化为
        // next-run：等空闲后独立 run（D3：封口后回落——消息入账一次）
      }
      // next-run：等会话空闲后作为独立 run
      const deadline = Date.now() + (options.timeoutMs ?? NEXT_RUN_TIMEOUT_MS);
      while (this.runs.has(handle)) {
        const idle = await this.waitIdle(handle, deadline - Date.now());
        if (!idle) return { kind: 'timeout', handle };
      }
    }
    return this.startRun(agentId, conversationId, handle, message, options);
  }

  /**
   * 中止活跃 run（软中断：signal 在 step 边界生效，run 以
   * finish='interrupted' 收尾，next-turn 链跑随之停止）。
   * @param agentId 目标 Agent
   * @param conversationId 可选会话桶键（给出 = 精确中止该会话；缺省 = 中止该 Agent 全部活跃会话）
   * @returns 中止的 run 数
   */
  abort(agentId: string, conversationId?: string): number {
    let aborted = 0;
    for (const entry of this.runs.values()) {
      if (entry.agentId !== agentId) continue;
      if (conversationId !== undefined && entry.conversationId !== conversationId) continue;
      entry.controller.abort();
      aborted++;
    }
    return aborted;
  }

  /** 全部运行中会话（运行跟踪/诊断） */
  listRunning(): ConversationRunInfo[] {
    return [...this.runs.entries()].map(([handle, e]) => ({
      agentId: e.agentId,
      conversationId: e.conversationId,
      handle,
      startedAt: e.startedAt,
    }));
  }

  /**
   * 标记某会话的全部视图 stale（D11：群本体每有新发言时调用——成员视图
   * 是按读者的派生缓存，本体增长即失准；下次 startRun 由投递方携带的新
   * 种子重派生[send 的 per-member historyFor]，语义与 archive/completed
   * 联动一致[§4.2 stale-惰性，天然避开在途 run 竞态]）。
   */
  markStale(conversationId: string): void {
    for (const view of this.views.values()) {
      if (view.conversationId === conversationId) view.stale = true;
    }
  }

  /** 诊断快照：运行中会话 + 各 handle 的 next-turn 积压 */
  stats(): { running: ConversationRunInfo[]; queued: Record<string, number> } {
    const queued: Record<string, number> = {};
    for (const [handle, q] of this.turns) if (q.length > 0) queued[handle] = q.length;
    return { running: this.listRunning(), queued };
  }

  /** 会话是否繁忙（handle 粒度；conversationId 缺省 = 直答对桶 pairKey(DEFAULT_SENDER, agentId)） */
  isBusy(agentId: string, conversationId?: string): boolean {
    return this.runs.has(runAddress(agentId, conversationId ?? pairKey(DEFAULT_SENDER, agentId))!);
  }

  // ============================================================
  // 内部：串行化门 + next-turn 链跑
  // ============================================================

  /** 开跑（含 next-turn 链跑消费）：注册门 → router.send → 入账 → 消费队列 */
  private async startRun(
    agentId: string,
    conversationId: string,
    handle: string,
    firstMessage: LlmMessage,
    options: ConversationDeliverOptions,
  ): Promise<ConversationOutcome> {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const entry: RunEntry = { agentId, conversationId, controller, startedAt: Date.now() };
    this.runs.set(handle, entry); // 同步注册：deliver 同步前缀内即完成（竞态安全）
    // 视图派生化（M21 步骤 2/D2+F1）：取/建该 handle 的按读者投影视图
    // （stale = 从文件重派生；无视图时以 session.history(conv,{viewer})
    // 播种——重启/直答/独立会话路径上下文不再为空）。机制标记 run
    // （归档整理，M20）自身的事件被投影通道 meta 判定跳过，视图零污染。
    const view = await this.contextFor(handle, conversationId, agentId, options.history);
    let message = firstMessage;
    let sender = options.sender ?? DEFAULT_SENDER;
    let source: LoopSource = options.source ?? 'user';
    let autoWakes = 0;
    let first: LoopRunResult | undefined;

    try {
      while (true) {
        // run 信封快照：事件投影会并发追加视图（本条入站/同桶对端事件），
        // 信封须稳定——取"本条之前"的拷贝，router 会把本条追加到信封末尾。
        // 入站/回复行由 router 事件投影进视图（S1：视图 = 文件事件派生，
        // startRun 手工 push 退役）；错误收束同样经事件按 error→user 语义
        // 位投影（§2.4）。
        const history = [...view.messages];
        let result: LoopRunResult;
        try {
          result = await this.ctx.router.send(agentId, message, {
            sender,
            source,
            conversationId,
            history,
            ...(options.model ? { model: options.model } : {}),
            ...(options.maxSteps != null ? { maxSteps: options.maxSteps } : {}),
            ...(options.meta ? { meta: options.meta } : {}),
            signal: controller.signal,
          });
        } catch (err) {
          // 投递失败（如未知 Agent）：无需回滚——require 先于 message-received
          // emit（无事件无行）；emit 之后的失败（缺 model 等）行已入文件，
          // 视图与文件一致（S3 语义，旧回滚反而是分叉源）。错误原样上抛
          throw err;
        }
        if (first === undefined) first = result;
        if (result.finish === 'interrupted') break; // 中断链跑（ADR-2）

        // ---- next-turn 消费：当前 run 完全结束后才开下一个独立 run ----
        const queue = this.turns.get(handle);
        const next = queue?.shift();
        if (next === undefined) break;
        this.persistQueue(handle); // 消费即重写（M15：磁盘与内存同步）
        this.ctx.logger.info(
          '[conversation] 链跑下一轮 %C（conv=%C sender=%C/%C）',
          agentId,
          conversationId,
          next.sender,
          next.source,
        );
        if (next.source === 'event') {
          if (autoWakes >= MAX_AUTO_WAKES) {
            // 预算用尽：放回队首，等外部输入带来的下一次自然唤醒
            queue!.unshift(next);
            this.persistQueue(handle);
            break;
          }
          autoWakes++;
        } else {
          autoWakes = 0; // 用户/Agent 来源重置预算
        }
        message = next.message;
        sender = next.sender;
        source = next.source;
      }
    } finally {
      if (this.runs.get(handle) === entry) this.runs.delete(handle);
    }
    return { kind: 'run', result: first! };
  }

  /**
   * 取/建会话上下文视图（M21/D2 派生化）：
   *   · 无视图/stale → 重派生：调用方显式种子（群 historyFor 等专用投影）
   *     优先；否则 session.history(conv, {viewer}) 文件派生（唯一回放边界，
   *     F1 修复——直答/独立会话重启后首跑不再空上下文）；
   *   · session 行未装载（测试/最小组合）→ 显式种子/空兜底；
   *   · 已有视图 → 沿用（增量投影维护，不再重复播种）。
   */
  private async contextFor(
    handle: string,
    conversationId: string,
    viewer: string,
    seed: LlmMessage[] | undefined,
  ): Promise<ContextView> {
    const existing = this.views.get(handle);
    if (existing && !existing.stale) return existing;
    let messages: LlmMessage[];
    if (seed && seed.length > 0) {
      messages = [...seed];
    } else {
      const session = this.ctx.get('session', false) as
        | { history(id: string, options?: { viewer?: string }): Promise<LlmMessage[]> }
        | undefined;
      messages = session ? await session.history(conversationId, { viewer }) : [];
    }
    const view: ContextView = { conversationId, viewer, messages, stale: false };
    this.views.set(handle, view);
    return view;
  }

  private turnsFor(handle: string): QueuedTurn[] {
    let queue = this.turns.get(handle);
    if (!queue) {
      queue = [];
      this.turns.set(handle, queue);
    }
    return queue;
  }

  /** 等待 handle 空闲（不中止它）；双拍确认覆盖"旧 run 刚清理、新 run 尚未注册"的间隙 */
  private async waitIdle(handle: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.runs.has(handle)) {
      if (Date.now() >= deadline) return false;
      await sleep(20);
    }
    await sleep(20);
    return !this.runs.has(handle);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话状态机（ac-conversation 提供）：串行化门 + inbox 双队列 + steer/next-run placement */
    conversation: ConversationService;
  }
}
