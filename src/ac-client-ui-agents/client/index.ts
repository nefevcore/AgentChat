/// <reference lib="dom" />
// ============================================================
// ac-client-ui-agents/client/index.ts —— agents 域前端行 client 半边
//（M27.1，D19 改裁：ac-client-ui-* 独立 UI 行包）
//
// 自 webui/src/clients/roster.ts 迁入（S3-1b 行包 → M27.1 独立行）。
// 层 2 身份面 + agents 域写面（服务名 'roster' 与服务端占名无碰撞，D22 查重）：
//   · RosterCore（纯 reactive 核心，零 cordis）+ RosterService（壳）；
//     Core 与壳分离的服务面收益：跨域消费面经取用口 useRosterCore
//     （rosterAccess.ts——M28 §4.2 起 pinia 门面退役：app 内绑
//     ctx.roster.core 单一事实源；无 runtime 回落模块级单例）；
//   · 名册/预设/选择 + 显示名/头像解析 + 名册刷新/活跃提升/头像同步；
//   · lastContext 持久化经 ac-client-runtime 共享小件；
//   · 可摘除性（M27.1 双向）：卸本行 → ctx.roster 不可解析 →
//     消费面经取用口回落独立 Core（宿主不残废）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace, loadLastContext, saveLastContext, clearLastContextIf, VIEWER_ID } from 'ac-client-runtime';
import { computed, defineAsyncComponent, ref, type ComputedRef, type Ref } from 'vue';

// ---- 域契约（契约随 UI 行走：owning = ac-client-ui-agents） ----

/** Agent 名册条目（webui types.ts / api/roster.ts re-export 维持旧路径） */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  avatar?: string | null;
  lastActivity?: number;
  /** 最后一条消息摘要（P4：runs/snapshot 尾部记录合成；实时侧由 bumpAgent 覆盖） */
  lastMessage?: {
    role: string;
    content: string;
    timestamp: string;
    agent_id?: string;
  } | null;
  virtual?: boolean;
  hasActiveSession?: boolean;
  /** 能力标签（AgentListPane 徽章 / 搜索过滤） */
  tags?: string[];
  /** 模型配置透传（"未配置模型"警示态判定用） */
  model?: string;
  provider?: string;
}

/** 预设 Agent 目录条目（空会话默认路由目标；ac-agent-presets 物化） */
export interface AgentPresetInfo {
  id: string;
  name: string;
  label: string;
  description: string;
  default: boolean;
}

interface PAgentConfig {
  id: string;
  model?: string;
  provider?: string;
  virtual?: boolean;
  system?: string;
  name?: string;
  description?: string;
  tags?: string[];
  llmParams?: Record<string, unknown>;
  tools?: unknown;
  settings?: Record<string, unknown>;
  maxSteps?: number;
}

/** snapshot 会话尾部摘要（runs/snapshot conversations[].last） */
interface PConvTail {
  conversationId: string;
  updatedAt?: number;
  last?: { role: string; text: string; ts: string; agent_id?: string; name?: string };
}

/** AgentConfig[] + running + snapshot → AgentInfo[]（名册合成：name←
 *  name??description（显示名单源 + 存量回退）；头像恒指真实端点，404 由
 *  <img> onerror 回退；P4/M19：名册活动源 = viewer⇄agent 直答对桶
 *  pairKey(viewer, agent)——lastActivity ← 桶 updatedAt，lastMessage ←
 *  尾部记录（说话人 = 尾部 name） */
export function toAgentList(
  configs: PAgentConfig[],
  running: Array<{ agentId: string; conversationId: string }> = [],
  conversations: PConvTail[] = [],
): { agents: AgentInfo[] } {
  const runningAgents = new Set(running.map((r) => r.agentId));
  // 对桶 → 名册键（viewer 对桶取另一端；旧 agentId 桶直存兜底）
  //（M29 P1-1：VIEWER_ID 收敛 runtime 单源——ref 形态，比较用点取 .value）
  const viewer = VIEWER_ID.value;
  const convOf = new Map<string, PConvTail>();
  for (const c of conversations) {
    if (c.conversationId.includes('~')) {
      const parts = c.conversationId.split('~');
      if (parts.length === 2 && parts.includes(viewer)) {
        const other = parts[0] === viewer ? parts[1] : parts[0];
        const prev = convOf.get(other);
        if (!prev || (c.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) convOf.set(other, c);
      }
    } else {
      convOf.set(c.conversationId, c);
    }
  }
  return {
    agents: configs.map((c) => {
      const conv = convOf.get(c.id);
      const last = conv?.last;
      return {
        id: c.id,
        // 显示名：name 单源（description 回退 = 存量档未物化前的兼容）
        name: c.name ?? c.description ?? c.id,
        description: c.description ?? '',
        avatar: `/api/agents/${encodeURIComponent(c.id)}/avatar`,
        virtual: c.virtual,
        hasActiveSession: runningAgents.has(c.id),
        ...(c.model ? { model: c.model, ...(c.provider ? { provider: c.provider } : {}) } : {}),
        ...(Array.isArray(c.tags) ? { tags: c.tags } : {}),
        ...(conv?.updatedAt ? { lastActivity: conv.updatedAt } : {}),
        ...(last
          ? {
              lastMessage: {
                // 中性格式（D13）：归属优先 agent_id，旧 baked 行回落 name；
                // 气泡侧 = 说话人是否 viewer（旧 user 行视作 viewer 侧）
                role:
                  last.role === 'user' ||
                  (last.agent_id ?? last.name) === viewer
                    ? 'user'
                    : 'agent',
                content: last.text.slice(0, 80),
                timestamp: last.ts,
                agent_id: last.agent_id ?? last.name ?? (last.role === 'user' ? 'user' : c.id),
              },
            }
          : {}),
      };
    }),
  };
}

/** Agent 名册（P4：聚合 runs/snapshot 取 1v1 会话 lastActivity/lastMessage——snapshot 失败静默降级旧形态） */
export async function fetchAgents(rpc: Pick<RpcClientFace, 'call'>): Promise<{ agents: AgentInfo[] }> {
  const [agentsR, statsR, snapR] = await Promise.all([
    rpc.call<{ agents: PAgentConfig[] }>('agents/list'),
    rpc.call<{ running: Array<{ agentId: string; conversationId: string }> }>('conversation/stats'),
    rpc
      .call<{ conversations?: Array<{ conversationId: string; updatedAt?: number; last?: { role: string; text: string; ts: string; name?: string } }> }>('runs/snapshot')
      .catch(() => undefined),
  ]);
  return toAgentList(agentsR.agents ?? [], statsR.running ?? [], snapR?.conversations ?? []);
}

export async function fetchAgentPresets(rpc: Pick<RpcClientFace, 'call'>): Promise<{ presets: AgentPresetInfo[] }> {
  const r = await rpc.call<{ presets?: AgentPresetInfo[] }>('agents/presets');
  return { presets: r.presets ?? [] };
}

// ---- 名册写面 + Provider 注册面（M27.2-2 sidebar 面板壳随件迁；
//      原 webui api/roster.ts 门面已退役〔M28 §4.2〕） ----

/** 创建 Agent（src 形状 → preview AgentConfig 白名单） */
export async function createAgent(
  payload: { id?: string; name?: string; provider?: string; llm?: Record<string, unknown>; tools?: unknown },
  rpc: Pick<RpcClientFace, 'call'>,
): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  const config: Record<string, unknown> = {};
  if (payload.id) config.id = payload.id;
  if (payload.name) config.name = payload.name;
  if (payload.provider) config.provider = payload.provider;
  const model = (payload.llm as Record<string, unknown> | undefined)?.model;
  if (typeof model === 'string' && model) config.model = model;
  if (payload.tools !== undefined) config.tools = payload.tools;
  const r = await rpc.call<{ config?: { id?: string } }>('agents/create', { config });
  return { success: true, agentId: r.config?.id ?? payload.id };
}

/** Provider 注册面快照（llm/providers：名称/模型缓存/连接锚点——
 *  AgentList 建档下拉与 AgentPane provider 选择器数据源） */
export interface LlmProviderStat {
  name: string;
  models: string[];
  instantiated?: boolean;
  description?: string;
  baseUrl?: string;
  /** 模型能力元数据（探测/手配：vision/hidden——徽章与下拉过滤消费） */
  modelMeta?: Record<string, { vision?: boolean; hidden?: boolean }>;
}

export async function fetchLlmProviders(
  rpc: Pick<RpcClientFace, 'call'>,
): Promise<{ providers: string[]; stats: LlmProviderStat[] }> {
  return rpc.call<{ providers?: string[]; stats?: LlmProviderStat[] }>('llm/providers').then((r) => ({
    providers: r.providers ?? [],
    stats: r.stats ?? [],
  }));
}

// ---- 头像（preview 真实 HTTP multipart 面，浏览器直连——M27.2-2
//      settings 件出包随件迁；原 webui api/roster.ts 门面已退役〔M28 §4.2〕） ----

export function uploadAvatar(agentId: string, file: File): Promise<{ success?: boolean; error?: string }> {
  const form = new FormData();
  form.append('file', file);
  return fetch(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'POST', body: form }).then(async (resp) => {
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? `HTTP ${resp.status}`);
    return resp.json() as Promise<{ success?: boolean; error?: string }>;
  });
}

export async function deleteAvatar(agentId: string): Promise<{ success?: boolean; deleted?: boolean; error?: string }> {
  const resp = await fetch(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'DELETE' });
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? `HTTP ${resp.status}`);
  return resp.json() as Promise<{ success?: boolean; deleted?: boolean; error?: string }>;
}

/** 会话切换时间戳追踪（诊断用——与 conversation/runview/singles 共享单源，owning = ac-client-runtime） */
import { traceSwitch } from 'ac-client-runtime';

// ---- 名册核心 + 服务面 ----

/** 名册核心（纯 reactive；零 cordis——门面独立模式复用） */
export class RosterCore {
  readonly agents: Ref<AgentInfo[]> = ref([]);
  readonly activeAgentId: Ref<string> = ref('');
  /** 预设 Agent 目录（agents/presets RPC——ac-agent-presets 物化；拉取失败回退空，defaultPresetId 落 '__standard__' 字面量） */
  readonly presets: Ref<AgentPresetInfo[]> = ref([]);

  private lastActiveAgent = '';
  private rpc: Pick<RpcClientFace, 'call'> | null = null;

  /** RPC 面注入（行内服务构造后由插件 apply 供给；门面独立模式 = null → 拉取静默跳过） */
  bindRpc(rpc: Pick<RpcClientFace, 'call'>): void {
    this.rpc = rpc;
  }

  /** 名册刷新（Port B）：fetchAgents 汇聚 → setAgents；可选回调承接
   *  恢复选中链（chat store 的 tryRestore 逻辑在响应后执行）。 */
  requestAgents(onLoaded?: (agents: AgentInfo[]) => void): void {
    if (!this.rpc) return;
    void fetchAgents(this.rpc).then((d) => {
      this.setAgents(d.agents);
      onLoaded?.(d.agents);
    }).catch(() => undefined);
    void this.fetchPresets();
  }

  async fetchPresets(): Promise<void> {
    if (!this.rpc) return;
    try {
      const d = await fetchAgentPresets(this.rpc);
      this.presets.value = d.presets ?? [];
    } catch { /* 预设目录拉取失败：保持空（Session 下拉退化为普通 Agent 列表） */ }
  }

  /** 默认预设（空 Agent 会话的路由目标；未拉到时回退 __standard__） */
  readonly defaultPreset: ComputedRef<AgentPresetInfo | null> = computed(() =>
    this.presets.value.find(p => p.default) ?? this.presets.value[0] ?? null,
  );
  readonly defaultPresetId: ComputedRef<string> = computed(() => this.defaultPreset.value?.id ?? '__standard__');

  selectAgent(agentId: string): void {
    traceSwitch('active-id', agentId || '(反选为空)');
    // Toggle: 点击已选中的 Agent 取消选择
    if (this.activeAgentId.value === agentId) {
      this.activeAgentId.value = '';
      clearLastContextIf('agent');
      return;
    }
    this.activeAgentId.value = agentId;
    saveLastContext({ kind: 'agent', id: agentId });
  }

  /** 清空选中（groups/singles 域互斥用——不写 lastContext，与直写 ref 旧行为等价） */
  clearSelection(): void {
    this.activeAgentId.value = '';
  }

  setAgents(list: AgentInfo[]): void {
    this.agents.value = list.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  bumpAgent(role: string, content: string): void {
    this.bumpAgentById(this.activeAgentId.value, role, content);
  }

  bumpAgentById(agentId: string, role: string, content: string): void {
    if (!agentId || !content) return;
    const idx = this.agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;
    this.agents.value[idx] = {
      ...this.agents.value[idx],
      lastMessage: { role, agent_id: role === 'user' ? VIEWER_ID.value : agentId, content: content.slice(0, 80), timestamp: new Date().toISOString() },
      lastActivity: Date.now(),
    };
    this.agents.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  /** 刷新恢复：上次上下文是 agent pair 时恢复选中（single/group 上下文不在此恢复） */
  tryRestoreLastAgent(): string | null {
    const ctx = loadLastContext();
    if (ctx?.kind === 'agent' && !this.activeAgentId.value) {
      this.lastActiveAgent = ctx.id;
      const found = this.agents.value.find(a => a.id === this.lastActiveAgent);
      if (found) {
        this.selectAgent(this.lastActiveAgent);
        this.lastActiveAgent = '';
        return ctx.id;
      }
    }
    return null;
  }

  /** 根据 agent_id 获取头像 URL */
  getAgentAvatar(id: string): string | null {
    const agent = this.agents.value.find(a => a.id === id);
    return agent?.avatar ?? null;
  }

  /** 头像变更（上传/删除成功）后同步名册：名册头像恒指常量端点
   *  /api/agents/:id/avatar——浏览器不会对同 src 重新请求，Avatar 的 404
   *  回退也只在 src 变化时复位，常量 URL 永不自愈。上传 → 加时间戳强制
   *  各视图 <img> 重取；删除 → 置 null 回退首字。 */
  refreshAvatar(agentId: string, present: boolean): void {
    const idx = this.agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;
    this.agents.value[idx] = {
      ...this.agents.value[idx],
      avatar: present ? `/api/agents/${encodeURIComponent(agentId)}/avatar?t=${Date.now()}` : null,
    };
  }

  /** 根据 agent_id 获取显示名称（Agent 列表 → 预设目录 → id 兜底） */
  getAgentName(id: string): string {
    const agent = this.agents.value.find(a => a.id === id);
    if (agent?.name) return agent.name;
    const preset = this.presets.value.find(p => p.id === id);
    return preset?.name || id;
  }

  /** 是否预设 Agent（插件内置预设；无实体配置，设置面板不适用） */
  isPreset(id: string): boolean {
    return this.presets.value.some(p => p.id === id);
  }
}

interface RosterClientOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
}

/** roster 服务面：Core 的透传（读面 + 写面；§0.3 层 2 身份面） */
export class RosterService extends Service {
  readonly core = new RosterCore();

  // ── 读面（身份面：名册/预设/显示名/头像）──
  readonly agents = this.core.agents;
  readonly presets = this.core.presets;
  readonly activeAgentId = this.core.activeAgentId;
  readonly defaultPreset = this.core.defaultPreset;
  readonly defaultPresetId = this.core.defaultPresetId;

  constructor(ctx: Context, options: RosterClientOptions = {}) {
    super(ctx, 'roster');
    void options;
    this.core.bindRpc((ctx as ClientContext).rpc);
  }

  getAgentAvatar(id: string) { return this.core.getAgentAvatar(id); }
  getAgentName(id: string) { return this.core.getAgentName(id); }
  isPreset(id: string) { return this.core.isPreset(id); }

  // ── 写面（名册刷新/选中/活跃提升/头像同步）──
  requestAgents(onLoaded?: (agents: AgentInfo[]) => void) { this.core.requestAgents(onLoaded); }
  fetchPresets() { return this.core.fetchPresets(); }
  selectAgent(agentId: string) { this.core.selectAgent(agentId); }
  clearSelection() { this.core.clearSelection(); }
  setAgents(list: AgentInfo[]) { this.core.setAgents(list); }
  bumpAgent(role: string, content: string) { this.core.bumpAgent(role, content); }
  bumpAgentById(agentId: string, role: string, content: string) { this.core.bumpAgentById(agentId, role, content); }
  tryRestoreLastAgent() { return this.core.tryRestoreLastAgent(); }
  refreshAvatar(agentId: string, present: boolean) { this.core.refreshAvatar(agentId, present); }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** roster 身份面（层 2 对象层 + agents 域写面）：名册/预设/选择 + 显示名/头像解析 */
    roster: RosterService;
  }
}

/** roster 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const rosterClientPlugin = clientPlugin({
  name: 'ac-client-ui-agents.client',
  inject: ['rpc', 'slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(RosterService);
    // agents 名册面板（M28 P2：原 sidebar ListPanelsHost 内联面板迁入；
    // list-panel:domain 选举席贡献——壳按 ui.primaryPanel × meta.panel 选举）
    ctx.slots.inject('primary-sidebar:domain', () =>
      ctx.slots.register('primary-sidebar:domain', {
        id: 'webui-domain-agents.panel',
        component: defineAsyncComponent(() => import('./AgentListHost.vue')),
        meta: { panel: 'agents' },
      }),
    );
    // Agent 设置节（M28 P2 settings 退化：原 SettingsPanel 内联 agents 节
    // 迁入——列表/编辑双态 Host；settings:section 选举席贡献。左树数据化：
    // meta.label 叶词条 + 顶层 order 叶序——壳按席位条目派生树叶）
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-domain-agents.settings',
        component: defineAsyncComponent(() => import('./AgentSettingsHost.vue')),
        order: 10,
        meta: { section: 'agents', label: 'Agent 设置' },
      }),
    );
    // 会话头 Agent 动作族（会话区重构自 ConversationView 内联迁域归位：
    // conversation:header-widget 贡献 order 30——direct 形态「Agent 配置」
    // 按钮 + 更多菜单（删除 Agent，确认弹窗随件内迁））
    ctx.slots.inject('conversation:header-widget', () =>
      ctx.slots.register('conversation:header-widget', {
        id: 'agent-actions',
        component: defineAsyncComponent(() => import('./AgentHeaderActions.vue')),
        order: 30,
      }),
    );
  },
});

export default rosterClientPlugin;
