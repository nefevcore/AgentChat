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
import { WS_SEND, WS_EVENT } from '../core/events/contract';
import { isBackgroundRunSource } from '@agentchat/protocol';
import { fetchGroupHistory } from '../core/api/endpoints/groups';
import { fetchPairHistory } from '../core/api/endpoints/runs';
import { registerEventHandler, dispatchEvent } from '../core/registry/eventHandlers';
import { traceSwitch, histReqSentAt } from '../utils/switchTrace';
import {
  type DialogId, type DialogKind, directDialog, groupDialog, singleDialog, parseDialogId,
  mergeHistoryPage, buildTurnsIncremental, type TurnsMemo, lastStreaming, closeAllStreaming,
  groupMessageToChatMessage, pairMessageToChatMessage,
} from '../utils/feed';

const HISTORY_PAGE_SIZE = 5;
const GROUP_HISTORY_PAGE_SIZE = 50;
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
  /** 事件类型：message | tool | event | group */
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
  /** 增量 turns 状态：完成轮次复用对象身份，避免每个 token 全列表重渲染 */
  const _turnsMemo = new Map<DialogId, TurnsMemo>();
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
  /** resume 快照已合并的 dialog：防重复 subscribe 二次追加；历史首屏重载
   *  （mergeHistory isFirstPage 整体替换）时清除，允许重载后按最新快照重新合并 */
  const resumeMerged = new Set<DialogId>();
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 当前活跃对话（direct 由 agents store 派生；group/single 由 App 显式设置，优先）──
  const activeGroupId = ref('');
  const activeSingleId = ref('');
  /** single 会话 → 目标 Agent（消息 agent_id 的正确身份源；激活时登记） */
  const _singleAgent: Record<string, string> = {};
  const activeDialogId = computed<DialogId | null>(() => {
    if (activeSingleId.value) return singleDialog(activeSingleId.value);
    if (activeGroupId.value) return groupDialog(activeGroupId.value);
    const a = useAgentStore().activeAgentId;
    return a ? directDialog(a) : null;
  });
  const activeDialog = computed<DialogFeed | null>(() =>
    activeDialogId.value ? dialogs.value[activeDialogId.value] ?? null : null
  );
  const activeAgentId = computed(() => useAgentStore().activeAgentId);

  /**
   * dialog → 消息归属 Agent id（流式占位/活动记录的身份源）。
   * direct = key 本身；single = 激活时登记的 agentId（key 是 sessionId，
   * 直接用会导致消息 sender 显示成 session-id）；group = key（gid）。
   */
  function agentKeyOf(id: DialogId): string {
    const { kind, key } = parseDialogId(id);
    if (kind === 'single') return _singleAgent[key] ?? key;
    return key;
  }

  /** 激活群聊对话（与 direct/single 互斥） */
  function setActiveGroup(groupId: string) {
    activeGroupId.value = groupId;
    activeSingleId.value = '';
  }
  /** 取消群聊激活（回到 direct） */
  function clearActiveGroup() {
    activeGroupId.value = '';
  }
  /** 激活独立会话对话（与 direct/group 互斥；agentId = 消息身份源，激活时登记） */
  function setActiveSingle(sessionId: string, agentId?: string) {
    activeSingleId.value = sessionId;
    activeGroupId.value = '';
    if (agentId) _singleAgent[sessionId] = agentId;
  }
  /** 取消独立会话激活（回到 direct） */
  function clearActiveSingle() {
    activeSingleId.value = '';
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
  /** 结构性变更（增删/替换/截断/整体替换）→ 失效增量 turns memo，下次派生全量重建 */
  function invalidateTurns(id: DialogId) {
    _turnsMemo.delete(id);
  }
  function touch(id: DialogId, agentId: string, content: string, ts: number) {
    const d = dialogs.value[id];
    if (!d) return;
    if (ts > d.lastActivity) d.lastActivity = ts;
    d.lastMessage = { role: 'agent', content: content.slice(0, 80), agentId, ts };
  }

  // ── 派生 turns（memo：仅该 dialog 版本变化时重算；增量复用完成轮次对象身份）──
  function getTurns(id: DialogId): ComputedRef<Turn[]> {
    let c = _turnsCache.get(id);
    if (!c) {
      c = computed<Turn[]>(() => {
        void _version.value[id];
        const d = dialogs.value[id];
        if (!d) return [];
        const memo = buildTurnsIncremental(_turnsMemo.get(id) ?? null, d.rawMessages);
        _turnsMemo.set(id, memo);
        return memo.turns;
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
    invalidateTurns(id);
    bump(id);
  }
  function replaceMessage(id: DialogId, msgId: string, patch: Partial<ChatMessage>) {
    const d = dialogs.value[id];
    if (!d) return;
    const idx = d.rawMessages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    d.rawMessages[idx] = { ...d.rawMessages[idx], ...patch };
    invalidateTurns(id);
    bump(id);
  }
  function truncateAfter(id: DialogId, index: number) {
    const d = dialogs.value[id];
    if (!d) return;
    d.rawMessages = d.rawMessages.slice(0, index + 1);
    invalidateTurns(id);
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
    invalidateTurns(id);
    bump(id);
  }
  /** 整体替换 rawMessages（编辑/重新推理等场景） */
  function setRaw(id: DialogId, msgs: ChatMessage[]) {
    const d = ensureById(id);
    d.rawMessages = msgs;
    invalidateTurns(id);
    bump(id);
  }

  // ── 未读 ──
  function clearUnread(id: DialogId) {
    const d = dialogs.value[id];
    if (d) d.unread = 0;
  }
  /** 获取指定 Agent 的未读消息数量 */
  function getUnreadCount(agentId: string): number {
    return dialogs.value[directDialog(agentId)]?.unread ?? 0;
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
  /** 每个 history 目标（session ?? agentId）最新发出的 requestId：响应回显后
   *  与之比对，不匹配即在途旧请求的迟到响应（快速切换/大历史量时响应到达序
   *  ≠ 发送序）——直接丢弃，防止旧分页被当作首屏合并进刚重置的分区。 */
  const _historyReq: Record<string, string> = {};
  function loadHistory(dialogId: DialogId, from: string, to: string, session?: string) {
    const d = ensureById(dialogId);
    d.status = 'loading';
    d.hasMore = false;
    d.offset = 0;
    const key = session ?? to;
    _historyOffset[key] = 0;
    const reqId = uid('histreq');
    _historyReq[key] = reqId;
    histReqSentAt.set(reqId, performance.now());
    traceSwitch('req', `首屏 ${dialogId} reqId=${reqId.slice(-6)}`);
    useWebSocketStore().send(WS_SEND.historyRequest, {
      from, to, limit: HISTORY_PAGE_SIZE, offset: 0, requestId: reqId,
      ...(session ? { session } : {}),
    });
  }
  function loadMoreHistory(dialogId: DialogId) {
    const d = dialogs.value[dialogId];
    if (!d || d.status === 'loading' || !d.hasMore) return;
    const parsed = parseDialogId(dialogId);
    const agentId = parsed.key;
    d.status = 'loading';
    _historyOffset[agentId] = (_historyOffset[agentId] || 0) + HISTORY_PAGE_SIZE;
    const reqId = uid('histreq');
    _historyReq[agentId] = reqId;
    histReqSentAt.set(reqId, performance.now());
    traceSwitch('req-more', `offset=${_historyOffset[agentId]} ${dialogId} reqId=${reqId.slice(-6)}`);
    useWebSocketStore().send(WS_SEND.historyRequest, {
      from: VIEWER_ID.value, to: agentId, limit: HISTORY_PAGE_SIZE, offset: _historyOffset[agentId],
      requestId: reqId,
      ...(parsed.kind === 'single' ? { session: agentId } : {}),
    });
  }
  function mergeHistory(dialogId: DialogId, msgs: ChatMessage[], isFirstPage: boolean): DialogFeed | null {
    const d = dialogs.value[dialogId];
    if (!d) return null;
    const mergeT0 = performance.now();
    d.status = 'ready';
    const agentId = parseDialogId(dialogId).key;
    d.hasMore = msgs.filter(m => m.agent_id === VIEWER_ID.value).length >= HISTORY_PAGE_SIZE;
    const prevOffset = _historyOffset[agentId] || 0;
    // 首屏整体替换前，摘出仍在流式的尾部占位（切走再切回时正在生成的回复）。
    // 整体替换会把占位 wipe 掉 → lastStreaming 找不到载体 → 后续 delta 静默
    // 丢弃，直到 stepEnd 才恢复（表现为"切回后正在生成的回复消失/冻结"）。
    let streamingTail: ChatMessage[] = [];
    if (isFirstPage && d.streaming) {
      streamingTail = d.rawMessages.filter(m => m.isStreaming || m.role === 'tool' && !m.content);
    }
    const { merged: deduped, userCount } = mergeHistoryPage(msgs, d.rawMessages, isFirstPage, VIEWER_ID.value);
    const nextRaw = isFirstPage
      ? (streamingTail.length > 0 && !deduped.some(m => m.isStreaming) ? [...deduped, ...streamingTail] : deduped)
      : deduped;
    if (prevOffset > 0) _historyOffset[agentId] = prevOffset - HISTORY_PAGE_SIZE + userCount;
    d.rawMessages = nextRaw;
    // 首屏整体替换：重置 resume 合并标记（切走再切回/刷新竞态后允许按快照重新合并）
    if (isFirstPage) resumeMerged.delete(dialogId);
    invalidateTurns(dialogId);
    bump(dialogId);
    traceSwitch('merge', `${dialogId} ${isFirstPage ? '首屏' : '续拉'} → ${nextRaw.length} 条，merge 耗时 ${(performance.now() - mergeT0).toFixed(1)}ms`);
    return d;
  }

  /** 对外单值：当前活跃 dialog 的加载态（兼容旧接口） */
  const loadingHistory = computed(() => activeDialog.value?.status === 'loading');
  const hasMoreHistory = computed(() => activeDialog.value?.hasMore ?? false);

  // ── 群组历史（REST /api/groups/:id/history，分页：最新 50 + 上翻更早）──
  async function loadGroupHistory(dialogId: DialogId, groupId: string) {
    const d = ensureById(dialogId);
    d.status = 'loading';
    // 记录 fetch 起点：期间到达的实时消息（WS group.message push）在整体替换时
    // 会被旧快照吞掉（凭空消失）——摘出活尾部追加到新页之后
    const preLen = d.rawMessages.length;
    try {
      const data = await fetchGroupHistory(groupId);
      const msgs = (data.messages ?? []).map(groupMessageToChatMessage);
      const liveTail = d.rawMessages.slice(preLen);
      d.rawMessages = liveTail.length > 0 ? [...msgs, ...liveTail] : msgs;
      d.offset = msgs.length;
      // 只有拉满一页才可能还有更早历史；空群聊/短群聊 hasMore=false，
      // 避免 direct 自动续拉逻辑在群聊空态无限递归（DialogView 已另加守卫）。
      d.hasMore = msgs.length >= GROUP_HISTORY_PAGE_SIZE;
      d.status = 'ready';
      invalidateTurns(dialogId);
      bump(dialogId);
    } catch {
      d.status = 'ready';
    }
  }

  /** 上翻加载更早群组历史：前插并返回新增消息（调用方负责保持滚动位置） */
  async function loadOlderGroupHistory(dialogId: DialogId, groupId: string): Promise<ChatMessage[] | null> {
    const d = dialogs.value[dialogId];
    if (!d || d.status === 'loading' || !d.hasMore) return null;
    try {
      const data = await fetchGroupHistory(groupId, d.offset);
      const older = (data.messages ?? []).map(groupMessageToChatMessage);
      if (older.length > 0) {
        d.rawMessages = [...older, ...d.rawMessages];
        d.offset += older.length;
        invalidateTurns(dialogId);
        bump(dialogId);
      }
      return older;
    } catch {
      return null;
    }
  }

  // ── pair（Agent 会话对只读视角）：REST /api/history 分页灌入分区 ──
  const PAIR_HISTORY_PAGE_SIZE = 50;

  /** 加载会话对历史（首屏：整体替换；a/b 端点任意顺序） */
  async function loadPairHistory(dialogId: DialogId, a: string, b: string) {
    const d = ensureById(dialogId);
    d.status = 'loading';
    try {
      const data = await fetchPairHistory(a, b, PAIR_HISTORY_PAGE_SIZE, 0);
      const msgs = (data.messages ?? []).map(m => pairMessageToChatMessage(m, a));
      d.rawMessages = msgs;
      d.offset = msgs.length;
      d.hasMore = msgs.length >= PAIR_HISTORY_PAGE_SIZE;
      d.status = 'ready';
      invalidateTurns(dialogId);
      bump(dialogId);
    } catch {
      d.status = 'ready';
    }
  }

  /** 上翻加载更早会话对历史：前插并返回新增消息（调用方保持滚动位置） */
  async function loadOlderPairHistory(dialogId: DialogId, a: string, b: string): Promise<ChatMessage[] | null> {
    const d = dialogs.value[dialogId];
    if (!d || d.status === 'loading' || !d.hasMore) return null;
    try {
      const data = await fetchPairHistory(a, b, PAIR_HISTORY_PAGE_SIZE, d.offset);
      const older = (data.messages ?? []).map(m => pairMessageToChatMessage(m, a));
      if (older.length > 0) {
        d.rawMessages = [...older, ...d.rawMessages];
        d.offset += older.length;
        invalidateTurns(dialogId);
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
  // active 参数 = 事件是否属于当前查看的 Agent：仅门控【全局 UI 信号】
  // （turnInProgress / lastRunEndAt / archivePending）；dialog 分区状态
  // （streaming 标志 / 流式占位 / 收尾关闭）必须与查看上下文无关地处理——
  // 生命周期开/关事件若按"当前查看的 Agent"门控，用户在运行中途切换会话后
  // 谓词结果改变，stepEnd/chatEnd 被跳过 → 分区 streaming 永远为 true
  // （表现为列表头像光环不熄灭）。
  function onStepStart(id: DialogId | null, active: boolean) {
    if (!id) return;
    if (active) markActive();
    const d = ensureById(id);
    d.streaming = true;
    // 重复 step.start（WS 重连重放/事件重发）不再追加第二个空占位——
    // 空占位叠加即"测/测试双气泡"问题的另一入口
    const msgs = d.rawMessages;
    const last = msgs[msgs.length - 1];
    if (!(last && last.role === 'agent' && last.isStreaming && !last.content && !(last.thinking || last.reasoning_content))) {
      msgs.push(newAssistant(agentKeyOf(id)));
    }
    bump(id);
  }
  function onStepEnd(id: DialogId | null, data: any, active: boolean) {
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const asst = lastStreaming(msgs, 'agent'); if (asst) asst.isStreaming = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'tool' && msgs[i].isStreaming) msgs[i].isStreaming = false;
    }
    d.streaming = false;
    bump(id);
    if (data.interrupted) onInterrupted(id, active);
    if (active) scheduleDone(msgs);
  }
  function onThinkingStart(id: DialogId | null, data: any, active = true) {
    if (!id) return;
    // 全局 turnInProgress 只由当前查看会话的事件点亮——后台会话的 thinking
    // 不再影响当前视图的思维链折叠时机（TurnDisplayItem 据此折叠）
    if (active) markActive();
    const msgs = ensureById(id).rawMessages;
    let asst = lastStreaming(msgs, 'agent');
    if (asst && ((asst.thinking || asst.reasoning_content || '').trim())) {
      // 双 thinking.start（重连重放）：先关闭旧占位再开新占位——旧占位残留
      // isStreaming=true 会让派生 step 恒流式（折叠栏强制展开、dots 不灭）
      asst.isStreaming = false;
      asst = newAssistant(agentKeyOf(id));
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
    // bump 目标 = 事件所属 Agent（bumpAgent 固定打给"当前激活 Agent"，
    // 后台 Agent 流式完成时会把别人的回复写进激活项的列表预览/排序）
    if (asst.content) useAgentStore().bumpAgentById(agentKeyOf(id), 'assistant', asst.content);
    recordActivity({
      dialogId: id, agentId: agentKeyOf(id),
      summary: (asst.content || '').slice(0, 60), event: 'message',
    });
    bump(id);
  }
  function onMessageError(id: DialogId | null, data: any, active: boolean) {
    if (active) turnInProgress.value = false;
    if (!id) return;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    // 分区流式态回落（sendMessage 发送即置位；run 失败无 stepEnd 时防止 contextBusy 卡死）
    const d = dialogs.value[id];
    if (d) {
      d.streaming = false;
      // 同步关闭流式占位：run 硬失败没有后续 stepEnd/chatEnd 收尾，
      // 占位 isStreaming 残留会让打字动画常转、增量 turns 无法落定
      const msgs = d.rawMessages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'agent' && m.isStreaming) {
          m.isStreaming = false;
          if (!m.content?.trim()) m.content = '⚠️ (生成失败)';
        }
      }
      closeAllStreaming(msgs);
    }
    // 与持久化统一：role='error' 走红色错误分隔符（buildTurns 独立 system turn）
    append(id, {
      id: `error-${Date.now()}`, role: 'error', content: errMsg,
      isStreaming: false, timestamp: Date.now(),
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
      tool_call_id: prepId, arguments: {},
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
        existing.arguments = data.arguments;
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
      existing.arguments = data.arguments;
      if (asst) addToolCall({ id: data.tool_call_id, name: data.tool_name, arguments: data.arguments, result: '', label: data.label || data.tool_name, running: true, startTime: Date.now() });
    } else {
      msgs.push({
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id, arguments: data.arguments,
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
    // 精确按 tool_call_id 匹配占位：并行工具调用时"最后一条流式 tool"可能
    // 是另一个调用——按位置关闭会把 X 的 result 写进 Y 的占位（Y 永远 running）
    let closedById = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' && m.tool_call_id === data.tool_call_id) {
        m.content = data.result ?? ''; m.isStreaming = false; closedById = true; break;
      }
    }
    // 兼容回退：旧事件无 tool_call_id 时退回位置匹配（单工具场景等价）
    if (!closedById && !data.tool_call_id) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'tool' && m.toolName && m.isStreaming) { m.content = data.result ?? ''; m.isStreaming = false; break; }
      }
    }
    const asst = lastStreaming(msgs, 'agent') ?? [...msgs].reverse().find(m => m.role === 'agent' && m.toolCalls?.length) ?? null;
    const tc = toolCallsOf(asst).find((x: any) => x.id === data.tool_call_id);
    if (tc) { tc.running = false; tc.result = data.result ?? ''; }
    bump(id);
  }
  function onToolUpdate(id: DialogId | null, data: any) {
    if (!id) return;
    const d = ensureById(id);
    const msgs = d.rawMessages;
    // 优先按 tool_call_id 精确匹配（并行工具调用时位置匹配会写错目标）
    let existing: ChatMessage | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'tool' && msgs[i].tool_call_id === data.tool_call_id) { existing = msgs[i]; break; }
    }
    if (!existing && !data.tool_call_id) existing = lastStreaming(msgs, 'tool');
    if (existing) existing.content += data.delta ?? '';
    // 同步 toolCalls 的 result —— turns 派生的 ToolMessage 内容来自 assistant.toolCalls
    const asst = lastStreaming(msgs, 'agent');
    const tc = toolCallsOf(asst).find((x: any) => x.id === data.tool_call_id);
    if (tc) tc.result = (tc.result || '') + (data.delta ?? '');
    bump(id);
  }
  function onInterrupted(id: DialogId | null, active: boolean) {
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
    if (active) scheduleDone(msgs);
  }
  function onChatEnd(id: DialogId | null, data: any, active: boolean) {
    if (!id) return;
    const d = ensureById(id);
    const content = typeof data?.content === 'string' ? data.content : '';
    let fallbackAdded = false;

    // 兜底：chat.message.* 增量事件丢失时，用 chat.end 携带的最终内容补出回复，
    // 避免「发送后无流式回复、刷新后才能看到」。
    if (content) {
      const msgs = d.rawMessages;
      const streaming = lastStreaming(msgs, 'agent');
      const alreadyHas = msgs.some((m) => m.role === 'agent' && m.content === content && !m.isStreaming);
      if (streaming && !streaming.content.trim()) {
        streaming.content = content;
        streaming.isStreaming = false;
        fallbackAdded = true;
      } else if (!alreadyHas) {
        msgs.push({
          id: uid('final'),
          role: 'agent',
          content,
          agent_id: agentKeyOf(id),
          isStreaming: false,
          timestamp: Date.now(),
        });
        fallbackAdded = true;
      }
    }

    d.streaming = false;
    closeAllStreaming(d.rawMessages);
    bump(id);
    if (fallbackAdded) {
      const agentId = agentKeyOf(id);
      useAgentStore().bumpAgentById(agentId, 'assistant', content);
      recordActivity({
        dialogId: id, agentId,
        summary: content.slice(0, 60), event: 'message',
      });
    }
    if (active) scheduleDone(d.rawMessages);
  }

  // ── 会话恢复 ──
  function onSessionResume(d: any) {
    if (!d.active) return;
    resumeSnapshot = d;
    // 快照带 session id（chat.subscribe data.session 的回显）：精确路由到该
    // single 分区——同 Agent 多个 single 会话并存时按 agentId 猜会把 A 会话
    // 的流式快照并进 B 会话（串台）；历史未到时先挂起，由 onHistory 首屏补合。
    if (d.session) {
      const sid = String(d.session);
      const dialogId = singleDialog(sid);
      const raw = dialogs.value[dialogId]?.rawMessages;
      if (raw && raw.length > 0) {
        turnInProgress.value = true;
        mergeResumeSnapshot(d, dialogId);
      }
      return;
    }
    // 旧载荷（无 session id）：按激活上下文 _singleAgent 路由（best effort）
    const sid = activeSingleId.value;
    if (sid && (_singleAgent[sid] ?? '') === d.agentId) {
      turnInProgress.value = true;
      const dialogId = singleDialog(sid);
      const raw = dialogs.value[dialogId]?.rawMessages;
      if (raw && raw.length > 0) mergeResumeSnapshot(d, dialogId);
      return;
    }
    if (d.agentId === activeAgentId.value) {
      turnInProgress.value = true;
      const dialogId = directDialog(d.agentId);
      const raw = dialogs.value[dialogId]?.rawMessages;
      if (raw && raw.length > 0) {
        mergeResumeSnapshot(d, dialogId);
      }
    }
  }
  /** 将 resume 快照（未落盘的当前轮）追加进 rawMessages（turns 由派生自动生成）。
   *  target：目标分区（single 恢复传 singleDialog(sid)；缺省 direct）。
   *
   *  与已落盘前缀对齐（去重）：run 进行中时已完成的步骤会实时 checkpoint 到
   *  messages.jsonl（toolExecutionStart/stepEnd），刷新后 history 首屏会带回
   *  这些消息，快照里同一段不能重复追加：
   *    ① userMessages：同内容 viewer 消息已存在 → 跳过；
   *    ② steps（仅已归档步骤）：当前轮已落盘 assistant 数 k，前 min(k, steps.length)
   *       个步骤已在历史 → 跳过；
   *    ③ 进行中部分（由顶层 content/thinking/phase/toolCallId 承载）：分区里已有
   *       流式载体（直播占位/已落盘前缀）→ 原地续流（长度取胜，不回卷直播已
   *       渗出的内容）；否则新建占位。绝不新建第二个占位——旧占位会冻结在
   *       部分内容，表现为「测 / 测试」双气泡堆叠。
   *  兼容：旧后端载荷把进行中步骤并入 steps 尾部（与顶层 content/thinking
   *  同源同值）——按镜像特征剔除，双端版本错位时不破。 */
  function mergeResumeSnapshot(d: any, target?: DialogId) {
    resumeSnapshot = null;
    turnInProgress.value = true;
    const dialogId = target ?? directDialog(d.agentId);
    if (resumeMerged.has(dialogId)) return;
    resumeMerged.add(dialogId);
    const msgs = ensureById(dialogId).rawMessages;

    // 当前轮在 raw 中已落盘的范围：最后一条 viewer 消息之后
    let lastViewerIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].agent_id === VIEWER_ID.value) { lastViewerIdx = i; break; }
    }
    const turnMsgs = lastViewerIdx >= 0 ? msgs.slice(lastViewerIdx + 1) : [];
    let lastTurnAsst: ChatMessage | null = null;
    for (const m of turnMsgs) {
      if (m.role === 'agent' && m.agent_id === d.agentId) lastTurnAsst = m;
    }
    const persistedAssistants = turnMsgs.filter(m => m.role === 'agent' && m.agent_id === d.agentId).length;

    // ① 当前轮用户消息（postHook 前未落盘）：同内容已落盘则跳过
    const userMsgs = (d.userMessages && d.userMessages.length > 0)
      ? d.userMessages
      : (d.userMessage ? [{ content: d.userMessage, ts: d.userMessageTs || Date.now() }] : []);
    const viewerTexts = new Set(msgs.filter(m => m.agent_id === VIEWER_ID.value).map(m => m.content));
    for (const um of userMsgs) {
      if (viewerTexts.has(um.content)) continue;
      msgs.push({
        id: uid('user'), role: 'agent', content: um.content,
        timestamp: um.ts || Date.now(), agent_id: VIEWER_ID.value,
      });
    }

    // ② 已完成的 ReAct 步骤（跳过已落盘部分）。
    // 旧载荷兼容：进行中步骤曾被并入 steps 尾部，与顶层 content/thinking
    // 同源同值——按镜像特征剔除（全空步骤不剔：tools-only 已完成步骤
    // content/thinking 也为空，误剔会丢工具记录）。
    const rawSteps: any[] = d.steps || [];
    const lastRaw = rawSteps[rawSteps.length - 1];
    const mirrorsCurrent = !!lastRaw
      && ((lastRaw.content || '') !== '' || (lastRaw.thinking || '') !== '')
      && (lastRaw.content || '') === (d.content || '')
      && (lastRaw.thinking || '') === (d.thinking || '');
    const steps: any[] = (mirrorsCurrent ? rawSteps.slice(0, -1) : rawSteps).map((s: any) => ({
      thinking: s.thinking || '',
      label: s.label || '',
      tool_calls: (s.tool_calls || []).map((tc: any) => ({
        id: tc.id, name: tc.name || '', arguments: tc.arguments || {}, result: tc.result || '', label: tc.label || tc.name || '',
      })),
      content: s.content || '',
      ts: s.ts || Date.now(),
    }));
    const skipSteps = Math.min(persistedAssistants, steps.length);
    for (const s of steps.slice(skipSteps)) {
      if (s.content || s.thinking || s.tool_calls?.length) {
        const stepMsgId = uid('asst');
        msgs.push({
          id: stepMsgId, role: 'agent', content: s.content || '',
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

    // ③ 进行中的 assistant（当前正在流式的部分）：优先复用已有载体
    let asst: ChatMessage;
    if (persistedAssistants > steps.length && lastTurnAsst) {
      // 最后一条落盘 assistant = currentStep 的已落盘前缀：原地续流。
      // 长度取胜：subscribe 往返期间直播 delta 可能已渗出更长的内容，
      // 按快照整体覆盖会"回卷"（丢已渗出尾巴，后续 delta 追加即重复）。
      asst = lastTurnAsst;
      asst.isStreaming = true;
      if ((d.content || '').length > (asst.content || '').length) asst.content = d.content;
      if ((d.thinking || '').length > (asst.thinking || asst.reasoning_content || '').length) {
        asst.thinking = d.thinking;
        asst.reasoning_content = d.thinking;
      }
      if (d.label) asst.label = d.label;
    } else {
      // 直播分区已有流式占位（切回运行中的 Agent 的即时合并路径）：复用它，
      // 不得新建第二个占位——旧占位会冻结在部分内容（堆叠根因）。
      let live: ChatMessage | null = null;
      for (let i = turnMsgs.length - 1; i >= 0; i--) {
        const m = turnMsgs[i];
        if (m.role === 'agent' && m.agent_id === d.agentId && m.isStreaming) { live = m; break; }
      }
      if (live) {
        asst = live;
        if ((d.content || '').length > (asst.content || '').length) asst.content = d.content;
        if ((d.thinking || '').length > (asst.thinking || asst.reasoning_content || '').length) {
          asst.thinking = d.thinking;
          asst.reasoning_content = d.thinking;
        }
        if (d.label && !asst.label) asst.label = d.label;
      } else {
        asst = newAssistant(d.agentId);
        asst.thinking = d.thinking || undefined;
        asst.reasoning_content = d.thinking || undefined;
        asst.content = d.content || '';
        asst.label = d.label || undefined;
        msgs.push(asst);
      }
    }
    if (d.phase === 'tool' && d.toolCallId) {
      // 复用落盘前缀时 toolCalls 里已有该调用（含真实 id）：只标记 running，避免重复条目
      const tcs = toolCallsOf(asst);
      const existing = tcs.find((tc: any) => tc.id === d.toolCallId);
      if (existing) {
        existing.running = true;
        if (d.label) existing.label = existing.label || d.label;
      } else {
        tcs.push({ id: d.toolCallId, name: d.toolName || '', arguments: {}, result: '', label: d.label || d.toolName || '', running: true, startTime: Date.now() });
      }
      if (!msgs.some(m => m.role === 'tool' && m.tool_call_id === d.toolCallId)) {
        msgs.push({
          id: `tool-${d.toolCallId}`, role: 'tool', content: '',
          name: d.toolName, toolName: d.toolName,
          label: d.label || d.toolName,
          isStreaming: true, timestamp: Date.now(),
        });
      }
    }
    bump(dialogId);
    logger.info(`[FeedStore] 已恢复 ${d.agentId} 的活跃会话（${dialogId}，phase=${d.phase}, steps=${steps.length}（跳过已落盘 ${skipSteps}）, content=${(d.content || '').length}chars）`);
  }

  // ── 历史响应 ──
  /** 在途旧请求的迟到响应（requestId 与该目标最新发出的不一致）→ 丢弃。
   *  旧后端响应无 requestId 回显时放行（兼容，仅失去该保护）。
   *  丢弃后分区状态可能停留在 loading，由更新请求自己的响应负责回落。 */
  function isStaleHistoryResponse(key: string, data: any): boolean {
    if (!data?.requestId) return false;
    const latest = _historyReq[key];
    return !!latest && data.requestId !== latest;
  }

  function onHistory(data: any) {
    // 追踪：响应到达时刻 + 往返耗时（req 发出 → resp 到达）+ stale 判定
    const reqId = data?.requestId ? String(data.requestId) : '';
    const sentAt = reqId ? histReqSentAt.get(reqId) : undefined;
    const rtt = sentAt !== undefined ? `往返 ${(performance.now() - sentAt).toFixed(0)}ms` : '无发出时刻（旧后端无回显）';
    histReqSentAt.delete(reqId);
    // 独立会话历史（后端回显 session）：路由到 single dialog（offset 按 session 维度）
    if (data.session) {
      const sid = String(data.session);
      if (isStaleHistoryResponse(sid, data)) {
        traceSwitch('resp-stale', `single:${sid.slice(-8)} reqId=${reqId.slice(-6)} 丢弃（${rtt}）`);
        return;
      }
      const dialogId = singleDialog(sid);
      const msgs = (data.messages ?? []).map(historyMsgToChatMessage);
      traceSwitch('resp', `single:${sid.slice(-8)} ${msgs.length} 条，${rtt}`);
      const isFirstPage = (_historyOffset[sid] || 0) === 0;
      mergeHistory(dialogId, msgs, isFirstPage);
      // 首屏加载后合并 resume 快照（single 当前轮未落盘部分；
      // 订阅响应先于历史到达时在此补合，与 direct 路径对齐）。
      // 快照带 session id 时精确匹配；旧载荷回退 agentId 比对
      if (isFirstPage && resumeSnapshot) {
        const snapSid = resumeSnapshot.session ? String(resumeSnapshot.session) : null;
        const matched = snapSid !== null
          ? snapSid === sid
          : (_singleAgent[sid] ?? '') === resumeSnapshot.agentId;
        if (matched) mergeResumeSnapshot(resumeSnapshot, dialogId);
      }
      return;
    }
    const target = data.agentId || activeAgentId.value;
    if (!target) return;
    if (isStaleHistoryResponse(target, data)) {
      traceSwitch('resp-stale', `${target} reqId=${reqId.slice(-6)} 丢弃（${rtt}）`);
      return;
    }
    const dialogId = directDialog(target);
    const msgs = (data.messages ?? []).map(historyMsgToChatMessage);
    traceSwitch('resp', `${target} ${msgs.length} 条，${rtt}`);
    const isFirstPage = (_historyOffset[target] || 0) === 0;
    mergeHistory(dialogId, msgs, isFirstPage);
    // 初次加载完成后，合并 resume 快照（当前轮未落盘消息）
    if (isFirstPage && resumeSnapshot && resumeSnapshot.agentId === target) {
      mergeResumeSnapshot(resumeSnapshot);
    }
  }

  /** 后端 PersistedMessage → 前端 ChatMessage（历史加载共用） */
  function historyMsgToChatMessage(m: any): ChatMessage {
    return {
      id: m.message_id ?? uid('hist'),
      role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id, toolCalls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      source: m.source,
      timestamp: new Date(m.timestamp ?? Date.now()).getTime(),
    };
  }

  // ── 事件路由 ──
  function eventAgentId(d: any): string { return d?.agentId || d?.agent || ''; }
  /** 仅当事件的 sender 为当前用户时才处理流式输出，防止其他 Agent 的推理结果串台 */
  function isForCurrentUser(d: any): boolean {
    return !d?.sender || d.sender === VIEWER_ID.value;
  }
  /** 门控 Agent（UI 信号用）：single 视角 = 该会话登记的目标 Agent（而非 direct
   *  列表选中项——旧逻辑用 direct 选中项门控，用户先选过别的 Agent 再进 single
   *  会话时 stepStart 被跳过 → 分区里没有流式占位 → 正文增量全部丢弃，
   *  表现为「前端不识别流式输出」，回复一次性弹出或完全不显示）；
   *  direct 视角 = 列表选中 Agent；未知（未登记）= 不门控（放行）。 */
  const gatingAgentId = computed<string | null>(() => {
    const sid = activeSingleId.value;
    if (sid) return _singleAgent[sid] ?? null;
    return useAgentStore().activeAgentId;
  });
  /** UI 信号门控：仅当前查看会话的 Agent 更新全局指示器（turnInProgress/
   *  archivePending/lastRunEndAt）。注意：只门控全局信号——dialog 分区状态
   *  （streaming/流式占位/收尾）必须上下文无关地处理，否则运行中途切换会话
   *  会导致开/关事件失去配对（光环卡死，见 onStepStart 注释）。 */
  function isForActiveAgent(d: any): boolean {
    const a = gatingAgentId.value;
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
   *  - single~sid：独立会话（P3）；属于用户发起的会话，放行
   *  - 无 dialogId：旧事件，放行（由 agentId 兜底）
   */
  function isUserDialog(d: any): boolean {
    const dialogId = d?.dialogId;
    if (!dialogId || typeof dialogId !== 'string') return true;
    if (dialogId.startsWith('group~')) return false;
    if (dialogId.startsWith('single~')) return true;
    if (dialogId.startsWith('chat~')) return dialogId.split('~').includes(VIEWER_ID.value);
    return true;
  }

  /** 从事件载荷解析目标 dialog（single~sid → single dialog；其余 agentId → direct） */
  function resolveDialogId(data: any): DialogId | null {
    const backendDialog = data?.dialogId;
    if (typeof backendDialog === 'string' && backendDialog.startsWith('single~')) {
      return singleDialog(backendDialog.slice('single~'.length));
    }
    const agentId = eventAgentId(data);
    return agentId ? directDialog(agentId) : null;
  }

  /**
   * 消息类事件处理器注册表（扩展点：新事件 = 在此注册）。
   * 由 init() 统一注册到 core/registry/eventHandlers，WS 单一分发。
   */
  const FEED_HANDLERS: Array<[string, (data: any) => void]> = [
    // C1：后端 chat.start 下发 hint/source（hint/source 来自 meta['chat.start']）。
    // 事件内容统一由 source 元数据驱动（summary 优先）；是否后台/自主推理由
    // isBackgroundRunSource(source) 分类，不再使用 isTrigger 布尔标记。
    [WS_EVENT.chatStart, (data) => {
      const source = data.source as ChatMessage['source'] | undefined;
      const dialogId = resolveDialogId(data);
      if (!isUserDialog(data)) return;
      // 与生命周期事件同策略：hint/活动记录写入目标分区（与查看上下文无关），
      // 仅 archivePending（全局 UI 信号）门控到当前查看的 Agent
      if (isBackgroundRunSource(source)) {
        if (isForActiveAgent(data) && source?.kind === 'archive') archivePending.value = true;
        if (dialogId) {
          // 时间线分隔符展示完整 hint（支持多行换行）；source.summary 只用于列表/活动摘要
          const content = typeof data.hint === 'string' && data.hint
            ? data.hint
            : source?.summary ?? '';
          append(dialogId, {
            id: uid('event'),
            role: 'event',
            content,
            agent_id: data.sender || 'system',
            source,
            timestamp: Date.now(),
          });
          recordActivity({
            dialogId, agentId: data.sender || 'system',
            summary: (source?.summary ?? content).slice(0, 60), event: 'event',
          });
        }
      }
    }],
    [WS_EVENT.chatStepStart, (data) => { const d = resolveDialogId(data); if (isUserDialog(data)) onStepStart(d, isForActiveAgent(data)); }],
    [WS_EVENT.chatStepEnd, (data) => { const d = resolveDialogId(data); if (isUserDialog(data)) onStepEnd(d, data, isForActiveAgent(data)); }],
    [WS_EVENT.chatInterrupted, (data) => { const d = resolveDialogId(data); if (isUserDialog(data)) onInterrupted(d, isForActiveAgent(data)); }],
    [WS_EVENT.chatEnd, (data) => {
      const d = resolveDialogId(data);
      if (!isUserDialog(data)) return;
      const active = isForActiveAgent(data);
      if (active) { archivePending.value = false; lastRunEndAt.value = Date.now(); }
      onChatEnd(d, data, active);
    }],
    // 流式内容：始终写入目标 dialog 缓冲，不受 isForActiveAgent 限制（但防串台 + 防自言自语）
    [WS_EVENT.chatMessageStart, () => { /* 预留 */ }],
    [WS_EVENT.chatMessageUpdate, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onMessageUpdate(d, data); }],
    [WS_EVENT.chatMessageEnd, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onMessageEnd(d, data); }],
    [WS_EVENT.chatMessageError, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onMessageError(d, data, isForActiveAgent(data)); }],
    [WS_EVENT.chatThinkingStart, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onThinkingStart(d, data, isForActiveAgent(data)); }],
    [WS_EVENT.chatThinkingUpdate, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onThinkingUpdate(d, data); }],
    [WS_EVENT.chatThinkingEnd, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onThinkingEnd(d, data); }],
    [WS_EVENT.chatToolcallStart, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onToolcallStart(d, data); }],
    [WS_EVENT.chatToolcallUpdate, (data) => { if (isUserDialog(data) && isForCurrentUser(data)) markActive(); }],
    [WS_EVENT.chatToolcallEnd, (data) => { if (isUserDialog(data) && isForCurrentUser(data)) markActive(); }],
    [WS_EVENT.chatToolExecutionStart, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onToolStart(d, data); }],
    [WS_EVENT.chatToolExecutionUpdate, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onToolUpdate(d, data); }],
    [WS_EVENT.chatToolExecutionEnd, (data) => { const d = resolveDialogId(data); if (isUserDialog(data) && isForCurrentUser(data)) onToolEnd(d, data); }],
    [WS_EVENT.chatSessionResume, (data) => onSessionResume(data)],
    [WS_EVENT.historyResponse, (data) => onHistory(data)],
    // 群聊消息：Agent 在群组中说话 → 写入对应 group dialog（与 direct 同池）
    [WS_EVENT.groupMessage, (data) => {
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
    }],
    // 虚拟 Agent 收到消息 → 实时推送到对应 Agent 对话中（发送方 Agent 主动发给 user）。
    // 会话键必须用发送方 data.from（真实 Agent），而非接收方 data.agent（=user 虚拟 Agent）：
    // 否则消息被写进 direct:user 快照，用户在发送方对话里看不到（历史重载才正常）。
    [WS_EVENT.chatVirtualReceive, (data) => {
      const vAgentId = data?.from || data?.agent;
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
    }],
  ];

  /** 兼容入口：按事件类型分发到注册表 */
  function ingest(type: string, data: any) {
    dispatchEvent(type, data);
  }

  // ── 注册 WS 消息路由（单一分发点）──
  function init() {
    const ws = useWebSocketStore();
    ws.init();
    for (const [type, fn] of FEED_HANDLERS) registerEventHandler(type, fn);
    ws.onMessage((type, data) => ingest(type, data));
    // 重连后清理：断线期间发出的 history.request 已随旧连接作废（status 残留
    // 'loading' 永久堵死分页）；断线中丢失 stepEnd/chatEnd 的分区也要关闭
    // 残留的流式占位（否则 typing 动画常转、turns 派生恒流式）
    ws.onConnect(() => {
      for (const d of Object.values(dialogs.value)) {
        if (d.status === 'loading') d.status = 'ready';
        if (d.streaming) {
          d.streaming = false;
          closeAllStreaming(d.rawMessages);
          bump(d.id);
        }
      }
    });
  }

  return {
    // state / 派生
    dialogs, activeDialogId, activeDialog, activeAgentId, activeGroupId, activeSingleId,
    setActiveGroup, clearActiveGroup, setActiveSingle, clearActiveSingle,
    activity,
    turnInProgress, lastRunEndAt, archivePending,
    unreadAgents, getUnreadCount, loadingHistory, hasMoreHistory,
    getDialog, getRaw, getTurns,
    // 原语
    ensureById, append, removeMessage, replaceMessage, truncateAfter, resetDialog, setRaw,
    clearUnread, touch, bump,
    // 历史
    loadHistory, loadMoreHistory, mergeHistory,
    loadGroupHistory, loadOlderGroupHistory, loadPairHistory, loadOlderPairHistory,
    // 事件
    ingest, init,
  };
});
