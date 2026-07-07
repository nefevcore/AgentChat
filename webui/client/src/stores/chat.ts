import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentInfo, ChatMessage, ToolCall } from '../types';
import { WebSocketClient } from '../services/websocket';

export const useChatStore = defineStore('chat', () => {
  // ---- State ----
  const agents = ref<AgentInfo[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const activeAgent = ref<string>('');
  const connected = ref(false);
  const loadingHistory = ref(false);
  /** 是否还有更多历史消息可加载 */
  const hasMoreHistory = ref(false);
  /** 当前已加载的历史消息偏移量（用于分页） */
  let historyOffset = 0;
  const HISTORY_PAGE_SIZE = 50;
  /** 当前是否有用户请求正在处理中（整个 ReAct 会话期间为 true） */
  const turnInProgress = ref(false);
  /** 延迟判定会话结束的定时器（response.done 后等待新 start 事件） */
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;
  const TURN_DONE_DELAY = 300;

  /** 标记一轮 start 事件到达（取消 pending done，确保 turnInProgress 为 true） */
  function markTurnActive() {
    if (pendingDoneTimer) {
      clearTimeout(pendingDoneTimer);
      pendingDoneTimer = null;
    }
    turnInProgress.value = true;
  }

  /** 计划判定会话结束：延迟后若仍无 streaming assistant，则 turnInProgress = false */
  function scheduleTurnDone() {
    if (pendingDoneTimer) clearTimeout(pendingDoneTimer);
    pendingDoneTimer = setTimeout(() => {
      pendingDoneTimer = null;
      if (!findLastStreamingAssistant()) {
        turnInProgress.value = false;
      }
    }, TURN_DONE_DELAY);
  }

  // ---- Getters ----
  const currentMessages = computed(() =>
    messages.value.filter(
      (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
    )
  );

  // ---- WebSocket setup ----
  let wsClient: WebSocketClient;

  function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;
    wsClient = new WebSocketClient(wsUrl);

    wsClient.onMessage((type, data) => {
      switch (type) {
        case 'agent.list.response':
          agents.value = (data.agents ?? []).sort(
            (a: AgentInfo, b: AgentInfo) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
          );
          break;

        case 'chat.response.start':
          handleResponseStart(data);
          break;

        case 'chat.response.chunk':
          handleChunk(data);
          break;

        case 'chat.response.done':
          handleResponseDone(data);
          break;

        case 'chat.tool.start':
          handleToolStart(data);
          break;

        case 'chat.tool.done':
          handleToolDone(data);
          break;

        case 'chat.interrupted':
          handleInterrupted(data);
          break;

        case 'chat.thinking.start':
          handleThinkingStart(data);
          break;

        case 'chat.thinking.chunk':
          handleThinkingChunk(data);
          break;

        case 'chat.thinking.done':
          handleThinkingDone(data);
          break;

        case 'history.response':
          handleHistory(data);
          break;
      }
    });

    wsClient.onConnect(() => {
      connected.value = true;
      // 重连后重新请求 Agent 列表
      requestAgents();
    });

    wsClient.onDisconnect(() => {
      connected.value = false;
    });

    wsClient.connect();
  }

  // ---- Actions ----

  /** 请求 Agent 列表 */
  function requestAgents() {
    wsClient.send('agent.list', {});
  }

  /** 发送聊天消息 */
  function sendMessage(
    content: string,
    to?: string,
    options?: { deepThink?: boolean; files?: import('../types').FileAttachment[] }
  ) {
    const target = to ?? activeAgent.value;
    if (!target || (!content.trim() && (!options?.files || options.files.length === 0))) return;

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      files: options?.files,
    };
    messages.value.push(userMsg);

    // 同步更新侧边栏 Agent 卡片的最后一条消息
    updateAgentLastMessageFromUser(content);

    turnInProgress.value = true;

    wsClient.send('chat.send', {
      to: target,
      content,
      deepThink: options?.deepThink ?? true,
      files: options?.files ?? [],
    });

    // 添加一个占位的 assistant 消息（流式填充）
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: Date.now(),
    };
    messages.value.push(assistantMsg);
  }

  /** 请求历史消息 */
  async function loadHistory(from: string, to: string) {
    loadingHistory.value = true;
    historyOffset = 0;
    hasMoreHistory.value = false;
    wsClient.send('history.request', { from, to, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }

  /** 加载更多历史消息（向上滚动触发） */
  async function loadMoreHistory() {
    if (!activeAgent.value || loadingHistory.value || !hasMoreHistory.value) return;
    loadingHistory.value = true;
    historyOffset += HISTORY_PAGE_SIZE;
    wsClient.send('history.request', {
      from: 'user',
      to: activeAgent.value,
      limit: HISTORY_PAGE_SIZE,
      offset: historyOffset,
    });
  }

  /** 重置历史分页状态 */
  function resetHistoryPagination() {
    historyOffset = 0;
    hasMoreHistory.value = false;
  }

  /** 切换活跃 Agent，并加载对话历史 */
  function selectAgent(agentId: string) {
    if (activeAgent.value === agentId) return;
    activeAgent.value = agentId;
    // 切换 Agent 时清空当前消息并加载历史
    messages.value = [];
    resetHistoryPagination();
    loadHistory('user', agentId);
  }

  // ---- 内部消息处理 ----

  function handleResponseStart(data: any) {
    markTurnActive();
    // 如果没有正在流式的 assistant 消息，创建新的（ReAct 多轮迭代）
    if (!findLastStreamingAssistant()) {
      const msg: ChatMessage = {
        id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: Date.now(),
      };
      messages.value.push(msg);
    }
  }

  function handleChunk(data: any) {
    // 找到最后一个 streaming 的 assistant 消息
    const last = findLastStreamingAssistant();
    if (last) {
      last.content += data.delta ?? '';
    }
  }

  function handleResponseDone(data: any) {
    const last = findLastStreamingAssistant();
    if (last) {
      last.content = data.content ?? last.content;
      last.thinking = data.reasoning ?? last.thinking;
      last.reasoning_content = data.reasoning ?? last.reasoning_content;
      last.toolCalls = data.tool_calls ?? undefined;
      last.isStreaming = false;

      // 同步更新侧边栏 Agent 卡片的最后一条消息
      updateAgentLastMessage(data.content ?? last.content);
    }
    scheduleTurnDone();
  }

  /** 更新 agents 列表中对应 Agent 的 lastMessage（assistant 回复）并重新排序 */
  function updateAgentLastMessage(content: string) {
    const agentId = activeAgent.value;
    if (!agentId || !content) return;

    const idx = agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;

    // 原地替换以保持响应式
    agents.value[idx] = {
      ...agents.value[idx],
      lastMessage: {
        role: 'assistant',
        content: content.slice(0, 80),
        timestamp: new Date().toISOString(),
      },
      lastActivity: Date.now(),
    };

    // 按最近活动时间重新排序
    agents.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  /** 更新 agents 列表中对应 Agent 的 lastMessage（用户消息）并重新排序 */
  function updateAgentLastMessageFromUser(content: string) {
    const agentId = activeAgent.value;
    if (!agentId || !content) return;

    const idx = agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;

    agents.value[idx] = {
      ...agents.value[idx],
      lastMessage: {
        role: 'user',
        content: content.slice(0, 80),
        timestamp: new Date().toISOString(),
      },
      lastActivity: Date.now(),
    };

    agents.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  function handleThinkingStart(data: any) {
    markTurnActive();
    if (!findLastStreamingAssistant()) {
      const msg: ChatMessage = {
        id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: Date.now(),
      };
      messages.value.push(msg);
    }
    // 设置思考标签
    const last = findLastStreamingAssistant();
    if (last && data.label) {
      last.label = data.label;
    }
  }

  function handleThinkingDone(data: any) {
    // 更新思考标签（含耗时）
    const last = findLastStreamingAssistant();
    if (last && data.label) {
      last.label = data.label;
    }
  }

  /** 处理中断事件：关闭上一轮流式消息（保留最新创建的 assistant 占位） */
  function handleInterrupted(_data: any) {
    // 收集所有流式 assistant 消息
    const streamingAssistants: { index: number; msg: ChatMessage }[] = [];
    for (let i = 0; i < messages.value.length; i++) {
      const m = messages.value[i];
      if (m.role === 'assistant' && m.isStreaming) {
        streamingAssistants.push({ index: i, msg: m });
      }
    }

    // 如果有多个流式 assistant，关闭除最后一个之外的所有
    if (streamingAssistants.length > 1) {
      for (let i = 0; i < streamingAssistants.length - 1; i++) {
        const item = streamingAssistants[i];
        item.msg.isStreaming = false;
        if (!item.msg.content || item.msg.content.trim() === '') {
          item.msg.content = '⏸️ (已被中断)';
        }
      }
    } else if (streamingAssistants.length === 1) {
      // 只有一个流式 assistant（无新消息发送时被显式中断）
      const item = streamingAssistants[0];
      item.msg.isStreaming = false;
      if (!item.msg.content || item.msg.content.trim() === '') {
        item.msg.content = '⏸️ (已被中断)';
      }
    }

    // 结束所有流式中的 tool 消息
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i];
      if (m.role === 'tool' && m.isStreaming) {
        m.isStreaming = false;
      }
    }
    scheduleTurnDone();
  }

  function handleToolStart(data: any) {
    markTurnActive();
    const toolMsg: ChatMessage = {
      id: `tool-start-${data.tool_call_id}`,
      role: 'tool',
      content: '',
      name: data.tool_name,
      toolName: data.tool_name,
      label: data.label || data.tool_name,
      isStreaming: true,
      timestamp: Date.now(),
    };
    messages.value.push(toolMsg);
  }

  function handleToolDone(data: any) {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i];
      if (m.role === 'tool' && m.toolName && m.isStreaming) {
        m.content = data.result ?? '';
        m.isStreaming = false;
        break;
      }
    }
  }

  function handleThinkingChunk(data: any) {
    const last = findLastStreamingAssistant();
    if (last) {
      last.thinking = (last.thinking ?? '') + (data.delta ?? '');
      last.reasoning_content = (last.reasoning_content ?? '') + (data.delta ?? '');
    }
  }

  function handleHistory(data: any) {
    loadingHistory.value = false;
    const historyMsgs = (data.messages ?? []).map((m: any) => ({
      id: m._meta?.message_id ?? `hist-${Date.now()}-${Math.random()}`,
      role: m.role as ChatMessage['role'],
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id,
      toolCalls: m.tool_calls,
      name: m.name,
      toolName: m.name,
      label: m.label,
      thinking: m.reasoning_content,
      reasoning_content: m.reasoning_content,
      timestamp: new Date(m._meta?.timestamp ?? Date.now()).getTime(),
    }));

    // 判断是否还有更多历史消息
    hasMoreHistory.value = historyMsgs.length >= HISTORY_PAGE_SIZE;

    if (historyOffset === 0) {
      // 首次加载：替换消息列表
      messages.value = historyMsgs;
    } else {
      // 加载更多：前置到消息列表顶部
      messages.value = [...historyMsgs, ...messages.value];
    }
  }

  function findLastStreamingAssistant(): ChatMessage | null {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'assistant' && messages.value[i].isStreaming) {
        return messages.value[i];
      }
    }
    return null;
  }

  // ---- Init ----
  initWebSocket();

  return {
    agents,
    messages,
    activeAgent,
    connected,
    loadingHistory,
    hasMoreHistory,
    turnInProgress,
    currentMessages,
    sendMessage,
    requestAgents,
    loadHistory,
    loadMoreHistory,
    selectAgent,
  };
});
