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
import { useAgentStore } from './agents';
import { useFeedStore } from './feed';
import { logger } from '../utils/logger';
import { VIEWER_ID } from '../constants';
import { wireRpc } from '../api/wire';
import { toToolDefs, chatPresence } from '../api/chat-ops';
import { directDialog, singleDialog, bucketKey, type DialogId } from '../utils/feed';

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
  /** 消息路由目标 Agent（single 场景 = session.json 的 agentId；空会话回退默认预设） */
  agentId: string;
  /** 独立会话 id（仅 single） */
  sessionId?: string;
  /** 会话级模型覆盖（仅 single；singles 引用语义——投递时随信封透传 router） */
  model?: string;
}

export const useChatStore = defineStore('chat', () => {
  const feed = useFeedStore();

  const activeAgent = () => useAgentStore().activeAgentId;

  /** 当前会话上下文：显式 single 激活优先；否则当前 Agent（pair，现状语义） */
  function resolveContext(): ChatContext | null {
    if (feed.activeSingleId) {
      // single：agentId/model 由调用方在激活时经 setSingleContext 声明（feed 只存 sessionId）
      const meta = singleMeta.get(feed.activeSingleId);
      if (meta) {
        return {
          kind: 'single',
          agentId: meta.agentId,
          sessionId: feed.activeSingleId,
          ...(meta.model ? { model: meta.model } : {}),
        };
      }
    }
    const agentId = activeAgent();
    return agentId ? { kind: 'pair', agentId } : null;
  }

  /** single 会话元信息（agentId/模型覆盖等；激活时登记） */
  const singleMeta = new Map<string, { agentId: string; model?: string }>();

  /** 激活独立会话上下文（页面路由用；agentId/model 来自 session 元数据，feed 据此登记消息身份） */
  function setSingleContext(sessionId: string, agentId: string, model?: string) {
    singleMeta.set(sessionId, { agentId, ...(model ? { model } : {}) });
    feed.setActiveSingle(sessionId, agentId);
    // 刷新/切换恢复：查询该会话的活跃快照（带 session 精确匹配——同一 Agent
    // 多个 single 会话并存时按 agentId 匹配会拿到别的会话的快照，恢复即串台；
    // 运行中 → 合成最小 active 快照恢复当前轮；空闲 → active:false 无害忽略）
    if (agentId) void subscribeResume(agentId, sessionId);
  }
  /** 退出独立会话上下文（回到 pair） */
  function clearSingleContext() {
    feed.clearActiveSingle();
  }

  /** conversation/stats → resume 快照（运行中命中=最小 active 快照[前端兜底合并]；空闲 active:false） */
  async function subscribeResume(agentId: string, session?: string): Promise<void> {
    try {
      const stats = await wireRpc.call<{ running?: Array<{ agentId: string; conversationId: string }> }>('conversation/stats');
      const hit = (stats.running ?? []).find((r) =>
        r.agentId === agentId && (session ? r.conversationId === session : r.conversationId === bucketKey(VIEWER_ID.value, agentId)));
      feed.handleResume(hit
        ? { active: true, agentId, ...(session ? { session } : {}), phase: 'message', content: '', thinking: '', label: '', toolCallId: '', toolName: '', steps: [], userMessages: [] }
        : { active: false, agentId, ...(session ? { session } : {}) });
    } catch { /* stats 失败静默（刷新恢复是尽力而为） */ }
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

  /** 发送后流式态看门狗：后端重启/事件丢失时无 stepStart/stepEnd/chatEnd，
   *  分区 streaming 永真 → contextBusy 永久卡"打断并发送"态。到期检查：
   *  分区里已无任何流式占位仍标记 streaming → 判定事件链断裂，回落并提示。 */
  function armSendWatchdog(dialogId: DialogId) {
    setTimeout(() => {
      const d = feed.getDialog(dialogId);
      if (!d || !d.streaming) return;
      const hasLive = d.rawMessages.some(m => m.isStreaming);
      if (!hasLive) {
        d.streaming = false;
        turnInProgress.value = false;
        busyFeedback.value = '⚠️ 发送后长时间无响应（连接可能已中断），请重试或检查后端状态';
        if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
        busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 6000);
      }
    }, 30_000);
  }

  /** 投递（Port B，M19/D3）：requestId 直达传输层幂等键（重连 flush 重发同 id → 后端 deduped ack）。
   *  直答路径前端透传——会话键（pairKey(viewer, agent)）与 sender 由后端
   *  web-api 边界显式计算（D3：边界算则前端透传）；single 显式传 sid。 */
  function deliver(ctx: ChatContext | null, target: string, content: string, files: import('../types').FileAttachment[] | undefined, requestId?: string) {
    const composed = composeContent(content, files);
    if (requestId) deliverTargets.set(requestId, target);
    void wireRpc.call('conversation/deliver', {
      agentId: target,
      message: composed,
      ...(requestId ? { requestId } : {}),
      ...(ctx && ctx.kind === 'single' && ctx.sessionId
        ? { conversationId: ctx.sessionId, ...(ctx.model ? { model: ctx.model } : {}) }
        : {}),
    }, requestId).catch((err: unknown) => {
      // 投递失败：红条反馈（feed 流式态由 watchdog 兜底回落）
      logger.warn('[ChatStore] 投递失败', err);
      busyFeedback.value = `⚠️ 发送失败：${err instanceof Error ? err.message : String(err)}`;
      if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
      busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 6000);
    });
  }

  /** 附件行合成：上传指纹 → workspace 路径（agent 可 read）；无记录降级文件名 */
  function composeContent(content: string, files: import('../types').FileAttachment[] | undefined): string {
    if (!files?.length) return content;
    const lines = files.map((f) => {
      if (!f) return '';
      const path = chatPresence.uploadPaths.get(f.hash) ?? chatPresence.uploadPaths.get(f.filename);
      return path ? `[附件] ${path}` : `[附件] ${f.filename}（已上传，路径未记录）`;
    });
    return `${content}\n${lines.join('\n')}`.trim();
  }

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
    // 发送即置当前分区流式态（step-started 到达前 contextBusy 已生效；
    // after-step/after-run 会正常回落，避免残留）
    feed.ensureById(dialogId).streaming = true;
    armSendWatchdog(dialogId);
    if (!to && ctx?.kind !== 'single') useAgentStore().bumpAgent(VIEWER_ID.value, content);
    turnInProgress.value = true;
    deliver(to || !ctx ? null : ctx, target, content, options?.files, uid('send'));
  }

  /** 内部用：直接发送消息（不添加 user 气泡），用于重新推理 */
  function _sendRaw(ctx: ChatContext, content: string, deepThink: boolean, files: import('../types').FileAttachment[]) {
    void deepThink;
    turnInProgress.value = true;
    deliver(ctx, ctx.agentId, content, files, uid('send'));
  }

  /** 停止当前生成：中断 Agent 正在运行的 LLM/工具执行。
   *  single 上下文带 session（后端会话级精确中断，不牵连同 Agent 的其他会话）；
   *  直答 = viewer 对桶键（M19） */
  function interruptGeneration() {
    const ctx = resolveContext();
    if (!ctx) return;
    void wireRpc.call('conversation/interrupt', {
      agentId: ctx.agentId,
      conversationId: ctx.kind === 'single' && ctx.sessionId ? ctx.sessionId : bucketKey(VIEWER_ID.value, ctx.agentId),
    }).catch(() => undefined);
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
        void wireRpc.call('session/delete-message', { conversationId: bucketKey(VIEWER_ID.value, target), messageId: m.persistedMsgId }).catch(() => undefined);
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
      void wireRpc.call('session/delete-message', { conversationId: bucketKey(VIEWER_ID.value, ctx.agentId), messageId: msg.persistedMsgId }).catch(() => undefined);
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
        void wireRpc.call('session/delete-message', { conversationId: bucketKey(VIEWER_ID.value, ctx.agentId), messageId: mid }).catch(() => undefined);
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
    void wireRpc.call('session/archive', { conversationId: bucketKey(VIEWER_ID.value, ctx.agentId), agentId: ctx.agentId })
      .then(() => onSessionCompressed({}))
      .catch((err: unknown) => {
        compressPending.value = false;
        compressFeedback.value = `❌ 归档触发失败：${err instanceof Error ? err.message : String(err)}`;
      });
  }

  /** 继续生成：preview 无"无消息自主续写"面——注入续写指令（source:'event'
   *  不进用户气泡语义；消息会入会话流——已知降级，README 记录）。
   *  直答路径不传 conversationId（边界算 viewer 对键，M19/D3） */
  function continueGeneration() {
    const ctx = resolveContext();
    if (!ctx || turnInProgress.value) return;
    turnInProgress.value = true;
    void wireRpc.call('conversation/deliver', {
      agentId: ctx.agentId,
      message: '[chat.continue] 请基于当前上下文继续。',
      source: 'event',
      ...(ctx.kind === 'single' && ctx.sessionId
        ? { conversationId: ctx.sessionId, ...(ctx.model ? { model: ctx.model } : {}) }
        : {}),
    }).catch(() => undefined);
  }

  // ── ask_questions 交互 ──
  function respondInteraction(choice: string) {
    const current = interactionState.value;
    if (!current) return;
    void wireRpc.call('interaction/reply', {
      id: current.interaction_id,
      answer: { answers: [choice] },
    }).catch(() => undefined);
    interactionState.value = null;
  }
  function dismissInteraction() {
    interactionState.value = null;
  }

  // ── System Prompt 预览 ──
  /** 预览请求（Port B 直连）：agents/system-prompt RPC → 直接填状态 */
  function requestSystemPrompt(agentId?: string) {
    const ctx = resolveContext();
    const target = agentId ?? (ctx?.kind === 'single' ? ctx.agentId : activeAgent());
    if (!target) return;
    systemPromptLoading.value = true;
    systemPromptContent.value = '';
    systemPromptError.value = '';
    void wireRpc.call<{ systemPrompt?: string }>('agents/system-prompt', { agentId: target })
      .then((r) => {
        systemPromptLoading.value = false;
        systemPromptContent.value = r.systemPrompt ?? '';
      })
      .catch((err: unknown) => {
        systemPromptLoading.value = false;
        systemPromptError.value = err instanceof Error ? err.message : '获取 System Prompt 失败';
      });
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
    void wireRpc.call<{ defs?: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }>('agents/tool-defs', { agentId: target })
      .then((r) => {
        toolDefsLoading.value = false;
        toolDefs.value = toToolDefs(r.defs ?? []) as never;
      })
      .catch((err: unknown) => {
        toolDefsLoading.value = false;
        toolDefsError.value = err instanceof Error ? err.message : '获取工具定义失败';
      });
  }
  function clearToolDefs() {
    toolDefs.value = [];
    toolDefsError.value = '';
  }

  // ── 非消息类事件（Port B：wire 事件 + ack 直连） ──
  function onAgentListResponse(agents: Array<Record<string, unknown>>, hasActiveIds?: Set<string>) {
    void hasActiveIds;
    useAgentStore().setAgents(agents as never);
    const restored = useAgentStore().tryRestoreLastAgent();
    if (restored) {
      feed.resetDialog(directDialog(restored));
      loadHistory(VIEWER_ID.value, restored);
      const agent = useAgentStore().agents.find(a => a.id === restored);
      if (agent?.hasActiveSession) {
        void subscribeResume(restored);
      }
    }
  }

  /** 归档触发回执——异步流程已启动，等待归档完成 */
  function onSessionCompressed(_d?: unknown) {
    compressFeedback.value = '已触发归档，Agent 正在整理记忆…';
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 5000);
  }

  /** 归档完成（archive/completed 广播）——重置状态并重载会话 */
  function onSessionArchived(payload: { agentId?: string } | undefined) {
    const agent = String(payload?.agentId ?? '');
    const current = activeAgent();
    if (agent !== current && agent !== 'user') return;
    compressPending.value = false;
    compressFeedback.value = '✅ 记忆已整理，会话已归档';
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 4000);
    if (current) {
      feed.resetDialog(directDialog(current));
      loadHistory(VIEWER_ID.value, current);
    }
  }

  /** 投递回执（ws/ack + deliver outcome）：busy 排队提示 / deduped 重连恢复 */
  function onDeliverAck(kind: 'busy' | 'deduped' | string, info: Record<string, unknown> | undefined, requestId: string) {
    void requestId;
    if (kind === 'busy') {
      const to = String(info?.agentId ?? '');
      const name = useAgentStore().agents.find((a: any) => a.id === to)?.name || to || '对方';
      busyFeedback.value = `⏳ ${name} 正忙，您的消息已作为追加指令排队，稍后处理…`;
      if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
      busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 4000);
      return;
    }
    if (kind === 'deduped') {
      // 同一 requestId 已被后端处理（WS 重连 flush 场景）：结束本地进行中态，
      // 并重拉历史把已投递/已落盘的消息恢复出来，避免"页面无响应"卡死。
      turnInProgress.value = false;
      busyFeedback.value = '这条消息刚刚已投递，正在恢复对话…';
      if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
      busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 3000);
      const to = deliverTargets.get(requestId);
      if (to) setTimeout(() => loadHistory(VIEWER_ID.value, to), 250);
    }
  }

  /** deliver 发起时登记 requestId → to（deduped ack 恢复历史用） */
  const deliverTargets = new Map<string, string>();

  // ── Init：wire 订阅（Port B 单一入口） ──
  feed.init(); // 统一信息流（消息类事件，wire 帧分发）
  // 启动名册链：fetchAgents 汇聚 → 恢复上次选中（resetDialog + 首屏历史 + resume）
  useAgentStore().requestAgents((list) => onAgentListResponse(list as never));
  wireRpc.onWireEvent((type, args) => {
    if (type === 'agents/updated') {
      useAgentStore().requestAgents();
      return;
    }
    if (type === 'archive/completed') {
      onSessionArchived(args[0] as { agentId?: string });
      return;
    }
    if (type === 'system/restarting') {
      compressPending.value = false;
      compressFeedback.value = '后端正在重启，稍后自动重连…';
      if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
      compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 3000);
      return;
    }
    if (type === 'durable-interaction/opened') {
      const payload = args[0] as Record<string, unknown>;
      if (!payload || payload.kind !== 'ask_questions') return;
      const q = Array.isArray(payload.questions) ? (payload.questions[0] as { question?: string; options?: string[] }) : undefined;
      if (!q) return;
      interactionState.value = {
        interaction_id: String(payload.id ?? ''),
        agent_id: String(payload.owner ?? ''),
        question: String(q.question ?? ''),
        options: Array.isArray(q.options) ? q.options.map(String) : [],
        allow_custom: true,
        timeout_ms: typeof payload.deadline === 'number' ? Math.max(0, payload.deadline - Date.now()) : 300_000,
      };
      turnInProgress.value = true;
      return;
    }
    if (type === 'singles/updated') {
      const [meta, action] = args as [Record<string, unknown> | undefined, string];
      if (typeof meta?.id === 'string') {
        if (action === 'removed') chatPresence.knownSingles.delete(meta.id);
        else chatPresence.knownSingles.add(meta.id);
      }
      return;
    }
    if (type === 'group/created' || type === 'group/deleted') {
      const id = type === 'group/created' ? String((args[0] as Record<string, unknown>)?.id ?? '') : String(args[0] ?? '');
      if (id) {
        if (type === 'group/created') chatPresence.knownGroups.add(id);
        else chatPresence.knownGroups.delete(id);
      }
      return;
    }
  });
  wireRpc.onWireAck((ack) => {
    onDeliverAck(ack.kind, ack.info, ack.requestId);
  });

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
    /** 运行中 Agent 的 resume 订阅（列表点击运行项跳转等场景） */
    subscribeAgent: subscribeResume,
    // 会话上下文（P3 single；pair 场景零影响）
    resolveContext, setSingleContext, clearSingleContext,
  };
});
