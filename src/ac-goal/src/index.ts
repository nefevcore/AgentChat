// ============================================================
// ac-goal —— 长期目标（ctx.goals）：goal-round 驱动 + goal 工具
//
// 定位（对齐现代 harness 语义，DSH goal-round-driver 同款）：goal 不是
// 被动状态记录，是**驱动指令**——登记后宿主自动逐轮推进，直到模型判
// 定达成（completed）或受阻（blocked）才停：
//   · loop/after-run 监听：本桶有 active 目标且 run 正常收束
//     （finish=stop/max-steps）→ conversation.deliver(source:'event')
//     投递下一轮【goal-round N/M】消息（sender=Agent 自身，同 timer
//     自会话姿势）；异常收束（error/interrupted）→ 自动暂停（防打断
//     后又自己跑起来）。
//   · 轮次记账：goal-round run（信封 meta[GOAL_ROUND_META]）收束时
//     roundsDone+1；达到 maxRounds（创建时可设，缺省 20，上限 200）
//     → 自动暂停并注明。MAX_AUTO_WAKES 只约束单 deliver 链内的
//     next-turn 消费——跨轮链的防自激由 maxRounds 承担。
//   · 状态到达模型的通道 = **消息面**（goal-round 事件消息 + 工具调用
//     及结果的历史行），**不改写 system**——目标/待办状态逐轮变化，
//     system 注入会使 [system+tool schema] 前缀每轮失效（KV cache 全
//     miss）；消息面追加只扩展前缀尾部（M21/D4 同口径，system 恒定）。
//
// 状态归属（对齐 ac-memory 键规约）：
//   · 桶键 = conversationId ?? agentId——目标随会话桶走：1v1 对话、
//     群、独立会话（sid）、Agent 自会话（a~a）各一份，互不串扰
//     （预设 __standard__ 服务全部 singles，按 sid 分桶即天然隔离）；
//   · 持久化归 ac-agent-store（ADR-5：entry key 'goal'，单 entry 存
//     该 Agent 全部桶；桶数上限 32 按 updatedAt 淘汰，防无界增长）；
//   · 同一桶至多一个未完成目标（current）——完成即入 history（上限 20）。
//
// 工具面（repo 惯例：单工具 + action 枚举，参照 ac-timer-tools）：
//   goal(action=create/get/update) —— create 登记（objective 一句话
//   可判完成 + max_rounds 轮次预算）；update 支持 objective 编辑、
//   status 流转（active 恢复并清 autoPausedReason / paused 暂停（停
//   轮）/ blocked 受阻[必填 blocked_reason] / completed 收口入历史）。
//
// settings['goal'] = { enabled? }：**门控自主推进**（agentGate——
// false = 本 Agent 不自动开轮，工具面照常；全局层可写同键）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import { agentOfRunRequest, isArchiveReviewRun } from 'ac-agent-loop';
import type { LoopRunResult } from 'ac-agent-loop';
import { agentGate } from 'ac-gate-core';
import type {} from 'ac-agent-store'; // ctx.agentStore 服务类型（type-only）

/** 目标状态：active 推进中（开轮）/ paused 已暂停（停轮）/ blocked 受阻 / completed 已达成（终态入 history） */
export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked';

/** 目标记录（current 恒非终态；终态移入桶内 history） */
export interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;
  /** 进展备注（创建/更新可写） */
  note?: string;
  /** status='blocked' 必填：具体阻塞条件 */
  blockedReason?: string;
  /** 宿主自动暂停的原因（轮次上限/异常收束；resume 即清除） */
  autoPausedReason?: string;
  /** 已完成的 goal-round 数（轮 run 收束时 +1） */
  roundsDone?: number;
  /** 轮次预算上限（缺省 20；达到即自动暂停） */
  maxRounds?: number;
  createdAt: string;
  updatedAt: string;
  /** status='completed' 时存在 */
  completedAt?: string;
}

/** 会话桶内的目标状态 */
export interface GoalBucket {
  /** 未完成目标（至多一个；缺省 = 无） */
  current?: GoalRecord;
  /** 已达成目标（完成序；上限 20） */
  history: GoalRecord[];
  updatedAt: string;
}

/** agentStore entry 'goal' 的持久形态（单 entry 存该 Agent 全部桶） */
export interface GoalStore {
  version: 1;
  buckets: Record<string, GoalBucket>;
}

/** 快照（get 输出；只读副本） */
export interface GoalSnapshot {
  current?: GoalRecord;
  history: GoalRecord[];
}

/** goal 更新补丁（undefined 字段 = 保持不变；note='' = 清除） */
export interface GoalUpdatePatch {
  objective?: string;
  note?: string;
  status?: GoalStatus;
  blockedReason?: string;
}

/** goal-round 信封 meta 键（M20 机制标记透明通道同款；值 = 轮号） */
export const GOAL_ROUND_META = 'goal-round';

/** agentStore entry key（param-case；机制数据归 agent-store 唯一写口） */
const GOAL_ENTRY_KEY = 'goal';
/** 桶数上限（按 updatedAt 淘汰最旧） */
const MAX_BUCKETS = 32;
/** 桶内 history 上限 */
const MAX_HISTORY = 20;
/** objective 长度上限 */
const MAX_OBJECTIVE = 2000;
/** 轮次预算缺省 / 硬上限 */
const DEFAULT_MAX_ROUNDS = 20;
const HARD_MAX_ROUNDS = 200;

let goalSeq = 0;

function newGoalId(): string {
  goalSeq = (goalSeq + 1) % 10_000;
  return `goal-${Date.now().toString(36)}-${goalSeq}`;
}

function isGoalStatus(v: unknown): v is GoalStatus {
  return v === 'active' || v === 'paused' || v === 'completed' || v === 'blocked';
}

/**
 * goal-round 投递消息（纯函数供测试锁定；状态经消息面到达模型）。
 * DSH 同款单块形态（dsh-goal-round-driver prompt 模板）：
 *   · <goal_round> 标签块——机器可解析的续行标记；
 *   · Objective 经 JSON.stringify——多行/类标签目标保持**数据**形态
 *     （内联拼接会让目标文本伪装成指令）；
 *   · 固定一段常驻指令：权威信息源 + 取证后收口 + 未完成保持推进；
 *     生命周期细节（blocked 阈值/completed 语义）住在 goal 工具描述里，
 *     轮消息不重复。
 * 无备注接力（DSH 同款）：跨轮连续性由会话历史承载（工具调用/结果
 * 持久在场）；note 仍是 goal 字段（UI/get 可见），不随轮消息回注。
 */
export function renderGoalRoundMessage(goal: GoalRecord, round: number): string {
  const max = goal.maxRounds ?? DEFAULT_MAX_ROUNDS;
  return [
    '<goal_round>',
    `Objective: ${JSON.stringify(goal.objective)}`,
    `Round: ${round}/${max}`,
    '',
    '在本会话内继续朝目标推进。以当前工作区、工具结果与持久会话状态为准——检查它们，不要假设早前叙述仍然成立。做出实质进展并验证结果。宣称完成前，先收集整个目标已达成的证据，读取当前目标并标记完成；仍有工作未完成则保持目标 active 留待下一轮。报告受阻前遵循 goal 工具的受阻策略。',
    '</goal_round>',
  ].join('\n');
}

/**
 * goal-round 的 sender = 桶对端（2026-09-03 KV cache 实测修正）：对话信息
 * 块渲染 `[当前对话对象] <sender>` 进 system——sender 若取 Agent 自身，
 * 用户轮（sender=user）与轮次轮（sender=admin）交替即翻转 system → 每次
 * 边界 ~94k 全量前缀 miss。取对端使两种轮的 system 字节一致：
 *   · 对键 a~b → ≠agentId 的一侧（1v1 = user；委托桶 = 委托方）；
 *   · 自会话对角线 a~a → 自身（timer 自会话同款，机制触发标注在位）；
 *   · 非对键（singles sid / 群 id）→ 'user'（与 webui 用户侧发送同源）。
 */
export function goalRoundSender(conversationId: string, agentId: string): string {
  const parts = conversationId.split('~');
  if (parts.length === 2) {
    if (parts[0] === parts[1]) return agentId;
    return parts[0] === agentId ? parts[1]! : parts[0]!;
  }
  return 'user';
}

/** conversation 服务最小形状（结构性；经 ctx.get root-traced 解析——deliver 深链） */
interface ConversationLike {
  deliver(
    agentId: string,
    inbound: string,
    options: { sender: string; source: 'event'; conversationId: string; meta?: Record<string, unknown> },
  ): Promise<unknown>;
}

export class GoalsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'goals');

    // goal-round 驱动：run 收束 → 未达成的 active 目标自动开下一轮。
    // agentGate：settings['goal'].enabled=false（per-Agent/全局）= 不开轮。
    this.ctx.on('loop/after-run', agentGate(this.ctx, 'goal', agentOfRunRequest, (request, result) => {
      void this.maybeContinue(request.agent, request.conversationId, request.meta, result);
    }), { description: 'goal-round 驱动：未达成目标自动续跑下一轮（异常/上限自动暂停）' });
  }

  // ============================================================
  // 驱动（after-run → 下一轮投递 / 自动暂停）
  // ============================================================

  private async maybeContinue(
    agentId: string | undefined,
    conversationId: string | undefined,
    meta: Record<string, unknown> | undefined,
    result: LoopRunResult,
  ): Promise<void> {
    try {
      if (agentId === undefined || conversationId === undefined) return; // 子 Agent / loop 直连无桶
      if (isArchiveReviewRun(meta)) return; // 归档整理 run 不推进目标（M20 机制标记）
      const goal = this.currentOf(agentId, conversationId);
      if (!goal || goal.status !== 'active') return; // 无目标 / 暂停 / 受阻：不驱动

      // 轮次记账：本 run 是 goal-round → roundsDone + 1
      let roundsDone = goal.roundsDone ?? 0;
      if (meta?.[GOAL_ROUND_META] !== undefined) {
        roundsDone += 1;
        this.setRounds(agentId, conversationId, roundsDone);
      }

      if (result.finish !== 'stop' && result.finish !== 'max-steps') {
        // 异常收束（error/interrupted；veto = 被 before-run 拦截不动）：
        // 自动暂停——防"用户打断后又自己跑起来"
        this.autoPause(agentId, conversationId, `第 ${roundsDone + 1} 轮异常收束（finish=${result.finish}）`);
        return;
      }

      const maxRounds = goal.maxRounds ?? DEFAULT_MAX_ROUNDS;
      if (roundsDone >= maxRounds) {
        this.autoPause(agentId, conversationId, `已达轮次上限（${maxRounds}）——用 goal(action="update", status="active") 恢复或 completed 收口`);
        return;
      }

      const conversation = this.ctx.get('conversation') as ConversationLike | undefined;
      if (!conversation) {
        this.ctx.logger.warn('[goals] conversation 服务不可用，goal-round 未投递');
        return;
      }
      const round = roundsDone + 1;
      this.ctx.logger.info('[goals] goal-round %C/%C → %C（conv=%C）', String(round), String(maxRounds), goal.id, conversationId);
      await conversation.deliver(agentId, renderGoalRoundMessage(goal, round), {
        sender: goalRoundSender(conversationId, agentId), // 桶对端：与用户轮 system 一致（KV 前缀不翻转）
        source: 'event',
        conversationId,
        meta: { [GOAL_ROUND_META]: round },
      });
    } catch (err: unknown) {
      this.ctx.logger.error('[goals] goal-round 驱动失败: %C', String(err));
    }
  }

  /** 轮次记账写口（只动 roundsDone/updatedAt，不触碰其余字段） */
  private setRounds(agentId: string, key: string, roundsDone: number): void {
    const store = this.loadStore(agentId);
    const bucket = store.buckets[key];
    if (!bucket?.current) return;
    bucket.current = { ...bucket.current, roundsDone, updatedAt: new Date().toISOString() };
    bucket.updatedAt = bucket.current.updatedAt;
    this.saveStore(agentId, store);
  }

  /** 宿主自动暂停（轮次上限/异常收束）：paused + autoPausedReason（note 不动） */
  private autoPause(agentId: string, key: string, reason: string): void {
    const store = this.loadStore(agentId);
    const bucket = store.buckets[key];
    if (!bucket?.current || bucket.current.status !== 'active') return;
    const now = new Date().toISOString();
    bucket.current = { ...bucket.current, status: 'paused', autoPausedReason: reason, updatedAt: now };
    bucket.updatedAt = now;
    this.saveStore(agentId, store);
    this.ctx.logger.info('[goals] 目标自动暂停: %C', reason);
  }

  // ============================================================
  // 桶读写（agentStore entry 'goal'；读改写全量落盘，原子性由 store 保证）
  // ============================================================

  private loadStore(agentId: string): GoalStore {
    const stored = this.ctx.agentStore.readEntry<GoalStore>(agentId, GOAL_ENTRY_KEY);
    if (stored === undefined || stored === null || typeof stored !== 'object'
      || stored.buckets === undefined || typeof stored.buckets !== 'object') {
      return { version: 1, buckets: {} };
    }
    return stored;
  }

  private saveStore(agentId: string, store: GoalStore): void {
    // 桶淘汰：超上限按 updatedAt 淘汰最旧（防无界增长）
    const keys = Object.keys(store.buckets);
    if (keys.length > MAX_BUCKETS) {
      const sorted = keys.sort((a, b) =>
        (store.buckets[a]?.updatedAt ?? '') < (store.buckets[b]?.updatedAt ?? '') ? -1 : 1);
      for (const k of sorted.slice(0, keys.length - MAX_BUCKETS)) delete store.buckets[k];
    }
    this.ctx.agentStore.saveEntry(agentId, GOAL_ENTRY_KEY, store);
  }

  private bucketOf(agentId: string, key: string): GoalBucket {
    const store = this.loadStore(agentId);
    const bucket = store.buckets[key];
    if (bucket === undefined || typeof bucket !== 'object' || !Array.isArray(bucket.history)) {
      return { history: [], updatedAt: new Date().toISOString() };
    }
    return bucket;
  }

  /** 桶键校验（空键拒绝；键为 JSON 字段非文件名，无路径词法约束） */
  private assertKey(agentId: string, key: string): void {
    if (!agentId) throw new Error('缺少 agentId（goal 状态按 Agent × 会话桶归属）');
    if (!key) throw new Error('缺少会话桶键（conversationId ?? agentId）');
  }

  // ============================================================
  // 查询 API
  // ============================================================

  /** 桶快照（current + history；只读副本） */
  snapshot(agentId: string, key: string): GoalSnapshot {
    this.assertKey(agentId, key);
    const bucket = this.bucketOf(agentId, key);
    return {
      ...(bucket.current ? { current: { ...bucket.current } } : {}),
      history: bucket.history.map((g) => ({ ...g })),
    };
  }

  /** 当前未完成目标（无 → undefined） */
  currentOf(agentId: string, key: string): GoalRecord | undefined {
    this.assertKey(agentId, key);
    const current = this.bucketOf(agentId, key).current;
    return current ? { ...current } : undefined;
  }

  /** 全部桶视图（诊断） */
  list(agentId: string): Array<{ key: string; bucket: GoalBucket }> {
    const store = this.loadStore(agentId);
    return Object.entries(store.buckets).map(([key, bucket]) => ({ key, bucket }));
  }

  // ============================================================
  // 写 API（域规则违反抛错——工具面由 ac-tools 收敛为 { ok:false, error }）
  // ============================================================

  /** 登记目标（同桶已有未完成目标 → 抛错：先收口或换会话） */
  create(agentId: string, key: string, objective: string, note?: string, maxRounds?: number): GoalRecord {
    this.assertKey(agentId, key);
    const text = objective.trim();
    if (!text) throw new Error('objective 不能为空（一句话、可判完成）');
    if (text.length > MAX_OBJECTIVE) throw new Error(`objective 过长（上限 ${MAX_OBJECTIVE} 字符）`);
    const rounds = Math.floor(maxRounds ?? DEFAULT_MAX_ROUNDS);
    if (!Number.isFinite(rounds) || rounds < 1 || rounds > HARD_MAX_ROUNDS) {
      throw new Error(`max_rounds 非法（1-${HARD_MAX_ROUNDS}，缺省 ${DEFAULT_MAX_ROUNDS}）`);
    }
    const store = this.loadStore(agentId);
    const bucket = store.buckets[key] ?? { history: [], updatedAt: new Date().toISOString() };
    if (bucket.current) {
      throw new Error(
        `本会话已有未完成目标 "${bucket.current.objective}"（id=${bucket.current.id}，状态 ${bucket.current.status}）——先 goal(action="update", status="completed"|"blocked") 收口再开新目标`,
      );
    }
    const now = new Date().toISOString();
    const record: GoalRecord = {
      id: newGoalId(),
      objective: text,
      status: 'active',
      maxRounds: rounds,
      createdAt: now,
      updatedAt: now,
      ...(note && note.trim() ? { note: note.trim() } : {}),
    };
    store.buckets[key] = { ...bucket, current: record, updatedAt: now };
    this.saveStore(agentId, store);
    return { ...record };
  }

  /**
   * 更新当前目标（无目标 → 抛错）。支持 objective 编辑、note 备注、
   * status 流转；status='completed' → 设 completedAt 并移入 history
   * （桶回到无目标态，驱动停止）；status='blocked' 必填 blockedReason；
   * status='active'（恢复）→ 清 autoPausedReason 并重新开轮。
   */
  update(agentId: string, key: string, patch: GoalUpdatePatch): GoalRecord {
    this.assertKey(agentId, key);
    const store = this.loadStore(agentId);
    const bucket = store.buckets[key];
    if (!bucket?.current) {
      throw new Error('本会话尚无未完成目标——先 goal(action="create", objective=...) 登记');
    }
    const goal = { ...bucket.current };
    const hasObjective = typeof patch.objective === 'string';
    const hasNote = typeof patch.note === 'string';
    const hasStatus = patch.status !== undefined;
    if (!hasObjective && !hasNote && !hasStatus && patch.blockedReason === undefined) {
      throw new Error('update 缺少可更新字段（objective / note / status / blocked_reason）');
    }
    if (hasObjective) {
      const text = patch.objective!.trim();
      if (!text) throw new Error('objective 不能为空');
      if (text.length > MAX_OBJECTIVE) throw new Error(`objective 过长（上限 ${MAX_OBJECTIVE} 字符）`);
      goal.objective = text;
    }
    if (hasNote) {
      const text = patch.note!.trim();
      if (text) goal.note = text;
      else delete goal.note;
    }
    const now = new Date().toISOString();
    if (hasStatus) {
      if (!isGoalStatus(patch.status)) {
        throw new Error(`未知状态 "${String(patch.status)}"（active/paused/completed/blocked 之一）`);
      }
      goal.status = patch.status;
      if (patch.status === 'active') delete goal.autoPausedReason; // 恢复 = 清宿主暂停标记
    }
    // blockedReason 仅在终态为 blocked 时存在（离开 blocked 即清除——
    // 防陈旧原因潜伏到下一次 blocked）
    if (goal.status === 'blocked') {
      const reason = (typeof patch.blockedReason === 'string' ? patch.blockedReason : '').trim() || goal.blockedReason;
      if (!reason) {
        throw new Error('status="blocked" 必须给 blocked_reason（具体阻塞条件——何时能恢复）');
      }
      goal.blockedReason = reason;
    } else {
      delete goal.blockedReason;
    }
    goal.updatedAt = now;

    if (goal.status === 'completed') {
      const done: GoalRecord = { ...goal, completedAt: now };
      const history = [...bucket.history, done].slice(-MAX_HISTORY);
      store.buckets[key] = { history, updatedAt: now };
      this.saveStore(agentId, store);
      return { ...done };
    }
    store.buckets[key] = { ...bucket, current: goal, updatedAt: now };
    this.saveStore(agentId, store);
    return { ...goal };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 长期目标服务（ac-goal 提供）：goal-round 驱动 + goal 工具 + 会话桶目标状态 */
    goals: GoalsService;
  }
}

function err(message: string): ToolResult {
  return { ok: false, error: message };
}

export const name = 'ac-goal';

export const inject = ['tools', 'agentStore'];

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'goal',
  label: '长期目标（自主推进）',
  description: 'goal 工具登记跨会话目标后宿主自动逐轮推进（goal-round：after-run 续投下一轮，异常/轮次上限自动暂停）；状态经消息面到达模型（不改写 system，KV cache 友好）；桶键 = conversationId ?? agentId',
  fields: [{ name: 'enabled', type: 'boolean', default: true, description: '自主推进门控（false = 不自动开轮，工具面不变；Agent 可覆盖）' }],
  listeners: [{ event: 'loop/after-run', role: 'goal-round 驱动', description: 'Agent 循环收束通知（持久化/审计/指标订阅）', respectsEnabled: true }],
};

export function apply(ctx: Context) {
  // 服务直接挂本行 fiber（durable-interaction 形态）：service + 工具注册
  // + 驱动监听同 fiber 归属，摘行整体回收
  const service = new GoalsService(ctx);

  ctx.tools.register({
    name: 'goal',
    description:
      '管理跨会话长期目标：create 登记（一句话、可判完成；登记后宿主自动逐轮推进直至完成/受阻，max_rounds 为轮次预算）/ get 查看（当前目标 + 历史 + 轮次进度）/ update 流转（paused 暂停停轮、active 恢复、blocked 受阻[必填 blocked_reason]、completed 达成收口；可改 objective/note）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update'], description: '操作' },
        objective: { type: 'string', description: '[create] 目标描述；[update] 修改目标文本' },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'blocked'],
          description: '[update] 流转状态（blocked 必填 blocked_reason；completed 收口入历史）',
        },
        blocked_reason: { type: 'string', description: '[update status=blocked] 具体阻塞条件（何时能恢复）' },
        note: { type: 'string', description: '[create/update] 进展备注（goal get / UI 可见；空串清除）' },
        max_rounds: { type: 'number', description: '[create] 轮次预算（1-200，缺省 20；达到即自动暂停）', minimum: 1, maximum: 200 },
      },
      required: ['action'],
    },
    execute(args, call): ToolResult {
      const agentId = call.agentId;
      if (agentId === undefined) return err('缺少执行身份（agentId）——goal 需在 Agent run 内调用');
      const key = call.conversationId ?? agentId;
      const action = String(args.action ?? '');

      // ---- get ----
      if (action === 'get') {
        return { ok: true, output: service.snapshot(agentId, key) };
      }

      // ---- create ----（域规则违反由服务抛错，ac-tools 收敛）
      if (action === 'create') {
        const objective = typeof args.objective === 'string' ? args.objective : '';
        const maxRounds = typeof args.max_rounds === 'number' ? args.max_rounds : undefined;
        const goal = service.create(
          agentId,
          key,
          objective,
          typeof args.note === 'string' ? args.note : undefined,
          maxRounds,
        );
        return {
          ok: true,
          output: {
            goal,
            message: `目标已登记（id=${goal.id}，轮次预算 ${goal.maxRounds}）——宿主将自动逐轮推进；达成后 goal(action="update", status="completed") 收口，无法推进则 status="blocked"+blocked_reason`,
          },
        };
      }

      // ---- update ----
      if (action === 'update') {
        const patch: GoalUpdatePatch = {};
        if (typeof args.objective === 'string') patch.objective = args.objective;
        if (typeof args.note === 'string') patch.note = args.note;
        if (typeof args.status === 'string') patch.status = args.status as GoalStatus;
        if (typeof args.blocked_reason === 'string') patch.blockedReason = args.blocked_reason;
        const goal = service.update(agentId, key, patch);
        return {
          ok: true,
          output: {
            goal,
            completed: goal.status === 'completed',
            message: goal.status === 'completed'
              ? `目标 "${goal.objective}" 已达成收口（入历史；可开新目标）`
              : `目标已更新（status=${goal.status}${goal.status === 'active' ? '，恢复逐轮推进' : '，停止开轮'}）`,
          },
        };
      }

      return err(`未知 action "${action}"（create/get/update 之一）`);
    },
  });
}
