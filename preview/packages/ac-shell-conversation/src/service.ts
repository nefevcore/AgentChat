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

/**
 * 终稿回信目标（cr-638）：replyTo（显式指定）优先 → sender（信源即回信
 * 目标，大多数信封同源）。目标 = 本壳 agent 时返回 null——自己回自己会
 * 再拉起一轮 run（壳内单 agent + 收束点回投 = 自激回环：每轮自答一次，
 * 用户侧还收不到终稿，只因预算衰减才停）。
 */
export function replyTargetOf(env: Envelope, agentId: string): string | null {
  const to = env.replyTo ?? env.sender;
  return to === agentId ? null : to;
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
  /** 当前 run 的中止信号（stop 面——boot 控制帧 interrupt 消费） */
  private currentAbort: AbortController | null = null;
  /** 当前占门 run 的会话面（runState 消费——runs/snapshot 的壳内半边） */
  private activeRun: { conversationId: string; startedAt: number } | null = null;
  private machine = new ConversationMachine('shell');
  /** 安全重启挂起标记（cr-629：restart_shell 置位——当前 run 收束点消费） */
  private restartPending = false;
  /** 跨壳发信面（惰性连接邮局） */
  private outbound: { send(env: Envelope): Promise<unknown>; close(): void } | null = null;

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
  async receiveEnvelope(env: Envelope, ack: { fresh: boolean }, opts: { recovered?: boolean } = {}): Promise<'deduped' | 'ledger-only' | 'queued' | 'steered' | 'settled'> {
    const ledger = this.ctx.ledger;
    const uuid = env.uuid;
    const payload = env.payload as { text?: string; lane?: string; placement?: string } | null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    // 忙态投递方式（cr-575 队列产品化）：信封 payload 白名单窄化后入决策——
    // next-turn / next-run = busy 时排队（QueueDock 数据面），steer = 注入活跃 run
    const lane = payload?.lane === 'next-step' || payload?.lane === 'next-turn' ? payload.lane : undefined;
    const placement = payload?.placement === 'steer' || payload?.placement === 'next-run' ? payload.placement : undefined;
    // kind 词汇面：receipt/grant/revoke = ledger-only（A4——不进 inbox 不激活）
    const plan: DeliverPlan = env.kind !== 'message'
      ? { action: 'ledger-only', reason: env.kind === 'receipt' ? 'receipt' : 'control' }
      : this.machine.plan({
        kind: 'message',
        sender: env.sender,
        requestId: env.requestId,
        admitted: ack.fresh,
        conversationId: uuid,
        preview: text,
        source: env.sender === 'user' ? 'user' : 'agent',
        ...(lane !== undefined ? { lane } : {}),
        ...(placement !== undefined ? { placement } : {}),
      });
    // 落账（A2：delivered 即 ack——requestId 幂等在 ledger writer 内）。
    // kind 按 sender 归域：user/agent 1v1 = 'user'；群地址 = 'group'；
    // 跨壳 agent 会话 = 'agent'（与 user 账本〔kind: 'user'〕投影分层对齐）
    const kind = env.to.includes('~') ? 'group' : env.sender === 'user' ? 'user' : 'agent';
    // recovered（cr-629 boot 恢复面）：inbox durable 里的信在首次入站时已
    // 落账（writer 内存 AdmissionGate 跨进程不幂等——重投会双写行），跳过。
    if (opts.recovered !== true) await ledger.deliverRow(uuid, [this.agentId, env.sender], kind, {
      role: 'agent',
      content: text,
      agent_id: env.sender,
      requestId: env.requestId,
      uuid,
    });
    // 队列快照推送（cr-579）：plan=queue = 队列新增点——权威快照 emit
    if (plan.action === 'queue') this.emitQueueChanged(uuid);
    // inbox durable（A4：busy 排队的信才进 inbox——plan=run 本轮直接消费、
    // plan=steer 注入活跃 run，均无排队事实；收束链跑只消费机器队列成员，
    // plan=run 信封入 inbox 即成孤儿〔idle 探针恒忙根因，cr-548〕）
    const afterBudget = budgetAfterReceive(env.budget, env.sender);
    if (plan.action === 'queue' && entersInbox(env.kind, afterBudget)) {
      ledger.inboxStore(uuid, env);
    }
    if (plan.action === 'run' || plan.action === 'steer') {
      const outcome = await this.driveRun(uuid, env, plan);
      // 恢复面消费即清（cr-629）：run/steered = 已消费——inbox 剔行防下代
      // 重启再重投（queued = steer 落空转投已回存，保留）。
      if (opts.recovered === true && outcome !== 'queued') {
        this.ctx.ledger.inboxClear(uuid, env.requestId);
      }
      return outcome; // 'steered' | 'settled' | 'queued'（steer 落空转投队列，cr-627）
    }
    // queue / ledger-only / deduped：落账即全部职责（队列消费在 run 收束点）
    return plan.action === 'queue' ? 'queued' : plan.action;
  }

  // —— 主线消费方言叶（collab-tools 等 inject 'conversation' 的行——方法面
  // 子集适配：deliver 组装主线 ConversationOutcome 形状；目标非本壳 agent =
  // 跨壳经邮局。preview 壳内目标恒 self（本 agent），跨壳投递走 postReply 面。）

  /** 串行化门快照（主线 web-api 消费） */
  isBusy(): boolean {
    return this.machine.state().busy;
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
    options: { sender?: string; source?: string; conversationId?: string; requestId?: string; timeoutMs?: number; replyTo?: string } = {},
  ): Promise<
    | { kind: 'run'; result: { steps: unknown[]; text: string; finish: string; usage: { prompt: number; completion: number; promptAccumulated: number; steps: number } } }
    | { kind: 'steered'; handle: string }
    | { kind: 'queued'; handle: string }
    | { kind: 'timeout'; handle: string }
    | { kind: 'deduped'; handle: string }
  > {
    const content = typeof inbound === 'string' ? inbound : inbound.content;
    const sender = options.sender ?? 'user';
    const uuid = options.conversationId ?? pairKey(sender, this.agentId);
    const handle = uuid === this.agentId ? this.agentId : uuid + '~' + this.agentId;
    const env: Envelope = {
      uuid,
      requestId: options.requestId ?? 'local-' + crypto.randomUUID(),
      sender,
      to: agentId,
      kind: 'message',
      budget: 3,
      payload: { text: content },
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

  private async driveRun(uuid: string, env: Envelope, plan: DeliverPlan): Promise<'steered' | 'settled' | 'queued'> {
    if (plan.action === 'steer') {
      // steer：注入活跃 run（主线 loop Service 方法——runAddress 词汇）
      const handle = this.steerHandle(uuid);
      const injected = this.ctx.agentLoop.steer(handle, { role: 'user', content: this.textOf(env) });
      if (injected) {
        await this.ctx.ledger.journalInject(uuid, plan.runId, this.textOf(env), env.requestId);
        return 'steered';
      }
      // steer 落空（cr-627）：活跃 run 属其他会话（单机串行化门多会话并发
      // 常态——steer 按 runAddress 寻址，跨会话不匹配）或收束封口后迟到。
      // 此前只 return（注释承诺「入 inbox 由收束点链跑消费」但未实现）——
      // 消息仅剩 deliverRow 落账，run 永不拉起（作答/投递静默丢失根源）。
      // 转投：inbox durable + 机器 turnQueue 补入队尾，当前 run 收束点链跑消费。
      const afterBudget = budgetAfterReceive(env.budget, env.sender);
      if (entersInbox(env.kind, afterBudget)) this.ctx.ledger.inboxStore(uuid, env);
      this.machine.requeue({
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
    this.currentAbort = abort;
    let runId = '';
    let restartNow = false;
    try {
      const config = this.readConfig();
      runId = 'run-' + env.requestId;
      this.machine.runStarted(runId);
      this.activeRun = { conversationId: uuid, startedAt: Date.now() };
      for (;;) {
        const history = this.ctx.ledger.historyFor(uuid);
        const result = await this.ctx.agentLoop.run({
          runId,
          agent: this.agentId,
          ...this.effectiveModelRef(config, env.model),
          ...(config.system !== undefined ? { system: config.system } : {}),
          tools: this.llmToolFace(config, uuid),
          ...(config.maxSteps !== undefined && config.maxSteps > 0 ? { maxSteps: config.maxSteps } : {}),
          sender: env.sender,
          source: env.sender === 'user' ? 'user' : 'agent',
          conversationId: uuid,
          messages: [...history, { role: 'user', content: this.textOf(env) }],
          // 单次投递提权（cr-626）：信封 elevation → loop request（主线每步
          // 装配进 ToolCall.elevation——full-access 档工具行跳过沙箱白名单）。
          ...(env.elevation !== undefined ? { elevation: env.elevation } : {}),
          signal: abort.signal,
        });
        // settle（终稿 + journal-settled；error 文本如实入账）
        const finish = result.finish === 'error' ? 'error' : result.finish === 'interrupted' ? 'interrupted' : 'ok';
        await this.ctx.ledger.settleRun(uuid, [this.agentId, env.sender], 'user', {
          role: 'agent',
          content: result.text,
          agent_id: this.agentId,
          requestId: 'reply-' + env.requestId,
          uuid,
          run: runId,
        }, runId, finish);
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
        if (this.postOfficeAddress !== undefined && replyTo !== null && (result.text !== '' || replyTo === 'user')) {
          await this.postReply(replyTo, uuid, result.text, env, runId);
        }
        // 安全重启收口（cr-629，restart_shell）：在途信封从未消费完——标记
        // 后跳出链跑（回队动作在 finally 之后——finally 的幂等 runSettled 会
        // shift 队列头，先回队会被它吞掉）。boot 收到 restart-ready 即以
        // 重启码 42 退出；宿主 respawn 新壳，boot 恢复面经 recoverPendingInbox
        // 重投续跑。
        if (this.restartPending) {
          this.restartPending = false;
          restartNow = true;
          break;
        }
        // 链跑：next-turn 队列消费（收束即重占门——runSettled 后同步
        // runStarted，见方法头注释；takeFromInbox 落空 = 该 turn 无信封可跑，
        // break 后 finally 幂等收口）
        const next = this.machine.runSettled(env.sender !== 'user');
        if (next === null) break;
        // 链跑取信按条目会话键（cr-627）：单机串行化门多会话并发——队列里
        // 可能混有其他会话的转投信（steer 落空/排队），按当前 run 会话取会
        // 永远取不到 → 出队即丢。run 随信封的会话走（historyFor/落账同键）。
        const nextCid = next.conversationId ?? uuid;
        const nextEnv = this.takeFromInbox(nextCid, next.requestId);
        if (nextEnv === null) break;
        this.emitQueueChanged(nextCid); // 队列缩减点（链跑消费出队）
        uuid = nextCid;
        env = nextEnv;
        runId = 'run-' + env.requestId;
        this.machine.runStarted(runId);
      }
    } finally {
      this.machine.runSettled(false); // 幂等收口（链跑循环内已逐轮 settled）
      this.activeRun = null;
      if (this.currentAbort === abort) this.currentAbort = null;
    }
    // 安全重启回队（finally 后——见循环内标记点注释）：在途信封回 inbox
    // durable + 机器队尾（steer 落空转投同形，cr-627）+ restart-ready 通知。
    if (restartNow) {
      const afterRestart = budgetAfterReceive(env.budget, env.sender);
      if (entersInbox(env.kind, afterRestart)) this.ctx.ledger.inboxStore(uuid, env);
      this.machine.requeue({
        requestId: env.requestId,
        conversationId: uuid,
        preview: this.textOf(env),
        sender: env.sender,
        ...(env.sender === 'user' ? { source: 'user' } : { source: 'agent' }),
      });
      this.emitQueueChanged(uuid);
      this.ctx.emit('conversation/restart-ready', this.agentId);
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
    // 串行化门：busy → 入 next-turn 队列等待（整理是机制任务，不抢用户 run）
    while (this.machine.state().busy) {
      await new Promise((r) => setTimeout(r, 50));
      // 极端活锁防御：用户 run 长忙 + 整理排队——交给调用方 timeout 兜底
      if (opts.signal?.aborted) return { finish: 'interrupted', text: '' };
    }
    const config = this.readConfig();
    const runId = opts.runId;
    this.machine.runStarted(runId);
    this.activeRun = { conversationId: uuid, startedAt: Date.now() };
    const abort = new AbortController();
    const onOuterAbort = () => abort.abort(new Error('整理超时中止'));
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    this.currentAbort = abort;
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
      return { finish, text: result.text };
    } finally {
      opts.signal?.removeEventListener('abort', onOuterAbort);
      if (this.currentAbort === abort) this.currentAbort = null;
      this.activeRun = null;
      this.machine.runSettled(false);
    }
  }

  /** 队列变更权威快照 emit（主线 ac-conversation 同名事件同参序——boot 旁带发射） */
  private emitQueueChanged(uuid: string): void {
    const handle = uuid === this.agentId ? this.agentId : uuid + '~' + this.agentId;
    this.ctx.emit('conversation/queue-changed', this.agentId, uuid, handle,
      this.machine.queued(uuid).map((t): ConversationQueuedItem => ({
        id: t.id,
        preview: t.preview,
        sender: t.sender,
        source: (t.source ?? (t.sender === 'user' ? 'user' : 'agent')) as ConversationQueuedItem['source'],
        queuedAt: t.queuedAt,
      })));
  }

  /** 中止当前 run（stop 面——busy 时有效；返回是否在途） */
  interrupt(): boolean {
    if (this.currentAbort === null) return false;
    this.currentAbort.abort(new Error('stop 请求'));
    return true;
  }

  /**
   * 安全重启请求（cr-629，restart_shell 工具消费面）：busy → 中止当前
   * run + 挂起标记（收束点回队在途信封后发 conversation/restart-ready——
   * boot 收到即以重启码 42 优雅退出）；空闲 → 直接发。返回 true = 有
   * 在途 run（restart-ready 稍后到达）；false = 已发出。
   */
  requestRestart(): boolean {
    if (this.machine.state().busy) {
      this.restartPending = true;
      this.interrupt();
      return true;
    }
    this.ctx.emit('conversation/restart-ready', this.agentId);
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
        try {
          await this.receiveEnvelope(env, { fresh: true }, { recovered: true });
          recovered += 1;
        } catch (err) {
          this.ctx.logger.warn('[conversation] 恢复面：信封 ' + id + ' 重投失败——' + String(err));
        }
      }
    }
    return recovered;
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
      if (this.machine.queued(uuid).some((t) => t.preview.includes(record.id))) continue;
      // 转录在场判定：answerNotice 正文精确行比对（正文含 interaction id）。
      // 主线 late-reply deliver sender = owner（本 agent）→ replayView 投成
      // assistant 行——比对不限 role。已消费 = 答案行之后有终稿行；仅答案
      // 行在场而其后无终稿（原 run interrupted——落账了但 run 未拉起）仍重放。
      const notice = answerNoticeOf(record);
      const rows = this.ctx.ledger.historyFor(uuid);
      const idx = rows.findIndex((r) => r.content === notice);
      if (idx >= 0 && rows.slice(idx + 1).some((r) => r.role === 'assistant')) continue;
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

  /** 串行化门 + 当前 run 会话面（admin run-state 帧消费——宿主 runs/snapshot 活跃集数据源） */
  runState(): { busy: boolean; conversationId: string | null; runId: string | null; startedAt: number | null; queuedTurns: number } {
    const st = this.machine.state();
    return {
      busy: st.busy,
      conversationId: this.activeRun?.conversationId ?? null,
      runId: st.currentRun,
      startedAt: this.activeRun?.startedAt ?? null,
      queuedTurns: st.queuedTurns,
    };
  }

  // —— next-turn 队列读写（排队 UI 数据面；主线 queue/removeQueued/steerQueued 同语义） ——

  /** 排队消息快照（conversationId 缺省 = user 直答对桶） */
  queue(conversationId?: string): Array<{ id: string; preview: string; sender: string; queuedAt: number; source?: string; conversationId?: string }> {
    return this.machine.queued(conversationId ?? pairKey('user', this.agentId));
  }

  /** 删除一条排队消息（同步清 inbox durable；已消费/不存在 → false） */
  removeQueued(id: string): boolean {
    const removed: QueuedTurn | null = this.machine.removeQueued(id);
    if (removed?.conversationId !== undefined) {
      this.ctx.ledger.inboxClear(removed.conversationId, id);
      this.emitQueueChanged(removed.conversationId); // 队列缩减点
    }
    return removed !== null;
  }

  /**
   * 排队消息插话（DSH 严格 steering 语义）：原子出队 → 注入活跃 run 下一步；
   * 窗口已关（空闲/收束竞态）→ 原位放回返回 'requeued'（不报失败，仍按队列投递）；
   * 条目不存在（已消费/已删）→ 'not-found'。
   */
  async steerQueued(id: string): Promise<'steered' | 'requeued' | 'not-found'> {
    const taken = this.machine.steerTake(id);
    if (taken === null) return 'not-found';
    const { item, index } = taken;
    const uuid = item.conversationId;
    // 窗口判定：非 busy / 会话键缺席（旧入队形态）/ 空预览 → 放回原位
    if (!this.machine.state().busy || uuid === undefined || item.preview === '') {
      this.machine.steerRestore(item, index);
      return 'requeued';
    }
    const handle = this.steerHandle(uuid);
    const injected = this.ctx.agentLoop.steer(handle, { role: 'user', content: item.preview });
    if (!injected) {
      this.machine.steerRestore(item, index);
      return 'requeued';
    }
    await this.ctx.ledger.journalInject(uuid, this.machine.state().currentRun ?? '', item.preview, item.requestId);
    this.ctx.ledger.inboxClear(uuid, item.requestId);
    this.emitQueueChanged(uuid); // 队列缩减点（steer 出队）
    return 'steered';
  }

  /** 上下文注入落账口（cr-625：主线 session.recordContext 的壳侧形态——
   * run 活跃 journal-inject 落账〔消费点真序〕+ session/context-injected
   * 事件发射〔前端直播行〕。主线 ask-questions 行经 SessionShim 零改动
   * 消费：作答注入（已收到用户回答）/ 未响应通知两形态同口）。run 不活跃
   * 不落账（该路径调用点恒 run 活跃；跨 run 持久归 late-reply deliver）。 */
  async recordContext(
    conversationId: string,
    content: string,
    extra: { source: string; label?: string; injectionId?: string },
  ): Promise<void> {
    const run = this.machine.state().currentRun ?? '';
    if (run !== '') {
      await this.ctx.ledger.journalInject(conversationId, run, content, extra.injectionId);
    }
    this.ctx.emit('session/context-injected', conversationId, this.agentId, {
      source: extra.source,
      ...(extra.injectionId !== undefined ? { injectionId: extra.injectionId } : {}),
      ...(extra.label !== undefined ? { label: extra.label } : {}),
    });
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
   * config.tools 点名 ∩ 可见面；模式收窄单源引用主线纯函数（估算与真实
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
  private toolFaceOf(config: { tools?: string[] | { include?: string[]; exclude?: string[] } }): string[] | undefined {
    const key = JSON.stringify(config.tools ?? null);
    if (this.toolFaceCache?.key !== key) {
      const resolved = resolveToolNames(config.tools);
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
      payload: { text, run: runId },
    };
    // 断链重试（cr-628/629）：宿主重启窗口（restart_host / 崩溃复活）邮局
    // 管道断——send 抛错后弃连接重连重试（run 键行只能经邮局到达 user 壳，
    // 一次失败即丢 = 刷新后 run 蒸发）。10 次 × 2s ≈ 20s，覆盖宿主复活档
    //（supervisor 重拉退避基档 1.5s + boot 秒级）。
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureOutbound();
        await this.outbound!.send(reply);
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
    inject: ['agentLoop', 'ledger'],
    apply(ctx: Context) {
      ctx.plugin(class extends ConversationService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
