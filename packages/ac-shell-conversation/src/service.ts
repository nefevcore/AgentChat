// ============================================================
// service.ts —— 会话行装配面（M8.2：全量 loop 接线）
//
// 纯状态机（state.ts）+ 服务面（本模块）合体 = 壳 conversation 行：
//   信封入站 → inboxDecision（A4 + budget）→ ledger 落账（A2 落账即
//   确认）→ ConversationMachine 决策 → ctx.agentLoop.run 真身
//   （主线 ac-agent-loop——请求装配吸收主线 router 的 send 半边：
//   agents-core 直读配置 + 行集投影工具面 + system 装配链经
//   loop/before-run waterfall 由 persona/system-prompt 行注入）→
//   settle 终稿 + journal → 跨壳回复经邮局投递（send_agent 语义半边）。
// 主线 ac-conversation 的 deliver 语义面（串行化门/steer/next-run/防自激）
// 由 ConversationMachine + 本服务链跑循环承担——不复制主线 890 行实现，
// 信封面（A6 统一载体）是新架构的输入边界。
// ============================================================
import * as crypto from 'node:crypto';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { ConversationMachine, type DeliverPlan, type QueuedTurn } from './state.ts';
import type {} from './events.ts';
import { readAgentConfig, readChildConfig, resolveToolNames, type AgentConfig } from 'ac-agents-core';
import { pairKey } from 'ac-core-utils';
import type { Envelope, StreamFrame } from 'ac-envelope-core';
import { budgetAfterReceive, entersInbox, isBudgetSource } from 'ac-envelope-core';
import { readLedger, readJournal } from 'ac-ledger';
import { poolFallbackRef, splitModelRef } from 'ac-llm'; // 模型缺省回落单源（cr-313 语义——cr-561 复用）+ name@model 引用拆分
import { effectiveToolMode, narrowToolsByMode } from 'ac-agents'; // 工具调用模式收窄单源（估算与真实 run 同口径——主线三处共用同源引用）
import { answerNotice } from 'ac-ask-questions'; // 应答通知正文单源（cr-636 恢复面重放口径与主线 late-reply 同源）
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export interface ConversationRowOptions {
  dataRoot: string;
  agentId: string;
  /** 父 agent id（影子形态：配置与账本域在 agents/<parent>/children/<id>/） */
  parentId?: string;
  /** 跨壳投递面（邮局 ipc——send_agent 半边）；缺省 = 无邮局（CLI 直连形态） */
  postOfficeAddress?: string;
  /**
   * 行 id → 工具名清单（cr-590：壳装配期行集目录投影——AgentConfig.tools
   * 的词形是行 id〔cutover/模板/补迁单源〕，LLM 工具面要的是工具名。
   * 行 id → 工具名的展开词汇 owning = ac-rowset-core 目录；装配期投影传入，
   * 服务面零目录知识。缺席 = 不展开（词形已是工具名的存量直用）。
   */
  rowTools?: Record<string, string[]>;
}

/**
 * answered 记录 → answerNotice 正文（cr-636 恢复面比对键）：list 拿到的
 * 是完整 DurableInteraction 投影（payload/answer 在场），直接走主线
 * 同款格式化——单源，不另造正文。
 */
function answerNoticeOf(record: { id: string; payload?: unknown; answer?: unknown }): string {
  return answerNotice(record as Parameters<typeof answerNotice>[0]);
}

/** 续跑态（cr-667，A1）：恢复面传入 driveRun 的中断 run 重建前缀 */
interface RunResume {
  messages: import('ac-llm').LlmMessage[];
  committedSteps: number;
}

/**
 * 终稿回信目标（cr-638）：replyTo（显式指定）优先 → sender（信源即回信
 * 目标，大多数信封同源）。目标 = 本壳 agent 时返回 null——自己回自己会
 * 再拉起一轮 run（壳内单 agent + 收束点回投 = 自激回环：每轮自答一次，
 * 用户侧还收不到终稿，只因预算衰减才停）。
 */
export function replyTargetOf(env: Envelope, agentId: string): string | null {
  // 群广播扇出（cr-712 方案 A）：信封带 broadcast 标记 = 群成员流入站
  // ——收信方终稿只落自己成员流，不回投发送方（回投 = 串键污染发送方
  // 账本 + 群内互答链，两缺口同因）。
  if ((env.payload as { broadcast?: unknown } | null)?.broadcast === true) return null;
  const to = env.replyTo ?? env.sender;
  return to === agentId ? null : to;
}

/**
 * 子 Agent 在管面（可选服务——conversation 不硬依赖 subagent 行，cr-710）：
 * 回信目标若是本壳子 Agent，必须由拥有子壳的 subagent 行直投 ipc——子壳
 * 端点不在宿主可达表，裸子 id 走邮局只会拉起同 id 的顶层幽灵身份。
 */
interface OwnedChildFace {
  ownsChild?(childId: string): boolean;
  deliverToChild?(childId: string, env: Envelope): Promise<boolean>;
}

/** 完成回执的发起会话键（任务信封 payload 原样往返；缺席 = 宿主直调/旧版子壳） */
function replyConversationOf(env: Envelope): string | undefined {
  const payload = env.payload as { replyConversation?: unknown } | null;
  const value = payload?.replyConversation;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 主线 loop 的 step 事件载荷词汇（type-only——同 ac-ledger loop-events） */
import type { LlmMessage } from 'ac-llm';
import type { ConversationQueuedItem } from 'ac-conversation';

export class ConversationService extends Service {
  private dataRoot: string;
  private agentId: string;
  private parentId: string | undefined;
  private postOfficeAddress: string | undefined;
  private rowTools: Record<string, string[]> | undefined;
  /** 在途 run 表（键 = 门键 runAddress(agent, conversationId)——值含中止信号
   * 与会话面；interrupt 按 run 中止、runState 多 run 投影） */
  private readonly activeRuns = new Map<string, { conversationId: string; startedAt: number; abort: AbortController }>();
  /** per-conversation 串行化门（cr-746：门键 = runAddress(agent, conversationId)，
   * 惰性建——同 Agent 多会话并行 run，同会话仍至多一个 run） */
  private readonly machines = new Map<string, ConversationMachine>();
  /** 门键（runAddress 同源：自会话 = agentId，其余 = uuid~agentId） */
  private gateKey(uuid: string): string {
    return uuid === this.agentId ? this.agentId : uuid + '~' + this.agentId;
  }
  private machineFor(uuid: string): ConversationMachine {
    const key = this.gateKey(uuid);
    let m = this.machines.get(key);
    if (m === undefined) {
      m = new ConversationMachine(key);
      this.machines.set(key, m);
    }
    return m;
  }
  /** 安全重启挂起标记（cr-629：restart_shell 置位——当前 run 收束点消费，
   * 不中断（cr-658 自然收束语义） */
  private restartPending = false;
  /** 最近收束尾巴（cr-748 状态对账批）：run 收束即记——runState 携带，宿主
   * 轮询对拍「活跃集消失但从未见 settled 帧」的短命 run；纯内存，容量 8，
   * 旧条目随新收束挤出（活壳视角的对齐面，非持久面——壳死即蒸发，崩溃
   * 兜底归孤儿收口/inbox 恢复既有链） */
  private readonly recentSettled: Array<{ runId: string; conversationId: string; finishedAt: number; finish: 'ok' | 'interrupted' | 'error' }> = [];
  /** 跨壳发信面（惰性连接邮局） */
  private outbound: { send(env: Envelope): Promise<unknown>; close(): void } | null = null;
  /** 本代服务创建时刻（reconcileUndelivered 行龄门——只收上代死信，cr-666） */
  private readonly bootedAtMs = Date.now();

  constructor(ctx: Context, options: ConversationRowOptions) {
    super(ctx, 'conversation');
    this.dataRoot = options.dataRoot;
    this.agentId = options.agentId;
    this.parentId = options.parentId;
    this.postOfficeAddress = options.postOfficeAddress;
    this.rowTools = options.rowTools;
    // 驻留面收割（注册即归属——主线 web-server 同款）：outbound 常驻 ipc
    // 连接随 fiber dispose 关闭，不关则壳进程 close 链永挂。
    this.ctx.fiber.effect(() => () => { this.outbound?.close(); }, 'conversation.outbound');
  }

  /** 信封入站（boot 收信面唯一入口）：幂等 → 落账 → 决策 → 驱动。
   * 返回驱动概要（deduped / ledger-only / steered / settled）——deliver
   * 方言叶据此组装主线 Outcome 形状。 */
  async receiveEnvelope(env: Envelope, ack: { fresh: boolean }, opts: { recovered?: boolean; resume?: RunResume } = {}): Promise<'deduped' | 'ledger-only' | 'queued' | 'steered' | 'settled'> {
    const ledger = this.ctx.ledger;
    const uuid = env.uuid;
    const payload = env.payload as { text?: string; lane?: string; placement?: string } | null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    // 忙态投递方式（cr-575 队列产品化）：信封 payload 白名单窄化后入决策——
    // next-turn / next-run = busy 时排队（QueueDock 数据面），steer = 注入活跃 run
    const lane = payload?.lane === 'next-step' || payload?.lane === 'next-turn' ? payload.lane : undefined;
    const placement = payload?.placement === 'steer' || payload?.placement === 'next-run' ? payload.placement : undefined;
    // 收信后预算（A1/F-8 单源：user 直发重置满额，其余沿信封逐跳递减）——
    // 决策与 inbox 同一份值（cr-710：机器不再自持计数器）。
    const afterBudget = budgetAfterReceive(env.budget, env.sender);
    // 子 Agent 完成回执（cr-711）：**不是会话发言**——不进会话机、不起
    // 父⇄子对桶 run（LLM 有消息必回 = 互答链），只落子账本 + 把结果投回
    // 发起会话。判定 = 发信方是本壳在管子 Agent（subagent 行 owning 面）。
    const fromChild = env.kind === 'message'
      && (env.payload as { notice?: unknown } | null)?.notice !== true
      && (this.ctx.get('subagents', false) as OwnedChildFace | undefined)?.ownsChild?.(env.sender) === true;
    // 跨壳 Agent 完成回执（cr-712，cr-711 语义泛化到 send_agent 委托）：
    // postReply 在回信上打的 completion 标记（任务信封本身虽带
    // replyConversation 但**不带**该标记——收方不得把任务当回执，否则
    // 委托根本不执行）。回执已落本壳对桶账本（上方 deliverRow），不再
    // 唤醒对桶会话（互答链），转投发起会话。
    const completion = fromChild
      || (env.kind === 'message'
        && (env.payload as { completion?: unknown } | null)?.completion === true
        && env.sender !== this.agentId
        && env.sender !== 'user');
    // 父侧代答（cr-736）：任务信封带 interactionReply 标记 = 父对 pending
    // 提问的作答——不是会话发言，转 durableInteraction.reply（replied 事件
    // 三态续走既有：忙步 steer / idle 半边 / late-reply）。通道信任面 = 子壳
    // IPC 管道本身（与 manage 帧同级），不作会话行——转录归 ask-questions
    // 监听器 recordContext。
    const iReply = env.kind === 'message'
      ? (env.payload as { interactionReply?: { id?: unknown; answer?: unknown } } | null)?.interactionReply
      : undefined;
    if (iReply !== undefined && typeof iReply.id === 'string' && iReply.id !== '') {
      const durable = this.ctx.get('durableInteraction', false) as
        | { reply(id: string, answer: unknown): unknown }
        | undefined;
      if (durable === undefined) throw new Error('durableInteraction 服务缺席——代答无落点');
      durable.reply(iReply.id, iReply.answer ?? null);
      return 'ledger-only';
    }
    // kind 词汇面：receipt/grant/revoke = ledger-only（A4——不进 inbox 不激活）
    const plan: DeliverPlan = env.kind !== 'message'
      ? { action: 'ledger-only', reason: env.kind === 'receipt' ? 'receipt' : 'control' }
      : completion
        ? { action: 'ledger-only', reason: 'child-completion' }
        : this.machineFor(uuid).plan({
          kind: 'message',
          sender: env.sender,
          requestId: env.requestId,
          admitted: ack.fresh,
          budget: afterBudget,
          conversationId: uuid,
          preview: text,
          source: env.sender === 'user' ? 'user' : 'agent',
          ...(lane !== undefined ? { lane } : {}),
          ...(placement !== undefined ? { placement } : {}),
        });
    // 落账（A2：delivered 即 ack——requestId 幂等在 ledger writer 内）。
    // kind 按 sender 归域（ledgerKindOf 单源）。
    // cr-713：busy-steer 不落入站行——消息的账本记录归 journal-inject 单源
    //（settle 物化为 inject 行，落在 run 轨迹的真实到达位）。此前入站行在
    // run 进行中即时 append、而 run 段行收束才物化——mid-run 到达的消息恒
    // 排到整个 run 块之前（seq 错位）且与物化 inject 行同文双份（模型上下文
    // 双喂）。run/queue 路径不受影响：入站行仍是上下文单源（historyFor 复读
    // 当前消息）；steer 落空转投（cr-627）在转投点补落。
    // 恢复面补行门（cr-639）：writer 幂等门在内存、跨进程不防双写，此前
    // recovered 一律跳过落账——但首投代崩溃在 deliverRow 前的窗口（或直投
    // inbox durable 形态）行缺席 = 上下文单源断链（run 拿不到当前消息）。
    // 盘面按 requestId 查重（inject 行/注入台账同键——cr-713 steer 记录），
    // 缺席才补写（在场 = 幂等短路，同旧语义）。
    if (plan.action !== 'steer' && (opts.recovered !== true || !ledger.hasInboundRow(uuid, env.requestId))) {
      await ledger.deliverRow(uuid, [this.agentId, env.sender], this.ledgerKindOf(env), {
        role: 'agent',
        content: text,
        agent_id: env.sender,
        requestId: env.requestId,
        uuid,
      });
    }
    // 完成回执收束（cr-711 子 Agent / cr-712 跨壳委托同款）：对桶只落账
    //（子/委托会话保留任务与终稿事实），结果转投发起会话——不占串行化门、
    // 不消费 budget（忙态注入/排队归 machine.plan 决策）。
    if (completion) {
      await this.notifyCompletion(env, text, fromChild);
      return 'ledger-only';
    }
    // 队列快照推送（cr-579）：plan=queue = 队列新增点——权威快照 emit
    if (plan.action === 'queue') this.emitQueueChanged(uuid);
    // inbox durable（A4：busy 排队的信才进 inbox——plan=run 本轮直接消费、
    // plan=steer 注入活跃 run，均无排队事实；收束链跑只消费机器队列成员，
    // plan=run 信封入 inbox 即成孤儿〔idle 探针恒忙根因，cr-548〕）
    if (plan.action === 'queue' && entersInbox(env.kind, afterBudget)) {
      ledger.inboxStore(uuid, env);
    }
    if (plan.action === 'run' || plan.action === 'steer') {
      const outcome = await this.driveRun(uuid, env, plan, opts.resume);
      // 恢复面消费即清（cr-629）：run/steered = 已消费——inbox 剔行防下代
      // 重启再重投（queued = steer 落空转投已回存，保留）。restart_shell
      // 不再有回队面（cr-658 自然收束语义——run 恰好消费一次）。
      if (opts.recovered === true && outcome !== 'queued') {
        this.ctx.ledger.inboxClear(uuid, env.requestId);
      }
      return outcome;
    }
    // queue / ledger-only / deduped：落账即全部职责（队列消费在 run 收束点）
    return plan.action === 'queue' ? 'queued' : plan.action;
  }

  // —— 主线消费方言叶（collab-tools 等 inject 'conversation' 的行——方法面
  // 子集适配：deliver 组装主线 ConversationOutcome 形状；目标非本壳 agent =
  // 跨壳经邮局。preview 壳内目标恒 self（本 agent），跨壳投递走 postReply 面。）

  /** 串行化门快照（主线 web-api 消费——多门任一 busy 即忙） */
  isBusy(): boolean {
    return this.activeRuns.size > 0;
  }

  /**
   * 主线 deliver 方言叶（collab-tools send_agent 消费面）：
   * 目标 = 本壳 agent（壳内只有 self）→ 构造信封走 receiveEnvelope 全链；
   * outcome 映射：settled→run（LoopRunResult 近似——终稿从账本回放取）、
   * steered→steered、queue→queued、deduped→deduped。
   * 主线 Outcome.result 是完整 LoopRunResult——preview 以终稿文本近似组装
   *（steps/usage 明细归 journal/账本——恒等门口径）。
   */
  async deliver(
    agentId: string,
    inbound: string | LlmMessage,
    options: { sender?: string; source?: string; conversationId?: string; requestId?: string; timeoutMs?: number; replyTo?: string; budget?: number; notice?: boolean; replyConversation?: string } = {},
  ): Promise<
    | { kind: 'run'; result: { steps: unknown[]; text: string; finish: string; usage: { prompt: number; completion: number; promptAccumulated: number; steps: number } } }
    | { kind: 'steered'; handle: string }
    | { kind: 'queued'; handle: string }
    | { kind: 'timeout'; handle: string }
    | { kind: 'deduped'; handle: string }
    | { kind: 'sent'; handle: string }
  > {
    const content = typeof inbound === 'string' ? inbound : inbound.content;
    const sender = options.sender ?? 'user';
    const uuid = options.conversationId ?? pairKey(sender, this.agentId);
    const handle = uuid === this.agentId ? this.agentId : uuid + '~' + this.agentId;
    // 跨壳投递（cr-712 修投递面断点 #3）：目标非本壳 agent——信封经邮局
    // dispatch 到目标壳（宿主 ensureHook 按需拉起），本壳只落自己的出站行
    //（对桶双侧账本各持一份投影）。此前 deliver 不看 to：构造 to=目标 的
    // 信封后直接喂本壳 receiveEnvelope = 发送方自己消费自己——消息只写进
    // 发送方账本并让发送方自己跑一轮，对端壳永远收不到。
    // 子 Agent 目标不经此面（postReply cr-710 同判——子壳端点不在宿主
    // 可达表，任务消息走 subagent 工具的直投分支）。
    if (agentId !== this.agentId) {
      if ((this.ctx.get('subagents', false) as OwnedChildFace | undefined)?.ownsChild?.(agentId) === true) {
        throw new Error('目标 ' + agentId + ' 是本壳子 Agent——子 Agent 任务消息走 subagent 工具（send_agent 的 sub_ 分支）');
      }
      const out: Envelope = {
        uuid,
        requestId: options.requestId ?? 'local-' + crypto.randomUUID(),
        sender,
        to: agentId,
        kind: 'message',
        budget: options.budget ?? 3,
        payload: {
          text: content,
          ...(options.notice === true ? { notice: true } : {}),
          ...(options.replyConversation !== undefined ? { replyConversation: options.replyConversation } : {}),
        },
        ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
      };
      await this.sendEnvelope(out);
      await this.ctx.ledger.deliverRow(uuid, [this.agentId, sender], this.ledgerKindOf(out), {
        role: 'agent',
        content,
        agent_id: sender,
        requestId: out.requestId,
        uuid,
      });
      return { kind: 'sent', handle };
    }
    const env: Envelope = {
      uuid,
      requestId: options.requestId ?? 'local-' + crypto.randomUUID(),
      sender,
      to: agentId,
      kind: 'message',
      budget: options.budget ?? 3,
      payload: {
        text: content,
        ...(options.notice === true ? { notice: true } : {}),
        ...(options.replyConversation !== undefined ? { replyConversation: options.replyConversation } : {}),
      },
      ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
    };
    const summary = await this.receiveEnvelope(env, { fresh: true });
    if (summary === 'steered') return { kind: 'steered', handle };
    if (summary === 'deduped') return { kind: 'deduped', handle };
    if (summary === 'ledger-only') return { kind: 'queued', handle };
    // settled：终稿从账本回放取（settlement 已落）
    const rows = this.ctx.ledger.historyFor(uuid);
    const last = rows.at(-1);
    return {
      kind: 'run',
      result: {
        steps: [],
        text: last?.role === 'assistant' ? last.content : '',
        finish: 'stop',
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      },
    };
  }

  /**
   * 子 Agent 完成回执转投（cr-711）：把子壳终稿作为一条来自子 Agent 的
   * 消息注入**发起会话**（spawn/send 工具调用所在的 user⇄agent 会话），
   * `replyTo: 'user'` 让本壳终稿面向用户、不回投子 Agent（否则又是互答）。
   * 发起会话键随任务信封往返（payload.replyConversation）；缺席 = 宿主
   * 直调/旧版子壳，无发起地可回——只落账。通知 requestId 由回执 requestId
   * 派生，落账幂等门兼任重放去重（重启重投不重复唤醒）。
   */
  private async notifyCompletion(env: Envelope, text: string, fromChild: boolean): Promise<void> {
    const target = replyConversationOf(env);
    if (target === undefined) return;
    const requestId = 'subagent-done-' + env.requestId;
    if (this.ctx.ledger.hasInboundRow(target, requestId)) return; // 已投过（重放）
    const label = fromChild ? '子 Agent ' + env.sender + ' 完成' : 'Agent ' + env.sender + ' 回复';
    const notice = '[' + label + ']\n' + (text.trim() === '' ? '（无文本终稿）' : text);
    try {
      await this.deliver(this.agentId, notice, {
        sender: env.sender,
        source: 'event',
        conversationId: target,
        replyTo: 'user',
        budget: 1,
        requestId,
        notice: true,
      });
    } catch (err) {
      process.stderr.write('[shell] 子 Agent 完成回执转投失败（' + target + '）：' + String(err) + '\n');
    }
  }

  /** 驱动一轮 run（plan = run）或注入活跃 run（plan = steer）。
   * 返回 true = steer 注入成功（run 仍在途）；false = run 已收束。
   *
   * busy 收口不变式（cr-549）：plan 占门后的一切异常路径（config 重读/
   * 落账失败/loop 抛错）都不得泄漏 busy——异常向上抛的同时 finally 清门。
   * 链跑循环「收束即重占门」：runSettled 后下一 turn 开跑前同步重置 busy，
   * 链窗口（await runSettled → runStarted）无 busy=false 缝（并发入站见
   * 空闲 → 双 run 竞态；idle 探针误判可收割在途 run）。 */
  /**
   * 运行模型引用（agent.model → 全局池默认连接回落；cr-561 根因修复）。
   *
   * 此前是 `config.model ?? 'mock'`：mock provider 只在 --mock-provider 时注册，
   * 正式宿主上每个 model 为 null 的 agent（旧数据根导入的 33 个全是 null）都会
   * 以「未知模型 mock」收束——空终稿 + finish=error，前端零反馈，看起来就是
   * 「消息发出去没反应」。回落口径与主线单源一致：poolFallbackRef（provider
   * 显式 → 该连接默认模型；未声明 → 全局默认连接）。
   */
  private modelRefOf(config: AgentConfig): { provider?: string; model: string } {
    const direct = typeof config.model === 'string' && config.model !== '' ? config.model : undefined;
    const declared = typeof config.provider === 'string' && config.provider !== '' ? config.provider : undefined;
    // 显式模型优先；'mock' 例外——它只可能是占位（真 mock 场景由 --mock-provider 兜）
    if (direct !== undefined && direct !== 'mock') {
      return { ...(declared !== undefined ? { provider: declared } : {}), model: direct };
    }
    const fallback = poolFallbackRef(this.readPoolConfig(), declared);
    if (fallback !== undefined) return { provider: declared ?? fallback.provider, model: fallback.model };
    return { ...(declared !== undefined ? { provider: declared } : {}), model: direct ?? 'mock' };
  }

  /**
   * 生效模型引用：信封显式覆盖优先（deliver 合并点产物——显式入参 >
   * conv-settings 存储，cr-565），缺省回 agent 配置 + 池默认连接回落。
   * 覆盖 = 'name@model' 或裸模型名（splitModelRef 单源拆分——裸名不带
   * provider，由 llm 注册面按模型名路由，与主线 router 边界同义）。
   */
  private effectiveModelRef(config: AgentConfig, override: string | undefined): { provider?: string; model: string } {
    if (override !== undefined && override !== '') {
      const ref = splitModelRef(override);
      return ref.provider !== undefined ? { provider: ref.provider, model: ref.model } : { model: ref.model };
    }
    return this.modelRefOf(config);
  }

  /** 数据根全局 config.json 的 llmProviders 节（池回落入参；缺席/坏文件 → undefined） */
  private readPoolConfig(): Record<string, unknown> | undefined {
    try {
      const cfg = JSON.parse(readFileSync(path.join(this.dataRoot, 'config.json'), 'utf-8')) as Record<string, unknown>;
      const pool = cfg.llmProviders;
      return pool !== null && typeof pool === 'object' && !Array.isArray(pool) ? (pool as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private async driveRun(uuid: string, env: Envelope, plan: DeliverPlan, initialResume?: RunResume): Promise<'steered' | 'settled' | 'queued'> {
    if (plan.action === 'steer') {
      // steer：注入活跃 run（主线 loop Service 方法——runAddress 词汇）
      const handle = this.steerHandle(uuid);
      const injected = this.ctx.agentLoop.steer(handle, { role: 'user', content: this.textOf(env) });
      if (injected) {
        await this.ctx.ledger.journalInject(uuid, plan.runId, this.textOf(env), env.requestId);
        return 'steered';
      }
      // steer 落空（cr-627 语义在 per-门下收敛，cr-746）：本会话活跃 run
      // 收束封口后迟到（busy 判定已 per-门——不再有「活跃 run 属其他会话」
      // 形态；跨会话信在自己门是空闲，plan 恒为 run）。转投：inbox durable
      // + 本会话 turnQueue 补入队尾，当前 run 收束点链跑消费。
      // cr-713：入站行在转投点补落（steer 分支不再预落）——队信消费靠
      // historyMessagesFor 复读当前消息，行缺席 = 模型失明当前消息。
      await this.ctx.ledger.deliverRow(uuid, [this.agentId, env.sender], this.ledgerKindOf(env), {
        role: 'agent',
        content: this.textOf(env),
        agent_id: env.sender,
        requestId: env.requestId,
        uuid,
      });
      const afterBudget = budgetAfterReceive(env.budget, env.sender);
      if (entersInbox(env.kind, afterBudget)) this.ctx.ledger.inboxStore(uuid, env);
      this.machineFor(uuid).requeue({
        requestId: env.requestId,
        conversationId: uuid,
        preview: this.textOf(env),
        sender: env.sender,
        ...(env.sender === 'user' ? { source: 'user' } : { source: 'agent' }),
      });
      this.emitQueueChanged(uuid);
      return 'queued';
    }
    // run：串行化门 + 全量 loop 真身（signal = stop 中止面——ADR-2 步边界检查）。
    // config 读取移入 try（cr-549）：plan 已占门，读取 throw 需经 finally 清门
    // ——此前 throw 在 try 外，busy 泄漏（idle 探针恒忙 + reviewRun 自旋永挂）。
    const abort = new AbortController();
    let runId = '';
    let restartNow = false;
    // 续跑态（cr-667，A1）：首 run 用恢复面传入的前缀；链跑每轮按新信封
    // 重取（幂等——defer run 悬置/队列消费下轮续跑两形态共用）。
    let resume = initialResume ?? null;
    const machine = this.machineFor(uuid);
    try {
      const config = this.readConfig();
      runId = 'run-' + env.requestId;
      machine.runStarted(runId);
      this.activeRuns.set(this.gateKey(uuid), { conversationId: uuid, startedAt: Date.now(), abort });
      if (resume !== null) {
        // A2 标注（事件归位：观察通知 emit——boot 旁带转发链既有消费面）
        this.ctx.emit('session/context-injected', uuid, this.agentId, { source: 'resume', label: '上一轮被中断，已原地续跑' });
      }
      for (;;) {
        // 在途标记（cr-639 at-least-once）：run 起步即入 inbox durable、收束
        // 即清——壳被硬杀（无 restart 回队面：外部杀进程/崩溃）时在途信不再
        // 随进程蒸发，下代 boot recoverPendingInbox 重投续跑（run 7vmy 实锤：
        // interrupted 收束后无重投，消息整轮丢失）。链跑每轮同理（队信消费
        // 后 takeFromInbox 已清，起步重打标记）。
        if (entersInbox(env.kind, budgetAfterReceive(env.budget, env.sender))) {
          this.ctx.ledger.inboxStore(uuid, env);
        }
        // 上下文单源 = 账本（cr-639/658）：轨迹读面——含各 run 的
        // assistant/tool 协议对（tool_calls + 结果），不再对既往工具工作
        // 失明。receiveEnvelope 已 deliverRow 落了本条 user 行（recovered
        // 重投时行也早已在盘）——复读即含当前消息，再 append 同文本 = 模型
        // 每轮收双份当前消息（01a16af1 probe 实锤）。链跑循环每轮顶复读
        // history，队信消费同理自带行（busy-steer 直注消息无入站行——
        // cr-713 记录归 inject 行，轨迹读面自带）。
        const history = this.ctx.ledger.historyMessagesFor(uuid);
        // 续跑前缀（cr-667）：中断 run 无终稿行 → history 天然不含其轨迹，
        // 拼接无双计；maxSteps 按剩余额度（已用尽 → 1 步收尾轮逼收束）。
        const result = await this.ctx.agentLoop.run({
          runId,
          agent: this.agentId,
          ...this.effectiveModelRef(config, env.model),
          ...(config.system !== undefined ? { system: config.system } : {}),
          tools: this.llmToolFace(config, uuid),
          ...(config.maxSteps !== undefined && config.maxSteps > 0
            ? { maxSteps: resume !== null ? Math.max(1, config.maxSteps - resume.committedSteps) : config.maxSteps }
            : {}),
          sender: env.sender,
          source: env.sender === 'user' ? 'user' : 'agent',
          conversationId: uuid,
          messages: resume !== null ? [...history, ...resume.messages] : history,
          // 单次投递提权（cr-626）：信封 elevation → loop request（主线每步
          // 装配进 ToolCall.elevation——full-access 档工具行跳过沙箱白名单）。
          ...(env.elevation !== undefined ? { elevation: env.elevation } : {}),
          signal: abort.signal,
        });
        // settle（终稿 + journal-settled；error 文本如实入账）
        const finish = result.finish === 'error' ? 'error' : result.finish === 'interrupted' ? 'interrupted' : 'ok';
        if (finish === 'error') process.stderr.write('[conversation] run 以 error 收束（' + runId + '）：' + (result.error ?? '无错误文本') + '\n');
        await this.ctx.ledger.settleRun(uuid, [this.agentId, env.sender], 'user', {
          role: 'agent',
          content: result.text,
          agent_id: this.agentId,
          requestId: 'reply-' + env.requestId,
          uuid,
          run: runId,
          // run 墙钟耗时（cr-772）：终稿行持久锚——历史链栏「用时」段取源
          ...(result.wallMs !== undefined ? { runMs: result.wallMs } : {}),
        }, runId, finish);
        // 在途标记收束即清（cr-639）：run 已 settle = 消息已消费。此后任何
        // 失败（postReply 断链等）不重跑整轮——run 锚缺口归 cr-628
        // anchorableRuns boot 补投面，不归消息重投面。
        this.ctx.ledger.inboxClear(uuid, env.requestId);
        this.noteSettled(runId, uuid, finish); // cr-748 收束尾巴（对账面）
        // run 收束通知（cr-591，run-error 泛化）：每用户 run 收束即发——宿主
        // 旁带桥接成主线 loop/after-run（前端清 busy / 终稿入列 / 权威行重拉
        // 全挂该帧；成功收束缺席 = busy 卡「运行中」+ 终稿只能刷新可见）。
        // 账本 settle 行仍是权威收束记录（旁带瞬态，B3 语义）；
        // reviewRun 机制 run 不发。
        this.ctx.emit('conversation/run-settled', {
          conversationId: uuid,
          runId,
          finish,
          text: result.text,
          ...(finish === 'error' ? { message: result.error ?? `run 以 error 收束` } : {}),
          sender: env.sender,
          source: env.sender === 'user' ? 'user' : 'agent',
        });
        // 终稿回复投递（R-2：终稿回复 = 一次普通 send——恒投回 sender；
        // user 回信经邮局 local 通道到 user 壳桩，跨壳回信投 sender 端点）。
        // user run 恒投（cr-628）：interrupted/error 收束常无终稿文本，此前
        // 空文本跳过 postReply → user 账本永无 run 键行 → 刷新后整个 run
        //（含 journal steps）从前端蒸发。空文本也投——run 键行是读侧联查
        // 的唯一锚点；跨壳 agent 收信人维持非空才投（空回信对端无消费面）。
        // 回信目标 = replyTo ?? sender（cr-638：sender 与回信目标分离——
        // late-reply 重放 sender=owner 保账本投影，终稿仍回 user）；
        // 目标 = 自身（回环）→ null，不投。
        const replyTo = replyTargetOf(env, this.agentId);
        // 失败文案（cr-712）：error 收束常无终稿文本——跨壳 Agent 收信人
        // 此前被空文本跳过 = 发起方永远不知道委托失败。error 且收信方是
        // Agent 时合成失败文案随回信（user 收信人维持空文本 run 键行语义）。
        const failText = finish === 'error' && replyTo !== null && replyTo !== 'user'
          ? '[执行失败：' + (result.error ?? '未知错误') + ']'
          : '';
        const replyText = result.text !== '' ? result.text : failText;
        if (this.postOfficeAddress !== undefined && replyTo !== null && (replyText !== '' || replyTo === 'user')) {
          await this.postReply(replyTo, uuid, replyText, env, runId);
        }
        // 安全重启收口（cr-629/658 自然收束语义）：restart_shell 只挂起
        // 标记、不中断 run——本轮已自然 settle（终稿/回信/清行恰好一次），
        // 标记命中即跳出链跑。boot 收 restart-ready 以重启码 42 退出；宿主
        // respawn 新壳，boot 按 marker 会话键注入「已重启」通知开续跑轮
        //（续跑上下文 = 轨迹读面，不依赖信封回投）。
        // 多 run 重启语义（cr-746）：等所有门收束——本 run 收束后仍有其他
        // 在途 run 则继续等（它们的收束点会再次检查）；全闲才兑现重启。
        if (this.restartPending && this.activeRuns.size <= 1) {
          this.restartPending = false;
          restartNow = true;
          break;
        }
        // 链跑：本会话 next-turn 队列消费（收束即重占门——runSettled 后
        // 同步 runStarted，见方法头注释；takeFromInbox 落空 = 该 turn 无
        // 信封可跑，break 后 finally 幂等收口）。cr-746 per-门后队列恒
        // 本会话的（跨会话信在自己门 plan=run 直接开跑，不再转投本队列）
        // ——cr-627 的按条目会话键取信分支随之退役。
        // 死信跳过（cr-685）：出队条目在 inbox 无信封（已被消费的残迹 / 无
        // 信封的合成轮）不再 break 丢整队——出队下一条直到取到可跑信。
        resume = null; // 本轮已收束——链跑下轮按新信封重取
        let nextEnv: Envelope | null = null;
        while (nextEnv === null) {
          const next = machine.runSettled();
          if (next === null) break;
          const candidate = this.takeFromInbox(uuid, next.requestId);
          this.emitQueueChanged(uuid); // 队列缩减点（链跑消费 / 死信出队）
          if (candidate !== null) {
            nextEnv = candidate;
            env = nextEnv;
            runId = 'run-' + env.requestId;
          }
        }
        if (nextEnv === null) break;
        // 链跑续跑重取（cr-667 R3）：队信自身可能是 defer 悬置的中断 run
        const st = this.ctx.ledger.resumeStateFor(uuid, runId);
        resume = st !== null && st !== 'degraded' ? st : null; // degraded/null → 常规跑
        machine.runStarted(runId);
        this.activeRuns.set(this.gateKey(uuid), { conversationId: uuid, startedAt: Date.now(), abort });
      }
    } finally {
      // 收口清门不动队列（cr-685）：早退路径（restart break / 死信跳空后
      // break / 异常）下 runSettled 的 shift 会静默丢一条排队 turn。
      machine.releaseGate();
      this.activeRuns.delete(this.gateKey(uuid));
    }
    // 安全重启通知（finally 后——链跑已 break，busy 已收口）：不回队在途
    // 信封（cr-658——本轮已自然消费），只携会话键通知 boot 退 42（新壳按
    // marker 注入「已重启」续跑轮）。
    if (restartNow) {
      this.ctx.emit('conversation/restart-ready', { agentId: this.agentId, conversationId: uuid });
    }
    return 'settled';
  }

  /**
   * 机制 run 投递（archive 行消费面——D11）：与用户 run 共串行化门
   *（busy 时 next-run 排队），但**不落账不进上下文**（主线 deliver 的
   * meta[ARCHIVE_REVIEW] 三不语义——本壳单 agent，整理者恒 self，
   * 无双侧 done 协议）。settle 走 settleMechanismFor（journal-settled
   * 落 journal、messages 不落行）。maxSteps = 整理硬闸（主线闸①）。
   */
  async reviewRun(uuid: string, prompt: string, opts: { runId: string; maxSteps?: number; signal?: AbortSignal } = { runId: 'review' }): Promise<{ finish: 'ok' | 'interrupted' | 'error'; text: string }> {
    const ledger = this.ctx.ledger;
    const machine = this.machineFor(uuid);
    // 串行化门：busy → 入 next-turn 队列等待（整理是机制任务，不抢用户 run）
    while (machine.state().busy) {
      await new Promise((r) => setTimeout(r, 50));
      // 极端活锁防御：用户 run 长忙 + 整理排队——交给调用方 timeout 兜底
      if (opts.signal?.aborted) return { finish: 'interrupted', text: '' };
    }
    const config = this.readConfig();
    const runId = opts.runId;
    machine.runStarted(runId);
    const abort = new AbortController();
    this.activeRuns.set(this.gateKey(uuid), { conversationId: uuid, startedAt: Date.now(), abort });
    const onOuterAbort = () => abort.abort(new Error('整理超时中止'));
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const history = this.ctx.ledger.historyFor(uuid);
      const result = await this.ctx.agentLoop.run({
        runId,
        agent: this.agentId,
        ...this.modelRefOf(config),
        tools: this.llmToolFace(config, uuid),
        ...(opts.maxSteps !== undefined && opts.maxSteps > 0 ? { maxSteps: opts.maxSteps } : {}),
        sender: this.agentId, // 机制触发 = 目标自身（自会话语义——主线 source='event'）
        source: 'event',
        conversationId: uuid,
        meta: { 'archive-review': true }, // 三不标记（主线 ARCHIVE_REVIEW_META 同键）
        messages: [...history, { role: 'user', content: prompt }],
        signal: abort.signal,
      });
      const finish = result.finish === 'error' ? 'error' : result.finish === 'interrupted' ? 'interrupted' : 'ok';
      await ledger.settleMechanismFor(uuid, runId, finish);
      this.noteSettled(runId, uuid, finish); // cr-748 收束尾巴（对账面）
      return { finish, text: result.text };
    } finally {
      opts.signal?.removeEventListener('abort', onOuterAbort);
      this.activeRuns.delete(this.gateKey(uuid));
      // reviewRun 非链跑（无收束消费面）——runSettled 的 shift 会静默丢
      // 排队 turn（cr-685）；清门留队列，待下一封入站信触发链跑。
      machine.releaseGate();
      // 队列唤醒（cr-688）：收束后本会话队列若仍有 turn，取队首重入
      // driveRun（无新信时不再滞留到下次事件）。finally 内 await：门先占
      // 后回执；唤醒失败不掩 reviewRun 结果（留 boot 恢复面收敛）。
      try { await this.drainQueuedTurn(machine, uuid); } catch { /* 唤醒失败不掩回执 */ }
    }
  }

  /** 排队 turn 唤醒消费（cr-688）：非链跑收束（reviewRun）后队列无消费者
   * ——无新信时滞留到下次事件/壳重启。取队首信封重入 driveRun（信封
   * 已落账，不重走 receive 面；driveRun 内部链跑自会清完剩余队列）。
   * 死信 / 无会话键条目不唤醒——留收束链跑与 boot 恢复面收敛。 */
  private async drainQueuedTurn(machine: ConversationMachine, uuid: string): Promise<void> {
    if (machine.state().busy) return;
    const next = machine.takeQueueHead();
    if (next === null) return;
    const env = this.takeFromInbox(uuid, next.requestId);
    this.emitQueueChanged(uuid); // 队列缩减点（唤醒消费 / 死信出队）
    if (env === null) return;
    await this.driveRun(uuid, env, { action: 'run', budgetAfter: 0 });
  }

  /** 队列变更权威快照 emit（主线 ac-conversation 同名事件同参序——boot 旁带发射） */
  private emitQueueChanged(uuid: string): void {
    const handle = uuid === this.agentId ? this.agentId : uuid + '~' + this.agentId;
    this.ctx.emit('conversation/queue-changed', this.agentId, uuid, handle,
      this.machineFor(uuid).queued(uuid).map((t): ConversationQueuedItem => ({
        id: t.id,
        preview: t.preview,
        sender: t.sender,
        source: (t.source ?? (t.sender === 'user' ? 'user' : 'agent')) as ConversationQueuedItem['source'],
        queuedAt: t.queuedAt,
      })));
  }

  /** 中止在途 run（stop 面——多 run 时按会话键中止该会话的 run；缺省全中止。
   *  返回是否有在途 run 被中止） */
  interrupt(conversationId?: string): boolean {
    const targets = conversationId === undefined
      ? [...this.activeRuns.values()]
      : [this.activeRuns.get(this.gateKey(conversationId))].filter((r) => r !== undefined);
    if (targets.length === 0) return false;
    for (const { abort } of targets) abort.abort(new Error('stop 请求'));
    return true;
  }

  /**
   * 安全重启请求（cr-629/658，restart_shell 工具消费面）：busy → 只挂起
   * 标记、**不中断 run**（自然收束语义——本轮恰好 settle/回信/清行一次；
   * 模型已在工具返回里被引导收尾，终稿即重启后的接力上下文）；收束点
   * 发 conversation/restart-ready（携会话键）。空闲 → 直接发。返回 true =
   * 有在途 run（restart-ready 在收束后到达）；false = 已发出。
   */
  requestRestart(): boolean {
    if (this.activeRuns.size > 0) {
      this.restartPending = true;
      return true;
    }
    this.ctx.emit('conversation/restart-ready', { agentId: this.agentId });
    return false;
  }

  /**
   * boot 恢复面（cr-629）：跨壳重启/崩溃的续跑链——inbox durable 里全是
   * 已落账未消费的信（排队/steer 落空转投/安全重启回队），逐封经标准
   * receiveEnvelope 链重投（recovered：跳过重复落账；机器空闲 → 开新 run）。
   * 此前无恢复面：pending inbox 只阻止 idle-exit，无人消费 = 死信。
   * 逐封串行（每封可能是整轮 run）；信封损坏跳过（fail-soft——恢复面
   * 不得因单封坏信拒绝整域续跑）。返回恢复封数。
   */
  async recoverPendingInbox(): Promise<number> {
    const sessionsRoot = path.join(this.ctx.ledger.agentDirOf(), 'sessions');
    let uuids: string[] = [];
    try { uuids = readdirSync(sessionsRoot); } catch { return 0; }
    let recovered = 0;
    for (const uuid of uuids) {
      const inboxDir = path.join(sessionsRoot, uuid, 'inbox');
      let ids: string[] = [];
      try { ids = readdirSync(inboxDir).filter((n: string) => n.endsWith('.json')).map((n: string) => n.slice(0, -5)); } catch { continue; }
      for (const id of ids) {
        const env = this.ctx.ledger.inboxRead(uuid, id) as Envelope | null;
        if (env === null || typeof env.requestId !== 'string') continue;
        // 续跑分支（cr-667，A1）：run 有步行且无 settled → 原地续跑（前缀重建、
        // 同 runId、剩余额度——不再从 step 0 重做）；degraded（轨迹损坏）/
        // null（无轨迹或已收束）→ 常规重投（cr-658 语义——轨迹经读面进上下文）。
        const resume = this.ctx.ledger.resumeStateFor(uuid, 'run-' + env.requestId);
        if (resume === 'degraded') {
          this.ctx.emit('session/context-injected', uuid, this.agentId, { source: 'resume-degraded', label: '上一轮被中断，已按摘要继续' });
        }
        try {
          await (resume !== null && resume !== 'degraded'
            ? this.receiveEnvelope(env, { fresh: true }, { recovered: true, resume })
            : this.receiveEnvelope(env, { fresh: true }, { recovered: true }));
          recovered += 1;
        } catch (err) {
          this.ctx.logger.warn('[conversation] 恢复面：信封 ' + id + ' 重投失败——' + String(err));
          // R1 fail-safe：续跑面失败补 interrupted settled——防 defer 悬置
          //（下次 boot resume 态失效 → 常规重投收敛，不再永占 defer 集）。
          if (resume !== null && resume !== 'degraded') {
            try { await this.ctx.ledger.settleMechanismFor(uuid, 'run-' + env.requestId, 'interrupted'); } catch { /* 尽力收口 */ }
          }
        }
      }
    }
    return recovered;
  }

  /**
   * boot 收尾一致性对账（cr-666，leftovers C2）：crash 窗口「只落账未执行」
   * 的入站信收敛——deliverRow 落账后、plan 队列/inbox durable 落盘前壳死，
   * 该信既无 run 轨迹也不在 inbox（recoverPendingInbox 只扫 inbox durable）
   * → 死信直到下一条消息带出（cr-648 观测一次，本面把「观察一次」变成
   * 确定性收敛）。判据全取盘上事实：会话末段连续入站 user 行（requestId 非
   * reply- 前缀）× journal 无 run-<requestId> 轨迹且无同 requestId 注入行
   * × 不在机器队列 × 不在 inbox durable → 经 deliver 补投（落账幂等由
   * requestId 承担；replyTo=user 防 postReply 自激——cr-638 同款）。
   */
  async reconcileUndelivered(): Promise<number> {
    const sessionsRoot = path.join(this.ctx.ledger.agentDirOf(), 'sessions');
    let uuids: string[] = [];
    try { uuids = readdirSync(sessionsRoot); } catch { return 0; }
    let redelivered = 0;
    for (const uuid of uuids) {
      const dir = path.join(sessionsRoot, uuid);
      const { rows } = readLedger(dir);
      const lines = readJournal(dir);
      // 逆序收敛末段未决入站（遇首条已消费形态行止：终稿 / 回执 / 机制行）。
      // 行龄门（cr-666 实测修正）：只收 boot 前落账的行——死信恒为上代壳所写；
      // 本代进行中的写入（旁路 writer / 在途 run）落账晚于服务创建，误收会
      // 把进行中消息当死信补投（e2e-cli 实锤：reconcile 竞态多出一行 error 回执）。
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        const rowAt = Date.parse(row.timestamp);
        if (Number.isFinite(rowAt) && rowAt > this.bootedAtMs) continue; // 本代写入——不动
        if (row.role !== 'agent' || row.agent_id === this.agentId) break; // 终稿行止
        const req = row.requestId;
        if (typeof req !== 'string' || req === '' || req.startsWith('reply-')) break;
        if (row.agent_id !== 'user') break; // receipt 等机制行天然无 run——不收敛
        const runKey = 'run-' + req;
        const hasTrace = lines.some((l) => l.run === runKey
          || (l.type === 'journal-inject' && l.requestId === req));
        const queued = this.machineFor(uuid).queued(uuid).some((t) => t.id === req); // 队列快照 id = requestId
        const inInbox = this.ctx.ledger.inboxRead(uuid, req) !== null;
        if (hasTrace || queued || inInbox) continue; // 在途——由既有恢复面消费
        // recovered 语义补投：落账行盘面查重（行已在 = 短路不双写——writer
        // 幂等门在内存，跨树重建不防双写，cr-639 同因）；replyTo=user 防回投
        // 自激（cr-638）。
        await this.receiveEnvelope({
          uuid,
          requestId: req,
          sender: row.agent_id,
          to: this.agentId,
          kind: 'message',
          budget: 3,
          payload: { text: row.content },
          replyTo: 'user',
        }, { fresh: true }, { recovered: true });
        redelivered += 1;
      }
    }
    return redelivered;
  }

  /**
   * boot 恢复面（cr-636）：answered ask_questions 交互跨壳重放。
   *
   * 断链场景：作答时发起 run 已死且壳已换代（原 run interrupted 崩溃/宿主
   * 重启窗口）——主线 late-reply deliver 只在壳内事件面消费，新壳 boot 后
   * openByRun 内存登记恒空、无人重投，答案永久滞留盘上（dur-mvjk1ook
   * 实锤：answered 落盘正确、转录有答案行但无任何 run 跟随）。
   *
   * 重放口径 = 主线 late-reply 同款：answerNotice 正文（单源 import）经
   * receiveEnvelope 标准链重投——落账行去重由 transcript 比对承担：正文
   * 中的 interaction id 在会话账本在场 = 已消费（同款重放幂等键）。
   * 重投 run 收束成功后 close('consumed')——收缩下次扫描面（终态记录
   * 保留期缺省 7 天，sweep 归 durable-interaction 行自身节奏）。
   * 队列在途同 id 跳过（recoverPendingInbox 已覆盖该面）；busy 交由
   * receiveEnvelope 决策（plan=queue 排队——链跑消费，不丢）。
   */
  async replayAnsweredInteractions(): Promise<number> {
    const di = this.ctx.get('durableInteraction', false) as
      | { list(filter?: { kind?: string; owner?: string; state?: string }): Array<{ id: string; key: string; kind: string; owner?: string; payload?: unknown; answer?: unknown }>;
          close(id: string, reason?: string): boolean }
      | undefined;
    if (di === undefined) return 0; // 行集不含 durable-interaction 行——无重放面
    const pending = di.list({ kind: 'ask_questions', owner: this.agentId, state: 'answered' });
    let replayed = 0;
    for (const record of pending) {
      const uuid = record.key;
      // 队列在途跳过：该交互答案已在机器队列排队（recoverPendingInbox 面）
      if (this.machineFor(uuid).queued(uuid).some((t) => t.preview.includes(record.id))) continue;
      // 转录在场判定：answerNotice 正文精确行比对（正文含 interaction id），
      // 比对不限 role（late-reply 落 assistant 侧、inject 落 agent 侧都有）。
      // 已消费 = 答案行之后有终稿级文本行；仅答案行在场而其后无终稿（原 run
      // interrupted——落账了但 run 未拉起）仍重放。
      const notice = answerNoticeOf(record);
      // 比对扫原始账本行而非 historyFor 投影（cr-747）：replayView 滤掉
      // source='inject' 行（run 回放防双计），而 steer/挂起注入路径消费的
      // notice 恒落 inject 行——投影比对恒失配，已消费答案被误判未消费、
      // 每次重启重放（现场 dur-mvrrebv9：row7 inject 消费 + row10 重放双投）。
      const rows = readLedger(path.join(this.ctx.ledger.agentDirOf(), 'sessions', uuid)).rows;
      const idx = rows.findIndex((r) => r.content === notice);
      if (idx >= 0 && rows.slice(idx + 1).some((r) => r.role === 'agent' && r.content.trim() !== '' && r.source !== 'segment' && r.source !== 'inject')) continue;
      await this.deliver(this.agentId, notice, {
        sender: this.agentId,
        source: 'event',
        conversationId: uuid,
        requestId: 'late-reply-' + record.id,
        // 终稿回信目标 = user（cr-638）：sender 恒 owner 保 replayView 投影，
        // 但回信必须投 user——缺 replyTo 时 postReply 投回自身，自激回环
        // （壳内单 agent，收束点又能投给自己 = 每轮再拉一轮 run）。
        replyTo: 'user',
      });
      di.close(record.id, 'consumed');
      replayed += 1;
    }
    return replayed;
  }

  /** 在途 run 会话面（admin run-state 帧消费——宿主 runs/snapshot 活跃集数据源）。
   *  cr-746 per-门后一壳可多 run：主形状 = runs 数组（含各自 machine 的门态）；
   *  兼容面 = busy/startedAt 取最早 run、runId/queuedTurns 取最早门的值
   *  （旧单 run 消费方读形状不变——runs/interrupt 等已改读 runs 数组）。 */
  runState(): {
    busy: boolean; conversationId: string | null; runId: string | null; startedAt: number | null; queuedTurns: number;
    runs: Array<{ conversationId: string; runId: string | null; startedAt: number; queuedTurns: number }>;
    /** cr-748：最近收束尾巴（旧壳消费方缺省忽略——可选字段零破坏） */
    recentSettled: Array<{ runId: string; conversationId: string; finishedAt: number; finish: 'ok' | 'interrupted' | 'error' }>;
  } {
    const runs = [...this.activeRuns.entries()].map(([key, r]) => {
      const st = this.machines.get(key)?.state();
      return {
        conversationId: r.conversationId,
        runId: st?.currentRun ?? null,
        startedAt: r.startedAt,
        queuedTurns: st?.queuedTurns ?? 0,
      };
    }).sort((a, b) => a.startedAt - b.startedAt);
    const first = runs.length > 0
      ? runs[0]
      : { conversationId: null as string | null, runId: null as string | null, startedAt: null as number | null, queuedTurns: 0 };
    return {
      busy: runs.length > 0,
      conversationId: first.conversationId,
      runId: first.runId,
      startedAt: first.startedAt,
      queuedTurns: first.queuedTurns,
      runs,
      recentSettled: [...this.recentSettled],
    };
  }

  /** 收束尾巴入列（cr-748）：容量 8 环形挤出。finishedAt 域与 startedAt 同源
   *  （Date.now()——新旧 run 起收时序可比） */
  private noteSettled(runId: string, conversationId: string, finish: 'ok' | 'interrupted' | 'error'): void {
    this.recentSettled.push({ runId, conversationId, finishedAt: Date.now(), finish });
    if (this.recentSettled.length > 8) this.recentSettled.shift();
  }

  // —— next-turn 队列读写（排队 UI 数据面；主线 queue/removeQueued/steerQueued 同语义） ——

  /** 排队消息快照（conversationId 缺省 = user 直答对桶） */
  queue(conversationId?: string): Array<{ id: string; preview: string; sender: string; queuedAt: number; source?: string; conversationId?: string }> {
    return this.machineFor(conversationId ?? pairKey('user', this.agentId)).queued(conversationId);
  }

  /** 删除一条排队消息（同步清 inbox durable；已消费/不存在 → false）。
   *  id 全局唯一（requestId）——遍历各门查找。 */
  removeQueued(id: string): boolean {
    for (const m of this.machines.values()) {
      const removed: QueuedTurn | null = m.removeQueued(id);
      if (removed !== null) {
        if (removed.conversationId !== undefined) {
          this.ctx.ledger.inboxClear(removed.conversationId, id);
          this.emitQueueChanged(removed.conversationId); // 队列缩减点
        }
        return true;
      }
    }
    return false;
  }

  /**
   * 排队消息插话（DSH 严格 steering 语义）：原子出队 → 注入活跃 run 下一步；
   * 窗口已关（空闲/收束竞态）→ 原位放回返回 'requeued'（不报失败，仍按队列投递）；
   * 条目不存在（已消费/已删）→ 'not-found'。
   */
  async steerQueued(id: string): Promise<'steered' | 'requeued' | 'not-found'> {
    // id 全局唯一（requestId）——定位条目所在门
    let machine: ConversationMachine | null = null;
    let taken: { item: QueuedTurn; index: number } | null = null;
    for (const m of this.machines.values()) {
      taken = m.steerTake(id);
      if (taken !== null) { machine = m; break; }
    }
    if (machine === null || taken === null) return 'not-found';
    const { item, index } = taken;
    const uuid = item.conversationId;
    // 窗口判定：本会话门非 busy / 会话键缺席（旧入队形态）/ 空预览 → 放回原位
    if (!machine.state().busy || uuid === undefined || item.preview === '') {
      machine.steerRestore(item, index);
      return 'requeued';
    }
    const handle = this.steerHandle(uuid);
    const injected = this.ctx.agentLoop.steer(handle, { role: 'user', content: item.preview });
    if (!injected) {
      machine.steerRestore(item, index);
      return 'requeued';
    }
    await this.ctx.ledger.journalInject(uuid, machine.state().currentRun ?? '', item.preview, item.requestId);
    this.ctx.ledger.inboxClear(uuid, item.requestId);
    this.emitQueueChanged(uuid); // 队列缩减点（steer 出队）
    return 'steered';
  }

  /** 上下文注入落账口（cr-625：主线 session.recordContext 的壳侧形态——
   * run 活跃 journal-inject 落账〔消费点真序〕+ session/context-injected
   * 事件发射〔前端直播行〕。主线 ask-questions 行经 SessionShim 零改动
   * 消费：作答注入（已收到用户回答）/ 未响应通知两形态同口）。run 不活跃
   * 不落账（该路径调用点恒 run 活跃；跨 run 持久归 late-reply deliver）。
   *
   * cr-707 两处根修：
   *  · 注入身份缺省即铸（injectionId）——直播帧与 settlement 物化行同锚
   *    （物化行 message_id = injectionId），前端 mergeHistoryPage 双键去重
   *    才能把「直播行」与「刷新行」认成同一份注入事实；
   *  · 事件先于落盘：journal IO 挡在帧前会让续跑帧（step-started/delta）
   *    超车——注入行在直播流里被顶到后续步之后（用户实测「挂到倒数第二」）。
   *    label/injectSource/ts 一并随行落盘（此前只进事件，刷新即丢文案）。 */
  async recordContext(
    conversationId: string,
    content: string,
    extra: { source: string; label?: string; injectionId?: string },
  ): Promise<void> {
    const injectionId = extra.injectionId ?? 'inj-' + crypto.randomUUID();
    const ts = Date.now();
    this.ctx.emit('session/context-injected', conversationId, this.agentId, {
      source: extra.source,
      injectionId,
      ...(extra.label !== undefined ? { label: extra.label } : {}),
    });
    const run = this.machines.get(this.gateKey(conversationId))?.state().currentRun ?? '';
    if (run === '') return;
    await this.ctx.ledger.journalInject(conversationId, run, content, undefined, {
      injectionId,
      injectSource: extra.source,
      ...(extra.label !== undefined ? { label: extra.label } : {}),
      ts,
    });
  }

  /** 落账 kind（sender 归域：群地址 group / user 直发 user / 跨壳 agent——
   * receiveEnvelope 与 steer 落空转投点共用单源） */
  private ledgerKindOf(env: Envelope): string {
    return env.to.includes('~') ? 'group' : env.sender === 'user' ? 'user' : 'agent';
  }

  /** steer 寻址（主线 runAddress 词汇：conversationId ≠ agent → `<uuid>~<agent>`） */
  private steerHandle(uuid: string): string {
    return uuid === this.agentId ? this.agentId : uuid + '~' + this.agentId;
  }

  private textOf(env: Envelope): string {
    const payload = env.payload as { text?: string } | null;
    return typeof payload?.text === 'string' ? payload.text : '';
  }

  /**
   * 配置直读（run 前重读——A14 同拍）：shadow 形态读 children 嵌套域。
   * 公开方法：agent-admin 预览面（boot 控制帧）与 run 链共用同一读取。
   */
  readConfig(): AgentConfig {
    const config = this.parentId !== undefined
      ? readChildConfig(this.dataRoot, this.parentId, this.agentId)
      : readAgentConfig(this.dataRoot, this.agentId);
    if (config === null) throw new Error('agent 配置缺席：' + this.agentId);
    return config;
  }

  /**
   * System Prompt 装配预览（cr-552 跨进程 dry-run 的壳内半边）：以干跑
   * 请求过三档装配链（before-run-first → before-run → before-run-last，
   * 主线 agent-admin systemPromptPreview 同构）——persona/system-prompt/
   * memory 等全部组装器真实生效，但不发 run（不落账、不占串行化门、
   * 无 LLM 调用）。virtual 身份无系统提示词 fail-loud。
   * 请求装配口径与 driveRun 同源（readConfig/toolFaceOf/sender=user/
   * 缺省键 pairKey('user', agent)）——预览 = 真实 run 的装配面镜像。
   */
  async previewSystemPrompt(conversationId?: string): Promise<string> {
    const config = this.readConfig();
    if (config.virtual === true) throw new Error('Agent "' + this.agentId + '" 是 virtual（无系统提示词）');
    // 工具面与 driveRun 同源走 llmToolFace（cr-590 行 id 展开 + cr-593
    // 模式收窄——tc-programmatic 会话干跑请求面 = ['run_code']，run_code
    // 行的 SDK 投影注入（isModeToolFace 判定）随之到达；直读
    // resolveToolNames/toolFaceOf 是未收窄全量面，投影块永不注入 =
    // 前端 SystemPromptPanel 看不到程序化 SDK 的根因）。
    const tools = this.llmToolFace(config, conversationId);
    const request = {
      agent: this.agentId,
      ...this.modelRefOf(config),
      ...(config.system !== undefined ? { system: config.system } : {}),
      tools,
      sender: 'user',
      source: 'user' as const,
      conversationId: conversationId ?? pairKey('user', this.agentId),
      messages: [],
    };
    const call = { request };
    await this.ctx.waterfall('loop/before-run-first', call, () =>
      this.ctx.waterfall('loop/before-run', call, () =>
        this.ctx.waterfall('loop/before-run-last', call, async () =>
          ({ steps: [], text: '', finish: 'stop', usage: null }) as never)));
    // 读载体 call.request（组装器以替换 request 的方式变异载体——本地别名仍是旧对象）
    return call.request.system ?? '';
  }

  /**
   * 全量工具目录（tools/list 的壳内半边，cr-582）：注册面附注册方行名
   * （listWithOwner——owner 是框架侧事实不进定义契约）——UI 按来源行分组
   * 折叠（主线 tools/list / assemblyView catalog 同形）。
   */
  toolsCatalog(): Array<{
    name: string; description: string; parameters: Record<string, unknown>; owner: string;
    requiredTags?: string[]; needPermission?: boolean;
  }> {
    return this.ctx.tools.listWithOwner().map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: (t.parameters ?? {}) as Record<string, unknown>,
      ...(t.requiredTags ? { requiredTags: t.requiredTags } : {}),
      ...(t.needPermission ? { needPermission: true } : {}),
      owner: t.owner,
    }));
  }

  /**
   * 装配工具目录（agents/assembly 的壳内半边——cr-552）：已注册工具全量
   * 目录（含 owner 分组锚点，cr-582 补齐）+ 生效集（行集投影）。宿主
   * agent-admin 行拿目录数据源。
   */
  assemblyToolsView(): {
    tools: ReturnType<ConversationService['toolsCatalog']>;
    enabled: string[];
  } {
    const all = this.ctx.tools.list();
    const config = this.readConfig();
    // 现算不经缓存：预览语义 = 当前落盘态的镜像（写口落盘后立即可见）
    return {
      tools: this.toolsCatalog(),
      enabled: this.toolFaceOf(config) ?? all.map((t) => t.name),
    };
  }

  /**
   * LLM 工具面单源（cr-593）：行集词形展开（toolFaceOf）∩ 非 mode 可见面 →
   * 工具调用模式收窄（effectiveToolMode + narrowToolsByMode——主线 router
   * dispatch 同口径单源引用）。估算面（toolDefs）与真实 run（driveRun /
   * reviewRun）共用——此前 run 面不收窄：tc-programmatic 会话估算报
   * mode 集而真 run 拿全量面（Agent 自省「生效集 1 个工具」的实锤根源）。
   */
  private llmToolFace(config: AgentConfig, conversationId?: string): string[] {
    const allDefs = this.ctx.tools.list();
    const visible = new Set(allDefs.filter((t) => t.injection !== 'mode').map((t) => t.name));
    const resolved = this.toolFaceOf(config) ?? [...visible];
    const mode = effectiveToolMode(config, conversationId, {
      convSettings: this.ctx.get('convSettings', false) as
        | { get(conversationId: string): { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' } }
        | undefined,
    });
    return narrowToolsByMode(resolved.filter((n) => visible.has(n)), allDefs, mode);
  }

  /**
   * 生效工具集（agents/tool-defs 估算面——Token 仪表固定开销，cr-582；
   * 主线 web-api 同构）：可见面 = 注册面去 mode 工具（preview 无会话授权
   * caps 面——授权在执行时 gate〔cr-527 A14〕，LLM 面不按会话收窄）；
   * config.rows 点名 ∩ 可见面；模式收窄单源引用主线纯函数（估算与真实
   * run 同口径），会话覆盖经 convSettings 垫片现读。
   */
  toolDefs(conversationId?: string): {
    names: string[];
    defs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  } {
    const config = this.readConfig();
    const allDefs = this.ctx.tools.list();
    const names = this.llmToolFace(config, conversationId);
    return {
      names,
      defs: allDefs
        .filter((t) => names.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description ?? '', parameters: (t.parameters ?? {}) as Record<string, unknown> })),
    };
  }

  /** 工具面（行集投影——AgentConfig.tools 点名 ∨ 行引用解析；缺省 = 全部注册）。
   * per-config 值缓存：写口落盘后 config.tools 变化即键变，天然失效。
   * 行 id 展开（cr-590）：条目词形 = 行 id 时换行工具名（'fs-tools' →
   * read/write/edit）；工具名/tag 词形原样透传（visible ∩ 在 toolDefs/run
   * 装配处收敛）。 */
  private toolFaceCache: { key: string; face: string[] | undefined } | null = null;
  private toolFaceOf(config: { rows?: string[] | { include?: string[]; exclude?: string[] } }): string[] | undefined {
    const key = JSON.stringify(config.rows ?? null);
    if (this.toolFaceCache?.key !== key) {
      const resolved = resolveToolNames(config.rows);
      // 展开去重保序（多行别名/点名并集不产重复名——LLM schema 面干净）
      const expanded = resolved === undefined ? undefined
        : [...new Set(resolved.flatMap((token) => this.rowTools?.[token] ?? [token]))];
      this.toolFaceCache = { key, face: expanded };
    }
    return this.toolFaceCache.face;
  }

  /** inbox 取信（链跑消费） */
  private takeFromInbox(uuid: string, requestId: string): Envelope | null {
    const stored = this.ctx.ledger.inboxRead(uuid, requestId);
    if (stored === null) return null;
    const env = stored as Envelope;
    this.ctx.ledger.inboxClear(uuid, requestId);
    return env;
  }

  /** 跨壳回复（邮局投递——sender 端点可达性由邮局路由判定） */
  private async postReply(to: string, uuid: string, text: string, orig: Envelope, runId: string): Promise<void> {
    // 自回环防线（cr-638）：目标 = 本壳 agent 即自己回自己，投递会再拉一轮
    // run（预算耗尽前反复自答、用户侧却收不到终稿）。fail-open 到日志——
    // 正常路径（user / 跨壳 agent）永不命中。
    if (to === this.agentId) {
      process.stderr.write('[shell] 终稿回信目标 = 自身（' + to + '），已跳过投放（replyTo 缺省回环）\n');
      return;
    }
    const replyConversation = replyConversationOf(orig);
    const reply = {
      uuid,
      requestId: 'reply-' + orig.requestId,
      sender: this.agentId,
      to,
      kind: 'message' as const,
      budget: Math.max(0, orig.budget - 1),
      // payload.run（cr-595）：终稿产生 run 的键——user 壳写穿 user 账本时
      // 盖 source=run:<id> 戳，webui history 据此联查 agent 账本 journal 带出
      // 思考/工具卡（D4.2）。缺席 = 读侧无键可联（刷新后只剩终稿文本）。
      // replyConversation（cr-711）：任务发起会话键原样回带——父壳据此把
      // 子 Agent 完成回执投回发起会话（user⇄父），而非唤醒父⇄子对桶。
      // completion 标记（cr-712）：回信（而非任务信封）才携带——收方据它
      // 判定「完成回执」转投发起会话；任务信封只带 replyConversation 不带
      // 此标记（判据混用会把委托任务当回执吞掉）。
      payload: {
        text,
        run: runId,
        ...(replyConversation !== undefined ? { replyConversation, completion: true } : {}),
      },
    };
    // 子 Agent 回信直投（cr-710）：子壳注册的端点是 `<parent>--<child>`
    //（boot 影子形态），裸子 id 在宿主可达表恒缺席——投邮局会触发宿主
    // ensureHook 按需拉起一个同 id 的顶层幽灵身份（空 config），回信即误投
    // 且互答链跨身份延续。在管（subagent 行持有句柄或物化清单）= 直投其
    // ipc；已退出的子 Agent 直接丢弃（不投邮局防幽灵）。
    const children = this.ctx.get('subagents', false) as OwnedChildFace | undefined;
    if (children?.ownsChild?.(to) === true) {
      const delivered = await children.deliverToChild?.(to, reply) ?? false;
      if (!delivered) {
        process.stderr.write('[shell] 回信目标 ' + to + ' 是本壳子 Agent 但当前不可达（已退出/无活锁）——不投邮局（防幽灵顶层身份）\n');
      }
      return;
    }
    await this.sendEnvelope(reply);
  }

  /** 跨壳信封发送（邮局 dispatch——deliver 跨壳面 / 群扇出 / postReply
   * 共用）。断链重试（cr-628/629）：宿主重启窗口（restart_host / 崩溃
   * 复活）邮局管道断——send 抛错后弃连接重连重试（run 键行只能经邮局
   * 到达 user 壳，一次失败即丢 = 刷新后 run 蒸发）。10 次 × 2s ≈ 20s，
   * 覆盖宿主复活档（supervisor 重拉退避基档 1.5s + boot 秒级）。 */
  async sendEnvelope(env: Envelope): Promise<void> {
    if (this.postOfficeAddress === undefined) {
      throw new Error('邮局未装配（CLI 直连形态）——跨壳投递不可用');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureOutbound();
        await this.outbound!.send(env);
        return;
      } catch (err) {
        if (attempt >= 9) throw err;
        this.outbound?.close();
        this.outbound = null;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  /** 邮局连接惰性建立（postReply / 断链重连共用半边） */
  private async ensureOutbound(): Promise<void> {
    if (this.outbound !== null) return;
    const { IpcClient } = await import('ac-post-office');
    const client = new IpcClient();
    await client.connect(this.postOfficeAddress!);
    this.outbound = {
      send: (e: Envelope) => client.send(e),
      close: () => client.close(),
    };
  }

}

// 服务键 'conversation' 不重复 declare——主线 ac-conversation 已占用该键
//（declare module 全局合并同键须同类型）；preview 运行时注册同名服务，
// 方法面提供主线消费方言叶子集（deliver→ConversationOutcome）+ preview
// 专属信封入站（receiveEnvelope——boot 收信面经 ctx.get 软取，主线
// sessionCapsOf 同惯例）。cutover 后主线行退役，本行成为唯一提供者。

/** conversation 行工厂（boot rowAssemblers 装配） */
export function makeConversationRow(options: ConversationRowOptions): Plugin {
  return {
    name: 'shell-conversation-row',
    // tools = run 装配硬依赖（cr-639）：llmToolFace 每轮 run 要 ctx.tools
    // 投影工具面——此前未声明，事件派生异步链（late-reply 唤醒等）里属性
    // 访问抛 "cannot get property tools without inject"，被发起方 .catch
    // 静默吞掉 = 唤醒 run 从未真正拉起（cr-636 报告与 run 7vmy 丢失同根因）。
    inject: ['agentLoop', 'ledger', 'tools'],
    apply(ctx: Context) {
      ctx.plugin(class extends ConversationService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
