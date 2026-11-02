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
import { materializeChild, listChildIds, readAgentConfig, childIsArchived, ARCHIVED_FILE } from 'ac-agents-core';
import { readGlobalAuth, readAgentAuth, deriveChildAuth } from 'ac-auth-core';
import { deriveShellRowset, readCatalog } from 'ac-rowset-core';
import { filterSpawnTools, convInheritTagsOf, spawnChildConfigOf } from './inherit.ts';
import { makeEnvelope, deliver, readActivationLock, IpcClient, type DeliverResult, type RendezvousPaths, type Envelope } from 'ac-envelope-core';
import { runAddress } from 'ac-core-utils';
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
  /** 已退出时的死因投影（aborted = 带任务硬退出，cr-724） */
  exit?: { code: number | null; signal: string | null; aborted: boolean };
  /** 发起会话键（cr-738：list 会话域过滤——config 物化/inbox 信封回落；缺席 = 宿主直调/早期无键） */
  originConversation?: string;
}

/** 终稿回执（sync/await 面） */
export interface SubagentReply {
  childId: string;
  text: string;
}

/** 子域 pending 提问投影（await 面——cr-729：子等回答时 await 直达可见） */
export interface SubagentAsking {
  childId: string;
  interactionId: string;
  questions: Array<{ question: string; options: string[]; multi?: true }>;
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
  private childMeta = new Map<string, { name?: string; busy: boolean; exited: boolean; exit?: { code: number | null; signal: string | null; aborted: boolean } }>();

  constructor(ctx: Context, options: SubagentRowOptions) {
    super(ctx, 'subagents');
    this.dataRoot = options.dataRoot;
    this.agentId = options.agentId;
    this.bootFile = options.bootFile;
    this.catalogFile = options.catalogFile;
    this.spawnShell = options.spawnShell ?? defaultSpawnShell;
    this.postOfficeAddress = options.postOfficeAddress;
    this.registerTool();
    // 提问 watch 面随服务卸载回收（注册即归属——cordis effect 代管）
    this.ctx.effect(() => () => {
      for (const handle of [...this.askWatchers.values()]) handle.close();
      this.askWatchers.clear();
    });
    // boot 对账（cr-731）——conversation 行可能在 subagent 行之后装配（行序
    // 依赖），有界重试直到会话面可用（cr-733；execute 首调仍是最后兜底）。
    this.ensureReconciled();
  }

  /** 生存盘点：用于收件侧识别「本壳子 Agent」——**含已退出者**（句柄 ∪
   * 磁盘物化清单），回信不得降级成同名顶层端点（见父壳 conversation
   * postReply 的子 Agent 直投面，cr-710）。 */
  ownsChild(childId: string): boolean {
    return this.children.has(childId) || listChildIds(this.dataRoot, this.agentId).includes(childId);
  }

  /** 子 Agent 回信直投（cr-862 盘面会合）：在管句柄走既有 ipc 连接；
   * 句柄面空（父壳换代）走 deliver()——活锁直投，锁缺席/陈锁落子域 inbox
   *（信等人，不拉起——cr-710 防幽灵语义：回信面不做 owner 重拉）。
   * 都不可达 = false（调用方丢弃，不走邮局，防宿主按裸子 id 拉起同 id
   * 的幽灵顶层身份）。 */
  async deliverToChild(childId: string, env: Envelope): Promise<boolean> {
    const proc = this.children.get(childId);
    if (proc !== undefined) {
      try { await proc.deliver(env); } catch { return false; }
      this.markSettled(childId); // 父回信 = 子壳上一轮已终稿（忙态随帧回落）
      return true;
    }
    const out = await deliver(this.childPaths, env);
    if (out.channel !== 'direct') return false; // 离线信封已落子域 inbox（信等人）——回信直投面不拉起（cr-710 防幽灵语义）
    this.markSettled(childId);
    return true;
  }

  /** 子域目录（物化域单源——boot 影子形态同款路径代数） */
  private childDirOf(childId: string): string {
    return path.join(this.dataRoot, 'agents', this.agentId, 'children', childId);
  }

  /** 会合寻址面（盘面会合 §一）：children 域路径代数——锁在物化域根，
   *  inbox 落 sessions/<parent~child>/（对桶目录，与子壳账本同址域）。 */
  private get childPaths(): RendezvousPaths {
    return {
      agentDirOf: (childId) => this.childDirOf(childId),
      sessionDirOf: (childId) => path.join(this.childDirOf(childId), 'sessions', this.agentId + '~' + childId),
    };
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
      displayStatus: meta?.busy === true ? 'running' : (meta?.exit?.aborted === true ? 'error' : (meta?.exited === true ? 'stopped' : (runs > 0 ? 'done' : 'idle'))),
      task,
      runs,
      createdAt,
      updatedAt,
      deleted: false,
    };
  }

  /** 在场查询（cr-712：retired SubagentsService.get 面——collab send_agent
   * 的发信身份归一 / sub_ 分支消费）：物化域内即有投影（含已退出者）。 */
  get(childId: string): SubagentChangeInfo | undefined {
    return this.ownsChild(childId) ? this.infoOf(childId) : undefined;
  }

  /** 主线消费面适配（cr-712：collab send_agent 的 sub_ 分支——retired
   * SubagentsService.send 同形）：sendOp 薄包装。conversationId 即完成
   * 回执的发起会话键（cr-711）；elevation 两档白名单窄化后随任务信封下发
   *（提权继承，cr-728）。delivered 词形：fresh → 'started'，
   * 重投 → 'deduped'（任务信封 requestId 每发新铸，常态恒 started）。
   * 归档子拒绝（cr-856：ownsChild 对归档者维持 true 是迟到回信防线，
   * 非任务受理面）。 */
  async send(id: string, opts: { parentId: string; text: string; mode?: string; conversationId?: string; elevation?: string }): Promise<{ delivered: string; info: SubagentChangeInfo }> {
    if (!this.ownsChild(id) || childIsArchived(this.dataRoot, this.agentId, id)) throw new Error('子 Agent 不在管理面：' + id);
    const mode = opts.mode === 'steer' || opts.mode === 'next-run' || opts.mode === 'sync' ? opts.mode : 'async';
    const elevation = opts.elevation === 'sandbox-access' || opts.elevation === 'full-access' ? opts.elevation : undefined;
    const out = await this.sendOp(id, opts.text, mode, 0, opts.conversationId, undefined, elevation);
    return { delivered: out.delivered ? 'started' : 'deduped', info: this.infoOf(id) };
  }

  /** 物化 + 拉起（R-5：物化即快照——父此后改配置不传播）。
   * replyConversation = 发起本次任务的会话键（工具调用所在的 user⇄agent
   * 会话）：随任务信封带给子壳，子壳终稿回信原样带回——父壳据此把完成
   * 回执投回发起会话（而不是唤醒父⇄子对桶再跑一轮，cr-711）。sync/带
   * waitMs 的调用不设——结果由工具返回值直接交付，无需二次唤醒。 */
  async spawnOp(input: {
    name?: string; system?: string; task: string;
    tools?: string[]; waitMs?: number; replyConversation?: string; signal?: AbortSignal; elevation?: 'sandbox-access' | 'full-access';
  }): Promise<{ childId: string; reply?: SubagentReply; filtered?: string[] }> {
    const childId = this.newChildId();
    const parent = readAgentConfig(this.dataRoot, this.agentId);
    if (parent === null) throw new Error('父 agent 配置缺席：' + this.agentId);
    const catalog = readCatalog(this.catalogFile);
    const parentRowset = deriveShellRowset({ rows: parent.rows }, catalog);
    // spawn ⊆ 授权投影：过滤词表单源（inherit.ts——cr-616/762/763 判据收拢）
    let tools: string[] | undefined;
    let filtered: string[] | undefined;
    if (input.tools !== undefined) {
      const { granted, rejected } = filterSpawnTools(input.tools, new Set(parentRowset.rowIds), catalog);
      tools = granted;
      if (rejected.length > 0) filtered = rejected;
    }
    // 会话设置继承面（cr-753 单源化）：ctx 解析在服务层，映射判据在 inherit.ts
    const convSettings = this.ctx.get('convSettings', false) as
      | { get(id: string): Record<string, string> }
      | undefined;
    const convOf = input.replyConversation !== undefined && convSettings !== undefined
      ? convSettings.get(input.replyConversation)
      : {};
    const inheritTags = convInheritTagsOf(convOf, input.elevation);
    // cr-758 工作区锚点继承：发起会话挂载工作区时（singles「挂载即基准」），
    // 子会话键 parent~sub-x 是新对桶——singles 无记录，锚点结构上到不了
    // 子壳（相对路径/bash cwd/提示词 [工作目录] 回落 files/<sub-id>）。快照
    // 进子 config settings.security.workdir：物化即快照（R-5 同构），经
    // WorkspaceShim 沙箱基准的显式 workdir 层（主线 ac-workspace 同序）
    // 全消费面闭环。workspace 能力缺席/未挂载 = 不写（子保持专用空间）。
    const workspace = this.ctx.get('workspace', false) as
      | { conversationWorkspaceRoot?(cid?: string): string | null | undefined }
      | undefined;
    const anchor = workspace?.conversationWorkspaceRoot?.(input.replyConversation);
    // 模型继承（cr-759）：生效模型覆盖 = 同一份 conv-settings 读取
    const modelOverride = typeof convOf.model === 'string' && convOf.model !== '' ? convOf.model : undefined;
    // 子 config 快照单源（inherit.ts——六处内联拼装收拢，cr-856）
    const childConfig = spawnChildConfigOf({
      parent,
      ...(tools !== undefined ? { tools } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.system !== undefined ? { system: input.system } : {}),
      inheritTags,
      ...(typeof anchor === 'string' && anchor !== '' ? { workdirAnchor: anchor } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
    }, catalog);
    materializeChild(this.dataRoot, this.agentId, childId, childConfig);
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
    // 发起会话键物化（cr-731）：重启后提问通知的注入目标从盘恢复——
    // convOf 是内存态，父壳换代即蒸发。
    if (input.replyConversation !== undefined) {
      const cfgFile = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId, 'config.json');
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8')) as Record<string, unknown>;
        cfg.originConversation = input.replyConversation;
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      } catch { /* 物化失败——盘读面自然缺席，注入回落 convOf */ }
    }
    this.spawnProcess(childId, input.name); // 拉起单源（cr-862——与 owner 重拉同构）
    this.notify(childId, 'spawned');
    if (input.replyConversation !== undefined) this.convOf.set(childId, input.replyConversation);
    if (input.task === '') return { childId, ...(filtered !== undefined ? { filtered } : {}) };
    const waitMs = input.waitMs ?? 0;
    const out = await this.sendOp(childId, input.task, waitMs > 0 ? 'sync' : 'async', waitMs, input.replyConversation, input.signal, input.elevation);
    return { childId, ...(out.reply !== undefined ? { reply: out.reply } : {}), ...(filtered !== undefined ? { filtered } : {}) };
  }

  /** 任务信封（budget = 2：子 run 一次 + 回信线余量；replyConversation
   * 随 payload 往返——子壳 postReply 原样回带，父壳据此把完成回执投回
   * 发起会话，cr-711；elevation = 提权继承——父的随信临时提权随任务信封
   * 下发，子壳 receiveEnvelope → loop 既有链路生效，cr-728） */
  private taskEnvelope(childId: string, text: string, replyConversation?: string, elevation?: 'sandbox-access' | 'full-access'): Envelope {
    return makeEnvelope({
      uuid: this.agentId + '~' + childId,
      requestId: 'sub-' + crypto.randomUUID(),
      sender: this.agentId,
      to: childId,
      kind: 'message',
      budget: 2,
      payload: { text, ...(replyConversation !== undefined ? { replyConversation } : {}) },
      ...(elevation !== undefined ? { elevation } : {}),
    });
  }

  /**
   * 投递消息。mode 的父侧语义：sync = 阻塞等新终稿；async/steer/next-run
   * = 立返（steer/next-run 的实际投递去向由子壳 conversation 状态机决策
   * ——busy 自动的 steer，空闲即 run；本面不做二次裁决）。
   * replyConversation 只挂在「完成后需要唤醒发起会话」的异步任务上：
   * sync / waitMs 由返回值交付结果，不再重复通知（否则同轮双份）。
   *
   * 投递换轨（cr-862 盘面会合）：任务信封恒走 deliver() 双层会合——活体
   * 直投（在管句柄 = 常态；换代后按物化域活锁）失败或无锁 = 落子域 inbox
   *（信等人）+ owner 重拉子壳（父 owns 子——对齐「宿主 owns agent」；
   * 重拉壳 boot 的 recoverPendingInbox 自动消费落盘信，续会话不丢上下文）。
   */
  async sendOp(
    childId: string, message: string, mode: 'async' | 'sync' | 'steer' | 'next-run', waitMs = 0,
    replyConversation?: string, signal?: AbortSignal, elevation?: 'sandbox-access' | 'full-access',
  ): Promise<{ delivered: boolean; reply?: SubagentReply }> {
    if (!this.ownsChild(childId) || childIsArchived(this.dataRoot, this.agentId, childId)) {
      throw new Error('子 Agent 不在管理面：' + childId + '（list 查询在场清单）');
    }
    const baseline = this.settledCount(childId);
    const meta = this.childMeta.get(childId);
    const proc = meta?.exited === true ? undefined : this.children.get(childId);
    const syncWait = mode === 'sync' || waitMs > 0;
    const envelope = this.taskEnvelope(childId, message, syncWait ? undefined : replyConversation, elevation);
    const deliverP = (async (): Promise<DeliverResult> => {
      if (proc !== undefined) {
        try { return { channel: 'direct', fresh: (await proc.deliver(envelope)).fresh }; }
        catch { /* 死链（boot.ready 超时/连接断）——降级盘面会合 */ }
      }
      return deliver(this.childPaths, envelope);
    })();
    if (meta !== undefined) meta.busy = true;
    this.notify(childId, 'started');
    const ack = await deliverP;
    if (ack.channel === 'inbox') this.reviveChild(childId); // 落盘即送达——owner 拉起子壳消费（cr-862）
    if (syncWait) {
      const reply = await this.awaitReply(childId, waitMs > 0 ? waitMs : 60_000, baseline, signal);
      this.markSettled(childId);
      return { delivered: true, ...(reply !== null ? { reply } : {}) };
    }
    return { delivered: true };
  }

  /**
   * owner 重拉（cr-862）：deliver 落 inbox = 子壳不在跑（无锁/陈锁）。父是
   * 子的生命周期 owner——按物化域 respawn 子进程（不重物化：config/auth
   * 在盘，续会话不丢上下文）；与 spawnOp 的拉起段同构（句柄/meta/watch/
   * onExit 全套）。单飞次序（重拉 → 消费 inbox → 终稿回信）由子壳 boot 链
   * 自治——本面 fire-and-forget，sync 等待面照常轮询终稿。
   */
  private reviveChild(childId: string): void {
    const meta = this.childMeta.get(childId);
    // 守卫判活句柄（非句柄存在）：崩溃子的死句柄仍在 children map——须让位重拉，
    // 否则 inbox 落盘信无人消费（守卫误判「在管」）。活句柄在场 = 直投刚失败的
    // 竞态窗，不双拉。
    if (meta?.exited !== true && this.children.has(childId)) return;
    this.children.delete(childId); // 死句柄出管
    if (meta !== undefined) { meta.exited = false; meta.exit = undefined; meta.busy = true; }
    this.spawnProcess(childId, meta?.name);
    this.notify(childId, 'started');
  }

  /** 子壳进程拉起单源（spawnOp 首拉 / reviveChild 重拉同构）——句柄/meta/
   *  提问 watch/退出钩子全套接线。 */
  private spawnProcess(childId: string, name?: string): ShellProcess {
    const proc = this.spawnShell({
      dataRoot: this.dataRoot, parentId: this.agentId, childId,
      bootFile: this.bootFile, catalogFile: this.catalogFile,
      mockProvider: true,
      ...(this.postOfficeAddress !== undefined ? { postOffice: this.postOfficeAddress } : {}),
    });
    this.children.set(childId, proc);
    if (!this.childMeta.has(childId)) this.childMeta.set(childId, { name, busy: false, exited: false });
    this.watchAsksOf(childId);
    proc.onExit((code, signal) => {
      const m = this.childMeta.get(childId);
      const aborted = m?.busy === true;
      if (m !== undefined) { m.exited = true; m.busy = false; m.exit = { code, signal, aborted }; }
      this.closeAskWatch(childId);
      this.notify(childId, 'settled');
    });
    return proc;
  }

  /**
   * 子壳一轮收束（终稿出现 / 父回信直投——回信只发生在终稿之后）：忙态回落
   * + settled 帧。此前只有 sync/stop/exit 清忙，async spawn 置忙后永不回落——
   * 子 Agent 看板常亮 running（会话「看起来不结束」，cr-710）。
   */
  private markSettled(childId: string): void {
    const meta = this.childMeta.get(childId);
    if (meta === undefined || meta.busy !== true) return;
    meta.busy = false;
    this.notify(childId, 'settled');
  }

  /** 等新终稿（baseline = 投递时的终稿数；超时 = null）。不在场 = 抛错
   *（fail-loud——同主线 await 对未知 id 的早期校验语义；换代后句柄面空
   * 但物化域仍在管，cr-856 放宽 ownsChild——盘读面照常可用）。
   * 无终稿但子域有 pending 提问（cr-729）→ 返回 asking 载荷——子的
   * ask_questions 挂起对父此前不可见（父永轮 pending、子永等回答）。 */
  async awaitOp(childId: string, timeoutMs: number, signal?: AbortSignal): Promise<SubagentReply | SubagentAsking | null> {
    if (!this.ownsChild(childId)) {
      throw new Error('子 Agent 不在管理面：' + childId + '（list 查询在场清单）');
    }
    const reply = await this.awaitReply(childId, timeoutMs, this.settledCount(childId), signal);
    if (reply !== null) { this.markSettled(childId); return reply; }
    // 等待落空（超时/中止）——子仍在等回答时优先回报 asking（比 pending 有信息量；
    // 终稿已在前一行优先返回，两态不冲突）
    return this.pendingAskOf(childId);
  }

  /** 子域 pending 提问投影（盘读 children/<id>/interactions.jsonl——子进程
   * 持有自己的交互 store，父侧只读可见性；作答走 answerOp 控制帧）。 */
  private pendingAskOf(childId: string): SubagentAsking | null {
    const file = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId, 'interactions.jsonl');
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    // last-wins per id：reply 追加 answered 行后同 id 的旧 pending 行不得再命中
    const byId = new Map<string, { kind?: unknown; state?: unknown; payload?: { questions?: unknown } | null }>();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const r = JSON.parse(line) as { kind?: unknown; state?: unknown; id?: unknown; payload?: { questions?: unknown } | null };
        if (typeof r.id === 'string') byId.set(r.id, r);
      } catch { /* 撕裂行跳过 */ }
    }
    let pending: { id?: unknown; payload?: { questions?: unknown } | null } | undefined;
    for (const [id, r] of byId) {
      if (r.kind === 'ask_questions' && r.state === 'pending') pending = { id, payload: r.payload };
    }
    if (pending === undefined || typeof pending.id !== 'string') return null;
    const rawQs = pending.payload?.questions;
    const questions = Array.isArray(rawQs)
      ? rawQs.map((q) => {
        const item = (q ?? {}) as { question?: unknown; options?: unknown; multi?: unknown };
        return {
          question: typeof item.question === 'string' ? item.question : '',
          options: Array.isArray(item.options) ? item.options.map((o) => String(o)) : [],
          ...(item.multi === true ? { multi: true as const } : {}),
        };
      })
      : [];
    return { childId, interactionId: pending.id, questions };
  }

  /** 代答子 Agent 的 pending 提问（cr-729）：在管子壳走 stdin 控制帧
   * interaction-reply admin op——子侧 durableInteraction.reply → replied
   * 事件 → 三态注入（忙步 steer / idle 挂起半边 / late-reply）全在子进程
   * 内闭环，父零感知恢复语义。换管外子（cr-862）：deliver() 双层会合直投
   * interactionReply 标记信封（收信面转 store.reply 同链）。落 inbox =
   * 挂起方（子进程）已死、代答无消费面——fail-loud（对齐 cr-736 文案面）。 */
  async answerOp(childId: string, answers: Array<string | string[] | null>, interactionId?: string): Promise<{ interactionId: string; status: string }> {
    const asking = this.pendingAskOf(childId);
    const id = interactionId !== undefined && interactionId !== '' ? interactionId : asking?.interactionId;
    if (id === undefined) throw new Error('子 Agent 无待答提问（answer 前可 await 查看 asking 状态）');
    const proc = this.children.get(childId);
    if (proc === undefined) {
      if (readActivationLock(this.childDirOf(childId)) === null) {
        throw new Error('子 Agent 不在管理面且无活锁（' + childId + '）——父壳换代后子未拉起：先 spawn 新子或 delete 收割');
      }
      const out = await deliver(this.childPaths, makeEnvelope({
        uuid: this.agentId + '~' + childId,
        requestId: 'sub-answer-' + crypto.randomUUID(),
        sender: this.agentId,
        to: childId,
        kind: 'message',
        budget: 0,
        payload: { interactionReply: { id, answer: { answers } } },
      }));
      if (out.channel !== 'direct') {
        throw new Error('子 Agent 活锁不可达（' + childId + '）——陈锁：先 spawn 新子或 delete 收割');
      }
      return { interactionId: id, status: 'answered' };
    }
    const out = await proc.control({
      ctrl: 'admin', agentId: childId, op: 'interaction-reply', id,
      answer: { answers },
    }) as { status?: unknown } | null;
    return { interactionId: id, status: typeof out?.status === 'string' ? out.status : 'answered' };
  }

  // —— 子域提问推送（cr-730）：watch 发现新 pending ask → 注入父会话 ——

  /** 已通知的交互 id（防重投——watch 事件对同一 ask 可能多次触发） */
  private askNotified = new Set<string>();
  /** 子域 watch 面childId → handle */
  private askWatchers = new Map<string, { close(): void }>();
  /** childId → 发起会话键（注入目标——execute 各 action 顺手记录） */
  private convOf = new Map<string, string>();
  /** 发起会话键盘读缓存（只缓存命中——缺席可被懒回填后补） */
  private originCache = new Map<string, string>();
  /** boot 对账是否已成功跑过一次（conversation 缺席时首调重试） */
  private reconciled = false;
  /** 对账重试链在场标记（防 execute 兜底与 boot 链叠加） */
  private reconcileChain = false;

  /**
   * 子域提问通知单源（cr-863）：盘 watch / childAsk 信封 / boot 对账三
   * 通道汇入——askNotified 幂等门 → emit subagents/ask → 注入发起会话
   * （steer 忙步 / deliver 空闲唤醒）。childAsk 信封（子壳 opened 事件
   * 推送）断父壳换代后 watch 面蒸发窗（recovery-matrix S2）：事件比盘
   * watch 快（opened 落盘即发 vs fs.watch 防抖 200ms），两通道同门不双发。
   */
  notifyChildAsk(childId: string, interactionId: string): void {
    // 盘校验（cr-863）：childAsk 信封可能滞留 inbox 跨代重放——盘上非当前
    // pending（已答/关闭/陈代提问）不通知；watch 通道同源恒过。提问载荷
    // 以盘读为准（pendingAskOf 单源），信封不携带正文格式化职责。
    const asking = this.pendingAskOf(childId);
    if (asking === null || asking.interactionId !== interactionId) return;
    if (this.askNotified.has(interactionId)) return;
    this.askNotified.add(interactionId);
    this.ctx.emit('subagents/ask', asking);
    this.injectAskNotice(childId, asking);
  }

  /** 开启子域提问 watch（目录 watch——interactions.jsonl 首建与追加都触发；
   * 防抖对齐 ac-webui-core watchLedger 同款形态）。幂等。 */
  private watchAsksOf(childId: string): void {
    if (this.askWatchers.has(childId)) return;
    const dir = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId);
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, () => {
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          const asking = this.pendingAskOf(childId);
          if (asking === null) return;
          this.notifyChildAsk(childId, asking.interactionId);
        }, 200);
      });
    } catch { /* 目录缺席（未物化即退出）——无 watch 面 */ return; }
    watcher.on('error', () => { watcher.close(); this.askWatchers.delete(childId); });
    this.askWatchers.set(childId, {
      close: () => { if (timer !== null) clearTimeout(timer); watcher.close(); this.askWatchers.delete(childId); },
    });
  }

  private closeAskWatch(childId: string): void {
    this.askWatchers.get(childId)?.close();
  }

  /** 发起会话键记录（cr-738）：内存 convOf + 懒回填 config——存量子（spawn
   * 时无键路径产生）在后续任一 action 触达时补键，origin 覆盖率逐步收敛。 */
  private noteOrigin(childId: string, conversationId: string): void {
    this.convOf.set(childId, conversationId);
    if (this.originCache.get(childId) === conversationId) return;
    const cfgFile = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId, 'config.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8')) as { originConversation?: unknown };
      if (typeof cfg.originConversation === 'string' && cfg.originConversation !== '') {
        this.originCache.set(childId, cfg.originConversation);
        return;
      }
      cfg.originConversation = conversationId;
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      this.originCache.set(childId, conversationId);
    } catch { /* 盘面缺席（未物化/损坏）——内存键仍生效 */ }
  }

  /** 子域 config.json 的发起会话键（spawn 物化——重启后注入目标盘读恢复）。
   * 回落（cr-732）：originConversation 是 cr-731 新物化字段，此前 spawn 的
   * 历史子缺席——读子域各会话 inbox 任务信封的 payload.replyConversation
   * （cr-711 起随任务信封持久化，历史子全有），零迁移覆盖。 */
  private originConversationOf(childId: string): string | undefined {
    const cached = this.originCache.get(childId);
    if (cached !== undefined) return cached;
    const found = this.readOriginConversation(childId);
    if (found !== undefined) this.originCache.set(childId, found); // 只缓存命中（后续 send 可补键）
    return found;
  }

  private readOriginConversation(childId: string): string | undefined {
    const childDir = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId);
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(childDir, 'config.json'), 'utf-8')) as { originConversation?: unknown };
      if (typeof cfg.originConversation === 'string' && cfg.originConversation !== '') return cfg.originConversation;
    } catch { /* 物化域缺席——走 inbox 回落（同样缺席则 undefined） */ }
    let sessions: fs.Dirent[] = [];
    try { sessions = fs.readdirSync(path.join(childDir, 'sessions'), { withFileTypes: true }); } catch { return undefined; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      let files: fs.Dirent[] = [];
      try { files = fs.readdirSync(path.join(childDir, 'sessions', s.name, 'inbox'), { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile()) continue;
        try {
          const env = JSON.parse(fs.readFileSync(path.join(childDir, 'sessions', s.name, 'inbox', f.name), 'utf-8')) as { payload?: { replyConversation?: unknown } };
          const rc = env.payload?.replyConversation;
          if (typeof rc === 'string' && rc !== '') return rc;
        } catch { /* 撕裂信封跳过 */ }
      }
    }
    return undefined;
  }

  /** 对账重试（cr-733）：conversation 服务可能晚于本行装配——boot 时拿
   * 不到会话面则 500ms 重试（60s 上限）；execute 首调是补充触发。 */
  private ensureReconciled(): void {
    this.reconcilePendingAsks(); // 幂等（askNotified 防重发 + deliver 幂等键）
    if (this.reconciled || this.reconcileChain) return;
    this.reconcileChain = true; // 单链——execute 兜底与 boot 共用，不叠加计时器面
    const t = setInterval(() => {
      if (this.reconciled) { clearInterval(t); this.reconcileChain = false; return; }
      this.reconcilePendingAsks();
    }, 500);
    if (typeof t.unref === 'function') t.unref();
    // 上限：60s 后放弃（execute 首调仍是最后兜底）
    const cap = setTimeout(() => { clearInterval(t); this.reconcileChain = false; }, 60_000);
    if (typeof cap.unref === 'function') cap.unref();
  }

  /** boot/首次调用对账（cr-731）：物化子的 pending ask 补投通知——父壳
   * 重启后 watcher/askNotified/convOf 全蒸发，未答提问不得成死信。deliver
   * 携带幂等键，已投过的自动短路；重启仍未答的提问重投一次是期望语义。 */
  private reconcilePendingAsks(): void {
    const conversation = this.ctx.get('conversation', false);
    for (const childId of listChildIds(this.dataRoot, this.agentId)) {
      if (childIsArchived(this.dataRoot, this.agentId, childId)) continue;
      // S2 断根（recovery-matrix P2，cr-863）：活锁在场且不在管（换代后活子
      // 形态——askWatchers 蒸发，此后子的新提问对父不可见直到再次重启）
      // → watch 重建（watch 只读盘 + emit，不依赖 conversation 就绪；注入
      // 面缺席自然回落对账重试）。死子（无锁）不建——消费面无人，
      // reviveChild 时 spawnProcess 会补建。
      if (this.children.has(childId) === false
        && readActivationLock(this.childDirOf(childId)) !== null) {
        this.watchAsksOf(childId);
      }
      const asking = this.pendingAskOf(childId);
      if (asking === null) continue;
      if (!this.askNotified.has(asking.interactionId)) {
        this.askNotified.add(asking.interactionId);
        this.ctx.emit('subagents/ask', asking);
      }
      // 幂等键去重——已投过的自动短路；steer 优先（cr-736：忙 run 步边界
      // 即时注入，系统通知不进 QueueDock 排队；空闲才 deliver 唤醒）
      if (conversation !== undefined) this.injectAskNotice(childId, asking);
    }
    this.reconciled = conversation !== undefined; // 缺席 = 未投成——execute 首调重试
  }

  /** 通知正文（steer 注入与 deliver 同文——转录形状两路一致，单源防漂移） */
  private askNoticeText(childId: string, asking: SubagentAsking): string {
    const name = this.childMeta.get(childId)?.name ?? childId;
    const qs = asking.questions
      .map((q) => '- ' + q.question + (q.multi ? '（多选）' : '') + ': ' + q.options.map((o, j) => String.fromCharCode(65 + j) + '. ' + o).join('　'))
      .join('\n');
    return '[系统通知] 子 Agent ' + name + '（' + childId + '）发起提问并挂起等待（interaction ' + asking.interactionId + '）：\n'
      + qs + '\n请用 subagent 工具 action=answer 代答（answers 与问题顺序一致）；若认为不该等待，也可明确答复它自行决断。';
  }

  /** 「收到子 Agent 提问」注入父会话：忙 run steer 步边界注入 / 空闲
   * deliver 唤醒新 run——形态对齐 ask-questions 答案注入（同为事件驱动的
   * 上下文到达，cr-730：父不再依赖轮询 await 盘读发现问题）。 */
  private injectAskNotice(childId: string, asking: SubagentAsking): void {
    const conv = this.convOf.get(childId) ?? this.originConversationOf(childId);
    if (conv === undefined) return; // 宿主直调无发起会话——await 面仍可见
    const handle = runAddress(this.agentId, conv);
    const agentLoop = this.ctx.get('agentLoop', false) as
      | { steer(h: string, m: { role: 'user'; content: string }, meta?: { sender?: string; source?: string }): boolean }
      | undefined;
    if (handle !== undefined && agentLoop !== undefined
      && agentLoop.steer(handle, { role: 'user', content: this.askNoticeText(childId, asking) }, { sender: this.agentId, source: 'event' })) return;
    this.deliverAskNotice(childId, asking);
  }

  /** 通知投递（持久幂等面）：requestId = ask-notice-<interactionId>——
   * cr-250 .deliver-seen.json 跨重启去重；重放（boot 对账/投递失败重试）
   * 同键自动短路。 */
  private deliverAskNotice(childId: string, asking: SubagentAsking): void {
    const conv = this.convOf.get(childId) ?? this.originConversationOf(childId);
    if (conv === undefined) return;
    const conversation = this.ctx.get('conversation', false) as
      | { deliver(agentId: string, message: string, options?: Record<string, unknown>): Promise<unknown> }
      | undefined;
    if (conversation === undefined) return; // 会话行未装/未就绪——对账面稍后补投
    void conversation.deliver(this.agentId, this.askNoticeText(childId, asking), {
      sender: this.agentId, source: 'event', conversationId: conv,
      requestId: 'ask-notice-' + asking.interactionId,
    }).catch((err: unknown) => {
      this.ctx.logger.warn('[subagent] 提问通知投递失败（' + asking.interactionId + '）: ' + String(err));
    });
  }

  private sessionDirOf(childId: string): string {
    return path.join(this.dataRoot, 'agents', this.agentId, 'children', childId,
      'sessions', this.agentId + '~' + childId);
  }

  private async awaitReply(childId: string, timeoutMs: number, baseline: number, signal?: AbortSignal): Promise<SubagentReply | null> {
    const dir = this.sessionDirOf(childId);
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    for (;;) {
      const last = this.lastSettled(childId, dir, baseline);
      if (last !== null) return last;
      // 宿主中止（run_code 墙钟耗尽/用户 abort 经 call.signal 下发，cr-727）：
      // 立返 null 让位——worker 停在本子调用 Promise 上够不到中止检查点，
      // 不理会则宽限后 terminate 成「worker 异常退出（code=1）」。
      if (signal?.aborted) return null;
      const exit = this.childMeta.get(childId)?.exit;
      if (exit?.aborted === true) {
        // 子壳带任务硬退出（正常 stop/interrupt 由子壳落收束行，不进此处）：
        // 终稿永不再出现——合成失败回执一次定性，等待方拿到确定结局。
        return { childId, text: '⚠ 子代理进程异常退出（exit code=' + String(exit.code) + ' signal=' + String(exit.signal) + '），任务未完成、无终稿。可 send 重发任务或 delete 收割。' };
      }
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

  /** list 面（在场 + 物化清单——含已退出者，status 区分；归档收割者隐去〔cr-712〕）。
   * conversationId 给定（cr-738）= 会话域过滤：只列该会话派生的子 + 无会话键
   * 条目（宿主直调/早期存量——保守显示防孤儿管理不到）；undefined = 全量。 */
  listOp(conversationId?: string): SubagentEntry[] {
    const ids = new Set<string>([...this.children.keys(), ...listChildIds(this.dataRoot, this.agentId)]);
    const entries: SubagentEntry[] = [...ids].sort().filter((childId) => this.children.has(childId) || !childIsArchived(this.dataRoot, this.agentId, childId)).map((childId): SubagentEntry => {
      const proc = this.children.get(childId);
      const meta = this.childMeta.get(childId);
      const origin = this.originConversationOf(childId);
      return {
        childId,
        ...(meta?.name !== undefined ? { name: meta.name } : {}),
        status: meta?.exited === true || proc === undefined ? 'exited' : 'ready',
        pid: proc?.pid ?? -1,
        busy: meta?.busy ?? false,
        ...(meta?.exit !== undefined ? { exit: meta.exit } : {}),
        ...(origin !== undefined ? { originConversation: origin } : {}),
      };
    });
    return entries.filter((e) => conversationId === undefined
      || e.originConversation === undefined
      || e.originConversation === conversationId);
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

  /** delete：收割（shutdown + 归档标识——cr-712 改物理删除为归档：子域账本
   * 〔任务/思考/终稿〕保留供运行跟踪回放审计，list/看板按 archived.json 隐去。
   * 归档子仍在物化清单（ownsChild 维持 true）——迟到回信直投落空即弃，
   * 不走邮局〔防幽灵顶层身份，cr-710 语义保持〕。） */
  async deleteOp(childId: string): Promise<{ deleted: boolean }> {
    this.closeAskWatch(childId);
    const proc = this.children.get(childId);
    if (proc !== undefined) {
      await proc.shutdown().catch(() => proc.kill());
      this.children.delete(childId);
    }
    const meta = this.childMeta.get(childId);
    if (meta !== undefined) { meta.exited = true; meta.busy = false; }
    const archiveDir = path.join(this.dataRoot, 'agents', this.agentId, 'children', childId);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, ARCHIVED_FILE),
      JSON.stringify({ archivedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf-8',
    );
    // 空工作区顺手回收（cr-754）：子 Agent 的 files/<sub-id> 由垫片懒建，
    // 纯只读任务留下空目录物种——归档收割时 rmdir（仅空目录可删：非空 =
    // 子留有产出文件，保留不动）。
    try {
      fs.rmdirSync(path.join(this.dataRoot, 'files', childId));
    } catch { /* 非空/缺席——保留不动 */ }
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
        + 'spawn 创建并启动首条任务（任务角色定位/专业人设/输出约束 → system 参数）；send 对已创建的子 Agent 续聊（mode：async 立即返回/sync 阻塞等回复/steer 注入进行中的 run/next-run 排队到下一轮）；await 等待并取当前结果；list 查询（含历史）；stop 停止当前推理（保留会话，可继续 send）；delete 删除（收割——停进程并归档：会话账本保留供审计回放，从看板/list 隐去，不可再 send）。'
        + '注意：本工具管理的是你私有的子 Agent 看板，子 Agent 的回复只返回给你——它不能替你向用户或其他 Agent 转达/推送/通知任何内容；要给其他 Agent 或用户发消息用 send_agent，要发群消息用 send_group。'
        + '长输出指引：预期产出长文本（报告/清单/多文件分析等）时，在输出约束里要求子 Agent 把完整产出写入文件（给明确路径），回复只报路径与要点摘要——长回复走回传通道会撞输出体积预算被截断（头尾保留、中段丢失）；需要细节时再 read 该文件（可分页无损读取）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['spawn', 'send', 'await', 'answer', 'list', 'stop', 'delete'], description: '操作' },
          task: { type: 'string', description: '[spawn] 首条任务消息，需完整自包含（子 Agent 看不到你的会话）——把内容完整写进本参数，不要请转交式截断。任务的角色定位/专业人设/输出约束放 system 参数（固化人设，勿混进 task）。长文本产出类任务的输出约束建议写明：完整结果写入指定文件、回复只给路径+要点（长回复会被截断）。省略则仅创建不启动，之后用 send 发首条' },
          name: { type: 'string', description: '[spawn] 子 Agent 名称' },
          tools: { type: 'array', items: { type: 'string' }, description: '[spawn] 子 Agent 可用的工具名清单（须是你有权分派的能力的子集，越权名会被过滤；subagent/run_code 一律拒绝——子 Agent 不能再派子孙/再开编排层）。缺省不传 = 继承你的工具面；传空数组 [] = 纯推理子 Agent' },
          system: { type: 'string', description: '[spawn] 子 Agent 的 system prompt（人设/行为约束）。传入即固化（跨轮/跨重启）并完全接管人格语义——不继承父 Agent 的人设与 persona 配置；缺省 = 继承父' },
          subagent_id: { type: 'string', description: '[send/await/answer/stop/delete] 目标子 Agent ID（spawn 返回的 subagent_id，可 list 查询；勿凭记忆复写）' },
          message: { type: 'string', description: '[send] 给该子 Agent 的消息内容（自包含，或基于该子 Agent 已有进展的追问/补充指示）——不是给其他 Agent 或用户发消息' },
          mode: { type: 'string', enum: ['async', 'sync', 'steer', 'next-run'], description: '[send] 投递语义：async（缺省）立即返回，忙时排队；sync 阻塞到消费本条消息的 run 收束并返回结果；steer 注入当前 run 的下一步（空闲则开新 run）；next-run 排队到当前 run 收束后独立执行（async 忙时同此）' },
          timeout_s: { type: 'number', description: '[await] 等待上限秒数（0 = 缺省立即查询不等待；正值 = 阻塞等待新终稿，超时返回 pending；子 Agent 有 pending 提问时返回 asking + 问题载荷——用 action=answer 代答，否则子会一直等）', minimum: 0 },
          answers: { type: 'array', items: { type: ['string', 'array', 'null'] }, description: '[answer] 对子 Agent pending 提问的逐题回答（与提问顺序一一对应；单选 = 选项文本或 null 跳过，多选 = 文本数组）' },
          wait_time: { type: 'number', description: '[spawn] 正值 = 阻塞等首条任务终稿（秒；超时返回已转后台，结果稍后 await 查询）', minimum: 0 },
          query: { type: 'string', description: '[list] 按 id/名称子串过滤' },
          all: { type: 'boolean', description: '[list] true = 列全部子 Agent（跨会话）；缺省只列当前会话派生的（无会话归属的历史条目也会显示，origin_session 字段标注发起会话）' },
        },
        required: ['action'],
      },
      execute: async (args: Record<string, unknown>, call): Promise<ToolResult> => {
        if (!this.reconciled) this.ensureReconciled(); // boot 时 conversation 行未装——首调兜底
        const childOf = (): string => {
          const id = String(args.subagent_id ?? '');
          if (id === '') throw new Error('缺少 subagent_id（spawn 返回值；list 可查在场清单）');
          if (replyConversation !== undefined) this.noteOrigin(id, replyConversation);
          return id;
        };
        // 发起会话键（工具在哪个会话里执行）：异步完成回执据此投回该会话
        //（不设 = 宿主直调/子 Agent 直跑，无发起会话可回——回执只落子账本）。
        const replyConversation = typeof call.conversationId === 'string' && call.conversationId !== '' ? call.conversationId : undefined;
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
              ...(replyConversation !== undefined ? { replyConversation } : {}),
              ...(call.signal !== undefined ? { signal: call.signal } : {}),
              ...(call.elevation === 'sandbox-access' || call.elevation === 'full-access' ? { elevation: call.elevation } : {}),
            });
            const notes: string[] = [];
            if (out.filtered !== undefined) notes.push('以下 tools 词未命中目录或不属你的行集，已过滤：' + out.filtered.join(', '));
            if (out.reply === undefined) notes.push('已转后台（未带 wait_time / 等待超时）——完成后结果会自动回到本会话；也可用 await/list 主动查询');
            return {
              ok: true,
              output: {
                subagent_id: out.childId,
                status: 'created',
                action: 'spawn',
                ...(notes.length > 0 ? { note: notes.join('；') } : {}),
                ...(out.reply !== undefined ? { result: { text: out.reply.text } } : {}),
              },
            };
          }
          case 'send': {
            const message = String(args.message ?? '');
            if (message.trim() === '') return { ok: false, error: 'send 缺少 message（给子 Agent 的消息内容——给用户/其他 Agent 发消息用 send_agent）' };
            const mode = (args.mode === 'sync' || args.mode === 'steer' || args.mode === 'next-run') ? args.mode : 'async';
            const out = await this.sendOp(childOf(), message, mode, 0, replyConversation, call.signal,
              call.elevation === 'sandbox-access' || call.elevation === 'full-access' ? call.elevation : undefined);
            return {
              ok: true,
              output: {
                action: 'send',
                delivered: out.delivered,
                ...(out.reply !== undefined ? { result: { text: out.reply.text } } : {}),
              },
            };
          }
          case 'await': {
            const timeoutS = Math.max(0, Number(args.timeout_s ?? 0));
            const reply = await this.awaitOp(childOf(), timeoutS * 1000, call.signal);
            if (reply === null) return { ok: true, output: { action: 'await', status: 'pending', note: '尚无新终稿——稍后再查（或 timeout_s > 0 阻塞等待）' } };
            if ('interactionId' in reply && 'questions' in reply) {
              return {
                ok: true,
                output: {
                  action: 'await',
                  status: 'asking',
                  interaction_id: reply.interactionId,
                  questions: reply.questions,
                  note: '子 Agent 已发起提问并挂起等待——用 action=answer 逐题作答（answers 与 questions 顺序一致）；不答它不会继续',
                },
              };
            }
            return { ok: true, output: { action: 'await', status: 'settled', result: { text: reply.text } } };
          }
          case 'answer': {
            if (!Array.isArray(args.answers)) return { ok: false, error: 'answer 缺少 answers（与子 Agent 提问逐题对应的回答数组）' };
            const answers = args.answers.map((a: unknown) =>
              typeof a === 'string' || a === null || (Array.isArray(a) && a.every((x) => typeof x === 'string')) ? a : String(a));
            const out = await this.answerOp(
              childOf(), answers as Array<string | string[] | null>,
              typeof args.interaction_id === 'string' && args.interaction_id !== '' ? args.interaction_id : undefined,
            );
            return { ok: true, output: { action: 'answer', ...out, note: '已作答——子 Agent 将自动继续（忙时步边界注入/挂起中即时续走）；终稿稍后 await 收取' } };
          }
          case 'list': {
            const query = typeof args.query === 'string' ? args.query : '';
            // 会话域过滤（cr-738）：缺省只列当前会话派生的子（+ 无键条目）；all = 全量
            const scope = args.all === true || typeof call.conversationId !== 'string' || call.conversationId === ''
              ? undefined
              : call.conversationId;
            const entries = this.listOp(scope).filter((e) => query === '' || e.childId.includes(query) || (e.name ?? '').includes(query));
            // LLM 面词形 snake_case（同 subagent_id）；origin 缺席不携带
            const agents = entries.map((e) => ({
              childId: e.childId,
              ...(e.name !== undefined ? { name: e.name } : {}),
              status: e.status,
              pid: e.pid,
              busy: e.busy,
              ...(e.exit !== undefined ? { exit: e.exit } : {}),
              ...(e.originConversation !== undefined ? { origin_session: e.originConversation } : {}),
            }));
            return { ok: true, output: { action: 'list', agents, total: entries.length } };
          }
          case 'stop': {
            const out = await this.stopOp(childOf());
            return { ok: true, output: { action: 'stop', stopped: out.stopped, note: out.stopped ? '已请求中止当前 run（收束 interrupted，实体保留）' : '无活跃 run（或子壳已退出）' } };
          }
          case 'delete': {
            const out = await this.deleteOp(childOf());
            return { ok: true, output: { action: 'delete', deleted: out.deleted } };
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
  const p = path.join(path.resolve(fileURLToPath(new URL('../../../', import.meta.url))), 'bin', 'AgentChat.exe');
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
  // windowsHide（cr-724）：Windows 上 GUI 宿主 spawn 控制台映像会弹独立命令行
  // 窗——用户随手关窗即杀子代理且无任何回执；仓库其余 spawn 点均已带，此处补齐。
  // detached（cr-856，对齐 cr-642 orchestrate）：父壳退出（restart_shell/崩溃）
  // 时不被 Windows Job 对象/控制台组连带杀灭——R-5「owner 失活子存活」不再
  // 靠运气；stdio 仍 pipe（ipc/控制帧监护面照常），壳退出自然断链。
  const child = childSpawn(AGENTCHAT_EXE, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, detached: true });
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
