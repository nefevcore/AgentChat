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
import { clientPlugin, type ClientContext, type RpcClientFace } from 'ac-client-runtime';
import { defineAsyncComponent, ref, type Ref } from 'vue';
import { useUiStore } from 'ac-client-ui-sidebar/client/uiStore.ts';

// pair 视角组件（异步：node 环境消费本模块不求值 .vue 视图链——
// PairDialogView 内核经 domain→base 跨包引用，浏览器首渲染时装载）
const PairDialogViewAsync = defineAsyncComponent(() => import('ac-client-ui-conversation/client/PairDialogView.vue'));

/** pair 视角状态读取（ui.pairView——防御式：pinia 未装配的求值上下文
 *  返回 null = 视角不激活，不抛错〔测试族裸 boot 场景〕） */
function pairViewState(): { a: string; b: string } | null {
  try {
    return useUiStore().pairView;
  } catch {
    return null;
  }
}

// ---- src 视图契约（RunTracking 消费形状；webui api/runs re-export——
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

export interface RunsGroupSession {
  key: string;
  groupId: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  /** 热力时间窗计数（无面 → 缺省；见 RunsPairSession.windows） */
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

export interface RunsGroupArchive {
  groupId: string;
  agentId: string;
  lastActivity: number;
}

export interface RunsSnapshot {
  generatedAt: string;
  members: RunsMember[];
  pairs: RunsPairSession[];
  groups: RunsGroupSession[];
  groupArchives: RunsGroupArchive[];
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
  const convOf = new Map((s.conversations ?? []).map((c) => [c.conversationId, c]));
  const agentMembers = agents.map((a) => ({ id: a.id, name: a.name ?? a.description ?? a.id, kind: 'agent' as const }));
  const groupMembers = (s.groups ?? []).map((g) => ({ id: g.groupId, name: g.name, kind: 'group' as const }));
  const agentIds = new Set(agentMembers.map((m) => m.id));
  const groupIds = new Set(groupMembers.map((m) => m.id));
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
      // agents 已含 user（显示名如实）则直接用；否则合成占位（虚拟端点）
      ...(hasUser ? [] : [{ id: 'user', name: 'user', kind: 'virtual' as const }]),
      ...agentMembers,
      ...groupMembers,
      { id: 'system', name: 'system', kind: 'system' },
    ],
    pairs,
    groups: (s.groups ?? []).map((g) => {
      const conv = convOf.get(g.groupId);
      return {
        key: `group~${g.groupId}`,
        groupId: g.groupId,
        messageCount: conv?.messageCount ?? 0,
        lastActivity: conv?.updatedAt ?? 0,
        bytes: conv?.size ?? 0,
        ...(conv?.windows ? { windows: conv.windows } : {}),
      };
    }),
    groupArchives: [],
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
      groupSessions: (s.groups ?? []).length,
      singleSessions: 0,
      runningTotal: (s.running ?? []).length,
      runningSingles: 0,
      unknownMembers: [],
    },
  };
}

export interface RunsClientOptions {
  /** 快照轮询间隔（ms；缺省 3000） */
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

  constructor(ctx: Context, options: RunsClientOptions = {}) {
    super(ctx, 'runs');
    this.own = ctx as ClientContext;
    this.pollMs = options.pollMs ?? 3000;
  }

  /**
   * 拉取快照。**内容未变化时保留原对象引用**（只更新 generatedAt）——
   * 轮询若每次都替换对象，会触发矩阵 400+ 格子的 computed 级联重算与
   * 全量 patch；引用不变则派生全部短路，零渲染。
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return; // 慢响应乱序防护（回滚防线）
    this.inFlight = true;
    this.loading.value = true;
    try {
      // 域投影管线：snapshot + agents/list 双 RPC 聚合 → 矩阵视图合成
      const [raw, agentsR] = await Promise.all([
        this.own.rpc.call<PRunsSnapshot>('runs/snapshot'),
        this.own.rpc.call<{ agents?: RosterAgentView[] }>('agents/list'),
      ]);
      const next = toRunsSnapshot(raw ?? {}, agentsR.agents ?? []);
      this.loadError.value = '';
      const cur = this.snapshot.value;
      if (cur && RunsClientService.signature(cur) === RunsClientService.signature(next)) {
        cur.generatedAt = next.generatedAt; // 仅时间戳变化（快照时间显示的小更新）
        return;
      }
      this.snapshot.value = next;
    } catch (err: unknown) {
      this.loadError.value = (err as { message?: string })?.message ?? String(err);
    } finally {
      this.inFlight = false;
      this.loading.value = false;
    }
  }

  /** 首次使用时启动轮询（幂等）；定时器随本域 fiber 卸载回收 */
  ensurePolling(): void {
    if (this.pollTimer) return;
    void this.refresh();
    this.own.fiber.effect(() => {
      this.pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.refresh();
      }, this.pollMs);
      this.tickTimer = setInterval(() => { this.now.value = Date.now(); }, 1000);
      return () => this.stopPolling();
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
    // pair 视角出厂贡献（M28 P0-2/T6：矩阵格子进入的只读会话对视角；
    // order 10 = 居 talk(20) 之前——pair 激活期间覆盖 talk，原 AppFrame
    // 注册序语义保持；行卸载 → pair 视角消失）。经 slots.inject 声明
    // 存活期效应落位：席位在场即注册（domain 批次恒已声明）、缺席即
    // 等待（裸 client 测试不炸）、声明塌缩/本行卸载即回收。
    ctx.slots.inject('main:perspective', () =>
      ctx.slots.register('main:perspective', {
        id: 'pair',
        component: PairDialogViewAsync,
        order: 10,
        meta: {
          def: {
            id: 'pair', label: '会话对', icon: 'message-circle', order: 10,
            active: () => !!pairViewState(),
            component: PairDialogViewAsync,
            props: () => {
              const p = pairViewState();
              return { a: p?.a ?? '', b: p?.b ?? '' };
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
