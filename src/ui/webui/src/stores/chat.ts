// ============================================================
// Chat Store —— 业务动作 + 非消息状态（委托统一信息流 feed store）
//
// 重构后职责划分：
//   - stores/feed.ts  ：消息数据（per-dialog rawMessages + 派生 turns）+ 流式 ingest
//   - stores/chat.ts  ：业务动作（发送/重生成/删除/编辑…）+ 交互/预览/压缩等非消息状态
//   - 视图层对外 API 保持不变（UI 组件零改动）
//
// 设计文档：docs/feed-architecture.md
// ============================================================

import { defineStore, storeToRefs } from 'pinia';
import { ref, computed } from 'vue';
import type { ChatMessage } from '../types';
import { useWebSocketStore } from './websocket';
import { useAgentStore } from './agents';
import { useFeedStore } from './feed';
import { logger } from '../utils/logger';
import { VIEWER_ID } from '../constants';
import { directDialog } from '../utils/feed';

// 兼容旧测试导入路径（tests/mergeHistoryPage.test.ts）
export { mergeHistoryPage } from '../utils/feed';

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

export const useChatStore = defineStore('chat', () => {
  const feed = useFeedStore();
  const ws = useWebSocketStore();

  const activeAgent = () => useAgentStore().activeAgentId;

  // ══ 视图状态（委托 feed，storeToRefs 保持响应式引用）══
  const {
    activeDialogId, unreadAgents, turnInProgress,
    loadingHistory, hasMoreHistory, lastRunEndAt, archivePending,
  } = storeToRefs(feed);

  const messages = computed(() => {
    const id = activeDialogId.value;
    return id ? feed.getRaw(id) : [];
  });
  const turns = computed(() => {
    const id = activeDialogId.value;
    return id ? feed.getTurns(id).value : [];
  });
  const currentMessages = computed(() =>
    messages.value.filter(m => m.role === 'agent' || m.role === 'tool')
  );

  // ══ 复制反馈 ══
  const copyFeedback = ref(false);

  // ══ 压缩 / 记忆整理反馈（非消息状态）══
  const compressPending = ref(false);
  const compressFeedback = ref('');
  let compressFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** 对方正忙提示（chat.send.ack busy=true 时显示，3s 自动消失） */
  const busyFeedback = ref('');
  let busyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  // ══ ask_questions 交互（决策工具）══
  const interactionState = ref<{
    interaction_id: string;
    agent_id: string;
    question: string;
    options: string[];
    allow_custom: boolean;
    timeout_ms: number;
  } | null>(null);
  const interaction = computed(() => interactionState.value);

  // ══ System Prompt 预览 ══
  const systemPromptLoading = ref(false);
  const systemPromptContent = ref('');
  const systemPromptError = ref('');

  // ══ 工具定义预览 ══
  const toolDefsLoading = ref(false);
  const toolDefs = ref<any[]>([]);
  const toolDefsError = ref('');

  // ── Actions ──

  function sendMessage(content: string, to?: string, options?: {
    deepThink?: boolean; files?: import('../types').FileAttachment[];
  }) {
    const target = to ?? activeAgent();
    if (!target || (!content.trim() && !options?.files?.length)) return;
    const userMsg: ChatMessage = {
      id: uid('user'), role: 'agent', content, timestamp: Date.now(),
      files: options?.files, agent_id: 'user',
    };
    feed.append(directDialog(target), userMsg);
    useAgentStore().bumpAgent(VIEWER_ID.value, content);
    turnInProgress.value = true;
    ws.send('chat.send', { to: target, content, deepThink: options?.deepThink ?? true, files: options?.files ?? [] });
  }

  /** 内部用：直接发送消息（不添加 user 气泡），用于重新推理 */
  function _sendRaw(target: string, content: string, deepThink: boolean, files: import('../types').FileAttachment[]) {
    turnInProgress.value = true;
    ws.send('chat.send', { to: target, content, deepThink, files });
  }

  /** 停止当前生成：中断 Agent 正在运行的 LLM/工具执行 */
  function interruptGeneration() {
    const target = activeAgent();
    if (!target) return;
    ws.send('chat.interrupt', { to: target });
  }

  /** 重新推理：仅删除当前 assistant 回复，保留前面的 user 消息，重新发送 */
  function regenerateMessage(msgId: string) {
    if (turnInProgress.value) return;
    const target = activeAgent();
    if (!target) return;
    const dialogId = directDialog(target);
    const msgs = feed.getRaw(dialogId);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const oldMsg = msgs[idx];

    // 找到前方最近的 user 消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].agent_id === 'user') { userIdx = i; break; }
    }
    if (userIdx === -1) return;
    const userMsg = msgs[userIdx];

    // 持久化删除旧的 assistant 和 user 消息
    for (const m of [oldMsg, userMsg]) {
      if (m.persistedMsgId && target) {
        ws.send('chat.delete_message', {
          agent: target,
          counterpart: VIEWER_ID.value,
          messageId: m.persistedMsgId,
        });
      }
    }

    // 删除旧的 user 和 assistant（含中间 tool）消息，补一条新的 user 气泡
    const newUserMsg: ChatMessage = {
      id: uid('user'),
      role: 'agent',
      content: userMsg.content,
      timestamp: Date.now(),
      files: userMsg.files,
      agent_id: VIEWER_ID.value,
    };
    feed.setRaw(dialogId, [
      ...msgs.slice(0, userIdx),
      ...msgs.slice(idx + 1),
      newUserMsg,
    ]);
    useAgentStore().bumpAgent(VIEWER_ID.value, userMsg.content);

    _sendRaw(target, userMsg.content, true, userMsg.files ?? []);
  }

  /** 删除消息：仅删除指定气泡（assistant/user），同时持久化 */
  function deleteMessage(msgId: string) {
    if (turnInProgress.value) return;
    const agentId = activeAgent();
    if (!agentId) return;
    const dialogId = directDialog(agentId);
    const msg = feed.getRaw(dialogId).find(m => m.id === msgId);
    if (!msg) return;

    // 持久化删除（如果有 persistedMsgId）
    if (msg.persistedMsgId && agentId) {
      ws.send('chat.delete_message', {
        agent: agentId,
        counterpart: VIEWER_ID.value,
        messageId: msg.persistedMsgId,
      });
    }
    feed.removeMessage(dialogId, msgId);
  }

  /** 修改用户消息：更新内容，删除该消息之后的所有后续消息，重新发送 */
  function editMessage(msgId: string, newContent: string) {
    if (turnInProgress.value) return;
    const target = activeAgent();
    if (!target) return;
    const dialogId = directDialog(target);
    const msgs = feed.getRaw(dialogId);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    // 收集需要持久化删除的消息（被编辑的消息本身 + 后续消息）
    const toDelete = msgs.slice(idx)
      .filter(m => m.persistedMsgId)
      .map(m => m.persistedMsgId!);
    for (const mid of toDelete) {
      ws.send('chat.delete_message', {
        agent: target,
        counterpart: VIEWER_ID.value,
        messageId: mid,
      });
    }

    feed.replaceMessage(dialogId, msgId, { content: newContent });
    feed.truncateAfter(dialogId, idx);

    _sendRaw(target, newContent, true, []);
  }

  function loadHistory(from: string, to: string) {
    feed.loadHistory(directDialog(to), from, to);
  }

  function loadMoreHistory() {
    const target = activeAgent();
    if (!target || loadingHistory.value || !hasMoreHistory.value) return;
    feed.loadMoreHistory(directDialog(target));
  }

  function compressSession() {
    const target = activeAgent();
    if (!target || compressPending.value) return;
    compressPending.value = true;
    compressFeedback.value = '正在归档整理记忆…';
    ws.send('session.compress', { agent: target, counterpart: VIEWER_ID.value });
  }

  /** 继续生成：触发 Agent 基于当前对话上下文自主推理，无需新用户消息 */
  function continueGeneration() {
    const target = activeAgent();
    if (!target || turnInProgress.value) return;
    turnInProgress.value = true;
    ws.send('chat.continue', { to: target });
  }

  // ── ask_questions 交互 ──
  function respondInteraction(choice: string) {
    const current = interactionState.value;
    if (!current) return;
    ws.send('chat.interact.respond', { interaction_id: current.interaction_id, choice });
    interactionState.value = null;
  }
  function dismissInteraction() {
    interactionState.value = null;
  }

  // ── System Prompt 预览 ──
  function requestSystemPrompt(agentId?: string) {
    const target = agentId ?? activeAgent();
    if (!target) return;
    systemPromptLoading.value = true;
    systemPromptContent.value = '';
    systemPromptError.value = '';
    ws.send('agent.system_prompt', { agentId: target });
  }
  function onSystemPromptResponse(data: any) {
    systemPromptLoading.value = false;
    if (data.success) systemPromptContent.value = data.systemPrompt ?? '';
    else systemPromptError.value = data.error ?? '获取 System Prompt 失败';
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
    ws.send('agent.tool_defs', { agentId: target });
  }
  function onToolDefsResponse(data: any) {
    toolDefsLoading.value = false;
    if (data.success) toolDefs.value = data.toolDefs ?? [];
    else toolDefsError.value = data.error ?? '获取工具定义失败';
  }
  function clearToolDefs() {
    toolDefs.value = [];
    toolDefsError.value = '';
  }

  // ── 非消息类事件处理 ──
  function onAgentListResponse(d: any) {
    useAgentStore().setAgents(d.agents ?? []);
    const restored = useAgentStore().tryRestoreLastAgent();
    if (restored) {
      feed.resetDialog(directDialog(restored));
      loadHistory(VIEWER_ID.value, restored);
      const agent = useAgentStore().agents.find(a => a.id === restored);
      if (agent?.hasActiveSession) {
        ws.send('chat.subscribe', { to: restored });
      }
    }
  }

  /** 归档触发回执（session.compressed）——异步流程已启动，等待归档完成 */
  function onSessionCompressed(d: any) {
    compressFeedback.value = '已触发归档，Agent 正在整理记忆…';
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 5000);
  }

  /** 归档完成（session.archived）——重置状态并重载会话 */
  function onSessionArchived(data: any) {
    if (!data.success) {
      logger.error('[ChatStore] 会话归档失败:', data.error);
      compressPending.value = false;
      compressFeedback.value = '❌ 归档失败';
      return;
    }
    logger.info('[ChatStore] 会话已归档:', data.agent, data.counterpart);
    const current = activeAgent();
    if (data.agent !== current && data.counterpart !== current) return;
    compressPending.value = false;
    compressFeedback.value = '✅ 记忆已整理，会话已归档';
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 4000);
    if (current) {
      feed.resetDialog(directDialog(current));
      loadHistory(VIEWER_ID.value, current);
    }
  }

  // ── WS 非消息类事件分发表 ──
  // 消息类事件（chat.message/thinking/toolcall/tool_execution/start/turn/end/history/virtual.receive）
  // 由 feed store 的 ingest() 统一处理（feed.init() 已注册）
  const HANDLERS: Record<string, (d: any) => void> = {
    'agent.list.response': onAgentListResponse,
    'agent.profile.updated': () => { useAgentStore().requestAgents(); },
    // 对方正忙提示：消息已作为追加指令注入（后端 activeSession 转向时推送）
    'chat.send.ack': (d: any) => {
      if (d?.busy) {
        const name = useAgentStore().agents.find((a: any) => a.agent_id === d.to)?.name || d.to || '对方';
        busyFeedback.value = `⏳ ${name} 正忙，您的消息已作为追加指令排队，稍后处理…`;
        if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
        busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 4000);
      }
    },
    // ask_questions 交互：Agent 请求用户决策 → 显示弹窗
    'chat.interaction': (d: any) => {
      interactionState.value = d;
      turnInProgress.value = true;
    },
    'chat.interact.respond': () => { /* 响应已发送，弹窗已由 respondInteraction 关闭 */ },
    'session.compressed': onSessionCompressed,
    'session.archived': onSessionArchived,
    // 后端重启中（Supervisor 模式自动拉起，WS 自动重连）
    'system.restarting': () => {
      compressPending.value = false;
      compressFeedback.value = '后端正在重启，稍后自动重连…';
      if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
      compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 3000);
    },
    'agent.system_prompt.response': onSystemPromptResponse,
    'agent.tool_defs.response': onToolDefsResponse,
  };

  // ── Init ──
  feed.init(); // 注册统一信息流 ingest（消息类事件）
  ws.init();
  ws.onMessage((type, data) => HANDLERS[type]?.(data));

  return {
    // 视图状态
    messages, turns, currentMessages,
    unreadAgents, turnInProgress, loadingHistory, hasMoreHistory, lastRunEndAt, archivePending,
    copyFeedback,
    // 压缩/反馈
    compressPending, compressFeedback, busyFeedback,
    // 交互
    interaction,
    // 预览
    systemPromptLoading, systemPromptContent, systemPromptError,
    toolDefsLoading, toolDefs, toolDefsError,
    // Actions
    sendMessage, interruptGeneration, regenerateMessage, deleteMessage, editMessage,
    loadHistory, loadMoreHistory, compressSession, continueGeneration,
    respondInteraction, dismissInteraction,
    requestSystemPrompt, clearSystemPrompt,
    requestToolDefs, clearToolDefs,
  };
});
