// ============================================================
// service.ts —— 子 Agent 服务（M8.3；R-5 修订版单形态的 preview 实现）
//
// subagent = 注册表实体 + 真子壳进程：
//   · spawn = materializeChild（域内物化，M6.5 纯函数——spawn ⊆ 授权投影，
//     剥减机械构造）+ 拉起子壳进程（boot.ts --parent-id --persist，
//     spawnShell 注入面可测；owner 失活子存活——R-5，收割 = 显式 delete）；
//   · 投递 = 信封直投子壳 ipc（A6 统一载体；requestId 幂等 + ack fresh）；
//   · sync/await = 终稿轮询（messages.jsonl 带 run 键的 agent 行 = 终稿，
//     baseline 计数区分多轮新旧——200ms 轮询，零 watch 泄漏面）；
//   · stop = 控制帧 interrupt（活跃 run 收束 interrupted，实体保留）；
//   · 防自激：任务信封 budget = 2（子 run 一次 + 回信线余量；子壳回信
//     budget-1 由 conversation postReply 既有语义承担）。
// 子壳模型恒 mock provider（preview 药丸形态；真 provider 归 cutover 恒等门，
// M5 会话裁同款）。
// ============================================================
import { spawn as childSpawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { materializeChild, listChildIds, readAgentConfig } from 'ac-agents-core';
import { readGlobalAuth, readAgentAuth, deriveChildAuth } from 'ac-auth-core';
import { deriveShellRowset, readCatalog } from 'ac-rowset-core';
import { makeEnvelope, type Envelope } from 'ac-envelope-core';
import { IpcClient } from 'ac-post-office';
import { readLedger } from 'ac-ledger';
import type { ToolResult } from 'ac-tools';

/**
 * 变更后投影（subagents/updated 载荷——主线 SubagentInfo list 口径对齐，
 * 前端 SubBoardEntry 消费面零改动：task/runs/createdAt/updatedAt 从子域
 * 账本统计〔首条 user 行文本 + 终稿行数 + 文件时间戳〕）。
 */
export interface SubagentChangeInfo {
  id: string;
  parentId: string;
  name: string;
  status: string;
  /** 徽章口径（前端词汇）：running | done | error | timeout | stopped | idle */
  displayStatus: string;
  task: string;
  runs: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface SubagentRowOptions {
  dataRoot: string;
  /** 本壳 agent id（父） */
  agentId: string;
  /** 子壳 boot 入口与 catalog（boot 装配显式注入——preview 标准路径） */
  bootFile: string;
  catalogFile: string;
  /** 子壳 spawn 注入面（测试替身）；缺省 = 真子进程 */
  spawnShell?: SpawnShellFn;
  /** 邮局地址（子壳跨壳回信线；缺席 = 直投形态） */
  postOfficeAddress?: string;
}

/** 子壳进程操作面（真 spawn / 测试替身同构——进程 IO 注入） */
export interface ShellProcess {
  pid: number;
  /** 投递信封（ipc 直投；回执 = ack 帧 {ack, fresh}） */
  deliver(env: Envelope): Promise<{ fresh: boolean }>;
  /** 控制帧（stdin 行协议——interrupt/bench） */
  control(frame: Record<string, unknown>): Promise<unknown>;
  /** 优雅收割 */
  shutdown(): Promise<void>;
  /** 进程退出订阅 */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}
export type SpawnShellFn = (args: {
  dataRoot: string; parentId: string; childId: string;
  bootFile: string; catalogFile: string; mockProvider: boolean; postOffice?: string;
}) => ShellProcess;

/** 子记录（list 面） */
export interface SubagentEntry {
  childId: string;
  name?: string;
  status: 'starting' | 'ready' | 'exited';
  pid: number;
  busy: boolean;
}

/** 终稿回执（sync/await 面） */
export interface SubagentReply {
  childId: string;
  text: string;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export class ShellSubagentService extends Service {
  static inject = ['tools'];

  private dataRoot: string;
  private agentId: string;
  private bootFile: string;
  private catalogFile: string;
  private spawnShell: SpawnShellFn;
  private postOfficeAddress: string | undefined;
  private children = new Map<string, ShellProcess>();
  private childMeta = new Map<string, { name?: string; busy: boolean; exited: boolean }>();

  constructor(ctx: Context, options: SubagentRowOptions) {
    super(ctx, 'subagents');
    this.dataRoot = options.dataRoot;
    this.agentId = options.agentId;
    this.bootFile = options.bootFile;
    this.catalogFile = options.catalogFile;
    this.spawnShell = options.spawnShell ?? defaultSpawnShell;
    this.postOfficeAddress = options.postOfficeAddress;
    this.registerTool();
  }

  /** 子 id 铸造（主线同款词表） */
  private newChildId(): string {
    return 'sub-' + Math.random().toString(36).slice(2, 8);
  }

  /** 变更通知（subagents/updated——boot 旁带成前端帧，面板清单刷新唯一源） */
  private notify(childId: string, action: 'spawned' | 'started' | 'settled' | 'stopped' | 'removed'): void {
    this.ctx.emit('subagents/updated', this.infoOf(childId), action);
  }

  /** 变更后投影（SubagentChangeInfo——task/runs 从子域账本统计） */
  infoOf(childId: string): SubagentChangeInfo {
    const meta = this.childMeta.get(childId);
    const proc = this.children.get(childId);
    const dir = this.sessionDirOf(childId);
    let task = '';
    let runs = 0;
    let createdAt = 0;
    let updatedAt = 0;
    try {
      const ledger = readLedger(dir);
      // 首条任务行 = 对端写的行（agent_id !== 子——viewer 投影同判据）
      const first = ledger.rows.find((r) => r.role === 'agent' && r.agent_id !== childId);
      task = (first?.content ?? '').slice(0, 120);
      runs = this.settledRows(childId, dir).length;
      const st = fs.statSync(path.join(dir, 'messages.jsonl'));
      createdAt = st.birthtimeMs;
      updatedAt = st.mtimeMs;
    } catch { /* 未开跑（spawn 未带 task）——零值 */ }
    return {
      id: childId,
      parentId: this.agentId,
      name: meta?.name ?? '',
      status: meta?.exited === true || proc === undefined ? 'exited' : 'ready',
      displayStatus: meta?.busy === true ? 'running' : (meta?.exited === true ? 'stopped' : (runs > 0 ? 'done' : 'idle')),
      task,
      runs,
      createdAt,
      updatedAt,
      deleted: false,
    };
  }

  /** 物化 + 拉起（R-5：物化即快照——父此后改配置不传播） */
  async spawnOp(input: {
    name?: string; system?: string; task: string;
    tools?: string[]; waitMs?: number;
  }): Promise<{ childId: string; reply?: SubagentReply; filtered?: string[] }> {
    const childId = this.newChildId();
    const parent = readAgentConfig(this.dataRoot, this.agentId);
    if (parent === null) throw new Error('父 agent 配置缺席：' + this.agentId);
    const catalog = readCatalog(this.catalogFile);
    const parentRowset = deriveShellRowset({ rows: parent.rows }, catalog);
    // spawn ⊆ 授权投影（工具 schema 承诺「越权名会被过滤」）：未命中目录或
    // 不属父行集的词在此过滤——不过滤会让子壳行集静态断言 fail-loud 早退，
    // spawn 面只见 boot.ready 超时、真实拒因被吞（cr-616，cr-615 实测暴露）。
    // 过滤后空集 = 纯推理子 Agent（schema 同义）。
    let tools: string[] | undefined;
    let filtered: string[] | undefined;
    if (input.tools !== undefined) {
      const parentIds = new Set(parentRowset.rowIds);
      const granted: string[] = [];
      const rejected: string[] = [];
      for (const token of input.tools) {
        const derived = deriveShellRowset({ rows: [token] }, catalog);
        if (derived.warnings.length > 0 || !derived.rowIds.every((id) => parentIds.has(id))) {
          rejected.push(token);
        } else {
          granted.push(token);
        }
      }
      tools = granted;
      if (rejected.length > 0) filtered = rejected;
    }
    materializeChild(this.dataRoot, this.agentId, childId, {
      ...parent,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.system !== undefined ? { system: input.system } : {}),
      ...(tools !== undefined ? { rows: tools } : {}),
    });
    // 子授权层物化（R-5 物化即快照 + spawn ⊆ 投影）：父投影快照内联 grants，
    // 此后父授权变更不传播（M6.5 deriveChildAuth 接线——cr-527）。子壳门读
    // 自己域 auth.json（children 不做运行时投影）。
    const childAuth = deriveChildAuth({
      childId,
      parentId: this.agentId,
      parentEnv: {
        global: readGlobalAuth(this.dataRoot),
        agent: readAgentAuth(this.dataRoot, this.agentId) ?? undefined,
        rowset: new Set(parentRowset.rowIds),
      },
      materializedAt: new Date().toISOString(),
    });
    const authFile = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify(childAuth, null, 2) + '\n', 'utf-8');
    const proc = this.spawnShell({
      dataRoot: this.dataRoot, parentId: this.agentId, childId,
      bootFile: this.bootFile, catalogFile: this.catalogFile,
      mockProvider: true,
      ...(this.postOfficeAddress !== undefined ? { postOffice: this.postOfficeAddress } : {}),
    });
    this.children.set(childId, proc);
    this.childMeta.set(childId, { name: input.name, busy: false, exited: false });
    proc.onExit(() => {
      const meta = this.childMeta.get(childId);
      if (meta !== undefined) { meta.exited = true; meta.busy = false; }
      this.notify(childId, 'settled');
    });
    this.notify(childId, 'spawned');
    if (input.task === '') return { childId, ...(filtered !== undefined ? { filtered } : {}) };
    const waitMs = input.waitMs ?? 0;
    const out = await this.sendOp(childId, input.task, waitMs > 0 ? 'sync' : 'async', waitMs);
    return { childId, ...(out.reply !== undefined ? { reply: out.reply } : {}), ...(filtered !== undefined ? { filtered } : {}) };
  }

  /** 任务信封（budget = 2：子 run 一次 + 回信线余量） */
  private taskEnvelope(childId: string, text: string): Envelope {
    return makeEnvelope({
      uuid: this.agentId + '~' + childId,
      requestId: 'sub-' + crypto.randomUUID(),
      sender: this.agentId,
      to: childId,
      kind: 'message',
      budget: 2,
      payload: { text },
    });
  }

  /**
   * 投递消息。mode 的父侧语义：sync = 阻塞等新终稿；async/steer/next-run
   * = 立返（steer/next-run 的实际投递去向由子壳 conversation 状态机决策
   * ——busy 自动的 steer，空闲即 run；本面不做二次裁决）。
   */
  async sendOp(
    childId: string, message: string, mode: 'async' | 'sync' | 'steer' | 'next-run', waitMs = 0,
  ): Promise<{ delivered: boolean; reply?: SubagentReply }> {
    const proc = this.children.get(childId);
    if (proc === undefined) throw new Error('子 Agent 不在管理面：' + childId + '（list 查询在场清单）');
    const baseline = this.settledCount(childId);
    const meta = this.childMeta.get(childId);
    if (meta !== undefined) meta.busy = true;
    this.notify(childId, 'started');
    const ack = await proc.deliver(this.taskEnvelope(childId, message));
    if (mode === 'sync' || waitMs > 0) {
      const reply = await this.awaitReply(childId, waitMs > 0 ? waitMs : 60_000, baseline);
      if (meta !== undefined) meta.busy = false;
      this.notify(childId, 'settled');
      return { delivered: ack.fresh, ...(reply !== null ? { reply } : {}) };
    }
    return { delivered: ack.fresh };
  }

  /** 等新终稿（baseline = 投递时的终稿数；超时 = null）。不在场 = 抛错
   *（fail-loud——同主线 await 对未知 id 的早期校验语义）。 */
  async awaitOp(childId: string, timeoutMs: number): Promise<SubagentReply | null> {
    if (!this.children.has(childId)) {
      throw new Error('子 Agent 不在管理面：' + childId + '（list 查询在场清单）');
    }
    return this.awaitReply(childId, timeoutMs, this.settledCount(childId));
  }

  private sessionDirOf(childId: string): string {
    return path.join(this.dataRoot, 'agents', this.agentId, 'children', childId,
      'sessions', this.agentId + '~' + childId);
  }

  private async awaitReply(childId: string, timeoutMs: number, baseline: number): Promise<SubagentReply | null> {
    const dir = this.sessionDirOf(childId);
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    for (;;) {
      const last = this.lastSettled(childId, dir, baseline);
      if (last !== null) return last;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(200, Math.max(20, deadline - Date.now())));
    }
  }

  /** 终稿行 = role agent + agent_id 本子 + 带 run 键（settle 专属；入站行无 run） */
  private settledRows(childId: string, dir: string): Array<{ content: string; run?: string }> {
    return readLedger(dir).rows.filter((r) => r.role === 'agent' && r.agent_id === childId && typeof r.run === 'string' && r.run !== '');
  }

  private settledCount(childId: string): number {
    return this.settledRows(childId, this.sessionDirOf(childId)).length;
  }

  private lastSettled(childId: string, dir: string, baseline: number): SubagentReply | null {
    const rows = this.settledRows(childId, dir);
    if (rows.length <= baseline) return null;
    return { childId, text: rows.at(-1)!.content };
  }

  /** list 面（在场 + 物化清单——含已退出者，status 区分） */
  listOp(): SubagentEntry[] {
    const ids = new Set<string>([...this.children.keys(), ...listChildIds(this.dataRoot, this.agentId)]);
    return [...ids].sort().map((childId) => {
      const proc = this.children.get(childId);
      const meta = this.childMeta.get(childId);
      return {
        childId,
        ...(meta?.name !== undefined ? { name: meta.name } : {}),
        status: meta?.exited === true || proc === undefined ? 'exited' : 'ready',
        pid: proc?.pid ?? -1,
        busy: meta?.busy ?? false,
      };
    });
  }

  /** stop：活跃 run 中止（控制帧 interrupt——实体保留可续 send） */
  async stopOp(childId: string): Promise<{ stopped: boolean }> {
    const proc = this.children.get(childId);
    if (proc === undefined) return { stopped: false };
    const out = await proc.control({ ctrl: 'interrupt' }) as { interrupted?: boolean };
    const meta = this.childMeta.get(childId);
    if (meta !== undefined) meta.busy = false;
    this.notify(childId, 'stopped');
    return { stopped: out.interrupted === true };
  }

  /** delete：收割（shutdown + 物化目录删除——探查残留消化，R-5 代价清单） */
  async deleteOp(childId: string): Promise<{ deleted: boolean }> {
    const proc = this.children.get(childId);
    if (proc !== undefined) {
      await proc.shutdown().catch(() => proc.kill());
      this.children.delete(childId);
    }
    const meta = this.childMeta.get(childId);
    if (meta !== undefined) { meta.exited = true; meta.busy = false; }
    fs.rmSync(path.join(this.dataRoot, 'agents', this.agentId, 'children', childId), { recursive: true, force: true });
    this.ctx.emit('subagents/updated', {
      id: childId, parentId: this.agentId, name: meta?.name ?? '', status: 'exited',
      displayStatus: 'stopped', task: '', runs: 0, createdAt: 0, updatedAt: Date.now(), deleted: true,
    } satisfies SubagentChangeInfo, 'removed');
    return { deleted: true };
  }

  // —— 工具面（主线 subagent 工具 schema 平移——LLM 面恒等；误用护栏保留） ——

  private registerTool(): void {
    this.ctx.tools.register({
      name: 'subagent',
      description:
        '派出子 Agent 执行可并行的调研/验证类子任务（全新独立会话——真子进程，不接触任何接收方）。'
        + 'spawn 创建并启动首条任务（任务角色定位/专业人设/输出约束 → system 参数）；send 对已创建的子 Agent 续聊（mode：async 立即返回/sync 阻塞等回复/steer 注入进行中的 run/next-run 排队到下一轮）；await 等待并取当前结果；list 查询（含历史）；stop 停止当前推理（保留会话，可继续 send）；delete 删除（收割——会话与目录一并移除）。'
        + '注意：本工具管理的是你私有的子 Agent 看板，子 Agent 的回复只返回给你——它不能替你向用户或其他 Agent 转达/推送/通知任何内容；要给其他 Agent 或用户发消息用 send_agent，要发群消息用 send_group。'
        + '长输出指引：预期产出长文本（报告/清单/多文件分析等）时，在输出约束里要求子 Agent 把完整产出写入文件（给明确路径），回复只报路径与要点摘要——长回复走回传通道会撞输出体积预算被截断（头尾保留、中段丢失）；需要细节时再 read 该文件（可分页无损读取）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['spawn', 'send', 'await', 'list', 'stop', 'delete'], description: '操作' },
          task: { type: 'string', description: '[spawn] 首条任务消息，需完整自包含（子 Agent 看不到你的会话）——把内容完整写进本参数，不要请转交式截断。任务的角色定位/专业人设/输出约束放 system 参数（固化人设，勿混进 task）。长文本产出类任务的输出约束建议写明：完整结果写入指定文件、回复只给路径+要点（长回复会被截断）。省略则仅创建不启动，之后用 send 发首条' },
          name: { type: 'string', description: '[spawn] 子 Agent 名称' },
          tools: { type: 'array', items: { type: 'string' }, description: '[spawn] 子 Agent 可用的工具名清单（须是你有权分派的能力的子集，越权名会被过滤）。缺省不传 = 继承你的工具面；传空数组 [] = 纯推理子 Agent' },
          system: { type: 'string', description: '[spawn] 子 Agent 的 system prompt（人设/行为约束）。传入即固化（跨轮/跨重启）并完全接管人格语义——不继承父 Agent 的人设与 persona 配置；缺省 = 继承父' },
          subagent_id: { type: 'string', description: '[send/await/stop/delete] 目标子 Agent ID（spawn 返回的 subagent_id，可 list 查询；勿凭记忆复写）' },
          message: { type: 'string', description: '[send] 给该子 Agent 的消息内容（自包含，或基于该子 Agent 已有进展的追问/补充指示）——不是给其他 Agent 或用户发消息' },
          mode: { type: 'string', enum: ['async', 'sync', 'steer', 'next-run'], description: '[send] 投递语义：async（缺省）立即返回，忙时排队；sync 阻塞到消费本条消息的 run 收束并返回结果；steer 注入当前 run 的下一步（空闲则开新 run）；next-run 排队到当前 run 收束后独立执行（async 忙时同此）' },
          timeout_s: { type: 'number', description: '[await] 等待上限秒数（0 = 缺省立即查询不等待；正值 = 阻塞等待新终稿，超时返回 pending）', minimum: 0 },
          wait_time: { type: 'number', description: '[spawn] 正值 = 阻塞等首条任务终稿（秒；超时返回已转后台，结果稍后 await 查询）', minimum: 0 },
          query: { type: 'string', description: '[list] 按 id/名称子串过滤' },
        },
        required: ['action'],
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const childOf = (): string => {
          const id = String(args.subagent_id ?? '');
          if (id === '') throw new Error('缺少 subagent_id（spawn 返回值；list 可查在场清单）');
          return id;
        };
        switch (args.action) {
          case 'spawn': {
            const task = String(args.task ?? '');
            if (/[:：]["'』」]?$/.test(task) && task.length <= 60) {
              return { ok: false, error: 'task 疑似被截断（以冒号结尾）：' + task.slice(0, 40) + '…——引导语后的正文没有出现在 task 参数里。请把完整内容一并放进 task（子 Agent 看不到你的其他参数或会话）' };
            }
            const out = await this.spawnOp({
              ...(typeof args.name === 'string' && args.name.trim() !== '' ? { name: args.name.trim() } : {}),
              ...(typeof args.system === 'string' && args.system.trim() !== '' ? { system: args.system } : {}),
              ...(Array.isArray(args.tools) ? { tools: args.tools.map((s) => String(s)) } : {}),
              task,
              ...(Number(args.wait_time) > 0 ? { waitMs: Math.round(Number(args.wait_time) * 1000) } : {}),
            });
            const notes: string[] = [];
            if (out.filtered !== undefined) notes.push('以下 tools 词未命中目录或不属你的行集，已过滤：' + out.filtered.join(', '));
            if (out.reply === undefined) notes.push('已转后台（未带 wait_time / 等待超时）——结果稍后经 await/list 查询');
            return {
              ok: true,
              output: {
                subagent_id: out.childId,
                status: 'created',
                ...(notes.length > 0 ? { note: notes.join('；') } : {}),
                ...(out.reply !== undefined ? { result: { text: out.reply.text } } : {}),
              },
            };
          }
          case 'send': {
            const message = String(args.message ?? '');
            if (message.trim() === '') return { ok: false, error: 'send 缺少 message（给子 Agent 的消息内容——给用户/其他 Agent 发消息用 send_agent）' };
            const mode = (args.mode === 'sync' || args.mode === 'steer' || args.mode === 'next-run') ? args.mode : 'async';
            const out = await this.sendOp(childOf(), message, mode);
            return {
              ok: true,
              output: {
                delivered: out.delivered,
                ...(out.reply !== undefined ? { result: { text: out.reply.text } } : {}),
              },
            };
          }
          case 'await': {
            const timeoutS = Math.max(0, Number(args.timeout_s ?? 0));
            const reply = await this.awaitOp(childOf(), timeoutS * 1000);
            if (reply === null) return { ok: true, output: { status: 'pending', note: '尚无新终稿——稍后再查（或 timeout_s > 0 阻塞等待）' } };
            return { ok: true, output: { status: 'settled', result: { text: reply.text } } };
          }
          case 'list': {
            const query = typeof args.query === 'string' ? args.query : '';
            const entries = this.listOp().filter((e) => query === '' || e.childId.includes(query) || (e.name ?? '').includes(query));
            return { ok: true, output: { agents: entries, total: entries.length } };
          }
          case 'stop': {
            const out = await this.stopOp(childOf());
            return { ok: true, output: { stopped: out.stopped, note: out.stopped ? '已请求中止当前 run（收束 interrupted，实体保留）' : '无活跃 run（或子壳已退出）' } };
          }
          case 'delete': {
            const out = await this.deleteOp(childOf());
            return { ok: true, output: { deleted: out.deleted } };
          }
          default:
            return { ok: false, error: '未知 action：' + String(args.action) };
        }
      },
    });
  }
}

// 服务键 'subagents' 不重复 declare——主线 ac-subagent 已占用该键（declare module
// 全局合并同键须同类型）；preview 运行时注册同名服务，消费方经 ctx.get('subagents',
// false) 软取（boot 装配面同 conversation 惯例）。cutover 后主线行退役，本行成为
// 唯一提供者。

/** 品牌单映像 exe（cr-620/624：bin/AgentChat.exe 在场即用——supervisor/宿主/壳同映像，任务管理器折一行；缺席回落 node 本体）。
 * 测试环境恒回落 node（cr-621）：品牌副本是本机构建产物，DSH 类沙箱对未知镜像
 * exe 拒写 %TEMP%（EPERM 建激活锁）——vitest 数据根多在 tmpdir，品牌面只归产品宿主。 */
const AGENTCHAT_EXE = (() => {
  const p = path.join(path.resolve(fileURLToPath(new URL('../../../../', import.meta.url))), 'bin', 'AgentChat.exe');
  if (process.env.AGENTCHAT_NO_BRANDED_EXE === '1') return process.execPath; // cr-669 诊断档
  return fs.existsSync(p) && process.env.VITEST === undefined ? p : process.execPath;
})();

/** 真 spawn：node --experimental-strip-types boot.ts --parent-id … --persist */
const defaultSpawnShell: SpawnShellFn = (a) => {
  const args = [
    '--experimental-strip-types', a.bootFile,
    '--data-root', path.resolve(a.dataRoot),
    '--agent-id', a.childId,
    '--parent-id', a.parentId,
    '--catalog', path.resolve(a.catalogFile),
    '--persist', 'true',
    '--mock-provider', a.mockProvider ? '1' : '0',
  ];
  if (a.postOffice !== undefined) args.push('--post-office', a.postOffice);
  const child = childSpawn(AGENTCHAT_EXE, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout!.on('data', (c: Buffer) => {
    for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l);
  });
  const readyHint = (): string | null => {
    const ready = lines.find((l) => l.startsWith('boot.ready'));
    if (ready === undefined) return null;
    return ready.split('\t')[2] ?? null;
  };
  const waitReady = async (): Promise<string> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const hint = readyHint();
      if (hint !== null) return hint;
      if (Date.now() > deadline) throw new Error('子壳 boot.ready 超时：' + lines.join(' | '));
      await sleep(100);
    }
  };
  let clientP: Promise<IpcClient> | null = null;
  const clientOf = async (): Promise<IpcClient> => {
    if (clientP === null) {
      clientP = (async () => {
        const client = new IpcClient();
        await client.connect(await waitReady());
        return client;
      })();
    }
    return clientP;
  };
  return {
    pid: child.pid ?? -1,
    deliver: async (env) => {
      const client = await clientOf();
      const ack = await client.send(env) as { fresh?: boolean };
      return { fresh: ack.fresh !== false };
    },
    control: (frame) => new Promise((resolve, reject) => {
      const base = lines.length; // 只扫新增段（旧 ctrl.done 不重放）
      const timer = setTimeout(() => { clearInterval(iv); reject(new Error('控制帧超时')); }, 20_000);
      const iv = setInterval(() => {
        for (let i = lines.length - 1; i >= base; i--) {
          if (lines[i].startsWith('ctrl.done')) {
            clearTimeout(timer); clearInterval(iv);
            try { resolve(JSON.parse(lines[i].split('\t').slice(1).join('\t'))); } catch { resolve(null); }
            return;
          }
          if (lines[i].startsWith('ctrl.error')) {
            clearTimeout(timer); clearInterval(iv);
            reject(new Error('控制帧失败：' + lines[i]));
            return;
          }
        }
      }, 50);
      child.stdin.write(JSON.stringify(frame) + '\n');
    }),
    shutdown: () => new Promise((res) => {
      child.stdin.write('shutdown\n');
      child.on('exit', () => res());
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 10_000).unref();
    }),
    onExit: (cb) => { child.on('exit', cb); },
    kill: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } },
  };
};

/** subagent 行工厂（boot rowAssemblers 装配） */
export function makeSubagentRow(options: SubagentRowOptions): Plugin {
  return {
    name: 'shell-subagent-row',
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.plugin(class extends ShellSubagentService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
