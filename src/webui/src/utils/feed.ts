// ============================================================
// utils/feed.ts —— 统一信息流纯函数层
//
// 单一真相源原则：
//   rawMessages（append-only 事件流） → buildTurns() 纯函数 → Turn[]
//   视图只消费派生结果，不直接维护第二份展示数据。
//
// 设计文档：docs/feed-architecture.md
// ============================================================

import type { ChatMessage, Turn, TurnStep } from '../types';
import { VIEWER_ID } from '../constants';

// ── Dialog 标识 ──

/**
 * DialogKind（M19/D4：direct 分区废除——viewer 直答也是对桶）：
 *   pair   = 对桶（含 viewer ⇒ 直答可写会话；不含 ⇒ 矩阵只读视角）
 *   group  = 群聊
 *   single = 独立会话（P3：同一 Agent 的多个隔离上下文）
 */
export type DialogKind = 'pair' | 'group' | 'single';

/**
 * 对话 ID（前端统一信息流的路由键，M19/D4 全对键统一）：
 *   pair:${a}|${b}（对桶：两端点排序后 | 连接——含 viewer 的即原直答
 *                会话，可写；不含 viewer 为 Agent 对只读视角）
 *   group:${groupId}（群聊）
 *   single:${sessionId}（独立会话）
 */
export type DialogId = `pair:${string}` | `group:${string}` | `single:${string}`;

/** 后端对桶键的镜像（pairKey(a,b)：排序 `~` 连接；与 conversationId 同词表） */
export function bucketKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

/** 构造 pair 对话 ID（两端点排序去序，保证同对会话共享分区缓存） */
export function pairDialog(a: string, b: string): DialogId {
  return `pair:${[a, b].sort().join('|')}`;
}

/**
 * 直答会话 ID（viewer⇄agent 对桶）：M19/D4 废除 direct: 分区——统一
 * pair: 键，本函数是"点开 Agent 即对话"的 viewer 相对糖（对端 = agent）。
 */
export function directDialog(agentId: string): DialogId {
  return pairDialog(VIEWER_ID.value, agentId);
}

/**
 * pair 分区键（'a|b'）→ 对端解析：含 viewer 取另一端（直答对端）；
 * 不含 viewer（Agent 对视角）取首端（真实身份由流式帧的 streamAgent 覆盖）。
 */
export function pairPartnerOf(key: string): string {
  const parts = key.split('|');
  if (parts.length !== 2) return key;
  const viewer = VIEWER_ID.value;
  if (parts[0] === viewer) return parts[1];
  if (parts[1] === viewer) return parts[0];
  return parts[0];
}

/** pair 分区是否含 viewer（可写直答会话判定；不含 = 矩阵只读视角） */
export function pairHasViewer(key: string): boolean {
  return key.split('|').includes(VIEWER_ID.value);
}

/** 构造 group 对话 ID */
export function groupDialog(groupId: string): DialogId {
  return `group:${groupId}`;
}

/** 构造 single 对话 ID（独立会话） */
export function singleDialog(sessionId: string): DialogId {
  return `single:${sessionId}`;
}

/** 解析 DialogId → { kind, key } */
export function parseDialogId(id: DialogId): { kind: DialogKind; key: string } {
  const sep = id.indexOf(':');
  const kind = id.slice(0, sep) as DialogKind;
  const key = id.slice(sep + 1);
  return { kind, key };
}

// ── 历史分页合并（原 chat.ts 迁移，保持纯函数）──

/**
 * 历史分页合并：新返回的较早消息在前 + 已有较晚消息在后，按 message_id 去重防重复。
 * 返回 [合并去重后的消息, 该页 user 链数]（userCount 用于按轮次校准分页 offset）。
 * viewerId：用户侧身份（调用方传 VIEWER_ID，此前硬编码 'user'——若未来
 * VIEWER_ID 可配置，分页 offset 校准会错算）。
 */
export function mergeHistoryPage(
  incoming: ChatMessage[],
  existing: ChatMessage[],
  isFirstPage: boolean,
  viewerId = 'user',
): { merged: ChatMessage[]; userCount: number } {
  const raw = isFirstPage ? incoming : [...incoming, ...existing];
  const seen = new Set<string>();
  const merged = raw.filter((m) => {
    if (m.persistedMsgId && seen.has(m.persistedMsgId)) return false;
    if (m.persistedMsgId) seen.add(m.persistedMsgId);
    return true;
  });
  const userCount = incoming.filter((m) => m.agent_id === viewerId).length;
  return { merged, userCount };
}

// ── Turn 构建（rawMessages → Turn[]）──

/** 流式内部消息形态（thinking + tool_calls + content） */
interface FeedAgentMsg {
  thinking: string;
  tool_calls: any[];
  content: string;
  ts: number;
  label?: string;
  /** 流式中（用于派生 turns 保留 isStreaming，驱动思维链自动展开） */
  isStreaming?: boolean;
  /** 原始消息 id：final 沿用之（此前合成 `final-<ts>` → edit/regenerate/delete
   *  按 id 查找 rawMessages 永远 -1，操作按钮静默失效） */
  id?: string;
  /** 用户附件（final 渲染附件 chips 用；派生时丢失会导致附件不显示） */
  files?: any[];
  agent_id?: string;
}

/** 同 sender 连续消息的时间合并阈值：间隔超过该值视为不同会话轮次（如定时广播），不合并 */
const MERGE_GAP_MS = 10 * 60 * 1000;

/**
 * 将 AgentMsg 数组转换为 TurnStep[] + final ChatMessage（原 _agentMsgsToSteps）。
 * 纯函数：输入不可变，输出全新对象。
 */
function buildTurnFromAgentMsgs(msgs: FeedAgentMsg[], streaming: boolean, agentId: string): Turn {
  const steps: TurnStep[] = msgs.map((t, i) => {
    const ts = t.ts || Date.now();
    const stepStreaming = streaming || (i === msgs.length - 1 && !!t.isStreaming);
    const asst: ChatMessage = {
      id: `step-${ts}-${i}`, role: 'agent', content: t.content || '',
      label: t.label || '', thinking: t.thinking, reasoning_content: t.thinking,
      toolCalls: (t.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) as any,
      isStreaming: stepStreaming && i === msgs.length - 1, timestamp: ts,
    };
    const tools: ChatMessage[] = (t.tool_calls || []).map((tc: any) => ({
      id: `tool-${tc.id}`, role: 'tool', content: tc.result || '',
      name: tc.name, toolName: tc.name, tool_call_id: tc.id, label: tc.label || tc.name || '',
      // 携带工具参数：让 ToolMessage 在"结果返回前"即可按参数渲染专用卡片
      // （如 bash 显示命令、edit/read 显示文件路径），无需等结果 JSON。
      arguments: tc.arguments,
      isStreaming: stepStreaming ? (tc.running || !tc.result) : !tc.result,
      status: stepStreaming && (tc.running || !tc.result) ? 'running' : undefined, timestamp: ts,
    } as ChatMessage));
    return { assistant: asst, tools, isStreaming: stepStreaming && i === msgs.length - 1 };
  });
  const last = msgs[msgs.length - 1];
  const final: ChatMessage = {
    // 沿用原始消息 id（缺省才合成）：edit/regenerate/delete 按 id 定位 raw 消息，
    // 合成 id 永远查不到 → 操作按钮静默失效
    id: last.id || `final-${last.ts || Date.now()}`, role: 'agent',
    content: last.content || '',
    reasoning_content: '', thinking: '',
    files: last.files, agent_id: last.agent_id,
    // 流式标记继承：final 走 useChunkedMarkdown 的 committed/pending 分块路径
    // （此前恒 false → 每个 rAF 帧对全文全量跑 markdown-it，长回复 O(n²) 卡顿）
    isStreaming: !!last.isStreaming,
    timestamp: last.ts || Date.now(),
  } as ChatMessage;
  return { agent_id: agentId, steps, final };
}

/**
 * 由原始消息流构建 Turn[]（原 _buildAgentTurnsForHistory）。
 * - event 消息（定时/归档/继续/重启等系统事件）→ 独立 system turn（渲染为分隔符）
 * - agent/user 消息按 sender 分组为 turn 链；同 sender 但间隔过长 → 拆分为独立轮次
 * - tool 消息匹配 tool_call_id 补 result/label
 */
export function buildTurns(msgs: ChatMessage[]): Turn[] {
  const allTurns: Turn[] = [];
  let cur: { agent_id: string; turns: FeedAgentMsg[] } | null = null;

  const flush = () => {
    if (cur?.turns.length) {
      allTurns.push(buildTurnFromAgentMsgs([...cur.turns], false, cur.agent_id));
      cur = null;
    }
  };

  for (const msg of msgs) {
    // event 系统事件消息：渲染为独立系统分隔符，不进普通 turn 链。
    // 兼容历史 API 归一化后的旧 trigger：user + source.legacyRole==='trigger'。
    const isEventMsg = msg.role === 'event'
      || (msg.role === 'user' && (msg.source as any)?.legacyRole === 'trigger');
    if (isEventMsg) {
      flush();
      const ts = msg.timestamp || Date.now();
      allTurns.push({
        agent_id: 'system',
        steps: [],
        // 时间线分隔符展示完整事件正文（可多行换行）；source.summary 仅用于列表/活动摘要
        final: { id: `event-${ts}-${allTurns.length}`, role: 'event', content: msg.content || msg.source?.summary || '', timestamp: ts, agent_id: 'system', source: msg.source },
      });
      continue;
    }
    // error 消息（如 LLM 调用失败）：独立系统 turn，渲染为红色错误分隔符（同 event 分隔）
    if (msg.role === 'error') {
      flush();
      const ts = msg.timestamp || Date.now();
      allTurns.push({
        agent_id: 'system',
        steps: [],
        final: { id: `error-${ts}-${allTurns.length}`, role: 'error', content: msg.content || '', timestamp: ts, agent_id: 'system' },
      });
      continue;
    }
    if (msg.role === 'agent' || msg.role === 'user') {
      // 跳过完全空白的流式占位（thinking/content/toolCalls 皆空），避免产生空气泡
      const empty = !msg.content && !msg.thinking && !msg.reasoning_content && !(msg.toolCalls?.length);
      if (empty) continue;
      const senderId = msg.agent_id || '';
      const ts = msg.timestamp || Date.now();
      const lastTurn = cur?.turns[cur.turns.length - 1];
      const gapTooLong = !!cur && !!lastTurn && (ts - lastTurn.ts) > MERGE_GAP_MS;
      // 无思考无工具的纯正文消息（如 send_agent 投递）：若当前轮已有完整正文，
      // 单独成轮 —— 否则它会把上一条正经回复吞进思维链折叠栏（正文被折叠）。
      const isPlainBody = !!msg.content && !msg.thinking && !msg.reasoning_content && !(msg.toolCalls?.length);
      const prevComplete = !!lastTurn && !!lastTurn.content && !(lastTurn.tool_calls?.length);
      const plainAfterComplete = isPlainBody && prevComplete;
      if (!cur || cur.agent_id !== senderId || gapTooLong || plainAfterComplete) {
        flush();
        cur = { agent_id: senderId, turns: [] };
      }
      cur.turns.push({
        thinking: msg.reasoning_content || msg.thinking || '',
        label: (msg as any).label || '',
        tool_calls: (msg.toolCalls || []).map((tc: any) => ({
          id: tc.id, name: tc.name || tc.function?.name || '',
          arguments: tc.arguments || tc.function?.arguments || '',
          result: '', label: tc.label || tc.name || '',
        })),
        content: msg.content || '',
        ts,
        isStreaming: msg.isStreaming,
        // 透传原始 id/附件/身份：final 沿用（edit/regenerate/delete 按 id 命中、附件渲染）
        id: msg.id,
        files: msg.files,
        agent_id: msg.agent_id,
      });
    }
    if (msg.role === 'tool' && cur?.turns.length) {
      const last = cur.turns[cur.turns.length - 1];
      const tc = last.tool_calls.find((t: any) => t.id === msg.tool_call_id);
      if (tc) { tc.result = msg.content || ''; tc.label = msg.label || msg.name || tc.name; }
    }
  }
  flush();
  return allTurns;
}

// ── 增量 Turn 构建（流式性能核心）──

/** 单条消息的稳定签名（内容级变化 → 签名变化；仅 O(1) 长度计算，不做全量哈希）。
 *  注意 toolCalls 必须覆盖每个调用的 result/running/label——onToolEnd/onToolUpdate
 *  会原地改写这些字段，签名漏掉会让 buildTurnsIncremental 误判"无变化"复用
 *  过期 turns（工具卡永久转圈、结果不刷新）。 */
function toolCallsSig(tcs: any[] | undefined | null): string {
  if (!tcs?.length) return '0';
  let s = `${tcs.length}`;
  for (const tc of tcs) {
    s += `|${tc?.id ?? ''}:${(tc?.result?.length ?? 0)}:${tc?.running ? 1 : 0}:${(tc?.label?.length ?? 0)}`;
  }
  return s;
}
function msgSig(m: ChatMessage): string {
  return `${m.id}|${m.role}|${m.content?.length ?? 0}|${m.thinking?.length ?? 0}|${m.reasoning_content?.length ?? 0}|${toolCallsSig(m.toolCalls)}|${m.label?.length ?? 0}|${m.isStreaming ? 1 : 0}`;
}

/** 增量 Turn 构建的缓存状态 */
export interface TurnsMemo {
  /** 已构建的 Turn 列表（完成轮次保持对象身份，可安全复用） */
  turns: Turn[];
  /** 与 msgs 一一对应的消息签名（用于判断"哪些消息变化了"） */
  sigs: string[];
}

/**
 * 增量 Turn 构建。
 *
 * 流式更新只改写最后一条消息（content/thinking/toolCalls/label/isStreaming 原地追加），
 * 前缀消息与 turn 分组均不变 → 复用先前 turn 的对象身份，仅重建最后一个 turn。
 * Vue 中其余 TurnDisplayItem 因 props 身份不变而完全跳过重渲染，
 * 消除"每个 token 全列表刷新"的卡顿（即"逐帧刷新全部消息"的根源）。
 *
 * 判定规则（O(n) 指针/签名比较，常数极小，远低于 markdown/DOM 开销）：
 * - 签名完全相同 → 零重建，整体复用；
 * - 仅最后一条消息签名变化 → 前缀 turn 复用身份，只重建最后一个 turn；
 * - 其余任何变化（结构性增删 / 多条消息变化 / 前缀消息被替换）→ 全量重建。
 *   注意：结构性变更（removeMessage/replaceMessage/setRaw/mergeHistory 等）会
 *   由 feed store 显式失效 memo，这里仍是纯函数兜底。
 *
 * 纯函数：输入 prev 状态 + 消息数组，输出新状态（含可复用的 turns）。
 */
export function buildTurnsIncremental(prev: TurnsMemo | null, msgs: ChatMessage[]): TurnsMemo {
  const sigs = msgs.map(msgSig);
  if (prev && prev.sigs.length === sigs.length) {
    let same = true;
    let onlyLast = true;
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i] !== prev.sigs[i]) {
        same = false;
        if (i < sigs.length - 1) onlyLast = false;
      }
    }
    if (same) return prev; // 无实际变化 → 完全复用
    const full = buildTurns(msgs);
    // 仅最后一条消息变化且分组结构稳定 → 复用前缀 turn，只替换最后一个
    if (onlyLast && full.length > 0 && full.length === prev.turns.length) {
      return {
        turns: [...prev.turns.slice(0, full.length - 1), full[full.length - 1]],
        sigs,
      };
    }
    // 分组结构变化（罕见）→ 全量
    return { turns: full, sigs };
  }
  return { turns: buildTurns(msgs), sigs };
}

/** 从消息中查找最后一条流式消息（可选 role 过滤） */
export function lastStreaming(msgs: ChatMessage[], role?: 'agent' | 'tool'): ChatMessage | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isStreaming && (!role || m.role === role)) return m;
  }
  return null;
}

/** 关闭所有流式标记 */
export function closeAllStreaming(msgs: ChatMessage[]): void {
  for (const m of msgs) { if (m.isStreaming) m.isStreaming = false; }
}

/** 群组持久化消息 → ChatMessage（REST 群组历史加载用）。
 *  D11：tool_calls / tool_call_id / reasoning_content 透传（群成员工具
 *  卡片与思维链——与 pairMessageToChatMessage 同款词汇） */
export function groupMessageToChatMessage(m: {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
}): ChatMessage {
  const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    role: (m.role === 'tool' ? 'tool' : 'agent') as ChatMessage['role'],
    content: m.content ?? '',
    agent_id: m.agent_id,
    name: m.name,
    label: m.label,
    timestamp: new Date(m.timestamp).getTime(),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
  };
}

/**
 * 会话对（pair）持久化消息 → ChatMessage（REST /api/history 加载用）。
 * 与群组转换的差异：event/system/error 角色保留（buildTurns 渲染为分隔符，
 * 系统注入/触发事件在时间线上可见）；tool_calls / reasoning 透传（完整思维链）。
 */
export function pairMessageToChatMessage(m: {
  role: string;
  content: string | null;
  agent_id?: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string | null;
  label?: string;
  message_id?: string;
  timestamp?: string;
}, fallbackAgentId: string): ChatMessage {
  const id = `pair-${m.message_id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`;
  const role = (m.role === 'tool' ? 'tool'
    : m.role === 'event' || m.role === 'system' ? 'event'
      : m.role === 'error' ? 'error'
        : 'agent') as ChatMessage['role'];
  return {
    id,
    role,
    content: m.content ?? '',
    agent_id: m.agent_id ?? fallbackAgentId,
    name: m.name,
    label: m.label,
    reasoning_content: (m.reasoning_content ?? '') || undefined,
    tool_call_id: m.tool_call_id,
    toolCalls: m.tool_calls as any,
    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
  } as ChatMessage;
}
