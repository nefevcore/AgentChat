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
// 记录通道（事件积累，零注入 router/loop/conversation——loop 仅订阅事件）：
//   · router/message-received  → 入站消息入账（会话空闲路径）
//   · conversation/steered     → steer 注入消息入账（会话忙路径）
//   · router/reply-completed   → 回复入账 + 落盘（收束行；吸收同 run 部分行）
//   · loop/run-started         → run 簿记（runId + 机制 run 标记——部分行门控）
//   · loop/after-step          → 步级部分行（src step-persist 平移）：带工具
//     调用的步完成即先落 partial 行（思维链/调用对，结果未回）；工具阻塞
//     等待（ask_questions）或中断时刷新可见，收束后被读侧吸收
//   · tool/after-execute       → 工具结果补记：结果到达即追加补行，records()
//     覆盖未收束 run 部分行的 result:null（中断 run 的恢复源 + KV 前缀保真）
//   · tool/before-execute      → fail-closed checkpoint：排空当前会话队列
//     （M11 执行身份定向化：按 call.conversationId flush，无身份退回
//     flushAll）后才放行工具执行；落盘失败则 veto（工具执行前入站消息
//     与部分行必已 durable）
//
// 【source → role 契约（2026-09-02 复评收口）】入站信封 source（触发来源）
// 是唯一的类别判据，忙（steered）/闲（message-received）两条入账路径同形：
//   · source='user'|'agent' → role:'agent'（真实发言，agent_id=说话人）
//   · source='event'        → role:'context' + source:'event'（机制行：后台
//     任务通知/定时触发/插件回触——UI 系统分隔符、LLM 回放 user 语义位；
//     agent_id=投递目标，诊断用。词汇 v2：旧 role:'event' 已迁移为
//     context+source，三轴见 SessionRecordRole）
//   · meta 门控（archive-review / group-hint 的 event）→ 不入账
// 前端 feed 的两帧（router/message-received / conversation/steered）按同款
// source 分流渲染——直播与刷新（history 的 role）一致。
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
import { isArchiveReviewRun, type LoopRunResult, type LoopStepRecord } from 'ac-agent-loop'; // loop/* 事件目录（type-only）
import { isGroupHint, maxSeqOf } from 'ac-core-utils'; // 跨行协议纯函数（解 session⇄group 环；2026-09-05 边界评估）
import type { LlmAttachment, LlmImageAttachment, LlmMessage, LlmRole } from 'ac-llm';
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

/**
 * 中性格式行角色（M21/D13 + 存储词汇 v2）：消费通道，读者无关。
 * v2 三轴（skill-injection-and-storage-vocab §2）：
 *   · role = 消费通道：'agent'（真实发言）/ 'context'（上下文材料——
 *     LLM 回放 user 语义位，UI 按 source/label 呈现）；
 *   · source（context 行携带）= UI 决策词：'event'（分隔符）/ 'error'
 *     （红色语义）/ 'skill'（技能注入 label 条）/ 开放词汇；
 *   · label = UI 文案（可选，缺省按 source 回落）。
 * 'event'/'error' 旧词仅存量（读侧回放等价，迁移 M-role-v2 改写后绝迹）。
 */
export type SessionRecordRole = 'agent' | 'context' | 'system' | 'tool' | 'error' | 'event';

/** 持久化行（append-only jsonl；归档去重/审计消费 message_id） */
export interface SessionRecord {
  /**
   * 行角色（消费通道，读者无关——词汇 v2 三轴见 SessionRecordRole 注释）：
   * - 'agent' = 一切真实发言（人类入站/Agent 出站/steer/私信），归属 agent_id；
   * - 'context' = 上下文材料（机制行/技能注入——source/label 决定 UI 呈现）；
   * - 'event'/'error' = 存量旧词（迁移 M-role-v2 后绝迹；读侧回放等价）；
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
  /** context 行来源/呈现决策词（'event' 分隔符 / 'error' 红色 / 'skill' label 条 / 开放）；存量 event/error 行的旧复读值（迁移后绝迹） */
  source?: string;
  /** context 行 UI 文案（可选；缺省按 source 回落——后台事件/运行错误） */
  label?: string;
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
  /**
   * 步级部分行标记（src step-persist 平移）：true = run 进行中已完工具步的
   * checkpoint（工具结果未回——落盘先于执行是"副作用前 durable"的设计）。
   * 结果到达后由 tool-result 补行覆盖（records() 读侧投影）；run 收束行
   * （同 run 键、无本标记）落账后吸收同 run 的全部部分行与补行——完成后
   * 形态与步级落盘前一致。run 未收束（工具阻塞等待 ask_questions / 中断 /
   * 进程死亡）时部分行保留：刷新后的历史首屏据此恢复思维链、工具卡与
   * （补行齐全时）真实工具结果。
   */
  partial?: boolean;
  /** 归位锚（partials 行专用，2026-09-20 摘除）：落盘时刻主文件队列序——
   *  读侧合并时在主文件 seq >= echoSeq 的首行之前归位（run 无锚时序恢复；
   *  同毫秒 timestamp 歧义免疫）。主文件行不带本字段 */
  echoSeq?: number;
  /** run 关联键（部分行与其收束行同值；读侧吸收对账用） */
  run?: string;
  /**
   * 多模态附件引用（image/video/file，M4 词表）：入站消息的 attachments
   * 旁挂原样落盘——只存引用（几十字节），base64 物化收敛在 provider 适配
   * 层；UI 刷新后据此恢复附件 chips。回放投影（projectRecord）把它带回
   * LlmMessage。
   */
  attachments?: LlmAttachment[];
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

/**
 * 工具结果补记行（type 判别行，同 session-header 机制）：run 进行中
 * tool/after-execute 到达即追加；records() 读侧按 `(run, tool_call_id)`
 * 覆盖到未收束 run 的部分行 `result:null` 上（2026-09-04——部分行按设计
 * 先于工具执行落盘，结果未回；run 中断后 `"null"` 回放既丢信息又打碎
 * provider KV 前缀）。收束行吸收同 run 部分行后本行随之失效（读侧不产
 * 出；重写窗口按 seq 并入保留）。旧版本读到本行 → parseRecordLine 无
 * role 词拒绝 → 安全忽略（前向兼容）。
 */
interface ToolResultLine {
  type: 'tool-result';
  /** run 关联键（与部分行/收束行同值） */
  run: string;
  tool_call_id: string;
  /** 工具终值（transform 后的 ToolResult——与 loop 回填模型的内容同对象） */
  result: unknown;
  /**
   * run_code 子调用标记（2026-09-17 程序化模式实测复盘 #B）：run_code
   * 程序内的子调用（call.runCodeSubcall）与模型直接调用在回放面同形
   * ——UI 据本标记区分（subcall 卡片平铺展示、带缩进样式，2026-09-17
   * 方向 B 重构：子调用产生独立工具卡 + 文件编辑追踪）；审计面保持
   * 全量。旧版本读到本行 → 未知字段忽略（前向兼容）。
   */
  subcall?: boolean;
  /**
   * 调用参数原始 JSON 串（subcall 补行携带——前端复原完整工具卡片
   * 的数据源；模型直调的参数已在 steps[].toolCalls[].arguments，不落
   * 本键）。旧版本读到本行 → 未知字段忽略（前向兼容）。
   */
  arguments?: string;
  /** 工具名（subcall 补行携带——同上，复原卡片的工具名源） */
  name?: string;
  seq?: number;
}

/** 补记行前缀判定（避免全量 JSON.parse） */
function isToolResultLine(line: string): boolean {
  return line.trimStart().startsWith('{"type":"tool-result"');
}

/** run_code 子调用 id（`<runId>#<seq>`）的 seq 数字段（无 # 后缀 → 0） */
function seqOfToolCallId(id: string): number {
  const at = id.lastIndexOf('#');
  if (at < 0) return 0;
  const n = Number(id.slice(at + 1));
  return Number.isFinite(n) ? n : 0;
}

/** 合法行角色词表（中性格式 D13 五词 + 存储词汇 v2 + 旧 baked 兼容词；records/tail 共用谓词）。
 * v2（skill-injection-and-storage-vocab）：role=消费通道（agent=真实发言 /
 * context=上下文材料）；event/error 旧词已迁移为 context+source（读侧
 * 等价回放兜底，写侧不再产生）。 */
const KNOWN_ROLES = new Set(['agent', 'context', 'error', 'event', 'user', 'assistant', 'system', 'tool']);

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
  const attachments = attachmentsOfLine(parsed.attachments);
  return {
    role: parsed.role,
    content: parsed.content ?? '',
    message_id: parsed.message_id ?? '',
    timestamp: parsed.timestamp ?? '',
    ...(typeof parsed.seq === 'number' && parsed.seq > 0 ? { seq: parsed.seq } : {}),
    ...(parsed.agent_id !== undefined ? { agent_id: parsed.agent_id } : {}),
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.source !== undefined ? { source: parsed.source } : {}),
    ...(typeof parsed.label === 'string' && parsed.label ? { label: parsed.label } : {}),
    ...(parsed.reasoning_content !== undefined ? { reasoning_content: parsed.reasoning_content } : {}),
    ...(parsed.steps !== undefined ? { steps: parsed.steps } : {}),
    ...(parsed.partial === true ? { partial: true } : {}),
    ...(typeof parsed.echoSeq === 'number' && parsed.echoSeq > 0 ? { echoSeq: parsed.echoSeq } : {}),
    ...(typeof parsed.run === 'string' && parsed.run ? { run: parsed.run } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

/** 附件引用行内归一（宽容解析：非数组/无合法项 → undefined；项须 kind ∈
 *  image/video/file 且 ref 为串） */
function attachmentsOfLine(v: unknown): LlmAttachment[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: LlmAttachment[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (
      !(a.kind === 'image' || a.kind === 'video' || a.kind === 'file') ||
      typeof a.ref !== 'string' ||
      !a.ref
    ) {
      continue;
    }
    out.push({
      kind: a.kind,
      ref: a.ref,
      ...(typeof a.mime === 'string' ? { mime: a.mime } : {}),
      ...(typeof a.filename === 'string' ? { filename: a.filename } : {}),
      ...(typeof a.detail === 'string' ? { detail: a.detail as LlmImageAttachment['detail'] } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
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
  /**
   * 步内相位序标记（源自 loop 步记录的 textBeforeTools，llm 聚合时记录）：
   * true = 本步正文先于工具调用分片到达。落盘于此并在前端历史展开时
   * 透传——思考过程卡片的步内渲染序（思考恒前；正文/工具卡相对序）。
   * 旧行无此键 = 正文后于工具（常见形态，回落固定序）。
   */
  textBeforeTools?: boolean;
  /**
   * 思考相位时长（毫秒；源自 loop 步记录的 reasoningMs，llm 聚合时记录）：
   * 首个 reasoning 片到达 → 首个非 reasoning 片到达的间隔。落盘于此并
   * 透传前端——历史回放恢复「已思考 · XmYs」耗时。旧行无此键 → 不显示
   * 耗时（组件回落「已思考」）。
   */
  reasoningMs?: number;
  /**
   * 本步 API 调用耗时（毫秒；源自 loop 步记录的 elapsedMs，llm dispatch
   * 层计时——请求发起→流末的纯流时间，不含工具执行）。落盘于此——
   * 会话每轮速率（token/s = 步 token / 步耗时）的历史观测依据。
   * 旧行无此键 → 不参与速率统计。
   */
  elapsedMs?: number;
  /**
   * 本步用量（源自 loop 步记录的 usage，llm 归一化）：elapsedMs 的速率
   * 分子（total = prompt + completion）。落盘于此供历史回放计算每轮速率；
   * 旧行无此键 → 速率不显示（elapsedMs 单独在场无意义，成对判定）。
   */
  usage?: { prompt: number; completion: number; total?: number };
  /**
   * 步完成时刻（epoch ms；源自 loop 的步级时序锚）。收束行把整轮 run
   * 折叠为单行，中途插行（投递消息/机制通知）与步的相对位置靠 steps[].ts
   * 在前端展开时恢复（2026-09-02 反馈：渲染序与落盘序不一致）。
   */
  ts?: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    /** 参数原始 JSON 字符串（前端按需 parse 展示） */
    arguments: string;
    /** 工具体返回的 ToolResult（对象原样 JSON 往返） */
    result: unknown;
    /**
     * run_code 子调用标记（2026-09-17 方向 B：records() subcalls 投影
     * 注入的条目）：true = 本调用由 run_code 程序内发起——前端平铺
     * 渲染独立工具卡（缩进样式）；不参与 LLM 回放（history() 不开投影）。
     */
    subcall?: boolean;
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

/** 生成 run 关联键（部分行 ↔ 收束行对账用） */
function genRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** run 簿记键：loop 事件载荷的 (agent, conversationId) 原样拼接——同一 run
 *  的 run-started/after-step/reply-completed 携带相同二元组，无需 runAddress
 *  规范化词汇（本服务不依赖 ac-agent-loop 寻址面）。任一缺席 = 无会话归属
 *  （直连 subagent 等）→ undefined（不簿记、不落部分行）。 */
/** 切分继承：关闭行未完结调用（result:null）的 id → 关闭行 run 键——
 * 切分后补行按此归属旧 run（覆盖关闭行 result:null 的对账键）。
 * 旧表条目随继承延续（多次切分链）。 */
function inheritPendingCalls(state: { run: string; buffered: SessionStepRecord[]; pendingCalls: Map<string, string> }): Map<string, string> {
  const inherited = new Map(state.pendingCalls);
  for (const s of state.buffered) {
    for (const tc of s.toolCalls ?? []) {
      if (tc.result === null || tc.result === undefined) inherited.set(tc.id, state.run);
    }
  }
  return inherited;
}

function runLogKey(agent: string | undefined, conversationId: string | undefined): string | undefined {
  if (!agent || !conversationId) return undefined;
  return `${agent}|${conversationId}`;
}

/** 部分行行内探测（stats/tail 窗口计数用）：record() 构造的 JSON 行该键值
 *  对唯一且无空格（JSON.stringify 无参格式）——前缀探测免全量 parse */
const PARTIAL_MARK = '"partial":true';

/**
 * tail() 尾窗读取字节数：单条记录受限长输出，8 MiB 窗口足够覆盖末条
 * 完整记录（与 repairTail 的尾窗同款尺寸；越界属病态文件，按「无末条」
 * 处理走全读兜底）。
 */
const TAIL_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * tail() 增量试探小窗（字节，2026-09-19 性能修复）：run 活跃期单轮新增
 * 通常 < 数 KB（单条 checkpoint 行）；64KB 覆盖多行新增 + 衔接余量。
 */
const TAIL_SMALL_WINDOW_BYTES = 64 * 1024;

/** tail() 的末条记录投影（展示字段投影，非完整 SessionRecord） */
type TailRecord = Pick<SessionRecord, 'role' | 'content' | 'timestamp' | 'agent_id' | 'name' | 'source'>;

/**
 * 尾窗文本 → 末条记录投影（tail 的解析核）：自尾向头找最后一条可解析的
 * 非部分行（部分行是 run 进行中的临时 checkpoint）。窗内找不到 = 交回
 * 调用方兜底（可能窗太小或文件病态）。
 */
function tailFromWindow(text: string): TailRecord | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim() || lines[i]!.includes(PARTIAL_MARK)) continue;
    const rec = parseRecordLine(lines[i]!);
    if (rec !== undefined) return rec;
  }
  return undefined;
}

/** 行内时间戳提取（避免全量 JSON.parse；无/坏时间戳不计窗） */
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

/** stats 基线全量校准间隔（ms）：时间窗随墙钟漂移，久未校准的增量
 *  计数会缓慢失真（旧消息出窗不回退）——超时强制一次全量重扫对齐。 */
const STATS_RECALIBRATE_MS = 60_000;

/**
 * subcall 补行 result 截断（2KB）已废除（2026-09-20 双文件剥离）：
 * 工具调用结果应如实记录——subcall 全文改落独立 subcalls.jsonl（不进
 * 主文件热扫描路径），体积代价与扫描性能解耦。存量会话中的截断形
 * （{__truncated:true, bytes, head}）读侧仍宽容呈现（前端有 head 前缀
 * 恢复兜底；迁移脚本可选择性展开）。
 */

/** 按记录时间戳统计各时间窗内消息数（热力色阶数据源；纯函数）。部分行
 *  （步级 checkpoint）不计——与 stats 行计数口径一致。入参为已 split
 *  的行数组（stats 的行计数同源共享，免二次 split）。 */
export function countWindowMessages(lines: readonly string[], now: number): SessionWindowCounts {
  const out: SessionWindowCounts = { h1: 0, d1: 0, d3: 0, d7: 0, d30: 0 };
  for (const line of lines) {
    if (!line || !line.trim() || line.includes(PARTIAL_MARK) || isHeaderLine(line) || isToolResultLine(line)) continue;
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
  // 附件引用随行回放（多模态一期）：history/context 视图产出的 LlmMessage
  // 携带 attachments → provider 适配层按模型物化/剥离
  const attachments =
    r.attachments !== undefined && r.attachments.length > 0 ? { attachments: r.attachments } : {};
  if (r.agent_id !== undefined) {
    // D13 新格式：agent_id 在场 → 自他归属按读者投影（自己的话 assistant）
    let role: LlmRole;
    if (r.role === 'agent') {
      role = viewer !== undefined && r.agent_id === viewer ? 'assistant' : 'user';
    } else if (r.role === 'context' || r.role === 'event' || r.role === 'error') {
      // 上下文材料/机制行/错误：恒 user 语义位（source 无关——回放统一）
      role = 'user';
    } else if (r.role === 'system' || r.role === 'tool') {
      role = r.role;
    } else {
      role = 'user'; // 防御：未知词表按 user 喂回
    }
    return { role, content: r.content, name: r.agent_id, ...attachments };
  }
  if (viewer === undefined) {
    // 匿名读者：旧 baked 行按原 role 直通（与既有 history 行为一致）
    return {
      role: (r.role === 'context' || r.role === 'event' ? 'user' : r.role) as LlmRole,
      content: r.content,
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...attachments,
    };
  }
  const attribution =
    r.name ?? (r.role === 'assistant' && conversationId !== undefined ? conversationId : undefined);
  // 上下文材料/事件行恒按 user 喂回（机制提示的 LLM 语义位——不参与自他归属判定）
  let role: LlmRole;
  if (r.role === 'context' || r.role === 'event') {
    role = 'user';
  } else if (r.role === 'system') {
    role = 'system';
  } else {
    role = attribution === viewer ? 'assistant' : 'user';
  }
  return { role, content: r.content, ...(attribution !== undefined ? { name: attribution } : {}), ...attachments };
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
  return expandSteps(r.steps);
}

/**
 * 步记录 → run 内消息序（expandTrajectory 的步级核，导出供
 * ac-conversation 视图投影复用——轨迹回放形状的单一事实源，防两处漂移）：
 * 每步 assistant(tool_calls?) + 配对 tool 结果行（结果 JSON 串化——
 * 与 loop 回填模型的 content 同源字节）。
 */
export function expandSteps(steps: SessionStepRecord[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const s of steps) {
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

/**
 * LoopRunResult.steps → 持久化步记录（onReplyCompleted 的映射核，导出供
 * ac-conversation 视图投影复用——落盘行与进程内视图的轨迹形状单一事实源）：
 * 工具结果按 tool_calls 序配对（toolResults[i]），无内容步（空正文/空思考/
 * 无调用）滤除。
 */
export function stepsFromRunResult(
  result: Pick<LoopRunResult, 'steps'>,
): SessionStepRecord[] {
  return result.steps
    .map((s) => ({
      content: s.text,
      ...(s.reasoning ? { reasoning: s.reasoning } : {}),
      ...(s.ts !== undefined ? { ts: s.ts } : {}),
      ...(s.textBeforeTools !== undefined ? { textBeforeTools: s.textBeforeTools } : {}),
      ...(s.reasoningMs !== undefined ? { reasoningMs: s.reasoningMs } : {}),
      ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
      ...(s.usage !== undefined ? { usage: s.usage } : {}),
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
  /**
   * stats() 热窗缓存 + 增量基线（file → mtime/size 对应的窗口计数与消息数；
   * scannedBytes/scannedAt = 增量扫描基线，见 stats()）。轮询零重算；
   * run 活跃期文件每轮变化时只读新增段追加计数（原整读 4~5MB 会话每轮
   * 同步阻塞数十 ms × 全部活跃会话——3s 轮询下的持续基底负载）。
   */
  private windowCache = new Map<string, { mtimeMs: number; size: number; windows: SessionWindowCounts; messageCount: number; scannedBytes?: number; scannedAt?: number }>();
  /**
   * tail() 尾部摘要缓存（file → mtime/size 对应的末条记录投影；mtime/size
   * 任一变化即失效重读）。动机：runs/snapshot 每 3s 对全部会话调
   * tail()，原先每轮 readFileSync 整读 messages.jsonl（数百 MB 数据根
   * 实测单轮秒级、同步阻塞事件循环——刷新页面时的 HTTP 请求全部排队）。
   * 缓存 + 尾部窗口读（TAIL_WINDOW_BYTES）后：文件未变零读，变化时也只
   * 读尾窗不整读。同 windowCache/recordsCache 的 mtime 门模式。
   */
  private tailCache = new Map<string, { mtimeMs: number; size: number; tail: TailRecord | undefined }>();
  /**
   * tail() 增量基线（2026-09-19 程序化模式性能修复）：file → 末次成功扫描的
   * 字节偏移 + 该偏移处的行尾状态。run 活跃期 runs/snapshot 3s 轮询对每个
   * 变化会话触发 8MiB 尾窗读——程序化会话（4~6MB、单行可达 680KB）令窗恒
   * 顶格：实测 239 会话冷轮 394ms/267MB 同步读。改为：上次扫描后的新增段
   * 先用小窗（末 64KB）试探——新末条几乎总在近尾部（append-only + 单行
   * checkpoint 远小于 64KB 的一般情形）；小窗内找不到可解析非部分行才回落
   * 大窗（部分行收束/大记录病态场景）。窗起点 = 缓存偏移（若仍在文件界内），
   * 保证与上次扫描的衔接。
   */
  private tailScanCache = new Map<string, { mtimeMs: number; size: number; scanEnd: number }>();
  /**
   * records() 解析缓存（file → mtime/size 对应的已解析记录 + subcall
   * 补行清单——2026-09-17 方向 B：投影注入的数据源随缓存走，命中路径
   * 与首读路径行为一致）：读侧投影
   * 缓存，非第二事实源——mtime/size 任一变化即失效重读，重启随进程消失
   * （S1/S3 同 stats() windowCache 模式）。动机：run 收束的 3 连读
   * （归档判定 + session/tokens + UI 回放）与夜间 archiveAll 批量扫描
   * 原本每次全量 readFileSync + 逐行 JSON.parse（4.6MB 会话 ~30ms 同步
   * 阻塞/次）。条目返回浅拷贝数组；元素对象共享——records() 内部的
   * supplements 覆盖幂等（同值重复覆盖），仓内调用方均为只读投影。
   * LRU 上限防 archiveAll 类全量扫描把内存吃穿（超出按插入序淘汰冷会话）。
   */
  private recordsCache = new Map<string, {
    mtimeMs: number;
    size: number;
    /** partials.jsonl 指纹（2026-09-20 partials 摘除门控）：缺席文件 = 0 稳定值 */
    partMtimeMs: number;
    partSize: number;
    /** subcalls.jsonl 指纹（2026-09-20 双文件门控）：缺席文件 = 0 稳定值 */
    subMtimeMs: number;
    subSize: number;
    records: SessionRecord[];
    /** subcall 补行清单（2026-09-17 方向 B + 2026-09-20 双文件）：投影注入数据源——命中路径同服务 */
    subcallLines?: Array<{ run: string; tool_call_id: string; name?: string; arguments?: string; result: unknown; seq?: number }>;
  }>();
  private static RECORDS_CACHE_MAX = 16;
  /**
   * 活跃 run 簿记（步级部分行配套）：loop/run-started 登记、reply-completed
   * 消费清除。key = runLogKey(agent, conversationId)；同键新 run 覆盖旧项
   * （串行会话门保证同会话不并发；残留项在进程死亡时随内存消失，无害）。
   */
  /** steer 消费前 stash（消息对象 → 投递信息）：步边界消费时切分落账 */
  private steerStash = new WeakMap<object, { conversationId: string; agentId?: string; message: LlmMessage; source?: string; meta?: Record<string, unknown> }>();

  private activeRuns = new Map<string, {
    run: string;
    archiveReview: boolean;
    wrotePartial: boolean;
    /**
     * 本 run 已完成步的全量缓冲（含纯文本步——partial 只落工具步）：
     * 插入切分（变体乙，skill-injection-and-storage-vocab §6）的关闭行
     * 数据源——切分时把切分前全部步打包落关闭行，余下步走新铸 run 键。
     */
    buffered: SessionStepRecord[];
    /**
     * 切分偏移：本 run（新键）之前已被关闭行吸收的步数——收束行
     * steps = stepsFromRunResult(result).slice(offset)（权威结果切片，
     * 防切分前的步在收束行双渲染）。0 = 未切分。
     */
    offset: number;
    /**
     * 切分前未完结调用的补行归属（变体乙）：tool_call_id → 关闭行 run 键。
     * 切分后 activeRuns 换新键，但切分前步的工具终值补行必须落【旧 run】
     * （关闭行 result:null 的覆盖源——补行按 run|tool_call_id 对账）。
     * 调用完结即摘除。
     */
    pendingCalls: Map<string, string>;
  }>();

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
      // 入站即落盘（2026-09-18 send_agent 静默丢失）：入站消息本身是对用户
      // 可见的副作用（与 tool/before-execute 的"副作用前 durable"同语义），
      // 不能只入队等后续 flush——目标桶此后可能再无任何 run 活动（虚拟端点
      // 无 reply-completed、无工具 checkpoint，agent⇄agent 委托在对方开跑
      // 前崩溃同样悬空），pending 滞留内存 = UI 读文件不可见、非优雅退出即
      // 丢。fire-and-forget 不阻塞 emit 链（既有 flushBestEffort 语义）。
      if (source === 'event') {
        this.record(conversationId, agentId, message, { roleOverride: 'context', source: 'event' });
        this.flushBestEffort(conversationId, '入站事件行');
        return;
      }
      this.record(conversationId, sender ?? 'user', message);
      this.flushBestEffort(conversationId, '入站消息');
    }, { description: '入站消息入账 + 即时落盘（对桶 + name 说话人）' });
    this.ctx.on('conversation/steered', (agentId, message, conversationId, _handle, sender, source, meta) => {
      // 插入切分（变体乙）：会话忙（有活跃 run）时 stash，步边界消费点
      // 统一切分落账（关闭行 + 插入行 + 新 run 键）——修复投递时落盘
      // 比 LLM 实际消费提前一步的错位；空闲路径照旧直落（下方原逻辑）。
      const busyKey = runLogKey(agentId, conversationId);
      if (busyKey !== undefined && this.activeRuns.has(busyKey)) {
        this.steerStash.set(message, { conversationId, agentId: sender, message, source, meta });
        return;
      }
      // steer 注入的说话人 = 注入方端点（deliver 调用者），非桶主；
      // 机制标记 run / 群 hint 触发同样不入账（M20 / M21-F6①）
      if (isArchiveReviewRun(meta)) return;
      if (isGroupHint(meta)) return;
      // 机制触发（source='event'，如后台任务完成通知）与 message-received
      // 路径同语义：role:'event' 系统事件行（UI 分隔符渲染；LLM 回放按
      // user 语义位）——此前 steer 入账忽略 source，会话忙时机制通知落成
      // 普通 agent 行（无 source 标注），前端既不渲染分隔符也不显消息
      //（2026-09-02 反馈：通知静默丢失）。同一通知空闲/忙两条入账路径
      // 自此同形。
      if (source === 'event') {
        this.record(conversationId, agentId, message, { roleOverride: 'context', source: 'event' });
        this.flushBestEffort(conversationId, '入站事件行');
        return;
      }
      this.record(conversationId, sender ?? agentId, message);
      this.flushBestEffort(conversationId, '入站消息');
    }, { description: 'steer 消息入账 + 即时落盘（机制通知 → 事件行；普通注入 → 说话人 agent 行）' });
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
    // ---- 步级部分行（src step-persist 平移）----
    // run 进行中每完成一个**带工具调用**的步，先落一条 partial 行（正文/
    // 思维链/工具调用对——结果未回）。工具阻塞等待（ask_questions 等用户
    // 决策）或进程中断时，刷新后的历史首屏可恢复此前的思维链与工具卡；
    // run 正常收束时收束行携带同 run 键，records() 读侧吸收全部部分行——
    // 完成后的落盘形态与步级落盘前逐字节一致（无工具调用的 run 零变化）。
    // 时序保证：after-step 先于工具执行、tool/before-execute checkpoint 随后
    // flush → 部分行在工具副作用/阻塞等待前已 durable。
    this.ctx.on('loop/run-started', (request) => {
      const key = runLogKey(request.agent, request.conversationId);
      if (key === undefined) return;
      this.activeRuns.set(key, {
        run: genRunId(),
        archiveReview: isArchiveReviewRun(request.meta),
        wrotePartial: false,
        buffered: [],
        offset: 0,
        pendingCalls: new Map(),
      });
    }, { description: 'run 簿记：runId 铸造 + 机制 run 标记（部分行门控）' });
    this.ctx.on('loop/after-step', (agent: string | undefined, step: LoopStepRecord, envelope) => {
      const conversationId = envelope?.conversationId;
      const key = runLogKey(agent, conversationId);
      if (key === undefined || conversationId === undefined) return;
      const state = this.activeRuns.get(key);
      if (!state || state.archiveReview) return;
      // 群桶不落部分行（M26 行为对齐）：群本体只收真实发言（post 唯一
      // 口）；群 run 的收束行不再落账 ⇒ 部分行没有吸收锚，落了即永久残留
      if (this.isGroupBucket(conversationId)) return;
      // 纯文本步不落部分行（收束行整行落账；无工具 run 的落盘形态零变化）
      // ——但全量步缓冲不跳过（切分关闭行需要纯文本步）
      if (!step?.toolCalls || step.toolCalls.length === 0) {
        state.buffered.push({
          content: step.text ?? '',
          ...(step.reasoning ? { reasoning: step.reasoning } : {}),
          ...(step.ts !== undefined ? { ts: step.ts } : {}),
          ...(step.textBeforeTools !== undefined ? { textBeforeTools: step.textBeforeTools } : {}),
          ...(step.reasoningMs !== undefined ? { reasoningMs: step.reasoningMs } : {}),
          ...(step.elapsedMs !== undefined ? { elapsedMs: step.elapsedMs } : {}),
          ...(step.usage !== undefined ? { usage: step.usage } : {}),
        });
        return;
      }
      state.wrotePartial = true;
      const stepRecord: SessionStepRecord = {
        content: step.text ?? '',
        ...(step.reasoning ? { reasoning: step.reasoning } : {}),
        ...(step.ts !== undefined ? { ts: step.ts } : {}),
        ...(step.textBeforeTools !== undefined ? { textBeforeTools: step.textBeforeTools } : {}),
        ...(step.reasoningMs !== undefined ? { reasoningMs: step.reasoningMs } : {}),
        ...(step.elapsedMs !== undefined ? { elapsedMs: step.elapsedMs } : {}),
        ...(step.usage !== undefined ? { usage: step.usage } : {}),
        toolCalls: step.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          // 工具尚未执行（落盘先于执行是设计）：结果由 tool/after-execute
          // 补行覆盖（中断 run）或收束行携带（正常收束）
          result: null,
        })),
      };
      state.buffered.push(stepRecord); // 全量步缓冲（切分关闭行数据源）
      this.record(conversationId, agent!, { role: 'user', content: step.text ?? '' }, {
        ...(step.reasoning ? { reasoning: step.reasoning } : {}),
        steps: [stepRecord],
        run: state.run,
        partial: true,
        target: 'partials', // 2026-09-20 摘除：partial 步行不进主文件（run 中间态档案）
      });
    }, { description: '步级部分行落账（工具步 checkpoint——ask_questions 等待期刷新不丢思维链）' });

    // ---- 插入切分（变体乙，skill-injection-and-storage-vocab §6）----
    // run 进行中插入消息（steer 注入 / 技能 context）到达消费点（步边界）
    // 时：当前进度落「关闭行」（携带切分前全部步，含纯文本步；吸收既有
    // partial）→ 插入行落此位 → 余下步走新铸 run 键。自然顺序即回放序
    //（KV 前缀保真），读侧零新逻辑（吸收机制既有）。
    // 时序：steer 投递时挂 stash，步边界消费时才切分（LLM 流期间到达的
    // steer 实际进队在步 N 之后——投递时落盘会提前一步；未消费的 steer
    // 随 loop steerQueue 语义一起丢——模型没见过就不算会话事实）。
    this.ctx.on('loop/step-started', (agent: string | undefined, index: number, messages: unknown, envelope) => {
      const conversationId = envelope?.conversationId;
      if (conversationId === undefined) return;
      // 找本步消息数组里被 stash 的对象（步边界消费完成 = 数组已含它）
      const msgs = Array.isArray(messages) ? (messages as Array<{ role?: string }>) : [];
      const stashed = msgs.map((m, i) => ({ m, i })).filter(({ m }) => this.steerStash.has(m as object));
      if (stashed.length === 0) return;
      for (const { m } of stashed) {
        const info = this.steerStash.get(m as object)!;
        this.steerStash.delete(m as object);
        // 机制标记/群 hint 的 steer 不入账（与空闲路径同款门控）
        if (info.meta !== undefined && (isArchiveReviewRun(info.meta) || isGroupHint(info.meta))) continue;
        // 切分：关闭行（切分前全部步）→ 插入行 → 新 run 键
        this.splitRunAt(conversationId, info.agentId ?? agent, info.message, info.source);
      }
      void index;
    }, { description: '步边界 steer 消费点：插入切分 + 落账' });
    // ---- 工具结果补记（2026-09-04：部分行 result 覆盖源）----
    // after-step 部分行按设计先于工具执行落盘（副作用前 durable），result
    // 恒 null；结果到达（after-execute，transform 后终值）即追加 tool-result
    // 补行。run 中断（手动停止/进程死亡）时收束行永不落盘——补行使：
    //   · records() 覆盖后部分行携带真实结果（UI 刷新不再永久转圈）
    //   · history() 轨迹回放可展开结果齐全的部分行（字节 = 模型实际看到
    //     的前缀 → provider KV 缓存命中 + 完成步记忆）
    // run 正常收束：收束行携带权威结果并吸收同 run 部分行，补行随之失效
    // （读侧不产出）。结果对象 = tools.execute 终值，与 loop 回填模型的
    // content 同源——JSON 往返字节一致（KV 前缀保真的关键）。
    this.ctx.on('tool/after-execute', (call, result) => {
      const conversationId = call.conversationId;
      const key = runLogKey(call.agentId, conversationId);
      if (key === undefined || conversationId === undefined) return;
      const state = this.activeRuns.get(key);
      if (!state || state.archiveReview) return; // 无活跃 run（宿主直调）/机制 run：无部分行可覆盖
      // 群桶不落工具补行（M26：同部分行——群本体只收真实发言）
      if (this.isGroupBucket(conversationId)) return;
      if (typeof call.toolCallId !== 'string' || !call.toolCallId) return; // 幻影调用（空 id）无对账锚
      const isSubcall = call.runCodeSubcall === true;
      // 三文件分流（2026-09-20 partials 摘除）：subcall → subcalls.jsonl；
      // 直调补行 → partials.jsonl（不进主文件——partial/补行同属 run 中间态，
      // 关闭行〔切分〕的终值覆盖源，如实保留不清理；主文件零死重）
      const queue = this.queueOf(conversationId, isSubcall ? 'subcalls' : 'partials');
      const line: ToolResultLine = {
        type: 'tool-result',
        // 补行 run 键（变体乙）：切分前未完结调用归属关闭行 run（覆盖对账
        // 键——新键下关闭行 result:null 永等不到覆盖）；完结即摘除
        run: state.pendingCalls.get(call.toolCallId) ?? state.run,
        tool_call_id: call.toolCallId,
        // 如实记录（2026-09-20 双文件改造）：工具终值原样落盘——截断已废
        // 除（见 capSubcallResult 删除注释）。subcall 行落独立 subcalls.jsonl
        //（UI 回放面专用——不进主文件热扫描路径）；直调补行仍落主文件
        //（部分行覆盖源，字节 = 模型实际所见，KV 前缀保真的组成部分）。
        result,
        ...(isSubcall
          ? {
              subcall: true,
              // 子调用参数随行落盘（2026-09-17 方向 B）：run_code 程序内
              // 调用不在模型 toolCalls 面——参数只在此处可得，records()
              // subcalls 投影据此复原完整工具卡（含文件编辑 diff 追踪）
              ...(call.name !== undefined ? { name: call.name } : {}),
              ...(call.args !== undefined ? { arguments: JSON.stringify(call.args) } : {}),
            }
          : {}),
        // 行序号（各自文件内单调，建队时从盘上末行续起）：主文件行是
        // compact 窗口保护锚；subcalls 行对齐编排顺序——run_code 有并行
        // Promise.all / 串行提交的顺序编排，注入 UI 时按本 seq 排序还原
        //（tool_call_id 的 #seq 尾段与编排序无关——它是程序内调用次序）。
        seq: queue.nextSeq++,
      };
      queue.pending.push(JSON.stringify(line));
      state.pendingCalls.delete(call.toolCallId); // 完结摘除（防后续切分误归属）
      this.flushBestEffort(conversationId, '工具结果补记');
    }, { description: '工具结果补记（run 未收束时的 result 覆盖——中断恢复源 + KV 前缀保真）' });
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

  /**
   * 群桶判定（M26 行为对齐）：shelf='groups'（ac-group D11 上架）。
   * 群本体只收真实发言（post 唯一口）——群 run 的终稿/步级部分行/工具
   * 补行一律不落（send_group 才是发言，契约明示直接输出无人可见）。
   */
  private isGroupBucket(conversationId: string): boolean {
    return this.shelfIndex.get(conversationId) === 'groups';
  }

  /**
   * 插入切分（变体乙，skill-injection-and-storage-vocab §6）：run 进行中
   * 插入消息（steer / 技能 context）到达消费点时调用——
   *   关闭行（role:'agent'，run=旧键，steps=切分前全部步〔含纯文本步〕，
   *   吸收既有 partial）→ 插入行（steer 按原入账形态）→ activeRuns 换新键
   *   （后续步走新 run，收束行 steps 只含切分后的步）。
   * 落盘自然顺序 = 回放顺序（KV 前缀保真）；读侧吸收机制既有，零新逻辑。
   */
  private splitRunAt(conversationId: string, agentId: string | undefined, message: LlmMessage, source?: string, meta?: Record<string, unknown>): void {
    const key = runLogKey(agentId, conversationId);
    const state = key !== undefined ? this.activeRuns.get(key) : undefined;
    if (state === undefined || key === undefined) return; // 无簿记（机制 run 等）：不切分，插入行直落
    // 关闭行：切分前全部步（可能为空——run 首步前的插入；空则不落关闭行，
    // 插入行仍在 run 行之前，位置正确）
    if (state.buffered.length > 0) {
      this.record(conversationId, agentId ?? conversationId, { role: 'user', content: '' }, {
        steps: state.buffered,
        run: state.run,
      });
    }
    // 插入行：与空闲路径同款入账形态（机制行 context / 普通注入 agent）
    if (source === 'event') {
      this.record(conversationId, agentId ?? conversationId, message, { roleOverride: 'context', source: 'event' });
    } else {
      this.record(conversationId, message.role === 'user' ? (agentId ?? 'user') : agentId ?? 'user', message);
    }
    this.flushBestEffort(conversationId, '插入切分');
    // 死重清理已退役（2026-09-20 partials 摘除——见档案 §7）
    void meta;
    // 新 run 键：buffered 清零、wrotePartial 重置（新 partial 走新键）；
    // offset = 切分前步数（收束行切片依据）
    this.activeRuns.set(key, {
      run: genRunId(),
      archiveReview: state.archiveReview,
      wrotePartial: false,
      buffered: [],
      offset: state.offset + state.buffered.length,
      pendingCalls: inheritPendingCalls(state),
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
    // 簿记清理先行（机制/群桶 run 同样消费——早退不留残留项）
    const runKey = runLogKey(agentId, conversationId);
    const active = runKey !== undefined ? this.activeRuns.get(runKey) : undefined;
    if (runKey !== undefined) this.activeRuns.delete(runKey);
    if (isArchiveReviewRun(meta)) return; // 机制标记 run 的回复不入账（M20）
    // 群桶 run 终稿不入群本体（M26 行为对齐）：群内容唯一口 = 群本体
    // post 行（send_group 工具/用户投递）——run 终稿不是群发言（契约
    // 明示"直接输出文本不会发送到群聊"）。判定双保险：hint 投递标记
    // （群 run 恒携带）+ groups shelf（D11 上架的群桶，覆盖非 hint 路径）。
    if (isGroupHint(meta) || this.isGroupBucket(conversationId)) return;
    // 步级部分行收束（消费 run 簿记）：本 run 写过部分行 → 收束行携带同
    // run 键，records() 读侧据此吸收；错误/中断收束不盖章——已落的思维链
    // 部分行保留（run 做过的推理是会话事实，UI 刷新后仍可见）。
    const runStamp = active?.wrotePartial === true ? { run: active.run } : {};
    // 错误收束一等化（D12/F7，§2.3）：role:'error'——UI 错误分隔符，
    // LLM 回放按 user 喂回（告知"出了错"而无自他归因污染）；不再以
    // `[error]` 前缀伪装 assistant 文本落盘。
    if (result.finish === 'error') {
      this.record(conversationId, agentId, { role: 'user', content: String(result.error ?? '循环失败') }, {
        roleOverride: 'context',
        source: 'error',
      });
      this.flushBestEffort(conversationId, '错误行');
      return;
    }
    // 思维链持久化（Port B P3）：run 各步 reasoning 拼接为整轮 thinking，
    // 刷新后历史回放可恢复思维链折叠栏。
    const reasoning = result.steps
      .map((s) => s.reasoning?.trim())
      .filter((r): r is string => !!r)
      .join('\n\n');
    // 步记录持久化（M18 反馈 #6）：工具调用对随 assistant 行落盘——
    // 刷新后 toHistoryMessages 按步重建 assistant+tool 气泡（与直播/
    // resume 快照同构），工具卡片不再丢失。映射核 = stepsFromRunResult
    // （导出：ac-conversation 视图投影同形状——单一事实源防漂移）。
    // 插入切分（变体乙）：收束行只携带切分后的步（切分前的步已在关闭行）
    const allSteps = stepsFromRunResult(result);
    const steps = allSteps.slice(active?.offset ?? 0);
    // 终文本为空仍入账（2026-09-02 反馈 #1）：run 因工具 interrupt
    // （system_restart/reload 等）或 max-steps 收束且末步为工具调用时
    // text=''，但已完成的步（思维链/工具结果对）是会话事实——丢行即
    // "整个 run 的思维链消失，只剩 send_agent 等投递消息"。空 content +
    // steps 携带全部内容：UI 按步重建无空泡；LLM 回放跳过空行（history）。
    if (!text && steps.length === 0) return;
    this.record(
      conversationId,
      agentId,
      { role: 'user', content: text },
      {
        ...(reasoning ? { reasoning } : {}),
        ...(steps.length > 0 ? { steps } : {}),
        ...runStamp,
      },
    );
    this.flushBestEffort(conversationId, '回复');
    // 死重清理已退役（2026-09-20 partials 摘除）：partial 行与直调补行
    // 改落 partials.jsonl（run 中间态档案，如实保留）——主文件零死重，
    // vacuum 无对象。见 skill-injection-and-storage-vocab §7。
  }

  // ============================================================
  // 入账（事件订阅调用；enqueue 不写盘，等待 flush 批量落）
  // ============================================================

  /**
   * context 行落账口（存储词汇 v2，skill-injection-and-storage-vocab §2）：
   * 供技能行等扩展经结构化面写上下文材料行（role:'context' + source/label
   * ——LLM 回放 user 语义位、UI 按 source/label 呈现）。即时落盘（与入站
   * 消息同语义：落账即 durable）。返回行 message_id。
   * split=true（变体乙）：run 进行中的插入（如 load_skill 后注入体）——
   * 先切分（关闭行 + 新 run 键）再落，落位 = 消息数组实际进队位置。
   */
  recordContext(
    conversationId: string,
    agentId: string,
    content: string,
    extra: { source: string; label?: string; split?: boolean },
  ): string {
    let id = '';
    if (extra.split === true) {
      // 变体乙切分：关闭行（吸收切分前步）→ context 插入行落此位 → 新 run 键
      id = this.splitRunWithContext(conversationId, agentId, content, extra);
    } else {
      id = this.record(conversationId, agentId, { role: 'user', content }, {
        roleOverride: 'context',
        source: extra.source,
        ...(extra.label !== undefined ? { label: extra.label } : {}),
      });
      this.flushBestEffort(conversationId, 'context 行');
    }
    return id;
  }

  /** 切分 + context 插入行（recordContext split=true 路径的核） */
  private splitRunWithContext(
    conversationId: string,
    agentId: string,
    content: string,
    extra: { source: string; label?: string },
  ): string {
    const key = runLogKey(agentId, conversationId);
    const state = key !== undefined ? this.activeRuns.get(key) : undefined;
    if (state === undefined || key === undefined) {
      // 无活跃簿记（run 未开始/已收束）：直落 context 行（位置正确——run 行前后）
      const id = this.record(conversationId, agentId, { role: 'user', content }, {
        roleOverride: 'context',
        source: extra.source,
        ...(extra.label !== undefined ? { label: extra.label } : {}),
      });
      this.flushBestEffort(conversationId, 'context 行');
      return id;
    }
    // 关闭行（切分前全部步）
    if (state.buffered.length > 0) {
      this.record(conversationId, agentId, { role: 'user', content: '' }, {
        steps: state.buffered,
        run: state.run,
      });
    }
    // context 插入行（source/label 词汇 v2 形态）
    const id = this.record(conversationId, agentId, { role: 'user', content }, {
      roleOverride: 'context',
      source: extra.source,
      ...(extra.label !== undefined ? { label: extra.label } : {}),
    });
    this.flushBestEffort(conversationId, 'context 插入切分');
    this.activeRuns.set(key, {
      run: genRunId(),
      archiveReview: state.archiveReview,
      wrotePartial: false,
      buffered: [],
      offset: state.offset + state.buffered.length,
      pendingCalls: inheritPendingCalls(state),
    });
    // 死重清理已退役（2026-09-20 partials 摘除——见档案 §7）
    return id;
  }

  /**
   * 入账一条消息（幂等：同一对象对同一会话只入队一次；id/timestamp 经
   * WeakMap 固化——同一消息对象重复入队产出同 id 行，且**不变异消息对象**
   * 本身：固化字段只进落盘行，绝不随消息引用流回 provider 请求体
   * ——M21 §8.2-C 字节分叉的修复点）。
   * 【D13 中性写入】行角色 = 话语类别：缺省 'agent'（一切真实发言），
   * extra.roleOverride 供上下文行（'context' + source/label——词汇 v2；
   * 'event'/'error' 存量词不再写）；归属 = agent_id 参数
   * （说话人端点），message.role 不再参与落盘形态。
   * @returns 落盘行 message_id（D11：群本体经本口入账，行 id 与
   *   GroupFeed 锚点/message_id 对齐）
   */
  private record(
    conversationId: string,
    agentId: string,
    message: LlmMessage,
    extra: {
      roleOverride?: 'context' | 'event' | 'error';
      source?: string;
      label?: string;
      reasoning?: string;
      /** ReAct 步记录（agent 回复行；工具调用对持久化，M18 反馈 #6） */
      steps?: SessionStepRecord[];
      /** run 关联键（步级部分行/收束行对账；records() 读侧吸收依据） */
      run?: string;
      /** 步级部分行标记（run 进行中的工具步 checkpoint） */
      partial?: boolean;
      /** 落盘目标（2026-09-20 partials 摘除）：partial 行落 partials.jsonl；
       *  缺省 messages。补行走独立构造不经本口 */
      target?: 'messages' | 'partials';
    } = {},
  ): string {
    assertConversationId(conversationId);
    const queue = this.queueOf(conversationId, extra.target ?? 'messages');
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
      ...(extra.label !== undefined && extra.label ? { label: extra.label } : {}),
      ...(extra.reasoning ? { reasoning_content: extra.reasoning } : {}),
      ...(extra.steps !== undefined && extra.steps.length > 0 ? { steps: extra.steps } : {}),
      ...(extra.partial === true
        // echoSeq：归位锚——partial 落盘时刻主文件队列序快照。partials 行
        // 读侧归位依据（主文件 seq 域的确定序，同毫秒 timestamp 歧义免疫）
        ? { partial: true, echoSeq: this.queueOf(conversationId, 'messages').nextSeq }
        : {}),
      ...(extra.run ? { run: extra.run } : {}),
      ...(message.attachments !== undefined && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
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
    // 三文件（2026-09-20 partials 摘除）：partials/subcalls 队列作废 + pending
    // 防御性搬移（目录整迁已带文件本体）
    const oldPartFile = path.join(oldDir, 'partials.jsonl');
    const partQueue = this.queues.get(oldPartFile);
    if (partQueue && partQueue.pending.length > 0) {
      fs.appendFileSync(path.join(newDir, 'partials.jsonl'), partQueue.pending.join('\n') + '\n', 'utf-8');
    }
    this.queues.delete(oldPartFile);
    const oldSubFile = path.join(oldDir, 'subcalls.jsonl');
    const subQueue = this.queues.get(oldSubFile);
    if (subQueue && subQueue.pending.length > 0) {
      fs.appendFileSync(path.join(newDir, 'subcalls.jsonl'), subQueue.pending.join('\n') + '\n', 'utf-8');
    }
    this.queues.delete(oldSubFile);
    this.queues.delete(oldFile);
    this.windowCache.delete(oldFile);
    this.windowCache.delete(newFile);
    this.recordsCache.delete(oldFile);
    this.recordsCache.delete(newFile);
    this.tailCache.delete(oldFile);
    this.tailCache.delete(newFile);

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

  /** 会话数据文件路径（三文件分工，partials 摘除 2026-09-20：
   *  messages = 会话定稿流〔header/user/agent/context/关闭行/收束行——
   *  append-only 事实流，无死重〕；partials = run 中间态〔partial 步行 +
   *  tool-result 补行——关闭行终值覆盖源，如实保留不清理〕；
   *  subcalls = run_code 子调用档案〔UI 回放面〕） */
  private dataFile(conversationId: string, kind: 'messages' | 'partials' | 'subcalls'): string {
    return path.join(
      this.conversationDir(conversationId),
      kind === 'subcalls' ? 'subcalls.jsonl' : kind === 'partials' ? 'partials.jsonl' : 'messages.jsonl',
    );
  }

  /** stat 兜底零值（文件缺席 = 0 稳定指纹——缓存门控用，见 recordsCache） */
  private statOrZero(file: string): { mtimeMs: number; size: number } {
    try {
      const st = fs.statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { mtimeMs: 0, size: 0 };
    }
  }

  private queueOf(conversationId: string, kind: 'messages' | 'partials' | 'subcalls' = 'messages'): LogQueue {
    const file = this.dataFile(conversationId, kind);
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

  /** 排空会话的 pending 与在途写，直到 quiescence（barrier 复用）。
   *  双文件（2026-09-20）：messages 与 subcalls 队列（在场时）一并排空。 */
  async flush(conversationId: string): Promise<void> {
    const dir = this.conversationDir(conversationId);
    const barriers: Array<Promise<void>> = [];
    for (const name of ['messages.jsonl', 'partials.jsonl', 'subcalls.jsonl'] as const) {
      const queue = this.queues.get(path.join(dir, name));
      if (!queue) continue;
      if (queue.barrier) { barriers.push(queue.barrier); continue; }
      const barrier = this.drain(queue).finally(() => {
        if (this.queues.get(queue.file) === queue) queue.barrier = undefined;
      });
      queue.barrier = barrier;
      barriers.push(barrier);
    }
    if (barriers.length === 0) return;
    await Promise.all(barriers);
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
    // 事件行 journal 折叠（P2）：仅对角线自会话桶 + viewer 显式配置 journal
    // 时启用。两遍扫描：先定位全部（对 viewer 可见的）event 行，尾部 K 条
    // 之外折叠为一条计数摘要（插入在首条被折叠 event 行的位置，保序）。
    const journalMode =
      options.viewer !== undefined &&
      this.eventReplayOf(options.viewer) === 'journal' &&
      conversationId === `${options.viewer}~${options.viewer}`;
    let eventIndexes: number[] = [];
    if (journalMode) {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        // 词汇 v2：context+source:'event' 才是可折叠的机制行——技能注入行
        //（source:'skill' 等）正文即语义，折叠即丢失，天然豁免
        if (r.role !== 'event' && !(r.role === 'context' && r.source === 'event')) continue;
        // hint 视点过滤同口径：投递目标非 viewer 的 event 行本就被跳过——
        // 不计入折叠范围（折叠摘要只覆盖本就会回放的行）。
        if (r.agent_id !== undefined && r.agent_id !== options.viewer) continue;
        eventIndexes.push(i);
      }
    }
    const keepEvents = journalMode ? this.eventJournalKeepOf(options.viewer!) : Infinity;
    const foldedSet = keepEvents < eventIndexes.length
      ? new Set(eventIndexes.slice(0, eventIndexes.length - keepEvents))
      : null;
    let foldSummaryInserted = false;
    const rows: LlmMessage[] = [];
    for (const [idx, r] of records.entries()) {
      if (foldedSet !== null && foldedSet.has(idx)) {
        if (!foldSummaryInserted) {
          foldSummaryInserted = true;
          rows.push({
            role: 'user',
            content: `[机制运行日志] 此前有 ${foldedSet.size} 次机制触发（定时/任务通知），细节已折叠——最新触发见下方近期条目；需要细节可用会话记录工具查阅。`,
          });
        }
        continue; // 折叠行跳过（摘要占位于首条折叠处，保序）
      }
      // 部分行（run 未收束残留）：工具结果补记齐全（records 覆盖后）→ 视同
      // 普通 steps 行回放——中断 run 已见前缀**字节保真**（provider KV 缓存
      // 命中 + 完成步记忆，2026-09-04）；不齐（工具执行中进程死亡）→ 跳过
      //（悬空 tool_calls 破坏 provider 消息序）。
      const stepsComplete = (r.steps ?? []).length > 0
        && r.steps!.every((s) => (s.toolCalls ?? []).every((tc) => tc.result !== null && tc.result !== undefined));
      if (r.partial === true && !stepsComplete) continue;
      // 空 content 的 agent 行：内容全在 steps（中断/max-steps 收束、部分行）
      // ——viewer 轨迹回放可展开时保留（恢复 run 内消息序），否则跳过
      //（回放层面与"不入账"语义一致）。
      const replaySteps = replayTrajectory
        && options.viewer !== undefined
        && r.agent_id === options.viewer
        && (r.steps ?? []).length > 0;
      if (r.role === 'agent' && !(r.content ?? '').trim() && !replaySteps) continue;
      // hint 视点过滤（2026-09-02 询问补齐）：event 行带投递目标（agent_id）
      // ——只喂给目标读者。role:'agent' 行按 viewer 换位投影（自己的话
      // assistant / 对方 user），event 行此前读者无关：共享对桶 a⇋b 里发给
      // b 的"你请求的…"类第二人称 hint 会原样进对端 a 的回放上下文（误导）。
      // UI（records）不受影响——共享时间线的分隔符读者无关。
      if (
        (r.role === 'event' || r.role === 'context') &&
        options.viewer !== undefined &&
        r.agent_id !== undefined &&
        r.agent_id !== options.viewer
      ) {
        continue;
      }
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
   * `session.replayTrajectory`（M21 时代全局域——双读过渡，显式布尔
   * 受尊重）；两处皆无 = 缺省 true（2026-10 缺省翻转：质量优先——
   * 原缺省 false 是成本优先取舍，见 replay-trajectory.test 头注）。
   * 公开读取口：ac-conversation 的视图投影同口径消费（进程内视图与
   * 文件重派生字节等价的前提——两处判定必须同源）。
   * 软依赖 agents/config（M12 铁律 2：跨服务方法调用走
   * ctx.get——组合缺行不炸回放）。
   */
  replayTrajectoryOf(viewer: string): boolean {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf?(id: string, name?: string): unknown }
      | undefined;
    const merged = agents?.settingsOf?.(viewer, 'session');
    if (merged !== undefined && merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
      const v = (merged as { replayTrajectory?: unknown }).replayTrajectory;
      if (v !== undefined) return v === true;
    }
    const config = this.ctx.get('config', false) as { get?(key: string): unknown } | undefined;
    const legacy = config?.get?.('session.replayTrajectory');
    return typeof legacy === 'boolean' ? legacy : true;
  }

  /**
   * 事件行回放模式（P2 自会话成本治理）：
   *   · 'full'（缺省）——event 行全量原文回放（历史行为，零变化）；
   *   · 'journal'——对角线自会话桶（conversationId = viewer~viewer，机制
   *     驱动的运行日志）的**旧 event 行**折叠为计数摘要，仅保留最近
   *     eventJournalKeep（缺省 6）条原文。非自会话桶不受影响（用户直答/
   *     委托对桶的 event 行语义不同，不折叠）。
   * 动机：30 分钟一轮的定时器让自会话 event 行无限堆积，每条 hint 原文
   * （数百字符）随全部历史每轮重放——news 实测单轮上下文 37 万 tokens
   * 中 event 行占大头，而"过去 46 次触发全部静默"的信息量是一行字。
   * 存储（records/UI）不动——本模式只作用于 LLM 回放投影。
   */
  eventReplayOf(viewer: string): 'full' | 'journal' {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf?(id: string, name?: string): unknown }
      | undefined;
    const merged = agents?.settingsOf?.(viewer, 'session');
    if (merged !== undefined && merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
      const v = (merged as { eventReplay?: unknown }).eventReplay;
      if (v === 'journal') return 'journal';
      if (v === 'full') return 'full';
    }
    return 'full'; // 缺省零变化
  }

  /** journal 模式保留的最近 event 行数（settings.session.eventJournalKeep；缺省 6） */
  eventJournalKeepOf(viewer: string): number {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf?(id: string, name?: string): unknown }
      | undefined;
    const merged = agents?.settingsOf?.(viewer, 'session');
    if (merged !== undefined && merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
      const v = (merged as { eventJournalKeep?: unknown }).eventJournalKeep;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
    }
    return 6;
  }

  /**
   * 回放持久化行（含 message_id/timestamp；M12 归档去重与审计的读取口）。
   * 不含概要头部——概要是压缩产物不是事实消息。与 history() 同：先排空在途队列。
   */
  async records(conversationId: string, options: { subcalls?: boolean } = {}): Promise<SessionRecord[]> {

    try {

      await this.flush(conversationId);
    } catch (err) {
      this.ctx.logger.warn(`[session] 回放前 flush 失败（${conversationId}）: ${String(err)}`);
    }
    const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
    // 解析缓存（mtime/size 门）：文件未变 → 免 readFileSync + 逐行 parse，
    // 直接复用已解析记录（run 收束 3 连读降为 1 读）。返回浅拷贝数组，
    // 元素对象共享（调用方只读；supplements 覆盖幂等）。缺失/失准 =
    // stat 兜底重读，行为与无缓存完全一致。
    try {
      const stat = fs.statSync(file);
      // 三指纹门控（2026-09-20 三文件）：messages/partials/subcalls 任一
      // 变化即失准重读（partials 新增补行不触发主文件 mtime 变化——
      // 关闭行终值覆盖依赖补行可见性）
      const partStat = this.statOrZero(this.dataFile(conversationId, 'partials'));
      const subStat = this.statOrZero(this.dataFile(conversationId, 'subcalls'));
      const cached = this.recordsCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        && cached.partMtimeMs === partStat.mtimeMs && cached.partSize === partStat.size
        && cached.subMtimeMs === subStat.mtimeMs && cached.subSize === subStat.size) {
        // subcall 投影：缓存的 subcallLines（已解析的补行）注入浅拷贝副本
        return this.injectSubcalls([...cached.records], cached.subcallLines ?? [], options);
      }
    } catch {
      // stat 失败 = 会话文件不存在/不可达 → 走下方空会话路径
    }
    let lines: string[] = [];
    try {
      if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf-8').split('\n');
      // partials 合并读取（2026-09-20 摘除）：partial 步行 + 直调补行。
      // 顺序恢复（records 时序契约）：partial 行按 run 键插回其锚行（同 run
      // 的首个非 partial 行——关闭行/收束行）之前——落盘前它们本就在锚行
      // 之前的时序位。补行不产出 SessionRecord（顺序无关，直接追加尾部）。
      const partFile = this.dataFile(conversationId, 'partials');
      if (fs.existsSync(partFile)) {
        const partLines = fs.readFileSync(partFile, 'utf-8').split('\n');
        // 先分层：partial 消息行（带 run）与补行（type:tool-result）
        const partMsgs: Array<{ run: string; line: string }> = [];
        const partSups: string[] = [];
        for (const pl of partLines) {
          if (!pl.trim()) continue;
          if (isToolResultLine(pl)) {
            partSups.push(pl);
            continue;
          }
          try {
            const pr = JSON.parse(pl) as { run?: unknown };
            if (typeof pr.run === 'string' && pr.run) {
              partMsgs.push({ run: pr.run, line: pl });
              continue;
            }
          } catch { /* 坏行照走尾部 */ }
          partSups.push(pl);
        }
        if (partMsgs.length > 0) {
          // 主文件行内找各 run 的首个锚行位置（非 partial 且同 run）；
          // 找不到锚（run 未收束）→ 该 run 的 partial 行插在全部主行后
          //（时序上确属最新——run 进行中）
          const anchorIdx = new Map<string, number>();
          for (let li = 0; li < lines.length; li++) {
            const ml = lines[li];
            if (!ml.trim() || isHeaderLine(ml) || isToolResultLine(ml)) continue;
            try {
              const mr = JSON.parse(ml) as { run?: unknown; partial?: unknown };
              if (typeof mr.run === 'string' && mr.run && mr.partial !== true && !anchorIdx.has(mr.run)) {
                anchorIdx.set(mr.run, li);
              }
            } catch { /* 忽略 */ }
          }
          const merged: string[] = [];
          let consumed = new Set<number>();
          for (let li = 0; li < lines.length; li++) {
            const ml = lines[li];
            let isAnchor = false;
            if (ml.trim() && !isHeaderLine(ml) && !isToolResultLine(ml)) {
              try {
                const mr = JSON.parse(ml) as { run?: unknown; partial?: unknown };
                if (typeof mr.run === 'string' && mr.run && mr.partial !== true && anchorIdx.get(mr.run) === li) isAnchor = true;
              } catch { /* 忽略 */ }
            }
            if (isAnchor) {
              // 该锚行前插入同 run 的 partial 行（保持 partials 文件内相对序）
              const mr = JSON.parse(ml) as { run: string };
              for (let pi = 0; pi < partMsgs.length; pi++) {
                if (!consumed.has(pi) && partMsgs[pi].run === mr.run) {
                  merged.push(partMsgs[pi].line);
                  consumed.add(pi);
                }
              }
            }
            merged.push(ml);
          }
          // 未消费（无锚 = run 未收束）：按 echoSeq 归位（partial 落盘时刻
          // 的主文件队列序——插在主文件 seq >= echoSeq 的首行之前；同毫秒
          // timestamp 歧义免疫。无 echoSeq（异常行）→ 尾部）
          for (let pi = 0; pi < partMsgs.length; pi++) {
            if (consumed.has(pi)) continue;
            let echo = 0;
            try {
              const pe = JSON.parse(partMsgs[pi].line) as { echoSeq?: unknown };
              echo = typeof pe.echoSeq === 'number' && pe.echoSeq > 0 ? pe.echoSeq : 0;
            } catch { /* 坏行 → 尾部 */ }
            let at = merged.length;
            if (echo > 0) {
              for (let mi = 0; mi < merged.length; mi++) {
                const ml = merged[mi];
                if (!ml.trim() || isHeaderLine(ml) || isToolResultLine(ml)) continue;
                try {
                  const me = JSON.parse(ml) as { seq?: unknown };
                  if (typeof me.seq === 'number' && me.seq >= echo) { at = mi; break; }
                } catch { /* 忽略 */ }
              }
            }
            merged.splice(at, 0, partMsgs[pi].line);
          }
          lines = merged;
        }
        lines.push(...partSups);
      }
    } catch {
      return []; // 读失败按空会话处理
    }
    const out: SessionRecord[] = [];
    // 工具结果补记（run → tool_call_id → 终值）：不产出 SessionRecord，
    // 尾部统一覆盖到【未收束 run】的部分行 result:null 上。
    // subcall 补行（run_code 子调用）另收集（options.subcalls 投影注入用）
    const supplements = new Map<string, unknown>();
    const subcallLines: Array<{ run: string; tool_call_id: string; name?: string; arguments?: string; result: unknown; seq?: number }> = [];
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
      if (isToolResultLine(line)) {
        try {
          const sup = JSON.parse(line) as Partial<ToolResultLine>;
          if (typeof sup.run === 'string' && sup.run && typeof sup.tool_call_id === 'string' && sup.tool_call_id) {
            // 主文件只收直调补行（部分行覆盖源）。subcall 行双文件改造
            //（2026-09-20）后落 subcalls.jsonl——此处若仍见 subcall:true 是
            // 迁移前的存量行：读侧兼容收集（对账 + 投影同收，迁移后消失）
            supplements.set(`${sup.run}|${sup.tool_call_id}`, sup.result);
            if (sup.subcall === true) {
              subcallLines.push({
                run: sup.run,
                tool_call_id: sup.tool_call_id,
                ...(typeof sup.name === 'string' && sup.name ? { name: sup.name } : {}),
                ...(typeof sup.arguments === 'string' && sup.arguments ? { arguments: sup.arguments } : {}),
                ...(typeof sup.seq === 'number' ? { seq: sup.seq } : {}),
                result: sup.result,
              });
            }
          }
        } catch {
          // 损坏补行忽略
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
    // 部分行吸收（读侧投影）：同 run 已有非部分收束行 → 其部分行不再可见
    // （append-only 文件不动；物理清除随 compact/deleteMessage 等原子重写
    // 自然发生——重写的 keep 集来自本投影）。run 未收束（工具阻塞等待 /
    // 中断 / 进程死亡）时无收束行，部分行保留——刷新后恢复思维链的恢复源。
    const absorbedRuns = new Set<string>();
    for (const r of out) {
      if (r.run !== undefined && r.partial !== true) absorbedRuns.add(r.run);
    }
    let visible = out;
    if (absorbedRuns.size > 0) {
      visible = out.filter((r) => r.partial !== true || r.run === undefined || !absorbedRuns.has(r.run));
    }
    // 补行覆盖：未收束 run 的部分行 result:null ← 工具终值（收束行已带
    // 权威结果，被吸收 run 的补行无落点、自然失效）。覆盖发生在缓存入库
    // **之前**——缓存条目即已含覆盖结果，命中路径零重复计算（同 run 补行
    // 重复到达时同值幂等覆盖，无漂移）。
    if (supplements.size > 0) {
      for (const r of visible) {
        // 覆盖面（2026-09-20 partials 摘除后扩）：partial 行（中断恢复源）
        // + 关闭行（切分 variant 的 steps 携带 result:null——终值在 partials
        // 补行，读侧合并覆盖）。匹配键 run|tool_call_id，无补行则不动。
        if (r.run === undefined || r.steps === undefined) continue;
        for (const s of r.steps) {
          for (const tc of s.toolCalls ?? []) {
            if (tc.result !== null && tc.result !== undefined) continue;
            const hit = supplements.get(`${r.run}|${tc.id}`);
            if (hit !== undefined) tc.result = hit;
          }
        }
      }
    }
    // subcalls.jsonl 合并读取（2026-09-20 双文件剥离）：run_code 子调用补行
    // 的独立档案——全文如实记录（无截断），UI 投影（options.subcalls）与
    // 存量迁移期主文件内的 subcall 行（上方兼容收集）合并服务。文件缺席
    //（非程序化会话/未迁移）= 空清单，行为与从前一致。
    try {
      const subFile = this.dataFile(conversationId, 'subcalls');
      if (fs.existsSync(subFile)) {
        for (const line of fs.readFileSync(subFile, 'utf-8').split('\n')) {
          if (!line.trim() || isHeaderLine(line)) continue;
          if (!isToolResultLine(line)) continue;
          try {
            const sup = JSON.parse(line) as Partial<ToolResultLine>;
            if (typeof sup.run === 'string' && sup.run && typeof sup.tool_call_id === 'string' && sup.tool_call_id) {
              subcallLines.push({
                run: sup.run,
                tool_call_id: sup.tool_call_id,
                ...(typeof sup.name === 'string' && sup.name ? { name: sup.name } : {}),
                ...(typeof sup.arguments === 'string' && sup.arguments ? { arguments: sup.arguments } : {}),
                ...(typeof sup.seq === 'number' ? { seq: sup.seq } : {}),
                result: sup.result,
              });
            }
          } catch {
            // 损坏补行忽略
          }
        }
      }
    } catch {
      // subcalls 文件读失败：按无子调用处理（主文件不受影响）
    }
    // 缓存入库（快照按读取时刻的 mtime/size 盖章；后续写/重写使 mtime 或
    // size 变化即失准重读）。LRU 上限：archiveAll 类全量扫描 135+ 会话时
    // 防内存无界（淘汰最冷条目 = 重读一次，行为不变）。缓存条目保持无
    // subcall 投影的纯净形（注入在入库之后的返回副本上——见下）。
    try {
      const stat = fs.statSync(file);
      // subcall 补行随缓存保存（投影开关注作用于读取方；缓存条目本身
      // 持有未注入的纯净 records + 补行清单——命中路径两态都可服务）
      const partStat = this.statOrZero(this.dataFile(conversationId, 'partials'));
      const subStat = this.statOrZero(this.dataFile(conversationId, 'subcalls'));
      // 三指纹（2026-09-20 三文件缓存门控）：任一变化即失准
      this.recordsCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, partMtimeMs: partStat.mtimeMs, partSize: partStat.size, subMtimeMs: subStat.mtimeMs, subSize: subStat.size, records: visible, subcallLines });
      if (this.recordsCache.size > SessionService.RECORDS_CACHE_MAX) {
        const coldest = this.recordsCache.keys().next().value;
        if (coldest !== undefined) this.recordsCache.delete(coldest);
      }
    } catch {
      // stat 失败（并发删除等）：不入缓存，读结果仍正确返回
    }
    // subcall 投影注入（2026-09-17 方向 B：run_code 子调用平铺）：
    // options.subcalls = true 时把 subcall 补行注入同 run 行的
    // steps[].toolCalls（subcall: true 标记）。定位 = 子调用 toolCallId
    // 形如 `<runId>#<seq>`——宿主 run_code 调用 id 即前缀 runId；找不到
    // 宿主（收束行被吸收/删消息）的子调用如实丢弃（无渲染锚）。
    // 注入在缓存入库**之后**的浅拷贝副本上（缓存对象零污染——命中路径
    // 复用缓存行对象，投影不得变异它们）；同宿主的多次子调用按 seq 排序
    // 追加。默认不开（history() LLM 回放面纯净——子调用不进 provider
    // 上下文，KV 前缀不受污染）。
    return this.injectSubcalls(visible, subcallLines, options);
  }

  /**
   * subcall 投影注入（2026-09-17 方向 B：run_code 子调用平铺）：
   * options.subcalls = true 时把 subcall 补行注入同 run 行的
   * steps[].toolCalls（subcall: true 标记）。定位 = 子调用 toolCallId
   * 形如 `<runId>#<seq>`——宿主 run_code 调用 id 即前缀 runId；找不到
   * 宿主（收束行被吸收/删消息）的子调用如实丢弃（无渲染锚）。
   * 注入在浅拷贝副本上（缓存条目与调用方共享对象零污染）；同宿主的
   * 多次子调用按 seq 排序追加。默认不开（history() LLM 回放面纯净
   * ——子调用不进 provider 上下文，KV 前缀不受污染）。
   * 收束行的注入同样生效（收束行 steps 带 run_code 调用对，subcall
   * 补行按 toolCallId 前缀定位宿主——与 run_code 卡片的 trace 时间线
   * 互补：trace 是摘要、本投影是完整卡片 + diff 追踪）。
   */
  private injectSubcalls(
    records: SessionRecord[],
    subcallLines: Array<{ run: string; tool_call_id: string; name?: string; arguments?: string; result: unknown; seq?: number }>,
    options: { subcalls?: boolean },
  ): SessionRecord[] {
    if (options.subcalls !== true || subcallLines.length === 0) return records;
    // 宿主 id 索引（2026-09-19 性能修复）：tool_call_id 形如 <hostId>#<seq>，
    // 宿主 id = 首 # 前段——一次分组替代每 toolCall 的全表 startsWith 扫描
    // （O(N×M) → O(N+M)；重度会话 320 调用 × 420 子调用实测 17ms → <1ms）。
    const byHost = new Map<string, typeof subcallLines>();
    for (const k of subcallLines) {
      const hash = k.tool_call_id.indexOf('#');
      if (hash <= 0) continue;
      const host = k.tool_call_id.slice(0, hash);
      const bucket = byHost.get(host);
      if (bucket) bucket.push(k);
      else byHost.set(host, [k]);
    }
    const injected = records.map((r) => ({ ...r, ...(r.steps !== undefined ? { steps: r.steps.map((s) => ({ ...s, ...(s.toolCalls !== undefined ? { toolCalls: [...s.toolCalls] } : {}) })) } : {}) }));
    for (const r of injected) {
      // 宿主匹配 = steps[].toolCalls[].id 前缀（byHost 键）。run 键非必需：
      // 未写过 partial 步行的 run（如纯 run_code 单步）收束行无 runStamp——
      // 同样是合法注入锚（修复前此类宿主的子调用被静默丢弃）。
      if (r.steps === undefined) continue;
      for (const s of r.steps) {
        if (!s.toolCalls) continue;
        for (let i = 0; i < s.toolCalls.length; i++) {
          const kids = byHost.get(s.toolCalls[i].id);
          if (kids === undefined || kids.length === 0) continue;
          // 排序键 = 行 seq（subcalls.jsonl 行内单调——run_code 提交序：并行
          // Promise.all 各分支完成序 ≠ 编排序，seq 才是程序语义序）。存量行
          //（迁移前无 seq）回退 tool_call_id 尾段（程序内调用次序，近似）。
          kids.sort((a, b) => (a.seq ?? seqOfToolCallId(a.tool_call_id)) - (b.seq ?? seqOfToolCallId(b.tool_call_id)));
          s.toolCalls.splice(i + 1, 0, ...kids.map((k) => ({
            id: k.tool_call_id,
            name: k.name ?? '(unknown)',
            arguments: k.arguments ?? '{}',
            result: k.result,
            subcall: true,
          })));
          i += kids.length;
        }
      }
    }
    return injected;
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
   * 重启后作答对账补记（late-reply 恢复源，2026-09-15 上下文丢失事故修复）：
   * 按 toolCallId 反查会话里**未收束 run** 的部分行（result:null 悬空调用），
   * 落一条 tool-result 补行——读侧 records() 覆盖后 history() 的 stepsComplete
   * 门放行，悬空 tool_calls 获得结果，整段轨迹（正文/思维链/调用对）回到
   * 回放上下文。run 死亡（后端重启/进程中断）时 tool/after-execute 永不再发
   * （进程内簿记随进程消失）——ask_questions 等对账型工具的答案由本口补位
   * （result 形状与工具正常返回约定一致，由调用方构造）。
   * 幂等：目标调用已有非 null 结果（已补记过/收束行）→ 无落点返回 false，
   * 不落行。返回 true = 补行已落盘（await flush——先补记后唤醒的时序锚）。
   */
  async backfillToolResult(conversationId: string, toolCallId: string, result: unknown): Promise<boolean> {
    if (typeof toolCallId !== 'string' || !toolCallId) return false;
    const records = await this.records(conversationId);
    // 反查落点：可见部分行（absorbedRuns 未吸收 = run 未收束）里 id 匹配且
    // 结果仍悬空的调用——沿用读侧既有 supplements 覆盖键（run|tool_call_id）
    let run: string | undefined;
    outer: for (const r of records) {
      if (r.partial !== true || r.run === undefined || r.steps === undefined) continue;
      for (const s of r.steps) {
        for (const tc of s.toolCalls ?? []) {
          if (tc.id === toolCallId && (tc.result === null || tc.result === undefined)) {
            run = r.run;
            break outer;
          }
        }
      }
    }
    if (run === undefined) return false;
    const queue = this.queueOf(conversationId);
    const line: ToolResultLine = {
      type: 'tool-result',
      run,
      tool_call_id: toolCallId,
      result,
      seq: queue.nextSeq++,
    };
    queue.pending.push(JSON.stringify(line));
    await this.flush(conversationId);
    return true;
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
    this.recordsCache.delete(file); // 重写即失效（mtime 门兜底存在；主动删免一次失准读）
    this.tailCache.delete(file);
    this.tailScanCache.delete(file); // 增量基线随重写作废（字节偏移不再可信）
    this.windowCache.delete(file); // 增量基线随重写作废（tmp+rename 重排全文件，字节偏移不再可信）
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
    const file = path.join(dir, 'messages.jsonl');
    this.queues.delete(file);
    this.queues.delete(path.join(dir, 'partials.jsonl')); // 三文件（2026-09-20 partials 摘除）
    this.queues.delete(path.join(dir, 'subcalls.jsonl'));
    this.recordsCache.delete(file);
    this.tailCache.delete(file);
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
   * 会话文件元信息（2026-09-19 性能修复，runs/snapshot 指纹专用）：
   * stat 直取 size/mtime——零文件读、零解析。digest 判等只需「变没变」，
   * 不需要尾部摘要与窗口计数的值（变化了才展开真数据）。不存在 = undefined。
   */
  statMeta(conversationId: string): { size: number; mtimeMs: number } | undefined {
    try {
      const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
      const st = fs.statSync(file);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * 会话轻量统计（M17-D 运行矩阵数据源；只读扫描不写——规约 1）。
   * 读文件行数/mtime + 热力时间窗（windows：h1/dN 窗口内消息数——
   * 矩阵范围色阶数据源）。不存在返回 undefined。
   *
   * 性能（run 活跃期优化）：缓存命中的 mtime/size 门不变；文件变化时
   * 不再整读——以缓存里的 scannedBytes 为基线只读新增段，行计数与窗口
   * 计数在旧值上追加。基线失效兜底（自动回落全量重扫，一次性成本）：
   *   · 文件缩小（partial 行收束重写 / rewriteMessages 后 mtime 门未及
   *     拦截的外部改写）→ 字节偏移不再可信；
   *   · scannedAt 超 STATS_RECALIBRATE_MS → 时间窗随墙钟漂移，全量对齐。
   * 增量语义近似（可接受）：旧消息随时间出窗不回退（最多高估一轮内
   * 移出量，60s 校准兜底）；步级 partial 行收束替换可能带来 ±1 行抖动，
   * 同样被下一次全量校准吸收。
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
      const now = Date.now();
      // 行计数排除会话头行（M21 步骤 7 / F4：防消息数 +1 漂移）、部分行
      // （run 进行中的步级 checkpoint，非独立消息）与工具结果补行
      // （type 判别行，同头行机制）
      const countable = (l: string): boolean => !isHeaderLine(l) && !isToolResultLine(l) && !l.includes(PARTIAL_MARK);
      // 增量可行：有基线 && 文件只增 && 基线未超校准期（尾部撕裂行由
      // 基线回退一个换行吸收——增量段起点是「上一轮扫描结束的完整行尾」）
      const base = cached?.scannedBytes;
      if (cached && base !== undefined && stat.size > base && now - (cached.scannedAt ?? 0) < STATS_RECALIBRATE_MS) {
        const fd = fs.openSync(file, 'r');
        let messageCount = cached.messageCount;
        let windows = { ...cached.windows };
        try {
          // 基线对齐换行边界：正常 append 恒以 \n 收尾，基线即行尾；若
          // 上轮落在撕裂行中间（异常路径），从基线起找下一个换行对齐
          let start = base;
          const probe = Buffer.alloc(1);
          fs.readSync(fd, probe, 0, 1, start - 1);
          if (probe[0] !== 0x0a) {
            // 罕见：基线不在行边界——回退做全量（偏移不可信）
            return this.statsFullScan(file, stat, now);
          }
          const buf = Buffer.alloc(stat.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          const lines = buf.toString('utf-8').split('\n');
          // 末元素是末换行后的空串（文件以 \n 结尾）或撕裂半行（计当轮
          // 不计，下轮基线推进后由收束行补偿——与全量口径在收束后对齐）
          for (let i = 0; i < lines.length - 1; i++) {
            const l = lines[i]!;
            if (!l.trim() || !countable(l)) continue;
            messageCount++;
            const m = TIMESTAMP_RE.exec(l);
            if (m) {
              const t = Date.parse(m[1]);
              if (!Number.isNaN(t)) {
                const age = now - t;
                if (age < 3_600_000) windows.h1++;
                if (age < 86_400_000) windows.d1++;
                if (age < 3 * 86_400_000) windows.d3++;
                if (age < 7 * 86_400_000) windows.d7++;
                if (age < 30 * 86_400_000) windows.d30++;
              }
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        this.windowCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, windows, messageCount, scannedBytes: stat.size, scannedAt: now });
        return { messageCount, size: stat.size, updatedAt: stat.mtimeMs, windows };
      }
      return this.statsFullScan(file, stat, now);
    } catch {
      return undefined;
    }
  }

  /** stats 全量扫描路径：整读 + 一次 split 双消费（行计数 & 窗口计数） */
  private statsFullScan(file: string, stat: fs.Stats, now: number): { messageCount: number; size: number; updatedAt: number; windows: SessionWindowCounts } {
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    const countable = (l: string): boolean => !isHeaderLine(l) && !isToolResultLine(l) && !l.includes(PARTIAL_MARK);
    let messageCount = 0;
    for (const l of lines) {
      if (l.trim() && countable(l)) messageCount++;
    }
    const windows = countWindowMessages(lines, now);
    this.windowCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, windows, messageCount, scannedBytes: stat.size, scannedAt: now });
    return { messageCount, size: stat.size, updatedAt: stat.mtimeMs, windows };
  }

  /**
   * 在途判定：写队列是否有未落盘记录。message-received 入账即进队，
   * 首次 flush（tool/before-execute checkpoint 或收束行）前文件口径恒 0
   * ——「会话有无内容」类判据（空白清理/身份锁定）必须计入在途，否则
   * 首 run 进行中的会话被误判无消息（前端事故：在途空白会话被别处
   * 新建会话的 purgeEmpty 连消息流一起硬删，运行完也无记录）。只读
   * 面向（不 flush、不建队——与 stats/tail 同口径）。
   */
  hasPending(conversationId: string): boolean {
    const queue = this.queues.get(path.join(this.conversationDir(conversationId), 'messages.jsonl'));
    return queue !== undefined && queue.pending.length > 0;
  }

  /**
   * 尾部记录（Port B P4 名册摘要数据源）：读最后一条非空行并解析，
   * 只取展示所需字段；不存在/损坏返回 undefined。与 stats() 同为只读
   * 面向（不 flush 在途队列——实时侧由前端 bump 覆盖）。部分行（步级
   * checkpoint）跳过——名册预览不显示 run 进行中的中间步。
   *
   * 性能（2026-09-15 优化）：runs/snapshot 每 3s 对全部会话调用本方法，
   * 原先每轮 readFileSync 整读 messages.jsonl（百 MB 级数据根单轮秒级、
   * 同步阻塞事件循环——并发 HTTP 全部排队）。现两级加速：
   *   · tailCache（mtime/size 门）：文件未变直接返回缓存投影，零读；
   *   · 尾窗读取：变化时只读文件尾 TAIL_WINDOW_BYTES 找末条记录，
   *     不再整读；窗内找不到（病态文件/记录超窗）才全读兜底。
   */
  tail(conversationId: string): TailRecord | undefined {
    let stat: fs.Stats;
    const file = path.join(this.conversationDir(conversationId), 'messages.jsonl');
    try {
      stat = fs.statSync(file);
    } catch {
      return undefined;
    }
    // 缓存命中：mtime/size 未变 → 直接投影（文件不变即稳定）
    const cached = this.tailCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.tail === undefined ? undefined : { ...cached.tail };
    }
    // 未命中：增量优先读取（性能修复见 tailScanCache 注释）。
    // prev = 上次扫描基线：文件只增且基线可信时，末条新记录几乎总落在
    // 「基线前一小段 + 新增段」内——先小窗试探，miss 再大窗兜底。
    const prev = this.tailScanCache.get(file);
    const incrementalViable = prev !== undefined
      && stat.size > prev.size
      && stat.size - prev.size <= TAIL_SMALL_WINDOW_BYTES;
    let tail: TailRecord | undefined;
    try {
      if (stat.size === 0) {
        tail = undefined;
      } else {
        const fd = fs.openSync(file, 'r');
        try {
          // 小窗试探（增量可行时）：窗起点 = min(基线偏移, size - 小窗)——
          // 保证至少覆盖基线行尾（衔接）且不超过小窗预算
          const window = incrementalViable
            ? Math.min(stat.size - Math.max(prev!.scanEnd, stat.size - TAIL_SMALL_WINDOW_BYTES), TAIL_SMALL_WINDOW_BYTES)
            : Math.min(stat.size, TAIL_WINDOW_BYTES);
          const start = stat.size - window;
          const buf = Buffer.alloc(window);
          fs.readSync(fd, buf, 0, window, start);
          let text: string;
          if (start > 0) {
            // 窗起点在行中：首段是被撕裂的半行，跳到首个换行后再解析
            const nl = buf.indexOf('\n');
            text = nl >= 0 ? buf.toString('utf-8', nl + 1) : '';
          } else {
            text = buf.toString('utf-8');
          }
          tail = tailFromWindow(text) ?? this.tailFullRead(file);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      return undefined;
    }
    // 增量基线推进：本次扫描落点（成功解析到末条时 = 文件末；未解析到
    // （全部分行/部分行）= 文件末——下轮从末尾衔接）。文件缩小（重写/截断）
    // 时基线作废（scanEnd > size 不更新，下轮回落大窗路径）。
    if (stat.size >= (prev?.scanEnd ?? 0)) {
      this.tailScanCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, scanEnd: stat.size });
    }
    this.tailCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, tail });
    return tail === undefined ? undefined : { ...tail };
  }

  /** tail() 全读兜底：尾窗内找不到可解析记录（病态大记录/窗太小）时整读 */
  private tailFullRead(file: string): TailRecord | undefined {
    try {
      const text = fs.readFileSync(file, 'utf-8').trimEnd();
      if (!text) return undefined;
      return tailFromWindow(text);
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
    { name: 'replayTrajectory', type: 'boolean', default: true, description: '轨迹回放——开（缺省）= Agent 回看自己历史时保留当时的工具调用轨迹（思考与工具结果对），质量优先但历史轮边界缓存失效、token 略增；关 = 对话级回放只保留每轮最终回复，成本最优。仅影响 Agent 自己的视角，翻转后下一轮生效（Agent 差异层可覆盖）' },
    { name: 'eventReplay', type: 'string', default: 'full', description: '事件行回放模式——full（缺省）= 机制触发行全量原文回放；journal = 仅自会话桶（agent~agent）的旧机制行折叠为计数摘要（保留最近 eventJournalKeep 条原文），适合高频定时器驱动的 Agent（如 news 每 30 分钟一轮监控）——旧触发记录的信息量是一行计数，不必每轮按原价重放' },
    { name: 'eventJournalKeep', type: 'number', min: 0, step: 1, default: 6, description: 'journal 模式保留的最近机制行条数（缺省 6；仅 eventReplay=journal 时生效）' },
  ],
  listeners: [
    { event: 'tool/before-execute', role: 'fail-closed checkpoint', description: '工具执行前拦截（安全策略/审计/参数改写）——承重：关停破坏会话桶一致性' },
    { event: 'tool/after-execute', role: '工具结果补记', description: '结果到达即追加补行，records() 覆盖未收束 run 部分行的 result:null——中断 run 的恢复源 + 回放 KV 前缀保真' },
    { event: 'loop/run-started', role: 'run 簿记', description: 'runId 铸造 + 机制 run 标记（步级部分行门控）——承重：关停后部分行无法与收束行对账' },
    { event: 'loop/after-step', role: '步级部分行', description: '带工具调用的步完成即先落 checkpoint 行（思维链/工具卡在 ask_questions 等待期刷新不丢；收束行吸收）' },
  ],
};


export function apply(ctx: Context, options: SessionRowOptions = {}) {
  ctx.plugin(SessionService, options);
}
