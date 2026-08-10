// ============================================================
// stores/chat.ts —— 统一会话 Store（agent 会话 + 群聊收敛为同一管线）
//
// 与 v1 的关键差异：
// 1. 所有会话按 conversationKey 归一化（'agent:<id>' / 'group:<id>'），
//    agent 与 group 共用一套消息缓冲 / Turn 构建 / 分页 / 渲染源；
// 2. 瞬态（isStreaming/status/isError）与领域数据分离：
//    消息本体（domain ChatMessage）是静态事实，runtime 单独维护；
// 3. WS 事件分发按目标会话路由，不依赖"当前激活"即可正确写入缓冲。
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { ChatMessage, ConversationRef, Turn } from '@/domain/types';
import { agentMsgsToSteps, buildTurnsForHistory, type AgentMsg, type AgentTurnEntry } from '@/domain/turns';
import { mergeHistoryPage, HISTORY_PAGE_SIZE } from '@/domain/history';
import { useWebSocketStore } from './websocket';
import { useAgentStore, VIEWER_ID } from './agents';
import { useGroupStore } from './groups';
import { groupApi } from '@/services/api';
import { logger } from '@/utils/logger';

const TURN_DONE_DELAY = 300;

/** 会话瞬态（UI 相关，与领域数据分离） */
export interface MessageRuntime {
  isStreaming?: boolean;
  status?: 'running' | 'success' | 'error';
  isError?: boolean;
}

export interface ConversationState {
  key: string;
  kind: 'agent' | 'group';
  id: string;
  /** 原始消息缓冲（流式增量写入） */
  messages: ChatMessage[];
  /** 已完成 Turn（历史 + onTurnEnd 追加） */
  turns: Turn[];
  /** 流式中的 entry（final 非空 = 进行中） */
  streaming: AgentTurnEntry[];
  /** 瞬态（msgId → runtime） */
  runtime: Record<string, MessageRuntime>;
  /** 历史分页 */
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  historyOffset: number;
  /** 是否正在生成（agent）/ 等待（group） */
  turnInProgress: boolean;
}

export function convKey(ref: ConversationRef): string {
  return `${ref.kind}:${ref.id}`;
}

const newConversation = (ref: ConversationRef): ConversationState => ({
  key: convKey(ref),
  kind: ref.kind,
  id: ref.id,
  messages: [],
  turns: [],
  streaming: [],
  runtime: {},
  hasMoreHistory: false,
  loadingHistory: false,
  historyOffset: 0,
  turnInProgress: false,
});

export const useChatStore = defineStore('chat', () => {
  const conversations = ref<Record<string, ConversationState>>({});
  /** 当前激活会话 */
  const activeRef = ref<ConversationRef | null>(null);
  /** 小红点 */
  const unreadAgents = ref(new Set<string>());

  const archivePending = ref(false);
  const lastRunEndAt = ref(0);
  const compressPending = ref(false);
  const compressFeedback = ref('');
  const busyFeedback = ref('');
  const copyFeedback = ref(false);

  // ask_questions 交互
  const interaction = ref<{
    interaction_id: string;
    agent_id: string;
    question: string;
    options: string[];
    allow_custom: boolean;
    timeout_ms: number;
  } | null>(null);

  // System Prompt / 工具定义预览
  const systemPromptLoading = ref(false);
  const systemPromptContent = ref('');
  const systemPromptError = ref('');
  const toolDefsLoading = ref(false);
  const toolDefs = ref<any[]>([]);
  const toolDefsError = ref('');

  let resumeSnapshot: any = null;
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;
  let compressFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let busyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 辅助 ──
  function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

  function getConv(ref: ConversationRef): ConversationState {
    const key = convKey(ref);
    if (!conversations.value[key]) conversations.value[key] = newConversation(ref);
    return conversations.value[key]!;
  }

  const activeKey = computed(() => activeRef.value ? convKey(activeRef.value) : '');

  /** 激活会话状态（渲染源） */
  const activeConv = computed<ConversationState | null>(() =>
    activeRef.value ? conversations.value[convKey(activeRef.value)] ?? null : null);

  /** 激活会话的展示 Turn 列表（历史 + 流式 entry 合并） */
  const turns = computed<Turn[]>(() => {
    const conv = activeConv.value;
    if (!conv) return [];
    const base = conv.turns;
    const entries = conv.streaming;
    if (!entries?.length) return base;
    const last = entries[entries.length - 1];
    if (!last.final) return base;
    const allMsgs = [...last.turns, last.final];
    if (!allMsgs.some(m => m.thinking || m.content || m.tool_calls?.length)) return base;
    const turn = agentMsgsToSteps(allMsgs, true, last.agent_id);
    return [...base, turn];
  });

  const messages = computed<ChatMessage[]>(() => activeConv.value?.messages ?? []);

  /** 当前激活会话是否正在生成 */
  const turnInProgress = computed(() => activeConv.value?.turnInProgress ?? false);

  function runtimeOf(conv: ConversationState, msgId: string): MessageRuntime {
    return conv.runtime[msgId] ?? {};
  }

  // ── 激活/选择 ──
  function selectConversation(ref: ConversationRef | null): void {
    activeRef.value = ref;
    if (ref?.kind === 'agent') {
      unreadAgents.value.delete(ref.id);
      useAgentStore().persistLastAgent(ref.id);
      loadHistory(ref);
    } else if (ref?.kind === 'group') {
      useGroupStore().persistLastGroup(ref.id);
      loadGroupHistory(ref);
    }
  }

  // ── Agent 会话动作 ──
  function sendMessage(content: string, files: FileAttachmentLike[] = []): void {
    const ref = activeRef.value;
    if (!ref || ref.kind !== 'agent') return;
    if (!content.trim() && !files.length) return;
    const conv = getConv(ref);
    const userMsg: ChatMessage = {
      id: uid('user'), role: 'agent', content, timestamp: Date.now(), files: files as any, agent_id: VIEWER_ID,
    };
    conv.messages.push(userMsg);
    conv.turns.push({ agent_id: VIEWER_ID, steps: [], final: userMsg });
    useAgentStore().bumpAgentById(ref.id, VIEWER_ID, content);
    markActive(conv);
    useWebSocketStore().send('chat.send', { to: ref.id, content, deepThink: true, files });
  }

  function interruptGeneration(): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent') return;
    useWebSocketStore().send('chat.interrupt', { to: ref.id });
  }

  function continueGeneration(): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent') return;
    const conv = getConv(ref);
    if (conv.turnInProgress) return;
    markActive(conv);
    useWebSocketStore().send('chat.continue', { to: ref.id });
  }

  function regenerateMessage(msgId: string): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent') return;
    const conv = getConv(ref);
    if (conv.turnInProgress) return;
    const msgs = conv.messages;
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const oldMsg = msgs[idx];
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].agent_id === VIEWER_ID) { userIdx = i; break; }
    }
    if (userIdx === -1) return;
    const userMsg = msgs[userIdx];
    for (const m of [oldMsg, userMsg]) {
      if (m.persistedMsgId) {
        useWebSocketStore().send('chat.delete_message', { agent: ref.id, counterpart: VIEWER_ID, messageId: m.persistedMsgId });
      }
    }
    conv.messages = [...msgs.slice(0, userIdx), ...msgs.slice(idx + 1)];
    const newUserMsg: ChatMessage = { ...userMsg, id: uid('user'), timestamp: Date.now() };
    conv.messages.push(newUserMsg);
    useAgentStore().bumpAgentById(ref.id, VIEWER_ID, userMsg.content);
    conv.turns.push({ agent_id: VIEWER_ID, steps: [], final: newUserMsg });
    useWebSocketStore().send('chat.send', { to: ref.id, content: userMsg.content, deepThink: true, files: userMsg.files ?? [] });
  }

  function deleteMessage(msgId: string): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent') return;
    const conv = getConv(ref);
    if (conv.turnInProgress) return;
    const idx = conv.messages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const msg = conv.messages[idx];
    if (msg.persistedMsgId) {
      useWebSocketStore().send('chat.delete_message', { agent: ref.id, counterpart: VIEWER_ID, messageId: msg.persistedMsgId });
    }
    conv.messages = [...conv.messages.slice(0, idx), ...conv.messages.slice(idx + 1)];
    conv.turns = conv.turns.filter(t => t.final?.id !== msgId);
  }

  function editMessage(msgId: string, newContent: string): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent') return;
    const conv = getConv(ref);
    if (conv.turnInProgress) return;
    const msgs = conv.messages;
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const toDelete = msgs.slice(idx).filter(m => m.persistedMsgId).map(m => m.persistedMsgId!);
    for (const mid of toDelete) {
      useWebSocketStore().send('chat.delete_message', { agent: ref.id, counterpart: VIEWER_ID, messageId: mid });
    }
    msgs[idx] = { ...msgs[idx], content: newContent };
    conv.messages = msgs.slice(0, idx + 1);
    conv.turns = conv.turns.filter(t => t.final?.id !== msgId || t.agent_id !== VIEWER_ID)
      .concat(conv.messages.filter(m => m.agent_id === VIEWER_ID).map(m => ({ agent_id: VIEWER_ID, steps: [], final: m })));
    useWebSocketStore().send('chat.send', { to: ref.id, content: newContent, deepThink: true, files: [] });
  }

  // ── 历史分页（agent）──
  function loadHistory(ref: ConversationRef): void {
    if (ref.kind !== 'agent') return;
    const conv = getConv(ref);
    conv.historyOffset = 0;
    conv.hasMoreHistory = false;
    conv.loadingHistory = true;
    useWebSocketStore().send('history.request', { from: VIEWER_ID, to: ref.id, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }

  function loadMoreHistory(): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent') return;
    const conv = getConv(ref);
    if (conv.loadingHistory || !conv.hasMoreHistory) return;
    conv.loadingHistory = true;
    conv.historyOffset += HISTORY_PAGE_SIZE;
    useWebSocketStore().send('history.request', { from: VIEWER_ID, to: ref.id, limit: HISTORY_PAGE_SIZE, offset: conv.historyOffset });
  }

  // ── 群聊 ──
  async function loadGroupHistory(ref: ConversationRef): Promise<void> {
    if (ref.kind !== 'group') return;
    const conv = getConv(ref);
    conv.loadingHistory = true;
    try {
      const data = await groupApi.history(ref.id, 50, 0);
      conv.messages = (data.messages ?? []).map(toChatMessage);
      conv.historyOffset = conv.messages.length;
      conv.turns = buildTurnsForHistory(ref.id, conv.messages);
      conv.hasMoreHistory = conv.messages.length >= 50;
    } catch { /* ignore */ } finally {
      conv.loadingHistory = false;
    }
  }

  async function loadOlderGroupHistory(): Promise<void> {
    const ref = activeRef.value;
    if (ref?.kind !== 'group') return;
    const conv = getConv(ref);
    if (conv.loadingHistory || !conv.hasMoreHistory) return;
    conv.loadingHistory = true;
    try {
      const data = await groupApi.history(ref.id, 50, conv.historyOffset);
      const older = (data.messages ?? []).map(toChatMessage);
      if (!older.length) { conv.hasMoreHistory = false; return; }
      conv.messages = [...older, ...conv.messages];
      conv.historyOffset += older.length;
      conv.turns = buildTurnsForHistory(ref.id, conv.messages);
      conv.hasMoreHistory = older.length >= 50;
    } catch { /* ignore */ } finally {
      conv.loadingHistory = false;
    }
  }

  function sendGroupMessage(content: string): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'group') return;
    if (!content.trim()) return;
    const conv = getConv(ref);
    conv.turnInProgress = true;
    useWebSocketStore().send('group.message', { group_id: ref.id, content, from: VIEWER_ID });
  }

  function toChatMessage(m: any): ChatMessage {
    return {
      id: uid('hist'),
      role: (m.role === 'tool' ? 'tool' : 'agent') as ChatMessage['role'],
      content: m.content ?? '',
      agent_id: m.agent_id,
      name: m.name,
      label: m.label,
      timestamp: new Date(m.timestamp || Date.now()).getTime(),
    };
  }

  // ── 压缩 ──
  function compressSession(): void {
    const ref = activeRef.value;
    if (ref?.kind !== 'agent' || compressPending.value) return;
    compressPending.value = true;
    compressFeedback.value = '正在归档整理记忆…';
    useWebSocketStore().send('session.compress', { agent: ref.id, counterpart: VIEWER_ID });
  }

  // ── 交互 ──
  function respondInteraction(choice: string): void {
    const current = interaction.value;
    if (!current) return;
    useWebSocketStore().send('chat.interact.respond', { interaction_id: current.interaction_id, choice });
    interaction.value = null;
  }
  function dismissInteraction(): void { interaction.value = null; }

  // ── System Prompt / 工具定义 ──
  function requestSystemPrompt(agentId?: string): void {
    const ref = activeRef.value;
    const target = agentId ?? (ref?.kind === 'agent' ? ref.id : undefined);
    if (!target) return;
    systemPromptLoading.value = true;
    systemPromptContent.value = '';
    systemPromptError.value = '';
    useWebSocketStore().send('agent.system_prompt', { agentId: target });
  }
  function clearSystemPrompt(): void { systemPromptContent.value = ''; systemPromptError.value = ''; }

  function requestToolDefs(agentId?: string): void {
    const ref = activeRef.value;
    const target = agentId ?? (ref?.kind === 'agent' ? ref.id : undefined);
    if (!target) return;
    toolDefsLoading.value = true;
    toolDefs.value = [];
    toolDefsError.value = '';
    useWebSocketStore().send('agent.tool_defs', { agentId: target });
  }
  function clearToolDefs(): void { toolDefs.value = []; toolDefsError.value = ''; }

  // ── 瞬态辅助 ──
  function markActive(conv: ConversationState): void {
    if (pendingDoneTimer) { clearTimeout(pendingDoneTimer); pendingDoneTimer = null; }
    conv.turnInProgress = true;
  }

  function scheduleDone(conv: ConversationState): void {
    if (pendingDoneTimer) clearTimeout(pendingDoneTimer);
    pendingDoneTimer = setTimeout(() => {
      pendingDoneTimer = null;
      if (!lastStreaming(conv.messages, 'agent')) conv.turnInProgress = false;
    }, TURN_DONE_DELAY);
  }

  function lastStreaming(msgs: ChatMessage[], role?: 'agent' | 'tool'): ChatMessage | null {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.isStreaming && (!role || m.role === role)) return m;
    }
    return null;
  }

  function closeAllStreaming(conv: ConversationState): void {
    for (const m of conv.messages) {
      if (m.isStreaming) m.isStreaming = false;
    }
    for (const key of Object.keys(conv.runtime)) {
      if (conv.runtime[key]?.isStreaming) conv.runtime[key]!.isStreaming = false;
    }
  }

  function newAssistant(agentId: string): ChatMessage {
    return { id: uid('asst'), role: 'agent', content: '', timestamp: Date.now(), agent_id: agentId };
  }

  function setRuntime(conv: ConversationState, msgId: string, patch: Partial<MessageRuntime>): void {
    conv.runtime[msgId] = { ...(conv.runtime[msgId] ?? {}), ...patch };
  }

  // ── Agent 流式事件（按目标会话路由）──
  function eventAgentId(d: any): string { return d?.agentId || d?.agent || ''; }
  function isForCurrentUser(d: any): boolean { return !d?.sender || d.sender === VIEWER_ID; }
  function isForActiveAgent(d: any): boolean {
    const ref = activeRef.value;
    if (!ref || ref.kind !== 'agent') return false;
    const eventAgent = d?.agentId || d?.agent;
    if (!eventAgent) return true;
    return eventAgent === ref.id;
  }

  function onTurnStart(agentId: string): void {
    const ref: ConversationRef = { kind: 'agent', id: agentId };
    const conv = getConv(ref);
    markActive(conv);
    conv.messages.push(newAssistant(agentId));
    const entries = conv.streaming;
    const lastEntry = entries[entries.length - 1];
    if (!lastEntry || lastEntry.agent_id !== agentId) {
      conv.streaming = [...entries, { agent_id: agentId, turns: [], final: null }];
    }
    const curEntry = conv.streaming[conv.streaming.length - 1]!;
    curEntry.turns = [];
    curEntry.final = { agent_id: agentId, thinking: '', tool_calls: [], content: '', ts: Date.now(), label: '' };
  }

  function onTurnEnd(agentId: string, data: any): void {
    const ref: ConversationRef = { kind: 'agent', id: agentId };
    const conv = getConv(ref);
    const asst = lastStreaming(conv.messages, 'agent'); if (asst) asst.isStreaming = false;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'tool' && conv.messages[i].isStreaming) conv.messages[i].isStreaming = false;
    }
    const entries = conv.streaming;
    if (entries?.length && entries[entries.length - 1].final) {
      const e = entries[entries.length - 1];
      e.turns.push({ ...e.final!, ts: Date.now() - (e.turns.length * 1000) });
      e.final = null;
      const snapshot = [...e.turns];
      e.turns = [];
      const turn = agentMsgsToSteps(snapshot, false, e.agent_id);
      if (e.agent_id === agentId) {
        const existing = conv.turns;
        const lastTurn = existing[existing.length - 1];
        if (lastTurn && lastTurn.agent_id === agentId) {
          existing[existing.length - 1] = { agent_id: agentId, steps: [...lastTurn.steps, ...turn.steps], final: turn.final };
          conv.turns = [...existing];
        } else {
          conv.turns = [...existing, turn];
        }
      }
    }
    if (data.interrupted) onInterrupted(agentId);
    scheduleDone(conv);
  }

  function onThinkingStart(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    markActive(conv);
    const msgs = conv.messages;
    let asst = lastStreaming(msgs, 'agent');
    if (asst && ((asst.thinking || asst.reasoning_content || '').trim())) {
      asst = newAssistant(agentId);
      msgs.push(asst);
    }
    if (asst && data.label) asst.label = data.label;
  }

  function onThinkingUpdate(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const asst = lastStreaming(conv.messages, 'agent');
    if (asst) { const d = data.delta ?? ''; asst.thinking = (asst.thinking ?? '') + d; asst.reasoning_content = (asst.reasoning_content ?? '') + d; }
    const et = conv.streaming;
    if (et?.length && et[et.length - 1].final) et[et.length - 1].final!.thinking += (data.delta ?? '');
  }

  function onThinkingEnd(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const asst = lastStreaming(conv.messages, 'agent');
    if (asst) {
      asst.label = data.label || undefined;
      const et = conv.streaming;
      if (et?.length && et[et.length - 1].final) et[et.length - 1].final!.label = data.label || undefined;
    }
  }

  function onMessageUpdate(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const asst = lastStreaming(conv.messages, 'agent'); if (asst) asst.content += data.delta ?? '';
    const et = conv.streaming;
    if (et?.length && et[et.length - 1].final) et[et.length - 1].final!.content += (data.delta ?? '');
  }

  function onMessageEnd(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const asst = lastStreaming(conv.messages, 'agent');
    if (!asst) return;
    asst.content = data.content ?? asst.content;
    asst.thinking = data.reasoning ?? asst.thinking;
    asst.reasoning_content = data.reasoning ?? asst.reasoning_content;
    if (data.tool_calls != null) asst.toolCalls = data.tool_calls;
    if (asst.content) useAgentStore().bumpAgentById(agentId, 'assistant', asst.content);
    const et = conv.streaming;
    if (et?.length && et[et.length - 1].final) {
      const f = et[et.length - 1].final!;
      f.content = data.content ?? f.content;
      if (data.tool_calls != null) f.tool_calls = data.tool_calls;
    }
  }

  function onMessageError(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    conv.turnInProgress = false;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    const msg: ChatMessage = { id: `error-${Date.now()}`, role: 'agent', content: `[ERROR] ${errMsg}`, timestamp: Date.now() };
    conv.messages.push(msg);
    setRuntime(conv, msg.id, { isError: true });
  }

  function onToolStart(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    markActive(conv);
    const msgs = conv.messages;
    const et = conv.streaming;
    const f = et?.length ? et[et.length - 1].final : null;
    const prep = f?.tool_calls?.find((tc: any) => tc.preparing && tc.name === data.tool_name);
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
      return;
    }
    const existing = lastStreaming(msgs, 'tool');
    if (existing && existing.toolName === data.tool_name) {
      existing.id = `tool-${data.tool_call_id}`;
      existing.label = data.label || data.tool_name;
      existing.name = data.tool_name;
      existing.toolName = data.tool_name;
      existing.tool_call_id = data.tool_call_id;
      _addToolToStreaming(conv, data.tool_call_id, data.tool_name, data.arguments);
    } else {
      const msg: ChatMessage = {
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id,
        label: data.label || data.tool_name, timestamp: Date.now(),
      };
      msgs.push(msg);
      setRuntime(conv, msg.id, { isStreaming: true });
      _addToolToStreaming(conv, data.tool_call_id, data.tool_name, data.arguments);
    }
  }

  function _addToolToStreaming(conv: ConversationState, callId: string, name: string, args: any): void {
    const et = conv.streaming;
    if (et?.length && et[et.length - 1].final) {
      const f = et[et.length - 1].final!;
      f.tool_calls = f.tool_calls || [];
      if (!f.tool_calls.find((tc: any) => tc.id === callId)) {
        f.tool_calls.push({ id: callId, name, arguments: args, result: '', label: '', running: true, startTime: Date.now() });
      }
    }
  }

  function onToolcallStart(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    markActive(conv);
    if (!data?.name) return;
    const et = conv.streaming;
    const f = et?.length ? et[et.length - 1].final : null;
    if (!f) return;
    if (f.tool_calls?.some((tc: any) => tc.preparing && tc.name === data.name)) return;
    const prepId = `prep-${data.name}-${data.index ?? Date.now()}`;
    f.tool_calls = f.tool_calls || [];
    f.tool_calls.push({ id: prepId, name: data.name, arguments: {}, result: '', label: `正在调用工具: ${data.name}`, preparing: true, running: true, startTime: Date.now() });
    const msg: ChatMessage = {
      id: `tool-${prepId}`, role: 'tool', content: '',
      name: data.name, toolName: data.name,
      tool_call_id: prepId,
      label: `正在调用工具: ${data.name}`, timestamp: Date.now(),
    };
    conv.messages.push(msg);
    setRuntime(conv, msg.id, { isStreaming: true });
  }

  function onToolEnd(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const msgs = conv.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' && m.toolName && m.isStreaming) { m.content = data.result ?? ''; m.isStreaming = false; break; }
    }
    const et = conv.streaming;
    if (et?.length && et[et.length - 1].final) {
      const tc = et[et.length - 1].final!.tool_calls?.find((x: any) => x.id === data.tool_call_id);
      if (tc) { tc.running = false; tc.result = data.result ?? ''; }
    }
  }

  function onToolUpdate(agentId: string, data: any): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const existing = lastStreaming(conv.messages, 'tool');
    if (existing) existing.content += data.delta ?? '';
    const et = conv.streaming;
    if (et?.length && et[et.length - 1].final) {
      const tc = et[et.length - 1].final!.tool_calls?.find((x: any) => x.id === data.tool_call_id);
      if (tc) tc.result = (tc.result || '') + (data.delta ?? '');
    }
  }

  function onInterrupted(agentId: string): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    const msgs = conv.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'agent' && m.isStreaming) {
        m.isStreaming = false;
        if (!m.content?.trim()) m.content = '\u23F8\uFE0F (已被中断)';
      }
    }
    closeAllStreaming(conv);
    scheduleDone(conv);
  }

  function onChatEnd(agentId: string): void {
    const conv = getConv({ kind: 'agent', id: agentId });
    closeAllStreaming(conv);
    scheduleDone(conv);
  }

  // ── 历史/恢复 ──
  function onAgentListResponse(d: any): void {
    useAgentStore().setAgents(d.agents ?? []);
    const saved = useAgentStore().restoreLastAgent();
    const found = saved ? useAgentStore().agents.find(a => a.id === saved) : null;
    if (found && !activeRef.value) {
      selectConversation({ kind: 'agent', id: found.id });
      if (found.hasActiveSession) useWebSocketStore().send('chat.subscribe', { to: found.id });
    }
  }

  function onSessionResume(d: any): void {
    if (!d.active) return;
    resumeSnapshot = d;
    if (d.agentId && activeRef.value?.kind === 'agent' && activeRef.value.id === d.agentId) {
      const conv = getConv({ kind: 'agent', id: d.agentId });
      conv.turnInProgress = true;
      if (conv.turns.length > 0) mergeResumeSnapshot(d);
      else conv.loadingHistory = false;
    }
  }

  function mergeResumeSnapshot(d: any): void {
    resumeSnapshot = null;
    const ref: ConversationRef = { kind: 'agent', id: d.agentId };
    const conv = getConv(ref);
    conv.turnInProgress = true;
    conv.loadingHistory = false;

    const userMsgs = (d.userMessages && d.userMessages.length > 0)
      ? d.userMessages
      : (d.userMessage ? [{ content: d.userMessage, ts: d.userMessageTs || Date.now() }] : []);
    for (const um of userMsgs) {
      const userMsg: ChatMessage = { id: uid('user'), role: 'agent', content: um.content, timestamp: um.ts || Date.now(), agent_id: VIEWER_ID };
      conv.messages.push(userMsg);
      conv.turns.push({ agent_id: VIEWER_ID, steps: [], final: userMsg });
    }

    const steps: AgentMsg[] = (d.steps || []).map((s: any) => ({
      thinking: s.thinking || '',
      label: s.label || '',
      tool_calls: (s.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.name || '', arguments: tc.arguments || {}, result: tc.result || '', label: tc.label || tc.name || '' })),
      content: s.content || '',
      ts: s.ts || Date.now(),
    }));
    if (steps.length) {
      const turn = agentMsgsToSteps(steps, false, d.agentId);
      conv.turns = [...conv.turns, turn];
      for (const s of steps) {
        if (s.content || s.thinking || s.tool_calls?.length) {
          conv.messages.push({
            id: uid('asst'), role: 'agent', content: s.content || '',
            thinking: s.thinking, reasoning_content: s.thinking, label: s.label,
            toolCalls: s.tool_calls as any, timestamp: s.ts || Date.now(), agent_id: d.agentId,
          });
          for (const tc of s.tool_calls || []) {
            conv.messages.push({
              id: `tool-${tc.id}`, role: 'tool', content: tc.result || '',
              name: tc.name, toolName: tc.name, tool_call_id: tc.id,
              label: tc.label || tc.name || '', timestamp: s.ts || Date.now(),
            });
          }
        }
      }
    }

    const asst = newAssistant(d.agentId);
    asst.thinking = d.thinking || undefined;
    asst.reasoning_content = d.thinking || undefined;
    asst.content = d.content || '';
    asst.label = d.label || undefined;
    conv.messages.push(asst);
    setRuntime(conv, asst.id, { isStreaming: true });
    const final: AgentMsg = { agent_id: d.agentId, thinking: d.thinking || '', tool_calls: [], content: d.content || '', label: d.label || '', ts: Date.now() };
    if (d.phase === 'tool' && d.toolCallId) {
      final.tool_calls.push({ id: d.toolCallId, name: d.toolName || '', arguments: {}, result: '', label: d.label || d.toolName || '', running: true, startTime: Date.now() });
    }
    conv.streaming = [...conv.streaming, { agent_id: d.agentId, turns: [], final }];
    if (d.phase === 'tool' && d.toolCallId) {
      conv.messages.push({
        id: `tool-${d.toolCallId}`, role: 'tool', content: '',
        name: d.toolName, toolName: d.toolName,
        label: d.label || d.toolName, timestamp: Date.now(),
      });
    }
    logger.info(`[ChatStore] 已恢复 ${d.agentId} 的活跃会话（phase=${d.phase}, steps=${steps.length}）`);
  }

  function onHistory(data: any): void {
    const target = data.agentId || (activeRef.value?.kind === 'agent' ? activeRef.value.id : '');
    if (!target) { return; }
    const conv = getConv({ kind: 'agent', id: target });
    conv.loadingHistory = false;
    const msgs = (data.messages ?? []).map((m: any): ChatMessage => ({
      id: m.message_id ?? uid('hist'),
      role: m.role === 'tool' ? 'tool' : 'agent',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id,
      toolCalls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      timestamp: new Date(m.timestamp ?? Date.now()).getTime(),
    }));
    conv.hasMoreHistory = msgs.filter((m: any) => m.agent_id === VIEWER_ID).length >= HISTORY_PAGE_SIZE;
    const prevOffset = conv.historyOffset;
    const { merged: deduped, userCount } = mergeHistoryPage(msgs, conv.messages, prevOffset === 0);
    if (prevOffset > 0) conv.historyOffset = prevOffset - HISTORY_PAGE_SIZE + userCount;
    conv.messages = deduped;
    conv.turns = buildTurnsForHistory(target, conv.messages);
    if (prevOffset === 0 && resumeSnapshot && resumeSnapshot.agentId === target) {
      mergeResumeSnapshot(resumeSnapshot);
    }
  }

  function onSessionCompressed(d: any): void {
    compressFeedback.value = '已触发归档，Agent 正在整理记忆…';
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 5000);
  }

  function onSessionArchived(data: any): void {
    if (!data.success) {
      compressPending.value = false;
      compressFeedback.value = '❌ 归档失败';
      return;
    }
    const current = activeRef.value;
    if (current?.kind !== 'agent' || (data.agent !== current.id && data.counterpart !== current.id)) return;
    compressPending.value = false;
    compressFeedback.value = '✅ 记忆已整理，会话已归档';
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 4000);
    const conv = getConv(current);
    conv.messages = [];
    conv.turns = [];
    conv.hasMoreHistory = false;
    loadHistory(current);
  }

  function onVirtualReceive(d: any): void {
    const agentId = d?.agent;
    if (!agentId) return;
    const conv = getConv({ kind: 'agent', id: agentId });
    conv.messages.push({ id: uid('virt'), role: 'agent', content: d?.payload ?? '', agent_id: agentId, label: d?.label, timestamp: Date.now() });
    conv.turns.push({ agent_id: agentId, steps: [], final: conv.messages[conv.messages.length - 1]! });
    const active = activeRef.value;
    if (!(active?.kind === 'agent' && active.id === agentId)) {
      unreadAgents.value.add(agentId);
      useAgentStore().bumpAgentById(agentId, 'assistant', d?.payload ?? '');
    }
  }

  // ── WS 事件分发表 ──
  const HANDLERS: Record<string, (d: any) => void> = {
    'agent.list.response': onAgentListResponse,
    'agent.profile.updated': () => { useAgentStore().requestAgents(); },
    'chat.send.ack': (d: any) => {
      if (d?.busy) {
        const name = useAgentStore().agents.find((a: any) => a.agent_id === d.to)?.name || d.to || '对方';
        busyFeedback.value = `⏳ ${name} 正忙，您的消息已作为追加指令排队，稍后处理…`;
        if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
        busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 4000);
      }
    },
    'chat.start': (d: any) => {
      if (d.isTrigger === true && isForActiveAgent(d)) {
        if (d.hint && typeof d.hint === 'string' && d.hint.includes('[归档整理]')) archivePending.value = true;
        const ref = activeRef.value;
        if (ref?.kind === 'agent') {
          const conv = getConv(ref);
          const trigMsg: ChatMessage = { id: uid('trigger'), role: 'trigger', content: d.hint, agent_id: d.sender || 'system', timestamp: Date.now() };
          conv.messages.push(trigMsg);
          conv.turns.push({ agent_id: 'system', steps: [], final: trigMsg });
        }
      }
    },
    'chat.turn.start': (d: any) => { if (isForActiveAgent(d)) onTurnStart(eventAgentId(d)); },
    'chat.turn.end': (d: any) => { if (isForActiveAgent(d)) onTurnEnd(eventAgentId(d), d); },
    'chat.interrupted': (d: any) => { if (isForActiveAgent(d)) onInterrupted(eventAgentId(d)); },
    'chat.end': (d: any) => {
      if (isForActiveAgent(d)) {
        archivePending.value = false;
        lastRunEndAt.value = Date.now();
        onChatEnd(eventAgentId(d));
      }
    },
    'chat.interaction': (d: any) => { interaction.value = d; const ref = activeRef.value; if (ref?.kind === 'agent') markActive(getConv(ref)); },
    'chat.interact.respond': () => { /* 已关闭 */ },
    'chat.message.update': (d: any) => { if (!isForCurrentUser(d)) return; onMessageUpdate(eventAgentId(d), d); },
    'chat.message.end': (d: any) => { if (!isForCurrentUser(d)) return; onMessageEnd(eventAgentId(d), d); },
    'chat.message.error': (d: any) => { if (!isForCurrentUser(d)) return; onMessageError(eventAgentId(d), d); },
    'chat.thinking.start': (d: any) => { if (!isForCurrentUser(d)) return; onThinkingStart(eventAgentId(d), d); },
    'chat.thinking.update': (d: any) => { if (!isForCurrentUser(d)) return; onThinkingUpdate(eventAgentId(d), d); },
    'chat.thinking.end': (d: any) => { if (!isForCurrentUser(d)) return; onThinkingEnd(eventAgentId(d), d); },
    'chat.toolcall.start': (d: any) => { if (!isForCurrentUser(d)) return; onToolcallStart(eventAgentId(d), d); },
    'chat.toolcall.update': (d: any) => { if (!isForCurrentUser(d)) return; const ref = activeRef.value; if (ref?.kind === 'agent') markActive(getConv(ref)); },
    'chat.toolcall.end': (d: any) => { if (!isForCurrentUser(d)) return; const ref = activeRef.value; if (ref?.kind === 'agent') markActive(getConv(ref)); },
    'chat.tool_execution.start': (d: any) => { if (!isForCurrentUser(d)) return; onToolStart(eventAgentId(d), d); },
    'chat.tool_execution.update': (d: any) => { if (!isForCurrentUser(d)) return; onToolUpdate(eventAgentId(d), d); },
    'chat.tool_execution.end': (d: any) => { if (!isForCurrentUser(d)) return; onToolEnd(eventAgentId(d), d); },
    'chat.session.resume': onSessionResume,
    'history.response': onHistory,
    'session.compressed': onSessionCompressed,
    'session.archived': onSessionArchived,
    'system.restarting': (d: any) => {
      compressPending.value = false;
      compressFeedback.value = '后端正在重启，稍后自动重连…';
      if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
      compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 3000);
    },
    'chat.virtual.receive': onVirtualReceive,
    'agent.system_prompt.response': (d: any) => {
      systemPromptLoading.value = false;
      if (d.success) systemPromptContent.value = d.systemPrompt ?? '';
      else systemPromptError.value = d.error ?? '获取 System Prompt 失败';
    },
    'agent.tool_defs.response': (d: any) => {
      toolDefsLoading.value = false;
      if (d.success) toolDefs.value = d.toolDefs ?? [];
      else toolDefsError.value = d.error ?? '获取工具定义失败';
    },
    // 群组事件 → 统一更新 groups + 目标会话缓冲
    'group.created': () => { useGroupStore().fetchGroups(); },
    'group.deleted': (d: any) => {
      if (activeRef.value?.kind === 'group' && activeRef.value.id === d?.group_id) activeRef.value = null;
      useGroupStore().fetchGroups();
    },
    'group.join': () => { useGroupStore().fetchGroups(); },
    'group.leave': () => { useGroupStore().fetchGroups(); },
    'group.message': (d: any) => {
      const gid = d?.group_id;
      if (!gid) return;
      useGroupStore().bumpActivity(gid);
      const conv = getConv({ kind: 'group', id: gid });
      const msg: ChatMessage = { id: uid('msg'), role: 'agent', content: d.payload ?? d.content ?? '', agent_id: d.from, timestamp: Date.now() };
      conv.messages.push(msg);
      conv.turns = [...conv.turns, { agent_id: d.from || '', steps: [], final: msg }];
      conv.turnInProgress = false;
    },
  };

  // ── Init ──
  function init(): void {
    const ws = useWebSocketStore();
    ws.init();
    ws.onMessage((type, data) => HANDLERS[type]?.(data));
    ws.onConnect(() => { useAgentStore().requestAgents(); });
    watch(activeRef, (ref) => {
      if (ref?.kind === 'agent' && unreadAgents.value.delete(ref.id)) {
        // 已清除红点
      }
    });
  }

  return {
    conversations, activeRef, activeKey, turns, messages, unreadAgents,
    turnInProgress,
    archivePending, lastRunEndAt, compressPending, compressFeedback, busyFeedback, copyFeedback,
    interaction, respondInteraction, dismissInteraction,
    systemPromptLoading, systemPromptContent, systemPromptError,
    toolDefsLoading, toolDefs, toolDefsError,
    requestSystemPrompt, clearSystemPrompt, requestToolDefs, clearToolDefs,
    selectConversation, sendMessage, interruptGeneration, continueGeneration,
    regenerateMessage, deleteMessage, editMessage,
    loadMoreHistory, loadOlderGroupHistory, compressSession,
    sendGroupMessage, runtimeOf, init,
  };
});

/** 附件形状（文件上传返回） */
export interface FileAttachmentLike {
  hash: string;
  filename: string;
  filesize: number;
  text?: string;
}
