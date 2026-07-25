// ============================================================
// Chat Store —— 消息状态、流式输出、事件分发
//
// 依赖 useWebSocketStore（连接）和 useAgentStore（Agent 选择）
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ChatMessage } from '../types';
import { useWebSocketStore } from './websocket';
import { useAgentStore } from './agents';

const HISTORY_PAGE_SIZE = 50;
const TURN_DONE_DELAY = 300;

export const useChatStore = defineStore('chat', () => {
  // ── State ──
  const messages = ref<ChatMessage[]>([]);
  const loadingHistory = ref(false);
  const hasMoreHistory = ref(false);
  const turnInProgress = ref(false);

  let historyOffset = 0;
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Getters ──
  const currentMessages = computed(() =>
    messages.value.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
  );

  // ── 内部辅助 ──
  function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

  function newAssistant(): ChatMessage {
    return { id: uid('asst'), role: 'assistant', content: '', isStreaming: true, timestamp: Date.now(), agent_id: activeAgent() };
  }

  function lastStreaming(role?: 'assistant' | 'tool'): ChatMessage | null {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i];
      if (m.isStreaming && (!role || m.role === role)) return m;
    }
    return null;
  }

  function markActive() {
    if (pendingDoneTimer) { clearTimeout(pendingDoneTimer); pendingDoneTimer = null; }
    turnInProgress.value = true;
  }

  function scheduleDone() {
    if (pendingDoneTimer) clearTimeout(pendingDoneTimer);
    pendingDoneTimer = setTimeout(() => {
      pendingDoneTimer = null;
      if (!lastStreaming('assistant')) turnInProgress.value = false;
    }, TURN_DONE_DELAY);
  }

  function closeAllStreaming() {
    for (const m of messages.value) { if (m.isStreaming) m.isStreaming = false; }
  }

  // ── Agent 事件委托 ──
  function activeAgent() { return useAgentStore().activeAgentId; }

  function isForActiveAgent(data: any): boolean {
    if (!activeAgent()) return true;
    const eventAgent = data?.agentId || data?.agent;
    if (!eventAgent) return true;
    return eventAgent === activeAgent();
  }

  // ── Actions ──

  function sendMessage(content: string, to?: string, options?: {
    deepThink?: boolean; files?: import('../types').FileAttachment[];
  }) {
    const target = to ?? activeAgent();
    if (!target || (!content.trim() && !options?.files?.length)) return;
    messages.value.push({ id: uid('user'), role: 'user', content, timestamp: Date.now(), files: options?.files, agent_id: 'user' });
    useAgentStore().bumpAgent('user', content);
    markActive();
    useWebSocketStore().send('chat.send', { to: target, content, deepThink: options?.deepThink ?? true, files: options?.files ?? [] });
  }

  /** 内部用：直接发送消息（不添加 user 气泡），用于重新推理 */
  function _sendRaw(target: string, content: string, deepThink: boolean, files: import('../types').FileAttachment[]) {
    markActive();
    useWebSocketStore().send('chat.send', { to: target, content, deepThink, files });
  }

  /** 重新推理：仅删除当前 assistant 回复，保留前面的 user 消息，重新发送 */
  function regenerateMessage(msgId: string) {
    if (turnInProgress.value) return;

    const idx = messages.value.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const oldMsg = messages.value[idx];

    // 找到前方最近的 user 消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages.value[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const userMsg = messages.value[userIdx];
    const target = activeAgent();
    if (!target) return;

    // 持久化删除旧的 assistant 和 user 消息
    for (const m of [oldMsg, userMsg]) {
      if (m.persistedMsgId && target) {
        useWebSocketStore().send('chat.delete_message', {
          agent: target,
          counterpart: 'user',
          messageId: m.persistedMsgId,
        });
      }
    }

    // 删除旧的 user 和 assistant（含中间 tool）消息
    messages.value = [
      ...messages.value.slice(0, userIdx),
      ...messages.value.slice(idx + 1),
    ];

    // 补充一条新的 user 消息气泡
    const newUserMsg: ChatMessage = {
      id: uid('user'),
      role: 'user',
      content: userMsg.content,
      timestamp: Date.now(),
      files: userMsg.files,
      agent_id: 'user',
    };
    messages.value = [...messages.value, newUserMsg];
    useAgentStore().bumpAgent('user', userMsg.content);

    _sendRaw(target, userMsg.content, true, userMsg.files ?? []);
  }

  /** 删除消息：仅删除指定气泡（assistant/user），同时持久化 */
  function deleteMessage(msgId: string) {
    if (turnInProgress.value) return;

    const idx = messages.value.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const msg = messages.value[idx];
    const agentId = activeAgent();

    // 持久化删除（如果有 persistedMsgId）
    if (msg.persistedMsgId && agentId) {
      useWebSocketStore().send('chat.delete_message', {
        agent: agentId,
        counterpart: 'user',
        messageId: msg.persistedMsgId,
      });
    }

    messages.value = [
      ...messages.value.slice(0, idx),
      ...messages.value.slice(idx + 1),
    ];
  }

  /** 修改用户消息：更新内容，删除该消息之后的所有后续消息，重新发送 */
  function editMessage(msgId: string, newContent: string) {
    if (turnInProgress.value) return;

    const idx = messages.value.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const target = activeAgent();
    if (!target) return;

    // 收集被截断消息中需要持久化删除的（有 persistedMsgId 的）
    const toDelete = messages.value.slice(idx + 1)
      .filter(m => m.persistedMsgId)
      .map(m => m.persistedMsgId!);

    // 发送 WS 删除请求
    for (const msgId of toDelete) {
      useWebSocketStore().send('chat.delete_message', {
        agent: target,
        counterpart: 'user',
        messageId: msgId,
      });
    }

    // 更新当前消息内容
    messages.value[idx] = { ...messages.value[idx], content: newContent };

    // 截断后续消息
    if (idx + 1 < messages.value.length) {
      messages.value = messages.value.slice(0, idx + 1);
    }

    // 重新发送
    _sendRaw(target, newContent, true, []);
  }

  function loadHistory(from: string, to: string) {
    historyOffset = 0; hasMoreHistory.value = false; loadingHistory.value = true;
    useWebSocketStore().send('history.request', { from, to, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }

  function loadMoreHistory() {
    if (!activeAgent() || loadingHistory.value || !hasMoreHistory.value) return;
    loadingHistory.value = true; historyOffset += HISTORY_PAGE_SIZE;
    useWebSocketStore().send('history.request', { from: 'user', to: activeAgent(), limit: HISTORY_PAGE_SIZE, offset: historyOffset });
  }

  function archiveSession() {
    const target = activeAgent();
    if (!target) return;
    useWebSocketStore().send('session.archive', { agent: target, counterpart: 'user' });
  }

  // ── 事件处理器（按 turn 生命周期） ──
  function onTurnStart() { markActive(); messages.value.push(newAssistant()); }

  function onTurnEnd(data: any) {
    const asst = lastStreaming('assistant'); if (asst) asst.isStreaming = false;
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'tool' && messages.value[i].isStreaming) messages.value[i].isStreaming = false;
    }
    if (data.interrupted) onInterrupted();
    scheduleDone();
  }

  function onThinkingStart(data: any) {
    markActive();
    const asst = lastStreaming('assistant'); if (asst && data.label) asst.label = data.label;
  }

  function onThinkingUpdate(data: any) {
    const asst = lastStreaming('assistant');
    if (asst) { const d = data.delta ?? ''; asst.thinking = (asst.thinking ?? '') + d; asst.reasoning_content = (asst.reasoning_content ?? '') + d; }
  }

  function onThinkingEnd(data: any) {
    const asst = lastStreaming('assistant');
    if (asst) {
      if (data.label) asst.label = data.label;
      else asst.label = undefined;
    }
  }

  function onMessageUpdate(data: any) {
    const asst = lastStreaming('assistant'); if (asst) asst.content += data.delta ?? '';
  }

  function onMessageEnd(data: any) {
    const asst = lastStreaming('assistant');
    if (!asst) return;
    asst.content = data.content ?? asst.content;
    asst.thinking = data.reasoning ?? asst.thinking;
    asst.reasoning_content = data.reasoning ?? asst.reasoning_content;
    asst.toolCalls = data.tool_calls;
    if (asst.content) useAgentStore().bumpAgent('assistant', asst.content);
  }

  function onMessageError(data: any) {
    turnInProgress.value = false;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    messages.value.push({
      id: `error-${Date.now()}`, role: 'assistant', content: `[ERROR] ${errMsg}`,
      isError: true, isStreaming: false, timestamp: Date.now(),
    });
  }

  function onToolStart(data: any) {
    markActive();
    const existing = lastStreaming('tool');
    if (existing && existing.toolName === data.tool_name) {
      existing.id = `tool-${data.tool_call_id}`;
      existing.label = data.label || data.tool_name;
      existing.name = data.tool_name;
      existing.toolName = data.tool_name;
    } else {
      messages.value.push({
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        label: data.label || data.tool_name, isStreaming: true, timestamp: Date.now(),
      });
    }
  }

  function onToolcallStart(data: any) {
    markActive();
    messages.value.push({
      id: `toolcall-${data.index ?? Date.now()}`,
      role: 'tool', content: '',
      name: data.name, toolName: data.name,
      label: data.name ? `正在准备调用: ${data.name}` : '正在准备工具调用...',
      isStreaming: true, timestamp: Date.now(),
    });
  }

  function onToolEnd(data: any) {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i];
      if (m.role === 'tool' && m.toolName && m.isStreaming) { m.content = data.result ?? ''; m.isStreaming = false; break; }
    }
  }

  function onToolUpdate(data: any) {
    const existing = lastStreaming('tool');
    if (existing) existing.content += data.delta ?? '';
  }

  function onInterrupted() {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i];
      if (m.role === 'assistant' && m.isStreaming) {
        m.isStreaming = false;
        if (!m.content?.trim()) m.content = '\u23F8\uFE0F (已被中断)';
      }
    }
    closeAllStreaming();
    scheduleDone();
  }

  function onChatEnd() { closeAllStreaming(); scheduleDone(); }

  function onAgentListResponse(d: any) {
    useAgentStore().setAgents(d.agents ?? []);
    const restored = useAgentStore().tryRestoreLastAgent();
    // 自动恢复选中 Agent 时需加载历史消息
    if (restored) {
      messages.value = [];
      historyOffset = 0;
      hasMoreHistory.value = false;
      loadHistory('user', restored);
      // 检查活跃会话
      const agent = useAgentStore().agents.find(a => a.id === restored);
      if (agent?.hasActiveSession) {
        useWebSocketStore().send('chat.subscribe', { to: restored });
      }
    }
  }

  function onSessionResume(d: any) {
    if (!d.active) return;
    if (d.agentId !== activeAgent()) return;

    turnInProgress.value = true;
    loadingHistory.value = false;

    const asst = newAssistant();
    asst.thinking = d.thinking || undefined;
    asst.reasoning_content = d.thinking || undefined;
    asst.content = d.content || '';
    asst.label = d.label || undefined;
    messages.value.push(asst);

    if (d.phase === 'tool' && d.toolCallId) {
      messages.value.push({
        id: `tool-${d.toolCallId}`,
        role: 'tool', content: '',
        name: d.toolName, toolName: d.toolName,
        label: d.label || d.toolName,
        isStreaming: true, timestamp: Date.now(),
      });
    }

    console.log(`[ChatStore] 已恢复 ${d.agentId} 的活跃会话（phase=${d.phase}, content=${d.content.length}chars）`);
  }

  function onHistory(data: any) {
    loadingHistory.value = false;
    const msgs = (data.messages ?? []).map((m: any): ChatMessage => ({
      id: m._meta?.message_id ?? uid('hist'),
      role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id, toolCalls: m.tool_calls, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      timestamp: new Date(m._meta?.timestamp ?? Date.now()).getTime(),
    }));
    hasMoreHistory.value = msgs.length >= HISTORY_PAGE_SIZE;
    messages.value = historyOffset === 0 ? msgs : [...msgs, ...messages.value];
  }

  function onSessionArchived(data: any) {
    if (!data.success) {
      console.error('[ChatStore] 会话归档失败:', data.error);
      return;
    }
    console.log('[ChatStore] 会话已归档，清空消息并重新加载');
    messages.value = [];
    historyOffset = 0;
    hasMoreHistory.value = false;
    if (activeAgent()) {
      loadHistory('user', activeAgent()!);
    }
  }

  // ── WS 事件分发表 ──
  const HANDLERS: Record<string, (d: any) => void> = {
    'agent.list.response': onAgentListResponse,
    'chat.start':           () => {},
    'chat.turn.start':      d => { if (isForActiveAgent(d)) onTurnStart(); },
    'chat.turn.end':        d => { if (isForActiveAgent(d)) onTurnEnd(d); },
    'chat.interrupted':     d => { if (isForActiveAgent(d)) onInterrupted(); },
    'chat.message.start':   () => {},
    'chat.message.update':  d => { if (isForActiveAgent(d)) onMessageUpdate(d); },
    'chat.message.end':     d => { if (isForActiveAgent(d)) onMessageEnd(d); },
    'chat.message.error':   d => { if (isForActiveAgent(d)) onMessageError(d); },
    'chat.thinking.start':  d => { if (isForActiveAgent(d)) onThinkingStart(d); },
    'chat.thinking.update': d => { if (isForActiveAgent(d)) onThinkingUpdate(d); },
    'chat.thinking.end':    d => { if (isForActiveAgent(d)) onThinkingEnd(d); },
    'chat.toolcall.start':  d => { if (isForActiveAgent(d)) onToolcallStart(d); },
    'chat.toolcall.update': d => { if (isForActiveAgent(d)) markActive(); },
    'chat.toolcall.end':    d => { if (isForActiveAgent(d)) markActive(); },
    'chat.tool_execution.start':  d => { if (isForActiveAgent(d)) onToolStart(d); },
    'chat.tool_execution.update': d => { if (isForActiveAgent(d)) onToolUpdate(d); },
    'chat.tool_execution.end':    d => { if (isForActiveAgent(d)) onToolEnd(d); },
    'chat.end':             d => { if (isForActiveAgent(d)) onChatEnd(); },
    'chat.session.resume':  onSessionResume,
    'history.response':     onHistory,
    'session.archived':     onSessionArchived,
  };

  // ── Init ──
  const ws = useWebSocketStore();
  ws.init();
  ws.onMessage((type, data) => HANDLERS[type]?.(data));
  ws.onConnect(() => {
    useAgentStore().requestAgents();
  });

  return {
    messages, loadingHistory, hasMoreHistory, turnInProgress, currentMessages,
    sendMessage, loadHistory, loadMoreHistory, archiveSession,
    regenerateMessage, deleteMessage, editMessage,
  };
});
