// ============================================================
// webui/src/clients/singles.ts —— singles 域插件（M27 S2：独立会话域）
//
// 归属表 §0.3：singles.ts → singles 域 → 暴露面 ctx.singleBoard
//（服务端已占 'singles' 名——按 D22 查重纪律避让，Board 后缀与
// jobBoard 同族）。域投影 + 服务面：
//   · 独立会话列表 + 激活态（activeSingleId 派生自 feed 活跃分区——
//     与 groups 同模式：列表只切上下文，视图层负责加载历史）；
//   · singles/updated 帧订阅（自动标题/设置变更 → 列表刷新）随本域
//     fiber 卸载回收（谁的数据谁订帧，§0.3 层 3）；
//   · 会话上下文协调（chatStore.setSingleContext / lastContext 持久化）
//     ——过渡期经 pinia store 协调，feed/chat 收尾时改服务面互调；
//   · 域投影不挂全局 pinia（§0.3 红线）——stores/singles.ts 随本迁移退役；
//   · 可摘除性（D19）：卸载本插件 → ctx.singleBoard 不可解析 → 独立
//     会话列表/视角消费面消失，宿主不残废。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, computed, type ComputedRef, type Ref } from 'vue';
import { fetchSingles, createSingle, updateSingle, archiveSingle, deleteSingle, type SingleSession } from '../api/singles';
import { useChatStore } from '../stores/chat';
import { useFeedStore } from '../stores/feed';
import { useAgentStore } from '../stores/agents';
import { wireRpc } from '../api/wire';
import { logger } from '../utils/logger';
import { saveLastContext, clearLastContextIf, loadLastContext } from '../utils/lastContext';

export interface SingleBoardOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
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

export class SingleBoardService extends Service {
  readonly singles: Ref<SingleSession[]> = ref([]);
  readonly loaded: Ref<boolean> = ref(false);

  /** 活跃独立会话 id（派生自 feed 活跃分区——会话上下文的唯一事实源过渡期在 feed） */
  readonly activeSingleId: ComputedRef<string> = computed(() => useFeedStore().activeSingleId);
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
    this.own.fiber.effect(() => {
      const off = wireRpc.onWireEvent((type) => {
        if (type === 'singles/updated') void this.refresh();
      });
      return off;
    }, 'singleBoard.wire');
  }

  async refresh(): Promise<void> {
    try {
      const d = await fetchSingles();
      this.singles.value = d.singles ?? [];
      this.loaded.value = true;
    } catch (err: unknown) {
      logger.warn('[SingleBoard] 拉取独立会话列表失败:', (err as { message?: string })?.message ?? String(err));
    }
  }

  /** 快速创建空会话（P4：无 Agent；已有空会话时复用，避免堆积空白条目） */
  async createQuick(): Promise<SingleSession | null> {
    return this.create({ reuse: true });
  }

  /** 创建并立即进入会话 */
  async create(payload: SingleCreatePayload): Promise<SingleSession> {
    const d = await createSingle(payload);
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
    useChatStore().setSingleContext(
      sessionId,
      session.agentId || useAgentStore().defaultPresetId,
      typeof session.model === 'string' && session.model ? session.model : undefined,
    );
    saveLastContext({ kind: 'single', id: sessionId });
  }

  /** 回到 pair 会话（不清列表数据） */
  deselectSingle(): void {
    useChatStore().clearSingleContext();
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
    const d = await updateSingle(sessionId, payload);
    await this.refresh();
    // 活跃会话换 Agent/模型 → 重建上下文（agentId 影响消息身份与投递目标，
    // ''=默认预设；model 覆盖随投递信封透传——refresh 后取服务端回显值）
    if ((payload.agentId !== undefined || payload.model !== undefined) && this.activeSingleId.value === sessionId) {
      const fresh = this.singles.value.find(s => s.id === sessionId);
      if (fresh) {
        const model = typeof fresh.model === 'string' && fresh.model ? fresh.model : undefined;
        useChatStore().setSingleContext(sessionId, fresh.agentId || useAgentStore().defaultPresetId, model);
      }
    }
    return d.session ?? null;
  }

  /** 归档（软删）：若正打开则先退出 */
  async archive(sessionId: string): Promise<void> {
    await archiveSingle(sessionId);
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    await this.refresh();
  }

  /** 删除（硬删：元数据+消息）：若正打开则先退出 */
  async remove(sessionId: string): Promise<void> {
    await deleteSingle(sessionId);
    if (this.activeSingleId.value === sessionId) this.deselectSingle();
    await this.refresh();
  }

  /** Agent 名（列表展示用；经 agents store 解析（含预设目录）；空 = 默认预设） */
  titleOf(s: SingleSession, agentName: (id: string) => string): string {
    if (!s.agentId) return s.title || '新会话';
    return s.title || `${agentName(s.agentId)} · ${new Date(s.createdAt).toLocaleString()}`;
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** singles 域投影（webui 域插件提供）：独立会话列表/激活态 + 上下文协调 */
    singleBoard: SingleBoardService;
  }
}

/** singles 域插件（装配序列第④步：in-bundle） */
export const singlesDomainPlugin = clientPlugin({
  name: 'webui-domain-singles',
  async apply(ctx: ClientContext) {
    await ctx.plugin(SingleBoardService);
  },
});
