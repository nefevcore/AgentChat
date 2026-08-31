// ============================================================
// ac-session —— 会话历史服务（事件积累 + 持久化后端）
//
// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— 回放投影
// （history viewer 变换）是确定性纯函数，输入不变则字节不变；概要头
// 直通。显式失效：compact/归档重建 = invalidate-from-head（一次性）。
// 幂等固化字段（message_id/timestamp）只进落盘行，绝不进 LLM 请求体。
//
// src 轨道映射（M10 持久化基座）：agent-session 的 writer 队列语义
// 【原样继承】（资产 #2：按文件串行 / WeakSet 引用幂等 / append+fsync /
// quiescence barrier / 失败批次回队首）+ 幂等 message_id 固化（资产：
// 同一消息对象重复入队产出同一 id 行）。
//
// 记录通道（事件积累，零注入 router/loop/conversation）：
//   · router/message-received  → 入站 user 消息入账
//   · router/reply-completed   → 回复入账 + 落盘
//   · conversation/steered     → steer 注入消息入账（M10 补齐：steer 不经
//     router，靠本事件进会话流——历史不断流）
//   · tool/before-execute      → fail-closed checkpoint：排空当前会话队列
//     （M11 执行身份定向化：按 call.conversationId flush，无身份退回
//     flushAll）后才放行工具执行；落盘失败则 veto（工具执行前入站消息
//     必已 durable）
//
// 存储约定（ADR-5：本服务 owns 会话文件；规约 2：叶子目录名即
// conversationId，无排序/前缀魔法）：
//   <root>/sessions/<conversationId>/messages.jsonl   消息流（append-only）
//   <root>/sessions/<conversationId>/summary.md       概要（压缩后）
//   <root>/sessions/<shelf>/<conversationId>/         上架会话（管理域组织：
//     独立会话归 sessions/singles/<ws|ungrouped>/<sid>/——索引持久化
//     .shelves.json，寻址仍是 conversationId，规约 2 不破）
//
// 入账粒度 = 对话级 + 思维链/步记录/事件标注（Port B P3 + M18 #6）。
// 【M21/D13 中性格式】落盘行是读者无关的中性事实（session-design §2.2）：
// 一切真实发言（人类入站 / Agent 出站 / steer 注入 / 私信）= role:'agent'
// + agent_id=说话人端点；机制触发 = role:'event'；run 错误收束 =
// role:'error'（D12/F7——错误不再伪装 assistant 文本）。角色由回放投影
// 按读者赋予（history() 的 viewer 变换，§2.4）——存储层永不烘死视角。
// assistant 行附整轮 reasoning_content 与 steps[]（ReAct 各步正文/思考/
// 工具调用对，刷新后按步重建工具卡片）。steps 缺省不进 history() 的
// LLM 回放（对话级语义——工具中间态只服务 UI 展示与审计）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { isArchiveReviewRun, type LoopRunResult } from 'ac-agent-loop'; // loop/* 事件目录（type-only）
import { isGroupHint } from 'ac-group';
import type { LlmMessage, LlmRole } from 'ac-llm';
import type {} from 'ac-router'; // router/* 事件目录（type-only）
import type {} from 'ac-conversation'; // conversation/* 事件目录（type-only）

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface SessionRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；会话目录 = <root>/sessions） */
  root?: string;
}

/** 热力时间窗消息计数（运行矩阵色阶数据源；h1/dN = 最近 N 时间窗内消息数） */
export interface SessionWindowCounts {
  h1: number;
  d1: number;
  d3: number;
  d7: number;
  d30: number;
}

/** 中性格式行角色（M21/D13）：话语类别，读者无关——一切真实发言 = 'agent'，归属由 agent_id 标记 */
export type SessionRecordRole = 'agent' | 'system' | 'tool' | 'error' | 'event';

/** 持久化行（append-only jsonl；归档去重/审计消费 message_id） */
export interface SessionRecord {
  /**
   * 行角色（话语类别，读者无关）：
   * - 'agent' = 一切真实发言（人类入站/Agent 出站/steer/私信），归属 agent_id；
   * - 'event' = 机制触发（UI 分隔符）；'error' = run 错误收束（UI 错误分隔符）；
   * - 'system'/'tool' 预留（概要经 summary.md、轨迹展开是回放投影非存储）。
   * 兼容读取：无 session-header 的旧文件按 baked 格式（'user'/'assistant' + name）
   * 宽容解析（§2.4 兼容路径；迁移见 docs/session-design.md §8-D13）。
   */
  role: SessionRecordRole | 'user' | 'assistant';
  content: string;
  message_id: string;
  timestamp: string;
  /**
   * 说话人端点 id（中性格式完备归属标记，取代旧 name）：一切 role:'agent'
   * 行必有；viewer/人类/Agent 端点同词汇（M19 端点对等贯穿到存储层）。
   * 回放投影（history）按 agent_id===viewer → assistant 赋予角色。
   */
  agent_id?: string;
  /** 旧 baked 格式说话人标注（读取兼容；新写不再产生——由 agent_id 取代） */
  name?: string;
  /** 事件/错误来源标注（role:'event'/'error' 行；诊断用） */
  source?: string;
  /** 思维链全文（agent 回复行；run 各步 reasoning 拼接，Port B P3） */
  reasoning_content?: string;
  /**
   * ReAct 步记录（agent 回复行；M18 反馈 #6——刷新后工具调用卡片不丢）。
   * 每步含正文/思考与工具调用对（arguments 原始 JSON 串 + result 为
   * ToolResult 对象）；history() LLM 回放不消费本字段（对话级语义）。
   */
  steps?: SessionStepRecord[];
  /**
   * 单调序号（M21 步骤 7 / D8：writer 按文件单调分配）。旧行无 seq
   * 视为缺失（行为不变）；收益：崩溃/丢行检测（断裂 = 有损）+ 归档
   * 二次去重序号锚（取代内容匹配）。
   */
  seq?: number;
}

/** 会话头行（版本锚点，M21 步骤 7 / §3.2）：新会话文件首行 */
export interface SessionHeader {
  type: 'session-header';
  /** 格式版本：**v1 即中性格式**（D13——role agent|system|tool|error|event + agent_id） */
  version: 1;
  createdAt: string;
}

/** 头行文本（writer 首建文件时入队；compact 等重写路径按存在性保留） */
function headerLine(): string {
  return JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date().toISOString() } satisfies SessionHeader);
}

/** 合法行角色词表（中性格式 D13 五词 + 旧 baked 兼容词；records/tail 共用谓词） */
const KNOWN_ROLES = new Set(['agent', 'error', 'event', 'user', 'assistant', 'system', 'tool']);

/** 行前缀判定（避免全量 JSON.parse；统计口径排除头行用） */
function isHeaderLine(line: string): boolean {
  return line.trimStart().startsWith('{"type":"session-header"');
}

/** 行 seq 读取（损坏/无 seq → undefined） */
function seqOfLine(line: string): number | undefined {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === 'number' && seq > 0 ? seq : undefined;
  } catch {
    return undefined;
  }
}

/** 行 → 归一化 SessionRecord（records/tail 共用解析核：词表校验 + `?? ''` 默认值 + 条件展开；损坏/未知词表 → undefined） */
function parseRecordLine(line: string): SessionRecord | undefined {
  let parsed: Partial<SessionRecord>;
  try {
    parsed = JSON.parse(line) as Partial<SessionRecord>;
  } catch {
    return undefined;
  }
  if (typeof parsed.role !== 'string' || !KNOWN_ROLES.has(parsed.role)) return undefined;
  return {
    role: parsed.role,
    content: parsed.content ?? '',
    message_id: parsed.message_id ?? '',
    timestamp: parsed.timestamp ?? '',
    ...(typeof parsed.seq === 'number' && parsed.seq > 0 ? { seq: parsed.seq } : {}),
    ...(parsed.agent_id !== undefined ? { agent_id: parsed.agent_id } : {}),
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.source !== undefined ? { source: parsed.source } : {}),
    ...(parsed.reasoning_content !== undefined ? { reasoning_content: parsed.reasoning_content } : {}),
    ...(parsed.steps !== undefined ? { steps: parsed.steps } : {}),
  };
}

/** 记录集最大 seq（无 seq 行忽略；空集 → undefined）——重写窗口基线用 */
export function maxSeqOf(records: Array<{ seq?: number }>): number | undefined {
  let max: number | undefined;
  for (const r of records) {
    if (typeof r.seq === 'number' && r.seq > (max ?? 0)) max = r.seq;
  }
  return max;
}

/** 半行可救判定：JSON 完整且形如会话行/头行（撕裂点在换行前的记录本体） */
function isValidRecordLine(line: string): boolean {
  if (isHeaderLine(line)) return true;
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line) as { role?: unknown };
    return typeof parsed.role === 'string' && parsed.role.length > 0;
  } catch {
    return false;
  }
}

/** 步记录（assistant 行的 steps[] 元素形状） */
export interface SessionStepRecord {
  content: string;
  reasoning?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    /** 参数原始 JSON 字符串（前端按需 parse 展示） */
    arguments: string;
    /** 工具体返回的 ToolResult（对象原样 JSON 往返） */
    result: unknown;
  }>;
}

/** 会话键校验：禁路径分隔/遍历（文件名即 conversationId） */
function assertConversationId(conversationId: string): void {
  if (
    !conversationId ||
    conversationId.includes('/') ||
    conversationId.includes('\\') ||
    conversationId.includes('..')
  ) {
    throw new Error(`conversationId "${conversationId}" 非法（禁路径分隔/遍历字符）`);
  }
}

/** 生成消息唯一 ID（幂等固化前铸造；对齐 src genMessageId） */
function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 行内时间戳提取（避免全量 JSON.parse；无/坏时间戳不计窗） */
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

/** 按记录时间戳统计各时间窗内消息数（热力色阶数据源；纯函数） */
export function countWindowMessages(jsonlText: string, now: number): SessionWindowCounts {
  const out: SessionWindowCounts = { h1: 0, d1: 0, d3: 0, d7: 0, d30: 0 };
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    const m = TIMESTAMP_RE.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) continue;
    const age = now - t;
    if (age < 3_600_000) out.h1++;
    if (age < 86_400_000) out.d1++;
    if (age < 3 * 86_400_000) out.d3++;
    if (age < 7 * 86_400_000) out.d7++;
    if (age < 30 * 86_400_000) out.d30++;
  }
  return out;
}

/**
 * 回放投影（M21 §2.4 视角变换，纯函数）：存储中性（role 记话语类别、
 * agent_id 记归属）⇒ 角色完全由回放按读者赋予——
 *   role='agent' && agent_id === viewer → assistant（我自己说的话）
 *   role='agent' && 其他                → user（别人说的，无论对方是谁）
 *   role='event' | 'error'              → user（机制提示/错误的 LLM 语义位）
 *   role='system'                       → system（直通，不参与变换）
 * 产物行 = { role, content, name: agent_id }（wire 形说话人标注——确定性
 * 派生，不影响前缀稳定）。
 * 兼容路径（迁移期，§8-D13）：无 agent_id 的旧 baked 行按
 * name===viewer→assistant、其余→user、event→user 变换——user⇄x 直答桶
 * 与现状逐字节一致（恒等门）；assistant 行缺 name 时归属回落
 * conversationId（singles 形态：会话键 = Agent id，旧行省略 name）。
 */
export function projectRecord(
  r: SessionRecord,
  viewer: string | undefined,
  conversationId?: string,
): LlmMessage {
  if (r.agent_id !== undefined) {
    // D13 新格式：agent_id 在场 → 自他归属按读者投影（自己的话 assistant）
    let role: LlmRole;
    if (r.role === 'agent') {
      role = viewer !== undefined && r.agent_id === viewer ? 'assistant' : 'user';
    } else if (r.role === 'event' || r.role === 'error') {
      role = 'user';
    } else if (r.role === 'system' || r.role === 'tool') {
      role = r.role;
    } else {
      role = 'user'; // 防御：未知词表按 user 喂回
    }
    return { role, content: r.content, name: r.agent_id };
  }
  if (viewer === undefined) {
    // 匿名读者：旧 baked 行按原 role 直通（与既有 history 行为一致）
    return {
      role: (r.role === 'event' ? 'user' : r.role) as LlmRole,
      content: r.content,
      ...(r.name !== undefined ? { name: r.name } : {}),
    };
  }
  const attribution =
    r.name ?? (r.role === 'assistant' && conversationId !== undefined ? conversationId : undefined);
  // 事件行恒按 user 喂回（机制提示的 LLM 语义位——不参与自他归属判定）
  let role: LlmRole;
  if (r.role === 'event') {
    role = 'user';
  } else if (r.role === 'system') {
    role = 'system';
  } else {
    role = attribution === viewer ? 'assistant' : 'user';
  }
  return { role, content: r.content, ...(attribution !== undefined ? { name: attribution } : {}) };
}

/**
 * 轨迹展开（M21/D14，§2.5）：viewer 自己的回复行 steps[] → run 内消息序
 * 复现——每步 assistant(tool_calls?) + 配对 tool 结果行（tool_call_id 配对，
 * content = 结果 JSON 串——与 loop 运行时同构[脱敏/往返漂移已显式接受]）→
 * 终 assistant(content)。reasoning 不回传（M4）。
 */
function expandTrajectory(r: SessionRecord): LlmMessage[] {
  if (r.steps === undefined || r.steps.length === 0) {
    return [projectRecord(r, r.agent_id, undefined)];
  }
  const out: LlmMessage[] = [];
  for (const s of r.steps) {
    const calls = s.toolCalls ?? [];
    out.push({
      role: 'assistant',
      content: s.content ?? '',
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    });
    for (const tc of calls) {
      out.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(tc.result ?? null),
      });
    }
  }
  return out;
}

/** writer 队列（src SessionLogWriter 语义原样：按文件串行 + barrier + 失败回队首） */
interface LogQueue {
  file: string;
  pending: string[];
  /** 已入队过的消息对象引用——同一对象对同一文件只落盘一次（跨数组/跨 run 幂等） */
  seen: WeakSet<object>;
  /** 下一行序号（M21/D8：writer 按文件单调分配；建队时从盘上末行续起） */
  nextSeq: number;
  active?: Promise<void>;
  barrier?: Promise<void>;
}

export class SessionService extends Service {
  private sessionsDir: string;
  private queues = new Map<string, LogQueue>();
  /**
   * 幂等固化登记（消息对象 → id/timestamp）：同一对象重复入队产出同 id 行，
   * 且不变异消息对象本身（固化字段绝不随消息引用流回 provider 请求体，
   * M21 §8.2-C 字节分叉修复）。
   */
  private solids = new WeakMap<object, { message_id: string; timestamp: string }>();
  /**
   * 会话上架索引（conversationId → shelf 相对路径，如 'singles/<ws>'）：
   * 独立会话等管理域把会话目录归入子文件夹时登记；寻址仍是
   * conversationId（叶子目录名不变，规约 2 保持——上架是数据不是命名魔法）。
   * 持久化 <root>/sessions/.shelves.json；shelf 根目录放 .shelf 标记
   * （ids() 不把 shelf 目录当作会话）。
   */
  private shelfIndex = new Map<string, string>();
  private shelfFile: string;
  /** stats() 热窗缓存（file → mtime/size 对应的窗口计数；轮询零重算） */
  private windowCache = new Map<string, { mtimeMs: number; size: number; windows: SessionWindowCounts; messageCount: number }>();

  constructor(ctx: Context, options: SessionRowOptions = {}) {
    super(ctx, 'session');
    this.sessionsDir = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'sessions');
    this.shelfFile = path.join(this.sessionsDir, '.shelves.json');
    this.loadShelfIndex();

    // ---- 记录通道（订阅即归属：随本服务 fiber 卸载撤销） ----
    // 【M21/D13 中性入账】一切真实发言 = role:'agent' + agent_id=说话人端点
    // （入站 = sender、回复 = 回复 Agent、steer = 注入方）；机制触发
    // （source='event'）= role:'event' + agent_id=目标自身（§2.3）。
    // 角色由回放投影按读者赋予（§2.4）——写入侧不猜读者是谁。旧 baked
    // 模型"投递目标是虚拟端点须记 assistant"的特判随切换删除（agent→viewer
    // 私信就是 role:'agent' + agent_id=说话 Agent，无需猜方向）。
    this.ctx.on('router/message-received', (agentId, message, conversationId, sender, source, meta) => {
      // 机制标记 run（归档整理）不入账：整理提示词是机制产物，非会话事实
      // （M20：通道回归 router 后由显式标记跳过，替代旧的"绕开 router"）
      if (isArchiveReviewRun(meta)) return;
      // 群 hint 投递触发（M21/F6①）：事实行已由 post 入群本体（ac-group
      // owning），逐成员 hint 不重复入账（修影子桶按成员重复 N 次）——
      // 该 run 的回复照常入账（回复是会话事实，reply-completed 不查本键）
      if (isGroupHint(meta)) return;
      if (source === 'event') {
        this.record(conversationId, agentId, message, { roleOverride: 'event', source: 'event' });
        return;
      }
      this.record(conversationId, sender ?? 'user', message);
    }, { description: '入站消息入账（对桶 + name 说话人）' });
    this.ctx.on('conversation/steered', (agentId, message, conversationId, _handle, sender, _source, meta) => {
      // steer 注入的说话人 = 注入方端点（deliver 调用者），非桶主；
      // 机制标记 run / 群 hint 触发同样不入账（M20 / M21-F6①）
      if (isArchiveReviewRun(meta)) return;
      if (isGroupHint(meta)) return;
      this.record(conversationId, sender ?? agentId, message);
    }, { description: 'steer 消息入账' });
    this.ctx.on('router/reply-completed', (agentId, text, result, conversationId, _sender, _source, meta) => {
      this.onReplyCompleted(agentId, text, result, conversationId, meta);
    }, { description: '回复入账 + checkpoint 定向 flush' });
    // fail-closed checkpoint（M11 定向化）：工具执行前排空该会话的写队列
    // （执行身份 call.conversationId 定向 flush，不再 flushAll 串台放大）；
    // 无身份（宿主直调 ctx.tools）时退回 flushAll 保底。落盘失败则 veto。
    this.ctx.on('tool/before-execute', async (execution, next) => {
      try {
        const conversationId = execution.call.conversationId;
        if (typeof conversationId === 'string' && conversationId) {
          await this.flush(conversationId);
        } else {
          await this.flushAll();
        }
        return next();
      } catch (err: unknown) {
        return {
          ok: false as const,
          error: `会话持久化 checkpoint 失败，已阻止工具执行：${String(err)}`,
        };
      }
    }, { description: 'fail-closed checkpoint：定向 flush 后放行' });
    // 卸载收尾：排空队列（优雅关闭；失败记日志不阻塞 dispose）
    this.ctx.fiber.effect(
      () => () =>
        this.flushAll().catch((err: unknown) => {
          this.ctx.logger.warn(`[session] 卸载排空队列失败: ${String(err)}`);
        }),
      'session.writer-flush',
    );
  }

  /** 落盘尽力而为（失败记日志不阻塞 emit 链） */
  private flushBestEffort(conversationId: string, subject: string): void {
    void this.flush(conversationId).catch((err: unknown) => {
      this.ctx.logger.warn(`[session] ${subject}落盘失败（${conversationId}）: ${String(err)}`);
    });
  }

  /** 回复入账（D13 中性：role:'agent' + agent_id=回复 Agent；错误收束 role:'error'；steps/reasoning 随行落盘） */
  private onReplyCompleted(
    agentId: string,
    text: string,
    result: LoopRunResult,
    conversationId: string,
    meta: Record<string, unknown> | undefined,
  ): void {
    if (isArchiveReviewRun(meta)) return; // 机制标记 run 的回复不入账（M20）
    // 错误收束一等化（D12/F7，§2.3）：role:'error'——UI 错误分隔符，
    // LLM 回放按 user 喂回（告知"出了错"而无自他归因污染）；不再以
    // `[error]` 前缀伪装 assistant 文本落盘。
    if (result.finish === 'error') {
      this.record(conversationId, agentId, { role: 'user', content: String(result.error ?? '循环失败') }, {
        roleOverride: 'error',
        source: 'error',
      });
      this.flushBestEffort(conversationId, '错误行');
      return;
    }
    if (!text) return; // 中断/空回复不入账
    // 思维链持久化（Port B P3）：run 各步 reasoning 拼接为整轮 thinking，
    // 刷新后历史回放可恢复思维链折叠栏。
    const reasoning = result.steps
      .map((s) => s.reasoning?.trim())
      .filter((r): r is string => !!r)
      .join('\n\n');
    // 步记录持久化（M18 反馈 #6）：工具调用对随 assistant 行落盘——
    // 刷新后 toHistoryMessages 按步重建 assistant+tool 气泡（与直播/
    // resume 快照同构），工具卡片不再丢失。
    const steps: SessionStepRecord[] = result.steps
      .map((s) => ({
        content: s.text,
        ...(s.reasoning ? { reasoning: s.reasoning } : {}),
        ...(s.toolCalls.length > 0
          ? {
              toolCalls: s.toolCalls.map((tc, i) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                result: s.toolResults[i] ?? null,
              })),
            }
          : {}),
      }))
      .filter((s) => s.content || s.reasoning || (s.toolCalls !== undefined && s.toolCalls.length > 0));
    this.record(
      conversationId,
      agentId,
      { role: 'user', content: text },
      {
        ...(reasoning ? { reasoning } : {}),
        ...(steps.length > 0 ? { steps } : {}),
      },
    );
    this.flushBestEffort(conversationId, '回复');
  }

  // ============================================================
  // 入账（事件订阅调用；enqueue 不写盘，等待 flush 批量落）
  // ============================================================

  /**
   * 入账一条消息（幂等：同一对象对同一会话只入队一次；id/timestamp 经
   * WeakMap 固化——同一消息对象重复入队产出同 id 行，且**不变异消息对象**
   * 本身：固化字段只进落盘行，绝不随消息引用流回 provider 请求体
   * ——M21 §8.2-C 字节分叉的修复点）。
   * 【D13 中性写入】行角色 = 话语类别：缺省 'agent'（一切真实发言），
   * extra.roleOverride 供机制行（'event'/'error'）；归属 = agent_id 参数
   * （说话人端点），message.role 不再参与落盘形态。
   * @returns 落盘行 message_id（D11：群本体经本口入账，行 id 与
   *   GroupFeed 锚点/message_id 对齐）
   */
  private record(
    conversationId: string,
    agentId: string,
    message: LlmMessage,
    extra: {
      roleOverride?: 'event' | 'error';
      source?: string;
      reasoning?: string;
      /** ReAct 步记录（agent 回复行；工具调用对持久化，M18 反馈 #6） */
      steps?: SessionStepRecord[];
    } = {},
  ): string {
    assertConversationId(conversationId);
    const queue = this.queueOf(conversationId);
    // 引用幂等（跨数组/跨 run 重复投递）：重复入队返回首行的 id（调用方
    // 幂等对账同锚）
    if (queue.seen.has(message)) return this.solids.get(message)?.message_id ?? '';
    queue.seen.add(message);
    // 幂等固化（src 教训：重复落盘至少产出同 id 行，可被任何一层去重）。
    // WeakMap 而非变异消息对象：固化字段不出本服务（§8.2-C）。
    let solid = this.solids.get(message);
    if (!solid) {
      solid = { message_id: genMessageId(), timestamp: new Date().toISOString() };
      this.solids.set(message, solid);
    }
    const line: SessionRecord = {
      role: extra.roleOverride ?? 'agent',
      content: message.content,
      agent_id: agentId,
      message_id: solid.message_id,
      timestamp: solid.timestamp,
      seq: queue.nextSeq++,
      ...(extra.source !== undefined ? { source: extra.source } : {}),
      ...(extra.reasoning ? { reasoning_content: extra.reasoning } : {}),
      ...(extra.steps !== undefined && extra.steps.length > 0 ? { steps: extra.steps } : {}),
    };
    queue.pending.push(JSON.stringify(line));
    return line.message_id;
  }

  private conversationDir(conversationId: string): string {
    assertConversationId(conversationId);
    const shelf = this.shelfIndex.get(conversationId);
    if (shelf !== undefined) {
      const shelved = path.join(this.sessionsDir, ...shelf.split('/'), conversationId);
      if (fs.existsSync(shelved)) return shelved;
      // 索引失准（目录被手动挪走）：清索引回落直存路径
      this.shelfIndex.delete(conversationId);
      this.saveShelfIndex();
    }
    return path.join(this.sessionsDir, conversationId);
  }

  // ============================================================
  // 会话上架（管理域组织文件夹；寻址不变）
  // ============================================================

  /**
   * 上架：把会话目录归入 <root>/sessions/<shelf>/<id>/（现存目录迁移）。
   * conversationId 寻址不变（叶子目录名 = conversationId）；shelf 根
   * 目录放 .shelf 标记（ids() 排除），索引持久化 .shelves.json。
   * 幂等：同 shelf 重复调用无副作用。
   */
  setShelf(conversationId: string, shelf: string): void {
    assertConversationId(conversationId);
    const segs = shelf.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length === 0 || segs.some((s) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))) {
      throw new Error(`shelf "${shelf}" 非法（须相对子路径，段以字母数字开头）`);
    }
    const normalized = segs.join('/');
    // 实际位置解析（conversationDir 自愈失准索引：索引说已上架但目录
    // 在直存处 → 清索引返回直存路径）——幂等以"目录真在架上"为准，
    // 不以索引值为准（目录可能被外部挪动）。
    const oldDir = this.conversationDir(conversationId);
    const newDir = path.join(this.sessionsDir, ...segs, conversationId);
    const oldFile = path.join(oldDir, 'messages.jsonl');
    const newFile = path.join(newDir, 'messages.jsonl');
    if (oldDir !== newDir && fs.existsSync(oldDir)) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true });
      try {
        fs.renameSync(oldDir, newDir);
      } catch {
        // Windows 目录 rename 常发 EPERM（杀软/句柄瞬时占用）：copy+remove 兜底
        fs.cpSync(oldDir, newDir, { recursive: true });
        fs.rmSync(oldDir, { recursive: true, force: true });
      }
    } else if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true }); // 新会话：目录先行（conversationDir 索引判定依赖存在性）
    }
    // shelf 根标记（首段目录；ids() 据此跳过）
    const shelfRoot = path.join(this.sessionsDir, segs[0]);
    fs.mkdirSync(shelfRoot, { recursive: true });
    const marker = path.join(shelfRoot, '.shelf');
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');

    // 迁移时在途队列作废：pending 同步落新文件（setShelf 调用点为启动/
    // 创建/换组，常态无在途写；防御性搬移）
    const queue = this.queues.get(oldFile);
    if (queue && queue.pending.length > 0) {
      fs.appendFileSync(newFile, `${queue.pending.join('\n')}\n`, 'utf-8');
    }
    this.queues.delete(oldFile);
    this.windowCache.delete(oldFile);
    this.windowCache.delete(newFile);

    this.shelfIndex.set(conversationId, normalized);
    this.saveShelfIndex();
  }

  /** 查询某会话的当前 shelf（未上架 → undefined） */
  shelfOf(conversationId: string): string | undefined {
    return this.shelfIndex.get(conversationId);
  }

  private loadShelfIndex(): void {
    try {
      if (!fs.existsSync(this.shelfFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.shelfFile, 'utf-8')) as Record<string, unknown>;
      for (const [id, shelf] of Object.entries(raw)) {
        if (typeof shelf === 'string' && shelf) this.shelfIndex.set(id, shelf);
      }
    } catch {
      // 索引损坏按空处理（singles 域启动后会重新同步）
    }
  }

  private saveShelfIndex(): void {
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      const tmp = `${this.shelfFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.shelfIndex), null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.shelfFile);
    } catch (err: unknown) {
      this.ctx.logger.warn(`[session] shelf 索引落盘失败: ${String(err)}`);
    }
  }

  private queueOf(conversationId: string): LogQueue {
    const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
    let queue = this.queues.get(file);
    if (!queue) {
      // B3 崩溃自愈：上次进程中途死可能留下无换行的尾部半行——先修复
      // 再建队（否则下一次 append 直接拼接，半行+新完整行 = 两行俱损）
      this.repairTail(file);
      queue = { file, pending: [], seen: new WeakSet(), nextSeq: this.probeNextSeq(file) };
      // 版本锚点（M21 步骤 7 / D8）：新会话文件首行 session-header——
      // 头行随首批落盘（文件创建即带锚；v1 = 中性格式 D13）
      if (!fs.existsSync(file)) queue.pending.push(headerLine());
      this.queues.set(file, queue);
    }
    return queue;
  }

  /** 建队续号（M21/D8）：读盘上末行 seq（缺省 1；旧格式无 seq 视为缺失）。
   *  B3：末行解析失败不再重置 1——与既有 seq 冲突会破坏 ac-archive-core
   *  dedupCutoff 的 first-match（二次归档区间错位）；降级为全文件扫描最大 seq */
  private probeNextSeq(file: string): number {
    try {
      const text = fs.readFileSync(file, 'utf-8').trimEnd();
      if (!text) return 1;
      const lastLine = text.slice(text.lastIndexOf('\n') + 1);
      if (isHeaderLine(lastLine)) return 1; // 仅头行
      const seq = seqOfLine(lastLine);
      if (seq !== undefined) return seq + 1;
      let max = 0;
      for (const line of text.split('\n')) {
        const s = seqOfLine(line);
        if (s !== undefined && s > max) max = s;
      }
      if (max > 0) this.ctx.logger.warn(`[session] 末行 seq 不可读（半行/损坏），全文件扫描续号 ${max + 1}`);
      return max > 0 ? max + 1 : 1;
    } catch {
      return 1;
    }
  }

  /**
   * 尾部半行自愈（B3）：writeSync 中途崩溃 → 尾部无 `\n` 半行 → 重启后
   * 下一次 append 直接拼接成一行 → 读取跳过 = 两行俱损。策略：
   *   · 尾字节已是 `\n`（常态）→ 零成本返回；
   *   · 尾部不完整行本身是合法记录（撕裂点恰在收尾换行前）→ 补 `\n` 保记录；
   *   · 解析不出 → 截断到最后一个换行（丢半行，不丢下一行）。
   */
  private repairTail(file: string): void {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // 不存在 = 新文件
    }
    if (size === 0) return;
    // 'r+'：截断半行需要写权限（Windows 对只读 fd ftruncate = EPERM）
    const fd = fs.openSync(file, 'r+');
    try {
      const probe = Buffer.alloc(1);
      fs.readSync(fd, probe, 0, 1, size - 1);
      if (probe[0] === 0x0a) return; // 已以换行结尾
      // 读尾部窗口找最后一个换行 + 完整半行内容（单条记录受限长输出，
      // 8 MiB 窗口足够；越界属病态文件，按截断处理并留日志）
      const window = Math.min(size, 8 * 1024 * 1024);
      const start = size - window;
      const text = Buffer.alloc(window);
      fs.readSync(fd, text, 0, window, start);
      const s = text.toString('utf-8');
      const nl = s.lastIndexOf('\n');
      const partial = nl >= 0 ? s.slice(nl + 1) : s;
      // 截断点是字节偏移：字符串索引在多字节 UTF-8（中文内容）下 ≠ 字节位
      const keep = start + Buffer.byteLength(s.slice(0, nl + 1), 'utf-8');
      if (isValidRecordLine(partial)) {
        // 撕裂点在换行前：记录本体完整，补一个换行即可救回
        const wfd = fs.openSync(file, 'a');
        try {
          fs.writeSync(wfd, '\n', null, 'utf-8');
          fs.fsyncSync(wfd);
        } finally {
          fs.closeSync(wfd);
        }
        this.ctx.logger.warn(`[session] 会话文件尾部半行为完整记录（崩溃撕裂点在换行前）——已补换行救回: ${file}`);
        return;
      }
      fs.ftruncateSync(fd, Math.max(0, keep));
      this.ctx.logger.warn(
        `[session] 会话文件尾部半行损坏（崩溃残留）——已截断 ${size - Math.max(0, keep)} 字节半行: ${file}`,
      );
    } finally {
      fs.closeSync(fd);
    }
  }

  // ============================================================
  // writer 队列（src SessionLogWriter 语义原样）
  // ============================================================

  /** 排空会话的 pending 与在途写，直到 quiescence（barrier 复用） */
  async flush(conversationId: string): Promise<void> {
    const queue = this.queues.get(
      path.join(this.conversationDir(conversationId), 'messages.jsonl'),
    );
    if (!queue) return;
    if (queue.barrier) return queue.barrier;
    const barrier = this.drain(queue).finally(() => {
      if (this.queues.get(queue.file) === queue) queue.barrier = undefined;
    });
    queue.barrier = barrier;
    return barrier;
  }

  /** 排空全部会话队列（checkpoint / 卸载收尾） */
  async flushAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => this.drain(queue)));
  }

  /** 排空一个队列：等在途写 → 批量 append+fsync；失败批次回队首并抛出 */
  private async drain(queue: LogQueue): Promise<void> {
    await Promise.allSettled(queue.active ? [queue.active] : []);
    while (queue.pending.length > 0) {
      // 队列已注销（clear 删目录 / setShelf 迁移作废旧队列）→ 丢弃残余
      // 批次不再写：防 drain 续写在删后/迁移后经 mkdirSync+append 复活
      // 旧路径文件（setShelf 的 pending 已防御性搬移新文件，丢弃无损失）
      if (this.queues.get(queue.file) !== queue) return;
      const batch = queue.pending.splice(0);
      const active = this.write(queue.file, batch);
      queue.active = active;
      try {
        await active;
      } catch (err) {
        queue.pending = [...batch, ...queue.pending]; // 保序回队首；调用方决定 fail-closed
        throw err;
      } finally {
        queue.active = undefined;
      }
    }
  }

  /** 一次 append + fsync（单写者假设：本服务是会话文件唯一写口）。
   *  B3：append 前零成本校验尾换行——同进程内撕裂写（partial writeSync
   *  抛错回队）后重试不再把新行拼进半行 */
  private async write(file: string, lines: string[]): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.repairTail(file);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, `${lines.join('\n')}\n`, null, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // ============================================================
  // 回放与维护
  // ============================================================

  /**
   * 回放历史（概要头部 + 此前消息；供 router.send options.history）——
   * **唯一回放边界**，角色由回放按读者赋予（§2.4）：viewer = 读者端点 id
   * （回 Agent 的那个 Agent），`agent_id === viewer → assistant`、其余 → user。
   * 先排空该会话在途队列（best effort——落盘失败不阻塞回放）。
   * viewer 缺省 = 匿名读者：中性行一律 user（无法判定自他；审计/原始行
   * 用 records()）；旧 baked 行按原 role 直通（与既有行为一致）。
   */
  async history(conversationId: string, options: { viewer?: string } = {}): Promise<LlmMessage[]> {
    const records = await this.records(conversationId);
    const summary = this.summary(conversationId);
    // 轨迹回放开关（M21/D14，§2.5；2026-08-30 P2 词汇收口）：读取走
    // settingsOf 合成（全局默认层 settings.session ∪ Agent 差异层——viewer
    // 即回读的 Agent，per-Agent 语义天然成立）；存量 config 键
    // `session.replayTrajectory` 双读过渡（新层显式值优先，未配置回落旧键
    // ——存量部署不静默翻转）。布尔两态，缺省 false = 对话级；K 截断档
    // 否决——截断预算使回放形状随内容前滑 → 缓存失效且费用反升，长对话
    // 预算归归档阈值唯一属主。true = **viewer 自己的**回复行 steps[] 全量
    // 物化（复现 run 内消息序——跨 run 保留自己的工具轨迹记忆、少重复
    // 调用；持久化 steps 是脱敏 + JSON 往返产物，历史 run 边界处仍 miss，
    // "开 = 高命中"不成立，按质量需求自选）。翻转 = 该会话回放形状整体
    // 显式 replace（一次性全量失效，低频可接受）。消费即读——settings
    // config/changed 后下一轮自动生效。
    const replayTrajectory =
      options.viewer !== undefined && this.replayTrajectoryOf(options.viewer);
    const rows: LlmMessage[] = [];
    for (const r of records) {
      if (!replayTrajectory || r.agent_id !== options.viewer) {
        rows.push(projectRecord(r, options.viewer, conversationId));
        continue;
      }
      rows.push(...expandTrajectory(r));
    }
    return [
      ...(summary !== undefined ? [{ role: 'system' as const, content: summary }] : []),
      ...rows,
    ];
  }

  /**
   * 轨迹回放开关读取（P2 收口）：settingsOf(viewer, 'session') 合成层
   * 的 replayTrajectory 显式值优先；未配置回落存量 config 键
   * `session.replayTrajectory`（M21 时代全局域——双读过渡）；两处皆无
   * = 缺省 false。软依赖 agents/config（M12 铁律 2：跨服务方法调用走
   * ctx.get——组合缺行不炸回放）。
   */
  private replayTrajectoryOf(viewer: string): boolean {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf?(id: string, name?: string): unknown }
      | undefined;
    const merged = agents?.settingsOf?.(viewer, 'session');
    if (merged !== undefined && merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
      const v = (merged as { replayTrajectory?: unknown }).replayTrajectory;
      if (v !== undefined) return v === true;
    }
    const config = this.ctx.get('config', false) as { get?(key: string): unknown } | undefined;
    return config?.get?.('session.replayTrajectory') === true;
  }

  /**
   * 回放持久化行（含 message_id/timestamp；M12 归档去重与审计的读取口）。
   * 不含概要头部——概要是压缩产物不是事实消息。与 history() 同：先排空在途队列。
   */
  async records(conversationId: string): Promise<SessionRecord[]> {
    try {
      await this.flush(conversationId);
    } catch (err) {
      this.ctx.logger.warn(`[session] 回放前 flush 失败（${conversationId}）: ${String(err)}`);
    }
    const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
    let lines: string[] = [];
    try {
      if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf-8').split('\n');
    } catch {
      return []; // 读失败按空会话处理
    }
    const out: SessionRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      // 会话头行（M21 步骤 7 / D8）：版本锚点——未知版本 fail-loud
      // （宁可拒绝也不误读；无头 = 旧 baked 格式按 §2.4 兼容路径宽容读）
      if (isHeaderLine(line)) {
        let header: Partial<SessionHeader>;
        try {
          header = JSON.parse(line) as Partial<SessionHeader>;
        } catch {
          continue; // 撕裂/损坏头行按损坏行忽略（与行级宽容路径一致）
        }
        if (header.version !== 1) {
          throw new Error(
            `会话 "${conversationId}" 格式版本 ${String(header.version)} 未知（本版本只认 v1 中性格式）——拒绝误读`,
          );
        }
        continue;
      }
      try {
        const rec = parseRecordLine(line);
        if (rec !== undefined) out.push(rec);
      } catch {
        // 损坏行忽略
      }
    }
    return out;
  }

  /**
   * 直注入账一条消息并落盘（M12 workspace 首启消息等宿主写入口；
   * ADR-5：外部一律经本 API，不直写会话文件）。幂等语义同事件通道。
   * 【D13 中性语义】message.role 不参与落盘形态——一切经此入账的都是
   * 真实发言：role:'agent' + agent_id=参数说话人端点。
   * 【D11】群本体经本口入账（唯一写路径）——返回行 message_id 供调用方
   * 对齐锚点/幂等对账。
   */
  async append(conversationId: string, agentId: string, message: LlmMessage): Promise<string> {
    const messageId = this.record(conversationId, agentId, message);
    await this.flush(conversationId);
    return messageId;
  }

  /**
   * 原子重写消息流（compact/deleteMessage/truncateAfter 共用写法；
   *  M21 步骤 7：已有头行则保留在首行——版本锚点跨重写存活）。
   *
   * B1 窗口保护（2026-08-31 审计）：`sinceSeq` = 调用方 records 快照的
   * max seq。快照之后、重写之前新到并已 flush 落账的记录（归档整理 run
   * 可达分钟级——steer 注入落账 / 群成员并发发言）曾被 tmp+rename 直接
   * 覆盖：先 durable 又被抹掉且零日志。现重写前重读当前文件，把
   * `seq > sinceSeq` 的行并入 rows 尾部（无 seq 的旧行不并入——删除
   * 语义优先于窗口语义）。
   */
  private rewriteMessages(file: string, rows: SessionRecord[], sinceSeq?: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let finalRows = rows;
    if (sinceSeq !== undefined && fs.existsSync(file)) {
      const window: SessionRecord[] = [];
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim() || isHeaderLine(line)) continue;
        try {
          const parsed = JSON.parse(line) as Partial<SessionRecord>;
          if (typeof parsed.seq === 'number' && parsed.seq > sinceSeq) {
            window.push(parsed as SessionRecord);
          }
        } catch {
          // 损坏行不并入（B3 修复路径在建队时已处理）
        }
      }
      if (window.length > 0) {
        finalRows = [...rows, ...window];
        this.ctx.logger.info(
          `[session] 重写窗口保护：并入快照后新到 ${window.length} 条记录（seq > ${sinceSeq}，归档/删除的仅是快照内内容）`,
        );
      }
    }
    const hadHeader =
      fs.existsSync(file) && isHeaderLine(fs.readFileSync(file, 'utf-8').split('\n')[0] ?? '');
    const body = finalRows.map((r) => JSON.stringify(r)).join('\n');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${[...(hadHeader ? [headerLine()] : []), ...(body ? [body] : [])].join('\n')}\n`, 'utf-8');
    fs.renameSync(tmp, file);
    this.queues.delete(file); // 旧队列作废（seen 引用防重入；nextSeq 由建队续号恢复）
  }

  /**
   * 压缩重建（M12 归档的落盘口）：可选写概要 + 用 keep 重写消息流
   * （原子：tmp+rename）。策略（阈值/分割点/概要内容）归调用方
   * （ac-archive），机制（文件布局/队列一致性）归本服务。
   * 重写前排空在途队列；重写后旧队列作废（seen 引用防重入）。
   *
   * B1：调用方必须传 `baselineSeq` = 其 records 快照的 max seq（maxSeqOf
   * 计算）——快照后新到的记录会被并入保留，不被重写覆盖。缺省不传 =
   * 精确按 keep 重写（兼容一次性脚本；生产调用方禁止省略）。
   */
  async compact(
    conversationId: string,
    opts: { summary?: string; keep?: SessionRecord[]; baselineSeq?: number } = {},
  ): Promise<void> {
    await this.flush(conversationId); // 旧账先 durable，重写不丢在途消息
    const dir = this.conversationDir(conversationId);
    const file = path.join(dir, 'messages.jsonl');
    if (opts.summary !== undefined) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.md'), `${opts.summary.trim()}\n`, 'utf-8');
    }
    this.rewriteMessages(file, opts.keep ?? [], opts.baselineSeq);
  }

  /**
   * 删除一条消息（M7 WebUI 会话管理面；按 message_id 定位）。
   * flush 后原子重写消息流（tmp+rename，同 compact 的写法）；
   * summary 不受影响。返回是否真的删除了记录（id 不存在 = false）。
   * B1：快照后新到记录经 sinceSeq 窗口并入（不被删除连带覆盖）。
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<boolean> {
    await this.flush(conversationId);
    const records = await this.records(conversationId);
    const kept = records.filter((r) => r.message_id !== messageId);
    if (kept.length === records.length) return false; // 无此 id（含空会话）
    this.rewriteMessages(
      path.join(this.conversationDir(conversationId), 'messages.jsonl'),
      kept,
      maxSeqOf(records),
    );
    return true;
  }

  /**
   * 截断会话：删除指定消息及其后全部记录（M17-C 行内编辑的
   * truncateAfter 语义——编辑某条用户消息 = 删其后消息再重发）。
   * 与 deleteMessage 同款原子重写；返回删除条数（0 = 无此 id）。
   * B1：快照后新到记录经 sinceSeq 窗口并入。
   */
  async truncateAfter(conversationId: string, messageId: string): Promise<number> {
    await this.flush(conversationId);
    const records = await this.records(conversationId);
    const idx = records.findIndex((r) => r.message_id === messageId);
    if (idx < 0) return 0;
    const kept = records.slice(0, idx);
    this.rewriteMessages(
      path.join(this.conversationDir(conversationId), 'messages.jsonl'),
      kept,
      maxSeqOf(records),
    );
    return records.length - idx;
  }

  /** 概要（已生成时；读 summary.md） */
  summary(conversationId: string): string | undefined {
    try {
      const file = path.join(this.conversationDir(conversationId), 'summary.md');
      if (!fs.existsSync(file)) return undefined;
      const text = fs.readFileSync(file, 'utf-8').trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 清空会话（删目录；在途队列作废——drain 守卫防续写复活）。
   * 语义：清空即丢弃在途批次（clear 后新 record 由建队自愈重新开档）。
   */
  clear(conversationId: string): void {
    const dir = this.conversationDir(conversationId);
    fs.rmSync(dir, { recursive: true, force: true });
    this.queues.delete(path.join(dir, 'messages.jsonl'));
  }

  /** 诊断：全部会话 id（直存目录 + 已上架目录；shelf 根目录排除） */
  ids(): string[] {
    const out: string[] = [];
    try {
      for (const e of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        // shelf 根目录（带 .shelf 标记）不是会话
        if (fs.existsSync(path.join(this.sessionsDir, e.name, '.shelf'))) continue;
        out.push(e.name);
      }
    } catch {
      // 根目录不存在
    }
    for (const [id, shelf] of this.shelfIndex) {
      if (out.includes(id)) continue;
      if (fs.existsSync(path.join(this.sessionsDir, ...shelf.split('/'), id))) out.push(id);
    }
    return out;
  }

  /**
   * 会话轻量统计（M17-D 运行矩阵数据源；只读扫描不写——规约 1）。
   * 读文件行数/mtime + 热力时间窗（windows：h1/dN 窗口内消息数——
   * 矩阵范围色阶数据源；mtime/size 缓存，3s 轮询零重算）。
   * 不存在返回 undefined。
   */
  stats(conversationId: string): { messageCount: number; size: number; updatedAt: number; windows: SessionWindowCounts } | undefined {
    try {
      const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
      if (!fs.existsSync(file)) return undefined;
      const stat = fs.statSync(file);
      const cached = this.windowCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return { messageCount: cached.messageCount, size: stat.size, updatedAt: stat.mtimeMs, windows: cached.windows };
      }
      const text = fs.readFileSync(file, 'utf-8');
      // 行计数排除会话头行（M21 步骤 7 / F4：防消息数 +1 漂移）
      const messageCount =
        text.trim() === ''
          ? 0
          : text.trim().split('\n').filter((l) => !isHeaderLine(l)).length;
      const windows = countWindowMessages(text, Date.now());
      this.windowCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, windows, messageCount });
      return { messageCount, size: stat.size, updatedAt: stat.mtimeMs, windows };
    } catch {
      return undefined;
    }
  }

  /**
   * 尾部记录（Port B P4 名册摘要数据源）：读最后一条非空行并解析，
   * 只取展示所需字段；不存在/损坏返回 undefined。与 stats() 同为只读
   * 面向（不 flush 在途队列——实时侧由前端 bump 覆盖）。
   */
  tail(conversationId: string): Pick<SessionRecord, 'role' | 'content' | 'timestamp' | 'agent_id' | 'name' | 'source'> | undefined {
    try {
      const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
      if (!fs.existsSync(file)) return undefined;
      const text = fs.readFileSync(file, 'utf-8').trimEnd();
      if (!text) return undefined;
      const lastLine = text.slice(text.lastIndexOf('\n') + 1);
      const rec = parseRecordLine(lastLine);
      if (rec === undefined) return undefined;
      return {
        role: rec.role,
        content: rec.content,
        timestamp: rec.timestamp,
        ...(rec.agent_id !== undefined ? { agent_id: rec.agent_id } : {}),
        ...(rec.name !== undefined ? { name: rec.name } : {}),
        ...(rec.source !== undefined ? { source: rec.source } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话历史服务（ac-session 提供）：事件积累 + 持久化 + history() 回放（按 conversationId 分桶） */
    session: SessionService;
  }
}

export const name = 'ac-session';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'session',
  label: '会话持久化',
  description: '工具副作用执行前 fail-closed checkpoint（排空该会话写入队列后才放行）+ 历史回放轨迹开关（settingsOf 合成：全局默认 ∪ Agent 差异层）',
  automatic: true,
  fields: [
    { name: 'replayTrajectory', description: '轨迹回放——开 = Agent 回看自己历史时保留当时的工具调用轨迹（思考与工具结果对），质量优先但历史轮边界缓存失效、token 略增；关（缺省）= 对话级回放只保留每轮最终回复，成本最优。仅影响 Agent 自己的视角，翻转后下一轮生效（Agent 差异层可覆盖）' },
  ],
  listeners: [{ event: 'tool/before-execute', role: 'fail-closed checkpoint', description: '工具执行前拦截（安全策略/审计/参数改写）——承重：关停破坏会话桶一致性' }],
};


export function apply(ctx: Context, options: SessionRowOptions = {}) {
  ctx.plugin(SessionService, options);
}
