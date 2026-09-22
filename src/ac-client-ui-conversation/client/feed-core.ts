// ============================================================
// ac-client-ui-conversation/client/feed-core.ts —— 统一信息流核心
//（M27 S2；M27.2-2 随 conversation 件出包）
//
// per-dialog 分区（scope 键 = conversationId 形态的 DialogId）+ 流式
// ingest 状态机 + 历史分页投影管线。归属 conversation 基础件
//（ConversationService.ctx.sessions.feed——§0.3 归属表）；双模门面
//（webui stores/feed.ts）回落独立实例供既有测试族（传 wireRpc）。
// M27.2-2：rpc 传输参数化（RpcClientFace 契约面注入——包不 import
// webui wire 胶水；onOpen 可选面 = 重连恢复链）。
// ============================================================
import { ref, computed, type ComputedRef } from 'vue';
import type { RpcClientFace } from 'ac-client-runtime';
import type { ChatMessage, Turn } from './types.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import type { RosterCore } from 'ac-client-ui-agents/client';
import { logger } from 'ac-client-ui-renderer/client/logger.ts';
import { VIEWER_ID } from './viewer.ts';
import { isBackgroundRunSource } from '@agentchat/protocol';
import { fetchGroupHistory, fetchPairHistory, toHistoryMessages } from './historyApi.ts';
import {
  routeDialog, isUserConversation, streamOf, parseArgs, stringifyToolResult, errText,
  historyPage, historyServed, chatPresence, extractPartialJsonString,
  type StreamState,
} from './chatOps.ts';
import { loadUnreadSnapshot, saveUnreadSnapshot } from './unreadStore.ts';
import { traceSwitch, histReqSentAt } from './switchTrace.ts';
import {
  type DialogId, type DialogKind, directDialog, groupDialog, singleDialog, parseDialogId,
  pairPartnerOf, pairHasViewer, bucketKey, fmtElapsed,
  mergeHistoryPage, buildTurnsIncremental, type TurnsMemo, lastStreaming, closeAllStreaming,
  groupMessageToChatMessage, pairMessageToChatMessage, attachmentFilesOf, splitAttachmentLines,
} from './feed.ts';

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
  /**
   * 首屏历史的会话文件指纹（size:mtimeMs；2026-09-19 切换重入优化）：
   * 服务端 session/history 首屏响应携带。切换会话重入时带上——文件未变
   * → 服务端 unchanged 短路（零读零序列化），前端保留现有渲染。分区
   * resetDialog/归档重载时清空（强制全量）。
   */
  historyFingerprint?: string;
  // 元数据（供列表/社区流/星图）
  lastActivity: number;
  lastMessage: { role: string; content: string; agentId: string; ts: number } | null;
  unread: number;
  streaming: boolean;
  /**
   * 本 run 计时状态（2026-12 计时反馈；run 级——每轮 run 独立，重置于
   * run-started。多轮会话不得从会话首条消息起算）：
   *   runStartAt         前端起点（run-started 帧到达时刻；过渡期计时源，
   *                      step-started 建占位时转驻消息）
   *   runAnchorMs        权威锚（截至最近步收束的整轮耗时；首步 = 前端
   *                      计时定格，后续步 = 前锚 + 相邻两步 step.ts 差分——
   *                      纯后端时钟域，客户端时钟偏差在差分中抵消）
   *   runAnchorBackendTs 锚对应的后端步收束时刻（step.ts；区间差分基准）
   */
  runStartAt?: number;
  runAnchorMs?: number;
  runAnchorBackendTs?: number;
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

/** createFeedCore 可选面：persistUnread = 未读快照持久化开关（缺省关）。
 *  生产路径（ConversationService）开：未读徽章刷新后经 localStorage
 *  单键 agentchat.unread 恢复；测试默认关——独立实例隔离，不互写快照。 */
export interface FeedCoreOptions {
  persistUnread?: boolean;
}

/** 信息流核心工厂（每次调用 = 独立状态实例；rpc = 宿主传输面——webui
 * 门面传 wireRpc，ConversationService 传 ctx.rpc；roster = 名册核心
 * 取用器（M28 §4.2：惰性解析——app 内 ctx.roster.core，缺省 useRosterCore；
 * 单测可显式注入 () => roster 隔离状态） */
export function createFeedCore(
  rpc: RpcClientFace,
  roster: () => RosterCore = useRosterCore,
  options: FeedCoreOptions = {},
) {
  const persistUnread = options.persistUnread === true;
  // ── State ──
  const dialogs = ref<Partial<Record<DialogId, DialogFeed>>>({});
  /** 版本号：rawMessages 变更时 bump，驱动派生 turns 重算 */
  const _version = ref<Record<DialogId, number>>({});

  // ── 未读持久化（persistUnread 开时生效）：工厂期水合 + 变更写穿 ──
  // 水合：恢复的分区只设 unread（不动 rawMessages/status——历史仍懒加载，
  // 徽章数据不触发拉取）；恢复后即视为本实例的当前态，后续增量/清除
  // 全量写回快照。非 viewer pair（矩阵只读分区）的未读无列表入口、
  // 徽章不消费——不恢复（与增量路径的 viewerRelevant 口径一致）。
  if (persistUnread) {
    const saved = loadUnreadSnapshot();
    if (saved) {
      for (const [id, n] of Object.entries(saved)) {
        if (n === undefined) continue;
        const { kind, key } = parseDialogId(id as DialogId);
        if (kind === 'pair' && !pairHasViewer(key)) continue;
        const d = ensureById(id as DialogId);
        d.unread = n;
      }
    }
  }
  /** 未读变更写穿：从 dialogs 全量投影「有未读」映射落盘（开开关时） */
  function persistUnreadNow(): void {
    if (!persistUnread) return;
    const counts: Partial<Record<DialogId, number>> = {};
    for (const [id, d] of Object.entries(dialogs.value)) {
      if (d && d.unread > 0 && isViewerDialog(id as DialogId)) counts[id as DialogId] = d.unread;
    }
    saveUnreadSnapshot(counts);
  }
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
  /**
   * 活跃会话最近一次步终值时刻（loop/after-step——工具步先于工具执行，
   * 长工具运行中即触发派生数据重取；此前挂 after-run 的 token 仪表
   * 刷新要等整轮收束）。仅活跃 Agent 的 run 置位；多工具 run 每步
   * 各置一次（幂等 bump，驱动 watch 重取）。
   */
  const lastStepEndAt = ref(0);
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
    const a = roster().activeAgentId.value;
    return a ? directDialog(a) : null;
  });
  const activeDialog = computed<DialogFeed | null>(() =>
    activeDialogId.value ? dialogs.value[activeDialogId.value] ?? null : null
  );
  const activeAgentId = computed(() => roster().activeAgentId.value);

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

  /** 激活群聊对话（与 direct/single 互斥）；进入即清该群未读
   *  （与 direct 点开 Agent 清未读同语义——名册群行徽章/活动栏聚合
   *  同源回落；调用方 ui-group selectGroup 三路径共用：列表点击/
   *  创建后自动选中/上次上下文恢复） */
  function setActiveGroup(groupId: string) {
    activeGroupId.value = groupId;
    activeSingleId.value = '';
    clearUnread(groupDialog(groupId));
  }
  /** 取消群聊激活（回到 direct） */
  function clearActiveGroup() {
    activeGroupId.value = '';
  }
  /** 激活独立会话对话（与 direct/group 互斥；agentId = 消息身份源，激活时登记）。
   *  进入即清该会话未读——与 setActiveGroup 进群清未读同语义：single 无名册
   *  行（名册只列 Agent/群），活动栏聚合徽章是唯一提示位，进会话不清会
   *  永久残留（2026-09-16 幽灵未读修复——此前该路径漏 clearUnread，
   *  后台 run 完成通知/机制事件计入后无任何清除路径，刷新还经快照恢复） */
  function setActiveSingle(sessionId: string, agentId?: string) {
    activeSingleId.value = sessionId;
    activeGroupId.value = '';
    if (agentId) _singleAgent[sessionId] = agentId;
    clearUnread(singleDialog(sessionId));
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
    d.historyFingerprint = undefined; // 重置（归档 compact/编辑后）：下次首屏强制全量
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
    if (d) {
      d.unread = 0;
      persistUnreadNow(); // 读位清除写穿（读即抹除，刷新不复活）
    }
  }
  /** 获取指定 Agent 的未读消息数量 */
  function getUnreadCount(agentId: string): number {
    return dialogs.value[directDialog(agentId)]?.unread ?? 0;
  }
  /** 兼容旧接口：有未读的 viewer 直答对桶的对端 agent 集合 */
  const unreadAgents = computed<Set<string>>(() => {
    const s = new Set<string>();
    for (const [id, d] of Object.entries(dialogs.value)) {
      if (d && d.unread > 0) {
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
  // gated=false（after-run 收束路径）：无条件重拉——一直开着的会话直播行
  // 未经历过历史合并，不重拉就永远换不成权威收束行（persistedMsgId 缺失
  // → 分支/编辑/删除按钮要刷新页面才出现，2026-12 分支功能反馈）。
  function scheduleSettlementReload(dialogId: DialogId, conversationId: string | undefined, gated = true) {
    if (gated && !_settlementReload.delete(dialogId)) return;
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
    // fingerprint 短路（2026-09-19）：首屏请求带分区现有指纹——文件未变时
    // 服务端 unchanged 轻载荷，本地分区原样保留（内容仍是最新：切走期间的
    // 新消息经 WS 直播帧持续路由进分区，不依赖历史通道）。
    const fpDialogId = session ? singleDialog(session) : directDialog(to);
    const fp = srcOffset === 0 ? dialogs.value[fpDialogId]?.historyFingerprint : undefined;
    void rpc.call<{ records?: unknown[]; hasMore?: boolean; unchanged?: boolean; fingerprint?: string }>('session/history', { ...base, conversationId, ...(fp !== undefined ? { fingerprint: fp } : {}) })
      .then((r) => {
        // 指纹命中：分区已是最新（status 回 ready；保留 rawMessages/未读）
        if (r.unchanged === true) {
          histReqSentAt.delete(reqId);
          const d = dialogs.value[fpDialogId];
          if (d && d.status === 'loading') d.status = 'ready';
          if (d && typeof r.fingerprint === 'string') d.historyFingerprint = r.fingerprint;
          return;
        }
        const records = (r.records ?? []) as Array<Record<string, unknown>>;
        historyServed(session, to, records.length);
        // 首屏指纹入库（下此重入短路用；服务端旧版无指纹字段则保持 undefined
        // ——重入退化为普通全量，行为不变）
        if (srcOffset === 0 && typeof r.fingerprint === 'string') {
          const d = dialogs.value[fpDialogId];
          if (d) d.historyFingerprint = r.fingerprint;
        }
        onHistory({
          messages: toHistoryMessages(records as never, conversationId),
          agentId: to,
          ...(session ? { session } : {}),
          requestId: reqId,
          // 服务端分页回显（M16）：hasMore = offset+limit < total（原始记录
          // 口径，精确）。透传给 mergeHistory 优先于页内 viewer 消息数
          // 启发式——single 机制驱动会话（timer/goal/子 Agent 接力）尾部
          // 整页可无 viewer 消息，启发式误判「没有更早历史」→ 上翻续拉
          // 被 hasMore 守卫挡死（2026-09 反馈：single 只见尾部消息）。
          ...(typeof r.hasMore === 'boolean' ? { serverHasMore: r.hasMore } : {}),
        });
      })
      .catch((err: unknown) => {
        logger.warn('[FeedStore] 历史加载失败', err);
        const dialogId = session ? singleDialog(session) : directDialog(to);
        const d = dialogs.value[dialogId];
        if (d && d.status === 'loading') d.status = 'ready';
        // 首屏失败重试一次（2026-12 反馈 #3）：静默 ready + 空会话 = 刷新后
        // 「没回放前面 steps」的主要形态（run 进行中 journal 回放全依赖此
        // 请求）。重试复用同 reqId（stale 守卫天然放行）；再失败维持静默
        // ——切会话/收束 settlement 会再拉。
        if (srcOffset === 0) {
          setTimeout(() => {
            const dd = dialogs.value[dialogId];
            if (dd && dd.status !== 'loading') requestHistoryPage(to, session, 0, reqId);
          }, 800);
        }
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
    // 寻址与 loadHistory 同词表（session ?? 裸 agentId）——M19 对桶键统一后
    // direct 分区的 parsed.key 是对桶键（alpha|user）：直传会把 conversationId
    // 叠成 bucketKey(viewer, 对桶键) = alpha|user~user，且响应路由
    // directDialog(对桶键) 落进不存在的分区 → mergeHistory 早退，原分区
    // status 永久 'loading'——上翻卡"加载历史消息中…"根因（single 的
    // parsed.key 恰与 session 同值，未受影响）。
    const session = parsed.kind === 'single' ? parsed.key : undefined;
    const to = session ?? agentKeyOf(dialogId);
    d.status = 'loading';
    _historyOffset[to] = (_historyOffset[to] || 0) + HISTORY_PAGE_SIZE;
    const reqId = uid('histreq');
    _historyReq[to] = reqId;
    histReqSentAt.set(reqId, performance.now());
    traceSwitch('req-more', `offset=${_historyOffset[to]} ${dialogId} reqId=${reqId.slice(-6)}`);
    requestHistoryPage(to, session, _historyOffset[to], reqId);
  }
  function mergeHistory(dialogId: DialogId, msgs: ChatMessage[], isFirstPage: boolean, serverHasMore?: boolean): DialogFeed | null {
    const d = dialogs.value[dialogId];
    if (!d) return null;
    const mergeT0 = performance.now();
    d.status = 'ready';
    // offset 校准键与 loadHistory/loadMoreHistory 同词表（session ?? 裸
    // agentId）——direct 分区对话键是对桶键，键词表漂移会让校准恒读 0（校准失效）
    const { kind: mKind, key: mKey } = parseDialogId(dialogId);
    const agentId = mKind === 'single' ? mKey : agentKeyOf(dialogId);
    // hasMore 判定：服务端回显（原始记录口径 offset+limit < total，精确）
    // 优先；旧后端无回显时回落页内 viewer 消息数启发式（≥5 条 = 可能还有）。
    d.hasMore = serverHasMore !== undefined
      ? serverHasMore
      : msgs.filter(m => m.agent_id === VIEWER_ID.value).length >= HISTORY_PAGE_SIZE;
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
        // 重连竞态对齐（2026-09-21 前端反馈 #4）：断线重连后 run 仍在途时，
        // 历史首屏带回的 journal 步行（完整步）与直播流式占位（同一步的部分
        // 内容）并存——同一步渲染两张思考卡/正文卡（「思考→正文→思考(重复)
        // →正文(重复)」）。tool_call_id 对齐覆盖不到纯文本步/思考步；这里按
        // 内容前缀对齐：历史 agent 行的 thinking+content 与占位重叠（互为前缀）
        // → 丢弃历史行，直播载体续流（与 mergeResumeSnapshot「长度取胜不回卷」
        // 同语义——journal 全量与直播部分谁长谁留下是不对的：直播占位才是流式
        // 载体，后续 delta 只认它；历史行的完整内容在收束 settlement 重拉时
        // 以权威形态回来）。
        const liveAgents = streamingTail.filter(m => m.role === 'agent' && m.isStreaming);
        // event 行对齐（injectionId 贯通）：直播 event 行（context-injected 帧
        // 上屏）带服务端锚 persistedMsgId，与历史活投影行/提升行同 message_id——
        // 精确 id 命中即丢弃历史行（mergeHistoryPage 双键去重之外的前置防线，
        // 防 streamingTail 拼接绕过合并路径）。存量兜底：无锚直播行（旧后端
        // 帧）与无锚历史行（旧 journal 投影，message_id 恒空）按内容配额多重
        // 集抵扣——只删无锚行且按直播行数封顶，带锚定稿行（跨轮同文通知）
        // 永不误删；配额耗尽即保留（宁重不丢）。
        const liveEventIds = new Set(streamingTail
          .filter(m => m.role === 'event' && m.persistedMsgId)
          .map(m => m.persistedMsgId as string));
        const legacyEventQuota = new Map<string, number>();
        for (const m of streamingTail) {
          if (m.role === 'event' && !m.persistedMsgId) {
            const k = String(m.content);
            legacyEventQuota.set(k, (legacyEventQuota.get(k) ?? 0) + 1);
          }
        }
        msgs = msgs.filter(m => {
          if (m.role === 'event') {
            // 新链路：同锚即同一份注入事实——直播行是流式载体，历史行丢弃
            if (m.persistedMsgId && liveEventIds.has(m.persistedMsgId)) return false;
            // 存量兜底：无锚投影行按内容抵扣（等量），带锚行不入场
            if (!m.persistedMsgId) {
              const k = String(m.content);
              const q = legacyEventQuota.get(k) ?? 0;
              if (q > 0) { legacyEventQuota.set(k, q - 1); return false; }
            }
          }
          if (m.role === 'tool' && m.tool_call_id && liveIds.has(m.tool_call_id)) return false;
          if (m.role === 'agent' && Array.isArray(m.toolCalls)
            && (m.toolCalls as any[]).some(tc => tc?.id && liveIds.has(tc.id))) return false;
          if (m.role === 'agent' && liveAgents.length > 0) {
            const histThinking = m.thinking ?? m.reasoning_content ?? '';
            const histBody = `${histThinking}\u0000${m.content ?? ''}`;
            const hit = histBody ? liveAgents.find(live => {
              const liveBody = `${live.thinking ?? live.reasoning_content ?? ''}\u0000${live.content ?? ''}`;
              return liveBody.startsWith(histBody) || histBody.startsWith(liveBody);
            }) : undefined;
            if (hit) {
              // 长度取胜回写：journal 全量比直播占位长（断线丢帧）时把完整内容
              // 搬进占位——占位是唯一流式载体（后续 delta 只认它），历史行丢弃
              // 后其内容必须在此保全，否则本步只剩部分内容。
              if (histBody.length > `${hit.thinking ?? hit.reasoning_content ?? ''}\u0000${hit.content ?? ''}`.length) {
                hit.thinking = histThinking || hit.thinking;
                hit.reasoning_content = histThinking || hit.reasoning_content;
                if ((m.content ?? '').length > (hit.content ?? '').length) hit.content = m.content ?? '';
              }
              return false;
            }
          }
          return true;
        });
      }
    }
    if (liveRunInFlight) _settlementReload.add(dialogId); // 收束后重拉（收束行是权威）
    // 首屏未落盘 viewer 消息保护（2026-12 反馈 #1：新会话发送后切走再切回，
    // 用户消息丢失）：本地已上屏的 viewer 气泡若 incoming 中无同内容行
    // （后端 record+flushBestEffort 异步——首次 flush 前 records() 读不到），
    // 整体替换会把它吃掉，直到收束 settlement 重拉才回来——中途整段缺失。
    // 保护范围 = streamingTail 锚点（最后一条 viewer 消息）本身：run 进行中
    // 它必然是本 run 的触发消息；run 空闲时（切回快于落盘的窗口）同样以
    // 内容比对为准。比对规格与 showOwnEcho/mergeResumeSnapshot 一致：
    // splitAttachmentLines 剥 [附件] 行后的正文。
    if (isFirstPage) {
      let anchor: ChatMessage | null = null;
      for (let i = d.rawMessages.length - 1; i >= 0; i--) {
        if (d.rawMessages[i].agent_id === VIEWER_ID.value) { anchor = d.rawMessages[i]; break; }
      }
      if (anchor) {
        const anchorText = splitAttachmentLines(String(anchor.content ?? '')).content;
        const inIncoming = msgs.some(m =>
          m.agent_id === VIEWER_ID.value
          && splitAttachmentLines(String(m.content ?? '')).content === anchorText);
        if (!inIncoming) {
          const copy = { ...anchor };
          (copy as any).persistedMsgId = undefined; // 本地行无服务端 id：防与后续历史行去重互吞
          msgs = [...msgs, copy]; // 尾部（run 进行中其后再接 streamingTail；空闲即列表末尾）
        }
      }
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
      const data = await fetchGroupHistory(groupId, 0, 50, rpc);
      const msgs = (data.messages ?? []).map(groupMessageToChatMessage);
      const liveTail = d.rawMessages.slice(preLen);
      d.rawMessages = liveTail.length > 0 ? [...msgs, ...liveTail] : msgs;
      d.offset = msgs.length;
      // 只有拉满一页才可能还有更早历史；空群聊/短群聊 hasMore=false，
      // 避免 direct 自动续拉逻辑在群聊空态无限递归（ConversationView 已另加守卫）。
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
      const data = await fetchGroupHistory(groupId, d.offset, 50, rpc);
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
      const data = await fetchPairHistory(a, b, PAIR_HISTORY_PAGE_SIZE, 0, rpc);
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
      const data = await fetchPairHistory(a, b, PAIR_HISTORY_PAGE_SIZE, d.offset, rpc);
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
      const asst = newAssistant(agentKeyOf(id));
      // run 前端起点转驻消息（run-started 已设分区态；占位 timestamp 被
      // 校准差分复用为「轮首」——用 runStartAt 而非建占位时刻，吸收
      // run-started → step-started 的投递间隔）
      asst.runStartAt = d.runStartAt;
      msgs.push(asst);
    }
    bump(id);
  }
  function onStepEnd(id: DialogId | null, data: any, active: boolean) {
    if (!id) return;
    const d = ensureById(id);
    // 步终值 = 全量替换语义：最短转圈的延迟关闭须先强制收口，
    // 否则 onMessageEnd 的步终正文与本步工具卡关停不同帧
    flushSpinHolds(id);
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
   *  「已思考 · XmYs」label 写到消息上——耗时随消息驻留分区 rawMessages，
   *  跨步重建/组件重挂载不丢失；无起点（WS 重连重放等）或不足 1s → 清空
   *  label（组件回落「已思考」）。收束时机 = 首个非 reasoning 片（正文/
   *  工具调用）或 delta-end。 */
  function closeThinking(id: DialogId | null, st: StreamState) {
    st.reasoningClosed = true;
    const startAt = st.reasoningStartAt;
    st.reasoningStartAt = 0;
    const elapsedMs = startAt ? Date.now() - startAt : 0;
    onThinkingEnd(id, {
      label: elapsedMs >= 1000 ? `已思考 · ${fmtElapsed(elapsedMs / 1000)}` : undefined,
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
    // 步级 API 计时/补全 token（after-step 透传）：链头速率（Σcompletion/Σms）
    // 的逐步数据源——随消息驻留分区 rawMessages，跨步重建不丢
    if (typeof data.apiMs === 'number' && data.apiMs >= 0) asst.apiMs = data.apiMs;
    if (typeof data.apiCompletion === 'number' && data.apiCompletion >= 0) asst.apiCompletion = data.apiCompletion;
    // 链栏耗时校准对（after-step 透传；见 types.ts ChatMessage.runCalibMs 注释）：
    // 后端权威的「截至本步收束」整轮耗时锚（step.ts − 轮首消息时刻）。
    // 每步收束覆盖——前端计时在其上续跑（显示 = runCalibMs + now − runCalibAt）
    if (typeof data.runCalibMs === 'number' && data.runCalibMs >= 0) {
      asst.runCalibMs = data.runCalibMs;
      asst.runCalibAt = Date.now();
    }
    // bump 目标 = 事件所属 Agent（bumpAgent 固定打给"当前激活 Agent"，
    // 后台 Agent 流式完成时会把别人的回复写进激活项的列表预览/排序）。
    // 仅 viewer 参与会话：agent 对/自会话（矩阵格）不进 agent⇋viewer 名册
    if (asst.content && isViewerDialog(id)) {
      roster().bumpAgentById(agentKeyOf(id), 'assistant', asst.content);
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
    flushSpinHolds(id); // 错误路径：延迟关闭立即收口（错误分隔符上屏前）
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
  // ── 工具占位（preparing）与最短转圈（2026-12 反馈修复）──
  //
  // 反馈现象：「前端不存在工具消息的 running 等待状态，只有工具执行完才
  // 出现」。链路核对结论：running 态机制上存在，但可见窗口极窄——
  //   ① llm/delta 工具分片阶段（模型流式生成参数，通常数秒——一个 step
  //     的大头）此前只累积不建卡：思考已闭合、正文常为空 → 界面纯静默；
  //   ② 本地快工具（read/glob/math 等）执行毫秒级，delta-end → after-execute
  //     几乎同批到达，Vue 同一渲染批次提交「建占位 + 写终态」——首帧
  //     paint 出来就是已完成，dots 中间态在 paint 层面从未存在过。
  //
  // 修复（两件）：
  //   A. 参数阶段占位：首个工具分片到达即建 preparing 卡（2026-09-04
  //     同名并行调用错位的教训——preparing 升级按 name 匹配最后一条流式
  //     tool 会抢错；本次占位本身仍按 index 建/升级，id 形如 prep-<idx>-<ts>，
  //      delta-end 按 preparing 标记 + name 精确配对升级为真 tool_call_id，
  //      幻影分片（id/name 空冲洗片）不建卡）；
  //   B. 最短转圈：onToolEnd 若距占位建立不足 TOOL_MIN_SPIN_MS 则延迟关闭
  //      （保证 dots 至少可见一瞬——快工具的终态不再瞬间吞掉运行态）。
  //      数据先落（content/running 即写），只延迟视觉关停；after-step /
  //      after-run / 中断 / 重连等边界事件强制 flush，防止 300ms 悬挂
  //      破坏「步终值全量替换」与收束重拉的时序假设。

  /** 最短转圈时长：快工具终态延迟关停，让 running dots 至少可见一瞬 */
  const TOOL_MIN_SPIN_MS = 300;
  /** 延迟关闭登记：tool_call_id → 目标时刻（边界事件 flush / 到点执行） */
  const _spinHold = new Map<string, number>();

  /**
   * 参数流式占位卡建立（llm/delta 工具分片首见时调用）。
   * 按 index 去重（st.preps）：同一调用的重复分片/重连重放不建第二张卡。
   * label = "正在调用工具: X"（显式 label 优先，展示层 toolDisplayLabel
   * 认它）；isStreaming = true → 转圈 dots 立即可见。
   */
  function prepareToolCall(id: DialogId, st: StreamState, idx: number, name: string) {
    if (st.preps.has(idx)) return;
    markActive();
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const asst = lastStreaming(msgs, 'agent');
    if (!asst) return; // 无流式载体（step-started 丢失等）：不标记，后续分片重试
    st.preps.add(idx);
    const prepId = `prep-${idx}-${Date.now()}`;
    toolCallsOf(asst).push({
      id: prepId, name, arguments: {}, result: '',
      label: `正在调用工具: ${name}`, preparing: true, running: true, startTime: Date.now(),
    });
    msgs.push({
      id: `tool-${prepId}`, role: 'tool', content: '',
      name, toolName: name, tool_call_id: prepId, arguments: {},
      label: `正在调用工具: ${name}`, isStreaming: true, timestamp: Date.now(),
    });
    bump(id);
  }

  /**
   * 最短转圈 flush：立即关闭指定（或全部）延迟关闭的占位。
   * 语义同直接关闭路径（m.isStreaming=false）——边界事件（after-step /
   * after-run / 中断 / 重连 / chat-error）到达时强制收口，防止悬挂的
   * 300ms 计时器破坏步终值全量替换与收束重拉的时序假设。
   */
  function flushSpinHolds(id: DialogId, only?: string) {
    if (_spinHold.size === 0) return;
    const targetIds = [..._spinHold.keys()].filter((tcid) => !only || tcid === only);
    if (!targetIds.length) return;
    for (const tcid of targetIds) _spinHold.delete(tcid);
    const d = dialogs.value[id];
    if (!d) return;
    const closeSet = new Set(targetIds);
    const msgs = d.rawMessages;
    let changed = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' && m.isStreaming && closeSet.has(m.tool_call_id ?? '')) {
        m.isStreaming = false;
        changed = true;
      }
    }
    if (changed) bump(id);
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
    // 升级 prepareToolCall 建立的占位（参数流式阶段已显示"正在调用工具"）：
    // 同名并行只认【未被认领】的 preparing 条目（find 不回头）——已被升级的
    // 条目 preparing=false，不会二次认领（旧按 name 全查会抢已升级的）。
    const prep = toolCallsOf(asst).find((tc: any) => tc.preparing && tc.name === data.tool_name);
    if (prep) {
      const prepRowId = prep.id; // prep-… 原始占位 id（重命名前捕获——占位行按它精确配对）
      prep.id = data.tool_call_id;
      prep.preparing = false;
      prep.arguments = data.arguments;
      prep.label = data.label || data.tool_name;
      // 占位行按 prepRowId 精确配对（不能用 lastStreaming——并行多占位时
      // 最后一条流式 tool 可能是别的调用的占位，位置匹配会漏升级本行）
      const prepRow = [...msgs].reverse().find(m => m.role === 'tool' && m.tool_call_id === prepRowId);
      if (prepRow) {
        prepRow.id = `tool-${data.tool_call_id}`;
        prepRow.tool_call_id = data.tool_call_id;
        prepRow.label = data.label || data.tool_name;
        prepRow.arguments = data.arguments;
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
  /**
   * run_code 子调用开始占位（2026-12 反馈 #2）：tool/started（before-execute
   * 放行后 emit）到达即建 running 平铺卡——此前终值到达才建卡（onSubcallEnd
   * 直接终态），串行链阻塞（approval 等待/长工具/checkpoint veto）时后续
   * 子调用无卡无状态，视觉即「堆积在 run_code 卡下不动」。占位语义与
   * onSubcallEnd 完全同构（同 tool_call_id upsert——先到建立、后到填值，
   * 帧丢失/乱序不双卡）；running=true → ToolMessage 行首旋转环。
   */
  function onSubcallStart(id: DialogId, data: { tool_call_id: string; tool_name: string; arguments?: unknown }) {
    const d = ensureById(id);
    const msgs = d.rawMessages;
    // 载体定位与 onSubcallEnd 同序：当前流式 agent 步优先（run_code 执行期
    // 步已收口——lastStreaming 为空时回退最后一条带 toolCalls 的 agent 消息
    // = 宿主 run_code 调用所在的步）
    const asst = lastStreaming(msgs, 'agent') ?? [...msgs].reverse().find((m: any) => m.role === 'agent' && m.toolCalls?.length) ?? null;
    if (!asst) return; // 无 agent 载体（异常时序）：丢弃——不破坏消息流形状
    const tc = toolCallsOf(asst);
    const existing = tc.find((x: any) => x.id === data.tool_call_id);
    if (existing) {
      // 已在场（started 重放 / end 先到）：仅补 running 标记，不覆盖已有 result
      existing.running = existing.result === undefined || existing.result === '' ? true : existing.running;
      if (data.arguments !== undefined && (!existing.arguments || (typeof existing.arguments === 'object' && Object.keys(existing.arguments as object).length === 0))) {
        existing.arguments = data.arguments;
      }
    } else {
      tc.push({ id: data.tool_call_id, name: data.tool_name || '(subcall)', arguments: data.arguments ?? {}, result: '', subcall: true, running: true, startTime: Date.now() });
    }
    const row = msgs.find((m: any) => m.role === 'tool' && m.tool_call_id === data.tool_call_id);
    if (row) {
      if (row.isStreaming !== true && !row.content) row.isStreaming = true; // 终值未到才回 running（重放防回卷）
    } else {
      msgs.push({
        id: 'tool-' + data.tool_call_id, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id, arguments: data.arguments ?? {},
        subcall: true, isStreaming: true, timestamp: Date.now(),
      } as any);
    }
    bump(id);
  }
  /**
   * run_code 子调用平铺落卡（2026-09-17 方向 B）：程序内调用的结果到达
   * 即建独立 tool 消息（subcall 标记）+ 追加进当前流式 agent 步的
   * toolCalls（fileEdits 等追踪层扫 toolCalls 收录——diff 追踪修复）。
   * 与 onToolEnd 的差别：无占位可匹配（toolCallId 无模型侧 id），恒建
   * 新条目；直接终态（run_code 桥接逐个 await 子调用——结果到达即完成，
   * 无独立 running 窗口）。onSubcallStart 占位在场时（2026-12 #2）原地
   * 填终值关停——同 tool_call_id upsert，帧乱序不双卡。
   */
  function onSubcallEnd(id: DialogId, data: { tool_call_id: string; tool_name: string; arguments: unknown; result: string }) {
    const d = ensureById(id);
    const msgs = d.rawMessages;
    const asst = lastStreaming(msgs, 'agent') ?? [...msgs].reverse().find((m: any) => m.role === 'agent' && m.toolCalls?.length) ?? null;
    if (!asst) return; // 无 agent 载体（异常时序）：丢弃——不破坏消息流形状
    const tc = toolCallsOf(asst);
    const existingTc = tc.find((x: any) => x.id === data.tool_call_id);
    if (existingTc) {
      // 占位在场（tool/started 先到）：原地填终值
      existingTc.result = data.result;
      existingTc.running = false;
      if (data.arguments !== undefined) existingTc.arguments = data.arguments;
    } else if (!tc.some((x: any) => x.id === data.tool_call_id)) {
      const entry: any = { id: data.tool_call_id, name: data.tool_name || '(subcall)', arguments: data.arguments ?? {}, result: data.result, subcall: true, running: false, startTime: Date.now() };
      tc.push(entry);
    }
    const row = msgs.find((m: any) => m.role === 'tool' && m.tool_call_id === data.tool_call_id);
    if (row) {
      row.content = data.result ?? '';
      row.arguments = data.arguments ?? row.arguments;
      row.isStreaming = false; // 占位在场：关停 running（最短转圈不适用——占位本身即长等待信号）
    } else {
      msgs.push({
        id: 'tool-' + data.tool_call_id, role: 'tool', content: data.result ?? '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id, arguments: data.arguments ?? {},
        subcall: true, isStreaming: false, timestamp: Date.now(),
      } as any);
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
        m.content = data.result ?? ''; closedById = true; break;
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
    // 最短转圈：数据已落（content/result 上面即写），视觉关停延至占位建立
    // 后满 TOOL_MIN_SPIN_MS——快工具的终态不再同帧吞掉 running dots。
    // 边界事件（步终/收束/中断/重连）经 flushSpinHolds 强制收口。
    const row = msgs.find((m) => m.role === 'tool' && m.tool_call_id === data.tool_call_id && m.isStreaming);
    if (row) {
      const spin = (tc as any)?.startTime ?? row.timestamp ?? Date.now();
      const hold = TOOL_MIN_SPIN_MS - (Date.now() - spin);
      if (hold > 0) {
        const deadline = Date.now() + hold;
        _spinHold.set(data.tool_call_id, deadline);
        const dialogId = id;
        setTimeout(() => {
          // 到点：仅当登记未被边界事件 flush 或重放覆盖（deadline 一致）时关闭
          if (_spinHold.get(data.tool_call_id) === deadline && dialogs.value[dialogId]) {
            flushSpinHolds(dialogId, data.tool_call_id);
          }
        }, hold);
      } else {
        row.isStreaming = false;
      }
    }
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
    flushSpinHolds(id); // 延迟关闭立即收口——中断语义 = 全部占位定格
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
    flushSpinHolds(id); // run 收束：延迟关闭立即收口（收束重拉的前提）
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
      roster().bumpAgentById(agentId, 'assistant', content);
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
        // run 起点兜底（刷新恢复：无 run-started 帧；快照步 ts = 本 run
        // 已知最早后端时刻，比 Date.now()（=恢复时刻）更接近真实起点）
        const firstStepTs = steps.length > 0 ? steps[0].ts : undefined;
        asst.runStartAt = firstStepTs ?? Date.now();
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
      mergeHistory(dialogId, msgs, isFirstPage, typeof data.serverHasMore === 'boolean' ? data.serverHasMore : undefined);
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
    mergeHistory(dialogId, msgs, isFirstPage, typeof data.serverHasMore === 'boolean' ? data.serverHasMore : undefined);
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
      // id 优先 sid（多步轮步行合成 key——同轮步行共享收束行 message_id，
      // Vue key 须唯一；sid 仅渲染去重用，服务端锚点恒走 persistedMsgId）
      id: m.sid ?? m.message_id ?? uid('hist'),
      role: m.role, content: split.content,
      agent_id: m.agent_id, toolCalls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      // 步内相位序透传（历史 steps 展开；直播自判值随收束重拉对齐）
      ...(m.textBeforeTools !== undefined ? { textBeforeTools: m.textBeforeTools } : {}),
      // 步级 API 计时/补全 token 透传（链头速率数据源，见 types.ts apiMs 注释）
      ...(typeof m.apiMs === 'number' ? { apiMs: m.apiMs } : {}),
      ...(typeof m.apiCompletion === 'number' ? { apiCompletion: m.apiCompletion } : {}),
      // 服务端锚点：多步轮步行 = 收束行真实 message_id（同轮同锚——fork/
      // truncate 按整轮命中；2026-12 分支锚点修复，此前合成 `-s{i}` 后端不存在）
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
   *  其余（他人发起且落 viewer 会话的帧）拦截，防推理结果串台。
   *  机制唤醒豁免（2026-09-16）：source='event' 的 run（ask_questions
   *  late-reply 回投 / timer 定点等）由后端 ws-bridge 判定落在用户可见
   *  会话才广播（自会话桶 a~a 与归档整理仍隐藏）——即本会话内容而非
   *  串台，此处放行。此前按 sender 一刀切拦截：表现为回执（系统事件行）
   *  可见但整轮隐形、收束瞬间终稿一次性弹出，中途思考与分步正文全部
   *  丢失（修复前 bug 现场）。 */
  function isForCurrentUser(d: any): boolean {
    if (!d?.sender || d.sender === VIEWER_ID.value) return true;
    if (d?.source === 'event') return true;
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
    return roster().activeAgentId.value;
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
      roster().bumpAgentById(from, 'assistant', payload);
      persistUnreadNow();
    }
  }

  /** 机制通知上屏（source='event' 入站——message-received 空闲路径与
   *  steered 忙路径共用）：系统事件行（分隔符渲染），与落盘 role:'event' /
   *  刷新历史同形。群分区同样不进（内容源 = post 行；群历史无 event 行）。 */
  function showEventNotice(agent: string | undefined, conversationId: string | undefined, content: string, anchor?: string): void {
    const keys = routeDialog(agent, conversationId, agent);
    if (!keys) return;
    const dialogId = keys.dialogId;
    if (parseDialogId(dialogId).kind === 'group') return; // 群分区唯一内容源 = post 行
    const d = ensureById(dialogId);
    d.rawMessages.push({
      // 注入身份键（injectionId）贯通：直播行带服务端锚点——与刷新后的
      // 活投影行/提升行同 message_id，mergeHistoryPage 双键去重直接生效
      //（运行中切换会话回视的重复 context 行根修）；缺席（旧后端）回落本地 id
      id: anchor ?? uid('msg'), role: 'event', content, agent_id: 'system', timestamp: Date.now(),
      ...(anchor !== undefined ? { persistedMsgId: anchor } : {}),
    });
    touch(dialogId, 'system', content, Date.now());
    bump(dialogId);
    if (isViewerDialog(dialogId) && dialogId !== activeDialogId.value) {
      d.unread += 1;
      roster().bumpAgentById(agentKeyOf(dialogId), 'assistant', content);
      persistUnreadNow();
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
        const keys = routeDialog(agent, request?.conversationId, request?.sender, request?.source);
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
        // 本 run 计时状态重置（每轮 run 独立计时——严禁沿用上一轮锚；
        // run-started 先于首步 step-started/首个 delta 到达）
        d.runStartAt = Date.now();
        d.runAnchorMs = undefined;
        d.runAnchorBackendTs = undefined;
        return;
      }
      case 'loop/step-started': {
        const [agent, , , envelope] = args as [string | undefined, number, unknown, { conversationId?: string; sender?: string; source?: string } | undefined];
        if (!isUserConversation(frameAgentId(agent), envelope?.conversationId)) return;
        const keys = routeDialog(frameAgentId(agent), envelope?.conversationId, envelope?.sender, envelope?.source);
        if (keys) { noteStreamAgent(keys); onStepStart(keys.dialogId, isForActiveAgent(keys)); }
        return;
      }
      case 'llm/delta': {
        const [input, chunk, meta] = args as [any, any, any];
        const agent = frameAgentId(meta?.agent ?? input?.meta?.agent);
        const conv = meta?.conversationId ?? input?.meta?.conversationId;
        if (!isUserConversation(agent, conv)) return;
        const keys = routeDialog(agent, conv, meta?.sender ?? input?.meta?.sender, meta?.source ?? input?.meta?.source);
        if (!keys || !isForCurrentUser(keys)) return;
        noteStreamAgent(keys);
        const st = streamOf(streams, keys.dialogId);
        const reasoning = typeof chunk?.reasoning === 'string' ? chunk.reasoning : '';
        if (reasoning) {
          if (!st.sawReasoning) {
            st.sawReasoning = true;
            // 思考相位起点：收束时定格「已思考 · XmYs」用
            st.reasoningStartAt = Date.now();
            // 思考消息 label 由组件按思考相位派生（思考中/已思考），不再写占位 label
            onThinkingStart(keys.dialogId, {}, isForActiveAgent(keys));
            // 起点驻留消息（2026-12 计时反馈）：「思考中 · Xs」实时计时与收束
            // label 共用同源起点——组件重挂载/跨步重建不丢，收束不倒跳
            const liveAsst = lastStreaming(ensureById(keys.dialogId).rawMessages, 'agent');
            if (liveAsst && liveAsst.reasoningStartAt === undefined) {
              liveAsst.reasoningStartAt = st.reasoningStartAt;
            }
          }
          onThinkingUpdate(keys.dialogId, { delta: reasoning });
        }
        const delta = typeof chunk?.delta === 'string' ? chunk.delta : '';
        if (delta) {
          if (st.sawReasoning && !st.reasoningClosed) closeThinking(keys.dialogId, st);
          // 步内相位序自判（textBeforeTools 的直播源）：首个正文 delta 到达
          // 时本步尚未见过工具分片 → 正文先行，标记到载体（思考过程卡片的
          // 步内渲染序依据；工具先行步不标，保持缺省序）。仅首次判定——
          // 后续 delta 不改写（相位已定）。
          if (!st.sawText) {
            st.sawText = true;
            if (!st.sawToolCall) {
              const asst = lastStreaming(ensureById(keys.dialogId).rawMessages, 'agent');
              if (asst) asst.textBeforeTools = true;
            }
          }
          onMessageUpdate(keys.dialogId, { delta });
        }
        if (Array.isArray(chunk?.toolCalls)) {
          st.sawToolCall = true;
          // 工具调用分片到场 = 模型离开思考相位（reasoning → tool_calls）
          if (st.sawReasoning && !st.reasoningClosed) closeThinking(keys.dialogId, st);
          for (const tc of chunk.toolCalls) {
            const idx = typeof tc?.index === 'number' ? tc.index : 0;
            // 参数流式阶段即建 preparing 占位卡（2026-12 反馈：此前只累积，
            // 模型打参数的数秒里界面纯静默）。按 index 去重（st.preps）；
            // 幻影分片（id/name 空）不建卡。
            if (typeof tc?.id === 'string' && tc.id && typeof tc?.name === 'string' && tc.name) {
              prepareToolCall(keys.dialogId, st, idx, tc.name);
            }
            // 只累积（id/name 首见建条目、argumentsDelta 拼接）——真 id 占位
            // 由 delta-end 统一按 index 序升级（onToolStart 按 preparing
            // 标记 + name 精确配对，多工具并存不抢位）。
            // id/name 须非空：provider 的空冲洗片（"" id/name）不成为调用
            if (typeof tc?.id === 'string' && tc.id && typeof tc?.name === 'string' && tc.name && !st.tools.has(idx)) {
              st.tools.set(idx, { id: tc.id, name: tc.name, buf: '' });
            }
            const acc = st.tools.get(idx);
            if (acc && typeof tc?.argumentsDelta === 'string') acc.buf += tc.argumentsDelta;
            // run_code 参数草稿（2026-09-21 前端反馈 #1）：code 字段可达数 KB，
            // 参数流式全程（数十秒）占位卡只有裸 spinner——粗提取已生成部分
            // 同步进 prep 条目与占位行，程序卡边生成边可见。终值由 delta-end
            // 的全量 arguments 覆盖。
            if (acc && acc.name === 'run_code') {
              const draft = extractPartialJsonString(acc.buf, 'code');
              if (draft !== undefined) {
                const d = dialogs.value[keys.dialogId];
                const msgs2 = d?.rawMessages;
                if (msgs2) {
                  const asst2 = lastStreaming(msgs2, 'agent');
                  const tcs2 = asst2 ? toolCallsOf(asst2) : [];
                  const prep2 = tcs2.find((x: any) => x.preparing && x.name === 'run_code');
                  if (prep2) {
                    const prevLen = typeof (prep2.arguments as any)?.code === 'string' ? (prep2.arguments as any).code.length : 0;
                    if (draft.length > prevLen) {
                      prep2.arguments = { ...(prep2.arguments as object ?? {}), code: draft };
                      const row2 = [...msgs2].reverse().find((m: any) => m.role === 'tool' && m.tool_call_id === prep2.id);
                      if (row2) row2.arguments = prep2.arguments;
                      bump(keys.dialogId);
                    }
                  }
                }
              }
            }
          }
        }
        return;
      }
      case 'llm/delta-end': {
        const [input, meta] = args as [any, any];
        const agent = frameAgentId(meta?.agent ?? input?.meta?.agent);
        const conv = meta?.conversationId ?? input?.meta?.conversationId;
        if (!isUserConversation(agent, conv)) return;
        const keys = routeDialog(agent, conv, meta?.sender ?? input?.meta?.sender, meta?.source ?? input?.meta?.source);
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
      case 'tool/started': {
        // 工具开始执行（before-execute 放行后 emit；2026-12 反馈 #2）：
        // run_code 子调用据此建 running 占位卡——终值前串行链阻塞可见。
        // 模型直调工具有模型侧占位（preparing/真 id 升级链），不在此建卡
        // （防与 onToolStart 双卡）；非 subcall 帧忽略。
        const [call] = args as [any];
        const agent = frameAgentId(call?.agentId);
        if (!isUserConversation(agent, call?.conversationId)) return;
        const keys = routeDialog(agent, call?.conversationId);
        if (!keys || typeof call?.toolCallId !== 'string' || !call.toolCallId) return;
        if (call?.runCodeSubcall === true) {
          onSubcallStart(keys.dialogId, {
            tool_call_id: call.toolCallId,
            tool_name: typeof call?.name === 'string' ? call.name : '',
            arguments: call?.args,
          });
        }
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
        // run_code 子调用平铺（2026-09-17 方向 B）：程序内调用无模型占位卡
        //（toolCallId 形如 <runId>#<seq>，不在任何 assistant.toolCalls 里）——
        // onToolEnd 的占位匹配必然落空，改走平铺建卡：紧跟当前流式 agent
        // 步追加独立 tool 消息（subcall 标记 → 缩进样式），fileEdits 等追踪
        // 层按消息流 toolCalls 天然收录
        if (call?.runCodeSubcall === true) {
          onSubcallEnd(keys.dialogId, {
            tool_call_id: call.toolCallId,
            tool_name: typeof call?.name === 'string' ? call.name : '',
            arguments: call?.args,
            result: stringifyToolResult(result, error),
          });
          return;
        }
        onToolEnd(keys.dialogId, { tool_call_id: call.toolCallId, result: stringifyToolResult(result, error) });
        return;
      }
      case 'llm/chat-error': {
        const [input, error] = args as [any, unknown];
        const agent = frameAgentId(input?.meta?.agent);
        const conv = input?.meta?.conversationId;
        if (!isUserConversation(agent, conv)) return;
        const keys = routeDialog(agent, conv, input?.meta?.sender, input?.meta?.source);
        if (!keys) return;
        onMessageError(keys.dialogId, { content: errText(error) }, isForActiveAgent(keys));
        return;
      }
      case 'loop/after-step': {
        const [agent, step, envelope] = args as [string | undefined, any, { conversationId?: string; sender?: string; source?: string } | undefined];
        if (!isUserConversation(frameAgentId(agent), envelope?.conversationId)) return;
        const keys = routeDialog(frameAgentId(agent), envelope?.conversationId, envelope?.sender, envelope?.source);
        if (!keys) return;
        noteStreamAgent(keys);
        // 步终值：message.end（全量替换语义）+ step.end（关闭占位；
        // toolCalls 透传 = run 是否继续的判定依据——见 onStepEnd）
        if (isForCurrentUser(keys)) {
          // 链栏耗时校准（2026-12 计时反馈）：每轮 run 独立计时，锚推进 =
          // 前锚 + 相邻两步 step.ts 差分（后端时钟域——客户端/服务器时钟
          // 偏差在差分中抵消；首步无前锚 → 前端计时定格，帧传播延迟在首
          // 校准即被吸收）。锚驻分区 run 级状态（run-started 重置），随步
          // 驻留消息（跨组件重挂载/切走切回不丢）
          const dCal = dialogs.value[keys.dialogId];
          let calibMs: number | undefined;
          if (typeof step?.ts === 'number' && dCal) {
            const prevTs = dCal.runAnchorBackendTs;
            if (prevTs !== undefined) {
              calibMs = (dCal.runAnchorMs ?? 0) + Math.max(0, step.ts - prevTs);
            } else {
              const t0 = dCal.runStartAt ?? lastStreaming(dCal.rawMessages, 'agent')?.runStartAt;
              calibMs = t0 !== undefined ? Math.max(0, Date.now() - t0) : undefined;
            }
            if (calibMs !== undefined) {
              dCal.runAnchorMs = calibMs;
              dCal.runAnchorBackendTs = step.ts;
            }
          }
          onMessageEnd(keys.dialogId, {
            content: String(step?.text ?? ''), reasoning: String(step?.reasoning ?? ''),
            // 思考耗时（后端权威 reasoningMs——与直播 closeThinking 同源定义）：
            // 覆盖前端推定的「已思考 · XmYs」label，消除流式帧延迟误差
            ...(typeof step?.reasoningMs === 'number' && step.reasoningMs >= 1000
              ? { label: `已思考 · ${fmtElapsed(step.reasoningMs / 1000)}` }
              : {}),
            // 步级 API 计时（loop 步记录 elapsedMs = dispatch 纯流时间）+
            // 步补全 token（usage.completion——输出口径，见 types.ts 注释）
            ...(typeof step?.elapsedMs === 'number' && step.elapsedMs >= 0 ? { apiMs: step.elapsedMs } : {}),
            ...(typeof step?.usage?.completion === 'number' && step.usage.completion >= 0 ? { apiCompletion: step.usage.completion } : {}),
            ...(calibMs !== undefined ? { runCalibMs: calibMs } : {}),
          });
        }
        onStepEnd(keys.dialogId, { interrupted: false, toolCalls: step?.toolCalls }, isForActiveAgent(keys));
        // 步终值时刻：仅活跃 Agent 的 run 置位（TokenGauge 等派生数据重取
        // 驱动——工具步在工具执行前到达，长工具运行中仪表即可刷新占用）
        if (isForActiveAgent(keys)) { lastStepEndAt.value = Date.now(); }
        // run_code 子调用对账（2026-12 反馈 #2）：步收口时存在无终值的
        // subcall 卡（WS 抖动丢 after-execute / 串行链长阻塞）→ 经
        // settlement 重拉补偿（journal/subcalls 投影已含真实结果）。
        // 节流：每分区同 run 至多一次——重拉合并自带 live-wins 对齐，
        // 后续步不再重复触发。
        const dSub = dialogs.value[keys.dialogId];
        if (dSub && dSub.streaming) {
          const hasOpenSubcall = dSub.rawMessages.some((m: any) =>
            m.role === 'tool' && m.subcall === true && (m.isStreaming || !m.content));
          if (hasOpenSubcall) _settlementReload.add(keys.dialogId);
        }
        return;
      }
      case 'loop/after-run': {
        const [request, result] = args as [any, any];
        const agent = frameAgentId(request?.agent);
        if (!isUserConversation(agent, request?.conversationId)) return;
        const keys = routeDialog(agent, request?.conversationId, request?.sender, request?.source);
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
        onChatEnd(keys.dialogId, { content: finish === 'stop' ? String(result?.text ?? '') : '' }, active);
        // 收束后无条件重拉首屏（gated=false）：权威收束行替换 partial 检查点行
        // 与直播行，补 persistedMsgId 供分支/编辑/删除定位——不止覆盖「run 中
        // 做过历史合并」的分区（一直开着的会话同样需要换权威行）
        scheduleSettlementReload(keys.dialogId, request?.conversationId, false);
        return;
      }
      case 'session/context-injected': {
        // 流式运行期 context 注入可见性（2026-09-21 反馈 #3）：技能注入等
        // context 行落账即通知——渲染为事件分隔行（与刷新后的 context 行
        // 同渲染位）。正文不广播（瘦身纪律）——文案 = label 直出，与刷新后
        // toHistoryMessages 的 r.label ?? r.content 同源同形（2026-12 前端
        // 反馈：此前 skill 行再拼「已注入技能上下文：」前缀，落账 label 本身
        // 已是完整文案，流式与刷新文本不一致）；label 缺席回落摘要词。
        const [conversationId, agentId, meta] = args as [string | undefined, string | undefined, { source?: unknown; label?: unknown; injectionId?: unknown } | undefined];
        if (!conversationId) return;
        const source = typeof meta?.source === 'string' ? meta.source : '';
        const label = typeof meta?.label === 'string' && meta.label ? meta.label : '';
        const text = label || (source === 'skill' ? '已注入技能上下文' : '已注入上下文');
        // injectionId（注入身份键）：直播行带锚——与刷新后的活投影行/提升行
        // 同 message_id，历史合并去重恒等生效；缺席（旧后端帧）回落本地 id
        const anchor = typeof meta?.injectionId === 'string' && meta.injectionId ? meta.injectionId : undefined;
        showEventNotice(frameAgentId(agentId), conversationId, text, anchor);
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
        // 未读：非 viewer 发言且该群非当前活跃群 → +1（与 direct 入站同口径
        // ——正在看的会话不计未读；清除经 clearUnread(group:gid)，由 ui-group
        // selectGroup 触发，名册群行/活动栏聚合徽章同源消费）
        if (from !== VIEWER_ID.value && gDialog !== activeDialogId.value) {
          gd.unread += 1;
          persistUnreadNow();
        }
        return;
      }
      case 'router/message-received': {
        // M19 统一路由：说话人 = sender 端点 id。viewer 自己的发送（本地
        // 已上屏）跳过；其余（Agent→viewer 私信 / agent⇄agent 委托入站）
        // 按对桶路由进对应 pair 分区实时显示 + 未读。
        // source='event'（机制通知，空闲路径）上屏已退役：通知面统一后由
        // ac-session 在事件行落账时发 session/context-injected（带注入身份
        // 锚 injectionId——直播行与刷新行同锚去重）；此处再渲染会双份。
        const [agentId, message, conversationId, sender, source] = args as
          [string, any, string, string?, string?, ...unknown[]];
        if (source === 'event') return;
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
        //  · source='event'（如后台任务完成通知）上屏已退役：通知面统一后
        //    由 ac-session 在事件行落账/stash 时发 session/context-injected
        //    （带注入身份锚）；此处再渲染会双份。
        //  · 其余（agent⇄agent 注入）与 message-received 同款 agent 行。
        const [agentId, message, conversationId, , sender, source] = args as
          [string, any, string, string, string?, string?, ...unknown[]];
        const from = typeof sender === 'string' && sender ? sender : '';
        if (from === VIEWER_ID.value) return;
        const content = String(message?.content ?? '');
        if (!content) return;
        if (source === 'event') return;
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
  let initialized = false;
  function init() {
    if (initialized) return; // 重入守卫（chat-core init 幂等语义对齐）
    initialized = true;
    rpc.onEvent(handleFrame);
    // 重连后清理：断线期间发出的 history 请求已作废（status 残留 'loading'
    // 永久堵死分页）；断线中丢失收尾帧的分区也要关闭残留流式占位
    rpc.onOpen?.(() => {
      // 重连 = 直播帧断供：延迟关闭全部作废（计时器到点查表扑空）
      _spinHold.clear();
      for (const d of Object.values(dialogs.value)) {
        if (!d) continue;
        if (d.status === 'loading') d.status = 'ready';
        if (d.streaming) {
          d.streaming = false;
          closeAllStreaming(d.rawMessages);
          bump(d.id);
        }
      }
      // 断线期间整理 run 的 after-run 帧丢失——"正在整理"态一并回落
      if (archiveReviewing.value.size > 0) archiveReviewing.value = new Set();
      // 历史对账（2026-11-28 可见性恢复缺口补齐）：断线窗口丢失的帧只能
      // 靠兜底轮询（最坏一个 interval）或用户切会话补回——重连成功的这一
      // 刻是唯一确定性补偿时机。与切会话同管线（loadHistory 签名零改写），
      // requestId 时序守卫天然防乱序合并；首屏 fingerprint 短路服务端
      // unchanged 轻载荷（文件未变时成本 = 一次 RPC 往返）。只重拉当前
      // 活跃对话（不在视图的分区缺帧本就只有未读语义，下次进入自然全量）。
      const resume = activeDialogId.value;
      if (resume) {
        const { kind, key } = parseDialogId(resume);
        if (kind === 'single') loadHistory(resume, VIEWER_ID.value, key, key);
        else if (kind === 'group') void loadGroupHistory(resume, key);
        else if (pairHasViewer(key)) loadHistory(resume, VIEWER_ID.value, pairPartnerOf(key));
        // 非 viewer 对桶（只读视角）无写口——重连恢复只覆盖 viewer 主路径
      }
    });
  }

  return {
    // state / 派生
    dialogs, activeDialogId, activeDialog, activeAgentId, activeGroupId, activeSingleId,
    setActiveGroup, clearActiveGroup, setActiveSingle, clearActiveSingle,
    activity,
    turnInProgress, lastStepEndAt, archivePending,
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
}

export type FeedCore = ReturnType<typeof createFeedCore>;
/** ref 自动解包视图（pinia store / reactive(core) 同构访问面） */
export type FeedView = { [K in keyof FeedCore]: import('vue').UnwrapRef<FeedCore[K]> };
