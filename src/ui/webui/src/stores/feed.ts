// ============================================================
// stores/feed.ts —— 统一信息流 Store（per-dialog 分区）
//
// 单一真相源：每个 dialog 的 rawMessages（append-only / 流式原地更新）
// 派生：turns 由 buildTurns 纯函数计算（memo 缓存，不落持久存储）
//
// 设计文档：docs/feed-architecture.md
// 本阶段：direct 对话接入统一池；群聊（group.message）留待下一步融合
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed, type ComputedRef } from 'vue';
import type { ChatMessage, Turn } from '../types';
import { useWebSocketStore } from './websocket';
import { useAgentStore } from './agents';
import { logger } from '../utils/logger';
import { VIEWER_ID } from '../constants';
import {
  type DialogId, type DialogKind, directDialog, groupDialog, parseDialogId,
  mergeHistoryPage, buildTurns, lastStreaming, closeAllStreaming, groupMessageToChatMessage,
} from '../utils/feed';

const HISTORY_PAGE_SIZE = 5;
const TURN_DONE_DELAY = 300;
const MAX_ACTIVITY = 500;

/** 全局活动条目（社区流 / 星图 / 会话列表排序的单一来源） */
export interface ActivityEntry {
  dialogId: DialogId;
  ts: number;
  kind: DialogKind;
  agentId: string;
  /** 消息/事件摘要（列表/社区流展示） */
  summary: string;
  /** 事件类型：message | tool | trigger | group */
  event: string;
}

/** 单个对话分区的完整状态 */
export interface DialogFeed {
  id: DialogId;
  kind: DialogKind;
  /** direct: 对方 agentId；group: null */
  partner: string | null;
  /** 唯一真相源（append-only；流式消息原地更新对象） */
  rawMessages: ChatMessage[];
  // 历史分页
  status: 'idle' | 'loading' | 'ready';
  hasMore: boolean;
  offset: number;
  // 元数据（供列表/社区流/星图）
  lastActivity: number;
  lastMessage: { role: string; content: string; agentId: string; ts: number } | null;
  unread: number;
  streaming: boolean;
}

function blankDialog(id: DialogId, kind: DialogKind, partner: string | null): DialogFeed {
  return {
    id, kind, partner,
    rawMessages: [],
    status: 'idle', hasMore: false, offset: 0,
    lastActivity: 0, lastMessage: null, unread: 0, streaming: false,
  };
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

export const useFeedStore = defineStore('feed', () => {
  // ── State ──
  const dialogs = ref<Record<DialogId, DialogFeed>>({});
  /** 版本号：rawMessages 变更时 bump，驱动派生 turns 重算 */
  const _version = ref<Record<DialogId, number>>({});
  const _turnsCache = new Map<DialogId, ComputedRef<Turn[]>>();
  const _historyOffset: Record<string, number> = {};

  // ── 全局活动索引（按 ts 倒序，cap MAX_ACTIVITY）──
  const _activity = ref<ActivityEntry[]>([]);
  function recordActivity(entry: Omit<ActivityEntry, 'ts' | 'kind'> & { kind?: DialogKind; ts?: number }) {
    const item: ActivityEntry = {
      ts: Date.now(),
      kind: parseDialogId(entry.dialogId).kind,
      ...entry,
    };
    const arr = _activity.value;
    const idx = arr.findIndex(a => a.ts < item.ts);
    if (idx === -1) arr.push(item);
    else arr.splice(idx, 0, item);
    if (arr.length > MAX_ACTIVITY) arr.length = MAX_ACTIVITY;
  }
  const activity = computed(() => _activity.value);

  /** 全局指示器（UI 兼容 chat store 的对应状态） */
  const turnInProgress = ref(false);
  const lastRunEndAt = ref(0);
  const archivePending = ref(false);

  let resumeSnapshot: any = null;
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 当前活跃对话（direct 由 agents store 派生；group 由 App 显式设置，优先）──
  const activeGroupId = ref('');
  const activeDialogId = computed<DialogId | null>(() => {
    if (activeGroupId.value) return groupDialog(activeGroupId.value);
    const a = useAgentStore().activeAgentId;
    return a ? directDialog(a) : null;
  });
  const activeDialog = computed<DialogFeed | null>(() =>
    activeDialogId.value ? dialogs.value[activeDialogId.value] ?? null : null
  );
  const activeAgentId = computed(() => useAgentStore().activeAgentId);

  /** 激活群聊对话（与 direct 互斥） */
  function setActiveGroup(groupId: string) {
    activeGroupId.value = groupId;
  }
  /** 取消群聊激活（回到 direct） */
  function clearActiveGroup() {
    activeGroupId.value = '';
  }

  // ── Dialog 基础工具 ──
  function ensureById(id: DialogId): DialogFeed {
    if (!dialogs.value[id]) {
      const { kind, key } = parseDialogId(id);
      dialogs.value = { ...dialogs.value, [id]: blankDialog(id, kind, kind === 'direct' ? key : null) };
    }
    return dialogs.value[id]!;
  }
  function bump(id: DialogId) {
    _version.value = { ..._version.value, [id]: (_version.value[id] ?? 0) + 1 };
  }
  function touch(id: DialogId, agentId: string, content: string, ts: number) {
    const d = dialogs.value[id];
    if (!d) return;
    if (ts > d.lastActivity) d.lastActivity = ts;
    d.lastMessage = { role: 'agent', content: content.slice(0, 80), agentId, ts };
  }

  // ── 派生 turns（memo：仅该 dialog 版本变化时重算）──
  function getTurns(id: DialogId): ComputedRef<Turn[]> {
    let c = _turnsCache.get(id);
    if (!c) {
      c = computed<Turn[]>(() => {
        void _version.value[id];
        const d = dialogs.value[id];
        return d ? buildTurns(d.rawMessages) : [];
      });
      _turnsCache.set(id, c);
    }
    return c;
  }
  function getRaw(id: DialogId): ChatMessage[] {
    return dialogs.value[id]?.rawMessages ?? [];
  }
  function getDialog(id: DialogId): DialogFeed | null {
    return dialogs.value[id] ?? null;
  }

  // ── 消息操作原语 ──
  function append(id: DialogId, msg: ChatMessage) {
    const d = ensureById(id);
    d.rawMessages.push(msg);
    touch(id, msg.agent_id || '', msg.content || '', msg.timestamp || Date.now());
    bump(id);
    return d;
  }
  function removeMessage(id: DialogId, msgId: string) {
    const d = dialogs.value[id];
    if (!d) return;
    d.rawMessages = d.rawMessages.filter(m => m.id !== msgId);
    bump(id);
  }
  function replaceMessage(id: DialogId, msgId: string, patch: Partial<ChatMessage>) {
    const d = dialogs.value[id];
    if (!d) return;
    const idx = d.rawMessages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    d.rawMessages[idx] = { ...d.rawMessages[idx], ...patch };
    bump(id);
  }
  function truncateAfter(id: DialogId, index: number) {
    const d = dialogs.value[id];
    if (!d) return;
    d.rawMessages = d.rawMessages.slice(0, index + 1);
    bump(id);
  }
  function resetDialog(id: DialogId) {
    const d = dialogs.value[id];
    if (!d) return;
    d.rawMessages = [];
    d.hasMore = false;
    d.offset = 0;
    d.status = 'idle';
    d.streaming = false;
    bump(id);
  }
  /** 整体替换 rawMessages（编辑/重新推理等场景） */
  function setRaw(id: DialogId, msgs: ChatMessage[]) {
    const d = ensureById(id);
    d.rawMessages = msgs;
    bump(id);
  }

  // ── 未读 ──
  function markUnread(id: DialogId) {
    const d = dialogs.value[id];
    if (d) d.unread += 1;
  }
  function clearUnread(id: DialogId) {
    const d = dialogs.value[id];
    if (d) d.unread = 0;
  }
  /** 兼容旧接口：有未读的 direct dialog 的 agentId 集合 */
  const unreadAgents = computed<Set<string>>(() => {
    const s = new Set<string>();
    for (const [id, d] of Object.entries(dialogs.value)) {
      if (d.unread > 0) {
        const { kind, key } = parseDialogId(id as DialogId);
        if (kind === 'direct') s.add(key);
      }
    }
    return s;
  });

  // ── 历史分页 ──
  function loadHistory(dialogId: DialogId, from: string, to: string) {
    const d = ensureById(dialogId);
    d.status = 'loading';
    d.hasMore = false;
    d.offset = 0;
    _historyOffset[to] = 0;
    useWebSocketStore().send('history.request', { from, to, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }
  function loadMoreHistory(dialogId: DialogId) {
    const d = dialogs.value[dialogId];
    if (!d || d.status === 'loading' || !d.hasMore) return;
    const agentId = parseDialogId(dialogId).key;
    d.status = 'loading';
    _historyOffset[agentId] = (_historyOffset[agentId] || 0) + HISTORY_PAGE_SIZE;
    useWebSocketStore().send('history.request', {
      from: VIEWER_ID.value, to: agentId, limit: HISTORY_PAGE_SIZE, offset: _historyOffset[agentId],
    });
  }
  function mergeHistory(dialogId: DialogId, msgs: ChatMessage[], isFirstPage: boolean): DialogFeed | null {
    const d = dialogs.value[dialogId];
    if (!d) return null;
    d.status = 'ready';
    const agentId = parseDialogId(dialogId).key;
    d.hasMore = msgs.filter(m => m.agent_id === VIEWER_ID.value).length >= HISTORY_PAGE_SIZE;
    const prevOffset = _historyOffset[agentId] || 0;
    const { merged: deduped, userCount } = mergeHistoryPage(msgs, d.rawMessages, isFirstPage);
    if (prevOffset > 0) _historyOffset[agentId] = prevOffset - HISTORY_PAGE_SIZE + userCount;
    d.rawMessages = deduped;
    bump(dialogId);
    return d;
  }

  /** 对外单值：当前活跃 dialog 的加载态（兼容旧接口） */
  const loadingHistory = computed(() => activeDialog.value?.status === 'loading');
  const hasMoreHistory = computed(() => activeDialog.value?.hasMore ?? false);

  // ── 群组历史（REST /api/groups/:id/history，分页：最新 50 + 上翻更早）──
  async function loadGroupHistory(dialogId: DialogId, groupId: string) {
    const d = ensureById(dialogId);
    d.status = 'loading';
    try {
      const resp = await fetch(`/api/groups/${encodeURIComponent(groupId)}/history?limit=50`);
      if (!resp.ok) { d.status = 'ready'; return; }
      const data = await resp.json();
      const msgs = (data.messages ?? []).map(groupMessageToChatMessage);
      d.rawMessages = msgs;
      d.offset = msgs.length;
      d.hasMore = true;
      d.status = 'ready';
      bump(dialogId);
    } catch {
      d.status = 'ready';
    }
  }

  /** 上翻加载更早群组历史：前插并返回新增消息（调用方负责保持滚动位置） */
  async function loadOlderGroupHistory(dialogId: DialogId, groupId: string): Promise<ChatMessage[] | null> {
    const d = dialogs.value[dialogId];
    if (!d || d.status === 'loading') return null;
    try {
      const resp = await fetch(`/api/groups/${encodeURIComponent(groupId)}/history?limit=50&offset=${d.offset}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const older = (data.messages ?? []).map(groupMessageToChatMessage);
      if (older.length > 0) {
        d.rawMessages = [...older, ...d.rawMessages];
        d.offset += older.length;
        bump(dialogId);
      }
      return older;
    } catch {
      return null;
    }
  }

  // ── 流式内部助手 ──
  function newAssistant(agentId: string): ChatMessage {
    return { id: uid('asst'), role: 'agent', content: '', isStreaming: true, timestamp: Date.now(), agent_id: agentId };
  }
  function markActive() { turnInProgress.value = true; }
  function scheduleDone(msgs: ChatMessage[]) {
    if (pendingDoneTimer) clearTimeout(pendingDoneTimer);
    pendingDoneTimer = setTimeout(() => {
      pendingDoneTimer = null;
      if (!lastStreaming(msgs, 'agent')) turnInProgress.value = false;
    }, TURN_DONE_DELAY);
  }

  /** 返回可变的 toolCalls 数组（宽松类型：含 result/label/running/preparing 等运行期字段） */
  function toolCallsOf(asst: ChatMessage | null): any[] {
    if (!asst) return [];
    if (!asst.toolCalls) asst.toolCalls = [] as any;
    return asst.toolCalls as any[];
  }

  // ── 流式事件处理（操作 rawMessages，派生自动反映）──
  function onTurnStart(id: DialogId | null) {
    if (!id) return;
    markActive();
    const d = ensureById(id);
    d.streaming = true;
    d.rawMessages.push(newAssistant(parseDialogId(id).key));
    bump(id);
  }
  function onTurnEnd(id: DialogId | null, data: any) {
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const asst = lastStreaming(msgs, 'agent'); if (asst) asst.isStreaming = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'tool' && msgs[i].isStreaming) msgs[i].isStreaming = false;
    }
    d.streaming = false;
    bump(id);
    if (data.interrupted) onInterrupted(id);
    scheduleDone(msgs);
  }
  function onThinkingStart(id: DialogId | null, data: any) {
    markActive();
    if (!id) return;
    const msgs = ensureById(id).rawMessages;
    let asst = lastStreaming(msgs, 'agent');
    if (asst && ((asst.thinking || asst.reasoning_content || '').trim())) {
      asst = newAssistant(parseDialogId(id).key);
      msgs.push(asst);
    }
    if (asst && data.label) asst.label = data.label;
    bump(id);
  }
  function onThinkingUpdate(id: DialogId | null, data: any) {
    if (!id) return;
    const msgs = ensureById(id).rawMessages;
    const asst = lastStreaming(msgs, 'agent');
    if (asst) { const dd = data.delta ?? ''; asst.thinking = (asst.thinking ?? '') + dd; asst.reasoning_content = (asst.reasoning_content ?? '') + dd; }
    bump(id);
  }
  function onThinkingEnd(id: DialogId | null, data: any) {
    if (!id) return;
    const msgs = ensureById(id).rawMessages;
    const asst = lastStreaming(msgs, 'agent');
    if (asst) asst.label = data.label || undefined;
    bump(id);
  }
  function onMessageUpdate(id: DialogId | null, data: any) {
    if (!id) return;
    const msgs = ensureById(id).rawMessages;
    const asst = lastStreaming(msgs, 'agent'); if (asst) asst.content += data.delta ?? '';
    bump(id);
  }
  function onMessageEnd(id: DialogId | null, data: any) {
    if (!id) return;
    const msgs = ensureById(id).rawMessages;
    const asst = lastStreaming(msgs, 'agent');
    if (!asst) return;
    asst.content = data.content ?? asst.content;
    asst.thinking = data.reasoning ?? asst.thinking;
    asst.reasoning_content = data.reasoning ?? asst.reasoning_content;
    if (data.tool_calls != null) asst.toolCalls = data.tool_calls;
    if (asst.content) useAgentStore().bumpAgent('assistant', asst.content);
    recordActivity({
      dialogId: id, agentId: parseDialogId(id).key,
      summary: (asst.content || '').slice(0, 60), event: 'message',
    });
    bump(id);
  }
  function onMessageError(id: DialogId | null, data: any) {
    turnInProgress.value = false;
    if (!id) return;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    append(id, {
      id: `error-${Date.now()}`, role: 'agent', content: `[ERROR] ${errMsg}`,
      isError: true, isStreaming: false, timestamp: Date.now(),
    });
  }
  function onToolcallStart(id: DialogId | null, data: any) {
    markActive();
    if (!id || !data?.name) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const asst = lastStreaming(msgs, 'agent');
    if (!asst) return;
    const tcs = toolCallsOf(asst);
    if (tcs.some((tc: any) => tc.preparing && tc.name === data.name)) return;
    const prepId = `prep-${data.name}-${data.index ?? Date.now()}`;
    tcs.push({ id: prepId, name: data.name, arguments: {}, result: '', label: `正在调用工具: ${data.name}`, preparing: true, running: true, startTime: Date.now() });
    msgs.push({
      id: `tool-${prepId}`, role: 'tool', content: '',
      name: data.name, toolName: data.name,
      tool_call_id: prepId,
      label: `正在调用工具: ${data.name}`, isStreaming: true, timestamp: Date.now(),
    });
    bump(id);
  }
  function onToolStart(id: DialogId | null, data: any) {
    markActive();
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const asst = lastStreaming(msgs, 'agent');
    const addToolCall = (tc: any) => {
      const tcs = toolCallsOf(asst);
      const found = tcs.find((x: any) => x.id === tc.id);
      if (found) { found.label = tc.label; }
      else tcs.push(tc);
    };
    // 升级 toolcall 阶段创建的占位（LLM 生成参数时已显示"正在调用工具"）
    const prep = toolCallsOf(asst).find((tc: any) => tc.preparing && tc.name === data.tool_name);
    if (prep) {
      prep.id = data.tool_call_id;
      prep.preparing = false;
      prep.arguments = data.arguments;
      prep.label = data.label || data.tool_name;
      const existing = lastStreaming(msgs, 'tool');
      if (existing && existing.toolName === data.tool_name) {
        existing.id = `tool-${data.tool_call_id}`;
        existing.tool_call_id = data.tool_call_id;
        existing.label = data.label || data.tool_name;
      }
      bump(id);
      return;
    }
    const existing = lastStreaming(msgs, 'tool');
    if (existing && existing.toolName === data.tool_name) {
      existing.id = `tool-${data.tool_call_id}`;
      existing.label = data.label || data.tool_name;
      existing.name = data.tool_name;
      existing.toolName = data.tool_name;
      existing.tool_call_id = data.tool_call_id;
      if (asst) addToolCall({ id: data.tool_call_id, name: data.tool_name, arguments: data.arguments, result: '', label: data.label || data.tool_name, running: true, startTime: Date.now() });
    } else {
      msgs.push({
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id,
        label: data.label || data.tool_name, isStreaming: true, timestamp: Date.now(),
      });
      if (asst) addToolCall({ id: data.tool_call_id, name: data.tool_name, arguments: data.arguments, result: '', label: data.label || data.tool_name, running: true, startTime: Date.now() });
    }
    bump(id);
  }
  function onToolEnd(id: DialogId | null, data: any) {
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' && m.toolName && m.isStreaming) { m.content = data.result ?? ''; m.isStreaming = false; break; }
    }
    const asst = lastStreaming(msgs, 'agent');
    const tc = toolCallsOf(asst).find((x: any) => x.id === data.tool_call_id);
    if (tc) { tc.running = false; tc.result = data.result ?? ''; }
    bump(id);
  }
  function onToolUpdate(id: DialogId | null, data: any) {
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const existing = lastStreaming(msgs, 'tool');
    if (existing) existing.content += data.delta ?? '';
    // 同步 toolCalls 的 result —— turns 派生的 ToolMessage 内容来自 assistant.toolCalls
    const asst = lastStreaming(msgs, 'agent');
    const tc = toolCallsOf(asst).find((x: any) => x.id === data.tool_call_id);
    if (tc) tc.result = (tc.result || '') + (data.delta ?? '');
    bump(id);
  }
  function onInterrupted(id: DialogId | null) {
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'agent' && m.isStreaming) {
        m.isStreaming = false;
        if (!m.content?.trim()) m.content = '\u23F8\uFE0F (已被中断)';
      }
    }
    closeAllStreaming(msgs);
    d.streaming = false;
    bump(id);
    scheduleDone(msgs);
  }
  function onChatEnd(id: DialogId | null) {
    if (!id) return;
    const d = ensureById(id);
    d.streaming = false;
    closeAllStreaming(d.rawMessages);
    bump(id);
    scheduleDone(d.rawMessages);
  }

  // ── 会话恢复 ──
  function onSessionResume(d: any) {
    if (!d.active) return;
    resumeSnapshot = d;
    if (d.agentId === activeAgentId.value) {
      turnInProgress.value = true;
      const dialogId = directDialog(d.agentId);
      const raw = dialogs.value[dialogId]?.rawMessages;
      if (raw && raw.length > 0) {
        mergeResumeSnapshot(d);
      }
    }
  }
  /** 将 resume 快照（未落盘的当前轮）追加进 rawMessages（turns 由派生自动生成） */
  function mergeResumeSnapshot(d: any) {
    resumeSnapshot = null;
    turnInProgress.value = true;
    const dialogId = directDialog(d.agentId);
    const msgs = ensureById(dialogId).rawMessages;

    // ① 当前轮用户消息（postHook 前未落盘）
    const userMsgs = (d.userMessages && d.userMessages.length > 0)
      ? d.userMessages
      : (d.userMessage ? [{ content: d.userMessage, ts: d.userMessageTs || Date.now() }] : []);
    for (const um of userMsgs) {
      msgs.push({
        id: uid('user'), role: 'agent', content: um.content,
        timestamp: um.ts || Date.now(), agent_id: VIEWER_ID.value,
      });
    }

    // ② 已完成的 ReAct 步骤
    const steps: any[] = (d.steps || []).map((s: any) => ({
      thinking: s.thinking || '',
      label: s.label || '',
      tool_calls: (s.tool_calls || []).map((tc: any) => ({
        id: tc.id, name: tc.name || '', arguments: tc.arguments || {}, result: tc.result || '', label: tc.label || tc.name || '',
      })),
      content: s.content || '',
      ts: s.ts || Date.now(),
    }));
    for (const s of steps) {
      if (s.content || s.thinking || s.tool_calls?.length) {
        msgs.push({
          id: uid('asst'), role: 'agent', content: s.content || '',
          thinking: s.thinking, reasoning_content: s.thinking, label: s.label,
          toolCalls: s.tool_calls as any, timestamp: s.ts || Date.now(), agent_id: d.agentId,
        });
        for (const tc of s.tool_calls || []) {
          msgs.push({
            id: `tool-${tc.id}`, role: 'tool', content: tc.result || '',
            name: tc.name, toolName: tc.name, tool_call_id: tc.id,
            label: tc.label || tc.name || '', timestamp: s.ts || Date.now(),
          });
        }
      }
    }

    // ③ 进行中的 assistant（当前正在流式的部分）
    const asst = newAssistant(d.agentId);
    asst.thinking = d.thinking || undefined;
    asst.reasoning_content = d.thinking || undefined;
    asst.content = d.content || '';
    asst.label = d.label || undefined;
    msgs.push(asst);
    if (d.phase === 'tool' && d.toolCallId) {
      toolCallsOf(asst).push({ id: d.toolCallId, name: d.toolName || '', arguments: {}, result: '', label: d.label || d.toolName || '', running: true, startTime: Date.now() });
      msgs.push({
        id: `tool-${d.toolCallId}`, role: 'tool', content: '',
        name: d.toolName, toolName: d.toolName,
        label: d.label || d.toolName,
        isStreaming: true, timestamp: Date.now(),
      });
    }
    bump(dialogId);
    logger.info(`[FeedStore] 已恢复 ${d.agentId} 的活跃会话（phase=${d.phase}, steps=${steps.length}, content=${d.content.length}chars）`);
  }

  // ── 历史响应 ──
  function onHistory(data: any) {
    const target = data.agentId || activeAgentId.value;
    if (!target) return;
    const dialogId = directDialog(target);
    const msgs = (data.messages ?? []).map((m: any): ChatMessage => ({
      id: m.message_id ?? uid('hist'),
      role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id, toolCalls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      timestamp: new Date(m.timestamp ?? Date.now()).getTime(),
    }));
    const isFirstPage = (_historyOffset[target] || 0) === 0;
    mergeHistory(dialogId, msgs, isFirstPage);
    // 初次加载完成后，合并 resume 快照（当前轮未落盘消息）
    if (isFirstPage && resumeSnapshot && resumeSnapshot.agentId === target) {
      mergeResumeSnapshot(resumeSnapshot);
    }
  }

  // ── 事件路由 ──
  function eventAgentId(d: any): string { return d?.agentId || d?.agent || ''; }
  /** 仅当事件的 sender 为当前用户时才处理流式输出，防止其他 Agent 的推理结果串台 */
  function isForCurrentUser(d: any): boolean {
    return !d?.sender || d.sender === VIEWER_ID.value;
  }
  /** UI 信号：仅活跃 Agent 更新全局指示器 */
  function isForActiveAgent(d: any): boolean {
    const a = activeAgentId.value;
    if (!a) return true;
    const eventAgent = d?.agentId || d?.agent;
    if (!eventAgent) return true;
    return eventAgent === a;
  }

  /** 事件会话归属判定（从后端会话键反解，不再只靠 agentId）：
   *  - chat~lo~hi：1v1；仅当含 VIEWER_ID 才属于用户可见的 direct 对话
   *    （chat~X~X = Agent 自言自语，chat~A~B = Agent 间对话，均过滤）
   *  - group~gid~aid：群聊内 Agent 自主推理的过程流式（thinking/正文占位）；
   *    不属于 1v1 界面 —— 群聊正式回复经 send_group → group.message 事件进群组对话，
   *    这里的过程流式一律过滤，防止串进当前 1v1 会话
   *  - 无 dialogId：旧事件，放行（由 agentId 兜底）
   */
  function isUserDialog(d: any): boolean {
    const dialogId = d?.dialogId;
    if (!dialogId || typeof dialogId !== 'string') return true;
    if (dialogId.startsWith('group~')) return false;
    if (dialogId.startsWith('chat~')) return dialogId.split('~').includes(VIEWER_ID.value);
    return true;
  }

  /**
   * 统一 ingest 入口：所有消息类 WS 事件流入此池。
   * 解析目标 dialog → 追加/更新 rawMessages → 更新元数据。
   */
  function ingest(type: string, data: any) {
    const agentId = eventAgentId(data);
    const dialogId: DialogId | null = agentId ? directDialog(agentId) : null;

    switch (type) {
      case 'chat.start': {
        // C1：后端显式下发 isTrigger，前端不再用正文 <trigger> 嗅探判定
        if (!isUserDialog(data)) break;
        if (data.isTrigger === true && isForActiveAgent(data)) {
          if (data.hint && typeof data.hint === 'string' && data.hint.includes('[归档整理]')) archivePending.value = true;
          if (dialogId) {
            append(dialogId, {
              id: uid('trigger'),
              role: 'trigger',
              content: data.hint,
              agent_id: data.sender || 'system',
              timestamp: Date.now(),
            });
            recordActivity({
              dialogId, agentId: data.sender || 'system',
              summary: (data.hint || '').slice(0, 60), event: 'trigger',
            });
          }
        }
        break;
      }
      case 'chat.turn.start':      if (isUserDialog(data) && isForActiveAgent(data)) onTurnStart(dialogId); break;
      case 'chat.turn.end':        if (isUserDialog(data) && isForActiveAgent(data)) onTurnEnd(dialogId, data); break;
      case 'chat.interrupted':     if (isUserDialog(data) && isForActiveAgent(data)) onInterrupted(dialogId); break;
      case 'chat.end':             if (isUserDialog(data) && isForActiveAgent(data)) { archivePending.value = false; lastRunEndAt.value = Date.now(); onChatEnd(dialogId); } break;

      // 流式内容：始终写入目标 dialog 缓冲，不受 isForActiveAgent 限制（但防串台 + 防自言自语）
      case 'chat.message.start':   break;
      case 'chat.message.update':  if (isUserDialog(data) && isForCurrentUser(data)) onMessageUpdate(dialogId, data); break;
      case 'chat.message.end':     if (isUserDialog(data) && isForCurrentUser(data)) onMessageEnd(dialogId, data); break;
      case 'chat.message.error':   if (isUserDialog(data) && isForCurrentUser(data)) onMessageError(dialogId, data); break;
      case 'chat.thinking.start':  if (isUserDialog(data) && isForCurrentUser(data)) onThinkingStart(dialogId, data); break;
      case 'chat.thinking.update': if (isUserDialog(data) && isForCurrentUser(data)) onThinkingUpdate(dialogId, data); break;
      case 'chat.thinking.end':    if (isUserDialog(data) && isForCurrentUser(data)) onThinkingEnd(dialogId, data); break;
      case 'chat.toolcall.start':  if (isUserDialog(data) && isForCurrentUser(data)) onToolcallStart(dialogId, data); break;
      case 'chat.toolcall.update': if (isUserDialog(data) && isForCurrentUser(data)) markActive(); break;
      case 'chat.toolcall.end':    if (isUserDialog(data) && isForCurrentUser(data)) markActive(); break;
      case 'chat.tool_execution.start':  if (isUserDialog(data) && isForCurrentUser(data)) onToolStart(dialogId, data); break;
      case 'chat.tool_execution.update': if (isUserDialog(data) && isForCurrentUser(data)) onToolUpdate(dialogId, data); break;
      case 'chat.tool_execution.end':    if (isUserDialog(data) && isForCurrentUser(data)) onToolEnd(dialogId, data); break;

      case 'chat.session.resume':  onSessionResume(data); break;
      case 'history.response':     onHistory(data); break;

      // 群聊消息：Agent 在群组中说话 → 写入对应 group dialog（与 direct 同池）
      case 'group.message': {
        const gid = data?.group_id;
        if (!gid) return;
        const gDialog = groupDialog(gid);
        const gd = ensureById(gDialog);
        gd.rawMessages.push({
          id: uid('msg'),
          role: 'agent',
          content: data.payload ?? data.content ?? '',
          agent_id: data.from,
          timestamp: Date.now(),
        });
        touch(gDialog, data.from || '', data.payload ?? data.content ?? '', Date.now());
        bump(gDialog);
        recordActivity({
          dialogId: gDialog, agentId: data.from || '',
          summary: (data.payload ?? data.content ?? '').slice(0, 60), event: 'group',
        });
        break;
      }

      // ⚠️ group.created/deleted/join/leave：由 App.vue 维护群组列表，此处不处理

      // 虚拟 Agent 收到消息 → 实时推送到对应 Agent 对话中（发送方 Agent 主动发给 user）
      case 'chat.virtual.receive': {
        const vAgentId = data?.agent;
        if (!vAgentId) return;
        const vDialog = directDialog(vAgentId);
        const d = ensureById(vDialog);
        d.rawMessages.push({
          id: uid('virt'),
          role: 'agent',
          content: data?.payload ?? '',
          agent_id: vAgentId,
          label: data?.label,
          timestamp: Date.now(),
        });
        bump(vDialog);
        recordActivity({
          dialogId: vDialog, agentId: vAgentId,
          summary: (data?.payload || '').slice(0, 60), event: 'message',
        });
        // 非当前活跃 Agent → 标记未读 + 置顶重排
        if (vAgentId !== activeAgentId.value) {
          d.unread += 1;
          useAgentStore().bumpAgentById(vAgentId, 'assistant', data?.payload ?? '');
        }
        break;
      }

      // ⚠️ group.message 等群聊事件：下一步将 GroupChat 融合进统一池后接入
      default:
        break;
    }
  }

  // ── 注册 WS 消息路由 ──
  function init() {
    const ws = useWebSocketStore();
    ws.init();
    ws.onMessage((type, data) => ingest(type, data));
  }

  return {
    // state / 派生
    dialogs, activeDialogId, activeDialog, activeAgentId, activeGroupId,
    setActiveGroup, clearActiveGroup,
    activity,
    turnInProgress, lastRunEndAt, archivePending,
    unreadAgents, loadingHistory, hasMoreHistory,
    getDialog, getRaw, getTurns,
    // 原语
    ensureById, append, removeMessage, replaceMessage, truncateAfter, resetDialog, setRaw,
    markUnread, clearUnread, touch, bump,
    // 历史
    loadHistory, loadMoreHistory, mergeHistory,
    loadGroupHistory, loadOlderGroupHistory,
    // 事件
    ingest, init,
  };
});
