// ============================================================
// ac-singles/client/index.ts —— singles client 半边（M27 S3-1b 行包双半边）
//
// 自 webui/src/clients/singles.ts 迁入（D19）。域投影 + 服务面
//（服务端已占 'singles' 名——'singleBoard' Board 后缀避让，D22）：
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
import { ref, computed, type ComputedRef, type Ref } from 'vue';

// ---- 域契约（契约随行走：owning = ac-singles 行包双半边） ----

/** 独立会话元数据（= preview SingleSessionMeta；webui api/singles.ts re-export 维持旧路径） */
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
  agentId?: string;
  model?: string | Record<string, unknown>;
  title?: string;
  workspaceId?: string;
  reuse?: boolean;
}

export interface SingleUpdatePayload {
  agentId?: string;
  model?: string | Record<string, unknown> | null;
  workspaceId?: string;
}

/** presence 同步钩子（行内服务传 sessions 协调面；webui 包装传 chatPresence 桥） */
export interface SinglesTrackOpts {
  track?: (id: string, removed?: boolean) => void;
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

export interface SingleBoardOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
}

export class SingleBoardService extends Service {
  readonly singles: Ref<SingleSession[]> = ref([]);
  readonly loaded: Ref<boolean> = ref(false);

  /** 活跃独立会话 id（派生自 feed 活跃分区——会话上下文的唯一事实源在会话服务） */
  readonly activeSingleId: ComputedRef<string> = computed(() => this.own.sessions.feed.activeSingleId.value);
  readonly activeSingle: ComputedRef<SingleSession | null> = computed(() =>
    this.activeSingleId.value ? this.singles.value.find(s => s.id === this.activeSingleId.value) ?? null : null,
  );
  /** 列表只显示未归档 */
  readonly activeSingles: ComputedRef<SingleSession[]> = computed(() => this.singles.value.filter(s => s.status === 'active'));

  /** 构造期 ctx = 本域插件 fiber（帧订阅绑定于此——卸载即回收，D5） */
  private readonly own: ClientContext;

  constructor(ctx: Context, options: SingleBoardOptions = {}) {
    super(ctx, 'singleBoard');
    this.own = ctx as ClientContext;
    void options;
    // wire singles/updated（自动标题生成/设置变更）→ 刷新列表（标题即时上屏）
    this.own.fiber.effect(() => this.own.rpc.onEvent((type) => {
      if (type === 'singles/updated') void this.refresh();
    }), 'singleBoard.wire');
  }

  /** presence 同步面（帧路由 single~sid 判别——sessions 协调面） */
  private track(id: string | undefined, removed = false): void {
    if (id) this.own.sessions.trackKnownSingle(id, removed);
  }

  async refresh(): Promise<void> {
    try {
      const d = await fetchSingles(this.own.rpc, { track: (id, removed) => this.track(id, removed) });
      this.singles.value = d.singles ?? [];
      this.loaded.value = true;
    } catch (err: unknown) {
      console.warn('[SingleBoard] 拉取独立会话列表失败:', (err as { message?: string })?.message ?? String(err));
    }
  }

  /** 快速创建空会话（P4：无 Agent；已有空会话时复用，避免堆积空白条目） */
  async createQuick(): Promise<SingleSession | null> {
    return this.create({ reuse: true });
  }

  /** 创建并立即进入会话 */
  async create(payload: SingleCreatePayload): Promise<SingleSession> {
    const d = await createSingle(payload, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    await this.refresh();
    if (d.session) this.selectSingle(d.session.id);
    return d.session;
  }

  /**
   * 激活独立会话：设置会话上下文。历史加载由 DialogView 的 single watch 统一触发
   * （与 group 模式一致：列表只切上下文，视图层负责加载）。
   * agentId 空 = 默认预设（src 同款：空 Agent 会话路由到 __standard__，
   * 由 ac-agent-presets 物化进 agents 注册表）
   */
  selectSingle(sessionId: string): void {
    const session = this.singles.value.find(s => s.id === sessionId);
    if (!session || session.status === 'archived') return;
    this.own.sessions.chat.setSingleContext(
      sessionId,
      session.agentId || this.own.roster.defaultPresetId.value,
      typeof session.model === 'string' && session.model ? session.model : undefined,
    );
    saveLastContext({ kind: 'single', id: sessionId });
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
    const session = this.singles.value.find(s => s.id === last.id);
    if (!session || session.status !== 'active') {
      clearLastContextIf('single');
      return null;
    }
    this.selectSingle(last.id);
    return last.id;
  }

  /**
   * 更新会话设置（输入栏内联调整：换 Agent（''=清空待选；已有消息时后端 409 禁改）/
   * 换模型覆盖（null=清除）/ 挂工作区（''=移入未分组））。
   * 换 Agent 时同步刷新会话上下文（feed 消息身份映射 + 后续投递目标）。
   */
  async updateSession(sessionId: string, payload: SingleUpdatePayload): Promise<SingleSession | null> {
    const d = await updateSingle(sessionId, payload, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    await this.refresh();
    // 活跃会话换 Agent/模型 → 重建上下文（agentId 影响消息身份与投递目标，
    // ''=默认预设；model 覆盖随投递信封透传——refresh 后取服务端回显值）
    if ((payload.agentId !== undefined || payload.model !== undefined) && this.activeSingleId.value === sessionId) {
      const fresh = this.singles.value.find(s => s.id === sessionId);
      if (fresh) {
        const model = typeof fresh.model === 'string' && fresh.model ? fresh.model : undefined;
        this.own.sessions.chat.setSingleContext(sessionId, fresh.agentId || this.own.roster.defaultPresetId.value, model);
      }
    }
    return d.session ?? null;
  }

  /** 归档（软删）：若正打开则先退出 */
  async archive(sessionId: string): Promise<void> {
    await archiveSingle(sessionId, this.own.rpc);
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    await this.refresh();
  }

  /** 删除（硬删：元数据+消息）：若正打开则先退出 */
  async remove(sessionId: string): Promise<void> {
    await deleteSingle(sessionId, this.own.rpc, { track: (id, removed) => this.track(id, removed) });
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    await this.refresh();
  }

  /** Agent 名（列表展示用；经 agents 名册解析（含预设目录）；空 = 默认预设） */
  titleOf(s: SingleSession, agentName: (id: string) => string): string {
    if (!s.agentId) return s.title || '新会话';
    return s.title || `${agentName(s.agentId)} · ${new Date(s.createdAt).toLocaleString()}`;
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** singles 域投影（ac-singles client 半边提供）：独立会话列表/激活态 + 上下文协调 */
    singleBoard: SingleBoardService;
  }
}

/** singles 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const singlesClientPlugin = clientPlugin({
  name: 'ac-singles.client',
  inject: ['rpc', 'sessions', 'roster'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(SingleBoardService);
  },
});

export default singlesClientPlugin;
