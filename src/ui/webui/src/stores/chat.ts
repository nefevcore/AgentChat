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
import { WS_SEND, WS_EVENT } from '../core/events/contract';
import { registerEventHandler } from '../core/registry/eventHandlers';
import { directDialog, singleDialog, type DialogId } from '../utils/feed';

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/**
 * 会话上下文（ChatContext 抽象，P3）：
 *   pair = 用户↔Agent 一对一（现状唯一形态，行为零变化）
 *   single = 独立会话（sessionId 决定历史/投递维度；agentId 仍是消息路由目标）
 * 动作层统一经 resolveContext() 取上下文：WS 载荷带 session、feed 分区用
 * single dialog、pair 场景完全保持原路径。
 */
export interface ChatContext {
  kind: 'pair' | 'single';
  /** 消息路由目标 Agent（single 场景 = session.json 的 agentId） */
  agentId: string;
  /** 独立会话 id（仅 single） */
  sessionId?: string;
}

export const useChatStore = defineStore('chat', () => {
  const feed = useFeedStore();
  const ws = useWebSocketStore();

  const activeAgent = () => useAgentStore().activeAgentId;

  /** 当前会话上下文：显式 single 激活优先；否则当前 Agent（pair，现状语义） */
  function resolveContext(): ChatContext | null {
    if (feed.activeSingleId) {
      // single：agentId 由调用方在激活时经 setSingleContext 声明（feed 只存 sessionId）
      const meta = singleMeta.get(feed.activeSingleId);
      if (meta) return { kind: 'single', agentId: meta.agentId, sessionId: feed.activeSingleId };
    }
    const agentId = activeAgent();
    return agentId ? { kind: 'pair', agentId } : null;
  }

  /** single 会话元信息（agentId 等；激活时登记） */
  const singleMeta = new Map<string, { agentId: string }>();

  /** 激活独立会话上下文（页面路由用；agentId 来自 session 元数据，feed 据此登记消息身份） */
  function setSingleContext(sessionId: string, agentId: string) {
    singleMeta.set(sessionId, { agentId });
    feed.setActiveSingle(sessionId, agentId);
    // 刷新/切换恢复：订阅该会话的活跃快照（带 session 精确匹配——同一 Agent
    // 多个 single 会话并存时按 agentId 匹配会拿到别的会话的快照，恢复即串台；
    // 运行中 → chat.session.resume 恢复未落盘的当前轮；空闲时后端回 active:false，
    // 前端忽略，无副作用）
    if (agentId) ws.send(WS_SEND.chatSubscribe, { to: agentId, session: sessionId });
  }
  /** 退出独立会话上下文（回到 pair） */
  function clearSingleContext() {
    feed.clearActiveSingle();
  }

  /** ctx → feed 分区键（pair = direct dialog；single = single dialog） */
  function ctxDialog(ctx: ChatContext): DialogId {
    return ctx.kind === 'single' && ctx.sessionId
      ? singleDialog(ctx.sessionId)
      : directDialog(ctx.agentId);
  }
  /** ctx → WS 载荷的 session 维度（pair 无） */
  function ctxSession(ctx: ChatContext): Record<string, unknown> {
    return ctx.kind === 'single' && ctx.sessionId ? { session: ctx.sessionId } : {};
  }

  // ══ 视图状态（委托 feed，storeToRefs 保持响应式引用）══
  const {
    activeDialogId, unreadAgents, turnInProgress,
    loadingHistory, hasMoreHistory, lastRunEndAt, archivePending,
  } = storeToRefs(feed);

  const messages = computed(() => {
    const id = activeDialogId.value;
    return id ? feed.getRaw(id) : [];
  });
  /** 当前会话上下文是否生成中（per-dialog 流式态）。全局 turnInProgress 会被
   *  任何会话的运行点亮——用它驱动输入框会让别的会话流式时当前会话误显
   *  「打断并发送」，且发送前的自动打断会误杀其他会话的运行（隔离缺陷）。 */
  const contextBusy = computed(() => {
    const id = feed.activeDialogId;
    const d = id ? feed.getDialog(id) : null;
    return d ? d.streaming : turnInProgress.value;
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
    deepThink?: boolean; reasoningEffort?: 'low' | 'high' | 'max'; files?: import('../types').FileAttachment[];
  }) {
    const ctx = resolveContext();
    const target = to ?? ctx?.agentId;
    if (!target || (!content.trim() && !options?.files?.length)) return;
    const dialogId = to || !ctx ? directDialog(target) : ctxDialog(ctx);
    const userMsg: ChatMessage = {
      id: uid('user'), role: 'agent', content, timestamp: Date.now(),
      files: options?.files, agent_id: 'user',
    };
    feed.append(dialogId, userMsg);
    // 发送即置当前分区流式态（chat.step.start 到达前 contextBusy 已生效；
    // stepEnd/interrupted/chatEnd 会正常回落，避免残留）
    feed.ensureById(dialogId).streaming = true;
    if (!to && ctx?.kind !== 'single') useAgentStore().bumpAgent(VIEWER_ID.value, content);
    turnInProgress.value = true;
    ws.send(WS_SEND.chatSend, {
      to: target,
      content,
      deepThink: options?.deepThink ?? true,
      ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      files: options?.files ?? [],
      requestId: uid('send'),
      ...(to || !ctx ? {} : ctxSession(ctx)),
    });
  }

  /** 内部用：直接发送消息（不添加 user 气泡），用于重新推理 */
  function _sendRaw(ctx: ChatContext, content: string, deepThink: boolean, files: import('../types').FileAttachment[]) {
    turnInProgress.value = true;
    ws.send(WS_SEND.chatSend, {
      to: ctx.agentId, content, deepThink, files,
      requestId: uid('send'), ...ctxSession(ctx),
    });
  }

  /** 停止当前生成：中断 Agent 正在运行的 LLM/工具执行。
   *  single 上下文带 session（后端会话级精确中断，不牵连同 Agent 的其他会话） */
  function interruptGeneration() {
    const ctx = resolveContext();
    if (!ctx) return;
    ws.send(WS_SEND.chatInterrupt, { to: ctx.agentId, ...ctxSession(ctx) });
  }

  /** 重新推理：仅删除当前 assistant 回复，保留前面的 user 消息，重新发送 */
  function regenerateMessage(msgId: string) {
    if (turnInProgress.value) return;
    const ctx = resolveContext();
    if (!ctx) return;
    const target = ctx.agentId;
    const dialogId = ctxDialog(ctx);
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
      if (m.persistedMsgId && ctx.kind === 'pair') {
        ws.send(WS_SEND.chatDeleteMessage, {
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
    if (ctx.kind !== 'single') useAgentStore().bumpAgent(VIEWER_ID.value, userMsg.content);

    _sendRaw(ctx, userMsg.content, true, userMsg.files ?? []);
  }

  /** 删除消息：仅删除指定气泡（assistant/user），同时持久化 */
  function deleteMessage(msgId: string) {
    if (turnInProgress.value) return;
    const ctx = resolveContext();
    if (!ctx) return;
    const dialogId = ctxDialog(ctx);
    const msg = feed.getRaw(dialogId).find(m => m.id === msgId);
    if (!msg) return;

    // 持久化删除（如果有 persistedMsgId；single v1 不支持消息级删除）
    if (msg.persistedMsgId && ctx.kind === 'pair') {
      ws.send(WS_SEND.chatDeleteMessage, {
        agent: ctx.agentId,
        counterpart: VIEWER_ID.value,
        messageId: msg.persistedMsgId,
      });
    }
    feed.removeMessage(dialogId, msgId);
  }

  /** 修改用户消息：更新内容，删除该消息之后的所有后续消息，重新发送 */
  function editMessage(msgId: string, newContent: string) {
    if (turnInProgress.value) return;
    const ctx = resolveContext();
    if (!ctx) return;
    const dialogId = ctxDialog(ctx);
    const msgs = feed.getRaw(dialogId);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    // 收集需要持久化删除的消息（被编辑的消息本身 + 后续消息）
    if (ctx.kind === 'pair') {
      const toDelete = msgs.slice(idx)
        .filter(m => m.persistedMsgId)
        .map(m => m.persistedMsgId!);
      for (const mid of toDelete) {
        ws.send(WS_SEND.chatDeleteMessage, {
          agent: ctx.agentId,
          counterpart: VIEWER_ID.value,
          messageId: mid,
        });
      }
    }

    feed.replaceMessage(dialogId, msgId, { content: newContent });
    feed.truncateAfter(dialogId, idx);

    _sendRaw(ctx, newContent, true, []);
  }

  function loadHistory(from: string, to: string, session?: string) {
    if (session) feed.loadHistory(singleDialog(session), from, to, session);
    else feed.loadHistory(directDialog(to), from, to);
  }

  function loadMoreHistory() {
    const dialogId = feed.activeDialogId;
    if (!dialogId || loadingHistory.value || !hasMoreHistory.value) return;
    feed.loadMoreHistory(dialogId);
  }

  function compressSession() {
    const ctx = resolveContext();
    if (!ctx || ctx.kind !== 'pair' || compressPending.value) return;
    compressPending.value = true;
    compressFeedback.value = '正在归档整理记忆…';
    ws.send(WS_SEND.sessionCompress, { agent: ctx.agentId, counterpart: VIEWER_ID.value });
  }

  /** 继续生成：触发 Agent 基于当前对话上下文自主推理，无需新用户消息 */
  function continueGeneration() {
    const ctx = resolveContext();
    if (!ctx || turnInProgress.value) return;
    turnInProgress.value = true;
    ws.send(WS_SEND.chatContinue, { to: ctx.agentId, ...ctxSession(ctx) });
  }

  // ── ask_questions 交互 ──
  function respondInteraction(choice: string) {
    const current = interactionState.value;
    if (!current) return;
    ws.send(WS_SEND.chatInteractRespond, { interaction_id: current.interaction_id, choice });
    interactionState.value = null;
  }
  function dismissInteraction() {
    interactionState.value = null;
  }

  // ── System Prompt 预览 ──
  /** 预览请求：single 上下文附带 session（后端并入挂载文件夹装配，
   *  预览的 [工作目录] 与实际 run 一致）；无参刷新时按当前上下文取目标 */
  function requestSystemPrompt(agentId?: string) {
    const ctx = resolveContext();
    const target = agentId ?? (ctx?.kind === 'single' ? ctx.agentId : activeAgent());
    if (!target) return;
    systemPromptLoading.value = true;
    systemPromptContent.value = '';
    systemPromptError.value = '';
    ws.send(WS_SEND.agentSystemPrompt, {
      agentId: target,
      ...(ctx?.kind === 'single' && ctx.sessionId ? { session: ctx.sessionId } : {}),
    });
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
    ws.send(WS_SEND.agentToolDefs, { agentId: target });
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
        ws.send(WS_SEND.chatSubscribe, { to: restored });
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
  // 消息类事件（chat.message/thinking/toolcall/tool_execution/start/step/end/history/virtual.receive）
  // 由 feed store 的 ingest() 统一处理（feed.init() 已注册）
  const HANDLERS: Record<string, (d: any) => void> = {
    [WS_EVENT.agentListResponse]: onAgentListResponse,
    [WS_EVENT.agentProfileUpdated]: () => { useAgentStore().requestAgents(); },
    // 对方正忙提示：消息已作为追加指令注入（后端 activeSession 转向时推送）
    [WS_EVENT.chatSendAck]: (d: any) => {
      if (d?.busy) {
        const name = useAgentStore().agents.find((a: any) => a.agent_id === d.to)?.name || d.to || '对方';
        busyFeedback.value = `⏳ ${name} 正忙，您的消息已作为追加指令排队，稍后处理…`;
        if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
        busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 4000);
      }
      if (d?.deduped) {
        // 同一 requestId 已被后端处理（WS 重连 flush 场景）：结束本地进行中态，
        // 并重拉历史把已投递/已落盘的消息恢复出来，避免"页面无响应"卡死。
        turnInProgress.value = false;
        busyFeedback.value = '这条消息刚刚已投递，正在恢复对话…';
        if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
        busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 3000);
        if (d.to) setTimeout(() => loadHistory(VIEWER_ID.value, d.to), 250);
      }
    },
    // ask_questions 交互：Agent 请求用户决策 → 显示弹窗
    [WS_EVENT.chatInteraction]: (d: any) => {
      interactionState.value = d;
      turnInProgress.value = true;
    },
    [WS_EVENT.chatInteractRespond]: () => { /* 响应已发送，弹窗已由 respondInteraction 关闭 */ },
    [WS_EVENT.sessionCompressed]: onSessionCompressed,
    [WS_EVENT.sessionArchived]: onSessionArchived,
    // 后端重启中（Supervisor 模式自动拉起，WS 自动重连）
    [WS_EVENT.systemRestarting]: () => {
      compressPending.value = false;
      compressFeedback.value = '后端正在重启，稍后自动重连…';
      if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
      compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 3000);
    },
    [WS_EVENT.agentSystemPromptResponse]: onSystemPromptResponse,
    [WS_EVENT.agentToolDefsResponse]: onToolDefsResponse,
  };

  // ── Init ──
  feed.init(); // 注册统一信息流 ingest（消息类事件，含 WS 单一分发挂载）
  ws.init();
  // 非消息类事件注册到统一事件注册表（WS 分发由 feed.init 挂载）
  for (const [type, fn] of Object.entries(HANDLERS)) registerEventHandler(type, fn);

  return {
    // 视图状态
    messages, turns, currentMessages, contextBusy,
    unreadAgents, turnInProgress, loadingHistory, hasMoreHistory, lastRunEndAt, archivePending,
    // 未读：进入会话时清除；获取指定 Agent 未读数
    clearUnread: (agentId: string) => feed.clearUnread(directDialog(agentId)),
    getUnreadCount: feed.getUnreadCount,
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
    // 会话上下文（P3 single；pair 场景零影响）
    resolveContext, setSingleContext, clearSingleContext,
  };
});
