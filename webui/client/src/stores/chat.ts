import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentInfo, ChatMessage } from '../types';
import { WebSocketClient } from '../services/websocket';

const HISTORY_PAGE_SIZE = 50;
const TURN_DONE_DELAY = 300;

export const useChatStore = defineStore('chat', () => {
  // ── State ──
  const agents = ref<AgentInfo[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const activeAgent = ref('');
  const connected = ref(false);
  const loadingHistory = ref(false);
  const hasMoreHistory = ref(false);
  const turnInProgress = ref(false);

  let historyOffset = 0;
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;
  let wsClient: WebSocketClient;
  /** 上次选中的 Agent ID（用于刷新后自动恢复） */
  let lastActiveAgent = '';

  // ── Getters ──
  const currentMessages = computed(() =>
    messages.value.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
  );

  // ── 内部辅助 ──
  function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

  function newAssistant(): ChatMessage {
    return { id: uid('asst'), role: 'assistant', content: '', isStreaming: true, timestamp: Date.now() };
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

  function bumpAgent(role: 'user' | 'assistant', content: string) {
    const id = activeAgent.value;
    if (!id || !content) return;
    const idx = agents.value.findIndex(a => a.id === id);
    if (idx === -1) return;
    agents.value[idx] = {
      ...agents.value[idx],
      lastMessage: { role, content: content.slice(0, 80), timestamp: new Date().toISOString() },
      lastActivity: Date.now(),
    };
    agents.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  // ── WebSocket 分发 ──
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
  };

  /** 检查事件是否属于当前选中的 Agent */
  function isForActiveAgent(data: any): boolean {
    if (!activeAgent.value) return true; // 未选择 Agent 时接受所有事件
    const eventAgent = data?.agentId || data?.agent;
    if (!eventAgent) return true;        // 无 agentId 的事件（如全局事件）默认接受
    return eventAgent === activeAgent.value;
  }

  function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsClient = new WebSocketClient(`${protocol}//${location.host}/ws`);
    wsClient.onMessage((type, data) => HANDLERS[type]?.(data));
    wsClient.onConnect(() => {
      connected.value = true;
      requestAgents();
      // 恢复上次选中的 Agent
      const saved = localStorage.getItem('agentchat.lastAgent');
      if (saved && !activeAgent.value) {
        lastActiveAgent = saved;
      }
    });
    wsClient.onDisconnect(() => { connected.value = false; });
    wsClient.connect();
  }

  // ── Actions ──
  function requestAgents() { wsClient.send('agent.list', {}); }

  function sendMessage(content: string, to?: string, options?: {
    deepThink?: boolean; files?: import('../types').FileAttachment[];
  }) {
    const target = to ?? activeAgent.value;
    if (!target || (!content.trim() && !options?.files?.length)) return;
    messages.value.push({ id: uid('user'), role: 'user', content, timestamp: Date.now(), files: options?.files });
    bumpAgent('user', content);
    turnInProgress.value = true;
    wsClient.send('chat.send', { to: target, content, deepThink: options?.deepThink ?? true, files: options?.files ?? [] });
  }

  function loadHistory(from: string, to: string) {
    historyOffset = 0; hasMoreHistory.value = false; loadingHistory.value = true;
    wsClient.send('history.request', { from, to, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }

  function loadMoreHistory() {
    if (!activeAgent.value || loadingHistory.value || !hasMoreHistory.value) return;
    loadingHistory.value = true; historyOffset += HISTORY_PAGE_SIZE;
    wsClient.send('history.request', { from: 'user', to: activeAgent.value, limit: HISTORY_PAGE_SIZE, offset: historyOffset });
  }

  function selectAgent(agentId: string) {
    // Toggle: 点击已选中的 Agent 取消选择
    if (activeAgent.value === agentId) {
      activeAgent.value = '';
      localStorage.removeItem('agentchat.lastAgent');
      return;
    }
    activeAgent.value = agentId;
    localStorage.setItem('agentchat.lastAgent', agentId);
    messages.value = []; historyOffset = 0; hasMoreHistory.value = false;
    loadHistory('user', agentId);
    // 检查是否有活跃会话，尝试订阅
    const agent = agents.value.find(a => a.id === agentId);
    if (agent?.hasActiveSession) {
      wsClient.send('chat.subscribe', { to: agentId });
    }
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
    if (asst.content) bumpAgent('assistant', asst.content);
  }

  function onMessageError(data: any) {
    // 停止当前流式消息
    turnInProgress.value = false;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    messages.value.push({
      id: `error-${Date.now()}`, role: 'assistant', content: `[ERROR] ${errMsg}`,
      isError: true, isStreaming: false, timestamp: Date.now(),
    });
  }

  function onToolStart(data: any) {
    markActive();
    // 尝试匹配 toolcall.start 预创建的占位消息（通过 toolName 匹配最近的流式 tool）
    const existing = lastStreaming('tool');
    if (existing && existing.toolName === data.tool_name) {
      existing.id = `tool-${data.tool_call_id}`;
      existing.label = data.label || data.tool_name;
      existing.name = data.tool_name;
      existing.toolName = data.tool_name;
    } else {
      // 无预创建占位 → 兜底创建（非流式调用或 toolcall.start 未触发）
      messages.value.push({
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        label: data.label || data.tool_name, isStreaming: true, timestamp: Date.now(),
      });
    }
  }

  function onToolcallStart(data: any) {
    // 模型开始生成工具调用参数 → 提前创建消息块
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
    // 流式追加工具执行输出（如 bash 长命令的实时进度）
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

  /** Agent 列表响应 —— 自动恢复上次选中的 Agent，检测活跃会话 */
  function onAgentListResponse(d: any) {
    agents.value = (d.agents ?? [])
      .sort((a: AgentInfo, b: AgentInfo) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

    // 自动恢复上次选中的 Agent
    if (lastActiveAgent && !activeAgent.value) {
      const found = agents.value.find(a => a.id === lastActiveAgent);
      if (found) {
        selectAgent(lastActiveAgent);
      }
      lastActiveAgent = '';
    }
  }

  /** 会话恢复快照 —— 重连时重建流式 UI 状态 */
  function onSessionResume(d: any) {
    if (!d.active) return;
    if (d.agentId !== activeAgent.value) return;

    turnInProgress.value = true;
    loadingHistory.value = false; // 历史加载已完成（在 selectAgent 中触发）

    // 创建 assistant 占位消息（如果 snapshot 中有内容）
    const asst = newAssistant();
    asst.thinking = d.thinking || undefined;
    asst.reasoning_content = d.thinking || undefined;
    asst.content = d.content || '';
    asst.label = d.label || undefined;
    messages.value.push(asst);

    // 如果正在 tool 阶段，创建 tool 占位消息
    if (d.phase === 'tool' && d.toolCallId) {
      messages.value.push({
        id: `tool-${d.toolCallId}`,
        role: 'tool',
        content: '',
        name: d.toolName,
        toolName: d.toolName,
        label: d.label || d.toolName,
        isStreaming: true,
        timestamp: Date.now(),
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
      timestamp: new Date(m._meta?.timestamp ?? Date.now()).getTime(),
    }));
    hasMoreHistory.value = msgs.length >= HISTORY_PAGE_SIZE;
    messages.value = historyOffset === 0 ? msgs : [...msgs, ...messages.value];
  }

  // ── Init ──
  initWebSocket();

  return {
    agents, messages, activeAgent, connected,
    loadingHistory, hasMoreHistory, turnInProgress, currentMessages,
    sendMessage, requestAgents, loadHistory, loadMoreHistory, selectAgent,
  };
});
