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
import { toToolDefs, chatPresence, pickAskQuestions } from '../api/chat-ops';
import { directDialog, singleDialog, bucketKey, splitAttachmentLines, type DialogId } from '../utils/feed';
import { isImageRef } from '../utils/media';

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/** deliver RPC 等整轮 run 收束才返回（web-api 语义）——长 run 专属超时
 *  （普通 RPC 缺省 60s；工具密集的 run 轻松超过，曾把"运行中"误报成
 *  "发送失败：rpc conversation/deliver 超时"） */
const DELIVER_RPC_TIMEOUT_MS = 10 * 60_000;

/**
 * 会话上下文（ChatContext 抽象，P3）：
 *   pair = 用户↔Agent 一对一（现状唯一形态，行为零变化）
 *   single = 独立会话（sessionId 决定历史/投递维度；agentId 仍是消息路由目标）
 * 动作层统一经 resolveContext() 取上下文：WS 载荷带 session、feed 分区用
 * single dialog、pair 场景完全保持原路径。
 */
interface ChatContext {
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

  // ══ 压缩 / 记忆整理反馈（非消息状态；tone 语义态 → FeedbackNotice 派生图标/配色）══
  const compressPending = ref(false);
  /** 手工归档进行中的会话键（conversationId）——完成帧按它精确复位
   *  pending（后台自动归档的完成帧不误清手工进行中的状态） */
  const pendingArchiveConv = ref('');
  const compressFeedback = ref('');
  const compressTone = ref<'info' | 'ok' | 'error'>('info');
  /** 归档完成时刻（当前 Agent）——token 仪表等"无 run 结束也会变"的派生
   *  数据在归档 compact 后需要重取（lastRunEndAt 不覆盖该时刻） */
  const sessionArchivedAt = ref(0);
  let compressFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  function setCompressFeedback(text: string, tone: 'info' | 'ok' | 'error' = 'info') {
    compressFeedback.value = text;
    compressTone.value = tone;
  }

  /** 投递反馈（ack busy / 发送失败等；tone 语义态 → FeedbackNotice 派生） */
  const busyFeedback = ref('');
  const busyTone = ref<'info' | 'error'>('info');
  let busyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  function setBusyFeedback(text: string, tone: 'info' | 'error' = 'info') {
    busyFeedback.value = text;
    busyTone.value = tone;
  }

  // ══ ask_questions 交互（决策工具）══
  /** 全部待答 ask_questions（按 created_at 降序）。live opened 帧与
   *  interaction/list 恢复记录共同维护——多个 Agent（或同一 Agent 多会话）
   *  并发提问时各有各的作答入口，互不覆盖；作答/超时/别处已答按 id 移除。 */
  const pendingInteractions = ref<Array<import('../api/chat-ops').AskQuestionsUiState>>([]);

  /** 当前上下文的待答提问：会话键路由（pair = viewer 对桶 / single = sid，
   *  与 interaction record 的 key 同词表）精确匹配优先；旧载荷无 key 回落
   *  agent 匹配（无 agent_id 放行——兼容）。切到哪个会话就答哪个会话的题，
   *  别家更新的提问不再占槽遮挡。 */
  const interaction = computed(() => {
    const ctx = resolveContext();
    if (!ctx) return null;
    const convKey = ctx.kind === 'single' && ctx.sessionId
      ? ctx.sessionId
      : bucketKey(VIEWER_ID.value, ctx.agentId);
    const keyHit = pendingInteractions.value.find((it) => it.key === convKey);
    if (keyHit) return keyHit;
    return pendingInteractions.value.find((it) =>
      !it.key && (!it.agent_id || it.agent_id === ctx.agentId)) ?? null;
  });

  /** ask_questions 载荷入列（两形归一见 chat-ops）：按 interaction_id upsert
   *  （同 id 重放仅刷新剩余倒计时），列表恒按 created_at 降序（最新优先）。 */
  function applyAskQuestions(r: Record<string, unknown> | null | undefined): void {
    const state = pickAskQuestions(r);
    if (!state) return;
    const rest = pendingInteractions.value.filter((it) => it.interaction_id !== state.interaction_id);
    rest.push(state);
    rest.sort((a, b) => b.created_at - a.created_at);
    pendingInteractions.value = rest;
    turnInProgress.value = true;
  }

  /** 按 id 移除（作答提交 / 本端关闭 / 别处已答 replied / 后端超时 closed） */
  function removeInteraction(id: string): void {
    pendingInteractions.value = pendingInteractions.value.filter((it) => it.interaction_id !== id);
  }

  /** 刷新/重连恢复：拉取全部 pending ask_questions 重挂弹窗（每条各有会话
   *  归属，按上下文路由展示）。opened 事件只在工具调用时刻广播一次——页面
   *  刷新后无人重推；write-ahead store（interaction/list）是唯一恢复源。
   *  对账语义：快照是 pending 真源——发出请求时已在本地、快照里却没有的
   *  条目 = 离线期间已被答/关闭（事件错过），剔除；请求在途期间新到的
   *  live opened（不在快照）保留。 */
  async function restorePendingInteractions(): Promise<void> {
    try {
      const before = new Set(pendingInteractions.value.map((it) => it.interaction_id));
      const r = await wireRpc.call<{ interactions?: Array<Record<string, unknown>> }>('interaction/list', { state: 'pending' });
      const snapshot = (r.interactions ?? [])
        .filter((it) => it && it.kind === 'ask_questions')
        .map((it) => pickAskQuestions(it))
        .filter((s): s is import('../api/chat-ops').AskQuestionsUiState => !!s);
      const inFlightAdds = pendingInteractions.value.filter((it) =>
        !before.has(it.interaction_id) && !snapshot.some((s) => s.interaction_id === it.interaction_id));
      const merged = [...snapshot, ...inFlightAdds];
      merged.sort((a, b) => b.created_at - a.created_at);
      pendingInteractions.value = merged;
    } catch { /* 恢复尽力而为（后端不可达/旧后端无该 RPC） */ }
  }
  wireRpc.onWireOpen(() => { void restorePendingInteractions(); });
  // 首次加载兜底：socket 已开（onWireOpen 错过）时 call 自带等连接语义——
  // 连接建立即返回；失败静默（恢复尽力而为）
  void restorePendingInteractions();

  // ══ System Prompt 预览 ══
  const systemPromptLoading = ref(false);
  const systemPromptContent = ref('');
  const systemPromptError = ref('');

  // ══ 工具定义（Token 弹层固定开销估算用；预览弹窗已由 Agent 配置的插件工具面取代）══
  const toolDefsLoading = ref(false);
  const toolDefs = ref<any[]>([]);

  // ── Actions ──

  /** 发送后流式态看门狗：后端重启/事件丢失时无 stepStart/stepEnd/chatEnd，
   *  分区 streaming 永真 → contextBusy 永久卡"停止"态。到期检查：
   *  分区里已无任何流式占位仍标记 streaming → 判定事件链断裂，回落并提示。
   *  在途判据含未闭合工具行（content 空）：streaming 升格 run 级后，工具
   *  执行窗口（after-step 已关占位、结果未回）run 仍活着——长工具不误报。 */
  function armSendWatchdog(dialogId: DialogId) {
    setTimeout(() => {
      const d = feed.getDialog(dialogId);
      if (!d || !d.streaming) return;
      const hasLive = d.rawMessages.some(m => m.isStreaming || (m.role === 'tool' && !m.content));
      if (!hasLive) {
        d.streaming = false;
        turnInProgress.value = false;
        setBusyFeedback('发送后长时间无响应（连接可能已中断），请重试或检查后端状态', 'error');
        if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
        busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 6000);
      }
    }, 30_000);
  }

  /** 投递（Port B，M19/D3）：requestId 直达传输层幂等键（重连 flush 重发同 id → 后端 deduped ack）。
   *  直答路径前端透传——会话键（pairKey(viewer, agent)）与 sender 由后端
   *  web-api 边界显式计算（D3：边界算则前端透传）；single 显式传 sid。
   *  busyMode（DSH 忙态语义）：'queue' = lane next-turn（排队等本轮结束
   *  后独立 run 投递）；'steer' = placement steer（立即注入活跃 run 的
   *  下一步）；undefined = 空闲普通发送（后端缺省路径）。 */
  function deliver(
    ctx: ChatContext | null,
    target: string,
    content: string,
    files: import('../types').FileAttachment[] | undefined,
    requestId?: string,
    busyMode?: 'queue' | 'steer',
  ) {
    const composed = composeContent(content, files);
    const attachments = imageAttachmentsOf(files);
    if (requestId) deliverTargets.set(requestId, target);
    void wireRpc.call('conversation/deliver', {
      agentId: target,
      message: composed,
      ...(attachments ? { attachments } : {}),
      ...(requestId ? { requestId } : {}),
      ...(busyMode === 'queue' ? { lane: 'next-turn' as const } : {}),
      ...(busyMode === 'steer' ? { placement: 'steer' as const } : {}),
      ...(ctx && ctx.kind === 'single' && ctx.sessionId
        ? { conversationId: ctx.sessionId, ...(ctx.model ? { model: ctx.model } : {}) }
        : {}),
    }, requestId, DELIVER_RPC_TIMEOUT_MS).catch((err: unknown) => {
      // 投递失败：红条反馈（feed 流式态由 watchdog 兜底回落）。驻留 12s
      //（2026-09-02 反馈：6s 一闪而过来不及看清/截图；完整错误恒在
      // 控制台——logger.warn '[ChatStore] 投递失败'）。
      // 超时降级（2026-09-02 反馈 #1）：deliver RPC 等整轮 run 收束才返回
      //（web-api 语义），工具密集的长 run 轻松超过缺省 60s——超时≠失败：
      // 会话流式态仍活着（分区 streaming / 全局 turnInProgress）说明 run
      // 正常进行，只记日志不打扰用户；流式已死才是真失败。
      const msg = err instanceof Error ? err.message : String(err);
      const dialogId = ctx && ctx.kind === 'single' && ctx.sessionId
        ? singleDialog(ctx.sessionId)
        : directDialog(target);
      const streamAlive = feed.getDialog(dialogId)?.streaming || turnInProgress.value;
      if (/超时$/.test(msg) && streamAlive) {
        logger.warn('[ChatStore] deliver RPC 超时但会话流式仍在进行（长 run），忽略', { target });
        return;
      }
      logger.warn('[ChatStore] 投递失败', err);
      // 排队发送失败：回显不会到来——回退登记（防同文后续回显经登记
      // 命中误补重复气泡）
      if (busyMode === 'queue') {
        feed.dropQueuedSend(
          dialogId,
          splitAttachmentLines(composed).content,
        );
      }
      setBusyFeedback(`发送失败：${msg}`, 'error');
      if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
      busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 12_000);
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

  /**
   * 图片附件 → 多模态引用（多模态一期）：仅图片文件、且能解析出 workspace
   * 路径（hash/filename 登记或 text 即路径）才携带；后端按目标模型物化/
   * 剥离。文本附件不产生引用（`[附件]` 路径行 + read 工具路径不变）。
   * 上限 50 与后端 deliver 校验对齐（超出截断并告警）。图片判定单源
   * utils/media（与输入框预览/气泡缩略图同款正则）。
   */
  function imageAttachmentsOf(files: import('../types').FileAttachment[] | undefined):
    | Array<{ kind: 'image'; ref: string; filename?: string }>
    | undefined {
    if (!files?.length) return undefined;
    const out: Array<{ kind: 'image'; ref: string; filename?: string }> = [];
    for (const f of files) {
      if (!f) continue;
      if (out.length >= 50) {
        logger.warn('[ChatStore] 图片附件超出 50 上限，多余部分仅作文件路径文本附带', { count: files.length });
        break;
      }
      const name = f.filename ?? '';
      const path = chatPresence.uploadPaths.get(f.hash) ?? chatPresence.uploadPaths.get(f.filename) ?? (f.text || '');
      if (!isImageRef(name, path)) continue;
      if (!path) continue;
      out.push({ kind: 'image', ref: path, ...(name ? { filename: name } : {}) });
    }
    return out.length > 0 ? out : undefined;
  }

  function sendMessage(content: string, to?: string, options?: {
    deepThink?: boolean; reasoningEffort?: 'low' | 'high' | 'max'; files?: import('../types').FileAttachment[];
    /** 忙态投递方式（DSH 语义）：缺省 = 运行中排队（next-turn 队列，
     *  本轮结束后独立投递——不再打断在途 run）；'steer' = 立即注入
     *  活跃 run 下一步。空闲时两者等价（普通发送）。 */
    mode?: 'steer';
  }) {
    const ctx = resolveContext();
    const target = to ?? ctx?.agentId;
    if (!target || (!content.trim() && !options?.files?.length)) return;
    const dialogId = to || !ctx ? directDialog(target) : ctxDialog(ctx);
    // DSH 忙态决策点：目标会话流式中 → 排队/插话（先于 streaming 置位
    // 判定——sendMessage 自己会点亮 streaming）。此处不 interrupt：
    // 停止是停止按钮的唯一职责（发送不再隐式打断在途 run）。
    const busy = feed.getDialog(dialogId)?.streaming === true;
    const busyMode = busy ? (options?.mode === 'steer' ? 'steer' : 'queue') : undefined;
    if (busyMode === 'queue') {
      // 排队路径本地不上屏（2026-09-06 顺序反馈）：消息只住 QueueDock——
      // 此前立即 append 会造成"既在队列又在会话流"双现，插在在途回复
      // 中间渲染顺序错乱。登记回显待补：消费投递（本轮结束后独立 run）
      // 的 router/message-received 回显按登记补气泡（feed.showOwnEcho）。
      feed.registerQueuedSend(
        dialogId,
        splitAttachmentLines(composeContent(content, options?.files)).content,
      );
    } else {
      feed.append(dialogId, {
        id: uid('user'), role: 'agent', content, timestamp: Date.now(),
        files: options?.files, agent_id: 'user',
      });
    }
    // 发送即置当前分区流式态（step-started 到达前 contextBusy 已生效；
    // after-step/after-run 会正常回落，避免残留）
    feed.ensureById(dialogId).streaming = true;
    armSendWatchdog(dialogId);
    if (!to && ctx?.kind !== 'single') useAgentStore().bumpAgent(VIEWER_ID.value, content);
    turnInProgress.value = true;
    deliver(to || !ctx ? null : ctx, target, content, options?.files, uid('send'), busyMode);
  }

  /** 内部用：直接发送消息（不添加 user 气泡），用于重新推理 */
  function _sendRaw(ctx: ChatContext, content: string, deepThink: boolean, files: import('../types').FileAttachment[]) {
    void deepThink;
    turnInProgress.value = true;
    deliver(ctx, ctx.agentId, content, files, uid('send'));
  }

  /** 插话本地上屏（QueueDock 行级 steer 成功后调用）：conversation/steered
   *  帧对 viewer 自己的发送跳过（本地已上屏语义），排队消息没有本地气泡
   *  ——补一条 user 气泡让插话在会话流可见。仅活跃会话（dock 只在活跃
   *  会话渲染）。插话走 steer 通道入账（无 message-received 回显）——
   *  同步回退排队登记，防同文后续回显误补重复气泡。 */
  function appendOwnSteered(content: string) {
    const ctx = resolveContext();
    if (!ctx) return;
    const dialogId = ctxDialog(ctx);
    // 与排队回显/历史同规格：尾部 [附件] 行剥回 chips（preview 是发送时
    // 合成的组合正文）
    const split = splitAttachmentLines(content);
    feed.dropQueuedSend(dialogId, split.content);
    feed.append(dialogId, {
      id: uid('user'), role: 'agent', content: split.content, timestamp: Date.now(),
      agent_id: VIEWER_ID.value,
      ...(split.files ? { files: split.files } : {}),
    });
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
    // 1v1 与独立会话均可触发（/archive 快捷命令同一入口）：single 的会话键
    // = sid（与 deliver/历史同口径），agentId 显式透传（sid 无 ~ 段，
    // 服务端 agentOfPair 推导不了承载 Agent）
    if (!ctx || compressPending.value) return;
    compressPending.value = true;
    setCompressFeedback('正在归档整理记忆…');
    const conversationId = ctx.kind === 'single' && ctx.sessionId
      ? ctx.sessionId
      : bucketKey(VIEWER_ID.value, ctx.agentId);
    pendingArchiveConv.value = conversationId;
    void wireRpc.call('session/archive', { conversationId, agentId: ctx.agentId })
      .then(() => onSessionCompressed({}))
      .catch((err: unknown) => {
        compressPending.value = false;
        pendingArchiveConv.value = '';
        setCompressFeedback(`归档触发失败：${err instanceof Error ? err.message : String(err)}`, 'error');
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
  /** 提交回答：answers 与 questions 对齐（未答/跳过的题传 null——工具结果如实
   *  呈现"用户跳过"，Agent 自行决断）；单题提交场景传 [choice]。
   *  提交即按 id 出列——列表里下一条（同会话或别家）自然接棒显示。 */
  function respondInteraction(answers: Array<string | null>) {
    const current = interaction.value;
    if (!current) return;
    void wireRpc.call('interaction/reply', {
      id: current.interaction_id,
      answer: { answers },
    }).catch(() => undefined);
    removeInteraction(current.interaction_id);
  }
  function dismissInteraction() {
    const current = interaction.value;
    if (current) removeInteraction(current.interaction_id);
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

  // ── 工具定义（Token 弹层固定开销估算）──
  /** 工具定义请求（target 推导同 requestSystemPrompt：显式 agentId 优先，
   *  否则当前会话上下文——single = 会话引用 Agent，pair = 激活 Agent）。
   *  独立会话引用 Agent ≠ 全局激活 Agent 时，缺省取错会污染固定开销估算。 */
  function requestToolDefs(agentId?: string) {
    const ctx = resolveContext();
    const target = agentId ?? (ctx?.kind === 'single' ? ctx.agentId : activeAgent());
    if (!target) return;
    toolDefsLoading.value = true;
    toolDefs.value = [];
    void wireRpc.call<{ defs?: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }>('agents/tool-defs', { agentId: target })
      .then((r) => {
        toolDefsLoading.value = false;
        toolDefs.value = toToolDefs(r.defs ?? []) as never;
      })
      .catch(() => {
        // 估算尽力而为：失败仅收敛 loading（弹层工具行显示 ≈ 0）
        toolDefsLoading.value = false;
      });
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
    setCompressFeedback('已触发归档，Agent 正在整理记忆…');
    if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
    compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 5000);
  }

  /** 归档完成（archive/completed 广播）——重置状态并重载会话。
   *  archived 条数区分反馈：0 条 = 未超尾部保留水位（仅完成整理，
   *  会话流无变化——不再误报"已归档"）。
   *  会话关联按载荷 conversationId 判定（1v1 对桶键 / 独立会话 sid）：
   *  single 视图 activeAgent 恒空，按 agent 对齐会恒早退——完成帧丢失
   *  即 compressPending 永不复位（全 app 归档入口锁死）且 single 分区
   *  不刷新；切走视图后完成的（仍在途的）归档按 pendingArchiveConv
   *  精确复位，后台自动归档（非手工触发）不误清。 */
  function onSessionArchived(payload: { agentId?: string; conversationId?: string; archived?: number; kept?: number } | undefined) {
    const agent = String(payload?.agentId ?? '');
    const conv = String(payload?.conversationId ?? '');
    const ctx = resolveContext();
    const current = activeAgent();
    // 当前视图关联：载荷命中本视图会话键（single sid / 1v1 对桶键）；
    // 旧载荷缺 conversationId 时回落 agent 对齐（向后兼容）
    const ctxConv = ctx
      ? (ctx.kind === 'single' && ctx.sessionId ? ctx.sessionId : bucketKey(VIEWER_ID.value, ctx.agentId))
      : '';
    const mine = ctx !== null
      ? (conv ? conv === ctxConv : agent === current || agent === 'user')
      : false;
    // 手工触发的在途归档：即使已切走视图也要复位 pending（后台自动
    // 归档的完成帧不做此复位——不该误清无关状态）
    const minePending = conv !== '' && conv === pendingArchiveConv.value;
    if (!mine && !minePending) return;
    if (minePending) pendingArchiveConv.value = '';
    compressPending.value = false;
    const archived = payload?.archived;
    if (mine) {
      setCompressFeedback(
        archived === 0
          ? '记忆整理完成（会话未超保留水位，0 条移出）'
          : typeof archived === 'number'
            ? `记忆已整理，已归档 ${archived} 条早期消息`
            : '记忆已整理，会话已归档',
        'ok',
      );
      if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
      compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 4000);
      feed.resetDialog(ctxDialog(ctx!));
      loadHistory(VIEWER_ID.value, ctx!.agentId, ctx!.kind === 'single' ? ctx!.sessionId : undefined);
      sessionArchivedAt.value = Date.now(); // 仪表重取信号（compact 后估算已回落）
    }
  }

  /** 投递回执（ws/ack + deliver outcome）：busy 排队/插话提示 / deduped 重连恢复 */
  function onDeliverAck(kind: 'busy' | 'deduped' | string, info: Record<string, unknown> | undefined, requestId: string) {
    void requestId;
    if (kind === 'busy') {
      const to = String(info?.agentId ?? '');
      const name = useAgentStore().agents.find((a: any) => a.id === to)?.name || to || '对方';
      // busy 分流（DSH 语义）：queued = 已排队等本轮结束；否则 = 已插话
      // 注入活跃 run（deliver outcome steered 的 ack 形态）
      setBusyFeedback(info?.queued
        ? `${name} 正忙，消息已排队，本轮结束后投递`
        : `已插入 ${name} 的当前运行（下一步生效）`);
      if (busyFeedbackTimer) clearTimeout(busyFeedbackTimer);
      busyFeedbackTimer = setTimeout(() => { busyFeedback.value = ''; }, 4000);
      return;
    }
    if (kind === 'deduped') {
      // 同一 requestId 已被后端处理（WS 重连 flush 场景）：结束本地进行中态，
      // 并重拉历史把已投递/已落盘的消息恢复出来，避免"页面无响应"卡死。
      turnInProgress.value = false;
      setBusyFeedback('这条消息刚刚已投递，正在恢复对话…');
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
      onSessionArchived(args[0] as { agentId?: string; conversationId?: string; archived?: number; kept?: number });
      return;
    }
    if (type === 'system/restarting') {
      compressPending.value = false;
      pendingArchiveConv.value = '';
      setCompressFeedback('后端正在重启，稍后自动重连…');
      if (compressFeedbackTimer) clearTimeout(compressFeedbackTimer);
      compressFeedbackTimer = setTimeout(() => { compressFeedback.value = ''; }, 3000);
      return;
    }
    if (type === 'durable-interaction/opened') {
      applyAskQuestions(args[0] as Record<string, unknown>);
      return;
    }
    if (type === 'durable-interaction/replied' || type === 'durable-interaction/closed') {
      // 本端或其他端已作答/后端超时关闭：按 id 出列（respondInteraction 已
      // 本地移除；这里覆盖"别处回答/后端超时"场景——弹窗不再悬空，同会话
      // 下一条 pending 自然接棒）
      const id = String((args[0] as Record<string, unknown> | undefined)?.id ?? '');
      if (id) removeInteraction(id);
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
    // 压缩/反馈（tone 语义态随文案设置——FeedbackNotice 派生图标/配色）
    compressPending, compressFeedback, compressTone, busyFeedback, busyTone,
    sessionArchivedAt,
    // 交互
    interaction,
    // 预览
    systemPromptLoading, systemPromptContent, systemPromptError,
    // 工具定义（Token 弹层固定开销估算）
    toolDefsLoading, toolDefs,
    // Actions
    sendMessage, interruptGeneration, regenerateMessage, deleteMessage, editMessage,
    appendOwnSteered,
    loadHistory, loadMoreHistory, compressSession, continueGeneration,
    respondInteraction, dismissInteraction,
    // 附件合成（群聊等非 store 投递路径复用：文本行 + 图片引用同构）
    composeContent, imageAttachmentsOf,
    requestSystemPrompt, clearSystemPrompt,
    requestToolDefs,
    /** 运行中 Agent 的 resume 订阅（列表点击运行项跳转等场景） */
    subscribeAgent: subscribeResume,
    // 会话上下文（P3 single；pair 场景零影响）
    resolveContext, setSingleContext, clearSingleContext,
  };
});
