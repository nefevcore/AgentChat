// ============================================================
// ac-subagent/src/service.ts —— 子 Agent 服务（cordis Service）
//
// 多轮会话模型（2026-10 重构：一次性委派 → 持久多轮实体）：
//   · 子 Agent = 持久实体（注册表落盘 + 会话消息落盘），跨重启可续聊；
//     spawn 创建（可带首条任务消息并启动 run），send 多轮续聊，
//     await 收结果，list 查询（含历史），stop 停推理（保留实体），
//     delete 打墓碑（list 不可见；会话文件保留）。
//   · run 编排：每 run = ctx.agentLoop.run 直连，身份 agent=<subId>
//     （派生注册身份：spawn/触达时 ctx.agents.register 派生条目）——
//       - steer 地址 = subId（runAddress：conversationId 缺省 → 地址即
//         agent）→ send(mode=steer) 经 ctx.agentLoop.steer 注入活跃 run；
//       - 身份合成 = 父身份编辑：preset:true（名册/协作/管理面不可见、
//         工作区根口径——与未注册时代零漂移）+ tags = 父 tags 剥
//         delegation（防递归 spawn）与 admin（防 system_restart 等宿主级
//         动作）：工具可见面与执行门禁同源收敛，不再依赖"未注册
//         fail-closed"（档位继承下 full 父的子 Agent 此前能看到全部
//         已注册工具）；
//       - 信封装配（subagent 直连 loop 不经 router）：system 优先
//         rec.system（spawn 显式固化——人格防污染，2026-12），缺省每 run
//         现读父人设；llmParams 每 run 现读父配置（热更生效）、tools 按
//         派生身份能力集终滤（点名也不可越过门禁）；settings 浅拷贝随父
//         （快照，显式 system 时剥 persona）——零会话污染语义保留：父
//         会话与 ac-session 不受任何影响。
//   · 上下文：会话消息 = user/assistant 对（首条裸文本 + 逐轮追加——
//     frameTask 已退役 2026-12，角色语义由 spawn system 参数承担）；
//     agent 行携带 steps 时按 expandSteps 轨迹展开复放（与主会话
//     replayTrajectory 同口径——探查型/中断 run 无终文本也不失忆）。
//   · 每 run 登记 job（kind=subagent；owner=父；完成通知回投发起会话）。
//
// 落盘（owning：本服务；三文件形态对齐 ac-session 2026-11 run journal
// 裁决——skill-injection-and-storage-vocab §10/§11 同款语义）：
//   <root>/subagents/index.json          注册表（原子写；含墓碑条目）
//   <root>/subagents/<subId>/
//     messages.jsonl  定稿流（run 期间静默——单一写面）：user 行（任务
//       消息/steer 注入提升，agent_id=父）+ agent 段行（steps，run 键）
//       + context error 行 + run-settled 判别行。全行 run 键（收束对账）。
//     partials.jsonl   run journal（瞬态台账，收束即清）：journal-step
//       步行（result:null，行序=模型消息数组实际序）/ journal-inject
//       注入行（steer 消费点落，ts 快照）/ tool-result 直调补行（终值
//       覆盖源）。崩溃窗口由 recoverJournal 惰性幂等收口。
//     subcalls.jsonl   run_code 子调用永久档案（UI 回放面，不清理——
//       与 journal 生命周期相反）。
//   迁移 v3：<subId>.jsonl 单文件 → <subId>/messages.jsonl（读侧回退兼容）。
//   旧行 {role:'assistant', content, ts} 宽容读取（回放/展示两读侧兼容）。
//   root = 行配置 root ?? AGENTCHAT_DATA_ROOT；未设 = 纯内存（测试兼容）。
//   启动装载：注册表 running → idle（run 随宿主死亡，崩溃恢复）；消息
//   懒装载（list 不读消息，send/await 触达时才读；journal 恢复同点触发）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopStepRecord } from 'ac-agent-loop';
import type { ToolResult } from 'ac-tools';
import type { JobOutcome } from 'ac-jobs';
import { splitModelRef } from 'ac-llm';
import { defaultPoolConnection } from 'ac-llm-pool';
import { expandSteps } from 'ac-session';
import {
  capabilitySetOf,
  effectiveTierOf,
  effectiveToolMode,
  filterLlmParams,
  narrowToolsByMode,
  toolAllowedFor,
  type AgentConfig,
} from 'ac-agents';

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
  timeoutMs: number;
  lastRun?: SubagentRunSummary;
  /**
   * 沙箱基准快照（2026-12 数据根一致修复）：spawn 时父会话挂载的工作区根
   * （无会话工作区 = 缺省）。子 Agent run 无会话键（账本归 subagents 域），
   * 沙箱链 fallback preset→数据根——快照进派生身份 settings.security.workdir
   * 后，工具基准/security 复检/提示词展示与父会话同根。持久化（跨重启仍生效）。
   */
  workdir?: string;
  /**
   * 显式 system prompt（2026-12 人格防污染裁决）：spawn 传入即固化（跨
   * run/跨重启）——executeRun 装配优先于父人设；同时派生身份的 persona
   * settings 清空（显式人设 = 完全接管人格语义，不与父的 persona 块叠加）。
   * 缺省 = 继承 parent.system（与 tags/settings 继承同族）。
   */
  system?: string;
}

/** list/get 投影 */
export interface SubagentInfo {
  id: string;
  parentId: string;
  name: string;
  status: SubagentStatus;
  /** 徽章口径：running | lastRun.status | idle（deleted=true 时消费方应展示「已删除」） */
  displayStatus: string;
  task: string;
  runs: number;
  createdAt: number;
  updatedAt: number;
  /** 墓碑标记（list includeDeleted 时可见——会话文件保留、history 可读） */
  deleted: boolean;
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
  /** 显式 system prompt（固化进 SubagentRecord——覆盖父人设，见 record.system 注释） */
  system?: string;
  toolNames?: string[];
  /** 每轮 run 超时毫秒（0 = 不设看门狗；缺省 0 = 不限——研究型任务常为长任务） */
  timeoutMs?: number;
  /** 发起会话键（job 完成通知回投目标） */
  conversationId?: string;
  /** 发起 run 的档位（§7.3 子 Agent 继承用：effectiveTierOf(parent, elevation)） */
  elevation?: 'sandbox-access' | 'full-access';
}

export interface SubagentSendOptions {
  /** job owner（发起方 Agent id） */
  parentId: string;
  text: string;
  mode?: SubagentSendMode;
  /** 发起会话键 */
  conversationId?: string;
  /** 发起 run 的档位（§7.3 子 Agent 继承用） */
  elevation?: 'sandbox-access' | 'full-access';
}

export interface SubagentListOptions {
  /** id/名称/任务子串过滤 */
  query?: string;
  /** 只列指定父名下的子 Agent（缺省 = 全部） */
  parentId?: string;
  runningOnly?: boolean;
  /** 含墓碑条目（缺省隐藏——展示面用它保留已删除历史入口；会话文件可读） */
  includeDeleted?: boolean;
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
  conversationId?: string;
  /** 发起 run 的档位（父 run 的 call.elevation 留痕——子 run 继承用；§7.3） */
  elevation?: 'sandbox-access' | 'full-access';
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
  /** 活跃 run 簿记（三文件化 2026-12）：journal 门控 + 步行补行路由锚。
   * 单 run 串行（runLoop consuming 门）→ 同 entry 至多一个活跃 run。 */
  activeRun?: {
    /** run 关联键（段行/补行/journal 行同键成组） */
    run: string;
    /** 本 run 已落 journal 行（步行/注入/补行任一）——settlement 分流依据 */
    journaled: boolean;
    /** steer 注入缓冲（消息对象 → ts 快照）：step-started 消费点对账 */
    stashed: Map<object, number>;
    /** journal 行序号（partials.jsonl 内单调，进程内分配） */
    seq: number;
    /** 直调补行内存台账（盘上落行后 push——readJournal 兜底源；subcall
     * 路由记忆在行本体 subcall:true 键上，不需要旁挂 kind） */
    pendingSups: Array<{ line: string; identity: string }>;
  };
}

interface RegistryFile {
  version: 1;
  subs: SubagentRecord[];
}

/**
 * 会话消息行（messages.jsonl 落盘形；subagent-session-view-plan.md R1 +
 * 三文件化 2026-12）：SessionRecord 中性格式兼容——agent 段行携带
 * steps[]，前端 toHistoryMessages 整链复用（工具卡/思维链/步级时序）。
 * 旧行 {role:'assistant', content, ts:number} 共存：两读侧宽容归一。
 */
export interface SubagentMessageLine {
  /** 新行：user（任务消息）/ agent（子回复）/ context（error 收束行）；旧行 assistant 读侧归一为 agent */
  role: 'user' | 'agent' | 'assistant' | 'context';
  /** user 行/agent 段行正文；context error 行 = 错误文本；段行可空串 */
  content: string;
  /** epoch ms（旧行字段；新行仍写——展示投影缺 timestamp 时兜底换算） */
  ts?: number;
  message_id?: string;
  /** ISO 时间串（toHistoryMessages 直读） */
  timestamp?: string;
  /** user 行 = parentId（任务发送方）；agent 行 = subId（说话人） */
  agent_id?: string;
  /** agent 行末步思维链（无 steps 时的折叠栏兜底） */
  reasoning?: string;
  /** 错误收束行（run 键在场）：role='context' + source='error' + content=错误文本 */
  source?: 'error';
  /** steer 提升行：true = 注入消息（消费点真序还原的时序标记） */
  injected?: boolean;
  /** run 键（三文件化 2026-12）：段行/注入提升行/错误行携带 = 产生于该 run
   * 周期；recoverJournal 的 settled 判定锚（同 run 非 partial 行存在性）。
   * 旧单文件行无此键（回退兼容路径照常读）。 */
  run?: string;
  /** 活投影行（展示口径专用，historyRecords 的 journal 活投影产物）：true =
   * run 进行中从 partials.jsonl 台账投影的临时行——settlement 提升后由定稿
   * 段行取代。不落盘；上下文回放（ensureMessages）不读 partial 行。 */
  partial?: boolean;
  /** agent 行：全量步记录（LoopStepRecord → SessionStepRecord 投影） */
  steps?: Array<{
    content: string;
    reasoning?: string;
    textBeforeTools?: boolean;
    reasoningMs?: number;
    ts?: number;
    toolCalls?: Array<{
      id: string;
      name: string;
      /** 参数原始 JSON 字符串（前端按需 parse 展示） */
      arguments: string;
      /** 工具体返回的 ToolResult（对象原样 JSON 往返；收束时终值全在） */
      result: unknown;
      /** run_code 子调用标记（subcalls 投影注入的条目）：平铺卡缩进样式 */
      subcall?: boolean;
    }>;
  }>;
}

/** journal 步行行（partials.jsonl；result:null——终值由补行/settlement 携带） */
interface JournalStepLine {
  type: 'journal-step';
  run: string;
  step: NonNullable<SubagentMessageLine['steps']>[number];
  agentId?: string;
  /** 行序号（partials.jsonl 内单调；settlement 切段排序键） */
  seq: number;
}

/** journal 注入行（partials.jsonl；steer 消费点落，ts 快照供提升还原） */
interface JournalInjectLine {
  type: 'journal-inject';
  run: string;
  message: { role: 'user'; content: string };
  agentId?: string;
  /** 注入时刻快照（epoch ms）——提升行 timestamp 由此还原（防错序） */
  ts?: number;
  seq: number;
}

/** 直调补行（partials.jsonl）：工具终值——步行 result:null 的覆盖源 */
interface ToolResultLine {
  type: 'tool-result';
  run: string;
  tool_call_id: string;
  result: unknown;
  seq: number;
}

/** run_code 子调用补行（subcalls.jsonl）：UI 回放面档案（不清理） */
interface SubcallLine {
  type: 'tool-result';
  run: string;
  tool_call_id: string;
  result: unknown;
  subcall: true;
  name?: string;
  arguments?: string;
  seq: number;
}

/** settled 判别行（messages.jsonl 提升批尾的原子提交标记） */
interface RunSettledLine {
  type: 'run-settled';
  run: string;
  seq?: number;
}

/** journal 行身份（rewritePartials 剔除对账的行键；无法解析 = 保留） */
function journalIdentity(line: string): string | undefined {
  try {
    const p = JSON.parse(line) as { type?: unknown; run?: unknown; seq?: unknown; tool_call_id?: unknown };
    if (typeof p.run !== 'string' || !p.run) return undefined;
    if ((p.type === 'journal-step' || p.type === 'journal-inject') && typeof p.seq === 'number') {
      return `${p.type}|${p.run}|${p.seq}`;
    }
    if (p.type === 'tool-result' && typeof p.tool_call_id === 'string' && p.tool_call_id) {
      return `tool-result|${p.run}|${p.tool_call_id}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** journal 行身份键合成（journalIdentity 的写侧孪生——四处模板并源，
 * 对齐 ac-session journalIdentityOf 先例：两份不同步 = 剔除漏行/重影） */
function journalIdentityOf(type: 'journal-step' | 'journal-inject' | 'tool-result', run: string, key: number | string): string {
  return type + '|' + run + '|' + String(key);
}

/** run-settled 前缀判定（避免全量 parse） */
function isRunSettledLine(line: string): boolean {
  return line.trimStart().startsWith('{"type":"run-settled"');
}

/** 生成消息唯一 ID（对齐 ac-session genMessageId 形态） */
function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成 run 关联键（段行/补行对账用；对齐 ac-session genRunId 形态） */
function genRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * LoopStepRecord → 落盘步记录（两口径共用，resultOf 区分）：
 * · journal 步行（partials.jsonl）：result 恒 null——落盘先于执行是设计，
 *   终值由补行携带〔中断恢复源〕或 settlement 携带〔正常收束，权威源〕；
 *   行序 = 模型消息数组实际序（注入行按消费点插在步行之间）；
 * · settlement 段行：tools 下标一一对应是 LoopStepRecord 契约，收束时
 *   toolResults 终值全在（权威源；loop 保证对应，防御性兜底 null——
 *   与 ac-session 部分行同口径，前端占位卡可识别）。
 */
function toStepRecord(step: LoopStepRecord, resultOf: (i: number) => unknown = () => null): NonNullable<SubagentMessageLine['steps']>[number] {
  return {
    content: step.text,
    ...(step.reasoning ? { reasoning: step.reasoning } : {}),
    ...(step.textBeforeTools !== undefined ? { textBeforeTools: step.textBeforeTools } : {}),
    ...(step.reasoningMs !== undefined ? { reasoningMs: step.reasoningMs } : {}),
    ...(step.ts !== undefined ? { ts: step.ts } : {}),
    ...(step.toolCalls.length > 0
      ? {
          toolCalls: step.toolCalls.map((tc, i) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            result: resultOf(i),
          })),
        }
      : {}),
  };
}

/** list 缺省/上限条数 */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
/** 派生身份剔除的能力标签：delegation 防递归 spawn；admin 防宿主级管理动作 */
const STRIPPED_TAGS = ['delegation', 'admin'];

/** subagent 工具已知参数名（未知参数 = 工具拿错的最强信号，入口报警） */
const KNOWN_ARG_KEYS = new Set([
  'action', 'task', 'name', 'tools', 'system', 'subagent_id',
  'message', 'mode', 'timeout_s', 'wait_time',
  'query', 'running_only', 'limit',
]);

/** 派生身份合成（父身份编辑）：preset 隐藏 + tags 剥 delegation/admin；
 * workdir 快照（2026-12 数据根一致修复）注入 settings.security.workdir
 * （sandboxWorkdir 显式档——子 Agent run 无会话键，靠快照与父会话同根） */
function deriveAgentConfig(rec: SubagentRecord, parent: AgentConfig): AgentConfig {
  const tags = (parent.tags ?? []).filter((t) => !STRIPPED_TAGS.includes(t));
  const settings = { ...(parent.settings ?? {}) } as Record<string, unknown>;
  if (rec.workdir !== undefined) {
    const security = { ...((settings.security as Record<string, unknown> | undefined) ?? {}) };
    security.workdir = rec.workdir;
    settings.security = security;
  }
  if (rec.system !== undefined) {
    // 显式人设 = 完全接管人格语义：清空继承的 persona 配置——否则
    // ac-persona 的 before-run 前置块（settingsOf(subId,'persona') 命中
    // 父的人设文件/文本）会与显式 system 叠加出双重人格
    delete settings.persona;
  }
  return {
    id: rec.id,
    preset: true, // 名册/协作/管理面不可见；工作区根口径（与未注册时代同回落）
    name: rec.name,
    description: `子 Agent（父：${rec.parentId}）：${rec.task || rec.name}`,
    // system/llmParams/tools/maxSteps 不进派生条目——executeRun 每 run 现读父配置
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}



/** id 文件名安全（生成端恒安全；装载端防御） */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(id);
}

/**
 * 「给 Agent/用户发消息」的指路提示（news 事故 2026-09-16：subagent(send)
 * 被 send_agent 意图串用）。工具层各误用出口共用一份文案，ac-collab-tools
 * 反向引用同源，避免两处漂移。
 */
export const HINT_AGENT_MESSAGING =
  'subagent 管理的是你私有的子 Agent 看板（spawn/send/await/list/stop/delete）：'
  + '子 Agent 的回复只返回给你。给其他 Agent 或用户发消息 → send_agent；'
  + '发群消息 → send_group；给已 spawn 的子 Agent 发任务消息 → subagent(action="send", subagent_id=…, message=…)。';

/** subagent 工具统一报错收敛：服务层 Error → 带指路的 ToolResult */
export function subagentErr(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('send_agent') || message.includes('转达') || message.includes('推送')) {
    return { ok: false, error: message, output: { hint: HINT_AGENT_MESSAGING } };
  }
  return { ok: false, error: message };
}

export class SubagentsService extends Service {
  static inject = ['tools', 'agentLoop', 'jobs', 'agents'];

  /** 持久化注册表全量（含墓碑；启动装载后常驻内存） */
  private records = new Map<string, SubagentRecord>();
  /** 活跃态（触达过的实体；run 收束后仅保留薄条目） */
  private entries = new Map<string, SubEntry>();
  /** 持久化目录（undefined = 纯内存态） */
  private readonly storeDir: string | undefined;
  /** waiter/inbox token 序号（进程内单调） */
  private seq = 0;

  constructor(ctx: Context, options: SubagentRowOptions = {}) {
    super(ctx, 'subagents');
    const root = options.root ?? process.env.AGENTCHAT_DATA_ROOT;
    this.storeDir = root !== undefined ? path.resolve(root, 'subagents') : undefined;
    this.loadRegistry();
    this.registerLoopHooks();
    this.registerTool();
  }

  /**
   * loop 事件订阅（三文件化 2026-12）：子 run 身份 = agent:<subId>、
   * conversationId 缺席——按 agent 寻址路由到本服务的 journal 通道。
   * 与 ac-session 同款事件面（after-step 步行 / after-execute 补行 /
   * step-started 注入消费点），本服务内自管 settlement（executeRun 收束）。
   */
  private registerLoopHooks(): void {
    // 步行落 journal（工具步 result:null；纯文本步同款——行序即真序）
    this.ctx.on('loop/after-step', (agent: string | undefined, step: LoopStepRecord) => {
      if (agent === undefined) return;
      const entry = this.entries.get(agent);
      if (entry?.activeRun === undefined) return; // 非本服务活跃 run（宿主 run 等）
      entry.activeRun.journaled = true;
      this.appendJournalLine(entry, { type: 'journal-step', run: entry.activeRun.run, step: toStepRecord(step), agentId: agent, seq: entry.activeRun.seq++ });
    }, { description: 'subagent journal 步行（run 中间态——settlement 切段数据源）' });
    // 直调/subcall 补行（终值覆盖源；subcall → subcalls.jsonl 永久档案）
    this.ctx.on('tool/after-execute', (call: { agentId?: string; toolCallId?: string; name?: string; runCodeSubcall?: boolean; args?: unknown }, result: unknown) => {
      if (call.agentId === undefined) return;
      const entry = this.entries.get(call.agentId);
      const active = entry?.activeRun;
      if (entry === undefined || active === undefined) return; // 宿主 run 补行归 ac-session
      if (typeof call.toolCallId !== 'string' || !call.toolCallId) return; // 幻影调用无对账锚
      const isSubcall = call.runCodeSubcall === true;
      const line: ToolResultLine | SubcallLine = {
        type: 'tool-result',
        run: active.run,
        tool_call_id: call.toolCallId,
        result,
        ...(isSubcall
          ? { subcall: true as const, ...(call.name !== undefined ? { name: call.name } : {}), ...(call.args !== undefined ? { arguments: JSON.stringify(call.args) } : {}) }
          : {}),
        seq: active.seq++,
      };
      active.pendingSups.push({ line: JSON.stringify(line), identity: journalIdentityOf('tool-result', active.run, call.toolCallId) });
      this.appendJournalLine(entry, line);
    }, { description: 'subagent 工具结果补记（步行 result:null 的终值覆盖源 + subcalls 档案）' });
    // steer 注入消费点（step-started 时消息数组已含注入——按对象身份对账）
    this.ctx.on('loop/step-started', (agent: string | undefined, _index: number, messages: unknown) => {
      if (agent === undefined) return;
      const entry = this.entries.get(agent);
      const active = entry?.activeRun;
      if (entry === undefined || active === undefined) return;
      const msgs = Array.isArray(messages) ? (messages as unknown[]) : [];
      for (const m of msgs) {
        const ts = active.stashed.get(m as object);
        if (ts === undefined) continue;
        active.stashed.delete(m as object);
        const content = (m as { content?: unknown }).content;
        if (typeof content !== 'string') continue;
        active.journaled = true;
        this.appendJournalLine(entry, { type: 'journal-inject', run: active.run, message: { role: 'user', content }, agentId: entry.record.parentId, ts, seq: active.seq++ });
      }
    }, { description: 'subagent steer 注入消费点落 journal（消费真序）' });
    // 收束时未消费的注入：直接落 messages（run 外行——不硬造 run 键）
    this.ctx.on('loop/steer-dropped', (agent: string | undefined, _conversationId: string | undefined, _handle: string, dropped: Array<{ message: unknown }>) => {
      if (agent === undefined) return;
      const entry = this.entries.get(agent);
      if (entry === undefined) return;
      for (const d of dropped) {
        const ts = entry.activeRun?.stashed.get(d.message as object);
        if (ts === undefined) continue;
        if (entry.activeRun) entry.activeRun.stashed.delete(d.message as object);
        const content = (d.message as { content?: unknown }).content;
        if (typeof content !== 'string') continue;
        this.appendMessage(entry.record.id, { role: 'user', content, agent_id: entry.record.parentId });
      }
    }, { description: 'subagent steer 收束竞态兜底（未消费注入不丢）' });
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

  /**
   * spawn 时沙箱基准快照（2026-12 数据根一致修复）：优先序与
   * sandboxWorkdir 会话感知链对齐——① 父会话挂载的工作区根
   * （conversationWorkspaceRoot；spawn 无会话键 = 跳过）② 父 settings
   * 显式 workdir（settingsOf 合成）。两者皆缺省 = undefined（沙箱链回
   * preset→数据根，与旧行为一致——父本就在数据根语境时零变化）。
   */
  private spawnWorkdirOf(opts: SubagentSpawnOptions): string | undefined {
    const workspace = this.ctx.get('workspace', false) as
      | { conversationWorkspaceRoot(conversationId: string | undefined): string | null; sandboxWorkdir(agentId: string | undefined, conversationId?: string): string | undefined }
      | undefined;
    if (opts.conversationId !== undefined) {
      const wsRoot = workspace?.conversationWorkspaceRoot(opts.conversationId);
      if (wsRoot) return wsRoot;
    }
    // 父显式 workdir / preset 数据根口径——与 sandboxWorkdir(父, 会话键)
    // 的 fallback 同源（复用其判定，不在此重复实现优先序细节）
    return workspace?.sandboxWorkdir(opts.parentId, opts.conversationId);
  }

  /** 创建子 Agent；task 给出即投递首条消息并启动 run */
  spawn(opts: SubagentSpawnOptions): SubagentSpawnResult {
    // fail-fast（保持旧语义）：父不存在/无模型在创建口报错（两道守卫同
    // 文案——resolveModel 内含父检查，此处保 parent 非空供派生身份使用）
    const parent = this.ctx.agents.get(opts.parentId);
    if (!parent) {
      throw new Error(`父 Agent "${opts.parentId}" 未注册（subagent 需要父的 model 配置）`);
    }
    this.resolveModel(opts.parentId);
    const spawnWorkdir = this.spawnWorkdirOf(opts);
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
      // 显式 >= 0 合法（0 = 不设看门狗）；未传/负数/NaN = 缺省不限（长任务友好）
      timeoutMs: typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : 0,
      ...(opts.toolNames && opts.toolNames.length > 0 ? { toolNames: opts.toolNames } : {}),
      // 沙箱基准快照（2026-12 数据根一致修复）：父会话挂载的工作区根——
      // 子 Agent run 无会话键，沙箱链 fallback preset→数据根会与父会话
      // 执行环境分叉；快照进派生身份后 fs/shell/安全复检同根
      ...(spawnWorkdir ? { workdir: spawnWorkdir } : {}),
      // 显式 system 固化（2026-12 人格防污染）：空串归一为缺席（不落空键）
      ...(opts.system?.trim() ? { system: opts.system } : {}),
    };
    this.records.set(id, record);
    this.persistRegistry();
    this.ctx.emit('subagents/updated', this.infoOf(record), 'spawned');
    // 派生身份注册（父身份编辑：preset 隐藏 + 剥 delegation/admin）
    this.ctx.agents.register(deriveAgentConfig(record, parent));
    const entry = this.hydrate(record);
    let settled: Promise<SubagentRunSummary> | undefined;
    const task = opts.task?.trim();
    if (task) {
      // 内部按 sync 投递取首轮收束 promise（供 spawn wait_time 阻塞语义）；
      // 对外仍是异步启动——settled 不 await 即忽略
      settled = this.deliver(entry, task, 'sync', {
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
        ...(opts.elevation ? { elevation: opts.elevation } : {}),
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
      ...(opts.elevation ? { elevation: opts.elevation } : {}),
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
    const stopped = this.stopRun(entry);
    if (stopped) this.ctx.emit('subagents/updated', this.infoOf(record), 'stopped');
    return stopped;
  }

  /** 打墓碑：终止活跃 run（若有）+ list 不再可见；会话文件保留 */
  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.deleted) return false;
    record.deleted = true;
    record.updatedAt = Date.now();
    // 派生身份随撤（register 幂等；宿主级失败容忍——重载时 hydrate 补齐）
    try {
      this.ctx.agents.remove(id);
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] "${id}" 撤派生身份失败（不影响删除）: ${String(err)}`);
    }
    const entry = this.entries.get(id);
    if (entry) {
      entry.inbox = [];
      this.stopRun(entry);
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
    this.ctx.emit('subagents/updated', this.infoOf(record), 'removed');
    return true;
  }

  /** 查询（含历史；墓碑缺省不可见——includeDeleted 携带，会话历史仍可读）。
   *  活跃在前，其余按 updatedAt 降序 */
  list(opts: SubagentListOptions = {}): { activeCount: number; total: number; subs: SubagentInfo[] } {
    const query = opts.query?.trim().toLowerCase();
    const infos = [...this.records.values()]
      .filter((r) => (opts.includeDeleted ? true : !r.deleted))
      .filter((r) => (opts.parentId !== undefined ? r.parentId === opts.parentId : true))
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

  /**
   * 会话消息（上下文回放口径：user/assistant 对——agent 行携带 steps 时
   * 按 expandSteps 轨迹展开，与主会话 replayTrajectory 同口径）。
   */
  async history(id: string): Promise<LlmMessage[]> {
    const record = this.requireRecord(id);
    const entry = this.hydrate(record);
    return [...(await this.ensureMessages(entry))];
  }

  /**
   * 会话消息（展示口径，R6：墓碑可读——remove 只打墓碑、会话文件保留的
   * 既有语义本就隐含可回看）：读 jsonl 全量行宽容解析（损坏行跳过；文件
   * 不存在 = 空数组）+ subcalls
   * 投影注入（2026-12 前端反馈 #2）。投影 = ac-session records() 同款语义：
   * subcalls.jsonl 档案行按 tool_call_id 前缀（'<hostCallId>#<seq>' 形态）定位
   * 宿主 run_code 调用，紧随其后平铺注入 steps[].toolCalls（subcall:true——
   * 前端缩进卡样式 + 完整参数/结果）。排序键 = 行 seq（程序提交序）；宿主
   * 缺席（孤儿档案）静默丢弃——无卡片可挂。
   *
   * journal 活投影（2026-12 对齐普通会话）：run 进行中（partials.jsonl 台账
   * 在场、messages 尚无段行）时，步行/注入行按真序投影为行尾 agent 段行
   * （partial:true——前端同 toHistoryMessages 步展开管线）+ injected user
   * 行；直调补行（tool-result 终值）覆盖步行 result:null。已收束 run 的
   * journal 行（崩溃残留——recoverJournal 收口前窗口）不投影：messages
   * 定稿流是权威。
   */
  historyRecords(id: string): SubagentMessageLine[] {
    const record = this.records.get(id);
    if (!record || this.storeDir === undefined) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(this.messagesPath(id), 'utf-8');
    } catch {
      return []; // 无文件 = 空会话
    }
    const out: SubagentMessageLine[] = [];
    const settledRuns = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as SubagentMessageLine;
        if (
          typeof parsed.content === 'string' &&
          (parsed.role === 'user' || parsed.role === 'agent' || parsed.role === 'assistant')
        ) {
          out.push(parsed);
          // settled 判定锚：同 run 非 partial 行存在 = 定稿已提升（对齐
          // recoverJournal 的组员存在性判定——injected 行是独立会话事实，
          // 不算收束锚）
          if (parsed.run !== undefined && parsed.partial !== true && parsed.injected !== true) {
            settledRuns.add(parsed.run);
          }
        }
      } catch {
        /* 损坏行跳过 */
      }
    }
    // journal 活投影（未收束 run——run 进行中/中断未恢复）：步行 → partial
    // agent 段行；注入行 → injected user 行；补行 → result 覆盖。行序 =
    // journal 文件序（真序），整体接在定稿流尾部（run 进行中 = 时序最新）。
    const live = this.readJournalLive(id, settledRuns);
    if (live.length > 0) out.push(...live);
    return this.injectSubcalls(out, this.readSubcallLines(id));
  }

  /**
   * partials.jsonl → 未收束 run 的活投影行（展示口径）。补行终值就地覆盖
   * 步行 result:null（同 ac-session supplements 语义）；subcall 档案行不
   * 在此文件（subcalls.jsonl——由 injectSubcalls 平面挂载），天然不混入。
   */
  private readJournalLive(id: string, settledRuns: Set<string>): SubagentMessageLine[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.partialsPath(id), 'utf-8');
    } catch {
      return []; // 无文件 = 无在途 run
    }
    // 直调补行（run|tool_call_id → 终值）——步行 result:null 覆盖源
    const sups = new Map<string, unknown>();
    const journalLines: Array<{ run: string; seq: number; line: unknown }> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as { type?: string; run?: unknown; seq?: unknown; tool_call_id?: unknown };
        if (typeof p.run !== 'string' || !p.run) continue;
        if (p.type === 'tool-result' && typeof p.tool_call_id === 'string' && p.tool_call_id) {
          sups.set(`${p.run}|${p.tool_call_id}`, (p as { result?: unknown }).result);
          continue;
        }
        if ((p.type === 'journal-step' || p.type === 'journal-inject') && typeof p.seq === 'number') {
          if (settledRuns.has(p.run)) continue; // 已收束：定稿流权威
          journalLines.push({ run: p.run, seq: p.seq, line: p });
        }
      } catch { /* 损坏行忽略 */ }
    }
    if (journalLines.length === 0) return [];
    journalLines.sort((a, b) => a.seq - b.seq);
    const out: SubagentMessageLine[] = [];
    // 步行按 run 连续聚合为段行（与 settlement 切段同形——注入行是切分点）
    let segSteps: NonNullable<SubagentMessageLine['steps']> = [];
    let segRun: string | undefined;
    const flushSeg = () => {
      if (segSteps.length === 0) return;
      // 补行覆盖：result:null ← 终值（在途 run 的工具结果如实可见）
      for (const s of segSteps) {
        for (const tc of s.toolCalls ?? []) {
          if (tc.result === null || tc.result === undefined) {
            const hit = sups.get(`${segRun}|${tc.id}`);
            if (hit !== undefined) tc.result = hit;
          }
        }
      }
      out.push({
        role: 'agent',
        content: '',
        agent_id: id,
        run: segRun,
        partial: true,
        steps: segSteps,
        // 步内真实 ts 推导 timestamp（步级排序锚——前端 ridBase 合成与
        // stepTs 回落均消费；缺 ts 的存量步回落读取时刻）
        timestamp: new Date(segSteps.find((s) => typeof s.ts === 'number' && s.ts > 0)?.ts ?? Date.now()).toISOString(),
      });
      segSteps = [];
    };
    for (const item of journalLines) {
      const p = item.line as { type: string; run: string; step?: NonNullable<SubagentMessageLine['steps']>[number]; message?: { content: string }; agentId?: string; ts?: number };
      if (p.type === 'journal-step' && p.step !== undefined) {
        if (segRun !== undefined && segRun !== p.run) flushSeg();
        segRun = p.run;
        segSteps.push(p.step);
        continue;
      }
      // journal-inject：切段 + injected user 行（提升形态与 settlement 一致）
      flushSeg();
      const ts = p.ts ?? Date.now();
      out.push({
        role: 'user',
        content: p.message?.content ?? '',
        agent_id: p.agentId ?? '',
        injected: true,
        run: p.run,
        ts,
        timestamp: new Date(ts).toISOString(),
      });
    }
    flushSeg();
    return out;
  }

  /** subcalls.jsonl 档案行读取（宽容解析；无文件 = 空表） */
  private readSubcallLines(id: string): SubcallLine[] {
    const out: SubcallLine[] = [];
    try {
      const raw = fs.readFileSync(this.subcallsPath(id), 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as Partial<SubcallLine>;
          if (p.subcall === true && typeof p.run === 'string' && typeof p.tool_call_id === 'string' && p.tool_call_id) {
            out.push(p as SubcallLine);
          }
        } catch { /* 损坏行忽略 */ }
      }
    } catch { /* 无文件 = 空表 */ }
    return out;
  }

  /**
   * subcall 档案 → steps[].toolCalls 平铺注入（宿主定位 = tool_call_id 首 #
   * 前缀，ac-session injectSubcalls 同款）。浅拷贝注入（盘上行对象不被
   * 变异——重读幂等）；run 进行中档案（宿主步行在 partials、段行未物化）
   * 无宿主可挂即静默跳过，settlement 后自然挂载。
   */
  private injectSubcalls(records: SubagentMessageLine[], subcallLines: SubcallLine[]): SubagentMessageLine[] {
    if (subcallLines.length === 0) return records;
    // 宿主 id 索引（O(N+M)；前缀 = run_code 调用的 toolCallId）
    const byHost = new Map<string, SubcallLine[]>();
    for (const k of subcallLines) {
      const hash = k.tool_call_id.indexOf('#');
      if (hash <= 0) continue;
      const host = k.tool_call_id.slice(0, hash);
      const bucket = byHost.get(host);
      if (bucket) bucket.push(k);
      else byHost.set(host, [k]);
    }
    const injected = records.map((r) => ({
      ...r,
      ...(r.steps !== undefined ? { steps: r.steps.map((s) => ({ ...s, ...(s.toolCalls !== undefined ? { toolCalls: [...s.toolCalls] } : {}) })) } : {}),
    }));
    for (const r of injected) {
      if (r.steps === undefined) continue;
      for (const s of r.steps) {
        if (!s.toolCalls) continue;
        for (let i = 0; i < s.toolCalls.length; i++) {
          const kids = byHost.get(s.toolCalls[i]!.id);
          if (kids === undefined || kids.length === 0) continue;
          // 排序键 = 行 seq（程序提交序；存量行回退 0 稳定序）
          kids.sort((a, b) => a.seq - b.seq);
          s.toolCalls.splice(i + 1, 0, ...kids.map((k) => ({
            id: k.tool_call_id,
            name: k.name ?? '(unknown)',
            arguments: k.arguments ?? '{}',
            result: k.result,
            subcall: true as const,
          })));
          i += kids.length;
        }
      }
    }
    return injected;
  }

  // ============================================================
  // 投递与 run 编排（内部）
  // ============================================================

  private deliver(
    entry: SubEntry,
    text: string,
    mode: SubagentSendMode,
    extra: { conversationId?: string; elevation?: 'sandbox-access' | 'full-access' } = {},
  ): { delivered: 'started' | 'steered' | 'queued'; settled?: Promise<SubagentRunSummary> } {
    const busy = entry.controller !== undefined;
    if (mode === 'steer' && busy) {
      // steer 地址 = subId（runAddress：conversationId 缺省 → 地址即 agent）
      // 三文件化 2026-12：注入消息改 stash（消费点对账落 journal）——消息对象
      // 只构造一次：loop.steer 入队的正是它，step-started 消费点按对象身份
      // 命中 stashed → journal-inject（消费真序）；收束未消费 → steer-dropped
      // 兜底直落 messages（run 外行不硬造 run）。
      const injectMsg: LlmMessage = { role: 'user', content: text };
      if (this.ctx.agentLoop.steer(entry.record.id, injectMsg)) {
        entry.activeRun?.stashed.set(injectMsg, Date.now());
        return { delivered: 'steered' };
      }
      // 收束窗口已关 → 回落排队（消息不丢，与 ac-conversation D3 同姿势）
    }
    const token = `w${++this.seq}`;
    entry.inbox.push({
      text,
      ...(extra.conversationId ? { conversationId: extra.conversationId } : {}),
      ...(extra.elevation ? { elevation: extra.elevation } : {}),
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
      for (;;) {
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
    this.ctx.emit('subagents/updated', this.infoOf(rec), 'started');

    // job 登记回调句柄：先声明后使用——settle 闭包会被早期失败路径
    // （模型解析失败等，先于 jobs.start）调用，声明滞后即 TDZ ReferenceError
    let jobDone: ((o: JobOutcome) => void) | undefined;

    const settle = (s: SubagentRunSummary): SubagentRunSummary => {
      entry.controller = undefined;
      entry.abortReason = undefined;
      entry.activeRun = undefined; // 闭簿（settlement 已在调用前完成——见收束段）
      rec.status = 'idle';
      rec.runs++;
      rec.lastRun = s;
      rec.updatedAt = Date.now();
      this.persistRegistry();
      this.ctx.emit('subagents/updated', this.infoOf(rec), 'settled');
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

    // journal 簿记开簿（三文件化 2026-12）：步行/注入/补行事件监听据此路由。
    // 此处置位覆盖全部后续路径（模型解析失败也在簿记之后——空 journal +
    // settlement 无物化对象，行为与旧整行直落一致）。
    const run = genRunId();
    entry.activeRun = { run, journaled: false, stashed: new Map(), seq: 1, pendingSups: [] };

    // 上下文装载 + 首条消息（frameTask 已退役 2026-12：任务原文直传；
    // context 参数同批退役——背景材料写进 task 或 send 追加，表达力等价）
    const messages = await this.ensureMessages(entry);
    const first = messages.length === 0;
    const content = item.text;
    if (first && !rec.task) {
      rec.task = item.text.slice(0, 80);
      this.persistRegistry();
    }
    messages.push({ role: 'user', content });
    this.appendMessage(rec.id, { role: 'user', content, agent_id: rec.parentId });

    // 模型解析（每 run 现解析——父配置热更生效）
    let model: string;
    const failRun = (err: unknown): SubagentRunSummary => settle({
      status: 'error',
      finish: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      finishedAt: Date.now(),
    });
    let provider: string | undefined;
    try {
      const resolved = this.resolveModel(rec.parentId);
      model = resolved.model;
      provider = resolved.provider;
    } catch (err: unknown) {
      return failRun(err);
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
            this.stopRun(entry);
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

    // 超时看门狗（abort 在步边界生效；LLM 传输层直达）。0 = 不设看门狗。
    // 竞态守卫：stop 先 abort 且 run 收束中时，迟到触发不覆写既有
    // abortReason（否则终态误标 timeout）——仅本 run 的 controller 在役
    // 且尚无中止原因时才记 timeout。
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (rec.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (entry.controller === controller && entry.abortReason === undefined) {
          entry.abortReason = 'timeout';
          controller.abort();
        }
      }, rec.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    let result: LoopRunResult;
    try {
      // 子 Agent 档位继承（access-tier §7.3）：elevation = 父 run 生效档位
      // effectiveTierOf(parent, call.elevation)——继承不放大也不缩水。
      // 两个先前盲区一并补齐：base 父派出的子 Agent（恒 base、会话无用户）
      // 永远写不了文件；父 run 处于用户快捷提权态（call.elevation）时
      // 此前也只看 tags——子 Agent 落回 base 逐工具审批。run 编排是
      // agentLoop.run 直连（可信服务，不经 deliver）——elevation 合法装配方。
      const parent = this.ctx.agents.get(rec.parentId);
      const parentTier = effectiveTierOf(parent, item.elevation);
      // 信封装配（router 同款；subagent 直连 loop 不经 router，此处为
      // 唯一装配点）：工具可见面 = 点名集/全量 ∩ 派生身份能力集——
      // spawn.tools 点名也不可越过门禁（subagent/system_restart 等
      // requiredTags 工具对子 Agent 不可见不可执行）；system/llmParams
      // 现读父配置（热更生效）。
      const caps = capabilitySetOf(this.ctx, rec.id);
      const allDefs = this.ctx.tools.list();
      // 常规能力面（对齐 router：injection 分流——mode 工具不进常规面，
      // tc-programmatic 时经 narrowToolsByMode 从 defs 合成）
      const allowed = allDefs.filter((t) => t.injection !== 'mode' && toolAllowedFor(t, caps)).map((t) => t.name);
      let names = rec.toolNames && rec.toolNames.length > 0 ? rec.toolNames.filter((n) => allowed.includes(n)) : allowed;
      // 工具调用模式传播（2026-12 injection 轴重构后单源化；同日二次修正：
      // 收窄不再限定「未点名」——与 router 真实 run 同口径，mode 对任何面
      // 生效）：生效档 = 发起会话覆盖（conv-settings toolMode）??
      // toolModeOf(父)——tc-programmatic ⇒ LLM 面合成 mode 工具集
      // （injection:'mode'，与 tags/点名无关——**点名工具不丢失**：仍在
      // 能力面，经 run_code 投影〔scope='projection' 能力面直取〕程序内
      // tools.<name>() 可调，门禁逐调用复检）；tc-none ⇒ 空面；tc-base ⇒
      // 点名面/能力面（spawn.tools 只在该档收窄面）。判定/收窄用 ac-agents
      // 单源（effectiveToolMode/narrowToolsByMode）。投影注入由 ac-run-code
      // prompt.ts 按 run 级 request.tools 自然生效。
      {
        const mode = effectiveToolMode(parent, item.conversationId, {
          convSettings: this.ctx.get('convSettings', false) as
            | { get(conversationId: string): { toolMode?: 'tc-base' | 'tc-programmatic' | 'tc-none' } }
            | undefined,
        });
        names = narrowToolsByMode(names, allDefs, mode);
        if (mode === 'tc-programmatic' && names.length === 0) {
          this.ctx.logger.warn('[subagent] 工具调用模式为 tc-programmatic 但无 injection:mode 工具（run-code 行未装），子 Agent 工具面为空——形同 tc-none，不回落常规工具面');
        }
      }
      const llmParams = filterLlmParams(parent?.llmParams);
      result = await this.ctx.agentLoop.run({
        // 派生注册身份：steer 可寻址 + 门禁按剥减后 tags 判定（防递归/
        // 防宿主级动作）+ persona/memory 等扩展行随 settings 生效
        agent: rec.id,
        model,
        ...(provider ? { provider } : {}),
        messages: [...messages],
        // 空集照传（loop 收敛为无工具）——缺省会回落全量已注册，绕过门禁
        tools: names,
        // system 装配（2026-12 人格防污染）：显式固化（rec.system）优先——
        // 完全接管人格语义；缺省继承父人设（与 tags/settings 继承同族）
        ...(rec.system !== undefined ? { system: rec.system } : parent?.system ? { system: parent.system } : {}),
        ...(Object.keys(llmParams).length > 0 ? { llmParams } : {}),
        ...(parentTier !== 'base-access' ? { elevation: parentTier } : {}),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      return failRun(err);
    }
    clearTimeout(timer);

    // settlement（三文件化 2026-12，对齐 ac-session 2026-11 泛化裁决）：
    // 有 journal（步行/注入/补行任一）→ 切段物化提升进 messages + journal
    // 剔除（含错误/中断收束——run 做过的推理是会话事实）；无 journal 的 run
    //（一步即溃/纯文本空转）照旧整行直落（与三文件化前零变化）。
    // 内存消息数组同步追加（与 ensureMessages 展开口径一致——跨 run 轨迹
    // 复放，探查型/中断 run 不失忆）：有步 = expandSteps 展开（末步 content
    // 即终文本，与主会话 replayTrajectory 单源同形）；无步纯文本 = 终文本行。
    {
      const steps = result.steps.map((s) => toStepRecord(s, (i) => s.toolResults[i] ?? null));
      if (steps.length > 0) messages.push(...expandSteps(steps));
      else if (result.text) messages.push({ role: 'assistant', content: result.text });
    }
    const active = entry.activeRun!;
    if (active.journaled) {
      this.settleRun(entry, active, result, run);
    } else if (result.finish === 'error') {
      // 无 journal 的错误收束（一步即溃）也要落 error 行：失败是会话事实，
      // 静默 = 用户只见 run 无响应（形态与 settleRun 内 error 分支一致：
      // role:'context' + source:'error'——主会话 D12/F7 同口径）
      this.appendMessage(rec.id, {
        role: 'context',
        content: String(result.error ?? '循环失败'),
        agent_id: rec.id,
        source: 'error',
        run,
      });
    } else if (result.text) {
      const steps = result.steps.map((s) => toStepRecord(s, (i) => s.toolResults[i] ?? null));
      this.appendMessage(rec.id, {
        role: 'agent',
        content: result.text,
        agent_id: rec.id,
        ...(steps.length > 0 ? { steps } : {}),
        ...(steps.length > 0 && steps.at(-1)?.reasoning ? { reasoning: steps.at(-1)!.reasoning } : {}),
      });
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

  // ============================================================
  // settlement（run 收束物化，三文件化 2026-12）
  // ============================================================

  /**
   * settlement 主流程：journal（盘上行 + 内存 pendingSups）按真序切段 →
   * 提升进 messages.jsonl（含 run-settled 判别行）→ partials 剔除。
   * subcalls 行不剔除（永久档案）。数据源合并读（ac-session readJournalRun
   * 同款语义）：崩溃场景本方法不走（recoverJournal 收口），运行时盘上
   * 行优先、内存 pendingSups 只补 append 失败窗口的缺口（readJournal
   * 身份去重；同键重放幂等）。
   */
  private settleRun(entry: SubEntry, active: NonNullable<SubEntry['activeRun']>, result: LoopRunResult, run: string): void {
    if (this.storeDir === undefined) return; // 纯内存态：无中间态可物化（内存 messages 数组已追加）
    const id = entry.record.id;
    const { stepLines, injectLines, sups } = this.readJournal(id, run);
    if (stepLines.length === 0 && injectLines.length === 0 && sups.length === 0) return; // 空 journal：无物化对象（防御）
    // 补行并入（keyed by tool_call_id；同键新行在后覆盖——重放幂等）
    const supMap = new Map<string, unknown>();
    for (const s of sups) supMap.set(s.tool_call_id, s.result);
    const steps = stepLines.map((x) => x.step);
    for (const sl of steps) {
      for (const tc of sl.toolCalls ?? []) {
        const hit = supMap.get(tc.id);
        if (hit !== undefined) tc.result = hit;
      }
    }
    // 权威覆盖：收束 result 终值（journal 步行与收束行同源；防御差异以收束为准）
    const allSteps = result.steps.map((s) => toStepRecord(s, (i) => s.toolResults[i] ?? null));
    if (allSteps.length === steps.length) {
      for (let i = 0; i < steps.length; i++) {
        for (let k = 0; k < (steps[i].toolCalls ?? []).length; k++) {
          const tc = steps[i].toolCalls![k]!;
          const auth = allSteps[i].toolCalls?.[k];
          if (auth) tc.result = auth.result;
        }
      }
    }
    // 切段：注入行 = 切分点。全行带 run 键（对账锚——同 run 非 partial 行存在性）
    const mergedSeq = [
      ...stepLines.map((s) => ({ kind: 'step' as const, seq: s.seq, step: s.step })),
      ...injectLines.map((j) => ({ kind: 'inject' as const, seq: j.seq, line: j })),
    ].sort((a, b) => a.seq - b.seq);
    const segs: Array<NonNullable<SubagentMessageLine['steps']>> = [];
    const injects: JournalInjectLine[] = [];
    let seg: NonNullable<SubagentMessageLine['steps']> = [];
    for (const item of mergedSeq) {
      if (item.kind === 'step') { seg.push(item.step); continue; }
      segs.push(seg); seg = [];
      injects.push(item.line);
    }
    segs.push(seg); // 尾段
    const hasSegments = injects.length > 0;
    const batch: Array<() => void> = [];
    const pushSeg = (stepsSeg: NonNullable<SubagentMessageLine['steps']>) => {
      if (stepsSeg.length === 0) return;
      batch.push(() => this.appendMessage(id, {
        role: 'agent',
        content: stepsSeg.at(-1)?.content ?? '',
        agent_id: entry.record.id,
        steps: stepsSeg,
        run,
      }));
    };
    if (hasSegments) {
      // 切分形态：段行 + 注入提升行交错；终文本在尾段末步（收束行退役——不重复落）
      for (let i = 0; i < injects.length; i++) {
        pushSeg(segs[i]!);
        const j = injects[i]!;
        const ts = j.ts ?? Date.now();
        batch.push(() => this.appendMessage(id, {
          role: 'user',
          content: j.message.content,
          agent_id: j.agentId ?? entry.record.parentId,
          injected: true,
          run,
          ts,
        }));
      }
      pushSeg(segs.at(-1)!);
    } else if (result.finish === 'error') {
      // 错误收束：尾段步物化 + context error 行（run 做过的推理是会话事实）。
      // role:'context'（主会话 D12/F7 同口径）：UI 错误分隔符（toHistoryMessages
      // 只认 context+source:error）+ 回放不进子上下文（下方 user 轮过滤）。
      // 存量 role:'user'+source:'error' 行读侧照常兼容（historyApi 200 行分支
      // 不命中时落普通 user 渲染，行为同旧）。
      pushSeg(segs[0]!);
      batch.push(() => this.appendMessage(id, {
        role: 'context',
        content: String(result.error ?? '循环失败'),
        agent_id: entry.record.id,
        source: 'error',
        run,
      }));
    } else {
      // 无切分：整 run 单行直落（终文本 + 全部 steps；与三文件化前同形 + run 键）
      const text = result.text;
      batch.push(() => this.appendMessage(id, {
        role: 'agent',
        content: text,
        agent_id: entry.record.id,
        ...(steps.length > 0 ? { steps } : {}),
        ...(steps.length > 0 && steps.at(-1)?.reasoning ? { reasoning: steps.at(-1)!.reasoning } : {}),
        run,
      }));
    }
    for (const fn of batch) fn();
    // settled 判别行（提升批尾——原子提交标记 + 恢复判定诊断信号）
    try {
      const file = this.messagesPath(id);
      fs.appendFileSync(file, JSON.stringify({ type: 'run-settled', run, seq: this.nextMsgSeq(file) } satisfies RunSettledLine) + '\n', 'utf-8');
    } catch { /* 判别行失败不阻塞——恢复判定按组员存在性 */ }
    // journal 剔除（按行身份；subcalls 永久档案不在此文件，天然不受影响）
    this.rewritePartials(id, new Set([
      ...stepLines.map((s) => journalIdentityOf('journal-step', run, s.seq)),
      ...injectLines.map((j) => journalIdentityOf('journal-inject', run, j.seq)),
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- as-cast 后判别键比较是运行时判别（盘上 JSON 往返行 subcall 键可缺席）
      ...sups.filter((s) => (s as SubcallLine).subcall !== true).map((s) => journalIdentityOf('tool-result', run, s.tool_call_id)),
    ]));
  }

  /** journal 读取（盘上 partials + subcalls + 内存 pendingSups 合并；身份去重——盘上优先，内存行仅补盘上缺口〔append 失败窗口〕） */
  private readJournal(id: string, run: string): { stepLines: JournalStepLine[]; injectLines: JournalInjectLine[]; sups: Array<ToolResultLine | SubcallLine> } {
    const stepLines: JournalStepLine[] = [];
    const injectLines: JournalInjectLine[] = [];
    const sups: Array<ToolResultLine | SubcallLine> = [];
    const seen = new Set<string>();
    const collect = (raw: string) => {
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as Record<string, unknown>;
          if (p.run !== run) continue;
          const ident = journalIdentity(line);
          if (ident !== undefined) {
            if (seen.has(ident)) continue;
            seen.add(ident);
          }
          if (p.type === 'journal-step') stepLines.push(p as unknown as JournalStepLine);
          else if (p.type === 'journal-inject') injectLines.push(p as unknown as JournalInjectLine);
          else if (p.type === 'tool-result') sups.push(p as unknown as ToolResultLine | SubcallLine);
        } catch { /* 损坏行忽略 */ }
      }
    };
    if (this.storeDir !== undefined) {
      for (const f of [this.partialsPath(id), this.subcallsPath(id)]) {
        try { collect(fs.readFileSync(f, 'utf-8')); } catch { /* 无文件 = 空 */ }
      }
    }
    // 内存 pendingSups 后入（同身份覆盖语义由 readJournal 的 seen 去重天然实现：盘上旧行被跳过）
    for (const p of this.entries.get(id)?.activeRun?.pendingSups ?? []) {
      try {
        const parsed = JSON.parse(p.line) as ToolResultLine | SubcallLine;
        if (!seen.has(p.identity)) { seen.add(p.identity); sups.push(parsed); }
      } catch { /* 忽略 */ }
    }
    return { stepLines, injectLines, sups };
  }

  /** partials.jsonl 剔除已提升 run 的行（按行身份；全空 = 删文件） */
  private rewritePartials(id: string, identities: Set<string>): void {
    if (this.storeDir === undefined) return;
    const file = this.partialsPath(id);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const ident = journalIdentity(line);
      if (ident !== undefined && identities.has(ident)) continue;
      kept.push(line);
    }
    if (kept.length === 0) { try { fs.rmSync(file); } catch { /* 并发删无害 */ } return; }
    if (kept.length === lines.filter((x) => x.trim()).length) return; // 无剔除（幂等）
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, file);
  }

  /**
   * journal 恢复（崩溃窗口收口，惰性触发——ensureMessages 触达时）：
   * partials 有行但 messages 无对应 run 组员（进程死亡）→ 投影为中断收束
   * 段行提升进 messages（durable 定稿）→ 剔除 journal。幂等：重放提升批
   * 行身份一致（run 键锚定），已 settled 的 run 直接剔除。
   */
  private recoverJournal(entry: SubEntry): void {
    if (this.storeDir === undefined) return;
    const id = entry.record.id;
    const partFile = this.partialsPath(id);
    let raw: string;
    try {
      raw = fs.readFileSync(partFile, 'utf-8');
    } catch {
      return; // 无 journal = 无崩溃窗口
    }
    if (!raw.trim()) { try { fs.rmSync(partFile); } catch { /* 忽略 */ } return; }
    // messages 已 settled 的 run 键集（同 run 非 partial 行存在性——无单点锚）
    const settled = new Set<string>();
    try {
      for (const line of fs.readFileSync(this.messagesPath(id), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as { run?: unknown; role?: unknown; type?: unknown };
          if (typeof p.run === 'string' && p.run && p.type !== 'run-settled') settled.add(p.run);
        } catch { /* 忽略 */ }
      }
    } catch { /* 无 messages 文件 = 全部未 settled */ }
    // 按 run 分组 journal 行
    const runs = new Map<string, { stepLines: JournalStepLine[]; injectLines: JournalInjectLine[]; sups: Array<ToolResultLine | SubcallLine> }>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        if (typeof p.run !== 'string' || !p.run) continue;
        let bucket = runs.get(p.run);
        if (!bucket) { bucket = { stepLines: [], injectLines: [], sups: [] }; runs.set(p.run, bucket); }
        if (p.type === 'journal-step') bucket.stepLines.push(p as unknown as JournalStepLine);
        else if (p.type === 'journal-inject') bucket.injectLines.push(p as unknown as JournalInjectLine);
        else if (p.type === 'tool-result' && p.subcall !== true) bucket.sups.push(p as unknown as ToolResultLine);
      } catch { /* 损坏行忽略 */ }
    }
    if (runs.size === 0) { try { fs.rmSync(partFile); } catch { /* 忽略 */ } return; }
    const identities = new Set<string>();
    for (const [run, bucket] of runs) {
      if (settled.has(run)) {
        // 提升 批已 durable（append 后 clear 前崩溃）→ 直接剔除（幂等）
        for (const s of bucket.stepLines) identities.add(journalIdentityOf('journal-step', run, s.seq));
        for (const j of bucket.injectLines) identities.add(journalIdentityOf('journal-inject', run, j.seq));
        for (const s of bucket.sups) identities.add(journalIdentityOf('tool-result', run, s.tool_call_id));
        continue;
      }
      // 孤儿 run（进程死亡时未收束）→ 投影为中断收束段行
      const supMap = new Map<string, unknown>();
      for (const s of bucket.sups) supMap.set(s.tool_call_id, s.result);
      const merged = [
        ...bucket.stepLines.map((s) => ({ kind: 'step' as const, seq: s.seq, step: s.step })),
        ...bucket.injectLines.map((j) => ({ kind: 'inject' as const, seq: j.seq, line: j })),
      ].sort((a, b) => a.seq - b.seq);
      const segs: Array<NonNullable<SubagentMessageLine['steps']>> = [];
      const injects: JournalInjectLine[] = [];
      let seg: NonNullable<SubagentMessageLine['steps']> = [];
      for (const item of merged) {
        if (item.kind === 'step') { seg.push(item.step); continue; }
        segs.push(seg); seg = [];
        injects.push(item.line);
      }
      segs.push(seg);
      for (let i = 0; i < injects.length; i++) {
        if (segs[i] && segs[i].length > 0) {
          for (const st of segs[i]!) for (const tc of st.toolCalls ?? []) { const hit = supMap.get(tc.id); if (hit !== undefined) tc.result = hit; }
          this.appendMessage(id, { role: 'agent', content: segs[i]!.at(-1)?.content ?? '', agent_id: id, steps: segs[i]!, run });
        }
        const j = injects[i]!;
        this.appendMessage(id, { role: 'user', content: j.message.content, agent_id: j.agentId ?? entry.record.parentId, injected: true, run, ts: j.ts ?? Date.now() });
      }
      const tail = segs.at(-1)!;
      if (tail.length > 0) {
        for (const st of tail) for (const tc of st.toolCalls ?? []) { const hit = supMap.get(tc.id); if (hit !== undefined) tc.result = hit; }
        this.appendMessage(id, { role: 'agent', content: tail.at(-1)?.content ?? '', agent_id: id, steps: tail, run });
      }
      for (const s of bucket.stepLines) identities.add(journalIdentityOf('journal-step', run, s.seq));
      for (const j of bucket.injectLines) identities.add(journalIdentityOf('journal-inject', run, j.seq));
      for (const s of bucket.sups) identities.add(journalIdentityOf('tool-result', run, s.tool_call_id));
    }
    this.rewritePartials(id, identities);
  }

  /** messages.jsonl 行序号（判别行 seq 用；末行续起） */
  private nextMsgSeq(file: string): number {
    try {
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      const last = lines.at(-1);
      if (last) {
        const p = JSON.parse(last) as { seq?: unknown };
        if (typeof p.seq === 'number') return p.seq + 1;
      }
    } catch { /* 无文件/解析失败 = 1 */ }
    return 1;
  }

  /** reason 字面量赋值会让 TS 流分析把 abortReason narrow 成单值，致 1285
   * 的 timeout 比较被误判恒 false（看门狗 1173 的异步写点流分析不可见）——
   * 参数形式保住联合类型，勿内联字面量 */
  private stopRun(entry: SubEntry, reason: 'stop' | 'timeout' = 'stop'): boolean {
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
      // 派生身份补注册（跨重启/宿主重启后触达：注册面丢失即按当前父配置
      // 重派生——与 spawn 同源；父已注销则保持无注册，回落旧 fail-closed 口径）
      if (!this.ctx.agents.has(record.id)) {
        const parent = this.ctx.agents.get(record.parentId);
        if (parent) {
          try {
            this.ctx.agents.register(deriveAgentConfig(record, parent));
          } catch {
            /* 已注册竞态（并发触达）——忽略 */
          }
        }
      }
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

  infoOf(rec: SubagentRecord): SubagentInfo {
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
      deleted: rec.deleted,
      ...(rec.lastRun ? { lastRun: rec.lastRun } : {}),
    };
  }

  private registryPath(): string {
    return path.join(this.storeDir!, 'index.json');
  }

  /** 会话目录（三文件化 2026-12：<root>/subagents/<subId>/） */
  private subDir(id: string): string {
    return path.join(this.storeDir!, id);
  }

  /** 定稿流（messages.jsonl；迁移 v3 前的旧单文件 = <subId>.jsonl 回退） */
  private messagesPath(id: string): string {
    return fs.existsSync(path.join(this.storeDir!, `${id}.jsonl`))
      ? path.join(this.storeDir!, `${id}.jsonl`)
      : path.join(this.subDir(id), 'messages.jsonl');
  }

  /** run journal（partials.jsonl；旧单文件会话无此文件——空 journal 语义） */
  private partialsPath(id: string): string {
    return path.join(this.subDir(id), 'partials.jsonl');
  }

  /** 子调用档案（subcalls.jsonl；永久保留——与 journal 生命周期相反） */
  private subcallsPath(id: string): string {
    return path.join(this.subDir(id), 'subcalls.jsonl');
  }

  /** journal 行追加（步行/注入/补行统一入口；按行 kind 分流目标文件） */
  private appendJournalLine(entry: SubEntry, line: JournalStepLine | JournalInjectLine | ToolResultLine | SubcallLine): void {
    if (this.storeDir === undefined) return; // 纯内存态：journal 只服务 settlement（内存态无中间态可恢复）
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上：判别键的运行时判别
      const isSub = (line as SubcallLine).subcall === true;
      const file = isSub ? this.subcallsPath(entry.record.id) : this.partialsPath(entry.record.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf-8');
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] journal 落盘失败（${entry.record.id}）: ${String(err)}`);
    }
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 盘上 JSON 宽容读（旧注册表可缺 subs/有坏行）
      for (const rec of parsed.subs ?? []) {
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
      // journal 恢复（惰性触发——触达即收口崩溃窗口）+ 活投影读取
      this.recoverJournal(entry);
      try {
        const raw = fs.readFileSync(this.messagesPath(entry.record.id), 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line.trim() || isRunSettledLine(line)) continue;
          try {
            const parsed = JSON.parse(line) as SubagentMessageLine;
            if (typeof parsed.content === 'string') {
              // 回放口径归一：agent/assistant → assistant；context 行不进
              // 子上下文（错误/材料行是会话展示事实，非对话轮；error 收束行
              // 2026-12 起写 context，存量 user+source:error 行仍走 user 回放，
              // 行为同旧）。agent 行携带 steps 时按 expandSteps 轨迹展开
              // （2026-12 多轮失忆修复：与主会话 replayTrajectory 同口径——
              // 探查型/中断 run 无终文本也不丢推理与工具结果对；result:null
              // 悬空调用由 expandSteps 合成配对 tool 行，openai 系不拒单）。
              // 旧无 steps 行照旧只回放 content。
              if (parsed.role === 'user') lines.push({ role: 'user', content: parsed.content });
              else if (parsed.role === 'agent' || parsed.role === 'assistant') {
                if (parsed.steps !== undefined && parsed.steps.length > 0) {
                  lines.push(...expandSteps(parsed.steps));
                } else if (parsed.content) {
                  lines.push({ role: 'assistant', content: parsed.content });
                }
              }
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

  /**
   * 会话行追加（SubagentMessageLine 全形；尽力而为，失败不阻塞）。
   * message_id/timestamp 此处铸造（对齐 ac-session：落盘前固化）。
   */
  private appendMessage(id: string, line: Omit<SubagentMessageLine, 'message_id' | 'ts' | 'timestamp'> & { ts?: number }): void {
    if (this.storeDir === undefined) return;
    try {
      const dir = this.subDir(id);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ts = line.ts ?? Date.now();
      const { ts: _ts, ...rest } = line;
      const full: SubagentMessageLine = {
        message_id: genMessageId(),
        ts,
        timestamp: new Date(ts).toISOString(),
        ...rest,
      };
      fs.appendFileSync(this.messagesPath(id), `${JSON.stringify(full)}\n`, 'utf-8');
    } catch (err: unknown) {
      this.ctx.logger.warn(`[subagent] 会话落盘失败（${id}/${line.role}）: ${String(err)}`);
    }
  }

  // ============================================================
  // subagent 工具（spawn/send/await/list/stop/delete 单工具 action 分发）
  // ============================================================

  /**
   * 缺参/错 id 提前校验（工具返回层）：给最常见的两类失败附上下文引导——
   *   · send/await 缺 subagent_id 且名下零子 Agent → 大概率工具拿错
   *     （send_agent 语义串线，news 事故 #3），报错直接点破并指路；
   *   · id 不存在 → 附近似候选（防手写/记忆复写 id 抄错，如 `…zqql_`）。
   * 通过则返回 undefined，执行继续。
   */
  private earlyCheck(args: Record<string, unknown>, parentId: string): ToolResult | undefined {
    if (args.action === 'list' || args.action === 'spawn') return undefined;
    const id = String(args.subagent_id ?? '');
    if (!id) {
      if (args.action === 'send' || args.action === 'await' || args.action === 'stop' || args.action === 'delete') {
        const owned = this.list({ parentId }).total;
        if (owned === 0) {
          return {
            ok: false,
            error: `缺少 subagent_id：当前没有任何子 Agent（action="${String(args.action)}" 只对已 spawn 的子 Agent 有意义）。若意图是给其他 Agent 或用户发消息 → send_agent；发群消息 → send_group；要派新任务 → action="spawn"`,
            output: { hint: HINT_AGENT_MESSAGING },
          };
        }
        return { ok: false, error: `缺少 subagent_id 参数（spawn 返回的 subagent_id，可 action="list" 查询）` };
      }
      return undefined;
    }
    // id 给了但不存在（含墓碑）：附近似候选
    if (this.get(id) === undefined) {
      const rec = this.records.get(id);
      if (rec?.deleted === true) {
        return {
          ok: false,
          error: `子 Agent "${id}" 已删除（delete 后不可再触达；需要时重新 spawn）`,
        };
      }
      const candidates = this.nearbyIds(id);
      return {
        ok: false,
        error:
          `子 Agent "${id}" 不存在。`
          + (candidates.length > 0
            ? `近似候选：${candidates.join(' / ')}`
            : '名下暂无子 Agent（action="list" 查询；spawn 创建）'),
      };
    }
    return undefined;
  }

  /** id 近似候选（前缀最长匹配 ≤3 个；含已删除——报错提示用） */
  private nearbyIds(id: string): string[] {
    // 剥离常见誊写噪声（尾缀/引号）
    const needle = id.replace(/[_'"\s]+$/, '');
    const hits: string[] = [];
    for (const key of this.records.keys()) {
      if (key === needle) continue;
      // 候选 = needle 是 key 的前缀，或 key 是 needle 的前缀（≥8 字符才有区分度）
      if ((key.startsWith(needle) || needle.startsWith(key)) && Math.min(key.length, needle.length) >= 8) {
        hits.push(key);
      }
      if (hits.length >= 3) break;
    }
    return hits;
  }

  private registerTool(): void {
    this.ctx.tools.register({
      name: 'subagent',
      description:
        '派出子 Agent 执行可并行的调研/验证类子任务（全新独立会话，不接触任何接收方）。'
        + 'spawn 创建并可选启动首条任务（任务角色定位/专业人设/输出约束 → system 参数）；send 对已创建的子 Agent 续聊（mode：async 立即返回/sync 阻塞等回复/steer 注入进行中的 run/next-run 排队到下一轮）；await 等待并取当前结果；list 查询（含历史）；stop 停止当前推理（保留会话，可继续 send）；delete 删除（list 不再可见）。'
        + '注意：本工具管理的是"你私有的子 Agent 看板"，子 Agent 的回复只返回给你——它不能替你向用户或其他 Agent 转达/推送/通知任何内容；要给其他 Agent 或用户发消息用 send_agent，要发群消息用 send_group。'
        + '长输出指引：预期产出长文本（报告/清单/多文件分析等）时，在输出约束里要求子 Agent 把完整产出写入文件（给明确路径），回复只报路径与要点摘要——长回复走回传通道会撞输出体积预算被截断（头尾保留、中段丢失）；需要细节时再 read 该文件（可分页无损读取）。',
      requiredTags: ['delegation'],
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['spawn', 'send', 'await', 'list', 'stop', 'delete'],
            description: '操作',
          },
          task: {
            type: 'string',
            description:
              '[spawn] 首条任务消息，需完整自包含（子 Agent 看不到你的会话）——把内容完整写进本参数，不要"请转交以下内容："式截断。任务的角色定位/专业视角/输出约束放 system 参数（固化人设，勿混进 task）。长文本产出类任务的输出约束建议写明：完整结果写入指定文件、回复只给路径+要点（长回复会被截断）。省略则仅创建不启动，之后用 send 发首条',
          },
          name: { type: 'string', description: '[spawn] 子 Agent 名称' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              '[spawn] 子 Agent 可用的工具名清单（须是你有权分派的能力的子集，越权名会被过滤）。缺省不传 = 继承你的工具面。程序化模式随会话传播（与点名无关）：程序化档下子 Agent 的 LLM 面恒为 run_code 单入口，点名的工具不丢失——它们进 run_code SDK 投影，程序内 tools.<name>() 照常可调；tc-base 档下点名集才直接成为 LLM 面。传空数组 [] = 纯推理子 Agent（tc-base 档下无任何工具；程序化档被 mode 集覆盖）',
          },
          system: {
            type: 'string',
            description: '[spawn] 子 Agent 的 system prompt（人设/行为约束）。传入即固化（跨轮/跨重启）并完全接管人格语义——不继承父 Agent 的人设与 persona 配置；缺省 = 继承父。框架块（系统环境/工具指引）与程序化模式的 SDK 投影仍会自动追加，无需手写',
          },
          subagent_id: {
            type: 'string',
            description: '[send/await/stop/delete] 目标子 Agent ID（spawn 返回的 subagent_id，可 list 查询；勿凭记忆复写）',
          },
          message: {
            type: 'string',
            description: '[send] 给该子 Agent 的消息内容（自包含，或基于该子 Agent 已有进展的追问/补充指示）——不是给其他 Agent 的消息',
          },
          mode: {
            type: 'string',
            enum: ['async', 'sync', 'steer', 'next-run'],
            description:
              '[send] 投递语义：async（缺省）立即返回，忙时排队；sync 阻塞到消费本条消息的 run 收束并返回结果；steer 注入当前 run 的下一步（空闲则开新 run）；next-run 排队到当前 run 收束后独立执行（async 忙时同此）',
          },
          timeout_s: { type: 'number', description: '[spawn] 每轮 run 超时秒数（0 = 缺省不限——研究型任务常为长任务；正值 = 超时强制终止）', minimum: 0 },
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
        // ── 误用护栏（2026-09-16 news 事故复盘）───────────────────────
        // ① 未知参数 = 工具拿错的最强信号（当时 send_agent 的 message 正文
        //    塞进 subagent(send) 被静默丢弃）→ 立即报错并指路，不放行半截内容。
        const unknownArgs = Object.keys(args).filter((k) => !KNOWN_ARG_KEYS.has(k));
        if (unknownArgs.length > 0) {
          const lost = unknownArgs.filter(
            (k) => typeof args[k] === 'string' && String(args[k]).trim() !== '',
          );
          return {
            ok: false,
            error:
              `未知参数 ${unknownArgs.join('/')}：本工具没有这些参数，其中的内容不会送达任何接收方。`
              + (lost.length > 0
                ? `其中 ${lost.join('/')} 携带了内容——疑似想用别的工具（给其他 Agent/用户发消息 → send_agent；发群消息 → send_group；给已创建的子 Agent 发任务消息 → 本工具 action="send" 且须带 subagent_id）。`
                : '请核对参数表后重试。'),
            output: { hint: HINT_AGENT_MESSAGING },
          };
        }
        // ② 缺参/错 id 提前校验：错误信息附上下文引导（零子 Agent 时点破
        //    "工具拿错"，id 近似时给出候选）
        const parentId = call.agentId ?? '__host__';
        const early = this.earlyCheck(args, parentId);
        if (early !== undefined) return early;
        // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
        switch (args.action) {
          case 'spawn': {
            const task = String(args.task ?? '').trim();
            if (!task && (Number(args.wait_time) || 0) > 0) {
              return { ok: false, error: 'spawn 未给 task 时没有可等待的 run（wait_time 仅在带任务启动时有效）' };
            }
            // 冒号/引号截断嫌疑：task 以"请转交/请输出以下内容：""请发送："等
            // 引导语+冒号结尾而正文不在 task 里（news 事故 #2：正文在未知参数
            // message 中丢失，子 Agent 只收到半句话）
            if (/[:：][""'』」]?$/.test(task) && task.length <= 60) {
              return {
                ok: false,
                error: `task 疑似被截断（以冒号结尾）："${task.slice(0, 40)}…"——引导语后的正文没有出现在 task 参数里。请把完整内容一并放进 task（子 Agent 看不到你的其他参数或会话）`,
                output: { hint: HINT_AGENT_MESSAGING },
              };
            }
            const spawned = this.spawn({
              parentId,
              ...(args.name ? { name: String(args.name) } : {}),
              ...(task ? { task } : {}),
              ...(typeof args.system === 'string' && args.system.trim() ? { system: args.system } : {}),
              ...(Array.isArray(args.tools) ? { toolNames: args.tools.map((s: unknown) => String(s)) } : {}),
              ...(Number(args.timeout_s) >= 0 ? { timeoutMs: Math.round(Number(args.timeout_s) * 1000) } : {}),
              ...(call.conversationId ? { conversationId: call.conversationId } : {}),
              ...(call.elevation === 'sandbox-access' || call.elevation === 'full-access' ? { elevation: call.elevation } : {}),
            });
            if ((Number(args.wait_time) || 0) > 0 && spawned.settled) {
              const s = await spawned.settled;
              if (s.status !== 'done') {
                return {
                  ok: false,
                  error: s.error || `首轮 run 未完成（status=${s.status}）`,
                  output: { action: 'spawn', subagent_id: spawned.info.id, status: s.status },
                };
              }
              return {
                ok: true,
                output: {
                  action: 'spawn',
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
                action: 'spawn',
                subagent_id: spawned.info.id,
                name: spawned.info.name,
                task: task.slice(0, 120),
                status: spawned.info.status,
                message:
                  spawned.info.status === 'running'
                    ? `子 Agent "${spawned.info.id}" 已创建并启动（子 Agent 的回复只返回给你，不会送达任何用户或其他 Agent）：用 subagent(action="await", subagent_id) 收结果，subagent(action="send", subagent_id) 续聊`
                    : `子 Agent "${spawned.info.id}" 已创建（未启动）：用 subagent(action="send", subagent_id) 发首条任务`,
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
              ...(call.elevation === 'sandbox-access' || call.elevation === 'full-access' ? { elevation: call.elevation } : {}),
            });
            if (mode === 'sync' && r.settled) {
              const s = await r.settled;
              return {
                ok: true,
                output: {
                  action: 'send',
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
              started: '已启动新 run——结果仅返回给你（子 Agent 不能替你向任何接收方转达）；要收结果用 subagent(action="await", subagent_id) 或改用 mode="sync"',
              steered: '已注入当前 run 的下一步',
              queued: '已排队（当前 run 收束后自动消费）',
            };
            return {
              ok: true,
              output: {
                action: 'send',
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
                output: { action: 'await', subagent_id: id, status: 'idle', message: '尚未运行过（send 可启动首轮）' },
              };
            }
            return {
              ok: true,
              output: {
                action: 'await',
                subagent_id: id,
                status: s.status,
                finish: s.finish,
                ...(s.result !== undefined ? { result: s.result } : {}),
                ...(s.error !== undefined ? { error: s.error } : {}),
                elapsed_ms: s.finishedAt - s.startedAt,
                // 触达语义（news 事故 #7）：result 只回到父的执行上下文，
                // 不构成对任何用户/Agent/群的投递——需要转达时另行调用
                // send_agent / send_group。
                note: 'result 是子 Agent 给你的回话（仅本会话可见）——尚未投递给任何用户、Agent 或群；需要转达请另行调用 send_agent / send_group',
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
                action: 'list',
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
              output: { action: 'stop', subagent_id: id, stopped: true, message: '已请求停止（run 将在步边界收束；会话保留，可继续 send 续聊）' },
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
              output: { action: 'delete', subagent_id: id, deleted: true, message: '已标记删除（list 不再可见；会话文件保留）' },
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
