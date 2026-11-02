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
import { clientPlugin, type ClientContext, type RpcClientFace, loadLastContext, saveLastContext, clearLastContextIf } from 'ac-client-runtime';
import { takeDraft, parkDraft, restoreDrafts, draftsVersion } from 'ac-client-ui-conversation/client/draftParking.ts';
import { loadComposePrefs } from 'ac-client-ui-conversation/client/composePrefs.ts';
import { defineAsyncComponent, ref, computed, type ComputedRef, type Ref } from 'vue';

// single 视角组件（异步：node 环境消费本模块〔portb-e2e〕不求值 .vue
// 视图链——ConversationView 内核经 domain→base 跨包引用，浏览器首渲染时
// 装载。会话区重构更名：DialogView → ConversationView）
const ConversationViewAsync = defineAsyncComponent(() => import('ac-client-ui-conversation/client/ConversationView.vue'));

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

// ---- 幻影会话（延迟落盘，cr-847）----
// 新建会话不再立即 RPC 落盘：本地签发 id + 草稿暂存成「幻影」——列表
// 可见可进入可编辑草稿，服务端零痕迹；首条消息发送时物化（singles/create
// 带同 id + conversation/deliver），上下文/帧路由/草稿键全程同一 id，
// 用户全程无感。localStorage 留存（刷新/重启后幻影仍在——草稿不丢）。

/** 留存键（独立于草稿层：草稿键 single:<id> 与幻影 id 一一对应，但幻影
 *  集是列表态（要不要显示该行）、草稿是输入态（行内正文），两层分离） */
const PHANTOM_KEY = 'agentchat.phantomSingles';

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

/** 幻影元数据（SingleSession 形状的本地子集 + 留存时间戳） */
interface PhantomMeta {
  id: string;
  agentId: string;
  model?: string;
  workspaceId?: string;
  createdAt: string;
}

/** localStorage 面（jsdom/node 缺省 undefined——全兜底；与 lastContext 同款姿势） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const lsStore: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

/** 留存序列化（损坏整份丢弃）——导出供测试 */
export function savePhantoms(list: PhantomMeta[]): void {
  try { lsStore?.setItem(PHANTOM_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export function loadPhantoms(): PhantomMeta[] {
  try {
    const raw = lsStore?.getItem(PHANTOM_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: PhantomMeta[] = [];
    for (const e of arr) {
      if (typeof e?.id === 'string' && e.id !== '' && typeof e.agentId === 'string' && typeof e.createdAt === 'string') {
        out.push({
          id: e.id, agentId: e.agentId,
          ...(typeof e.model === 'string' && e.model !== '' ? { model: e.model } : {}),
          ...(typeof e.workspaceId === 'string' && e.workspaceId !== '' ? { workspaceId: e.workspaceId } : {}),
          createdAt: e.createdAt,
        });
      }
    }
    return out;
  } catch { return []; }
}

function seen(track: SinglesTrackOpts['track'], meta: { id?: string } | undefined, removed = false): void {
  if (track && meta?.id) track(meta.id, removed);
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

  // ---- 幻影会话集（延迟落盘，cr-847）----
  // 与已物化列表分源：singles = 服务端真值，phantoms = 本地未落盘态。
  // 消费面（activeSingle/activeSingles/titleOf…）经 allSingles 并入——
  // 列表/视角/选择链零改动地看见幻影。物化后从幻影集移除、由真值接管。
  /** 幻影集（服务端会话目录尚不存在——id 已定、草稿/元数据本地） */
  readonly phantoms: Ref<PhantomMeta[]> = ref([]);
  /** 幻影 → SingleSession 形状（title 由草稿派生——列表可见「正在写什么」；
   *  draftsVersion 为响应锚：清草稿/改草稿时派生 title 即时重算） */
  private phantomView(p: PhantomMeta): SingleSession {
    void draftsVersion.value;
    const draft = takeDraft('single:' + p.id);
    return {
      id: p.id,
      agentId: p.agentId,
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(draft ? { title: draft.replace(/\n[\s\S]*$/, '').slice(0, 24) + (draft.length > 24 ? '…' : '') } : {}),
      ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
      status: 'active',
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    };
  }
  /** 全量 = 已物化 ∪ 幻影（幻影排最前——最新创建） */
  readonly allSingles: ComputedRef<SingleSession[]> = computed(() =>
    [...this.phantoms.value.map(p => this.phantomView(p)), ...this.singles.value],
  );
  private savePhantoms(): void { savePhantoms(this.phantoms.value); }

  /** 活跃独立会话 id（派生自 feed 活跃分区——会话上下文的唯一事实源在会话服务） */
  readonly activeSingleId: ComputedRef<string> = computed(() => this.own.sessions.feed.activeSingleId.value);
  readonly activeSingle: ComputedRef<SingleSession | null> = computed(() =>
    this.activeSingleId.value ? this.allSingles.value.find(s => s.id === this.activeSingleId.value) ?? null : null,
  );
  /** 列表只显示未归档 */
  readonly activeSingles: ComputedRef<SingleSession[]> = computed(() => this.allSingles.value.filter(s => s.status === 'active'));

  /** 构造期 ctx = 本域插件 fiber（帧订阅绑定于此——卸载即回收，D5） */
  private readonly own: ClientContext;
  /** 幻影留存已恢复标记（一次性——refresh 重复调用不重放） */
  private phantomsRestored = false;

  constructor(ctx: Context) {
    super(ctx, 'singleBoard');
    this.own = ctx as ClientContext;
    // wire singles/updated → 增量合并（mergeUpdate，零 RPC；全量 refresh 只留
    // 重连兜底与显式调用方）
    this.own.fiber.effect(() => this.own.rpc.onEvent((type, args) => {
      if (type === 'singles/updated') this.mergeUpdate(args[0] as SingleSession | undefined, args[1] as 'created' | 'updated' | 'archived' | 'removed' | undefined);
    }), 'singleBoard.wire');
    // 重连即刷：断连期间 singles/updated 帧丢失（新建/改名/归档不可见）
    // ——WS 恢复后补拉一次（feed-core/runview 同款恢复位；onOpen 可选
    // 成员，测试桩缺席时跳过）
    this.own.fiber.effect(() => this.own.rpc.onOpen?.(() => {
      if (this.loaded.value) void this.refresh();
    }) ?? (() => {}), 'singleBoard.reconnect');
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
      // 幻影对账：服务端已出现同 id（别端/前次会话物化）→ 幻影退役（真值接管）
      // 留存恢复（首启/重载）：草稿层先行，幻影随后——恢复必须先于对账：
      // 残留幻影（上次会话物化后因刷新丢失摘除事件的）只有经过真值校验
      // 才能退役，否则永久躲过对账 = 列表双行 + 新增恒复用（cr-849）
      restoreDrafts();
      if (!this.phantomsRestored) {
        if (this.phantoms.value.length === 0) this.phantoms.value = loadPhantoms();
        this.phantomsRestored = true;
      }
      // 幻影对账：服务端已出现同 id（物化/别端创建）→ 幻影退役（真值接管）
      if (this.phantoms.value.length > 0) {
        const live = new Set(d.singles.map(s => s.id));
        const keep = this.phantoms.value.filter(p => !live.has(p.id));
        if (keep.length !== this.phantoms.value.length) {
          this.phantoms.value = keep;
          this.savePhantoms();
        }
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
    // 真值到达（created/updated）= 幻影退役——任何服务端真值帧都证明该
    // 会话已落盘（物化回执/created 帧/auto-title 的 updated 帧）
    if ((action === 'created' || action === 'updated') && this.phantoms.value.some(p => p.id === meta.id)) {
      this.phantoms.value = this.phantoms.value.filter(p => p.id !== meta.id);
      this.savePhantoms();
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

  /** 快速创建空会话（P4：无 Agent；已有空会话时复用，避免堆积空白条目）
   *  常规新建入口已改 createPhantom（延迟落盘）；本方法留作旧路径兜底。 */
  async createQuick(): Promise<SingleSession | null> {
    return this.create({ reuse: true });
  }

  /**
   * 新建幻影会话（延迟落盘主入口，cr-847）：本地签发 id + 草稿位就绪，
   * 立即激活进入——服务端零往返零落盘。首条消息发送时经 materialize
   * 物化（同一 id）。
   * 单幻影约束（cr-848）：未发送的新会话全局唯一——已有幻影时一律
   * 复用（不比较配置：幻影的 Agent/模型/工作区可随后在会话里改，按
   * 配置匹配会让「写了半截换过 Agent」的旧幻影漏网、连点新增堆积成串）；
   * 显式从某工作区发起时只更新挂载（重挂不改 id——草稿/上下文零迁移）。
   */
  createPhantom(payload: { agentId?: string; model?: string; workspaceId?: string } = {}): SingleSession {
    const existing = this.phantoms.value.at(0);
    if (existing) {
      // 复用 + 偏好补位（cr-850）：显式工作区参数重挂；Agent/模型只在幻影
      // 尚无显式选择时从偏好补（用户在会话里改过则尊重，不回跳）
      const ws = payload.workspaceId;
      const next: PhantomMeta = {
        ...existing,
        ...(ws !== undefined && ws !== '' ? { workspaceId: ws } : {}),
        ...(existing.agentId === '' && payload.agentId ? { agentId: payload.agentId } : {}),
        ...(existing.model === undefined && payload.model ? { model: payload.model } : {}),
      };
      if (next !== existing) {
        this.phantoms.value = this.phantoms.value.with(0, next);
        this.savePhantoms();
      }
      const view = this.phantomView(next);
      this.selectSingleBy(view);
      return view;
    }
    const now = new Date().toISOString();
    const p: PhantomMeta = {
      id: issueLocalConversationId(),
      agentId: payload.agentId ?? '',
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      createdAt: now,
    };
    this.phantoms.value = [p, ...this.phantoms.value];
    this.savePhantoms();
    const view = this.phantomView(p);
    this.selectSingleBy(view);
    return view;
  }

  /**
   * 物化幻影会话（首条消息发送前调用——ChatInput 侧）：singles/create 带
   * 同 id 落盘 + 更新真值列表 + 摘除幻影。幂等：非幻影 id 直接返回（已
   * 物化/常规会话——重复调用无害）。
   */
  async materialize(phantomId: string): Promise<SingleSession | null> {
    const p = this.phantoms.value.find(x => x.id === phantomId);
    if (!p) return this.singles.value.find(s => s.id === phantomId) ?? null;
    try {
      const session = await this.create({ id: p.id, ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}) });
      this.phantoms.value = this.phantoms.value.filter(x => x.id !== phantomId);
      this.savePhantoms();
      if (p.model !== undefined) await this.updateSession(phantomId, { model: p.model }).catch(() => undefined);
      // 上下文重建（物化视图带服务端时间戳——feed 身份映射刷新）
      this.selectSingleBy(session);
      return session;
    } catch (err: unknown) {
      // 物化失败 fail-loud：幻影保留（用户草稿/上下文不动），发送层会收到异常
      console.warn('[SingleBoard] 会话物化失败:', (err as { message?: string }).message ?? String(err));
      throw err;
    }
  }

  /** 幻影态判定（ChatInput 发送前物化的判据——非幻影即常规会话） */
  isPhantom(id: string): boolean {
    return this.phantoms.value.some(p => p.id === id);
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
    // 幻影行同样可恢复（lastContext 指向幻影 = 上次刷新前正在编辑未发送）
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
   *   ③ 列表为空 → 新建本地幻影会话并进入（延迟落盘，cr-847）。
   * lastContext 有 agent/group 记录（上次不在独立会话）→ 不动，沿用户
   * 上次所在的上下文恢复。
   */
  async openDefaultSingle(): Promise<string | null> {
    const restored = this.restoreLastSingle();
    if (restored) return restored;
    if (loadLastContext()) return null; // 上次在 agent/group：尊重既有恢复链
    // 幻影优先于最近会话（未发送的草稿会话比「上次的对话」更要紧——
    // 用户刷新前正在写的那个会话应原位回来）
    const phantom = this.phantoms.value.at(0);
    if (phantom) {
      this.selectSingle(phantom.id);
      return phantom.id;
    }
    const recent = [...this.activeSingles.value].sort((a, b) =>
      Date.parse(b.lastActivity ?? b.updatedAt) - Date.parse(a.lastActivity ?? a.updatedAt)).at(0);
    if (recent) {
      this.selectSingle(recent.id);
      return recent.id;
    }
    // 列表为空 → 本地幻影会话（延迟落盘：偏好在 ChatInput 挂载时回放——
    // 此处不透传，物化时以幻影元数据为准）
    const fresh = this.createPhantom();
    return fresh.id;
  }

  /**
   * 更新会话设置（输入栏内联调整：换 Agent（''=清空待选；已有消息时后端 409 禁改）/
   * 换模型覆盖（null=清除）/ 挂工作区（''=移入未分组）/ 重命名（title））。
   * 换 Agent 时同步刷新会话上下文（feed 消息身份映射 + 后续投递目标）。
   */
  async updateSession(sessionId: string, payload: SingleUpdatePayload): Promise<SingleSession | null> {
    // 幻影态：设置本地生效（agentId/model/workspaceId 记入幻影元数据），
    // 物化时随创建落盘——服务端此刻还没有这个会话
    const pi = this.phantoms.value.findIndex(p => p.id === sessionId);
    if (pi >= 0) {
      const prev = this.phantoms.value[pi]!;
      const next: PhantomMeta = {
        ...prev,
        ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
        ...(payload.model !== undefined ? { model: payload.model === null || typeof payload.model !== 'string' ? undefined : payload.model } : {}),
        ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId === '' ? undefined : payload.workspaceId } : {}),
      };
      this.phantoms.value = this.phantoms.value.with(pi, next);
      this.savePhantoms();
      if ((payload.agentId !== undefined || payload.model !== undefined) && this.activeSingleId.value === sessionId) {
        this.own.sessions.chat.setSingleContext(sessionId, next.agentId || this.own.roster.defaultPresetId.value,
          typeof next.model === 'string' && next.model ? next.model : undefined);
      }
      return this.phantomView(next);
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

  /** 归档（软删）：若正打开则先退出。幻影 = 本地清除（服务端无此会话） */
  async archive(sessionId: string): Promise<void> {
    if (this.isPhantom(sessionId)) {
      this.phantoms.value = this.phantoms.value.filter(p => p.id !== sessionId);
      this.savePhantoms();
      parkDraft('single:' + sessionId, '');
      if (this.activeSingleId.value === sessionId) this.deselectSingle();
      return;
    }
    const d = await archiveSingle(sessionId, this.own.rpc);
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    // 增量合并（archived 帧同值幂等）——服务端回显 status 终值
    this.mergeUpdate(d.session, 'archived', { local: true });
  }

  /** 删除（硬删：元数据+消息）：若正打开则先退出。幻影 = 本地清除（服务端无此会话） */
  async remove(sessionId: string): Promise<void> {
    if (this.isPhantom(sessionId)) {
      this.phantoms.value = this.phantoms.value.filter(p => p.id !== sessionId);
      this.savePhantoms();
      parkDraft('single:' + sessionId, '');
      if (this.activeSingleId.value === sessionId) this.deselectSingle();
      return;
    }
    await deleteSingle(sessionId, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    // 本地摘除（removed 帧同值幂等）——立即从列表消失
    this.mergeUpdate({ id: sessionId } as SingleSession, 'removed', { local: true });
  }

  /** Agent 名（列表展示用；经 agents 名册解析（含预设目录）；空 = 默认预设） */
  titleOf(s: SingleSession, agentName: (id: string) => string): string {
    if (!s.agentId) return s.title || '新会话';
    return s.title || `${agentName(s.agentId)} · ${new Date(s.createdAt).toLocaleString()}`;
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
        component: ConversationViewAsync,
        order: 40,
        meta: {
          def: {
            id: 'single', label: '独立会话', icon: 'edit-3', order: 40,
            active: () => !!ctx.get('singleBoard')?.activeSingleId.value,
            component: ConversationViewAsync,
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
