// ============================================================
// service.ts —— ledger 行装配面（M8.2：账本行进 boot 装配）
//
// 纯库面（writer/reader/records）保持零 cordis；本模块 = 行的 cordis
// 服务面：writer 注册表（per-conversation 惰性）+ journal 步行接线
//（loop/after-step → journal-step——账本计量面归 ledger 行，manifest R2）。
// 类型增强 ctx.ledger 为 preview 专属键（主线对应键是 session，无冲突）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { LedgerWriter } from './writer.ts';
import { readLedger, replayView, summaryTextOf } from './reader.ts';
import { readAnchor, type CompactOptions, type CompactReport } from './archive.ts';
import type { LedgerRow, JournalStep, RunUsage } from './records.ts';
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
/** tool/after-execute 次参最小面（主线 ToolResult 子集） */
export interface ToolResultLike {
  ok: boolean;
  output?: unknown;
  error?: string;
}
import type { Envelope } from 'ac-envelope-core';
import { makeUsageEnvelope } from './usage.ts';

/** 行配置（boot 装配参数） */
export interface LedgerRowOptions {
  dataRoot: string;
  agentId: string;
  /** agent 域目录覆盖（影子形态 = agents/<parent>/children/<child>/——账本随
   * 物化域走，D4 空间不变式：每实例只写自己域；缺省 = 顶层 agents/<agentId>/） */
  agentDirOverride?: string;
  /** 邮局地址（usage 事件信投递面——cr-538；缺省 = 无邮局不发（CLI 直连形态）） */
  postOfficeAddress?: string;
}

export class LedgerService extends Service {
  private dataRoot: string;
  private agentId: string;
  private agentDirOverride: string | undefined;
  private postOfficeAddress: string | undefined;
  private writers = new Map<string, LedgerWriter>();
  /** run 收束计量缓存（runId → meter——settleRun 时随 journal-settled 落账
   * + 发 usage 事件信；after-run 先于 settle 到达的时序桥） */
  private runMeters = new Map<string, { usage: RunUsage; model: string; conversationId: string }>();
  /** usage 事件信出口（邮局 ipc——postReply 同款通道；惰性连接） */
  private usageOutbound: { send(env: Envelope): Promise<unknown> } | null = null;

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
    });
    // 工具结果补行（cr-596，主线 ac-session 同义）：loop/after-step 在工具
    // 执行前发射（副作用前 durable），步行 toolResults 恒空；结果到达即落
    // journal-tool-result 补行，读侧 stepsOfRun 按 toolCallId 覆盖合并——
    // 历史/刷新后工具卡不再是「永恒运行中」。run_code 子调用（runId 继承）
    // 同路带出。call 身份缺席（宿主直调等）不落。
    ctx.on('tool/after-execute', (call: ToolCallLike, result: ToolResultLike | undefined, error?: unknown) => {
      if (call.agentId !== this.agentId || call.conversationId === undefined
        || call.runId === undefined || call.toolCallId === undefined) return;
      const r = result !== undefined
        ? { ok: result.ok === true, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error !== undefined ? { error: result.error } : {}) }
        : { ok: false, ...(error !== undefined ? { error: String(error) } : { error: '工具执行失败' }) };
      void this.writerFor(call.conversationId, [this.agentId], 'user').journal({
        type: 'journal-tool-result',
        run: call.runId,
        toolCallId: call.toolCallId,
        result: r,
        // 子调用档案（cr-597）：run_code 程序内桥接的子调用携带名/参——
        // 宿主步行只有宿主 run_code 调用对，子调用卡片的名/参唯一来源
        //（主线 subcalls.jsonl 同义，preview 随补行落）
        ...(call.runCodeSubcall === true ? {
          subcall: true,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        } : {}),
      });
    });
    // usage 计量（cr-538：R2「journal 计量 + 事件信」）：after-run 缓存
    // run 级聚合（无计量步的 run 不缓存——主线同判），settleRun 消费。
    ctx.on('loop/after-run', (request: LoopRunRequestLike, result: LoopRunResult) => {
      if (request.agent !== this.agentId || request.runId === undefined) return;
      if (result.usage.steps === 0 && result.usage.completion === 0 && result.usage.prompt === 0) return;
      this.runMeters.set(request.runId, {
        usage: result.usage as RunUsage,
        model: request.model,
        conversationId: request.conversationId ?? this.agentId,
      });
    });
  }

  /** 本壳 agent 域目录（影子 = 嵌套物化域；顶层 = 缺省）。
   * public——idle 探针消费（sessions/<uuid>/inbox/ 盘面扫描定位，boot.ts）。 */
  agentDirOf(): string {
    return this.agentDirOverride ?? path.join(this.dataRoot, 'agents', this.agentId);
  }

  /** writer 注册表（per-conversation 惰性；participants/kind 首建生效） */
  private writerFor(uuid: string, participants: string[], kind: string): LedgerWriter {
    let w = this.writers.get(uuid);
    if (w === undefined) {
      w = new LedgerWriter(path.join(this.agentDirOf(), 'sessions', uuid), { participants, kind });
      this.writers.set(uuid, w);
    }
    return w;
  }

  /** 落账入站行（requestId 幂等准入在 writer 内——A2 落账即确认） */
  async deliverRow(uuid: string, participants: string[], kind: string, row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>): Promise<boolean> {
    return this.writerFor(uuid, participants, kind).deliver(row);
  }

  /** 步行落 journal（run 周期台账） */
  async journalStep(uuid: string, run: string, step: LoopStepRecord): Promise<void> {
    if (run === '') return;
    const line: JournalStep = {
      type: 'journal-step',
      run,
      step: step.index,
      content: step.text,
      ...(step.reasoning !== undefined && step.reasoning !== '' ? { reasoning: step.reasoning } : {}),
      ...(step.toolCalls.length > 0 ? {
        toolCalls: step.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      } : {}),
      ...(step.toolResults.length > 0 ? {
        toolResults: step.toolResults.map((r) => ({
          ok: r.ok,
          ...(r.output !== undefined ? { output: r.output } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
        })),
      } : {}),
    };
    await this.writerFor(uuid, [this.agentId], 'user').journal(line);
  }

  /** steer 注入行（journal-inject——按消费点真序落） */
  async journalInject(uuid: string, run: string, content: string, requestId?: string): Promise<void> {
    if (run === '') return;
    await this.writerFor(uuid, [this.agentId], 'user').journal({ type: 'journal-inject', run, content, ...(requestId !== undefined ? { requestId } : {}) });
  }

  /** run 收束：终稿行 + journal-settled（settlement 两阶段）+ 计量落账与
   * usage 事件信（cr-538——meter 取 after-run 缓存，消费即清）。 */
  async settleRun(uuid: string, participants: string[], kind: string, row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>, runId: string, finish: 'ok' | 'interrupted' | 'error'): Promise<void> {
    const meter = this.runMeters.get(runId);
    this.runMeters.delete(runId);
    await this.writerFor(uuid, participants, kind).settle(row, runId, finish, meter);
    if (meter !== undefined && this.postOfficeAddress !== undefined) {
      void this.reportUsage(runId, meter, finish);
    }
  }

  /** usage 事件信发射（at-least-once——失败不阻塞收束；宿主 requestId 幂等） */
  private async reportUsage(runId: string, meter: { usage: RunUsage; model: string; conversationId: string }, finish: string): Promise<void> {
    try {
      if (this.usageOutbound === null) {
        const { IpcClient } = await import('ac-post-office');
        const client = new IpcClient();
        await client.connect(this.postOfficeAddress!);
        this.usageOutbound = { send: (e) => client.send(e) };
      }
      await this.usageOutbound.send(makeUsageEnvelope({
        requestId: 'usage-' + runId,
        payload: {
          subject: 'usage-run', agent: this.agentId, model: meter.model, finish,
          usage: meter.usage, conversationId: meter.conversationId, runId,
        },
      }));
    } catch {
      // 计量已在 journal（usage 字段随 settlement 落盘）——事件信失败可容忍，
      // 宿主对账可扫账本补差（对账面归 usage 行）。不重试不阻塞。
    }
  }

  /** 会话历史回放（run 前重读——viewer 投影：自己 = assistant；概要存在
   * 时以 system 行置首——归档滚动概要注入，主线 history() 同语义） */
  historyFor(uuid: string): Array<{ role: 'assistant' | 'user' | 'system'; content: string }> {
    const dir = path.join(this.agentDirOf(), 'sessions', uuid);
    const summary = summaryTextOf(dir);
    const view = replayView(readLedger(dir).rows, this.agentId);
    return summary !== '' ? [{ role: 'system', content: summary }, ...view] : view;
  }

  /** 会话概要直读（archive 行消费——mtime 判新鲜归 overview 收尾） */
  summaryOf(uuid: string): string {
    return summaryTextOf(path.join(this.agentDirOf(), 'sessions', uuid));
  }

  /** 尾锚直读（archive 行消费——二次归档去重锚） */
  archiveAnchorOf(uuid: string) {
    return readAnchor(path.join(this.agentDirOf(), 'sessions', uuid));
  }

  /** 归档重写（archive 行编排调用——物理面归 writer.compact；per-uuid
   * writer 注册表路由） */
  async compactFor(uuid: string, opts: CompactOptions): Promise<CompactReport> {
    return this.writerFor(uuid, [this.agentId], 'user').compact(opts);
  }

  /** 机制 run 收束（archive 行消费——journal-settled 落账、账本不落行） */
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

declare module '@agentchat/cordis' {
  interface Context {
    /** 账本服务（preview 壳 ledger 行提供——writer 面 + journal 计量） */
    ledger: LedgerService;
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
