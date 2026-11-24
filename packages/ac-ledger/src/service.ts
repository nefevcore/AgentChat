// ============================================================
// service.ts —— ledger 行装配面（M8.2：账本行进 boot 装配）
//
// 纯库面（writer/reader/records）保持零 cordis；本模块 = 行的 cordis
// 服务面：writer 注册表（per-conversation 惰性）+ 步行相位接线
//（loop/after-step → step/* 事件行——cr-974 v2 单文件事件日志，账本
// 计量面归 ledger 行，manifest R2）。
// 类型增强 ctx.ledger 为 preview 专属键（主线对应键是 session，无冲突）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { LedgerWriter } from './writer.ts';
import { UNCOMMITTED_TOOL_ERROR } from './reader.ts';
import { foldDigestOf, foldLlmReplay, foldSession, foldTextReplay, rowShadowedBy } from './fold.ts';
import { REPLAY_BUILTIN_WORDS, type ReplayDecl, type ReplayKind } from './replay.ts';
import { wrapSystemReminder } from 'ac-core-utils';
import { readDomainFacts, type RunFactsV2 } from './events-v2.ts';
import { readAnchor, type CompactOptions, type CompactReport } from './archive.ts';
import { normalizeAttachments, type LedgerRow, type LedgerAttachment, type JournalInject, type RunUsage } from './records.ts';
import type { LoopStepRecord, LoopStepEnvelope, LoopRunRequestLike, LoopRunResult } from './loop-events.ts';

/** tool/after-execute 首参最小面（执行身份四键 + 子调用档案键——主线 ToolCall 子集） */
export interface ToolCallLike {
  agentId?: string;
  conversationId?: string;
  runId?: string;
  toolCallId?: string;
  name?: string;
  args?: Record<string, unknown>;
  runCodeSubcall?: boolean;
}
/**
 * 结构化行投影（recordsFor 输出——cr-1102/1103）：主线 SessionRecordFace
 * 消费形态（ac-memory 锚检测 / ac-skill 跨 run 去重同口径）。source 在
 * inject 事件上取 injectSource（现行注入词汇）；context 行保持行自有 source。
 */
export interface LedgerRecordRow {
  role: string;
  source?: string;
  agent_id?: string;
  content: string;
  injectSource?: string;
  label?: string;
  payload?: unknown;
  run?: string;
  seq?: number;
}

/** tool/after-execute 次参最小面（主线 ToolResult 子集） */
export interface ToolResultLike {
  ok: boolean;
  output?: unknown;
  error?: string;
}
import type { LlmMessage } from 'ac-llm';

/** 行配置（boot 装配参数） */
export interface LedgerRowOptions {
  dataRoot: string;
  agentId: string;
  /** agent 域目录覆盖（影子形态 = agents/<parent>/children/<child>/——账本随
   * 物化域走，D4 空间不变式：每实例只写自己域；缺省 = 顶层 agents/<agentId>/） */
  agentDirOverride?: string;
  /** 邮局地址（usage.report 服务帧投递面——cr-538/cr-1175；缺省 = 无邮局不发（CLI 直连形态）） */
  postOfficeAddress?: string;
}

export class LedgerService extends Service {
  private dataRoot: string;
  private agentId: string;
  private agentDirOverride: string | undefined;
  private postOfficeAddress: string | undefined;
  private writers = new Map<string, LedgerWriter>();
  /** run 收束计量缓存（runId → meter——settleRun 时随 journal-settled 落账
   * + 发 usage 计量帧；after-run 先于 settle 到达的时序桥）。stepCache =
   * 步级缓存序列（KV 走势步粒度——随 usage 信带出宿主，cr-714） */
  private runMeters = new Map<string, { usage: RunUsage; model: string; conversationId: string; stepCache?: Array<{ ts: number; hit: number; miss: number; prompt?: number }> }>();
  /** usage 服务帧出口（cr-1175 usage.report report 档——邮局 ipc，惰性连接） */
  private usageOutbound: { report(payload: unknown): void } | null = null;

  constructor(ctx: Context, options: LedgerRowOptions) {
    super(ctx, 'ledger');
    this.dataRoot = options.dataRoot;
    this.agentId = options.agentId;
    this.agentDirOverride = options.agentDirOverride;
    this.postOfficeAddress = options.postOfficeAddress;
    // journal 步行接线（run 周期台账）：本壳 agent 的步记录落 journal-step，
    // 工具卡全字段保留（toolCalls + toolResults——M8.7 恒等门同口径）。
    ctx.on('loop/after-step', (agent: string, step: LoopStepRecord, envelope: LoopStepEnvelope) => {
      if (agent !== this.agentId || envelope.conversationId === undefined) return;
      void this.journalStep(envelope.conversationId, envelope.runId ?? '', step);
      // 步级缓存信（cr-760 运行中实时性）：宿主 pendingTimelineMap 入账
      //（KV 走势尾段拼接），run 收束信到达后正式记账接管。与 journal 落账
      // 同判（无缓存数据的步不发）；usage-run 收束信的 stepCache 含全序——
      // 宿主 ts 判重防双计。CLI 直连（无邮局）不发。
      const su = step.usage;
      if (this.postOfficeAddress !== undefined && envelope.runId !== undefined
        && su !== undefined && (su.cacheHit != null || su.cacheMiss != null)) {
        void this.reportStepCache(envelope.conversationId, envelope.runId, step.index,
          step.ts ?? Date.now(), su.cacheHit ?? 0, su.cacheMiss ?? 0, su.prompt);
      }
    });
    // 工具结果事件（cr-596 语义，cr-974 v2 落形）：loop/after-step 在工具
    // 执行前发射（副作用前 durable），步内调用行先落；结果到达即落
    // step/tool-call-result 事件行，读侧 fold 按 toolCallId 覆盖合并——
    // 历史/刷新后工具卡不再是「永恒运行中」。run_code 子调用（runId 继承）
    // 全文内联主日志（D-1——subcalls.jsonl 分流退役）。call 身份缺席
    //（宿主直调等）不落。
    ctx.on('tool/after-execute', (call: ToolCallLike, result: ToolResultLike | undefined, error?: unknown, durationMs?: number) => {
      if (call.agentId !== this.agentId || call.conversationId === undefined
        || call.runId === undefined || call.toolCallId === undefined) return;
      const r = result !== undefined
        ? { ok: result.ok === true, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error !== undefined ? { error: result.error } : {}) }
        : { ok: false, ...(error !== undefined ? { error: String(error) } : { error: '工具执行失败' }) };
      void this.writerFor(call.conversationId, [this.agentId], 'user').appendEvents([{
        type: 'step/tool-call-result',
        run: call.runId,
        toolCallId: call.toolCallId,
        result: r,
        // 工具执行耗时（cr-766）：事件第四参——历史回放工具卡耗时数据源
        ...(durationMs !== undefined ? { durationMs } : {}),
        // 工具名恒落（cr-1143）：name 是 ToolCall 契约必填位，事件族消费方
        // （tool/result 帧按名路由——todo/goal dock 刷新触发）不区分直调/
        // 子调用，行内缺席即断链。子调用档案（cr-597）只追加 subcall 标记
        // 与名参全文。
        ...(call.name !== undefined ? { name: call.name } : {}),
        ...(call.runCodeSubcall === true ? {
          subcall: true,
          arguments: JSON.stringify(call.args ?? {}),
        } : {}),
        ts: Date.now(),
      }]);
    });
    // 注入消费点落账（cr-1251）：loop/inject-consumed（四通道统一事件——
    // steer/durable/before-run/run-idle）→ journalInject 落账 + 直播帧事件。
    // 落位 = 消息实际进入模型消息数组的位置（账本文件序 = 模型消息序，
    // cr-971 原则全通道兑现）。cr-707 事件先于落盘语义在 subscribe 序内自然
    // 成立（emit 同步扇出，落账 await 在其后）。宿主直调 run（agent 缺席）
    // 无落账面，跳过。
    ctx.on('loop/inject-consumed', (
      agent: string | undefined,
      conversationId: string | undefined,
      runId: string | undefined,
      consumed: Array<{ message: { content?: unknown; attachments?: unknown }; meta: { injectSource: string; injectionId?: string; label?: string; payload?: unknown; requestId?: string; replay?: string } }>,
    ) => {
      if (agent !== this.agentId || conversationId === undefined || runId === undefined) return;
      for (const c of consumed) {
        const content = String(c.message.content ?? '');
        const injectionId = c.meta.injectionId ?? 'inj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        // 直播帧事件（cr-625 语义归位——落账方发射）：壳侧 ws 旁带转发前端注入卡。
        this.ctx.emit('session/context-injected', conversationId, agent, {
          source: c.meta.injectSource,
          injectionId,
          ...(c.meta.label !== undefined ? { label: c.meta.label } : {}),
          bytes: content.length,
          ...(c.meta.payload !== undefined ? { payload: c.meta.payload as { questions?: Array<{ question: string; options?: string[]; multi?: boolean }>; answers?: Array<string | string[] | null>; outcome?: 'answered' | 'timeout' } } : {}),
        });
        // cr-1278：插话携带的附件随注入行落账（loop 传入的 LlmMessage 即真值源）
        const attachments = normalizeAttachments(c.message.attachments);
        void this.journalInject(conversationId, runId, content, c.meta.requestId, {
          injectionId,
          injectSource: c.meta.injectSource,
          ...(attachments !== undefined ? { attachments } : {}),
          ...(c.meta.label !== undefined ? { label: c.meta.label } : {}),
          ...(c.meta.payload !== undefined ? { payload: c.meta.payload as JournalInject['payload'] } : {}),
        }).catch(() => { /* 落账失败不阻断（直播帧已发）——fail-soft 与既有 recordContext 口径一致 */ });
      }
    });
    // usage 计量（cr-538：R2「journal 计量 + 计量帧」）：after-run 缓存
    // run 级聚合（无计量步的 run 不缓存——主线同判），settleRun 消费。
    ctx.on('loop/after-run', (request: LoopRunRequestLike, result: LoopRunResult) => {
      if (request.agent !== this.agentId || request.runId === undefined) return;
      if (result.usage.steps === 0 && result.usage.completion === 0 && result.usage.prompt === 0) return;
      // 步级缓存序列（KV 走势步粒度，cr-714）：仅含缓存字段——无计量步不
      // 入（走势点 = 「有计量的步」序列）；全 run 无步数据不写键（宿主聚
      // 并回退 run 合计单点）
      const stepCache = result.steps
        .filter((s) => s.usage && (s.usage.cacheHit != null || s.usage.cacheMiss != null))
        .map((s) => ({
          ts: s.ts ?? Date.now(),
          hit: s.usage!.cacheHit ?? 0,
          miss: s.usage!.cacheMiss ?? 0,
          // 本步真实上下文体积（cr-761 实时占用）——无计量步本就不在序列
          prompt: s.usage!.prompt,
        }));
      this.runMeters.set(request.runId, {
        usage: result.usage as RunUsage,
        model: request.model,
        conversationId: request.conversationId ?? this.agentId,
        ...(stepCache.length > 0 ? { stepCache } : {}),
      });
    });
  }

  /** 本壳 agent 域目录（影子 = 嵌套物化域；顶层 = 缺省）。
   * public——idle 探针消费（sessions/<uuid>/inbox/ 盘面扫描定位，boot.ts）。 */
  agentDirOf(): string {
    return this.agentDirOverride ?? path.join(this.dataRoot, 'agents', this.agentId);
  }

  /** writer 注册表（per-conversation 惰性；participants/kind 首建生效。
   *  cr-974 起 v2 事件日志写面（判别行 + 停物化；cr-998 起唯一形态）。 */
  private writerFor(uuid: string, participants: string[], kind: string): LedgerWriter {
    let w = this.writers.get(uuid);
    if (w === undefined) {
      w = new LedgerWriter(path.join(this.agentDirOf(), 'sessions', uuid), { participants, kind }, undefined, {
        // cr-976 B 案：落账切片 durable 后泛化通知（D3-2——step-journaled 的
        // 泛化形态；载荷 = 切片内追加行全集含 seq，批即语义单元：步相位批 /
        // 工具结果 / 注入 / 收束）。壳 boot 据此旁带转发宿主投影。
        onAppend: (rows) => {
          this.ctx.emit('ledger/event-appended', { agent: this.agentId, conversationId: uuid, rows });
        },
      });
      this.writers.set(uuid, w);
    }
    return w;
  }

  /** 落账入站行（requestId 幂等准入在 writer 内——A2 落账即确认） */
  async deliverRow(uuid: string, participants: string[], kind: string, row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>): Promise<boolean> {
    return this.writerFor(uuid, participants, kind).deliver(row);
  }

  /** 入站行在场判定（cr-639 恢复面补行门；cr-974 起走 fold 归一事实——
   *  speech/context 行与注入事件统一判键）：writer 幂等门在内存、跨进程
   *  不防重投双写，恢复面重投前以此判「行是否已落」，缺席才补写。 */
  hasInboundRow(uuid: string, requestId: string): boolean {
    const facts = readDomainFacts(path.join(this.agentDirOf(), 'sessions', uuid), this.agentId);
    if (facts.speech.some((s) => s.requestId === requestId)) return true;
    if (facts.contexts.some((c) => c.requestId === requestId)) return true;
    // cr-713：busy-steer 消息的记录 = inject 事件（消费点窗口）——同键判重
    for (const rf of facts.runs.values()) {
      if (rf.events.some((ev) => ev.kind === 'inject' && ev.requestId === requestId)) return true;
    }
    return false;
  }

  /** 步行落账（cr-974 v2：聚合步 → 相位事件族逐行入事件日志——行序即
   *  步内序；cr-946 textBeforeTools 退役（不落盘——相位序由事件序承载，
   *  读侧 fold 据首见序推导）。步末计量（usage/elapsedMs/aborted/textMs）
   *  挂步内末相位行。 */
  async journalStep(uuid: string, run: string, step: LoopStepRecord): Promise<void> {
    if (run === '') return;
    const ts = step.ts ?? Date.now();
    const base = {
      run,
      step: step.index,
      // 步身份键（cr-772 落盘透传）：与直播 delta 帧 meta.stepId 同值
      ...(step.stepId !== undefined ? { stepId: step.stepId } : {}),
    };
    const rows: Array<Record<string, unknown>> = [];
    // 思考相位恒先行（D-2 步内序：reasoning → 正文/工具调用）
    if (step.reasoning !== undefined && step.reasoning !== '') {
      rows.push({ type: 'step/reasoning', ...base, text: step.reasoning, ...(step.reasoningMs !== undefined ? { reasoningMs: step.reasoningMs } : {}), ts });
    }
    const contentRow = step.text !== '' ? { type: 'step/content', ...base, text: step.text, ts } as Record<string, unknown> : undefined;
    const callRows = step.toolCalls.map((tc) => ({ type: 'step/tool-call', ...base, toolCallId: tc.id, name: tc.name, arguments: tc.arguments, ts }));
    // cr-946 相位序：聚合记录携带 textBeforeTools（正文先于工具调用）——
    // 决定落行序，本身不落盘
    if (step.textBeforeTools === true && contentRow !== undefined) rows.push(contentRow);
    rows.push(...callRows);
    if (step.textBeforeTools !== true && contentRow !== undefined) rows.push(contentRow);
    // 早期形态（cr-596 前）：聚合步自带 toolResults 按位对应 → 结果事件行
    for (let i = 0; i < step.toolResults.length; i++) {
      const tc = step.toolCalls.at(i);
      if (tc === undefined) break;
      const tr = step.toolResults[i]!;
      rows.push({ type: 'step/tool-call-result', run, toolCallId: tc.id, result: { ok: tr.ok, ...(tr.output !== undefined ? { output: tr.output } : {}), ...(tr.error !== undefined ? { error: tr.error } : {}) }, ts });
    }
    // 步末计量挂步内末相位行（cr-766 aborted / cr-772 计时用量）
    const meter: Record<string, unknown> = {
      ...(step.usage !== undefined ? { usage: step.usage } : {}),
      ...(step.elapsedMs !== undefined ? { elapsedMs: step.elapsedMs } : {}),
      ...(step.aborted === true ? { aborted: true } : {}),
      ...(step.textMs !== undefined ? { textMs: step.textMs } : {}),
    };
    const last = rows.at(-1);
    if (last !== undefined && Object.keys(meter).length > 0) Object.assign(last, meter);
    const seq = rows.length > 0 ? await this.writerFor(uuid, [this.agentId], 'user').appendEvents(rows) : 0;
    // B2 帧携带：相位行落盘完成后补发 durable 锚事件——刻意晚于落盘（不
    // 反转 cr-707「事件先于落盘」：本事件的语义就是「seq 已 durable」），
    // seq = 步内末相位行。agent 随载荷携带（前端 routeDialog 路由键）。
    this.ctx.emit('ledger/step-journaled', {
      agent: this.agentId,
      conversationId: uuid,
      runId: run,
      step: step.index,
      seq,
      ...(step.stepId !== undefined ? { stepId: step.stepId } : {}),
    });
  }

  /** steer 注入事件（cr-974 v2 type:'inject'——按消费点真序落）。
   * extra（cr-707）：注入身份/来源/文案随行落盘——injectionId（直播行
   * 同锚）、injectSource（UI 卡片 kind）与 label（流式与刷新两路径同
   * 文案）；ts 由调用方给同一时刻。 */
  async journalInject(
    uuid: string,
    run: string,
    content: string,
    requestId?: string,
    extra?: { injectionId?: string; injectSource?: string; label?: string; payload?: JournalInject['payload']; attachments?: LedgerAttachment[]; ts?: number },
  ): Promise<void> {
    if (run === '') return;
    await this.writerFor(uuid, [this.agentId], 'user').appendEvents([{
      type: 'inject',
      run,
      content,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(extra?.attachments !== undefined ? { attachments: extra.attachments } : {}),
      ...(extra?.injectionId !== undefined ? { injectionId: extra.injectionId } : {}),
      ...(extra?.injectSource !== undefined ? { injectSource: extra.injectSource } : {}),
      ...(extra?.label !== undefined ? { label: extra.label } : {}),
      ...(extra?.payload !== undefined ? { payload: extra.payload } : {}),
      ts: extra?.ts ?? Date.now(),
    }]);
  }

  /** run 收束（cr-974 v2：终稿 message 行 +（error 时 context/error 行）+
   * run-end 标记行——物化/journal 两阶段退役）+ 计量落账与 usage 计量帧
   *（cr-538——meter 取 after-run 缓存，消费即清）。cr-807：error 收束补落
   * 错误行——错误文案只在瞬态帧（run-settled.message → 前端红条），刷新/
   * 错过帧即蒸发，落盘行补齐两路径。 */
  async settleRun(uuid: string, participants: string[], kind: string, row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>, runId: string, finish: 'ok' | 'interrupted' | 'error', errorMessage?: string, origin?: string): Promise<void> {
    const meter = this.runMeters.get(runId);
    this.runMeters.delete(runId);
    await this.writerFor(uuid, participants, kind).settle(row, runId, finish, meter, errorMessage, origin);
    if (meter !== undefined && this.postOfficeAddress !== undefined) {
      void this.reportUsage(runId, meter, finish);
    }
  }

  /** usage 服务帧出口（cr-842 断链自愈 + cr-1175 迁 usage.report report 档）：
   *  宿主重启后旧 named pipe 死连接写入即失败——弃缓存重连一次再发。
   *  report 档不等回执（fire-and-forget）；对账面兜底幂等（journal 事实源）。 */
  private async usageReportSend(payload: Record<string, unknown>): Promise<void> {
    if (this.usageOutbound === null) {
      const { IpcClient } = await import('ac-envelope-core');
      const client = new IpcClient();
      await client.connect(this.postOfficeAddress!);
      this.usageOutbound = { report: (p) => client.serviceReport('usage.report', p) };
    }
    try {
      this.usageOutbound.report(payload);
    } catch {
      // 死连接（宿主重启后 pipe 断）：弃缓存重连一次再发
      this.usageOutbound = null;
      const { IpcClient } = await import('ac-envelope-core');
      const client = new IpcClient();
      await client.connect(this.postOfficeAddress!);
      this.usageOutbound = { report: (p) => client.serviceReport('usage.report', p) };
      this.usageOutbound.report(payload);
    }
  }

  /** 步级缓存信发射（cr-760：after-step 即发——失败不重试，收束信兜底） */
  private async reportStepCache(
    conversationId: string, runId: string, step: number, ts: number, hit: number, miss: number, prompt: number | undefined,
  ): Promise<void> {
    try {
      await this.usageReportSend({ subject: 'usage-step', agent: this.agentId, conversationId, runId, step, ts, hit, miss, ...(prompt !== undefined ? { prompt } : {}) });
    } catch {
      // 收束信 stepCache 兜底（全序）——步级信丢失只损失实时性，不损失数据。
    }
  }

  /** usage 计量帧发射（cr-1175 起 report 档——尽力面，不阻塞收束：断链重连
   *  只在首份未送达时发生〔socket null 同步 throw〕，无 at-least-once 重发；
   *  丢失兜底 = 宿主 boot 对账回填（journal 事实源 → reportMeter 补录）） */
  private async reportUsage(runId: string, meter: { usage: RunUsage; model: string; conversationId: string; stepCache?: Array<{ ts: number; hit: number; miss: number; prompt?: number }> }, finish: string): Promise<void> {
    try {
      await this.usageReportSend({
        subject: 'usage-run', agent: this.agentId, model: meter.model, finish,
        usage: meter.usage, conversationId: meter.conversationId, runId,
        ...(meter.stepCache !== undefined ? { stepCache: meter.stepCache } : {}),
      });
    } catch {
      // 计量已在 journal（usage 字段随 settlement 落盘）——计量帧失败可容忍，
      // 宿主对账可扫账本补差（对账面归 usage 行）。不重试不阻塞。
    }
  }

  /** 会话历史回放（run 前重读——viewer 投影：自己 = assistant；概要存在
   * 时以 system 行置首——归档滚动概要注入，主线 history() 同语义）。
   * viewer 缺省 = 本壳 agent；跨壳委托读面（SessionShim.history）按
   * 对端视角投影（cr-712——委托对历史播种） */
  historyFor(uuid: string, viewer: string = this.agentId): Array<{ role: 'assistant' | 'user' | 'system'; content: string }> {
    const dir = path.join(this.agentDirOf(), 'sessions', uuid);
    // cr-974 摘要源 + cr-1189 V3 单源序：archive-summary 行 → v2 事件
    // 摘要（§2.3 三态）→ summary.md 兼容窗（v1）；文本投影走 fold 单源
    // （含 shadowed 过滤）
    const fold = foldSession(this.dataRoot, uuid, [dir]);
    // cr-1274 摘要单源：archive-summary 行（V3）唯一级——foldTextReplay 只投
    // speech 行不含 context，摘要行经 foldDigestOf 显式置首。
    const summary = foldDigestOf(fold) ?? '';
    const view = foldTextReplay(fold, viewer);
    return summary !== '' ? [{ role: 'system', content: summary }, ...view] : view;
  }

  /** 会话历史轨迹回放（cr-658 轨迹完整性 + cr-697 物化源切换）：
   * historyFor 文本投影之上，凡带 run 键的收束行前置该 run 的轨迹
   * （assistant/tool 协议对）——run 上下文对自己做过的工具工作不再失明
   * （正常终稿 run 同样带出，不只中断 run）。轨迹源 = 物化段行/注入行
   * （settlement 切段物化产物）优先；journal 兜底存量会话与 in-flight
   * run（收束即清后 journal 只剩 settled 行）。cr-640 时代的存量文本段行
   * （message_id 前缀 seg-、无 source 标记）过滤防双计；归档 compact
   * 重写后 run 键行随 keep 面消失 = 轨迹注入自然有界。 */
  // —— 回放声明注册表（cr-1104 注册制——registerToolMode 范式） ——

  private replayDecls = new Map<string, ReplayKind>();

  /**
   * 注册回放声明（cr-1104）：注入源词 → 回放档。fiber 归属——随注册行
   * 卸载自动回收（声明退场 → 该词回落默认 wrapper）。机制词封闭不可
   * 注册；撞名 fail-loud（同 toolMode 口径）。
   * @returns effect disposer
   */
  registerReplayPolicy(decl: ReplayDecl) {
    if (typeof decl.source !== 'string' || decl.source === '') {
      throw new Error('回放声明词非法（非空字符串）');
    }
    if (REPLAY_BUILTIN_WORDS.has(decl.source)) {
      throw new Error('机制词不可注册（封闭词表）: ' + decl.source);
    }
    if (!['original', 'wrapper', 'none'].includes(decl.replay)) {
      throw new Error('回放档非法（original|wrapper|none）: ' + JSON.stringify(decl.replay));
    }
    if (this.replayDecls.has(decl.source)) {
      throw new Error(`回放声明已注册: ${decl.source}`);
    }
    return this.ctx.fiber.effect(() => {
      this.replayDecls.set(decl.source, decl.replay);
      return () => {
        this.replayDecls.delete(decl.source);
      };
    }, `ledger.registerReplayPolicy(${decl.source})`);
  }

  /** 已注册声明清单（词表 watchdog / UI 展示用） */
  listReplayPolicies(): ReplayDecl[] {
    return [...this.replayDecls.entries()].map(([source, replay]) => ({ source, replay }));
  }

  /** 词 → 回放档（注册声明优先；缺省 wrapper——非 speech 事实行默认） */
  replayKindOf(word: string | undefined): ReplayKind {
    return (word !== undefined ? this.replayDecls.get(word) : undefined) ?? 'wrapper';
  }

  historyMessagesFor(uuid: string, opts: { excludeRun?: string } = {}): LlmMessage[] {
    const dir = path.join(this.agentDirOf(), 'sessions', uuid);
    // cr-974：LLM 回放走 fold 单源——压缩在场时摘要头与 shadowed 过滤
    // 均由 fold 承载（system 头在 foldLlmReplay 内置；摘要单源 = V3
    // archive-summary 行——cr-1274，v1 概要窗已随存量物化退役）。
    // parity 由 fold.test.ts 锁定。cr-1101：excludeRun——活动 run 轨迹
    // 排除（driveRun 轮间重派生防双喂）。
    const fold = foldSession(this.dataRoot, uuid, [dir]);
    return foldLlmReplay(fold, this.agentId, this.dataRoot, uuid, undefined, {
      excludeRun: opts.excludeRun,
      // cr-1104 注册制：声明词按 owning 插件的注册档回放（缺省 wrapper）
      replayOf: (word) => this.replayDecls.get(word),
    });
  }

  /**
   * 续跑状态读面（cr-667，A1；cr-974 起走 fold 归一事实——v1 journal 与
   * v2 相位行同构）：run 有步/注入事实且无 run-end → 重建消息前缀 +
   * 已提交步数（续跑准入与额度基数）；重建抛错 → 'degraded'（调用方退回
   * 重投 + 标注）；无步或已收束 → null（走常规链）。
   * 未提交调用合成 UNCOMMITTED_TOOL_ERROR（结果未知——唯一诚实状态）；
   * 中止步（aborted）整调用剔除、不计 committedSteps（cr-766）。
   */
  resumeStateFor(uuid: string, runId: string): { messages: import('ac-llm').LlmMessage[]; committedSteps: number } | 'degraded' | null {
    let rf: RunFactsV2 | undefined;
    try {
      rf = readDomainFacts(path.join(this.agentDirOf(), 'sessions', uuid), this.agentId).runs.get(runId);
    } catch {
      return null; // 域目录级不可读（缺席等）——常规链
    }
    if (rf === undefined) return null;
    const hasSteps = rf.events.some((ev) => ev.kind !== 'tool-call-result');
    if (!hasSteps) return null;
    if (rf.end !== undefined) return null; // 已收束（run-end）
    try {
      return resumeFromFacts(rf, (w) => this.replayDecls.get(w));
    } catch {
      return 'degraded'; // 轨迹重建失败（版本不兼容等）——降级重投
    }
  }

  // 孤儿 run 收口 recoverOrphanRuns（cr-628）已随 cr-974 退役：D-3 读方
  // 配平——未闭合 run 不回写，fold 投影层合成 run-end(interrupted)；
  // inbox 在途信恢复面（recoverPendingInbox）不受影响（defer 仲裁随收口
  // 面一同退役——续跑准入本身以 resumeStateFor 的「无 run-end」判定）。

  /**
   * inbox 在途 requestId 集（诊断/测试面保留；cr-974 前为恢复面 defer 仲裁）。
   */
  pendingInboxRequestIds(): Set<string> {
    const sessionsRoot = path.join(this.agentDirOf(), 'sessions');
    const out = new Set<string>();
    let uuids: string[] = [];
    try { uuids = fs.readdirSync(sessionsRoot); } catch { return out; }
    for (const uuid of uuids) {
      const inboxDir = path.join(sessionsRoot, uuid, 'inbox');
      let ids: string[] = [];
      try { ids = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.json')); } catch { continue; }
      for (const n of ids) {
        try {
          const env = JSON.parse(fs.readFileSync(path.join(inboxDir, n), 'utf-8')) as { requestId?: unknown };
          if (typeof env.requestId === 'string' && env.requestId !== '') out.add(env.requestId);
        } catch { /* 坏封跳过 */ }
      }
    }
    return out;
  }

  /**
   * 结构化行读面（cr-1102/1103：SessionShim.records 转发目标——主线
   * SessionService.records 的壳侧等价）。context 行（v1 role 判别 + v2
   * type:'context'，存量）与 inject 事件（v2 现行——run 活跃期注入经
   * recordContext → journalInject 落账）统一投影为「role:context 行」，
   * seq 升序：source = 行自有 source（context）/ injectSource（inject
   * 事件——注入行的来源词汇在 injectSource 键上）。纯读侧——不触写面
   * 与 fold。域目录不可读 = 空清单（fail-open，消费方去重/锚检测降级）。
   */
  recordsFor(uuid: string): Array<LedgerRecordRow> {
    let facts: ReturnType<typeof readDomainFacts>;
    try {
      facts = readDomainFacts(path.join(this.agentDirOf(), 'sessions', uuid), this.agentId);
    } catch {
      return [];
    }
    // cr-1191 压缩边界过滤：被任一代 shadow 的行不在回放（LLM 不可见），
    // 「在场判定」类消费（ac-skill 跨 run 去重 / ac-memory 锚检测）必须按
    // 回放口径——物理在场≠回放在场。V3 压缩后旧技能注入行物理在账本但
    // 已 shadow，不去重过滤会让 load_skill 回执 injected 而正文永不重注
    //（本会话活体复现：seq=176 技能行 vs boundary 1084）。谓词单源
    // rowShadowedBy（时刻放行 → seq 位置维 → 时刻维）；v1 无 seq 无数字
    // ts 行保守放行（无位置信息——与 estimateOf 口径一致）。
    const boundaries = facts.compactions;
    const shadowedOf = (seq: number | undefined, ts: number | undefined): boolean => {
      if (boundaries.length === 0 || (seq === undefined && ts === undefined)) return false;
      return boundaries.some((b) => rowShadowedBy(
        { ...(seq !== undefined ? { seq } : {}), ...(ts !== undefined ? { ts } : {}) }, b,
      ));
    };
    const tsOf = (iso: unknown): number | undefined => {
      if (typeof iso !== 'string' || iso === '') return undefined;
      const parsed = Date.parse(iso);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const out: Array<LedgerRecordRow & { seq?: number }> = [];
    for (const c of facts.contexts) {
      if (shadowedOf(c.seq, tsOf(c.timestamp))) continue;
      out.push({
        role: 'context', source: c.source, agent_id: c.agentId, content: c.content,
        ...(c.injectSource !== undefined ? { injectSource: c.injectSource } : {}),
        ...(c.label !== undefined ? { label: c.label } : {}),
        ...(c.payload !== undefined ? { payload: c.payload } : {}),
        ...(c.run !== undefined ? { run: c.run } : {}),
        ...(c.seq !== undefined ? { seq: c.seq } : {}),
      });
    }
    for (const rf of facts.runs.values()) {
      for (const ev of rf.events) {
        if (ev.kind !== 'inject') continue;
        if (shadowedOf(ev.seq, ev.ts)) continue;
        out.push({
          role: 'context', source: ev.injectSource ?? 'inject', agent_id: this.agentId, content: ev.content,
          ...(ev.injectSource !== undefined ? { injectSource: ev.injectSource } : {}),
          ...(ev.label !== undefined ? { label: ev.label } : {}),
          ...(ev.payload !== undefined ? { payload: ev.payload } : {}),
          run: ev.run,
          ...(ev.seq !== undefined ? { seq: ev.seq } : {}),
        });
      }
    }
    // cr-1155 排序口径修正：无 seq 的 v1 存量行归位最旧（文件序天然在前），
    // 不再按 MAX_SAFE_INTEGER 排到尾部冒充「最新」——ac-memory 锚扫描曾因此
    // 永命中 10 月 v1 旧行（S 冻结 → 无限重注）；消费方「取最近」类序依赖
    // 以 v2 seq 为准，v1 行只作存量材料在场。
    out.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
    return out;
  }

  /** 尾锚直读（archive 行消费——二次归档去重锚） */
  archiveAnchorOf(uuid: string) {
    return readAnchor(path.join(this.agentDirOf(), 'sessions', uuid));
  }

  /** 归档重写（archive 行编排调用——物理面归 writer.compact；per-uuid
   * writer 注册表路由；compress = 归档段整段单流 gzip——S5 白名单时机） */
  async compactFor(uuid: string, opts: CompactOptions & { compress?: boolean }): Promise<CompactReport> {
    return this.writerFor(uuid, [this.agentId], 'user').compact(opts);
  }

  /** 压缩事件落账（cr-1160 P1 单事件——archive 行编排消费：语义边界先
   * durable，物理回收随后（或解耦延后）经 compactFor。opts.summary 可空
   * ——P3 概要协议不合格时本代无新概要；stats/model 审计面随行。） */
  async compactionFor(uuid: string, runId: string, opts: { summary?: string; shadowedSeq?: number; stats?: { shadowedRows?: number; estimatedTokens?: number }; model?: string } = {}): Promise<number> {
    return this.writerFor(uuid, [this.agentId], 'user').compaction(runId, opts);
  }

  /** 机制 run 收束（cr-1189 V3 退役标记：整理轮改普通 run 语义后无生产
   *  消费方——保留薄壳供恢复面收口等残余形态，不再新增调用） */
  async settleMechanismFor(uuid: string, runId: string, finish: 'ok' | 'interrupted' | 'error'): Promise<void> {
    await this.writerFor(uuid, [this.agentId], 'user').settleMechanism(runId, finish);
  }

  // —— inbox durable（A4：投递未消费消息；队列事实源——收束后链跑消费） ——

  inboxStore(uuid: string, envelope: { requestId: string; payload: unknown }): void {
    this.writerFor(uuid, [this.agentId], 'user').inboxStore(envelope);
  }

  inboxList(uuid: string): Array<{ requestId: string; envelope: unknown }> {
    return this.writerFor(uuid, [this.agentId], 'user').inboxList()
      .map(({ requestId }) => ({ requestId, envelope: this.inboxRead(uuid, requestId) }));
  }

  inboxRead(uuid: string, requestId: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(this.agentDirOf(), 'sessions', uuid, 'inbox', requestId + '.json'),
        'utf-8',
      ));
    } catch {
      return null;
    }
  }

  inboxClear(uuid: string, requestId: string): void {
    this.writerFor(uuid, [this.agentId], 'user').inboxClear(requestId);
  }
}

/**
 * 续跑前缀重建（cr-667 resumeContextOfRun 的 fold 形态——v1 journal 与
 * v2 相位行经归一化同构）：事件行序遍历——注入入序；步按首见序分组；
 * 未提交调用合成 UNCOMMITTED_TOOL_ERROR（结果未知）；中止步整调用剔除
 * （aborted 是明确未执行）、不计 committedSteps。无有效消息 → null。
 */
function resumeFromFacts(rf: RunFactsV2, replayOf?: (word: string) => 'original' | 'wrapper' | 'none' | undefined): { messages: LlmMessage[]; committedSteps: number } | null {
  const results = new Map<string, { ok: boolean; output?: unknown; error?: string }>();
  for (const ev of rf.events) {
    if (ev.kind === 'tool-call-result' && ev.subcall !== true) results.set(ev.toolCallId, ev.result);
  }
  interface StepAcc { content: string[]; calls: Array<{ id: string; name: string; arguments: string }> }
  const order: number[] = [];
  const acc = new Map<number, StepAcc>();
  for (const ev of rf.events) {
    if (ev.kind === 'tool-call-result') continue;
    if (ev.kind === 'inject') continue;
    if (!acc.has(ev.step)) { acc.set(ev.step, { content: [], calls: [] }); order.push(ev.step); }
    const s = acc.get(ev.step)!;
    if (ev.kind === 'reasoning') continue; // 思考相位不进续跑协议面（v1 同判）
    if (ev.kind === 'content') s.content.push(ev.text);
    else s.calls.push({ id: ev.toolCallId, name: ev.name, arguments: ev.arguments });
  }
  const out: LlmMessage[] = [];
  let committedSteps = 0;
  // 注入点 = 事件行序（步首见序与注入交错还原——v1 seq 序同构）
  const seenSteps = new Set<number>();
  for (const ev of rf.events) {
    if (ev.kind === 'inject') {
      // cr-1101 live 对齐续记:续跑前缀的 inject 与 settle 后回放同字节(包裹 +
      // cr-1104 声明分档;烘焙 passthrough)——否则 resume 所见 ≠ 事后回放所见
      const kind = (ev.injectSource !== undefined ? replayOf?.(ev.injectSource) : undefined) ?? 'wrapper';
      if (kind === 'none') continue;
      out.push({ role: 'user', content: kind === 'wrapper' ? wrapSystemReminder(ev.content) : ev.content });
      continue;
    }
    if (ev.kind !== 'reasoning' && ev.kind !== 'content' && ev.kind !== 'tool-call') continue;
    if (seenSteps.has(ev.step)) continue;
    seenSteps.add(ev.step);
    const s = acc.get(ev.step)!;
    const content = s.content.join('');
    const meter = rf.meters.get(ev.step);
    // 中止/错误步（cr-766 / cr-1042）：调用从未执行且参数可能截断——整
    // 调用剔除（不合成 UNCOMMITTED——那是「结果未知」的语义；aborted 是
    // 明确未执行）。部分正文如实保留（携带面），不计入 committedSteps。
    if (meter?.aborted === true) {
      if (content.trim() !== '') out.push({ role: 'assistant', content });
      continue;
    }
    if (content.trim() === '' && s.calls.length === 0) continue;
    if (s.calls.length > 0 && s.calls.every((tc) => results.has(tc.id))) committedSteps += 1;
    out.push({
      role: 'assistant',
      content,
      ...(s.calls.length > 0 ? { tool_calls: s.calls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })) } : {}),
    });
    for (const tc of s.calls) {
      out.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(results.get(tc.id) ?? { ok: false, error: UNCOMMITTED_TOOL_ERROR }) });
    }
  }
  return out.length === 0 ? null : { messages: out, committedSteps };
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 账本服务（preview 壳 ledger 行提供——writer 面 + journal 计量） */
    ledger: LedgerService;
  }
  interface Events {
    /**
     * user 会话有新行落账（纯通知，cr-870/973：宿主观测点 = user 桩投递后 /
     * agent 终稿通知信到达——cr-973 起 viewer 物化退役，通知不再伴随宿主
     * 写入，语义改为「该会话 agent 域有新事实，缓存摘要宜失效」；装载对账
     * 仍是兜底）。消费方：singles 行清单注册表条目标 stale。
     *
     * @mode emit
     * @scope host（user 会话观测点只在宿主进程）
     * @param conversationId 会话 id
     */
    'ledger/viewer-appended'(conversationId: string): void;
    /**
     * journal 步行落盘完成（B2 帧携带）：seq 已 durable 的步级身份锚补发
     * 面——刻意晚于落盘（cr-707「事件先于落盘」不反转：本事件语义即
     * 「该 seq 已可引用」）。ws-bridge 直转前端（步级 seq 水位 + 直播行
     * seq 锚）。
     *
     * @mode emit
     * @param payload 会话/run/步身份 + 落盘行分配的 seq
     */
    'ledger/step-journaled'(payload: { agent: string; conversationId: string; runId: string; step: number; seq: number; stepId?: string }): void;
    /**
     * 事件日志追加 durable（cr-976 B 案，step-journaled 的泛化）：单个串行
     * 队列切片内追加到 messages.jsonl 的行全集（含分配好的 seq）。语义 =
     * 「这些 seq 已可引用」——刻意晚于落盘（fsync 后回调）。宿主直播管线
     * 据此投影转发（帧 = 事件的视图，收敛信号 = type:'run-end' 行——E-2
     * 根治形态）。
     *
     * @mode emit
     * @param payload 会话身份 + 追加行全集（判别字段 type 在行上）
     */
    'ledger/event-appended'(payload: { agent: string; conversationId: string; rows: Array<Record<string, unknown>> }): void;
  }
}

/** ledger 行工厂（boot rowAssemblers 装配——数据根/agentId 显式注入） */
export function makeLedgerRow(options: LedgerRowOptions): Plugin {
  return {
    name: 'shell-ledger-row',
    inject: [],
    apply(ctx: Context) {
      ctx.plugin(class extends LedgerService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
