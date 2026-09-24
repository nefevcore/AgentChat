// ============================================================
// ac-client-ui-conversation/client/chatOps.ts —— 聊天面共享操作件
//（M27.2-2 随 conversation 件迁入；原 webui api/chat-ops 门面已退役〔M28 §4.2〕
// 旧路径——chatPresence 单例跨消费面共享）
//
// 持久件：
//   · chatPresence：singles/groups 存在集合（帧路由判别）+ 上传指纹
//     →路径（附件行合成）——api/singles·groups/files 与 feed 事件共写
//   · routeDialog / isUserConversation：preview 帧载荷 → feed 分区
//     （1v1=direct:agentId、single=sid、群成员 run=群分区过滤）
//   · ToolStreams：llm/delta 工具调用参数按 index 累积（delta-end 解析
//     → tool_execution.start 语义）
//   · history 游标：src 轮次 offset → preview 消息 offset
//   · stringifyToolResult/errText：工具终值字符串化
// ============================================================

import type { DialogId } from './feed.ts';
import { directDialog, singleDialog, groupDialog, pairDialog } from './feed.ts';
import type { ChatMessage } from './types.ts';

// ---- 存在集合（原 adapterState 的收编新家） ----

interface ChatPresence {
  knownSingles: Set<string>;
  knownGroups: Set<string>;
  /** 上传指纹 → workspace 路径（chat.send 附件行合成；api/files 上传时登记） */
  uploadPaths: Map<string, string>;
}

export const chatPresence: ChatPresence = {
  knownSingles: new Set(),
  knownGroups: new Set(),
  uploadPaths: new Map(),
};

// ---- 帧载荷路由（feed 三关的 preview 词汇版） ----

interface FrameKeys {
  /** feed 分区键语义：pair:<a>|<b> / single:<sid> / group:<gid>（群被 isUserConversation 过滤） */
  dialogId: DialogId;
  agentId?: string;
  /** 发送方端点 id（M19：身份而非拓扑词） */
  sender: string;
  /**
   * 信封拓扑词（source：'user'|'agent'|'event'；缺省 '' = 未知——工具级
   * 事件无信封载荷）。'event' = 机制唤醒 run（late-reply 回投 / timer 定点
   * 等）落在用户可见会话——后端 ws-bridge 已按同口径放行广播，前端
   * isForCurrentUser 据此放行（本会话内容，非串台）。
   */
  source: string;
}

/**
 * preview 帧载荷（agentId/conversationId/sender）→ 分区路由。
 * M19 全对键统一：对桶 'a~b' → pair:a|b（含 viewer = 直答可写会话，
 * 不含 = 矩阵只读视角）；single=sid；群成员 run conversationId=gid
 * （feed 群分区由 group/message-posted 驱动，过程流经 isUserConversation
 * 过滤防串台）。conversationId 缺省回退 agent（无会话键的直连 run）→
 * viewer 直答对桶。
 */
export function routeDialog(agent: string | undefined, conversationId: string | undefined, sender?: string, source?: string): FrameKeys | null {
  const conv = conversationId || agent;
  if (!conv) return null;
  const senderKey = typeof sender === 'string' && sender ? sender : '';
  const sourceKey = typeof source === 'string' && source ? source : '';
  if (chatPresence.knownSingles.has(conv)) {
    return { dialogId: singleDialog(conv), ...(agent ? { agentId: agent } : {}), sender: senderKey, source: sourceKey };
  }
  if (chatPresence.knownGroups.has(conv)) {
    if (!agent) return null;
    return { dialogId: groupDialog(conv), agentId: agent, sender: senderKey, source: sourceKey };
  }
  // 对桶（M19）：'a~b'（含 a~a 自会话与 user~agent 直答）→ pair 分区
  if (conv.includes('~')) {
    const parts = conv.split('~');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { dialogId: pairDialog(parts[0], parts[1]), ...(agent ? { agentId: agent } : {}), sender: senderKey, source: sourceKey };
    }
    return null;
  }
  // 无会话键（loop 直连 run 等）：viewer 直答对桶
  if (!agent) return null;
  return { dialogId: directDialog(agent), agentId: agent, sender: senderKey, source: sourceKey };
}

/** 群桶过程流过滤（feed.isUserDialog 的 preview 版）：群会话键 → 不进 1v1 流 */
export function isUserConversation(agent: string | undefined, conversationId: string | undefined): boolean {
  const conv = conversationId || agent;
  if (!conv) return true;
  return !chatPresence.knownGroups.has(conv);
}

// ---- 工具调用参数累积（llm/delta toolCalls 分片 → 完整调用） ----

interface ToolCallAcc {
  id: string;
  name: string;
  buf: string;
}

export interface StreamState {
  sawReasoning: boolean;
  reasoningClosed: boolean;
  /** 思考相位起点（首个 reasoning 片到达时刻；收束时定格耗时 label 用） */
  reasoningStartAt?: number;
  /**
   * 已见工具调用分片（步内相位序自判——textBeforeTools 的直播源）：
   * 首个正文 delta 到达时若为 false → 标记 textBeforeTools=true（正文
   * 先行）；首个工具分片到达时若正文已出现 → 不标（工具先行，缺省序）。
   */
  sawToolCall?: boolean;
  /** 已见正文 delta（相位判定只在首见时刻做一次） */
  sawText?: boolean;
  /** index → 累积（id/name 首见建条目；argumentsDelta 拼接） */
  tools: Map<number, ToolCallAcc>;
  /**
   * 参数流式阶段已建 preparing 占位的 index 集合（2026-12 反馈：模型生成
   * 工具参数的数秒里前端完全静默——首个分片到达即建占位卡填补）。delta-end
   * 时显式清空（StreamState 寿命已延至 run 收束——见 feed-core delta-end）；重复分片/冲洗片靠它去重，防止同调用两张卡。
   */
  preps: Set<number>;
  /**
   * 步身份键 → 该步的流式载体消息（2026-12 身份贯通）：step-started /
   * 首 delta 到达时登记，本步 delta 帧经 meta.stepId O(1) 直达——取代
   * lastStreaming 位置扫描。旧后端帧无 stepId 时索引空置，回落启发式。
   */
  carrier: Map<string, ChatMessage>;
  /** 相位标志所属步的 stepId（onStepStart 换步即重置——见 feed-core） */
  phaseStepId?: string;
}

export function streamOf(streams: Map<string, StreamState>, dialogId: string): StreamState {
  let st = streams.get(dialogId);
  if (!st) {
    st = { sawReasoning: false, reasoningClosed: false, sawToolCall: false, sawText: false, tools: new Map(), preps: new Set(), carrier: new Map() };
    streams.set(dialogId, st);
  }
  return st;
}

/**
 * 参数流式粗提取（2026-09-21 前端反馈 #1）：从半截 arguments JSON 文本里
 * 尽力截取指定字符串字段的已生成部分。模型写 run_code 的 code 参数可达
 * 数 KB，参数阶段全程（数十秒）卡片只有裸 spinner——粗提取让代码面板
 * 边生成边可见。JSON 未闭合，靠「"field"\s*:\s*"」锚点 + 反向扫描未转义
 * 引号截断；失败（字段未开始/形态意外）返回 undefined 不抛。
 * 转义还原：常见 \n \\ \" \t 还原为字面字符（渲染层显示近似终态）。
 */
export function extractPartialJsonString(buf: string, field: string): string | undefined {
  const key = `"${field}"`;
  const keyAt = buf.indexOf(key);
  if (keyAt < 0) return undefined;
  let i = buf.indexOf('"', keyAt + key.length);
  // 跳过键与冒号后的空白，找到开引号
  while (i >= 0) {
    const between = buf.slice(keyAt + key.length, i);
    if (/^\s*:\s*$/.test(between)) break;
    i = buf.indexOf('"', i + 1);
  }
  if (i < 0) return undefined;
  i += 1; // 进字符串体
  let out = '';
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === '\\') {
      const next = buf[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '"') out += '"';
      else if (next === '\\') out += '\\';
      else if (next === undefined) return out; // 尾部孤立反斜杠
      else out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (ch === '"') return out; // 闭合引号（字段完整）
    out += ch;
    i += 1;
  }
  return out; // 未闭合 = 已生成部分
}

/** delta-end 解析参数（JSON 失败降级空对象——卡片少显示参数不崩） */
export function parseArgs(buf: string): Record<string, unknown> {
  try {
    return buf ? (JSON.parse(buf) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- 历史分页游标：src 轮次 offset → preview 消息 offset ----
// src history.request offset 单位=轮次（viewer 消息锚定，页大小 5）；
// preview session/history offset=跳过最新 N 条消息。游标按已服务条数
// 推进；hasMore 终止由前端按页内 viewer 消息数判定（我们控制返回页）。

const PAGE_MSG_LIMIT = 50;
const historyCursor = new Map<string, number>();

export function historyPage(session: string | undefined, to: string, offset: number): { conversationId: string; limit: number; offset: number } {
  const key = session ?? to;
  if (offset === 0) historyCursor.set(key, 0);
  return { conversationId: key, limit: PAGE_MSG_LIMIT, offset: historyCursor.get(key) ?? 0 };
}

export function historyServed(session: string | undefined, to: string, count: number): void {
  const key = session ?? to;
  historyCursor.set(key, (historyCursor.get(key) ?? 0) + count);
}

// ---- 工具定义形状（preview ToolDef 扁平 → src OpenAI 形；Token 弹层按 provider 载荷 JSON 估算工具定义开销） ----

export function toToolDefs(defs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): Array<Record<string, unknown>> {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters ?? { type: 'object', properties: {} } },
  }));
}

// ---- 工具终值字符串化（tool/after-execute result.output unknown → 字符串） ----

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function stringifyToolResult(result: { ok: boolean; output?: unknown; error?: string } | undefined, error?: unknown): string {
  // 失败两路都产出 {ok:false, error} 信封 JSON——parseToolResult 归一为
  // status:'error'（此前产出 "Error: …" 纯文本：专用卡片（read/write/edit
  // 等）解析恒 null → 失败原因在流式与历史中均不可见，仅未知工具的
  // <pre> 兜底可见）。成功仍为裸 output（parseToolResult 两形都认）。
  if (error !== undefined && error !== null) return JSON.stringify({ ok: false, error: errText(error) });
  if (!result) return '';
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      error: result.error ?? '工具执行失败',
      ...(result.output !== undefined ? { output: result.output } : {}),
    });
  }
  const out = result.output;
  if (typeof out === 'string') return out;
  if (out === undefined || out === null) return '';
  try {
    return typeof out === 'object' ? JSON.stringify(out, null, 2) : String(out);
  } catch {
    return String(out);
  }
}

// ---- ask_questions 交互载荷归一（live 帧 / interaction/list 恢复记录两形） ----

/** ask_questions 单题（question + 选项；multi: true = 多选，答案为数组） */
export interface AskQuestionsItem {
  question: string;
  options: string[];
  multi?: boolean;
}

/** ask_questions 弹窗状态（stores/chat pendingInteractions 的载荷形状） */
export interface AskQuestionsUiState {
  interaction_id: string;
  agent_id: string;
  /** 会话归属键（record.key = conversationId；多 Agent 并发提问时前端按它
   *  路由到各自会话——旧载荷缺省 undefined 回落 agent 匹配） */
  key?: string;
  /** 创建时刻（record.createdAt；多条 pending 并存时排序用） */
  created_at: number;
  /** 全部问题（工具支持最多 5 题——单题即选即发，多题逐题作答后一次提交） */
  questions: AskQuestionsItem[];
  allow_custom: boolean;
  timeout_ms: number;
}

/**
 * 选项文本归一（2026-09-15 反馈修复：模型可发 {label, description} 对象
 * 形态选项——后端 ac-durable-interaction 已归一，此处为恢复路径历史
 * 污染数据的同款防御）。规则与后端 optionText 一致；2026-09-17 补：
 * 未知键单键对象（映射形 {"选项全文": "alias"}）取键——与后端归一同步。
 */
function optionTextOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : typeof o.text === 'string' ? o.text.trim() : '';
    const desc = typeof o.description === 'string' ? o.description.trim() : typeof o.desc === 'string' ? o.desc.trim() : '';
    if (label && desc) return `${label} —— ${desc}`;
    if (label || desc) return label || desc;
    // 映射形兜底：无 label/text/description 键的对象，取首个键为选项文本
    const firstKey = Object.keys(o)[0];
    return firstKey !== undefined ? firstKey.trim() : '';
  }
  return '';
}

function normalizeOptionList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(optionTextOf).filter((s) => s.length > 0);
}

/**
 * ask_questions 载荷 → 弹窗状态（两形归一）：
 *  · live 帧（durable-interaction/opened）：ws-bridge 已整形——questions 上提为顶层；
 *  · 恢复记录（interaction/list）：原始 store 记录——questions 在 payload 内。
 * 保留全部有效问题（每题 question + options 原样；2026-09-02 反馈 #2：
 * 此前只取第一题，Agent 问多题时其余问题用户无从作答）。
 * timeout_ms：有 deadline 用剩余毫秒（下限 0）；无 deadline = 0（永不自动关
 * ——后端工具在永久等待，前端先关会让用户失去作答入口）。非 ask_questions
 * 载荷 / 无有效问题 → null。
 */
export function pickAskQuestions(r: Record<string, unknown> | null | undefined, now = Date.now()): AskQuestionsUiState | null {
  if (!r || r.kind !== 'ask_questions') return null;
  const raw = Array.isArray(r.questions)
    ? r.questions
    : r.payload && typeof r.payload === 'object' && Array.isArray((r.payload as { questions?: unknown[] }).questions)
      ? (r.payload as { questions: unknown[] }).questions
      : undefined;
  const questions: AskQuestionsItem[] = [];
  for (const q of (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown> | null | undefined>) {
    if (!q) continue;
    const question = optionTextOf(q.question);
    if (!question) continue;
    questions.push({
      question,
      options: normalizeOptionList(q.options),
      // multi 仅显式 true 透传（旧载荷缺省单选）
      ...(q.multi === true ? { multi: true } : {}),
    });
  }
  if (questions.length === 0) return null;
  return {
    interaction_id: String(r.id ?? ''),
    agent_id: String(r.owner ?? ''),
    ...(typeof r.key === 'string' && r.key ? { key: r.key } : {}),
    created_at: typeof r.createdAt === 'number' ? r.createdAt : 0,
    questions,
    allow_custom: true,
    timeout_ms: typeof r.deadline === 'number' ? Math.max(0, r.deadline - now) : 0,
  };
}

// ---- approval 提权审批载荷归一（access-tier §六；两形同 ask_questions） ----

/** 提权审批卡状态（pendingApprovals 的载荷形状） */
export interface ApprovalUiState {
  interaction_id: string;
  agent_id: string;
  /** 会话归属键（record.key = conversationId；多 Agent 并发审批时按它路由） */
  key?: string;
  created_at: number;
  /** 申请执行的工具名 */
  tool: string;
  /** 参数摘要（bash 全文 / 写路径全文 / 其余 JSON 截断——审批卡全文展示） */
  args: unknown;
  /** 档位说明（need 提示——为什么需要、批准意味着什么） */
  need: string;
  timeout_ms: number;
}

/**
 * approval 载荷 → 审批卡状态（live 帧 / interaction/list 恢复记录两形归一，
 * 同 pickAskQuestions 模式）：payload 内取 {tool, args, need}；缺 tool →
 * null（不渲染）。timeout_ms 语义同 ask_questions（0 = 永不自动关）。
 */
export function pickApproval(r: Record<string, unknown> | null | undefined, now = Date.now()): ApprovalUiState | null {
  if (!r || r.kind !== 'approval') return null;
  const payload =
    r.payload && typeof r.payload === 'object'
      ? (r.payload as { tool?: unknown; args?: unknown; need?: unknown })
      : {};
  const tool = typeof payload.tool === 'string' && payload.tool ? payload.tool : '';
  if (!tool) return null;
  return {
    interaction_id: String(r.id ?? ''),
    agent_id: String(r.owner ?? ''),
    ...(typeof r.key === 'string' && r.key ? { key: r.key } : {}),
    created_at: typeof r.createdAt === 'number' ? r.createdAt : 0,
    tool,
    args: payload.args ?? null,
    need: typeof payload.need === 'string' ? payload.need : '',
    timeout_ms: typeof r.deadline === 'number' ? Math.max(0, r.deadline - now) : 0,
  };
}
