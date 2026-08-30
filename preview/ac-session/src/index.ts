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
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import { GROUP_HINT_META } from 'ac-group';
import type { LlmMessage, LlmRole } from 'ac-llm';
import type {} from 'ac-router'; // router/* 事件目录（type-only）
import type {} from 'ac-agent-loop'; // loop/* 事件目录（type-only）
import type {} from 'ac-conversation'; // conversation/* 事件目录（type-only）

/** 机制标记 run（归档整理等）判定：见标记即不入账（M20，src META_ARCHIVE_REVIEW 三消费方之一） */
function isArchiveReview(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[ARCHIVE_REVIEW_META] === true;
}

/** 群 hint 投递触发标记（M21/F6①）：事实行已由 post 入群本体——入账跳过（回复照常） */
function isGroupHint(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[GROUP_HINT_META] === true;
}

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

/** 行前缀判定（避免全量 JSON.parse；统计口径排除头行用） */
function isHeaderLine(line: string): boolean {
  return line.trimStart().startsWith('{"type":"session-header"');
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
    const role: LlmRole =
      r.role === 'agent'
        ? viewer !== undefined && r.agent_id === viewer
          ? 'assistant'
          : 'user'
        : r.role === 'event' || r.role === 'error'
          ? 'user'
          : r.role === 'system' || r.role === 'tool'
            ? r.role
            : 'user'; // 防御：未知词表按 user 喂回
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
  const role: LlmRole =
    r.role === 'event'
      ? 'user'
      : r.role === 'system'
        ? 'system'
        : attribution === viewer
          ? 'assistant'
          : 'user';
  return { role, content: r.content, ...(attribution !== undefined ? { name: attribution } : {}) };
}

/**
 * 轨迹展开（M21/D14，§2.5）：viewer 自己的回复行 steps[] → run 内消息序
 * 复现——每步 assistant(tool_calls?) + 配对 tool 结果行（tool_call_id 配对，
 * content = 结果 JSON 串——与 loop 运行时同构[脱敏/往返漂移已显式接受]）→
 * 终 assistant(content)。reasoning 不回传（M4）。
 */
export function expandTrajectory(r: SessionRecord): LlmMessage[] {
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
  private windowCache = new Map<string, { mtimeMs: number; size: number; windows: SessionWindowCounts }>();

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
      if (isArchiveReview(meta)) return;
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
      if (isArchiveReview(meta)) return;
      if (isGroupHint(meta)) return;
      this.record(conversationId, sender ?? agentId, message);
    }, { description: 'steer 消息入账' });
    this.ctx.on('router/reply-completed', (agentId, text, result, conversationId, _sender, _source, meta) => {
      if (isArchiveReview(meta)) return; // 机制标记 run 的回复不入账（M20）
      // 错误收束一等化（D12/F7，§2.3）：role:'error'——UI 错误分隔符，
      // LLM 回放按 user 喂回（告知"出了错"而无自他归因污染）；不再以
      // `[error]` 前缀伪装 assistant 文本落盘。
      if (result.finish === 'error') {
        this.record(conversationId, agentId, { role: 'user', content: String(result.error ?? '循环失败') }, {
          roleOverride: 'error',
          source: 'error',
        });
        void this.flush(conversationId).catch((err: unknown) => {
          this.ctx.logger.warn(`[session] 错误行落盘失败（${conversationId}）: ${String(err)}`);
        });
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
      // 回复落盘（尽力而为：失败记日志不阻塞 emit 链）
      void this.flush(conversationId).catch((err: unknown) => {
        this.ctx.logger.warn(`[session] 回复落盘失败（${conversationId}）: ${String(err)}`);
      });
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
    // 卸载收尾：排空队列（优雅关闭）
    this.ctx.fiber.effect(
      () => () => this.flushAll(),
      'session.writer-flush',
    );
  }

  /** 会话根目录（诊断用） */
  get root(): string {
    return this.sessionsDir;
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
      queue = { file, pending: [], seen: new WeakSet(), nextSeq: this.probeNextSeq(file) };
      // 版本锚点（M21 步骤 7 / D8）：新会话文件首行 session-header——
      // 头行随首批落盘（文件创建即带锚；v1 = 中性格式 D13）
      if (!fs.existsSync(file)) queue.pending.push(headerLine());
      this.queues.set(file, queue);
    }
    return queue;
  }

  /** 建队续号（M21/D8）：读盘上末行 seq（缺省 1；旧格式无 seq 视为缺失） */
  private probeNextSeq(file: string): number {
    try {
      const text = fs.readFileSync(file, 'utf-8').trimEnd();
      if (!text) return 1;
      const lastLine = text.slice(text.lastIndexOf('\n') + 1);
      if (isHeaderLine(lastLine)) return 1; // 仅头行
      const seq = (JSON.parse(lastLine) as { seq?: unknown }).seq;
      return typeof seq === 'number' && seq > 0 ? seq + 1 : 1;
    } catch {
      return 1;
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

  /** 一次 append + fsync（单写者假设：本服务是会话文件唯一写口） */
  private async write(file: string, lines: string[]): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
    // 轨迹回放开关（M21/D14，§2.5）：config 键 session.replayTrajectory
    // （布尔两态，缺省 false = 对话级；K 截断档否决——截断预算使回放形状
    // 随内容前滑 → 缓存失效且费用反升，长对话预算归归档阈值唯一属主）。
    // true = **viewer 自己的**回复行 steps[] 全量物化（复现 run 内消息序
    // ——跨 run 保留自己的工具轨迹记忆、少重复调用；持久化 steps 是脱敏
    // + JSON 往返产物，历史 run 边界处仍 miss，"开 = 高命中"不成立，按
    // 质量需求自选）。翻转 = 该会话回放形状整体显式 replace（一次性全量
    // 失效，低频可接受）。消费即读——config/changed 后下一轮自动生效。
    const replayTrajectory =
      (this.ctx.get('config', false) as { get?(key: string): unknown } | undefined)?.get?.(
        'session.replayTrajectory',
      ) === true;
    const rows: LlmMessage[] = [];
    for (const r of records) {
      if (!replayTrajectory || options.viewer === undefined || r.agent_id !== options.viewer) {
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
        const header = JSON.parse(line) as Partial<SessionHeader>;
        if (header.version !== 1) {
          throw new Error(
            `会话 "${conversationId}" 格式版本 ${String(header.version)} 未知（本版本只认 v1 中性格式）——拒绝误读`,
          );
        }
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Partial<SessionRecord>;
        if (
          parsed.role !== 'agent' && parsed.role !== 'error' && parsed.role !== 'event' &&
          parsed.role !== 'user' && parsed.role !== 'assistant' &&
          parsed.role !== 'system' && parsed.role !== 'tool'
        ) {
          continue; // 损坏行忽略（中性格式 + 旧 baked 兼容词表）
        }
        out.push({
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
        });
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

  /** 原子重写消息流（compact/deleteMessage/truncateAfter 共用写法；
   *  M21 步骤 7：已有头行则保留在首行——版本锚点跨重写存活） */
  private rewriteMessages(file: string, rows: SessionRecord[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const hadHeader =
      fs.existsSync(file) && isHeaderLine(fs.readFileSync(file, 'utf-8').split('\n')[0] ?? '');
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
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
   */
  async compact(
    conversationId: string,
    opts: { summary?: string; keep?: SessionRecord[] } = {},
  ): Promise<void> {
    await this.flush(conversationId); // 旧账先 durable，重写不丢在途消息
    const dir = this.conversationDir(conversationId);
    const file = path.join(dir, 'messages.jsonl');
    if (opts.summary !== undefined) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.md'), `${opts.summary.trim()}\n`, 'utf-8');
    }
    this.rewriteMessages(file, opts.keep ?? []);
  }

  /**
   * 删除一条消息（M7 WebUI 会话管理面；按 message_id 定位）。
   * flush 后原子重写消息流（tmp+rename，同 compact 的写法）；
   * summary 不受影响。返回是否真的删除了记录（id 不存在 = false）。
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<boolean> {
    await this.flush(conversationId);
    const records = await this.records(conversationId);
    const kept = records.filter((r) => r.message_id !== messageId);
    if (kept.length === records.length) return false; // 无此 id（含空会话）
    this.rewriteMessages(path.join(this.conversationDir(conversationId), 'messages.jsonl'), kept);
    return true;
  }

  /**
   * 截断会话：删除指定消息及其后全部记录（M17-C 行内编辑的
   * truncateAfter 语义——编辑某条用户消息 = 删其后消息再重发）。
   * 与 deleteMessage 同款原子重写；返回删除条数（0 = 无此 id）。
   */
  async truncateAfter(conversationId: string, messageId: string): Promise<number> {
    await this.flush(conversationId);
    const records = await this.records(conversationId);
    const idx = records.findIndex((r) => r.message_id === messageId);
    if (idx < 0) return 0;
    const kept = records.slice(0, idx);
    this.rewriteMessages(path.join(this.conversationDir(conversationId), 'messages.jsonl'), kept);
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
   * 生成/覆盖概要：写 summary.md + 截断消息流（压缩语义：概要取代原消息）。
   * 同步语义（既有 API 兼容）；flush 感知的压缩重建走 compact()。
   */
  setSummary(conversationId: string, summary: string): void {
    const dir = this.conversationDir(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.md'), `${summary.trim()}\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '', 'utf-8'); // 截断
    this.queues.delete(path.join(dir, 'messages.jsonl')); // 旧队列作废（seen 引用防重）
  }

  /** 清空会话（删目录；在途队列作废） */
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
      const text = fs.readFileSync(file, 'utf-8');
      // 行计数排除会话头行（M21 步骤 7 / F4：防消息数 +1 漂移）
      const messageCount =
        text.trim() === ''
          ? 0
          : text.trim().split('\n').filter((l) => !isHeaderLine(l)).length;
      const cached = this.windowCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return { messageCount, size: stat.size, updatedAt: stat.mtimeMs, windows: cached.windows };
      }
      const windows = countWindowMessages(text, Date.now());
      this.windowCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, windows });
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
      const parsed = JSON.parse(lastLine) as Partial<SessionRecord>;
      if (
        parsed.role !== 'agent' && parsed.role !== 'error' && parsed.role !== 'event' &&
        parsed.role !== 'user' && parsed.role !== 'assistant' &&
        parsed.role !== 'system' && parsed.role !== 'tool'
      ) {
        return undefined;
      }
      return {
        role: parsed.role,
        content: parsed.content ?? '',
        timestamp: parsed.timestamp ?? '',
        ...(parsed.agent_id !== undefined ? { agent_id: parsed.agent_id } : {}),
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
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

export function apply(ctx: Context, options: SessionRowOptions = {}) {
  ctx.plugin(SessionService, options);
}
