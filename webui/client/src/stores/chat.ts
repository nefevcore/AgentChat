// ============================================================
// Chat Store —— 消息状态、流式输出、事件分发
//
// 依赖 useWebSocketStore（连接）和 useAgentStore（Agent 选择）
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { ChatMessage, Turn, TurnStep } from '../types';
import { useWebSocketStore } from './websocket';
import { useAgentStore } from './agents';
import { logger } from '../utils/logger';

const HISTORY_PAGE_SIZE = 5;
const TURN_DONE_DELAY = 300;

export const useChatStore = defineStore('chat', () => {
  // ── State ──
  /** Per-agent 消息缓冲：切换对话时不再丢失流式输出 */
  const _agentMessages = ref<Record<string, ChatMessage[]>>({});
  /** 有未读消息的 Agent ID 集合（虚拟 Agent 消息实时推送时标记） */
  const _unreadAgents = ref(new Set<string>(restoreUnread()));

  // ── 小红点持久化 ──
  const UNREAD_KEY = 'agentchat.unreadAgents';
  function persistUnread() {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([..._unreadAgents.value]));
  }
  function restoreUnread(): string[] {
    try { return JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]'); } catch { return []; }
  }
  const loadingHistory = ref(false);
  const hasMoreHistory = ref(false);
  const turnInProgress = ref(false);

  // ── System Prompt 预览 ──
  const systemPromptLoading = ref(false);
  const systemPromptContent = ref('');
  const systemPromptError = ref('');

  // ── 工具定义预览 ──
  const toolDefsLoading = ref(false);
  const toolDefs = ref<any[]>([]);
  const toolDefsError = ref('');

  // ── 复制反馈 ──
  const copyFeedback = ref(false);

  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;
  const _historyOffset: Record<string, number> = {};

  // ── Per-agent 消息缓冲辅助 ──
  function getMsgs(agentId: string): ChatMessage[] {
    if (!_agentMessages.value[agentId]) {
      _agentMessages.value[agentId] = [];
    }
    return _agentMessages.value[agentId]!;
  }
  function setMsgs(agentId: string, msgs: ChatMessage[]): void {
    _agentMessages.value[agentId] = msgs;
  }

  // ── Getters ──
  const messages = computed(() => getMsgs(activeAgent()));
  const currentMessages = computed(() =>
    messages.value.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
  );

  // ── Turns（位置驱动的思维链分组）──
  // 前提：tool 消息一定发生在 assistant 之后
  const turns = computed<Turn[]>(() => {
    const raw = messages.value;
    const allTurns: Turn[] = [];
    let cur: Turn | null = null;

    for (const msg of raw) {
      if (msg.role === 'user') {
        if (cur && cur.steps.length > 0) allTurns.push(cur);
        cur = null;
        continue;
      }

      if (msg.role === 'tool') {
        if (!cur) continue;
        const last = cur.steps[cur.steps.length - 1];
        if (last) last.tools.push(msg);
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.toolCalls?.length) {
          if (!cur) cur = { steps: [], final: null };
          cur.steps.push({ assistant: msg, tools: [], isStreaming: msg.isStreaming ?? false });
        } else if (cur) {
          // 最后回复：thinking 归入链的最后一个 step，正文独立显示
          const hasThink = (msg.reasoning_content || msg.thinking || '').trim();
          if (hasThink) {
            cur.steps.push({ assistant: { ...msg, content: '' }, tools: [], isStreaming: false });
            cur.final = { ...msg, reasoning_content: '', thinking: '' };
          } else {
            cur.final = msg;
          }
          allTurns.push(cur);
          cur = null;
        }
      }
    }

    if (cur && cur.steps.length > 0) allTurns.push(cur);
    return allTurns;
  });
  // ── 内部辅助 ──
  function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

  function newAssistant(agentId: string): ChatMessage {
    return { id: uid('asst'), role: 'assistant', content: '', isStreaming: true, timestamp: Date.now(), agent_id: agentId };
  }

  function lastStreaming(msgs: ChatMessage[], role?: 'assistant' | 'tool'): ChatMessage | null {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.isStreaming && (!role || m.role === role)) return m;
    }
    return null;
  }

  function markActive() {
    if (pendingDoneTimer) { clearTimeout(pendingDoneTimer); pendingDoneTimer = null; }
    turnInProgress.value = true;
  }

  function scheduleDone(msgs: ChatMessage[]) {
    if (pendingDoneTimer) clearTimeout(pendingDoneTimer);
    pendingDoneTimer = setTimeout(() => {
      pendingDoneTimer = null;
      if (!lastStreaming(msgs, 'assistant')) turnInProgress.value = false;
    }, TURN_DONE_DELAY);
  }

  function closeAllStreaming(msgs: ChatMessage[]) {
    for (const m of msgs) { if (m.isStreaming) m.isStreaming = false; }
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
    getMsgs(target).push({ id: uid('user'), role: 'user', content, timestamp: Date.now(), files: options?.files, agent_id: 'user' });
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
    const target = activeAgent();
    if (!target) return;
    const msgs = getMsgs(target);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const oldMsg = msgs[idx];

    // 找到前方最近的 user 消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const userMsg = msgs[userIdx];

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
    setMsgs(target, [
      ...msgs.slice(0, userIdx),
      ...msgs.slice(idx + 1),
    ]);

    // 补充一条新的 user 消息气泡
    const newUserMsg: ChatMessage = {
      id: uid('user'),
      role: 'user',
      content: userMsg.content,
      timestamp: Date.now(),
      files: userMsg.files,
      agent_id: 'user',
    };
    getMsgs(target).push(newUserMsg);
    useAgentStore().bumpAgent('user', userMsg.content);

    _sendRaw(target, userMsg.content, true, userMsg.files ?? []);
  }

  /** 删除消息：仅删除指定气泡（assistant/user），同时持久化 */
  function deleteMessage(msgId: string) {
    if (turnInProgress.value) return;
    const agentId = activeAgent();
    if (!agentId) return;
    const msgs = getMsgs(agentId);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const msg = msgs[idx];

    // 持久化删除（如果有 persistedMsgId）
    if (msg.persistedMsgId && agentId) {
      useWebSocketStore().send('chat.delete_message', {
        agent: agentId,
        counterpart: 'user',
        messageId: msg.persistedMsgId,
      });
    }

    setMsgs(agentId, [
      ...msgs.slice(0, idx),
      ...msgs.slice(idx + 1),
    ]);
  }

  /** 修改用户消息：更新内容，删除该消息之后的所有后续消息，重新发送 */
  function editMessage(msgId: string, newContent: string) {
    if (turnInProgress.value) return;
    const target = activeAgent();
    if (!target) return;
    const msgs = getMsgs(target);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    // 收集需要持久化删除的消息（被编辑的消息本身 + 后续消息）
    const toDelete = msgs.slice(idx)
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
    msgs[idx] = { ...msgs[idx], content: newContent };

    // 截断后续消息
    if (idx + 1 < msgs.length) {
      setMsgs(target, msgs.slice(0, idx + 1));
    }

    // 重新发送
    _sendRaw(target, newContent, true, []);
  }

  function loadHistory(from: string, to: string) {
    _historyOffset[to] = 0; hasMoreHistory.value = false; loadingHistory.value = true;
    useWebSocketStore().send('history.request', { from, to, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }

  function loadMoreHistory() {
    if (!activeAgent() || loadingHistory.value || !hasMoreHistory.value) return;
    const target = activeAgent();
    loadingHistory.value = true;
    _historyOffset[target] = (_historyOffset[target] || 0) + HISTORY_PAGE_SIZE;
    useWebSocketStore().send('history.request', { from: 'user', to: target, limit: HISTORY_PAGE_SIZE, offset: _historyOffset[target] });
  }

  function archiveSession() {
    const target = activeAgent();
    if (!target) return;
    useWebSocketStore().send('session.archive', { agent: target, counterpart: 'user' });
  }

  /** 继续生成：触发 Agent 基于当前对话上下文自主推理，无需新用户消息 */
  function continueGeneration() {
    const target = activeAgent();
    if (!target || turnInProgress.value) return;
    markActive();
    useWebSocketStore().send('chat.continue', { to: target });
  }

  // ── 事件处理器（按 turn 生命周期）──
  // 每个处理器接收 agentId 参数，确保流式输出写入正确的 Agent 缓冲
  function onTurnStart(agentId: string) { markActive(); getMsgs(agentId).push(newAssistant(agentId)); }

  function onTurnEnd(agentId: string, data: any) {
    const msgs = getMsgs(agentId);
    const asst = lastStreaming(msgs, 'assistant'); if (asst) asst.isStreaming = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'tool' && msgs[i].isStreaming) msgs[i].isStreaming = false;
    }
    if (data.interrupted) onInterrupted(agentId);
    scheduleDone(msgs);
  }

  function onThinkingStart(agentId: string, data: any) {
    markActive();
    const msgs = getMsgs(agentId);
    const asst = lastStreaming(msgs, 'assistant'); if (asst && data.label) asst.label = data.label;
  }

  function onThinkingUpdate(agentId: string, data: any) {
    const asst = lastStreaming(getMsgs(agentId), 'assistant');
    if (asst) { const d = data.delta ?? ''; asst.thinking = (asst.thinking ?? '') + d; asst.reasoning_content = (asst.reasoning_content ?? '') + d; }
  }

  function onThinkingEnd(agentId: string, data: any) {
    const asst = lastStreaming(getMsgs(agentId), 'assistant');
    if (asst) {
      if (data.label) asst.label = data.label;
      else asst.label = undefined;
    }
  }

  function onMessageUpdate(agentId: string, data: any) {
    const asst = lastStreaming(getMsgs(agentId), 'assistant'); if (asst) asst.content += data.delta ?? '';
  }

  function onMessageEnd(agentId: string, data: any) {
    const msgs = getMsgs(agentId);
    const asst = lastStreaming(msgs, 'assistant');
    if (!asst) return;
    asst.content = data.content ?? asst.content;
    asst.thinking = data.reasoning ?? asst.thinking;
    asst.reasoning_content = data.reasoning ?? asst.reasoning_content;
    asst.toolCalls = data.tool_calls;
    if (asst.content) useAgentStore().bumpAgent('assistant', asst.content);
  }

  function onMessageError(agentId: string, data: any) {
    turnInProgress.value = false;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    getMsgs(agentId).push({
      id: `error-${Date.now()}`, role: 'assistant', content: `[ERROR] ${errMsg}`,
      isError: true, isStreaming: false, timestamp: Date.now(),
    });
  }

  function onToolStart(agentId: string, data: any) {
    markActive();
    const msgs = getMsgs(agentId);
    const existing = lastStreaming(msgs, 'tool');
    if (existing && existing.toolName === data.tool_name) {
      existing.id = `tool-${data.tool_call_id}`;
      existing.label = data.label || data.tool_name;
      existing.name = data.tool_name;
      existing.toolName = data.tool_name;
      existing.tool_call_id = data.tool_call_id;
    } else {
      msgs.push({
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id,
        label: data.label || data.tool_name, isStreaming: true, timestamp: Date.now(),
      });
    }
  }

  function onToolcallStart(agentId: string, _data: any) {
    // toolcall 不再创建独立消息，由 onToolStart 统一管理（避免连续工具被拆成多段）
    markActive();
  }

  function onToolEnd(agentId: string, data: any) {
    const msgs = getMsgs(agentId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' && m.toolName && m.isStreaming) { m.content = data.result ?? ''; m.isStreaming = false; break; }
    }
  }

  function onToolUpdate(agentId: string, data: any) {
    const existing = lastStreaming(getMsgs(agentId), 'tool');
    if (existing) existing.content += data.delta ?? '';
  }

  function onInterrupted(agentId: string) {
    const msgs = getMsgs(agentId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.isStreaming) {
        m.isStreaming = false;
        if (!m.content?.trim()) m.content = '\u23F8\uFE0F (已被中断)';
      }
    }
    closeAllStreaming(msgs);
    scheduleDone(msgs);
  }

  function onChatEnd(agentId: string) { closeAllStreaming(getMsgs(agentId)); scheduleDone(getMsgs(agentId)); }

  function onAgentListResponse(d: any) {
    useAgentStore().setAgents(d.agents ?? []);
    const restored = useAgentStore().tryRestoreLastAgent();
    if (restored) {
      setMsgs(restored, []);
      hasMoreHistory.value = false;
      loadHistory('user', restored);
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

    const msgs = getMsgs(d.agentId);
    const asst = newAssistant(d.agentId);
    asst.thinking = d.thinking || undefined;
    asst.reasoning_content = d.thinking || undefined;
    asst.content = d.content || '';
    asst.label = d.label || undefined;
    msgs.push(asst);

    if (d.phase === 'tool' && d.toolCallId) {
      msgs.push({
        id: `tool-${d.toolCallId}`,
        role: 'tool', content: '',
        name: d.toolName, toolName: d.toolName,
        label: d.label || d.toolName,
        isStreaming: true, timestamp: Date.now(),
      });
    }

    logger.info(`[ChatStore] 已恢复 ${d.agentId} 的活跃会话（phase=${d.phase}, content=${d.content.length}chars）`);
  }

  function onHistory(data: any) {
    loadingHistory.value = false;
    // 使用响应中的 agentId（而非 activeAgent()），防止快速切换时写错缓冲区
    const target = data.agentId || activeAgent();
    const msgs = (data.messages ?? []).map((m: any): ChatMessage => ({
      id: m.message_id ?? uid('hist'),
      role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id, toolCalls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      timestamp: new Date(m.timestamp ?? Date.now()).getTime(),
    }));
    hasMoreHistory.value = msgs.filter((m: any) => m.role === 'user').length >= HISTORY_PAGE_SIZE;
    const offset = _historyOffset[target] || 0;
    setMsgs(target, offset === 0 ? msgs : [...msgs, ...getMsgs(target)]);
  }

  function onSessionArchived(data: any) {
    if (!data.success) {
      logger.error('[ChatStore] 会话归档失败:', data.error);
      return;
    }
    logger.info('[ChatStore] 会话已归档，清空消息并重新加载');
    if (activeAgent()) {
      setMsgs(activeAgent(), []);
    }
    hasMoreHistory.value = false;
    if (activeAgent()) {
      loadHistory('user', activeAgent()!);
    }
  }

  // ── WS 事件分发表 ──
  // 流式事件（chat.message/tool/thinking）提取 eventAgentId，始终写入正确 Agent 的缓冲
  // UI 事件（turn.start/end 等）保留 isForActiveAgent 防止全局指示器异常
  function eventAgentId(d: any): string { return d?.agentId || d?.agent || ''; }

  const HANDLERS: Record<string, (d: any) => void> = {
    'agent.list.response': onAgentListResponse,
    'agent.profile.updated': () => { useAgentStore().requestAgents(); },
    'chat.start':           d => {
      if (d.hint && typeof d.hint === 'string' && d.hint.startsWith('<trigger>')) {
        if (isForActiveAgent(d)) {
          getMsgs(activeAgent()).push({
            id: uid('trigger'),
            role: 'user',
            content: d.hint,
            agent_id: d.sender || 'system',
            timestamp: Date.now(),
          });
        }
      }
    },
    // UI 信号：仅活跃 Agent 更新全局指示器
    'chat.turn.start':      d => { if (isForActiveAgent(d)) onTurnStart(eventAgentId(d)); },
    'chat.turn.end':        d => { if (isForActiveAgent(d)) onTurnEnd(eventAgentId(d), d); },
    'chat.interrupted':     d => { if (isForActiveAgent(d)) onInterrupted(eventAgentId(d)); },
    'chat.end':             d => { if (isForActiveAgent(d)) onChatEnd(eventAgentId(d)); },
    // 流式内容：始终写入目标 Agent 缓冲，不受 isForActiveAgent 限制
    'chat.message.start':   () => {},
    'chat.message.update':  d => onMessageUpdate(eventAgentId(d), d),
    'chat.message.end':     d => onMessageEnd(eventAgentId(d), d),
    'chat.message.error':   d => { if (isForActiveAgent(d)) onMessageError(eventAgentId(d), d); },
    'chat.thinking.start':  d => onThinkingStart(eventAgentId(d), d),
    'chat.thinking.update': d => onThinkingUpdate(eventAgentId(d), d),
    'chat.thinking.end':    d => onThinkingEnd(eventAgentId(d), d),
    'chat.toolcall.start':  d => { if (isForActiveAgent(d)) onToolcallStart(eventAgentId(d), d); },
    'chat.toolcall.update': d => { if (isForActiveAgent(d)) markActive(); },
    'chat.toolcall.end':    d => { if (isForActiveAgent(d)) markActive(); },
    'chat.tool_execution.start':  d => onToolStart(eventAgentId(d), d),
    'chat.tool_execution.update': d => onToolUpdate(eventAgentId(d), d),
    'chat.tool_execution.end':    d => onToolEnd(eventAgentId(d), d),
    'chat.session.resume':  onSessionResume,
    'history.response':     onHistory,
    'session.archived':     onSessionArchived,
    // 虚拟 Agent 收到消息 → 实时推送到对应 Agent 对话中
    'chat.virtual.receive': d => {
      const agentId = d?.agent;
      if (!agentId) return;
      getMsgs(agentId).push({
        id: uid('virt'),
        role: 'assistant',
        content: d?.payload ?? '',
        agent_id: agentId,
        label: d?.label,
        timestamp: Date.now(),
      });
      // 非当前活跃 Agent → 标记小红点 + 置顶重排
      if (agentId !== activeAgent()) {
        _unreadAgents.value.add(agentId);
        persistUnread();
        useAgentStore().bumpAgentById(agentId, 'assistant', d?.payload ?? '');
      }
    },
    'agent.system_prompt.response': onSystemPromptResponse,
    'agent.tool_defs.response': onToolDefsResponse,
  };

  // ── System Prompt 预览 ──
  function requestSystemPrompt(agentId?: string) {
    const target = agentId ?? activeAgent();
    if (!target) return;
    systemPromptLoading.value = true;
    systemPromptContent.value = '';
    systemPromptError.value = '';
    useWebSocketStore().send('agent.system_prompt', { agentId: target });
  }

  function onSystemPromptResponse(data: any) {
    systemPromptLoading.value = false;
    if (data.success) {
      systemPromptContent.value = data.systemPrompt ?? '';
    } else {
      systemPromptError.value = data.error ?? '获取 System Prompt 失败';
    }
  }

  function clearSystemPrompt() {
    systemPromptContent.value = '';
    systemPromptError.value = '';
  }

  // ── 工具定义预览 ──
  function requestToolDefs(agentId?: string) {
    const target = agentId ?? activeAgent();
    if (!target) return;
    toolDefsLoading.value = true;
    toolDefs.value = [];
    toolDefsError.value = '';
    useWebSocketStore().send('agent.tool_defs', { agentId: target });
  }

  function onToolDefsResponse(data: any) {
    toolDefsLoading.value = false;
    if (data.success) {
      toolDefs.value = data.toolDefs ?? [];
    } else {
      toolDefsError.value = data.error ?? '获取工具定义失败';
    }
  }

  function clearToolDefs() {
    toolDefs.value = [];
    toolDefsError.value = '';
  }

  // ── Init ──
  const ws = useWebSocketStore();
  ws.init();
  ws.onMessage((type, data) => HANDLERS[type]?.(data));
  ws.onConnect(() => {
    useAgentStore().requestAgents();
  });

  // 切换 Agent 时自动清除未读标记
  watch(activeAgent, (newId) => {
    if (newId && _unreadAgents.value.delete(newId)) {
      persistUnread();
    }
  });

  return {
    messages, loadingHistory, hasMoreHistory, turnInProgress, currentMessages, turns,
    sendMessage, loadHistory, loadMoreHistory, archiveSession,
    regenerateMessage, deleteMessage, editMessage, continueGeneration,
    systemPromptLoading, systemPromptContent, systemPromptError,
    requestSystemPrompt, clearSystemPrompt,
    toolDefsLoading, toolDefs, toolDefsError,
    requestToolDefs, clearToolDefs,
    copyFeedback,
    /** 有未读消息的 Agent ID Set（供侧边栏小红点） */
    unreadAgents: computed(() => _unreadAgents.value),
    /** 清除指定 Agent 的未读标记 */
    clearUnread: (agentId: string) => { _unreadAgents.value.delete(agentId); },
  };
});
