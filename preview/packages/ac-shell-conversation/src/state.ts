// ============================================================
// state.ts —— 会话状态机（M3.4；D2/D4 语义平移）
//
// 串行化门（handle）：单参与者串行——busy 时入站走 inbox 双队列；
// 双队列（A4）：next-step = steer 注入活跃 run；next-turn = 跨 run 队列；
// budget 消费（M1.1）：自动唤醒 -1、0 = 只落账；user 端点桩（R-2）：
// 激活仪式化——user 在场即重置满额。
// ============================================================

/** 入站消息走向（消费时机分类——与信封 kind 正交，A4） */
export type Lane = 'next-step' | 'next-turn';

/** busy 时 next-step 的投放策略 */
export type Placement = 'steer' | 'next-run';

/** next-turn 队列条目（排队 UI 数据面 + 链跑消费双载体；steer 注入以 preview 为原文） */
export interface QueuedTurn {
  requestId: string;
  /** 会话键（排队时已知——队列快照按会话过滤 / steer 寻址用） */
  conversationId?: string;
  /** 消息预览（steer 注入与 UI 展示的原文载体） */
  preview: string;
  sender: string;
  /** 来源词（user / agent——展示面） */
  source?: string;
  queuedAt: number;
}

/** 会话状态快照（listRunning / 诊断面） */
export interface ConversationState {
  /** 串行化门地址（runAddress：agentId 或群 gid~agentId） */
  handle: string;
  busy: boolean;
  currentRun: string | null;
  queuedTurns: number;
  budget: number;
}

/** 投递决策结果（deliver 的纯计算半边——IO 归调用方） */
export type DeliverPlan =
  | { action: 'run'; budgetAfter: number }
  | { action: 'steer'; runId: string; budgetAfter: number }
  | { action: 'queue'; lane: Lane; budgetAfter: number }
  | { action: 'ledger-only'; reason: 'budget-exhausted' | 'receipt' | 'control' }
  | { action: 'deduped' };

/** 会话机（纯状态——无 IO；持久化经 ledger writer 由调用方接线） */
export class ConversationMachine {
  private busy = false;
  private currentRun: string | null = null;
  private readonly turnQueue: QueuedTurn[] = [];
  private budget: number;
  private readonly handle: string;

  constructor(
    handle: string,
    initialBudget = 3,
  ) {
    this.handle = handle;
    this.budget = initialBudget;
  }

  state(): ConversationState {
    return {
      handle: this.handle,
      busy: this.busy,
      currentRun: this.currentRun,
      queuedTurns: this.turnQueue.length,
      budget: this.budget,
    };
  }

  /**
   * 入站投递决策（决策点 = 门，M8.2 并发缝修复）：
   *   · receipt / grant / revoke / 控制面 → ledger-only（不进 inbox，A4）
   *   · budget = 0 → ledger-only（只落账不激活）
   *   · user 直发 → run/steer/queue（预算重置满额）
   *   · busy → steer（next-step）或 queue（next-turn）；空闲 → run
   * run 决策即占门（busy 同步置位——plan 与 runStarted 之间的 await
   * 窗口无并发缝；两封并发入站恒一 run 一 steer/queue）。
   */
  plan(input: {
    kind: 'message' | 'grant' | 'revoke' | 'receipt';
    sender: string;
    requestId: string;
    admitted: boolean;
    lane?: Lane;
    placement?: Placement;
    /** 会话键 + 预览（next-turn 入队时随行——队列快照/steer 数据面） */
    conversationId?: string;
    preview?: string;
    source?: string;
  }): DeliverPlan {
    if (!input.admitted) return { action: 'deduped' };
    if (input.kind !== 'message') {
      return { action: 'ledger-only', reason: input.kind === 'receipt' ? 'receipt' : 'control' };
    }
    if (input.sender === 'user') this.budget = 3; // user 是预算之源——重置满额
    if (this.budget <= 0) return { action: 'ledger-only', reason: 'budget-exhausted' };
    if (this.busy) {
      const lane = input.lane ?? 'next-step';
      if (lane === 'next-step') {
        const placement = input.placement ?? 'steer';
        if (placement === 'steer') return { action: 'steer', runId: this.currentRun!, budgetAfter: this.budget };
        return { action: 'queue', lane: 'next-turn', budgetAfter: this.budget };
      }
      this.turnQueue.push({
        requestId: input.requestId,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        preview: input.preview ?? '',
        sender: input.sender,
        ...(input.source !== undefined ? { source: input.source } : {}),
        queuedAt: Date.now(),
      });
      return { action: 'queue', lane: 'next-turn', budgetAfter: this.budget };
    }
    this.busy = true; // 决策即占门（同步）；runId 由调用方随后 runStarted 补登
    this.currentRun = null;
    return { action: 'run', budgetAfter: this.budget };
  }

  /** run 开始（runId 补登——busy 已在 plan 决策点置位；直调方未过 plan
   * 而占门时保持原冲突断言语义） */
  runStarted(runId: string): void {
    if (this.busy && this.currentRun !== null) {
      throw new Error('串行化门冲突：handle=' + this.handle + ' 已有 run ' + this.currentRun);
    }
    this.busy = true;
    this.currentRun = runId;
  }

  /**
   * run 收束：自动唤醒消耗预算（-1）；队列有货 → 下轮 run 信号。
   * 返回 queued 项（消费下一 turn）或 null（空闲）。
   */
  runSettled(consumedBudget: boolean): { requestId: string } | null {
    if (consumedBudget) this.budget = Math.max(0, this.budget - 1);
    this.busy = false;
    this.currentRun = null;
    const next = this.turnQueue.shift();
    return next === undefined ? null : { requestId: next.requestId };
  }

  // —— next-turn 队列读写（排队 UI 数据面——主线 queue/removeQueued/steerQueued 同语义） ——

  /** 排队快照（id = requestId；conversationId 给定时按会话过滤） */
  queued(conversationId?: string): Array<{ id: string; preview: string; sender: string; queuedAt: number; source?: string; conversationId?: string }> {
    return this.turnQueue
      .filter((t) => conversationId === undefined || t.conversationId === conversationId)
      .map((t) => ({
        id: t.requestId,
        preview: t.preview,
        sender: t.sender,
        queuedAt: t.queuedAt,
        ...(t.source !== undefined ? { source: t.source } : {}),
        ...(t.conversationId !== undefined ? { conversationId: t.conversationId } : {}),
      }));
  }

  /** 删除一条排队消息（返回被删条目——调用方据此清 inbox durable；未命中 → null） */
  removeQueued(id: string): QueuedTurn | null {
    const idx = this.turnQueue.findIndex((t) => t.requestId === id);
    if (idx < 0) return null;
    const [item] = this.turnQueue.splice(idx, 1);
    return item;
  }

  /** steer 取件（出队原子半边——注入失败由 steerRestore 原位放回） */
  steerTake(id: string): { item: QueuedTurn; index: number } | null {
    const index = this.turnQueue.findIndex((t) => t.requestId === id);
    if (index < 0) return null;
    const [item] = this.turnQueue.splice(index, 1);
    return { item, index };
  }

  /** steer 放回（窗口已关——原位插回不丢消息） */
  steerRestore(item: QueuedTurn, index: number): void {
    this.turnQueue.splice(Math.min(index, this.turnQueue.length), 0, item);
  }
}
