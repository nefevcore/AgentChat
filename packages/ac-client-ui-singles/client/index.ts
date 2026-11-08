// ============================================================
// ac-client-ui-singles/client/index.ts —— singles 域前端行 client 半边
//（M27.1，D19 改裁：ac-client-ui-* 独立 UI 行包）
//
// 自 webui/src/clients/singles.ts 迁入（S3-1b 行包 → M27.1 独立行）。
// 域投影 + 服务面（服务端已占 'singles' 名——'singleBoard' Board 后缀
// 避让，D22）：
//   · 独立会话列表 + 激活态（activeSingleId 派生自 feed 活跃分区——
//     列表只切上下文，视图层负责加载历史）；
//   · singles/updated 帧订阅（自动标题/设置变更 → 列表刷新）随本域
//     fiber 卸载回收（谁的数据谁订帧，§0.3 层 3）；
//   · 会话上下文协调（chat.setSingleContext / lastContext 持久化）
//     ——S3-1b 起走服务面互调（ctx.sessions / ctx.roster）；
//   · sid 集合同步（帧路由 single~sid 判别）经 sessions.trackKnownSingle；
//   · 可摘除性（D19）：卸载 ac-singles 行 → ctx.singleBoard 不可解析
//     → 独立会话列表/视角消费面消失，宿主不残废。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace, loadLastContext, saveLastContext, clearLastContextIf, resyncRetry } from 'ac-client-runtime';
import { takeDraft, parkDraft, restoreDrafts } from 'ac-client-ui-conversation/client/draftParking.ts';
import { loadComposePrefs } from 'ac-client-ui-conversation/client/composePrefs.ts';
import { defineAsyncComponent, ref, computed, type ComputedRef, type Ref } from 'vue';

// single 视角组件（静态跨包引用——v3 模块系统同源单例：构建期外部化
// 为 require，物化期命中壳种子表 sharedModules 的 in-bundle 实例；
// vitest 全局 vue 插件下 node 求值安全〔旧 defineAsyncComponent 裸
// import 词形已随 crash-hardening 退役——native import 无解析面必炸〕）
import * as ConversationViewNS from 'ac-client-ui-conversation/client/ConversationView.vue';
const ConversationView = ConversationViewNS.default;

// ---- 域契约（契约随 UI 行走：owning = ac-client-ui-singles） ----

/** 独立会话元数据（= preview SingleSessionMeta；原 webui api/singles.ts 门面已退役〔M28 §4.2〕） */
export interface SingleSession {
  id: string;
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
  /** 所属用户工作区（workspaceId 引用；缺省/空 = 未分组） */
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

export interface SingleCreatePayload {
  /** 指定会话 id（延迟落盘链路：幻影会话本地签发，物化时带上——消息流与 session.json 同目录） */
  id?: string;
  agentId?: string;
  model?: string | Record<string, unknown>;
  title?: string;
  workspaceId?: string;
  reuse?: boolean;
}

export interface SingleUpdatePayload {
  agentId?: string;
  model?: string | Record<string, unknown> | null;
  /** 重命名会话（trim 后非空才落；手改标题永不覆盖——幂等守卫认 session.json 有 title） */
  title?: string;
  workspaceId?: string;
}

/** presence 同步钩子（行内服务传 sessions 协调面；webui 包装传 chatPresence 桥） */
export interface SinglesTrackOpts {
  track?: (id: string, removed?: boolean) => void;
}

// ---- 单例草稿态（cr-894 幻影壳层退役）----
// 未发送的新会话全局唯一（cr-848 裁决）且不再占列表行：服务端零痕迹、
// 无会话 id——挂 single 视角用哨兵 __pending__。id 在首次发送时签发
//（cr-894：作为 singles/create 的幂等锚——失败重试必须同 id，否则失败
// 窗口里每次重试给服务端留一个空会话目录，延迟落盘的初衷即失效）。
// 草稿正文住通用草稿层（draftParking，键 = 哨兵），身份字段（Agent/
// 模型/工作区）留存在本层——「未发送草稿不因刷新丢失」由两层各守一半。
// 待发 id（pendingId）只在「create 已发出、落盘未确认」的失败窗口存在。

/** 留存键（身份字段面；草稿正文住 draftParking——两层各守一半） */
const PENDING_KEY = 'agentchat.pendingSingle';

/** single 视角哨兵（未发送草稿的会话位——feed 分区恒空，历史装载天然跳过） */
export const PENDING_SINGLE_ID = '__pending__';

/** UUIDv7（与 ac-envelope-core issue.ts 同构——前端无 node:crypto，用 getRandomValues） */
function issueLocalConversationId(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  (globalThis as { crypto?: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto?.getRandomValues(bytes);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/** 草稿身份字段（未发送会话的 Agent/模型/工作区选择；正文住 draftParking） */
interface PendingMeta {
  agentId: string;
  model?: string;
  workspaceId?: string;
  /** 待发会话 id（create 发出后留存——失败重试同 id 幂等；落盘确认即清） */
  pendingId?: string;
}

/** localStorage 面（jsdom/node 缺省 undefined——全兜底；与 lastContext 同款姿势） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const lsStore: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

/** 留存序列化（损坏视为无草稿）——导出供测试 */
export function savePending(meta: PendingMeta | null): void {
  try { lsStore?.setItem(PENDING_KEY, JSON.stringify(meta)); } catch { /* ignore */ }
}
export function loadPending(): PendingMeta | null {
  try {
    const raw = lsStore?.getItem(PENDING_KEY);
    if (!raw) return null;
    const e = JSON.parse(raw);
    if (e === null || typeof e !== 'object' || typeof e.agentId !== 'string') return null;
    return {
      agentId: e.agentId,
      ...(typeof e.model === 'string' && e.model !== '' ? { model: e.model } : {}),
      ...(typeof e.workspaceId === 'string' && e.workspaceId !== '' ? { workspaceId: e.workspaceId } : {}),
      ...(typeof e.pendingId === 'string' && e.pendingId !== '' ? { pendingId: e.pendingId } : {}),
    };
  } catch { return null; }
}

/** 迁移：cr-847~850 幻影留存（agentchat.phantomSingles 数组）→ 单例草稿态。
 *  壳行的草稿正文键是 single:<id>——迁移进草稿层（键改哨兵），身份字段
 *  进草稿态；旧键随手清除。无迁移面（无留存/已是新形状）= 无操作。 */
function migratePhantomStore(): void {
  try {
    const raw = lsStore?.getItem('agentchat.phantomSingles');
    if (!raw) return;
    lsStore?.removeItem('agentchat.phantomSingles');
    if (loadPending() !== null) return; // 新层已有草稿：旧壳行不再抢位
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return;
    const first = arr[0] as Record<string, unknown> | null;
    if (first === null || typeof first !== 'object' || typeof first.agentId !== 'string') return;
    const meta: PendingMeta = {
      agentId: first.agentId,
      ...(typeof first.model === 'string' && first.model !== '' ? { model: first.model } : {}),
      ...(typeof first.workspaceId === 'string' && first.workspaceId !== '' ? { workspaceId: first.workspaceId } : {}),
    };
    savePending(meta);
    if (typeof first.id === 'string' && first.id !== '') {
      // 正文迁移：旧键 single:<id> → 哨兵键（草稿层为通用层，不 import 本件）
      try {
        const draftsRaw = lsStore?.getItem('agentchat.drafts');
        if (draftsRaw) {
          const entries: unknown = JSON.parse(draftsRaw);
          if (Array.isArray(entries)) {
            const hit = entries.find((x) => Array.isArray(x) && x[0] === 'single:' + first.id);
            if (Array.isArray(hit) && typeof hit[1] === 'string' && hit[1] !== '') {
              lsStore?.setItem('agentchat.drafts', JSON.stringify([...entries.filter((x) => !(Array.isArray(x) && x[0] === 'single:' + first.id)), ['single:' + PENDING_SINGLE_ID, hit[1]]]));
            }
          }
        }
      } catch { /* 草稿层迁移尽力而为 */ }
    }
  } catch { /* 旧留存损坏 = 视为无迁移面 */ }
}

function seen(track: SinglesTrackOpts['track'], meta: { id?: string } | undefined, removed = false): void {
  if (track && meta?.id) track(meta.id, removed);
}

/** 草稿「有实义」判定：正文非空，或已签发服务端续发 id（发送中断的续发
 *  位——须原位回来）。空正文 + 无续发 id 的残留草稿不构成「正在写」，
 *  不得劫持启动落点（落最近会话；草稿仍列在列表草稿位可继续）。 */
function hasPendingSubstance(meta: PendingMeta): boolean {
  return meta.pendingId !== undefined || takeDraft('single:' + PENDING_SINGLE_ID) !== '';
}

export async function fetchSingles(rpc: Pick<RpcClientFace, 'call'>, opts: SinglesTrackOpts = {}): Promise<{ singles: SingleSession[] }> {
  const r = await rpc.call<{ singles?: SingleSession[] }>('singles/list');
  for (const s of r.singles ?? []) seen(opts.track, s);
  return { singles: r.singles ?? [] };
}

export async function createSingle(
  payload: SingleCreatePayload,
  rpc: Pick<RpcClientFace, 'call'>,
  opts: SinglesTrackOpts = {},
): Promise<{ session: SingleSession; reused?: boolean }> {
  const r = await rpc.call<{ single?: SingleSession; reused?: boolean }>('singles/create', {
    ...(payload.id ? { id: payload.id } : {}),
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    ...(payload.reuse === true ? { reuse: true } : {}),
  });
  seen(opts.track, r.single);
  return { session: r.single as SingleSession, ...(r.reused ? { reused: r.reused } : {}) };
}

/** 更新会话设置（agentId ''=清空待选[已有消息时后端拒绝]；model null=清除覆盖；workspaceId ''=未分组） */
export async function updateSingle(
  id: string,
  payload: { agentId?: string; model?: string | Record<string, unknown> | null; title?: string; workspaceId?: string },
  rpc: Pick<RpcClientFace, 'call'>,
  opts: SinglesTrackOpts = {},
): Promise<{ session: SingleSession }> {
  const r = await rpc.call<{ single?: SingleSession }>('singles/update', {
    id,
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId } : {}),
  });
  seen(opts.track, r.single);
  return { session: r.single as SingleSession };
}

/** 会话分支：复制 anchorMessageId 消息（含）之前的历史为新会话；锚点缺省 = 到最新一条 */
async function forkSingle(
  id: string,
  anchorMessageId: string | undefined,
  rpc: Pick<RpcClientFace, 'call'>,
  opts: SinglesTrackOpts = {},
): Promise<{ session: SingleSession }> {
  const r = await rpc.call<{ single?: SingleSession }>('singles/fork', {
    id,
    ...(anchorMessageId ? { anchorMessageId } : {}),
  });
  seen(opts.track, r.single);
  return { session: r.single as SingleSession };
}

/** 归档（软删，消息保留）——src DELETE（无 purge）语义 */
export async function archiveSingle(id: string, rpc: Pick<RpcClientFace, 'call'>): Promise<{ session: SingleSession }> {
  const r = await rpc.call<{ single?: SingleSession }>('singles/archive', { id });
  return { session: r.single as SingleSession };
}

/** 删除（硬删：元数据 + 消息记录，不可恢复）——src DELETE?purge=1 语义 */
export async function deleteSingle(id: string, rpc: Pick<RpcClientFace, 'call'>, opts: SinglesTrackOpts = {}): Promise<{ deleted: boolean }> {
  await rpc.call('singles/delete', { id });
  opts.track?.(id, true);
  return { deleted: true };
}

// ---- 域投影服务 ----

export class SingleBoardService extends Service {
  readonly singles: Ref<SingleSession[]> = ref([]);
  readonly loaded: Ref<boolean> = ref(false);

  // ---- 单例草稿态（cr-894）----
  // singles = 服务端真值；pending = 未发送草稿的身份字段（可空——无草稿
  // 即 null）。草稿只在编辑面存在：不占列表行（activeSingles = 真值），
  // 经 pendingView 以哨兵 id 挂 single 视角（activeSingle 专用）。
  /** 未发送草稿身份（null = 无草稿） */
  readonly pending: Ref<PendingMeta | null> = ref(null);
  /** 草稿 → SingleSession 形状（哨兵 id——feed 分区恒空，isSingleFresh
   *  天然成立居中开场）。title 不从草稿正文派生：会话头/列表对空会话
   *  恒回落「新会话」（useConversationIdentity/titleOf 同口径），正文
   *  预览顶掉「新会话」是 cr-937 修的体验缺陷——草稿正文的舞台只在
   *  输入框本身。draftsVersion 依赖随之退役（无派生面消费）。 */
  private pendingView(p: PendingMeta): SingleSession {
    const now = new Date().toISOString();
    return {
      id: PENDING_SINGLE_ID,
      agentId: p.agentId,
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }
  /** 全量 = 已物化真值（草稿不占行——列表只看这条） */
  readonly allSingles: ComputedRef<SingleSession[]> = computed(() => this.singles.value);
  private savePending(): void { savePending(this.pending.value); }

  /** 草稿态退役（发送成功/真值帧对账）：身份清空之外，哨兵正文位同步
   *  清键。不清的后果 = 串台（cr-937）：发送后 ChatInput 草稿转场 watcher
   *  会把残留 inputText 回写哨兵键（watcher flush 先于发送链 clear），
   *  下一个新会话 takeDraft 哨兵键即取到上一会话的已发正文。清键走
   *  parkDraft 空串（= 删键，两层同步）。 */
  private retireDraft(): void {
    this.pending.value = null;
    this.savePending();
    parkDraft('single:' + PENDING_SINGLE_ID, '');
  }

  /** 活跃独立会话 id（派生自 feed 活跃分区——会话上下文的唯一事实源在会话服务） */
  readonly activeSingleId: ComputedRef<string> = computed(() => this.own.sessions.feed.activeSingleId.value);
  /** 活跃会话：哨兵 → 草稿视图；否则真值行 */
  readonly activeSingle: ComputedRef<SingleSession | null> = computed(() =>
    this.activeSingleId.value === PENDING_SINGLE_ID
      ? (this.pending.value !== null ? this.pendingView(this.pending.value) : null)
      : (this.activeSingleId.value ? this.singles.value.find(s => s.id === this.activeSingleId.value) ?? null : null),
  );
  /** 列表只显示未归档（草稿不在列——未发送不占行） */
  readonly activeSingles: ComputedRef<SingleSession[]> = computed(() => this.allSingles.value.filter(s => s.status === 'active'));

  /** 构造期 ctx = 本域插件 fiber（帧订阅绑定于此——卸载即回收，D5） */
  private readonly own: ClientContext;
  /** 草稿留存已恢复标记（一次性——refresh 重复调用不重放） */
  private pendingRestored = false;

  constructor(ctx: Context) {
    super(ctx, 'singleBoard');
    this.own = ctx as ClientContext;
    migratePhantomStore(); // cr-847~850 旧幻影留存 → 单例草稿态（一次性）
    // wire singles/updated → 增量合并（mergeUpdate，零 RPC；全量 refresh 只留
    // 重连兜底与显式调用方）
    this.own.fiber.effect(() => this.own.rpc.onEvent((type, args) => {
      if (type === 'singles/updated') this.mergeUpdate(args[0] as SingleSession | undefined, args[1] as 'created' | 'updated' | 'archived' | 'removed' | undefined);
    }), 'singleBoard.wire');
    // 重连即刷：断连期间 singles/updated 帧丢失（新建/改名/归档不可见）
    // ——WS 恢复后补拉一次（feed-core/runview 同款恢复位；onOpen 可选
    // 成员，测试桩缺席时跳过）。onEpoch = 宿主换代（cr-948）：无条件全刷；
    // resyncRetry = restart_host 后首连撞 boot 早期窗口的失败退避重试。
    this.own.fiber.effect(() => {
      const offOpen = this.own.rpc.onOpen?.(() => {
        if (this.loaded.value) resyncRetry('singleBoard', () => this.refresh());
      }) ?? (() => {});
      const offEpoch = this.own.rpc.onEpoch?.(() => {
        resyncRetry('singleBoard', () => this.refresh());
      }) ?? (() => {});
      return () => { offOpen(); offEpoch(); };
    }, 'singleBoard.reconnect');
  }

  /** presence 同步面（帧路由 single~sid 判别——sessions 协调面） */
  private track(id: string | undefined, removed = false): void {
    if (id) this.own.sessions.trackKnownSingle(id, removed);
  }

  async refresh(): Promise<void> {
    try {
      const d = await fetchSingles(this.own.rpc, { track: (id, removed) => this.track(id, removed) });
      this.singles.value = d.singles;
      this.loaded.value = true;
      // 草稿恢复（首启/重载）：草稿层先行（正文），草稿身份随后——顺序
      // 承 cr-849：hasPendingSubstance 判「有实义」要读草稿层正文。
      restoreDrafts();
      if (!this.pendingRestored) {
        if (this.pending.value === null) this.pending.value = loadPending();
        this.pendingRestored = true;
      }
      // 真值接管清理（cr-849 同义收敛）：待发 id 已被服务端确认（上次 create
      // 实际成功但响应丢失/刷新抢跑）→ 草稿态退役（会话已是真值行）
      const pid = this.pending.value?.pendingId;
      if (pid !== undefined && d.singles.some(s => s.id === pid)) {
        this.retireDraft(); // 真值接管：哨兵正文位同步清键（cr-937 串台防线）
      }
      // single 未读对账（cr-290）：active 集外分区的未读 = 会话已删/归档——
      // 无行可点无清除路径（tab 聚合徽章永久残留），顺手清 + 写穿
      this.own.sessions.pruneSingleUnread(this.activeSingles.value.map(s => s.id));
    } catch (err: unknown) {
      console.warn('[SingleBoard] 拉取独立会话列表失败:', (err as { message?: string }).message ?? String(err));
    }
  }

  /**
   * 增量合并 singles/updated 帧（2026-09-24 卡顿优化）：
   * 载荷 = 变更后终值 + 类别——本地 upsert，零 RPC。
   *   · created/updated/archived → 原地替换或插入（保持列表的最近活动序——
   *     新条目插到最前；lastActivity 帧不带，沿用旧条目值，created 无值
   *     回落 createdAt 语义与 list 装配一致）；
   *   · removed → 摘除；
   *   · 列表未装载（冷启动首帧先于 fetch 到达）→ 忽略（首次 refresh 会
   *     带上全量真值，避免在空列表上合并出残缺快照）。
   * presence 同步（track）随合并执行——与 fetchSingles 的 seen 钩子同面。
   */
  private mergeUpdate(meta: SingleSession | undefined, action: 'created' | 'updated' | 'archived' | 'removed' | undefined, opts: { local?: boolean } = {}): void {
    if (!meta?.id || !action) return;
    // 未装载不合并（首次全量负责）——仅对外部帧：本端 RPC 返回值是权威数据
    //（create 在冷启动路径 makeClient 等场景 board 尚未 fetch，列表合并仍须生效）
    if (!opts.local && !this.loaded.value) return;
    // 真值到达（created/updated）= 草稿态退役——待发 id 已被服务端确认
    //（物化回执/created 帧/auto-title 的 updated 帧），会话由真值行接管
    if ((action === 'created' || action === 'updated') && this.pending.value?.pendingId === meta.id) {
      this.retireDraft(); // 真值接管：哨兵正文位同步清键（cr-937 串台防线）
    }
    this.track(meta.id, action === 'removed');
    const list = this.singles.value;
    const idx = list.findIndex((s) => s.id === meta.id);
    if (action === 'removed') {
      if (idx >= 0) this.singles.value = list.filter((s) => s.id !== meta.id);
      return;
    }
    // 保留旧条目的 lastActivity（帧载荷不带——标题/归档不改消息文件，旧值仍准）
    const merged: SingleSession = idx >= 0
      ? { ...meta, ...(list[idx].lastActivity ? { lastActivity: list[idx].lastActivity } : {}) }
      : meta;
    if (idx >= 0) {
      const next = [...list];
      next[idx] = merged;
      this.singles.value = next;
    } else {
      // created（或别端新建）：插到最前（列表按最近活动降序——新会话居首）
      this.singles.value = [merged, ...list];
    }
  }

  /** 快速创建空会话（P4：无 Agent；已有空会话时复用，避免堆积空白条目）。
   *  延迟落盘主入口已改 startDraft（cr-894）；本方法留作旧路径兜底。 */
  async createQuick(): Promise<SingleSession | null> {
    return this.create({ reuse: true });
  }

  /**
   * 进入草稿位（新建会话入口，cr-894）：无草稿即建（身份字段就地），
   * 有草稿 = 回到它——服务端零往返零落盘，id 延迟到首次发送签发。
   * 不比较配置回到唯一草稿（cr-848 裁决沿用）：草稿的 Agent/模型/工作区
   * 可随后在会话里改，按配置匹配会让「写了半截换过 Agent」的草稿漏网。
   */
  startDraft(payload: { agentId?: string; model?: string; workspaceId?: string } = {}): SingleSession {
    // 已有草稿 = 回到它（偏好补位同 cr-850 语义：显式工作区重挂；Agent/
    // 模型只在草稿尚无显式选择时补——用户改过则尊重不回跳）
    const existing = this.pending.value;
    const next: PendingMeta = existing ?? { agentId: payload.agentId ?? '', ...(payload.model ? { model: payload.model } : {}), ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}) };
    if (existing) {
      const ws = payload.workspaceId;
      Object.assign(next, {
        ...(ws !== undefined && ws !== '' ? { workspaceId: ws } : {}),
        ...(existing.agentId === '' && payload.agentId ? { agentId: payload.agentId } : {}),
        ...(existing.model === undefined && payload.model ? { model: payload.model } : {}),
      });
    }
    this.pending.value = next;
    this.savePending();
    const view = this.pendingView(next);
    this.selectPending();
    return view;
  }

  /**
   * 发送草稿（首条消息出门前调用——ChatInput 侧）：首次签发 id（留存作
   * 幂等锚）→ singles/create → 真值接管（草稿态清空 + 上下文重建）。
   * 失败 = id 留存不动，重试同 id（create 幂等）——失败窗口不产生孤儿
   * 空会话。落盘确认后 pendingId 无用即清（整个草稿态退役）。
   */
  async dispatchDraft(): Promise<SingleSession | null> {
    const p = this.pending.value;
    if (p === null) return null;
    const id = p.pendingId ?? issueLocalConversationId();
    if (p.pendingId === undefined) {
      this.pending.value = { ...p, pendingId: id };
      this.savePending();
    }
    try {
      const session = await this.create({ id, ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}) });
      if (p.model !== undefined) await this.updateSession(id, { model: p.model }).catch(() => undefined);
      // 真值接管：草稿态清空 + 上下文切到真值行（feed 身份映射刷新）。
      // cr-937 串台防线：create 内 selectSingleBy 已切 activeSingleId，
      // 若下方 model 覆盖的 await 窗口让 ChatInput 转场 watcher 抢先
      // flush，残留 inputText 会被回写哨兵键（from 键此刻仍是哨兵）——
      // 本清键在收尾同步段执行，晚于任何回写，哨兵位终值恒空，下一个
      // 新会话 takeDraft 哨兵键不再命中旧正文。
      this.retireDraft();
      this.selectSingleBy(session);
      return session;
    } catch (err: unknown) {
      // 失败 fail-loud：pendingId 留存（重试同 id），发送层会收到异常
      console.warn('[SingleBoard] 草稿发送失败（重试将复用会话 id）:', (err as { message?: string }).message ?? String(err));
      throw err;
    }
  }

  /** 草稿态判定（ChatInput 发送前 dispatchDraft 的判据） */
  isPending(): boolean {
    return this.pending.value !== null;
  }

  /** 激活草稿视角（哨兵 id 挂 single 视角——上下文目标 = 草稿 Agent/默认预设） */
  private selectPending(): void {
    const p = this.pending.value;
    if (p === null) return;
    this.own.sessions.chat.setSingleContext(
      PENDING_SINGLE_ID,
      p.agentId || this.own.roster.defaultPresetId.value,
      typeof p.model === 'string' && p.model ? p.model : undefined,
    );
  }

  /** 创建并立即进入会话 */
  async create(payload: SingleCreatePayload): Promise<SingleSession> {
    const d = await createSingle(payload, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    // 2026-09-24 卡顿优化：不再全量 refresh 后经列表 find 激活——created 帧的
    // 增量合并会更新列表，激活直接用 RPC 返回值（省一次 379 会话全量扫描
    // + 等待；此前「点新建 → 卡 → 进入」的串行链在此拆断）
    this.mergeUpdate(d.session, 'created', { local: true });
    this.selectSingleBy(d.session);
    return d.session;
  }

  /**
   * 激活独立会话：设置会话上下文。历史加载由 ConversationView 的 single watch 统一触发
   * （与 group 模式一致：列表只切上下文，视图层负责加载）。
   * agentId 空 = 默认预设（src 同款：空 Agent 会话路由到 __standard__，
   * 由 ac-agent-presets 物化进 agents 注册表）
   */
  selectSingle(sessionId: string): void {
    const session = this.allSingles.value.find(s => s.id === sessionId);
    if (!session || session.status === 'archived') return;
    this.selectSingleBy(session);
  }

  /** 按会话对象直接激活（列表点击传 find 结果；create 传 RPC 返回值——不等列表刷新） */
  private selectSingleBy(session: SingleSession): void {
    this.own.sessions.chat.setSingleContext(
      session.id,
      session.agentId || this.own.roster.defaultPresetId.value,
      typeof session.model === 'string' && session.model ? session.model : undefined,
    );
    saveLastContext({ kind: 'single', id: session.id });
  }

  /** 回到 pair 会话（不清列表数据） */
  deselectSingle(): void {
    this.own.sessions.chat.clearSingleContext();
    clearLastContextIf('single');
  }

  /** 刷新恢复：上次上下文是 single 时恢复选中（会话已删/已归档则清掉过期记录） */
  restoreLastSingle(): string | null {
    const last = loadLastContext();
    if (last?.kind !== 'single') return null;
    // 草稿位同样可恢复（lastContext 指向哨兵 = 上次刷新前正在编辑未发送）。
    // 空正文草稿不抢位（crash-hardening 批收口：残留空草稿会把启动落点
    // 永久劫持到空白会话——「正在写」的事实以正文/续发 id 为准）
    if (last.id === PENDING_SINGLE_ID) {
      if (this.pending.value !== null && hasPendingSubstance(this.pending.value)) {
        this.selectPending();
        return last.id;
      }
      clearLastContextIf('single');
      return null;
    }
    const session = this.allSingles.value.find(s => s.id === last.id);
    if (!session || session.status !== 'active') {
      clearLastContextIf('single');
      return null;
    }
    this.selectSingle(last.id);
    return last.id;
  }

  /**
   * 启动进入 single 会话（首启体验：开箱即会话页）。三级回落：
   *   ① lastContext 有 single 记录 → 恢复上次选中（restoreLastSingle 原语义）；
   *   ② 无任何上下文记录（首次启动）→ 选中最近活跃的独立会话；
   *   ③ 列表为空 → 草稿位开局（延迟落盘：偏好在 ChatInput 挂载时回放）。
   * lastContext 有 agent/group 记录（上次不在独立会话）→ 不动，沿用户
   * 上次所在的上下文恢复。草稿优先于最近会话（未发送的草稿比「上次的
   * 对话」更要紧——用户刷新前正在写的那个会话应原位回来）。
   */
  async openDefaultSingle(): Promise<string | null> {
    const restored = this.restoreLastSingle();
    if (restored) return restored;
    if (loadLastContext()) return null; // 上次在 agent/group：尊重既有恢复链
    if (this.pending.value !== null && hasPendingSubstance(this.pending.value)) {
      this.selectPending();
      return PENDING_SINGLE_ID;
    }
    const recent = [...this.activeSingles.value].sort((a, b) =>
      Date.parse(b.lastActivity ?? b.updatedAt) - Date.parse(a.lastActivity ?? a.updatedAt)).at(0);
    if (recent) {
      this.selectSingle(recent.id);
      return recent.id;
    }
    // 列表为空 → 草稿位开局（偏好在 ChatInput 挂载时回放，发送时以草稿为准）
    return this.startDraft().id;
  }

  /**
   * 更新会话设置（输入栏内联调整：换 Agent（''=清空待选；已有消息时后端 409 禁改）/
   * 换模型覆盖（null=清除）/ 挂工作区（''=移入未分组）/ 重命名（title））。
   * 换 Agent 时同步刷新会话上下文（feed 消息身份映射 + 后续投递目标）。
   */
  async updateSession(sessionId: string, payload: SingleUpdatePayload): Promise<SingleSession | null> {
    // 草稿态：设置本地生效（agentId/model/workspaceId 记入草稿身份），
    // 发送时随创建落盘——服务端此刻还没有这个会话
    if (sessionId === PENDING_SINGLE_ID && this.pending.value !== null) {
      const prev = this.pending.value;
      const next: PendingMeta = {
        ...prev,
        ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
        ...(payload.model !== undefined ? { model: payload.model === null || typeof payload.model !== 'string' ? undefined : payload.model } : {}),
        ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId === '' ? undefined : payload.workspaceId } : {}),
      };
      this.pending.value = next;
      this.savePending();
      if (payload.agentId !== undefined || payload.model !== undefined) {
        this.own.sessions.chat.setSingleContext(PENDING_SINGLE_ID, next.agentId || this.own.roster.defaultPresetId.value,
          typeof next.model === 'string' && next.model ? next.model : undefined);
      }
      return this.pendingView(next);
    }
    const d = await updateSingle(sessionId, payload, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    // 帧增量合并（updated 帧同值到达时幂等）；上下文重建直接用服务端回显值
    // ——不再全量 refresh 后 find（2026-09-24 卡顿优化，同 create）
    this.mergeUpdate(d.session, 'updated', { local: true });
    if ((payload.agentId !== undefined || payload.model !== undefined) && this.activeSingleId.value === sessionId) {
      const model = typeof d.session.model === 'string' && d.session.model ? d.session.model : undefined;
      this.own.sessions.chat.setSingleContext(sessionId, d.session.agentId || this.own.roster.defaultPresetId.value, model);
    }
    return d.session;
  }

  /**
   * 会话分支：复制 anchorMessageId 消息（含）之前的历史为新会话并立即
   * 进入。元数据（Agent/模型/工作区/标题）由后端继承；空锚点 = 全量
   * 复制。失败返回 null（调用方自行提示，分支按钮层已挡无效锚点）。
   */
  async fork(sessionId: string, anchorMessageId?: string): Promise<SingleSession | null> {
    try {
      const d = await forkSingle(sessionId, anchorMessageId, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
      // 增量合并 + 返回值直激活（created 帧会带同值再合并一次——幂等无害）
      this.mergeUpdate(d.session, 'created', { local: true });
      this.selectSingleBy(d.session);
      return d.session;
    } catch (err: unknown) {
      console.warn('[SingleBoard] 会话分支失败:', (err as { message?: string }).message ?? String(err));
      return null;
    }
  }

  /** 归档（软删）：若正打开则先退出。草稿位 = 本地清除（服务端无此会话） */
  async archive(sessionId: string): Promise<void> {
    if (sessionId === PENDING_SINGLE_ID) {
      this.discardDraft();
      return;
    }
    const d = await archiveSingle(sessionId, this.own.rpc);
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    // 增量合并（archived 帧同值幂等）——服务端回显 status 终值
    this.mergeUpdate(d.session, 'archived', { local: true });
  }

  /** 删除（硬删：元数据+消息）：若正打开则先退出。草稿位 = 本地清除（服务端无此会话） */
  async remove(sessionId: string): Promise<void> {
    if (sessionId === PENDING_SINGLE_ID) {
      this.discardDraft();
      return;
    }
    await deleteSingle(sessionId, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    // 本地摘除（removed 帧同值幂等）——立即从列表消失
    this.mergeUpdate({ id: sessionId } as SingleSession, 'removed', { local: true });
  }

  /** 丢弃草稿（归档/删除入口对草稿位的语义）：身份清空 + 草稿正文清位 +
   *  退出草稿视角。清正文经草稿层通用写口（parkDraft 空串 = 删键）。 */
  discardDraft(): void {
    this.pending.value = null;
    this.savePending();
    parkDraft('single:' + PENDING_SINGLE_ID, '');
    if (this.activeSingleId.value === PENDING_SINGLE_ID) this.deselectSingle();
  }

  /** 列表展示标题（经 agents 名册解析（含预设目录）；空 = 默认预设）。
   *  空会话（lastActivity 缺席——isSingleFresh 同源口径）恒「新会话」：
   *  切换预设 agentId 从空变非空不改变回落形状（cr-891——旧形状以 agentId
   *  为界，空会话标题从「新会话」跳成「Agent · 创建时间」）。有消息无标题
   *  回落 = Agent 名（cr-892：与 identity 头部 cr-33 同形状——回落窗口只在
   *  auto-title 未落盘的片刻，创建时间无信息量）。 */
  titleOf(s: SingleSession, agentName: (id: string) => string): string {
    if (!s.lastActivity || !s.agentId) return s.title || '新会话';
    return s.title || agentName(s.agentId);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** singles 域投影（ac-client-ui-singles client 半边提供）：独立会话列表/激活态 + 上下文协调 */
    singleBoard: SingleBoardService;
  }
}

/** singles 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const singlesClientPlugin = clientPlugin({
  name: 'ac-client-ui-singles.client',
  inject: ['rpc', 'sessions', 'roster', 'slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(SingleBoardService);
    // sessions 会话列表面板（M28 P2：原 sidebar ListPanelsHost 内联面板
    // 迁入；primary-sidebar:domain 选举席贡献——壳 PrimarySidebarHost 按
    // ui.primaryPanel × meta.panel 选举）
    ctx.slots.inject('primary-sidebar:domain', () =>
      ctx.slots.register('primary-sidebar:domain', {
        id: 'webui-domain-singles.panel',
        component: defineAsyncComponent(() => import('./SessionListHost.vue')),
        meta: { panel: 'sessions' },
      }),
    );
    // single 视角出厂贡献（M28 P0-2/T6：视角 = 跨包引用 ConversationView
    // 内核 + 域 props；行卸载 → 独立会话视角消失，talk 回落）。经 slots.inject
    // 声明存活期效应落位（在场即注册/缺席即等待/塌缩或卸载即回收）。
    // 【事故修复】active/props 一律 ctx.get('singleBoard') 可选探测——
    // 直接属性访问在本件 ctx 会抛 "cannot get property without inject"
    //（M28 P0.2 潜伏缺陷，同 ui-group 事故；talk def 姿势为正解）。
    ctx.slots.inject('main:perspective', () =>
      ctx.slots.register('main:perspective', {
        id: 'single',
        component: ConversationView,
        order: 40,
        meta: {
          def: {
            id: 'single', label: '独立会话', icon: 'edit-3', order: 40,
            active: () => !!ctx.get('singleBoard')?.activeSingleId.value,
            component: ConversationView,
            props: () => ({ group: null, single: ctx.get('singleBoard')?.activeSingle.value ?? null }),
          },
        },
      }),
    );
    // 会话头独立会话动作族（会话区重构自 ConversationView 内联迁域归位：
    // conversation:header-widget 贡献 order 30——single 形态更多菜单
    //（归档独立会话，确认弹窗随件内迁））
    ctx.slots.inject('conversation:header-widget', () =>
      ctx.slots.register('conversation:header-widget', {
        id: 'single-actions',
        component: defineAsyncComponent(() => import('./SingleHeaderActions.vue')),
        order: 30,
      }),
    );
  },
});

// boot graph 装载契约（webui/src/runtime/bootGraph.ts loadEntry 只认
// mod.default 的 apply）——本件是行 client 半边入口，default 出口不是
// 冗余别名而是装载面本体：md 的「全仓零消费」grep 扫不到动态 import 面，
// cr-459 曾据此判死删除 → ui-singles 整行被装载器静默跳过。
// 跨行一致性由 webui/tests/row-client-default-export.test.ts 锁定。
export default singlesClientPlugin;
