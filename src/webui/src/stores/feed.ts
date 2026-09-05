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
import { useAgentStore } from './agents';
import { logger } from '../utils/logger';
import { VIEWER_ID } from '../constants';
import { isBackgroundRunSource } from '@agentchat/protocol';
import { fetchGroupHistory } from '../api/groups';
import { fetchPairHistory } from '../api/runs';
import { wireRpc } from '../api/wire';
import { toHistoryMessages } from '../api/runs';
import {
  routeDialog, isUserConversation, streamOf, parseArgs, stringifyToolResult, errText,
  historyPage, historyServed, chatPresence,
  type StreamState,
} from '../api/chat-ops';
import { traceSwitch, histReqSentAt } from '../utils/switchTrace';
import {
  type DialogId, type DialogKind, directDialog, groupDialog, singleDialog, parseDialogId,
  pairPartnerOf, pairHasViewer, bucketKey, fmtElapsed,
  mergeHistoryPage, buildTurnsIncremental, type TurnsMemo, lastStreaming, closeAllStreaming,
  groupMessageToChatMessage, pairMessageToChatMessage, attachmentFilesOf, splitAttachmentLines,
} from '../utils/feed';

const HISTORY_PAGE_SIZE = 5;
const GROUP_HISTORY_PAGE_SIZE = 50;
const TURN_DONE_DELAY = 300;
const MAX_ACTIVITY = 500;

/** 全局活动条目（社区流 / 星图 / 会话列表排序的单一来源） */
interface ActivityEntry {
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
interface DialogFeed {
  id: DialogId;
  kind: DialogKind;
  /** pair: 对端 agentId（viewer 相对；group: null） */
  partner: string | null;
  /**
   * 流式帧的 run 目标 Agent（M19）：非 viewer 对桶（a|b）没有确定的对端
   * 身份，按最近一次帧的 agentId 记录（占位气泡/头像身份源）；
   * viewer 对桶用 pairPartnerOf 即可，本字段仅兜底。
   */
  streamAgent?: string;
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
  /**
   * 归档整理 run 进行中的对话（2026-09-04 认知缺口修复）：机制 run 流式
   * 隐藏（不扰民）但边界帧对隐藏 run 也广播（ws-bridge：run-started /
   * after-run 恒转发）——据此维护"正在整理"集合。archivePending（活跃
   * 对话是否整理中）供输入框占位与会话头状态条点亮；原全局 ref 从未被
   * 置 true（死路径），本次以活跃对话判定收编。
   */
  const archiveReviewing = ref<ReadonlySet<DialogId>>(new Set());
  const archivePending = computed(() => {
    const id = activeDialogId.value;
    return id !== null && archiveReviewing.value.has(id);
  });

  /** 归档整理 run 信封 meta 键（对齐 ac-agent-loop ARCHIVE_REVIEW_META） */
  const ARCHIVE_REVIEW_META_KEY = 'archive-review';

  /** 自会话桶判定（a~a 对角线——机制 run 的隐藏面；与 ws-bridge 同口径） */
  function isSelfPairConversation(conversationId: string | undefined): boolean {
    if (!conversationId || !conversationId.includes('~')) return false;
    const [a, b] = conversationId.split('~');
    return a === b;
  }

  /** 归档整理态登记（边界帧驱动；不可变替换保响应） */
  function markArchiveReview(id: DialogId, on: boolean): void {
    const cur = archiveReviewing.value;
    if (on === cur.has(id)) return;
    const next = new Set(cur);
    if (on) next.add(id);
    else next.delete(id);
    archiveReviewing.value = next;
  }

  let resumeSnapshot: any = null;
  /** resume 快照已合并的 dialog：防重复 subscribe 二次追加；历史首屏重载
   *  （mergeHistory isFirstPage 整体替换）时清除，允许重载后按最新快照重新合并 */
  const resumeMerged = new Set<DialogId>();
  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 当前活跃对话（pair 由 agents store 派生；group/single 由 App 显式设置，优先）──
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
   * pair = 对端（viewer 相对另一端；非 viewer 对用 streamAgent 兜底）；
   * single = 激活时登记的 agentId（key 是 sessionId，直接用会导致消息
   * sender 显示成 session-id）；group = key（gid）。
   */
  function agentKeyOf(id: DialogId): string {
    const { kind, key } = parseDialogId(id);
    if (kind === 'single') return _singleAgent[key] ?? key;
    if (kind === 'pair') {
      const d = dialogs.value[id];
      if (d?.streamAgent) return d.streamAgent;
      return pairPartnerOf(key);
    }
    return key;
  }

  /** 流式帧路由入站：登记 run 目标身份（非 viewer 对桶的身份源） */
  function noteStreamAgent(keys: { dialogId: DialogId; agentId?: string }): void {
    if (!keys.agentId) return;
    const d = ensureById(keys.dialogId);
    d.streamAgent = keys.agentId;
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
      dialogs.value = {
        ...dialogs.value,
        [id]: blankDialog(id, kind, kind === 'pair' ? pairPartnerOf(key) : null),
      };
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
        // run 级流式态参与派生（d.streaming 跨步边界不熄灭，覆盖步间
        // 静默窗口——上一步 after-step 关闭消息级标记后、下一步
        // step-started 前的整个 LLM API 往返期，final 仍须悬置）
        const memo = buildTurnsIncremental(_turnsMemo.get(id) ?? null, d.rawMessages, d.streaming);
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
    _settlementReload.delete(id);
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
  /** 兼容旧接口：有未读的 viewer 直答对桶的对端 agent 集合 */
  const unreadAgents = computed<Set<string>>(() => {
    const s = new Set<string>();
    for (const [id, d] of Object.entries(dialogs.value)) {
      if (d.unread > 0) {
        const { kind, key } = parseDialogId(id as DialogId);
        if (kind === 'pair' && pairHasViewer(key)) s.add(pairPartnerOf(key));
      }
    }
    return s;
  });

  // ── 历史分页 ──
  /** 每个 history 目标（session ?? agentId）最新发出的 requestId：响应回显后
   *  与之比对，不匹配即在途旧请求的迟到响应（快速切换/大历史量时响应到达序
   *  ≠ 发送序）——直接丢弃，防止旧分页被当作首屏合并进刚重置的分区。 */
  const _historyReq: Record<string, string> = {};
  /** run 进行中做过历史首屏合并的分区（直播行 live-wins 保留，无
   *  persistedMsgId）：run 收束后重拉首屏换权威收束行（吸收 partial、携带
   *  全部结果与消息 id）。 */
  const _settlementReload = new Set<DialogId>();
  /** run 收束 → 延迟重拉首屏（500ms 让收束行 flush 落盘；期间新 run 开跑也
   *  无害——合并自带 live-wins 对齐）。矩阵 pair（不含 viewer）走
   *  loadPairHistory（对桶两端寻址），直答/single 走常规 loadHistory。 */
  function scheduleSettlementReload(dialogId: DialogId, conversationId: string | undefined) {
    if (!_settlementReload.delete(dialogId)) return;
    setTimeout(() => {
      const { kind, key } = parseDialogId(dialogId);
      if (kind === 'group') return;
      if (kind === 'pair' && !pairHasViewer(key)
        && conversationId && conversationId.includes('~') && conversationId.split('~').length === 2) {
        const [a, b] = conversationId.split('~');
        void loadPairHistory(dialogId, a, b);
        return;
      }
      loadHistory(dialogId, VIEWER_ID.value, agentKeyOf(dialogId), kind === 'single' ? key : undefined);
    }, 500);
  }
  /** 历史加载（Port B 直连）：session/history RPC + 轮次 offset → 消息游标换算；
   *  响应处理复用 onHistory（stale 判定/首屏合并/resume 补合全保留）。
   *  M19：直答会话键 = pairKey(viewer, to)（与后端边界同款推导）；single = sid。 */
  function requestHistoryPage(to: string, session: string | undefined, srcOffset: number, reqId: string) {
    const base = historyPage(session, to, srcOffset);
    const conversationId = session ?? bucketKey(VIEWER_ID.value, to);
    void wireRpc.call<{ records?: unknown[] }>('session/history', { ...base, conversationId })
      .then((r) => {
        const records = (r.records ?? []) as Array<Record<string, unknown>>;
        historyServed(session, to, records.length);
        onHistory({
          messages: toHistoryMessages(records as never, conversationId),
          agentId: to,
          ...(session ? { session } : {}),
          requestId: reqId,
        });
      })
      .catch((err: unknown) => {
        logger.warn('[FeedStore] 历史加载失败', err);
        const dialogId = session ? singleDialog(session) : directDialog(to);
        const d = dialogs.value[dialogId];
        if (d && d.status === 'loading') d.status = 'ready';
      });
  }

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
    requestHistoryPage(to, session, 0, reqId);
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
    requestHistoryPage(agentId, parsed.kind === 'single' ? agentId : undefined, _historyOffset[agentId], reqId);
  }
  function mergeHistory(dialogId: DialogId, msgs: ChatMessage[], isFirstPage: boolean): DialogFeed | null {
    const d = dialogs.value[dialogId];
    if (!d) return null;
    const mergeT0 = performance.now();
    d.status = 'ready';
    const agentId = parseDialogId(dialogId).key;
    d.hasMore = msgs.filter(m => m.agent_id === VIEWER_ID.value).length >= HISTORY_PAGE_SIZE;
    const prevOffset = _historyOffset[agentId] || 0;
    // 首屏整体替换前，保留活跃 run 的直播行。直播行是工具结果的【唯一】载体
    // ——后端 run 进行中只落 partial 检查点行（result 恒 null，结果在收束行
    // 才落盘），整体替换若丢直播行：已完成步的工具卡永久转圈、续流新步正常
    // OK——同名工具连排时视觉即"同一调用两张卡"（2026-09-04 反馈）。
    // 保留范围 = 本 run 全部直播行（最后一条 viewer 消息之后，不只流式占位
    // ——已完成步的直播结果同样只在内存里）；历史页中同 run 的行按
    // tool_call_id 识别剔除，防同一调用两张卡。
    let streamingTail: ChatMessage[] = [];
    let liveRunInFlight = false;
    if (isFirstPage) {
      // run 进行中判定：分区流式标志或任何流式占位/未闭合工具行（onStepEnd
      // 在步间短暂置 false——工具执行窗口内靠占位兜住）
      const inFlight = d.streaming
        || d.rawMessages.some(m => m.isStreaming || (m.role === 'tool' && !m.content));
      if (inFlight) {
        liveRunInFlight = true;
        let lastUserIdx = -1;
        for (let i = d.rawMessages.length - 1; i >= 0; i--) {
          if (d.rawMessages[i].agent_id === VIEWER_ID.value) { lastUserIdx = i; break; }
        }
        streamingTail = d.rawMessages.slice(lastUserIdx + 1);
        const liveIds = new Set(streamingTail.map(m => m.tool_call_id).filter((x): x is string => !!x));
        msgs = msgs.filter(m => {
          if (m.role === 'tool' && m.tool_call_id && liveIds.has(m.tool_call_id)) return false;
          if (m.role === 'agent' && Array.isArray(m.toolCalls)
            && (m.toolCalls as any[]).some(tc => tc?.id && liveIds.has(tc.id))) return false;
          return true;
        });
      }
    }
    if (liveRunInFlight) _settlementReload.add(dialogId); // 收束后重拉（收束行是权威）
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
    // streaming 是 run 级信号（忙态投递/停止按钮/光环）：本步带工具调用
    // → 工具即将执行、下一步必来，run 仍在途中不熄灭。后端 after-step
    // 先于工具执行——步边界熄灭会让整个工具执行窗口被判空闲（忙时
    // Enter 直插 next-step）。熄灭点 = 自然收束步（无工具调用）/ after-run
    // / 中断 / 错误——run 终止路径恒有边界帧兜底。
    if (!Array.isArray(data?.toolCalls) || data.toolCalls.length === 0) d.streaming = false;
    bump(id);
    if (data.interrupted) onInterrupted(id, active);
    if (active) scheduleDone(msgs);
  }
  function onThinkingStart(id: DialogId | null, data: any, active = true) {
    if (!id) return;
    // 全局 turnInProgress 只由当前查看会话的事件点亮（全局忙态指示：停止
    // 按钮/输入手势等；思维链折叠已不随流式收束翻转，与该信号无关）
    if (active) markActive();
    const msgs = ensureById(id).rawMessages;
    let asst = lastStreaming(msgs, 'agent');
    if (asst && ((asst.thinking || asst.reasoning_content || '').trim())) {
      // 双 thinking.start（重连重放）：先关闭旧占位再开新占位——旧占位残留
      // isStreaming=true 会让派生 step 恒流式（思考消息恒「思考中」、dots 不灭）
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
  /** 思考收束：按流内记录的思考相位起点（首个 reasoning 片到达时刻）定格
   *  「已思考 | XmYs」label 写到消息上——耗时随消息驻留分区 rawMessages，
   *  跨步重建/组件重挂载不丢失；无起点（WS 重连重放等）或不足 1s → 清空
   *  label（组件回落「已思考」）。收束时机 = 首个非 reasoning 片（正文/
   *  工具调用）或 delta-end。 */
  function closeThinking(id: DialogId | null, st: StreamState) {
    st.reasoningClosed = true;
    const startAt = st.reasoningStartAt;
    st.reasoningStartAt = 0;
    const elapsedMs = startAt ? Date.now() - startAt : 0;
    onThinkingEnd(id, {
      label: elapsedMs >= 1000 ? `已思考 | ${fmtElapsed(elapsedMs / 1000)}` : undefined,
    });
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
    // 后台 Agent 流式完成时会把别人的回复写进激活项的列表预览/排序）。
    // 仅 viewer 参与会话：agent 对/自会话（矩阵格）不进 agent⇋viewer 名册
    if (asst.content && isViewerDialog(id)) {
      useAgentStore().bumpAgentById(agentKeyOf(id), 'assistant', asst.content);
      recordActivity({
        dialogId: id, agentId: agentKeyOf(id),
        summary: (asst.content || '').slice(0, 60), event: 'message',
      });
    }
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
          if (!m.content?.trim()) m.content = '(生成失败)';
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
      const prepRowId = prep.id; // prep-… 原始占位 id（重命名前捕获——占位行按它精确配对）
      prep.id = data.tool_call_id;
      prep.preparing = false;
      prep.arguments = data.arguments;
      prep.label = data.label || data.tool_name;
      const existing = lastStreaming(msgs, 'tool');
      if (existing && existing.tool_call_id === prepRowId) {
        existing.id = `tool-${data.tool_call_id}`;
        existing.tool_call_id = data.tool_call_id;
        existing.label = data.label || data.tool_name;
        existing.arguments = data.arguments;
      }
      bump(id);
      return;
    }
    // 占位复用仅限【同一调用重放】（tool_call_id 相同）：按名字匹配会把同名
    // 并行调用的前一个占位抢走（如并行建两个 destination——第一个调用的
    // 结果再无落点，卡片永久转圈，2026-09-04 "只有最后一个 OK"反馈）。
    const existing = lastStreaming(msgs, 'tool');
    if (existing && existing.tool_call_id === data.tool_call_id) {
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
    if (fallbackAdded && isViewerDialog(id)) {
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
      // [附件] 行剥离：快照正文是发送时的合成形（含路径行），历史行已剥
      // 离——同走剥离后比较/上屏，去重不失效、气泡与历史同形
      const split = splitAttachmentLines(String(um.content ?? ''));
      if (viewerTexts.has(split.content)) continue;
      msgs.push({
        id: uid('user'), role: 'agent', content: split.content,
        timestamp: um.ts || Date.now(), agent_id: VIEWER_ID.value,
        ...(split.files ? { files: split.files } : {}),
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
    // [附件] 行剥离（刷新后与实况同形）：正文尾部的合成路径行 → chips
    //（LLM 侧不动——落盘正文与非视觉模型的 read 路径原样保留）
    const split = splitAttachmentLines(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      attachmentFilesOf(m.attachments),
    );
    return {
      id: m.message_id ?? uid('hist'),
      role: m.role, content: split.content,
      agent_id: m.agent_id, toolCalls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      source: m.source,
      // 附件引用 → chips（多模态：text=ref 即 workspace 路径，点击可预览）
      ...(split.files ? { files: split.files } : {}),
      timestamp: new Date(m.timestamp ?? Date.now()).getTime(),
    };
  }

  // ── 事件路由 ──
  function eventAgentId(d: any): string { return d?.agentId || d?.agent || ''; }
  /** 流式输出处理门控（M19）：viewer 发起的 run（sender=viewer）照常；
   *  非 viewer 对桶（矩阵格子视角）的流式帧是本分区内容，同样放行——
   *  其余（他人发起且落 viewer 会话的帧）拦截，防推理结果串台。 */
  function isForCurrentUser(d: any): boolean {
    if (!d?.sender || d.sender === VIEWER_ID.value) return true;
    const id = d?.dialogId as DialogId | undefined;
    if (id) {
      const { kind, key } = parseDialogId(id);
      if (kind === 'pair' && !pairHasViewer(key)) return true;
    }
    return false;
  }
  /** 分区是否为 viewer 参与会话（名册条目/活动记录的归属面）：
   *  pair 不含 viewer = agent⇄agent 委托或 a~a 自会话（矩阵格）——其消息
   *  只进该只读分区，不 bump 名册（AgentList 条目即 agent⇋viewer 会话，
   *  自会话回复曾以 lastMessage 形式"串"进用户会话列表）。group/single
   *  均为 viewer 表面。 */
  function isViewerDialog(id: DialogId | null | undefined): boolean {
    if (!id) return false;
    const { kind, key } = parseDialogId(id);
    if (kind !== 'pair') return true;
    return pairHasViewer(key);
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
  /** UI 信号门控：仅当前查看会话的运行更新全局指示器（turnInProgress/
   *  archivePending/lastRunEndAt）。两重判定：
   *  ① 分区级（2026-08-28 反馈 #1）：帧路由到的 dialog ≠ 激活 dialog → 不算——同
   *  Agent 的自会话（a~a）/委托（a~b）run 点亮 viewer 会话的"生成中"即
   *  串台；无 dialogId 的载荷退回 ②。
   *  ② Agent 级（原判定）：事件 Agent = 激活上下文 Agent。
   *  注意：只门控全局信号——dialog 分区状态（streaming/流式占位/收尾）
   *  必须上下文无关地处理，否则运行中途切换会话会导致开/关事件失去
   *  配对（光环卡死，见 onStepStart 注释）。 */
  function isForActiveAgent(d: any): boolean {
    const id = d?.dialogId as DialogId | null | undefined;
    const active = activeDialogId.value;
    if (id && active && id !== active) return false;
    const a = gatingAgentId.value;
    if (!a) return true;
    const eventAgent = d?.agentId || d?.agent;
    if (!eventAgent) return true;
    return eventAgent === a;
  }

  /** 会话归属判定（Port B：preview 帧载荷）：群会话键（gid~agent 或 gid）
   *  的过程流不进 1v1——群正式消息走 group/message-posted；其余放行。 */
  function frameAgentId(a: unknown): string | undefined {
    return typeof a === 'string' && a ? a : undefined;
  }

  /**
   * preview 事件帧 → 分区路由与状态机分发（阶段二第六梯换血：
   * 原FEED_HANDLERS 的 src chat.* 词汇全部替换为 preview 事件名，
   * 载荷提取经 api/chat-ops 的 routeDialog/工具累积/字符串化；
   * 状态机处理函数（onStepStart 等）与三关语义原样保留）。
   */
  const streams = new Map<string, StreamState>();

  // ── busy 排队发送的回显登记 ──
  // DSH queue 语义（2026-09-06 顺序反馈）：Agent 运行中发送 → 消息进
  // next-turn 队列，本地【不上屏】（此前立即 append 造成"既在 QueueDock
  // 又在会话流"的双现，插在在途回复中间渲染顺序错乱）；消息只住排队
  // dock，消费投递（当前 run 结束后作为独立 run 经 router.send）时的
  // router/message-received 回显才落会话流——位置恰在新 run 流式之前。
  // 登记键 = 剥离 [附件] 行后的正文（与回显侧同规格化）；计数制——同文
  // 排队多条时每条回显各消费一次（内容查重无法区分同文多条）。
  const queuedEchoPending = new Map<DialogId, Map<string, number>>();

  /** busy 排队发送登记（sendMessage 排队路径调用；回显到来时补气泡） */
  function registerQueuedSend(id: DialogId, content: string): void {
    let m = queuedEchoPending.get(id);
    if (!m) {
      m = new Map();
      queuedEchoPending.set(id, m);
    }
    m.set(content, (m.get(content) ?? 0) + 1);
  }
  /** 消费一条登记（命中即减计）；未登记返回 false */
  function takeQueuedSend(id: DialogId, content: string): boolean {
    const m = queuedEchoPending.get(id);
    const n = m?.get(content) ?? 0;
    if (n <= 0) return false;
    if (n <= 1) m!.delete(content);
    else m!.set(content, n - 1);
    return true;
  }
  /** 回退登记：投递失败 / 排队条目被插话或删除（回显不再到来），防同文
   *  后续回显经登记命中误补重复气泡 */
  function dropQueuedSend(id: DialogId, content: string): void {
    takeQueuedSend(id, content);
  }

  /** viewer 自己的发送回显上屏（busy 排队消息消费投递时刻）：
   *  · 排队登记命中 → 上屏（同文多次排队各补各的）；
   *  · 未登记但同文 viewer 气泡已在场 → 本地已上屏（普通发送/重新推理/
   *    编辑路径），跳过——登记优先于在场判定：登记对应"确有一条未上屏
   *    的已投递消息"，与在场气泡不互斥；
   *  · 两者皆否（刷新后登记丢失 / 别处 tab 同账号发送）→ 上屏。
   *  正文与历史/快照同规格：尾部 [附件] 行剥回 chips。 */
  function showOwnEcho(
    dialogId: DialogId,
    message: { content?: unknown; attachments?: unknown },
    payload: string,
  ): void {
    const split = splitAttachmentLines(
      payload,
      attachmentFilesOf(message.attachments as Array<{ kind?: string; ref?: string; filename?: string }> | undefined),
    );
    const already = (dialogs.value[dialogId]?.rawMessages ?? []).some((m) =>
      m.agent_id === VIEWER_ID.value
      && splitAttachmentLines(String(m.content ?? '')).content === split.content);
    if (!takeQueuedSend(dialogId, split.content) && already) return;
    append(dialogId, {
      id: uid('user'), role: 'agent', content: split.content,
      timestamp: Date.now(), agent_id: VIEWER_ID.value,
      ...(split.files ? { files: split.files } : {}),
    });
  }

  /** 入站消息上屏（router/message-received 与 conversation/steered 共用）：
   *  viewer 自己的发送：普通发送/插话本地已上屏 → 跳过；busy 排队消息
   *  本地不上屏（只住 QueueDock）——消费投递的回显在 showOwnEcho 补气泡。
   *  其余（Agent→viewer 私信 / agent⇄agent 委托或注入）按对桶路由进对应
   *  pair 分区实时显示 + 未读。 */
  function showInbound(
    agent: string | undefined,
    message: { content?: unknown; name?: unknown; attachments?: unknown },
    conversationId: string | undefined,
    from: string,
  ): void {
    if (!from) return;
    const keys = routeDialog(agent, conversationId, from);
    if (!keys) return;
    // 群分区唯一内容源 = group/message-posted 的 post 行——入站帧不进群
    // 视图（2026-09-04 反馈：等待群回复时逐成员 hint 信封被渲染成 N-1 条
    // 「<msg …>…</msg>\n[当前时间]」幽灵消息，刷新即消失——与落盘历史
    // 无对应；服务端桥接面已同口径过滤，此处为前端兜底）
    if (parseDialogId(keys.dialogId).kind === 'group') return;
    const payload = String(message?.content ?? '');
    const dialogId = keys.dialogId;
    if (from === VIEWER_ID.value) {
      showOwnEcho(dialogId, message, payload);
      return;
    }
    const d = ensureById(dialogId);
    d.rawMessages.push({
      id: uid('msg'), role: 'agent', content: payload, agent_id: from, timestamp: Date.now(),
    });
    touch(dialogId, from, payload, Date.now());
    bump(dialogId);
    recordActivity({ dialogId, agentId: from, summary: payload.slice(0, 60), event: 'message' });
    // 未读与名册 bump 仅对 viewer 参与的对桶有意义（agent 对分区无
    // 列表入口；矩阵视角的实时性由本分区直接承载）
    const viewerRelevant =
      parseDialogId(dialogId).kind === 'pair' && pairHasViewer(parseDialogId(dialogId).key);
    if (viewerRelevant && dialogId !== activeDialogId.value) {
      d.unread += 1;
      useAgentStore().bumpAgentById(from, 'assistant', payload);
    }
  }

  /** 机制通知上屏（source='event' 入站——message-received 空闲路径与
   *  steered 忙路径共用）：系统事件行（分隔符渲染），与落盘 role:'event' /
   *  刷新历史同形。群分区同样不进（内容源 = post 行；群历史无 event 行）。 */
  function showEventNotice(agent: string | undefined, conversationId: string | undefined, content: string): void {
    const keys = routeDialog(agent, conversationId, agent);
    if (!keys) return;
    const dialogId = keys.dialogId;
    if (parseDialogId(dialogId).kind === 'group') return; // 群分区唯一内容源 = post 行
    const d = ensureById(dialogId);
    d.rawMessages.push({
      id: uid('msg'), role: 'event', content, agent_id: 'system', timestamp: Date.now(),
    });
    touch(dialogId, 'system', content, Date.now());
    bump(dialogId);
    if (isViewerDialog(dialogId) && dialogId !== activeDialogId.value) {
      d.unread += 1;
      useAgentStore().bumpAgentById(agentKeyOf(dialogId), 'assistant', content);
    }
  }

  function handleFrame(type: string, args: unknown[]): void {
    switch (type) {
      case 'loop/run-started': {
        // 边界帧（run-started/after-run）对隐藏 run 也恒转发：
        //   · 归档整理 run（meta[archive-review]）→ 点亮"正在整理"状态
        //     （流式仍隐藏，不打扰；光环语义不变）；
        //   · 可见 run → 点亮分区 streaming（run 级忙态信号：忙时 Enter
        //     排队/插话手势、停止按钮、头像光环的判定源）。后端 after-step
        //     先于工具执行，若 streaming 只在步内点亮，工具执行窗口
        //     （agentic run 的主要耗时）会被判空闲——忙态投递不带 lane，
        //     后端缺省 next-step+steer 直接插话进运行中 run（消息队列
        //     形同虚设）。run 边界恒广播，故以 run 为粒度点亮。
        const [request] = args as [any];
        const agent = frameAgentId(request?.agent);
        if (!isUserConversation(agent, request?.conversationId)) return;
        const keys = routeDialog(agent, request?.conversationId, request?.sender);
        if (!keys) return;
        if (request?.meta?.[ARCHIVE_REVIEW_META_KEY] === true) {
          markArchiveReview(keys.dialogId, true);
          return;
        }
        // 自会话桶（a~a）机制 run：桥接面隐藏其流式帧——不点亮 busy
        //（与 ws-bridge isHiddenRun 同口径）
        if (isSelfPairConversation(request?.conversationId)) return;
        const d = ensureById(keys.dialogId);
        if (!d.streaming) {
          d.streaming = true;
          bump(keys.dialogId);
        }
        return;
      }
      case 'loop/step-started': {
        const [agent, , , envelope] = args as [string | undefined, number, unknown, { conversationId?: string; sender?: string } | undefined];
        if (!isUserConversation(frameAgentId(agent), envelope?.conversationId)) return;
        const keys = routeDialog(frameAgentId(agent), envelope?.conversationId, envelope?.sender);
        if (keys) { noteStreamAgent(keys); onStepStart(keys.dialogId, isForActiveAgent(keys)); }
        return;
      }
      case 'llm/delta': {
        const [input, chunk, meta] = args as [any, any, any];
        const agent = frameAgentId(meta?.agent ?? input?.meta?.agent);
        const conv = meta?.conversationId ?? input?.meta?.conversationId;
        if (!isUserConversation(agent, conv)) return;
        const keys = routeDialog(agent, conv, meta?.sender ?? input?.meta?.sender);
        if (!keys || !isForCurrentUser(keys)) return;
        noteStreamAgent(keys);
        const st = streamOf(streams, keys.dialogId);
        const reasoning = typeof chunk?.reasoning === 'string' ? chunk.reasoning : '';
        if (reasoning) {
          if (!st.sawReasoning) {
            st.sawReasoning = true;
            // 思考相位起点：收束时定格「已思考 | XmYs」用
            st.reasoningStartAt = Date.now();
            // 思考消息 label 由组件按思考相位派生（思考中/已思考），不再写占位 label
            onThinkingStart(keys.dialogId, {}, isForActiveAgent(keys));
          }
          onThinkingUpdate(keys.dialogId, { delta: reasoning });
        }
        const delta = typeof chunk?.delta === 'string' ? chunk.delta : '';
        if (delta) {
          if (st.sawReasoning && !st.reasoningClosed) closeThinking(keys.dialogId, st);
          onMessageUpdate(keys.dialogId, { delta });
        }
        if (Array.isArray(chunk?.toolCalls)) {
          // 工具调用分片到场 = 模型离开思考相位（reasoning → tool_calls）
          if (st.sawReasoning && !st.reasoningClosed) closeThinking(keys.dialogId, st);
          for (const tc of chunk.toolCalls) {
            const idx = typeof tc?.index === 'number' ? tc.index : 0;
            // 只累积（id/name 首见建条目、argumentsDelta 拼接）——不建 preparing
            // 卡：delta-end 统一按 index 序建真 id 占位（onToolStart 的
            // preparing 升级链按 name 匹配最后一条流式 tool，多工具并存时失准）。
            // id/name 须非空：provider 的空冲洗片（"" id/name）不成为调用
            if (typeof tc?.id === 'string' && tc.id && typeof tc?.name === 'string' && tc.name && !st.tools.has(idx)) {
              st.tools.set(idx, { id: tc.id, name: tc.name, buf: '' });
            }
            const acc = st.tools.get(idx);
            if (acc && typeof tc?.argumentsDelta === 'string') acc.buf += tc.argumentsDelta;
          }
        }
        return;
      }
      case 'llm/delta-end': {
        const [input, meta] = args as [any, any];
        const agent = frameAgentId(meta?.agent ?? input?.meta?.agent);
        const conv = meta?.conversationId ?? input?.meta?.conversationId;
        if (!isUserConversation(agent, conv)) return;
        const keys = routeDialog(agent, conv, meta?.sender ?? input?.meta?.sender);
        if (!keys) return;
        noteStreamAgent(keys);
        const st = streams.get(keys.dialogId);
        streams.delete(keys.dialogId);
        if (!st) return;
        // 工具参数完成 → tool_execution.start 语义（升级 preparing 占位为真 id）
        for (const [, acc] of [...st.tools.entries()].sort((x, y) => x[0] - y[0])) {
          onToolStart(keys.dialogId, {
            tool_call_id: acc.id, tool_name: acc.name,
            arguments: parseArgs(acc.buf), label: acc.name,
          });
        }
        if (st.sawReasoning && !st.reasoningClosed) closeThinking(keys.dialogId, st);
        return;
      }
      case 'tool/progress': {
        const [call, chunk] = args as [any, string];
        const agent = frameAgentId(call?.agentId);
        if (!isUserConversation(agent, call?.conversationId)) return;
        const keys = routeDialog(agent, call?.conversationId);
        if (!keys || typeof call?.toolCallId !== 'string' || !isForCurrentUser(keys)) return;
        onToolUpdate(keys.dialogId, { tool_call_id: call.toolCallId, delta: String(chunk ?? '') });
        return;
      }
      case 'tool/after-execute': {
        const [call, result, error] = args as [any, any, unknown];
        const agent = frameAgentId(call?.agentId);
        if (!isUserConversation(agent, call?.conversationId)) return;
        const keys = routeDialog(agent, call?.conversationId);
        // toolCallId 须非空：空 id 是聚合层的幻影调用（unknown tool 错误），
        // 放行会经位置回退把错误结果写进别的工具占位
        if (!keys || typeof call?.toolCallId !== 'string' || !call.toolCallId || !isForCurrentUser(keys)) return;
        onToolEnd(keys.dialogId, { tool_call_id: call.toolCallId, result: stringifyToolResult(result, error) });
        return;
      }
      case 'llm/chat-error': {
        const [input, error] = args as [any, unknown];
        const agent = frameAgentId(input?.meta?.agent);
        const conv = input?.meta?.conversationId;
        if (!isUserConversation(agent, conv)) return;
        const keys = routeDialog(agent, conv, input?.meta?.sender);
        if (!keys) return;
        onMessageError(keys.dialogId, { content: errText(error) }, isForActiveAgent(keys));
        return;
      }
      case 'loop/after-step': {
        const [agent, step, envelope] = args as [string | undefined, any, { conversationId?: string; sender?: string } | undefined];
        if (!isUserConversation(frameAgentId(agent), envelope?.conversationId)) return;
        const keys = routeDialog(frameAgentId(agent), envelope?.conversationId, envelope?.sender);
        if (!keys) return;
        noteStreamAgent(keys);
        // 步终值：message.end（全量替换语义）+ step.end（关闭占位；
        // toolCalls 透传 = run 是否继续的判定依据——见 onStepEnd）
        if (isForCurrentUser(keys)) {
          onMessageEnd(keys.dialogId, { content: String(step?.text ?? ''), reasoning: String(step?.reasoning ?? '') });
        }
        onStepEnd(keys.dialogId, { interrupted: false, toolCalls: step?.toolCalls }, isForActiveAgent(keys));
        return;
      }
      case 'loop/after-run': {
        const [request, result] = args as [any, any];
        const agent = frameAgentId(request?.agent);
        if (!isUserConversation(agent, request?.conversationId)) return;
        const keys = routeDialog(agent, request?.conversationId, request?.sender);
        if (!keys) return;
        noteStreamAgent(keys);
        // 整理 run 收尾：状态条熄灭（完成反馈另由 archive/completed 驱动）
        if (request?.meta?.[ARCHIVE_REVIEW_META_KEY] === true) {
          markArchiveReview(keys.dialogId, false);
        }
        const finish = String(result?.finish ?? 'stop');
        if (finish === 'interrupted') {
          onInterrupted(keys.dialogId, isForActiveAgent(keys));
        } else if (finish === 'error') {
          onMessageError(keys.dialogId, { content: `生成失败：${errText(result?.error)}` }, isForActiveAgent(keys));
        }
        const active = isForActiveAgent(keys);
        if (active) { lastRunEndAt.value = Date.now(); }
        onChatEnd(keys.dialogId, { content: finish === 'stop' ? String(result?.text ?? '') : '' }, active);
        // run 进行中做过历史合并的分区：收束后重拉首屏（权威收束行替换
        // partial 检查点行与直播行，补 persistedMsgId 供编辑/删除定位）
        scheduleSettlementReload(keys.dialogId, request?.conversationId);
        return;
      }
      case 'system/restarting': {
        // 后端重启：在途整理 run 的 after-run 不会再来——集合清空防悬挂
        if (archiveReviewing.value.size > 0) archiveReviewing.value = new Set();
        return;
      }
      case 'group/message-posted': {
        const [groupId, message] = args as [string, any];
        if (!groupId || !message) return;
        const from = String(message.from ?? '');
        const gDialog = groupDialog(groupId);
        const gd = ensureById(gDialog);
        // [附件] 行剥离：群发正文由发送端合成（composeContent），live 帧
        // 也按 chips 呈现——与刷新后的群历史同形
        const posted = splitAttachmentLines(String(message.content ?? ''), attachmentFilesOf(message.attachments));
        gd.rawMessages.push({
          id: uid('msg'), role: 'agent', content: posted.content, agent_id: from, timestamp: Date.now(),
          ...(posted.files ? { files: posted.files } : {}),
        });
        touch(gDialog, from, posted.content, Date.now());
        bump(gDialog);
        recordActivity({ dialogId: gDialog, agentId: from, summary: posted.content.slice(0, 60), event: 'group' });
        return;
      }
      case 'router/message-received': {
        // M19 统一路由：说话人 = sender 端点 id。viewer 自己的发送（本地
        // 已上屏）跳过；其余（Agent→viewer 私信 / agent⇄agent 委托入站）
        // 按对桶路由进对应 pair 分区实时显示 + 未读。
        // source 全链一致性（2026-09-02 复评）：source='event'（机制通知，
        // 空闲路径）与 steered 忙路径/落盘 role:'event'/刷新历史同形——
        // 系统事件行（分隔符渲染），不显示成 sender 的普通消息。
        const [agentId, message, conversationId, sender, source] = args as
          [string, any, string, string?, string?, ...unknown[]];
        if (source === 'event') {
          const content = String(message?.content ?? '');
          if (content) showEventNotice(frameAgentId(agentId), conversationId, content);
          return;
        }
        const from =
          typeof sender === 'string' && sender
            ? sender
            : typeof message?.name === 'string' && message.name
              ? message.name
              : '';
        showInbound(frameAgentId(agentId), message, conversationId, from);
        return;
      }
      case 'conversation/steered': {
        // 会话忙时注入活跃 run 的消息（busy 发送 / 机制通知的 steer 通道）
        // ——不经 router/message-received（busy 时无该帧），需在此上屏：
        //  · viewer 自己的发送（busy 排队）本地已上屏 → 跳过；
        //  · source='event'（如后台任务完成通知）→ 系统事件行（与空闲
        //    路径/落盘/刷新同形）——此前该通道完全无人处理，通知静默丢失；
        //  · 其余（agent⇄agent 注入）与 message-received 同款 agent 行。
        const [agentId, message, conversationId, , sender, source] = args as
          [string, any, string, string, string?, string?, ...unknown[]];
        const from = typeof sender === 'string' && sender ? sender : '';
        if (from === VIEWER_ID.value) return;
        const content = String(message?.content ?? '');
        if (!content) return;
        if (source === 'event') {
          showEventNotice(frameAgentId(agentId), conversationId, content);
          return;
        }
        showInbound(frameAgentId(agentId), message, conversationId, from);
        return;
      }
      default:
        return; // 其余事件（agents/updated、archive/completed、plugin/* 等）由各自 store 订阅
    }
  }

  /** 测试/诊断入口：直接喂 preview 事件帧（参数序同事件目录） */
  function ingestFrame(type: string, args: unknown[]) {
    handleFrame(type, args);
  }

  // ── 订阅 wire 事件（单一分发点）──
  function init() {
    wireRpc.onWireEvent(handleFrame);
    // 重连后清理：断线期间发出的 history 请求已作废（status 残留 'loading'
    // 永久堵死分页）；断线中丢失收尾帧的分区也要关闭残留流式占位
    wireRpc.onWireOpen(() => {
      for (const d of Object.values(dialogs.value)) {
        if (d.status === 'loading') d.status = 'ready';
        if (d.streaming) {
          d.streaming = false;
          closeAllStreaming(d.rawMessages);
          bump(d.id);
        }
      }
      // 断线期间整理 run 的 after-run 帧丢失——"正在整理"态一并回落
      if (archiveReviewing.value.size > 0) archiveReviewing.value = new Set();
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
    // busy 排队发送回显登记（chat store 排队路径专用）
    registerQueuedSend, dropQueuedSend,
    // 历史
    loadHistory, loadMoreHistory, mergeHistory,
    loadGroupHistory, loadOlderGroupHistory, loadPairHistory, loadOlderPairHistory,
    // 事件
    ingestFrame, init, handleResume: onSessionResume,
  };
});
