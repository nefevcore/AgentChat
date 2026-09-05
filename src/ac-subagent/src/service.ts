// ============================================================
// ac-subagent/src/service.ts —— 子 Agent 服务（cordis Service）
//
// 多轮会话模型（2026-10 重构：一次性委派 → 持久多轮实体）：
//   · 子 Agent = 持久实体（注册表落盘 + 会话消息落盘），跨重启可续聊；
//     spawn 创建（可带首条任务消息并启动 run），send 多轮续聊，
//     await 收结果，list 查询（含历史），stop 停推理（保留实体），
//     delete 打墓碑（list 不可见；会话文件保留）。
//   · run 编排：每 run = ctx.agentLoop.run 直连，身份 agent=<subId>
//     （未注册合成 id）——
//       - steer 地址 = subId（runAddress：conversationId 缺省 → 地址即
//         agent）→ send(mode=steer) 经 ctx.agentLoop.steer 注入活跃 run；
//       - 安全门禁对未知身份 fail-closed（能力集只含 base）：delegation
//         标签工具（subagent 自身）被拒 → 递归 spawn 天然挡住，与
//         agent:undefined 时代一致；
//       - 沙箱/persona/memory/datetime 全部回落缺省（agentWorkdir 对
//         未注册 id 返回工作区根，与无身份时代同口径）——零会话污染
//         语义保留：父会话与 ac-session 不受任何影响。
//   · 上下文：会话消息 = user/assistant 对（任务框架 + 逐轮追加）；
//     run 内部 tool 轮次不跨 run 复放（run 结果文本即轮结论）。
//   · 每 run 登记 job（kind=subagent；owner=父；完成通知回投发起会话）。
//
// 落盘（owning：本服务；对齐 ac-conversation 待投持久化范式）：
//   <root>/subagents/index.json   注册表（原子写；含墓碑条目）
//   <root>/subagents/<subId>.jsonl 会话消息行 {role, content, ts}
//   root = 行配置 root ?? AGENTCHAT_DATA_ROOT；未设 = 纯内存（测试兼容）。
//   启动装载：注册表 running → idle（run 随宿主死亡，崩溃恢复）；消息
//   懒装载（list 不读消息，send/await 触达时才读）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult } from 'ac-agent-loop';
import type { ToolResult } from 'ac-tools';
import type { JobOutcome } from 'ac-jobs';
import { splitModelRef } from 'ac-llm';
import { defaultPoolConnection } from 'ac-llm-pool';

/** 子 Agent 实体状态（run 级终态见 SubagentRunSummary） */
export type SubagentStatus = 'idle' | 'running';

/** run 终态（timeout/stopped = 被 abort 打断，实体仍可续聊） */
export type SubagentRunStatus = 'done' | 'error' | 'timeout' | 'stopped';

/** 单轮 run 收束摘要 */
export interface SubagentRunSummary {
  status: SubagentRunStatus;
  /** loop finish 词汇（stop/max-steps/veto/error/interrupted） */
  finish: string;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

/** 注册表持久化条目（index.json 行） */
export interface SubagentRecord {
  id: string;
  parentId: string;
  name: string;
  /** 首条任务摘要（展示用；spawn 时或首条消息时填充） */
  task: string;
  status: SubagentStatus;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  /** 已执行 run 数 */
  runs: number;
  toolNames?: string[];
  maxSteps: number;
  timeoutMs: number;
  lastRun?: SubagentRunSummary;
}

/** list/get 投影 */
export interface SubagentInfo {
  id: string;
  parentId: string;
  name: string;
  status: SubagentStatus;
  /** 徽章口径：running | lastRun.status | idle */
  displayStatus: string;
  task: string;
  runs: number;
  createdAt: number;
  updatedAt: number;
  lastRun?: SubagentRunSummary;
}

export type SubagentSendMode = 'async' | 'sync' | 'steer' | 'next-run';

export interface SubagentRowOptions {
  /** 持久化根（给定即启用 <root>/subagents/；缺省跟随宿主数据根） */
  root?: string;
}

export interface SubagentSpawnOptions {
  parentId: string;
  name?: string;
  /** 首条任务消息（给出即启动首轮 run） */
  task?: string;
  context?: string;
  toolNames?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  /** 发起会话键（job 完成通知回投目标） */
  conversationId?: string;
}

export interface SubagentSendOptions {
  /** job owner（发起方 Agent id） */
  parentId: string;
  text: string;
  mode?: SubagentSendMode;
  /** 发起会话键 */
  conversationId?: string;
}

export interface SubagentListOptions {
  /** id/名称/任务子串过滤 */
  query?: string;
  runningOnly?: boolean;
  limit?: number;
}

export interface SubagentSpawnResult {
  info: SubagentInfo;
  /** spawn 带任务时：首轮 run 收束 promise */
  settled?: Promise<SubagentRunSummary>;
}

export interface SubagentSendResult {
  delivered: 'started' | 'steered' | 'queued';
  info: SubagentInfo;
  /** mode=sync：消费本条消息的 run 收束 promise */
  settled?: Promise<SubagentRunSummary>;
}

/** inbox 条目（待投消息；token = sync 等待方寻址键） */
interface InboxItem {
  text: string;
  context?: string;
  conversationId?: string;
  token?: string;
}

/** 内存活跃态（注册表条目的运行时伴生；run 收束后消息缓存回收） */
interface SubEntry {
  record: SubagentRecord;
  inbox: InboxItem[];
  /** 会话消息缓存（undefined = 仅磁盘，按需装载） */
  messages: LlmMessage[] | undefined;
  controller: AbortController | undefined;
  abortReason: 'stop' | 'timeout' | undefined;
  /** runLoop 活跃标志（同步置位/清位——kick 的竞态安全依据） */
  consuming: boolean;
  /** sync 等待方（token → resolve；消费该消息的 run 收束时回调） */
  waiters: Map<string, (s: SubagentRunSummary) => void>;
  /** 当前 run 收束回调（awaitSettled 挂载） */
  currentSettlers: Array<(s: SubagentRunSummary) => void>;
}

interface RegistryFile {
  version: 1;
  subs: SubagentRecord[];
}

interface MessageLine {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

/** 每 run 缺省超时（5 分钟） */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** 缺省步数上限 */
const DEFAULT_MAX_STEPS = 15;
/** list 缺省/上限条数 */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

/**
 * 首条消息框架（独立上下文，不背父 Agent 历史）。首条 = 任务定位 +
 * 多轮约定；后续 send 为普通 user 消息。
 */
function frameTask(task: string, context?: string): string {
  const parts = [`[子任务] 请作为独立子 Agent 完成以下任务。`, ``, `任务：${task}`];
  if (context?.trim()) parts.push(``, `[上下文]`, context.trim());
  parts.push(
    ``,
    `要求：独立思考并执行。本子 Agent 会话支持多轮：父 Agent 可能继续发送补充指示或追问，收到后基于已有进展继续执行并答复；每轮结束时给出明确的当前结论。`,
  );
  return parts.join('\n');
}

/** id 文件名安全（生成端恒安全；装载端防御） */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(id);
}

export class SubagentsService extends Service {
  static inject = ['tools', 'agentLoop', 'jobs', 'agents'];

  /** 持久化注册表全量（含墓碑；启动装载后常驻内存） */
  private records = new Map<string, SubagentRecord>();
  /** 活跃态（触达过的实体；run 收束后仅保留薄条目） */
  private entries = new Map<string, SubEntry>();
  /** 持久化目录（undefined = 纯内存态） */
  private readonly storeDir: string | undefined;
  /** 已建目录 memo（append 前置 mkdir 摊销） */
  private ensuredDir = false;
  /** waiter/inbox token 序号（进程内单调） */
  private seq = 0;

  constructor(ctx: Context, options: SubagentRowOptions = {}) {
    super(ctx, 'subagents');
    const root = options.root ?? process.env.AGENTCHAT_DATA_ROOT;
    this.storeDir = root !== undefined ? path.resolve(root, 'subagents') : undefined;
    this.loadRegistry();
    this.registerTool();
  }

  /** 卸载：中止全部活跃 run（尽力而为，收束异步完成）；等待方立即释放 */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.controller) {
        entry.abortReason ??= 'stop';
        entry.controller.abort();
      }
      this.releaseWaiters(entry, {
        status: 'stopped',
        finish: 'interrupted',
        error: '宿主卸载，等待中的 run 已中止（消息保留在队列）',
        startedAt: 0,
        finishedAt: Date.now(),
      });
      for (const fn of entry.currentSettlers.splice(0)) {
        fn({
          status: 'stopped',
          finish: 'interrupted',
          error: '宿主卸载，run 已中止',
          startedAt: 0,
          finishedAt: Date.now(),
        });
      }
    }
  }

  // ============================================================
  // 公共面（工具行转发；亦可被宿主进程内直调）
  // ============================================================

  /** 创建子 Agent；task 给出即投递首条消息并启动 run */
  spawn(opts: SubagentSpawnOptions): SubagentSpawnResult {
    // fail-fast（保持旧语义）：父不存在/无模型在创建口报错
    this.resolveModel(opts.parentId);
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const record: SubagentRecord = {
      id,
      parentId: opts.parentId,
      name: opts.name || '子任务',
      task: (opts.task ?? '').slice(0, 80),
      status: 'idle',
      deleted: false,
      createdAt: now,
      updatedAt: now,
      runs: 0,
      maxSteps: opts.maxSteps && opts.maxSteps > 0 ? opts.maxSteps : DEFAULT_MAX_STEPS,
      timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
      ...(opts.toolNames && opts.toolNames.length > 0 ? { toolNames: opts.toolNames } : {}),
    };
    this.records.set(id, record);
    this.persistRegistry();
    const entry = this.hydrate(record);
    let settled: Promise<SubagentRunSummary> | undefined;
    const task = opts.task?.trim();
    if (task) {
      // 内部按 sync 投递取首轮收束 promise（供 spawn wait_time 阻塞语义）；
      // 对外仍是异步启动——settled 不 await 即忽略
      settled = this.deliver(entry, task, 'sync', {
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      }).settled;
    }
    return { info: this.infoOf(record), ...(settled ? { settled } : {}) };
  }

  /**
   * 多轮发送。投递语义（mode）：
   *   · async（缺省）/next-run：忙 → 排队（当前 run 收束后独立 run 消费）；
   *     空闲 → 立即开跑。保守缺省：不打扰进行中的 run，注入须显式 steer。
   *   · steer：忙 → 注入活跃 run 的下一步（收束窗口已关 → 回落排队）；
   *     空闲 → 开新 run。
   *   · sync：投递同 async，但阻塞到消费本条消息的 run 收束（settled）。
   */
  send(id: string, opts: SubagentSendOptions): SubagentSendResult {
    const record = this.requireRecord(id);
    const entry = this.hydrate(record);
    const text = opts.text.trim();
    if (!text) throw new Error('send 需要非空 message');
    const r = this.deliver(entry, text, opts.mode ?? 'async', {
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    });
    return { delivered: r.delivered, info: this.infoOf(record), ...(r.settled ? { settled: r.settled } : {}) };
  }

  /**
   * 等待并取结果：运行中 → 等当前 run 收束；空闲 → 返回最近 run 摘要
   * （从未运行 → null）。无消息等待入口（send(sync) 是带消息的等待）。
   */
  async awaitSettled(id: string): Promise<SubagentRunSummary | null> {
    const record = this.requireRecord(id);
    const entry = this.hydrate(record);
    if (entry.controller !== undefined) {
      return new Promise<SubagentRunSummary>((resolve) => {
        entry.currentSettlers.push(resolve);
      });
    }
    return record.lastRun ?? null;
  }

  /** 停止当前推理（步边界收束为 stopped；实体与待投队列保留，可再 send） */
  stop(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.deleted) return false;
    const entry = this.hydrate(record);
    return this.stopRun(entry, 'stop');
  }

  /** 打墓碑：终止活跃 run（若有）+ list 不再可见；会话文件保留 */
  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.deleted) return false;
    record.deleted = true;
    record.updatedAt = Date.now();
    const entry = this.entries.get(id);
    if (entry) {
      entry.inbox = [];
      this.stopRun(entry, 'stop');
      this.releaseWaiters(entry, {
        status: 'stopped',
        finish: 'deleted',
        error: '子 Agent 已删除，等待中的消息不再消费',
        startedAt: 0,
        finishedAt: Date.now(),
      });
      // runLoop 在当前 run 收束后见 deleted 自行退出并回收 entry
    }
    this.persistRegistry();
    return true;
  }

  /** 查询（含历史；墓碑不可见）。活跃在前，其余按 updatedAt 降序 */
  list(opts: SubagentListOptions = {}): { activeCount: number; total: number; subs: SubagentInfo[] } {
    const query = opts.query?.trim().toLowerCase();
    const infos = [...this.records.values()]
      .filter((r) => !r.deleted)
      .map((r) => this.infoOf(r))
      .filter((info) => {
        if (query && !(`${info.id} ${info.name} ${info.task}`.toLowerCase().includes(query))) return false;
        if (opts.runningOnly && info.status !== 'running') return false;
        return true;
      });
    infos.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.createdAt - a.createdAt; // 同毫秒决胜（新创建在前）
    });
    const limit = Math.max(1, Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT));
    return {
      activeCount: infos.filter((i) => i.status === 'running').length,
      total: infos.length,
      subs: infos.slice(0, limit),
    };
  }

  /** 单个查询（墓碑视作不存在） */
  get(id: string): SubagentInfo | undefined {
    const record = this.records.get(id);
    if (!record || record.deleted) return undefined;
    return this.infoOf(record);
  }

  /** 会话消息（上下文回放口径：user/assistant 对） */
  async history(id: string): Promise<LlmMessage[]> {
    const record = this.requireRecord(id);
    const entry = this.hydrate(record);
    return [...(await this.ensureMessages(entry))];
  }

  // ============================================================
  // 投递与 run 编排（内部）
  // ============================================================

  private deliver(
    entry: SubEntry,
    text: string,
    mode: SubagentSendMode,
    extra: { context?: string; conversationId?: string } = {},
  ): { delivered: 'started' | 'steered' | 'queued'; settled?: Promise<SubagentRunSummary> } {
    const busy = entry.controller !== undefined;
    if (mode === 'steer' && busy) {
      // steer 地址 = subId（runAddress：conversationId 缺省 → 地址即 agent）
      if (this.ctx.agentLoop.steer(entry.record.id, { role: 'user', content: text })) {
        // 注入消息 = 会话事实：立即入档（活跃 run 的回复行收束时追加）
        this.commitUserLine(entry, text);
        return { delivered: 'steered' };
      }
      // 收束窗口已关 → 回落排队（消息不丢，与 ac-conversation D3 同姿势）
    }
    const token = `w${++this.seq}`;
    entry.inbox.push({
      text,
      ...(extra.context ? { context: extra.context } : {}),
      ...(extra.conversationId ? { conversationId: extra.conversationId } : {}),
      token,
    });
    this.kick(entry);
    const delivered: 'started' | 'queued' = busy ? 'queued' : 'started';
    return {
      delivered,
      ...(mode === 'sync'
        ? {
            settled: new Promise<SubagentRunSummary>((resolve) => {
              entry.waiters.set(token, resolve);
            }),
          }
        : {}),
    };
  }

  /** 唤醒 runLoop（consuming 同步标志：与 runLoop 出口的间隙零竞态） */
  private kick(entry: SubEntry): void {
    if (entry.consuming) return; // 链跑中，inbox 由当前 loop 消费
    void this.runLoop(entry);
  }

  /** 串行消费 inbox：一 run 一消息；stop/timeout/delete 打断链跑（队列保留） */
  private async runLoop(entry: SubEntry): Promise<void> {
    entry.consuming = true;
    try {
      while (true) {
        if (entry.record.deleted) break;
        const next = entry.inbox.shift();
        if (next === undefined) break;
        const summary = await this.executeRun(entry, next);
        if (summary.status === 'stopped' || summary.status === 'timeout') break;
      }
    } finally {
      entry.consuming = false;
      // 剩余等待方 = 尚未被消费的排队消息（本条目的 settle 在 executeRun
      // 内已各自释放）——它们未被处理、仍在队列，用 lastRun（上一轮的
      // 摘要）resolve 会谎报"本条已处理完毕"；统一以"run 被打断"口径释放
      this.releaseWaiters(entry, {
        status: 'stopped',
        finish: 'interrupted',
        error: 'run 被打断（消息保留在队列，下次 send 唤醒后消费）',
        startedAt: 0,
        finishedAt: Date.now(),
      });
      // 消息缓存回收（磁盘为事实源，下次触达重装载）——纯内存模式无
      // 磁盘可回读，缓存必须常驻（回收即丢历史）
      if (this.storeDir !== undefined) entry.messages = undefined;
    }
  }

  /** 单轮 run：装配上下文 → job 登记 → loop 直连 → 收束入档 */
  private async executeRun(entry: SubEntry, item: InboxItem): Promise<SubagentRunSummary> {
    const rec = entry.record;
    const startedAt = Date.now();
    const controller = new AbortController();
    entry.controller = controller;
    entry.abortReason = undefined;
    rec.status = 'running';
    rec.updatedAt = startedAt;
    this.persistRegistry();

    // job 登记回调句柄：先声明后使用——settle 闭包会被早期失败路径
    // （模型解析失败等，先于 jobs.start）调用，声明滞后即 TDZ ReferenceError
    let jobDone: ((o: JobOutcome) => void) | undefined;

    const settle = (s: SubagentRunSummary): SubagentRunSummary => {
      entry.controller = undefined;
      entry.abortReason = undefined;
      rec.status = 'idle';
      rec.runs++;
      rec.lastRun = s;
      rec.updatedAt = Date.now();
      this.persistRegistry();
      if (item.token !== undefined) {
        const w = entry.waiters.get(item.token);
        if (w) {
          entry.waiters.delete(item.token);
          w(s);
        }
      }
      const settlers = entry.currentSettlers.splice(0);
      for (const fn of settlers) fn(s);
      jobDone?.(jobOutcomeOf(s));
      if (rec.deleted) this.entries.delete(rec.id);
      return s;
    };

    // 上下文装载 + 首条消息框架
    const messages = await this.ensureMessages(entry);
    const first = messages.length === 0;
    const content = first ? frameTask(item.text, item.context) : item.text;
    if (first && !rec.task) {
      rec.task = item.text.slice(0, 80);
      this.persistRegistry();
    }
    messages.push({ role: 'user', content });
    this.appendMessage(rec.id, 'user', content);

    // 模型解析（每 run 现解析——父配置热更生效）
    let model: string;
    let provider: string | undefined;
    try {
      const resolved = this.resolveModel(rec.parentId);
      model = resolved.model;
      provider = resolved.provider;
    } catch (err: unknown) {
      return settle({
        status: 'error',
        finish: 'error',
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: Date.now(),
      });
    }

    // job 登记（每 run 一条；失败不阻塞执行——与旧 spawn 同姿势）
    try {
      this.ctx.jobs.start({
        kind: 'subagent',
        label: item.text.slice(0, 80) || '子任务',
        ownerAgentId: rec.parentId,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        meta: { subagentId: rec.id, name: rec.name, parentId: rec.parentId },
        run: () => ({
          cancel: () => {
            this.stopRun(entry, 'stop');
          },
          done: new Promise<JobOutcome>((resolveJob) => {
            jobDone = resolveJob;
          }),
          readOutput: () => rec.lastRun?.result ?? '',
        }),
      });
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] "${rec.id}" 登记 ctx.jobs 失败（不影响执行）: ${String(err)}`);
    }

    // 超时看门狗（abort 在步边界生效；LLM 传输层直达）
    const timer = setTimeout(() => {
      entry.abortReason = 'timeout';
      controller.abort();
    }, rec.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let result: LoopRunResult;
    try {
      result = await this.ctx.agentLoop.run({
        // 未注册合成身份：steer 可寻址 + 门禁 fail-closed（防递归）+ 扩展行回落缺省
        agent: rec.id,
        model,
        ...(provider ? { provider } : {}),
        messages: [...messages],
        ...(rec.toolNames && rec.toolNames.length > 0 ? { tools: rec.toolNames } : {}),
        maxSteps: rec.maxSteps,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      return settle({
        status: 'error',
        finish: 'error',
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: Date.now(),
      });
    }
    clearTimeout(timer);

    // 回复行（非空才入档——中断/空回复不留半行，与 ac-session 同口径）
    if (result.text) {
      messages.push({ role: 'assistant', content: result.text });
      this.appendMessage(rec.id, 'assistant', result.text);
    }
    const status: SubagentRunStatus =
      result.finish === 'error'
        ? 'error'
        : result.finish === 'interrupted'
          ? entry.abortReason === 'timeout'
            ? 'timeout'
            : 'stopped'
          : 'done'; // stop/max-steps/veto：有终文本即完成口径（旧语义）
    return settle({
      status,
      finish: result.finish,
      ...(result.text ? { result: result.text } : {}),
      ...(status === 'error'
        ? { error: result.error ?? `循环异常（finish=${result.finish}）` }
        : {}),
      startedAt,
      finishedAt: Date.now(),
    });
  }

  private stopRun(entry: SubEntry, reason: 'stop' | 'timeout'): boolean {
    if (entry.controller === undefined) return false;
    entry.abortReason = reason;
    entry.controller.abort();
    return true;
  }

  /** 释放全部等待方（loop 出口/删除/卸载：迟到的 sync 等待不悬挂） */
  private releaseWaiters(entry: SubEntry, fallback: SubagentRunSummary): void {
    for (const [, resolve] of entry.waiters) resolve(fallback);
    entry.waiters.clear();
  }

  // ============================================================
  // 身份/注册表/消息 持久化与装载
  // ============================================================

  /** 父模型解析（与 router 信封同口径：父 model → 默认池连接 → fail-closed） */
  private resolveModel(parentId: string): { model: string; provider?: string } {
    const parent = this.ctx.agents.get(parentId);
    if (!parent) {
      throw new Error(`父 Agent "${parentId}" 未注册（subagent 需要父的 model 配置）`);
    }
    let model = parent.model;
    if (!model) {
      const config = this.ctx.get('config', false) as
        | { get<T>(key: string): T | undefined }
        | undefined;
      const def = defaultPoolConnection(config?.get<Record<string, unknown>>('llmProviders'));
      if (def) model = `${def.provider}@${def.model}`;
    }
    if (!model || parent.virtual) {
      throw new Error(`父 Agent "${parentId}" 无可用模型（virtual 或缺 model，不能派子 Agent）`);
    }
    // 防御性拆分：存量 AgentConfig.model 可能带 name@model 引用
    const ref = splitModelRef(model);
    const provider = ref.provider ?? parent.provider;
    return { model: ref.model, ...(provider ? { provider } : {}) };
  }

  private requireRecord(id: string): SubagentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`子 Agent "${id}" 不存在（subagent(action="list") 查询可用 id）`);
    if (record.deleted) throw new Error(`子 Agent "${id}" 已删除`);
    return record;
  }

  private hydrate(record: SubagentRecord): SubEntry {
    let entry = this.entries.get(record.id);
    if (entry === undefined) {
      entry = {
        record,
        inbox: [],
        messages: undefined,
        controller: undefined,
        abortReason: undefined,
        consuming: false,
        waiters: new Map(),
        currentSettlers: [],
      };
      this.entries.set(record.id, entry);
    }
    return entry;
  }

  private infoOf(rec: SubagentRecord): SubagentInfo {
    const running = this.entries.get(rec.id)?.controller !== undefined || rec.status === 'running';
    return {
      id: rec.id,
      parentId: rec.parentId,
      name: rec.name,
      status: running ? 'running' : 'idle',
      displayStatus: running ? 'running' : (rec.lastRun?.status ?? 'idle'),
      task: rec.task,
      runs: rec.runs,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      ...(rec.lastRun ? { lastRun: rec.lastRun } : {}),
    };
  }

  private registryPath(): string {
    return path.join(this.storeDir!, 'index.json');
  }

  private messagesPath(id: string): string {
    return path.join(this.storeDir!, `${id}.jsonl`);
  }

  /** 启动装载：注册表全量入内存；running → idle（崩溃恢复） */
  private loadRegistry(): void {
    if (this.storeDir === undefined) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath(), 'utf-8');
    } catch {
      return; // 无文件 = 空表
    }
    let dirty = false;
    try {
      const parsed = JSON.parse(raw) as RegistryFile;
      for (const rec of parsed?.subs ?? []) {
        if (!rec || typeof rec.id !== 'string' || !safeId(rec.id)) continue;
        if (rec.deleted !== true && rec.status === 'running') {
          rec.status = 'idle'; // run 随宿主死亡
          dirty = true;
        }
        this.records.set(rec.id, rec);
      }
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] 注册表装载失败（按空表启动）: ${String(err)}`);
      return;
    }
    if (dirty) this.persistRegistry();
  }

  /** 注册表全量原子写（tmp+rename；墓碑条目保留） */
  private persistRegistry(): void {
    if (this.storeDir === undefined) return;
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });
      const body = JSON.stringify({ version: 1, subs: [...this.records.values()] } satisfies RegistryFile);
      const file = this.registryPath();
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, body, 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] 注册表落盘失败（内存语义照常）: ${String(err)}`);
    }
  }

  private async ensureMessages(entry: SubEntry): Promise<LlmMessage[]> {
    if (entry.messages !== undefined) return entry.messages;
    const lines: LlmMessage[] = [];
    if (this.storeDir !== undefined) {
      try {
        const raw = fs.readFileSync(this.messagesPath(entry.record.id), 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as MessageLine;
            if (parsed && (parsed.role === 'user' || parsed.role === 'assistant') && typeof parsed.content === 'string') {
              lines.push({ role: parsed.role, content: parsed.content });
            }
          } catch {
            /* 损坏行跳过 */
          }
        }
      } catch {
        /* 无文件 = 空会话 */
      }
    }
    entry.messages = lines;
    return lines;
  }

  /** 会话行追加（user/assistant；尽力而为，失败不阻塞） */
  private appendMessage(id: string, role: 'user' | 'assistant', content: string): void {
    if (this.storeDir === undefined) return;
    try {
      if (!this.ensuredDir) {
        fs.mkdirSync(this.storeDir, { recursive: true });
        this.ensuredDir = true;
      }
      fs.appendFileSync(this.messagesPath(id), `${JSON.stringify({ role, content, ts: Date.now() } satisfies MessageLine)}\n`, 'utf-8');
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] 会话落盘失败（${id}/${role}）: ${String(err)}`);
    }
  }

  /** steer 注入的消息即时入档（内存 + 磁盘；活跃 run 回复行收束时追加） */
  private commitUserLine(entry: SubEntry, text: string): void {
    entry.messages?.push({ role: 'user', content: text });
    this.appendMessage(entry.record.id, 'user', text);
  }

  // ============================================================
  // subagent 工具（spawn/send/await/list/stop/delete 单工具 action 分发）
  // ============================================================

  private registerTool(): void {
    this.ctx.tools.register({
      name: 'subagent',
      description:
        '派出子 Agent 执行子任务（多轮会话、消息落盘，可跨重启续聊）：spawn 创建并可选启动首条任务；send 发消息续聊（mode：async 立即返回/sync 阻塞等回复/steer 注入进行中的 run/next-run 排队到下一轮）；await 等待并取当前结果；list 查询（含历史）；stop 停止当前推理（保留会话，可继续 send）；delete 删除（list 不再可见）。',
      requiredTags: ['delegation'],
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['spawn', 'send', 'await', 'list', 'stop', 'delete'],
            description: '操作',
          },
          task: { type: 'string', description: '[spawn] 首条任务消息（需完整自包含；省略则仅创建不启动，之后用 send 发首条）' },
          name: { type: 'string', description: '[spawn] 子 Agent 名称' },
          tools: { type: 'array', items: { type: 'string' }, description: '[spawn] 可用工具名（留空 = 纯推理）' },
          context: { type: 'string', description: '[spawn] 首条任务的附加上下文' },
          subagent_id: { type: 'string', description: '[send/await/stop/delete] 子 Agent ID' },
          message: { type: 'string', description: '[send] 消息内容（自包含，或基于该子 Agent 已有进展的追问/补充指示）' },
          mode: {
            type: 'string',
            enum: ['async', 'sync', 'steer', 'next-run'],
            description:
              '[send] 投递语义：async（缺省）立即返回，忙时排队；sync 阻塞到消费本条消息的 run 收束并返回结果；steer 注入当前 run 的下一步（空闲则开新 run）；next-run 排队到当前 run 收束后独立执行（async 忙时同此）',
          },
          max_steps: { type: 'number', description: '[spawn] 每轮步数上限（默认 15）', minimum: 1 },
          timeout_s: { type: 'number', description: '[spawn] 每轮 run 超时秒数（默认 300，超时强制终止）', minimum: 1 },
          wait_time: {
            type: 'number',
            description: '[spawn] 正值 = 阻塞等首轮 run 完成并直接返回结果（默认 0 立即返回）',
            minimum: 0,
          },
          query: { type: 'string', description: '[list] 按 id/名称/任务子串过滤' },
          running_only: { type: 'boolean', description: '[list] 只看运行中（缺省含历史）' },
          limit: { type: 'number', description: '[list] 返回条数上限（默认 20，最大 100）', minimum: 1 },
        },
        required: ['action'],
      },
      // 箭头函数捕获服务实例（execute 由 tools 服务调用，this 不指向本服务）
      execute: async (args, call): Promise<ToolResult> => {
        // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
        const parentId = call.agentId ?? '__host__';
        switch (args.action) {
          case 'spawn': {
            const task = String(args.task ?? '').trim();
            if (!task && (Number(args.wait_time) || 0) > 0) {
              return { ok: false, error: 'spawn 未给 task 时没有可等待的 run（wait_time 仅在带任务启动时有效）' };
            }
            const spawned = this.spawn({
              parentId,
              ...(args.name ? { name: String(args.name) } : {}),
              ...(task ? { task } : {}),
              ...(args.context ? { context: String(args.context) } : {}),
              ...(Array.isArray(args.tools) ? { toolNames: args.tools.map((s: unknown) => String(s)) } : {}),
              ...(Number(args.max_steps) > 0 ? { maxSteps: Number(args.max_steps) } : {}),
              ...(Number(args.timeout_s) > 0 ? { timeoutMs: Math.round(Number(args.timeout_s) * 1000) } : {}),
              ...(call.conversationId ? { conversationId: call.conversationId } : {}),
            });
            if ((Number(args.wait_time) || 0) > 0 && spawned.settled) {
              const s = await spawned.settled;
              if (s.status !== 'done') {
                return {
                  ok: false,
                  error: s.error || `首轮 run 未完成（status=${s.status}）`,
                  output: { subagent_id: spawned.info.id, status: s.status },
                };
              }
              return {
                ok: true,
                output: {
                  subagent_id: spawned.info.id,
                  status: 'done',
                  result: s.result,
                  elapsed_ms: s.finishedAt - s.startedAt,
                },
              };
            }
            return {
              ok: true,
              output: {
                subagent_id: spawned.info.id,
                status: spawned.info.status,
                message:
                  spawned.info.status === 'running'
                    ? `子 Agent "${spawned.info.id}" 已创建并启动，用 subagent(action="await", subagent_id) 收结果，subagent(action="send") 续聊`
                    : `子 Agent "${spawned.info.id}" 已创建（未启动），用 subagent(action="send") 发首条任务`,
              },
            };
          }
          case 'send': {
            const id = String(args.subagent_id ?? '');
            if (!id) return { ok: false, error: '缺少 subagent_id 参数' };
            const text = String(args.message ?? '').trim();
            if (!text) return { ok: false, error: '缺少 message 参数' };
            const modeRaw = String(args.mode ?? 'async');
            const mode: SubagentSendMode =
              modeRaw === 'sync' || modeRaw === 'steer' || modeRaw === 'next-run' ? modeRaw : 'async';
            const r = this.send(id, {
              parentId,
              text,
              mode,
              ...(call.conversationId ? { conversationId: call.conversationId } : {}),
            });
            if (mode === 'sync' && r.settled) {
              const s = await r.settled;
              return {
                ok: true,
                output: {
                  subagent_id: id,
                  delivered: r.delivered,
                  status: s.status,
                  finish: s.finish,
                  ...(s.result !== undefined ? { result: s.result } : {}),
                  ...(s.error !== undefined ? { error: s.error } : {}),
                  elapsed_ms: s.finishedAt - s.startedAt,
                },
              };
            }
            const hints: Record<string, string> = {
              started: '已启动新 run（await 可收结果）',
              steered: '已注入当前 run 的下一步',
              queued: '已排队（当前 run 收束后自动消费）',
            };
            return {
              ok: true,
              output: {
                subagent_id: id,
                delivered: r.delivered,
                status: r.info.status,
                message: hints[r.delivered],
              },
            };
          }
          case 'await': {
            const id = String(args.subagent_id ?? '');
            if (!id) return { ok: false, error: '缺少 subagent_id 参数' };
            const s = await this.awaitSettled(id);
            if (s === null) {
              return {
                ok: true,
                output: { subagent_id: id, status: 'idle', message: '尚未运行过（send 可启动首轮）' },
              };
            }
            return {
              ok: true,
              output: {
                subagent_id: id,
                status: s.status,
                finish: s.finish,
                ...(s.result !== undefined ? { result: s.result } : {}),
                ...(s.error !== undefined ? { error: s.error } : {}),
                elapsed_ms: s.finishedAt - s.startedAt,
              },
            };
          }
          case 'list': {
            const r = this.list({
              ...(args.query ? { query: String(args.query) } : {}),
              ...(args.running_only === true ? { runningOnly: true } : {}),
              ...(Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
            });
            return {
              ok: true,
              output: {
                active_count: r.activeCount,
                total: r.total,
                subagents: r.subs.map((s) => ({
                  id: s.id,
                  name: s.name,
                  status: s.displayStatus,
                  task: s.task,
                  runs: s.runs,
                  created_at: new Date(s.createdAt).toISOString(),
                  updated_at: new Date(s.updatedAt).toISOString(),
                  ...(s.lastRun?.result !== undefined ? { last_result: s.lastRun.result.slice(0, 200) } : {}),
                })),
              },
            };
          }
          case 'stop': {
            const id = String(args.subagent_id ?? '');
            if (!id) return { ok: false, error: '缺少 subagent_id 参数' };
            if (!this.stop(id)) {
              return { ok: false, error: `子 Agent "${id}" 不存在或当前没有进行中的 run` };
            }
            return {
              ok: true,
              output: { subagent_id: id, stopped: true, message: '已请求停止（run 将在步边界收束；会话保留，可继续 send 续聊）' },
            };
          }
          case 'delete': {
            const id = String(args.subagent_id ?? '');
            if (!id) return { ok: false, error: '缺少 subagent_id 参数' };
            if (!this.remove(id)) {
              return { ok: false, error: `子 Agent "${id}" 不存在或已删除` };
            }
            return {
              ok: true,
              output: { subagent_id: id, deleted: true, message: '已标记删除（list 不再可见；会话文件保留）' },
            };
          }
          default:
            return {
              ok: false,
              error: `未知 action "${String(args.action)}"，应为 spawn/send/await/list/stop/delete 之一`,
            };
        }
      },
    });
  }
}

/** run 摘要 → job 终态映射（done→completed / error→failed / 打断→killed） */
function jobOutcomeOf(s: SubagentRunSummary): JobOutcome {
  if (s.status === 'done') return { status: 'completed', detail: 'exit ok', output: s.result ?? '' };
  if (s.status === 'error') return { status: 'failed', detail: s.error ?? 'error' };
  return { status: 'killed', detail: s.status };
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 子 Agent 多轮会话服务（ac-subagent 提供） */
    subagents: SubagentsService;
  }
}
