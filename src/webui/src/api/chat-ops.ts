// ============================================================
// api/chat-ops.ts —— 聊天面 Port B 共享操作件（阶段二第六梯）
//
// 由适配器（core/dialog/state/shapes）迁入并 Port B 化的持久件：
//   · chatPresence：singles/groups 存在集合（帧路由判别）+ 上传指纹
//     →路径（附件行合成）——api/singles·groups/files 与 feed 事件共写
//   · routeDialog / isUserConversation：preview 帧载荷 → feed 分区
//     （1v1=direct:agentId、single=sid、群成员 run=群分区过滤）
//   · ToolStreams：llm/delta 工具调用参数按 index 累积（delta-end 解析
//     → tool_execution.start 语义）
//   · history 游标：src 轮次 offset → preview 消息 offset
//   · stringifyToolResult/errText：工具终值字符串化
// ============================================================

import type { DialogId } from '../utils/feed';
import { directDialog, singleDialog, groupDialog, pairDialog } from '../utils/feed';

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
}

/**
 * preview 帧载荷（agentId/conversationId/sender）→ 分区路由。
 * M19 全对键统一：对桶 'a~b' → pair:a|b（含 viewer = 直答可写会话，
 * 不含 = 矩阵只读视角）；single=sid；群成员 run conversationId=gid
 * （feed 群分区由 group/message-posted 驱动，过程流经 isUserConversation
 * 过滤防串台）。conversationId 缺省回退 agent（无会话键的直连 run）→
 * viewer 直答对桶。
 */
export function routeDialog(agent: string | undefined, conversationId: string | undefined, sender?: string): FrameKeys | null {
  const conv = conversationId || agent;
  if (!conv) return null;
  const senderKey = typeof sender === 'string' && sender ? sender : '';
  if (chatPresence.knownSingles.has(conv)) {
    return { dialogId: singleDialog(conv), ...(agent ? { agentId: agent } : {}), sender: senderKey };
  }
  if (chatPresence.knownGroups.has(conv)) {
    if (!agent) return null;
    return { dialogId: groupDialog(conv), agentId: agent, sender: senderKey };
  }
  // 对桶（M19）：'a~b'（含 a~a 自会话与 user~agent 直答）→ pair 分区
  if (conv.includes('~')) {
    const parts = conv.split('~');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { dialogId: pairDialog(parts[0], parts[1]), ...(agent ? { agentId: agent } : {}), sender: senderKey };
    }
    return null;
  }
  // 无会话键（loop 直连 run 等）：viewer 直答对桶
  if (!agent) return null;
  return { dialogId: directDialog(agent), agentId: agent, sender: senderKey };
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
  /** index → 累积（id/name 首见建条目；argumentsDelta 拼接） */
  tools: Map<number, ToolCallAcc>;
}

export function streamOf(streams: Map<string, StreamState>, dialogId: string): StreamState {
  let st = streams.get(dialogId);
  if (!st) {
    st = { sawReasoning: false, reasoningClosed: false, tools: new Map() };
    streams.set(dialogId, st);
  }
  return st;
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

/** ask_questions 单题（question + 选项） */
export interface AskQuestionsItem {
  question: string;
  options: string[];
}

/** ask_questions 弹窗状态（stores/chat interactionState 的载荷形状） */
export interface AskQuestionsUiState {
  interaction_id: string;
  agent_id: string;
  /** 全部问题（工具支持最多 5 题——单题即选即发，多题逐题作答后一次提交） */
  questions: AskQuestionsItem[];
  allow_custom: boolean;
  timeout_ms: number;
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
    const question = String(q.question ?? '');
    if (!question) continue;
    questions.push({
      question,
      options: Array.isArray(q.options) ? q.options.map(String) : [],
    });
  }
  if (questions.length === 0) return null;
  return {
    interaction_id: String(r.id ?? ''),
    agent_id: String(r.owner ?? ''),
    questions,
    allow_custom: true,
    timeout_ms: typeof r.deadline === 'number' ? Math.max(0, r.deadline - now) : 0,
  };
}
