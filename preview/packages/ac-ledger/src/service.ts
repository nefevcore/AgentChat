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
import { readLedger, readJournal, anchorableRuns, replayView, summaryTextOf, trajectoryOfRun, resumeContextOfRun } from './reader.ts';
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
import type { LlmMessage } from 'ac-llm';
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

  /** 入站行在场判定（盘面直读——cr-639 恢复面补行门）：writer 幂等门在内存、
   *  跨进程不防重投双写，恢复面重投前以此判「行是否已落」，缺席才补写。 */
  hasInboundRow(uuid: string, requestId: string): boolean {
    return readLedger(path.join(this.agentDirOf(), 'sessions', uuid)).rows.some((r) => r.requestId === requestId);
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

  /** 会话历史轨迹回放（cr-658 轨迹完整性）：historyFor 文本投影之上，
   * 凡带 run 键的收束行前置该 run 的 journal 轨迹（assistant/tool 协议对）
   * ——run 上下文对自己做过的工具工作不再失明（正常终稿 run 同样带出，
   * 不只中断 run）。读侧重建取代 cr-640/653 写侧段行物化（已退役）；
   * 存量段行（message_id 前缀 seg-）过滤防双计。归档 compact 重写后
   * run 键行随 keep 面消失 = 轨迹注入自然有界。 */
  historyMessagesFor(uuid: string): LlmMessage[] {
    const dir = path.join(this.agentDirOf(), 'sessions', uuid);
    const summary = summaryTextOf(dir);
    const rows = readLedger(dir).rows;
    const journal = readJournal(dir);
    const out: LlmMessage[] = summary !== '' ? [{ role: 'system', content: summary }] : [];
    const traced = new Set<string>();
    for (const row of rows) {
      if (row.role !== 'agent' || row.message_id.startsWith('seg-')) continue;
      if (typeof row.run === 'string' && row.run !== '' && !traced.has(row.run)) {
        traced.add(row.run);
        const traj = trajectoryOfRun(journal, row.run);
        // 末步去重：自然收束 run 的末步 content 即终稿（loop 自然停点），
        // settle 行同文再入 = 终稿双份。轨迹末条 assistant 与终稿行同文时
        // 让位给终稿行（权威投影），其余步全保留。
        const last = traj.at(-1);
        if (row.content.trim() !== '' && last !== undefined && last.role === 'assistant'
          && !Array.isArray(last.tool_calls) && last.content === row.content) {
          traj.pop();
        }
        out.push(...traj);
      }
      if (row.content.trim() !== '') {
        out.push({ role: row.agent_id === this.agentId ? 'assistant' : 'user', content: row.content });
      }
    }
    return out;
  }

  /** 会话概要直读（archive 行消费——mtime 判新鲜归 overview 收尾） */
  summaryOf(uuid: string): string {
    return summaryTextOf(path.join(this.agentDirOf(), 'sessions', uuid));
  }
  /**
   * 续跑状态读面（cr-667，A1）：run 有步行/注入且无 settled → 重建消息前缀
   * + 已提交步数（续跑准入与额度基数）；journal 损坏/重建抛错 → 'degraded'
   *（调用方退回重投 + 标注）；无步行或已 settled → null（走常规链）。
   */
  resumeStateFor(uuid: string, runId: string): { messages: import('ac-llm').LlmMessage[]; committedSteps: number } | 'degraded' | null {
    let lines;
    try {
      lines = readJournal(path.join(this.agentDirOf(), 'sessions', uuid));
    } catch {
      return null; // journal 目录级不可读（缺席等）——常规链
    }
    const hasSteps = lines.some((l) => l.run === runId && (l.type === 'journal-step' || l.type === 'journal-inject'));
    if (!hasSteps) return null;
    if (lines.some((l) => l.run === runId && l.type === 'journal-settled')) return null;
    try {
      return resumeContextOfRun(lines, runId);
    } catch {
      return 'degraded'; // 轨迹重建失败（版本不兼容等）——降级重投
    }
  }

  /**
   * inbox 在途 requestId 集（cr-667，A1——恢复面仲裁）：boot 期先取，
   * recoverOrphanRuns 以此 defer 命中的 run（不补 interrupted settled，留给
   * 续跑面原地续跑）。
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

  /**
   * 孤儿 run 收口（cr-628，主线 recoverJournal 惰性幂等语义的 preview 形态）：
   * 壳死于 mid-run 时 journal 留下无 journal-settled 的步行——读侧
   * stepsOfRun 恒报 partial（真在途），run 永远「运行中」。boot 期对全部
   * 会话域扫一遍：有步行/注入行但无 settled 标记的 run 补写
   * journal-settled(interrupted)（幂等——已收束 run 不动）。
   * cr-631 持久化补环：收口的 run 同时补投 viewer run 键锚信（壳死时
   * postReply 未跑、viewer 行从未落——不补则孤儿投影随 settled 让位后
   * steps 二度消失）。锚信 = 空文本 + run 键（user 壳 writeThrough 落行，
   * cr-595 同通道）；盘上 viewer 行已锚定的跳过（防重——跨重启幂等）。
   * 无邮局（CLI 直连）只收口不补锚。返回收口数。
   * cr-667（A1 续跑）：defer = inbox 在途 requestId 集（boot 先取
   * pendingInboxRequestIds）——命中的 run 不补 interrupted settled（留给
   * recoverPendingInbox 续跑面原地续跑，续跑收束即落 ok settled）；锚补投
   * 与收口面解耦，照常执行。
   */
  async recoverOrphanRuns(defer?: Set<string>): Promise<number> {
    const sessionsRoot = path.join(this.agentDirOf(), 'sessions');
    let uuids: string[] = [];
    try { uuids = fs.readdirSync(sessionsRoot); } catch { return 0; }
    let settled = 0;
    const anchors: Array<{ uuid: string; run: string }> = [];
    for (const uuid of uuids) {
      const dir = path.join(sessionsRoot, uuid);
      const lines = readJournal(dir);
      if (lines.length === 0) continue;
      const seen = new Set<string>();
      for (const line of lines) {
        if (line.run === '') continue;
        if (line.type === 'journal-settled') seen.add(line.run);
      }
      const orphans = new Set<string>();
      for (const line of lines) {
        if (line.run !== '' && !seen.has(line.run)
          && (line.type === 'journal-step' || line.type === 'journal-inject')) orphans.add(line.run);
      }
      for (const run of orphans) {
        // cr-667 defer：inbox 在途信的 run 走续跑面——不补 settled（补了
        // 续跑准入〔无 settled〕即失效，退回 step 0 重跑）。
        if (defer !== undefined && run.startsWith('run-') && defer.has(run.slice(4))) continue;
        // 收口只补 journal-settled(interrupted)（cr-640 物化已退役——
        // 步级上下文归 historyMessagesFor 读侧轨迹重建，cr-658）。
        await this.writerFor(uuid, [this.agentId], 'user').settleMechanism(run, 'interrupted');
        settled += 1;
      }
      // viewer 锚缺口（cr-632 链接制——覆盖本 boot 收口与存量已收口两类；
      // 消息 run 判别排除机制 run）
      if (this.postOfficeAddress !== undefined) {
        const viewerDir = path.join(this.dataRoot, 'viewer', 'sessions', uuid);
        const ledgerRows = readLedger(dir).rows;
        for (const run of anchorableRuns(lines, readLedger(viewerDir).rows, ledgerRows)) {
          anchors.push({ uuid, run });
        }
      }
    }
    for (const a of anchors) {
      await this.relayRunAnchor(a.uuid, a.run).catch((err: unknown) => {
        // 补锚失败可容忍：viewer 行缺席下次 boot 仍会重扫重投
        this.ctx.logger.warn('[ledger] 孤儿锚信补投失败（' + a.run + '）：' + String(err));
      });
    }
    return settled;
  }

  /** viewer run 键锚信补投（邮局 → user 壳 writeThrough；失败上抛由调用方记档） */
  private async relayRunAnchor(uuid: string, run: string): Promise<void> {
    if (this.usageOutbound === null) {
      const { IpcClient } = await import('ac-post-office');
      const client = new IpcClient();
      await client.connect(this.postOfficeAddress!);
      this.usageOutbound = { send: (e) => client.send(e) };
    }
    await this.usageOutbound.send({
      uuid,
      requestId: 'orphan-' + run,
      sender: this.agentId,
      to: 'user',
      kind: 'message',
      budget: 0,
      payload: { text: '', run },
    } as Envelope);
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
