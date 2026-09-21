/// <reference lib="dom" />
// ============================================================
// ac-client-ui-runview/client/index.ts —— runview client 半边（M27 S3）
//
// 装载形态（D7/D19）：经 boot graph 动态装载（dev 期 vite 直服本源码 /
// prod 期构建为行 client 模块块）；经 ctx.rpc 调宿主 RPC（不 import
// webui 内部模块——行 client 半边只依赖 ac-client-runtime 契约面）。
// 依赖一律 inject 声明（D6）：rpc + slots。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, clientRuntime, type ClientContext, type RpcClientFace } from 'ac-client-runtime';
import { defineAsyncComponent, ref, watch, type Ref } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import type { MainViewDef } from 'ac-client-ui-layout/client/mainViews.ts';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';

// pair 视角组件（异步：node 环境消费本模块不求值 .vue 视图链——
// ConversationView 内核经 domain→base 跨包引用，浏览器首渲染时装载。
// 会话区重构 A 路线并入：原 PairDialogView 独立组件退役，pair =
// 内核 readonly 形态（a/b 端点 + readonly:true——仅阅读消息，禁止
// 编辑类操作；与 talk/group/single 同组件原地切换，语义统一）
const ConversationViewAsync = defineAsyncComponent(() => import('ac-client-ui-conversation/client/ConversationView.vue'));
// 运行矩阵大画布 + 运行跟踪面板（M28 P1-3 随域迁入；异步——node 环境
// 消费本模块不求值 .vue 视图链）
const RunTrackingAsync = defineAsyncComponent(() => import('./RunTracking.vue'));
const RunTrackingPanelAsync = defineAsyncComponent(() => import('./RunTrackingPanel.vue'));
// tracking aux 选区宿主（A5：自主侧边栏第三面板迁辅助侧边栏）
const RunTrackingSidebarHostAsync = defineAsyncComponent(() => import('./RunTrackingSidebarHost.vue'));

/** 活动栏 tracking 按钮的新入口（A5）：宽屏 = aux 'tracking' 选区意图；
 *  窄屏 = 主侧边栏旧路径（抽屉形态打开 tracking 面板页）。 */
function openTrackingPanel(): void {
  const ui = useUiStore();
  if (ui.isNarrow()) {
    ui.openPrimaryPanel('tracking'); // 窄屏抽屉：面板页保留
  } else {
    ui.auxOpenTracking();
  }
}

/** pair 视角状态读取（ui.pairView——防御式：pinia 未装配的求值上下文
 *  返回 null = 视角不激活，不抛错〔测试族裸 boot 场景〕） */
function pairViewState(): { a: string; b: string } | null {
  try {
    return useUiStore().pairView;
  } catch {
    return null;
  }
}

/** 矩阵快照主区视图激活判定（壳零域知识——状态随 owning 行）：
 *  只看开关（单一事实源——显式导航互斥下 pair/subagent 视角进入即收矩阵，
 *  开关不再反向受视角影响）。防御式同 pairViewState（pinia 未装配 = 不激活）。 */
function trackingActive(): boolean {
  try {
    return useUiStore().trackingViewVisible;
  } catch {
    return false;
  }
}

// ---- src 视图契约（RunTracking 消费形状；原 webui api/runs 门面已退役〔M28 §4.2〕——
// 契约随行走：S3 行包双半边同包，server 半边亦可复用） ----

export interface RunsMember {
  id: string;
  name: string;
  kind: 'agent' | 'virtual' | 'preset' | 'group' | 'system' | 'unknown';
  participants?: string[];
}

export interface WindowCounts { h1: number; d1: number; d3: number; d7: number; d30: number }

export interface RunsPairSession {
  key: string;
  a: string;
  b: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  /** 热力时间窗计数（h1/dN 消息量）；无面 → 缺省（UI 回退总量色阶） */
  windows?: WindowCounts;
}

export interface RunsSingleSession {
  key: string;
  id: string;
  agentId: string;
  title?: string;
  status?: string;
  workspaceId?: string;
  messageCount: number;
  lastActivity: number;
}

export interface RunsRunningEntry {
  convKey: string;
  kind: 'chat' | 'group' | 'single';
  agentId: string;
  startedAt: number;
  source?: { kind?: string; form?: string; summary?: string };
}

export interface RunsSnapshot {
  generatedAt: string;
  members: RunsMember[];
  pairs: RunsPairSession[];
  singles: RunsSingleSession[];
  running: RunsRunningEntry[];
  coverage: { matrixSessions: number; pairSessions: number; groupSessions: number; singleSessions: number; runningTotal: number; runningSingles: number; unknownMembers: string[] };
}

// ---- 宿主 RPC 原始形状（preview 形）+ 域投影合成管线 ----

/** runs/snapshot 原始载荷（宿主 preview 形状） */
export interface PRunsSnapshot {
  conversations: Array<{
    conversationId: string;
    messageCount?: number;
    size?: number;
    updatedAt?: number;
    /** 热力时间窗（后端按记录时间戳统计；缺失 = 旧后端，UI 回退总量色阶） */
    windows?: WindowCounts;
    /** 尾部一条摘要（名册 lastMessage 合成源） */
    last?: { role: string; text: string; ts: string; name?: string };
  }>;
  running: Array<{ agentId: string; conversationId: string; handle: string; startedAt: number }>;
  groups: Array<{ groupId: string; name: string; memberCount: number }>;
}

/** agents/list 行内最小视图（名册聚合只取身份面三字段） */
export interface RosterAgentView {
  id: string;
  name?: string;
  description?: string;
}

/**
 * preview snapshot + 名册 → 矩阵视图（域投影管线——契约随行走自
 * webui api/runs 迁入）。成员去重：agents 名册已含 'user' 时不再合成
 * 占位 user——否则矩阵出现两行同 id。M19 对桶统一：全部 'a~b' 键按同
 * 一规则进 pairs——user 只是端点之一，无 user 特判。
 */
export function toRunsSnapshot(s: PRunsSnapshot, agents: RosterAgentView[]): RunsSnapshot {
  const agentMembers = agents.map((a) => ({ id: a.id, name: a.name ?? a.description ?? a.id, kind: 'agent' as const }));
  const agentIds = new Set(agentMembers.map((m) => m.id));
  const groupIds = new Set((s.groups ?? []).map((g) => g.groupId));
  const hasUser = agentMembers.some((m) => m.id === 'user');
  // 会话桶分类（M19）：对桶 'a~b'（两端都是注册端点）→ pairs；群 gid /
  // 独立会话 sid 不进 pairs（群走 groups、singles 维持矩阵外独立降级）
  const pairs = (s.conversations ?? [])
    .filter((c) => {
      if (groupIds.has(c.conversationId)) return false;
      if (!c.conversationId.includes('~')) return false;
      const parts = c.conversationId.split('~');
      return parts.length === 2 && parts.every((p) => agentIds.has(p));
    })
    .map((c) => {
      const [a, b] = c.conversationId.split('~') as [string, string];
      return {
        // 对桶已排序（pairKey 构造时 sort）——chat~ 前缀 + 桶名即键
        key: `chat~${c.conversationId}`,
        a,
        b,
        messageCount: c.messageCount ?? 0,
        lastActivity: c.updatedAt ?? 0,
        bytes: c.size ?? 0,
        ...(c.windows ? { windows: c.windows } : {}),
      };
    });
  return {
    generatedAt: new Date().toISOString(),
    members: [
      // agents 已含 user（显示名如实）则直接用；否则合成占位（虚拟端点）。
      // 群/system 不入轴（2026-12 收窄）：快照管线无群参与证据供数
      //（groupArchives 恒空、agent×群格从不点亮）、system 无对桶——
      // 两轴 = Agent 端点（含 user），矩阵只覆盖真实会话对。
      ...(hasUser ? [] : [{ id: 'user', name: 'user', kind: 'virtual' as const }]),
      ...agentMembers,
    ],
    pairs,
    singles: [],
    running: (s.running ?? []).map((r) => {
      // 分类（M19）：群 gid → group~gid；对桶 'a~b'（含 user~agent 与
      // a~a）→ chat~<桶名>；其余（独立会话 sid）→ single~sid
      const conv = r.conversationId;
      const isGroup = groupIds.has(conv);
      const isPair = !isGroup && conv.includes('~') && conv.split('~').length === 2;
      const kind: 'chat' | 'group' | 'single' = isGroup ? 'group' : isPair ? 'chat' : 'single';
      const convKey = isGroup
        ? `group~${conv}${r.agentId && r.agentId !== conv ? `~${r.agentId}` : ''}`
        : isPair
          ? `chat~${conv}`
          : `single~${conv}`;
      return {
        convKey,
        kind,
        agentId: r.agentId,
        startedAt: r.startedAt,
        source: { kind: 'chat' },
      };
    }),
    coverage: {
      matrixSessions: pairs.length,
      pairSessions: pairs.length,
      groupSessions: 0, // 群不入矩阵（2026-12 收窄）——恒 0，面板文案不区分
      singleSessions: 0,
      runningTotal: (s.running ?? []).length,
      runningSingles: 0,
      unknownMembers: [],
    },
  };
}

export interface RunsClientOptions {
  /**
   * 兜底轮询间隔（ms；缺省 60_000）。2026-09-19 事件驱动化改造：快照
   * 刷新的主通道 = WS 事件（loop/run-started · loop/after-run ·
   * router/message-received——run 生命周期与投递是快照内容的全部变化源）；
   * 定时轮询降级为兜底（防 WS 断连漏帧——feed-core 同款考量；断连期间
   * 的变化由 onOpen 重连即刷补齐）。running 非空时缩短到 1/10（运行中
   * 面板的时长/进度显示仍需走表刷新）。
   */
  pollMs?: number;
}

export class RunsClientService extends Service {
  /** rpc 依赖声明（D6：fiber 等待 + own-fiber store 填充——构造期可安全访问） */
  static inject = ['rpc'] as const;

  readonly snapshot: Ref<RunsSnapshot | null> = ref(null);
  readonly loadError: Ref<string> = ref('');
  readonly loading: Ref<boolean> = ref(false);
  /** 本地时钟秒针（运行时长递增显示；轮询启动才走表） */
  readonly now: Ref<number> = ref(Date.now());

  /** 构造期 ctx = 本域插件 fiber（轮询定时器绑定于此——卸载即回收） */
  private readonly own: ClientContext;
  private readonly pollMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** 上一轮快照 digest（服务端短路判等；空 = 首轮/旧后端，请求不带） */
  private digest = '';

  constructor(ctx: Context, options: RunsClientOptions = {}) {
    super(ctx, 'runs');
    this.own = ctx as ClientContext;
    this.pollMs = options.pollMs ?? 60_000;
    // ---- 事件驱动刷新（2026-09-19 改造主通道）----
    // 快照内容的变化源 = run 生命周期（running/queued 面）+ 消息入站（stats/
    // last 面）。WS 帧到达即刷（去抖 500ms——多帧连发合并一次拉取；run 结束
    // 的收束行落盘在 after-run 帧之前，到达时数据已 durable）。rpc.onEvent
    // 可选成员（测试桩可能缺省）——缺席时退化纯兜底轮询。
    const triggerEvents = ['loop/run-started', 'loop/after-run', 'router/message-received'];
    let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleEventRefresh = (): void => {
      if (refreshDebounce !== null) clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(() => {
        refreshDebounce = null;
        void this.refresh();
      }, 500);
      if (typeof refreshDebounce.unref === 'function') refreshDebounce.unref();
    };
    this.ctx.fiber.effect(() => {
      // 单 handler 判事件名集合（每帧只过一次——三个订阅各挂一个会让每帧
      // 被判三遍）；onEvent 可选（测试桩可能缺省）——缺席退化纯兜底轮询
      const off = this.own.rpc.onEvent?.((type) => {
        if (triggerEvents.includes(type)) scheduleEventRefresh();
      }) ?? (() => {});
      // 重连即刷：断连期间丢失的帧由 onOpen 补齐（feed-core 同款恢复位）
      const offOpen = this.own.rpc.onOpen?.(() => scheduleEventRefresh()) ?? (() => {});
      // 前台化即刷：兜底 tick 的相位不随可见性变化——切回后下一 tick
      // 最坏还要等一个 interval（空闲态 60s）。visible 立即刷新消死区；
      // 刷后首个 tick 由顺延逻辑（ensurePolling）把相位锚回前台时刻。
      // 轮询未启动（无视图消费者）时不刷。
      const onVis = (): void => {
        if (document.visibilityState === 'visible' && this.pollTimer) void this.refresh();
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
      return () => {
        off(); offOpen();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      };
    }, 'runs.event-refresh');
  }

  /**
   * 拉取快照。**内容未变化时保留原对象引用**（只更新 generatedAt）——
   * 轮询若每次都替换对象，会触发矩阵 400+ 格子的 computed 级联重算与
   * 全量 patch；引用不变则派生全部短路，零渲染。两级防线：
   *   1. digest 短路（服务端）：请求带上一轮 digest，内容未变 → 后端回
   *      unchanged 轻载荷，零序列化/零投影（比下级更省——连投影重算
   *      都省了）；此时 snapshot 引用不动，只刷新 generatedAt；
   *   2. signature 短路（客户端兜底）：后端 digest 缺席（旧后端）或误判
   *      时，投影后对比内容签名，相同保留引用。
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return; // 慢响应乱序防护（回滚防线）
    this.inFlight = true;
    this.loading.value = true;
    try {
      // 域投影管线：snapshot + agents/list 双 RPC 聚合 → 矩阵视图合成
      //（并源 fetchRuns——同款聚合单份，服务轮询与按需拉取同源）
      const r = await fetchRuns(this.own.rpc, this.digest || undefined);
      this.loadError.value = '';
      if (r.digest) this.digest = r.digest;
      if (r.unchanged) {
        const cur = this.snapshot.value;
        if (cur) cur.generatedAt = new Date().toISOString(); // 仅时间戳（快照时间显示）
        return;
      }
      const cur = this.snapshot.value;
      if (cur && RunsClientService.signature(cur) === RunsClientService.signature(r.snapshot)) {
        cur.generatedAt = r.snapshot.generatedAt; // 仅时间戳变化（快照时间显示的小更新）
        return;
      }
      this.snapshot.value = r.snapshot;
    } catch (err: unknown) {
      this.loadError.value = (err as { message?: string })?.message ?? String(err);
    } finally {
      this.inFlight = false;
      this.loading.value = false;
    }
  }

  /**
   * 首次使用时启动轮询（幂等）；定时器随本域 fiber 卸载回收。
   * 秒针（now）按需启停：仅在有运行中会话时走表——时长显示（tooltip/
   * 面板行）只在 running 非空时有意义；零运行时秒针每秒打点驱动所有
   * 消费组件 re-render 是纯基底负载。running 变空 → 停表；再非空 → 复表。
   */
  ensurePolling(): void {
    if (this.pollTimer) return;
    void this.refresh();
    this.own.fiber.effect(() => {
      // 兜底轮询（动态间隔）：空闲 = pollMs（缺省 60s——事件驱动已是主通道，
      // 兜底只防 WS 断连漏帧）；running 非空 = pollMs/10（运行中面板的时长/
      // 进度仍需走表）。间隔切换 = 重建定时器（低频事件，成本可忽略）。
      // 后台顺延：hidden 期间 tick 扑空不清 timer（保 interval 节奏），visible
      // 的第一 tick 即刷 + 把下一轮重排到 interval 之后——消除"切回后要等满
      // 一个 interval（空闲态最坏 60s）"的死区（浏览器后台节流只影响 tick
      // 密度，顺延逻辑对此无假设）。
      const schedule = (): void => {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        const interval = (this.snapshot.value?.running.length ?? 0) > 0 ? Math.max(1_000, this.pollMs / 10) : this.pollMs;
        this.pollTimer = setInterval(() => {
          if (document.visibilityState === 'visible') {
            void this.refresh();
            if (hadHiddenTick) { hadHiddenTick = false; schedule(); }
          } else {
            hadHiddenTick = true;
          }
        }, interval);
      };
      let hadHiddenTick = false;
      schedule();
      const stopResched = watch(
        () => (this.snapshot.value?.running.length ?? 0) > 0,
        () => schedule(),
      );
      // 秒针启停随快照 running 数（watch 不进 effect 清理——定时器自身管理）
      const stopTick = watch(
        () => this.snapshot.value?.running.length ?? 0,
        (n) => {
          if (n > 0 && !this.tickTimer) {
            this.now.value = Date.now();
            this.tickTimer = setInterval(() => { this.now.value = Date.now(); }, 1000);
          } else if (n === 0 && this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
          }
        },
        { immediate: true },
      );
      return () => { stopResched(); stopTick(); this.stopPolling(); };
    }, 'runs.polling');
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  /** 快照内容签名（剔除每次必变的 generatedAt） */
  private static signature(s: RunsSnapshot): string {
    const { generatedAt: _drop, ...rest } = s;
    return JSON.stringify(rest);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** runview 域投影（ac-client-ui-runview client 半边提供）：snapshot/now + refresh/ensurePolling */
    runs: RunsClientService;
  }
}

/** runview 域插件（boot graph 装载；host 半边见 src/index.ts） */
export const runviewClientPlugin = clientPlugin({
  name: 'ac-client-ui-runview.client',
  inject: ['rpc', 'slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(RunsClientService);
    // 徽章数据源常驻：tracking rail 按钮的运行中徽章不依赖面板展开——
    // 行装载即启动快照轮询（幂等；面板挂载处的 ensurePolling 同函数短路），
    // fiber 卸载随 RunsClientService 定时器一并回收。经根 runtime 解析
    //（runs 由本行子 fiber 提供，本 fiber 未 inject——直访会抛；同下方
    // 让位 watch 的 clientRuntime() 姿势，裸 boot 测试 = undefined 静默跳过）。
    clientRuntime()?.runs?.ensurePolling();
    // 运行矩阵主区视图（main 席位 keyed 选举贡献——2026-11 主区语义
    // 纯化：原 main:tracking 专座收编为 main 选举条目）：active 谓词
    // 自带让位协议（见 trackingActive）；volatile（缺省）——离开即卸载，
    // runs 轮询随卸载停。「矩阵行缺席 → 条目不在 → 兜底 chat 直显」
    // 内在于选举（原壳内 useSeatOccupancy 门控退役）。
    ctx.slots.inject('main', () =>
      ctx.slots.register('main', {
        id: 'webui-domain-runview.matrix',
        component: RunTrackingAsync,
        order: 50,
        meta: {
          def: {
            id: 'tracking', order: 50,
            active: trackingActive,
            component: RunTrackingAsync,
          } satisfies MainViewDef,
        },
      }),
    );

    // ── 主区让位兜底 watch（2026-11 自 AppFrame 迁入——owning 行自理，
    //    壳零域知识）：选中 Agent/群/独立会话（来自任何列表面板）→
    //    矩阵/pair 让位回聊天。只在选中（非空变化）时收起：清空选择回到
    //    talk 视角不打断矩阵浏览；同值重选与 toggle 反选不触发。列表与
    //    运行面板的导航入口（AgentList/SessionList/RunTrackingPanel）已
    //    各自显式收起（closeTrackingView/openPairView 单点互斥），本
    //    watch 是快路径兜底。三元组经根 runtime 上下文可选探测（本件
    //    fiber 未 inject groups/singles——自身 ctx 属性访问会抛，M28
    //    P0.2 事故同款；root ctx 经 ?. 探测 = 缺席 undefined 不抛）。 ──
    ctx.effect(() => {
      const stop = watch(
        () => {
          const rt = clientRuntime();
          return [
            rt?.roster?.core.activeAgentId.value ?? '',
            rt?.groups?.activeGroupId.value ?? '',
            rt?.singleBoard?.activeSingleId.value ?? '',
          ] as const;
        },
        (cur, prev) => {
          const selected = cur.some((v, i) => v && v !== prev[i]);
          if (!selected) return;
          try {
            useUiStore().exitOverlays(); // 收矩阵 + 清 pair（进入会话的完整意图）
          } catch { /* pinia 未装配（裸 boot 测试）——静默 */ }
        },
      );
      return () => stop();
    });
    // 运行跟踪面板（primary-sidebar:domain 选举席贡献，meta.panel 选举键——
    // 壳 PrimarySidebarHost 按 ui.primaryPanel 三选一，P0-3；行卸载 → tracking
    // 面板页空态。A5 起桌面主入口 = aux 选区（下），此贡献保留：①窄屏
    // 抽屉形态消费；②旧 ui.primaryPanel 值 'tracking' 回落兜底）
    ctx.slots.inject('primary-sidebar:domain', () =>
      ctx.slots.register('primary-sidebar:domain', {
        id: 'webui-domain-runview.panel',
        component: RunTrackingPanelAsync,
        meta: { panel: 'tracking' },
      }),
    );
    // 运行跟踪 aux 选区（A5：桌面主入口——监视类归右栏，主侧边栏回归
    // 纯导航；组件复用 RunTrackingPanel，数据/轮询/跳转行为不变）
    ctx.slots.inject('aux-sidebar', () =>
      ctx.slots.register('aux-sidebar', {
        id: 'webui-domain-runview.sidebar',
        component: RunTrackingSidebarHostAsync,
        meta: {
          def: {
            id: 'tracking',
            order: 20, // rail 序：第 3 位（中频监视）
            keepAlive: true, // 清单/轮询状态常驻
            active: () => {
              try { return useUiStore().auxPanel === 'tracking'; } catch { return false; }
            },
            component: RunTrackingSidebarHostAsync,
            rail: {
              icon: 'activity',
              title: '运行跟踪',
              activate: () => { /* 意图通道路径自理（auxOpenTracking） */ },
              // 徽章 = 运行中会话数（rail 按钮常驻可见——数字随 runs 轮询
              // 更新；0 = 不渲染。轮询随本行装载启动〔见 apply 首〕，
              // 收起面板不丢徽章数据源。runs 经根 runtime 解析——本 fiber
              // 未 inject，闭包直访 ctx.runs 会抛，被壳安全求值吞掉）。
              badge: () => clientRuntime()?.runs?.snapshot.value?.running.length ?? 0,
            },
          } satisfies AuxSidebarPanelDef,
        },
      }),
    );
    // pair 视角出厂贡献（M28 P0-2/T6：矩阵格子进入的只读会话对视角；
    // order 10 = 居 talk(20) 之前——pair 激活期间覆盖 talk，原 AppFrame
    // 注册序语义保持；行卸载 → pair 视角消失）。会话区重构 A 路线：
    // 组件 = ConversationView 内核 readonly 形态（props 携 a/b 端点 +
    // readonly:true——slot-tree §5.10 readonlyContextAllowed 声明的
    // 消费侧）。经 slots.inject 声明存活期效应落位：席位在场即注册
    //（domain 批次恒已声明）、缺席即等待（裸 client 测试不炸）、
    // 声明塌缩/本行卸载即回收。
    ctx.slots.inject('main:perspective', () =>
      ctx.slots.register('main:perspective', {
        id: 'pair',
        component: ConversationViewAsync,
        order: 10,
        meta: {
          def: {
            id: 'pair', label: '会话对', icon: 'message-circle', order: 10,
            active: () => !!pairViewState(),
            component: ConversationViewAsync,
            props: () => {
              const p = pairViewState();
              return { a: p?.a ?? '', b: p?.b ?? '', readonly: true };
            },
          },
        },
      }),
    );
  },
});

export default runviewClientPlugin;

// ---- 运行动作面（M27.2-2 sidebar 面板壳随件迁；webui api/runs.ts
//      薄包装补 wireRpc 缺省维持旧路径） ----

/** src convKey（chat~a~b / group~g~a / single~s）→ preview conversationId（M19：
 *  chat 对键双向保留——'chat~a~b' → 'a~b'，不再剥 user 特判） */
export function convKeyToId(convKey: string): string {
  if (convKey.startsWith('single~')) return convKey.slice('single~'.length);
  if (convKey.startsWith('group~')) return convKey.split('~')[1] ?? convKey;
  if (convKey.startsWith('chat~')) return convKey.slice('chat~'.length);
  return convKey;
}

/** 中断指定会话键的运行中 run（软中断：run 走完 runEnd 落盘后退出） */
export async function interruptRun(
  convKey: string,
  rpc: Pick<RpcClientFace, 'call'>,
): Promise<{ success: boolean; error?: string }> {
  const r = await rpc.call<{ aborted?: number }>('runs/interrupt', { conversationId: convKeyToId(convKey) });
  return { success: (r.aborted ?? 0) > 0 };
}

/** 宿主 preview 快照载荷（完整形 / digest 短路轻载荷的联合） */
export type PRunsSnapshotResult = PRunsSnapshot & { digest?: string; unchanged?: boolean };

/** 运行跟踪快照（3s 轮询；snapshot + agents/list 双 RPC 聚合——
 *  M28 §4.2 自 webui api/runs.ts 归位：rpc 必传）。
 *  digest 短路：带上一轮 digest 请求，后端内容未变 → { unchanged: true }
 *  轻载荷（零序列化/零传输/零投影重算），此时跳过 agents/list 直接
 *  返回 unchanged 标记（调用方保留旧快照引用，仅刷新时间戳）。
 *  旧后端（无 digest 字段）恒返回完整载荷——路径自然兼容。 */
export async function fetchRuns(
  rpc: Pick<RpcClientFace, 'call'>,
  digest?: string,
): Promise<{ snapshot: RunsSnapshot; unchanged: boolean; digest?: string }> {
  const raw = await rpc.call<PRunsSnapshotResult>('runs/snapshot', digest ? { digest } : undefined);
  if (raw?.unchanged && digest) return { snapshot: null as never, unchanged: true, digest };
  const agentsR = await rpc.call<{ agents?: RosterAgentView[] }>('agents/list');
  return { snapshot: toRunsSnapshot(raw ?? {}, agentsR.agents ?? []), unchanged: false, digest: raw?.digest };
}

/** run 来源 → 中文标签（矩阵格/清单行共用——两视图逐字同款，并源单份） */
export function sourceLabel(r: RunsRunningEntry): string {
  const map: Record<string, string> = {
    user: '用户', agent: 'Agent', system: '系统', timer: '定时',
    group: '群聊', subagent: '子代理', continue: '续推', restart: '重启', archive: '归档',
  };
  return map[r.source?.kind ?? 'system'] ?? r.source?.kind ?? 'system';
}
