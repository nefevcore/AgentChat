// ============================================================
// webui/src/clients/roster.ts —— roster 域插件 + 层 2 身份面（M27 S2）
//
// 归属表 §0.3：agents.ts 读面→runtime 对象层（多基础件共读的身份面：
// 名册 agents/presets + 显示名/头像解析）；管理写面→agents 域。本插件
// 合并两半：ctx.roster（服务名 'roster' 与服务端占名无碰撞，D22 通过）。
//
// 形态：RosterCore（纯 reactive 核心，零 cordis）+ RosterService（cordis
// Service 壳）。Core 与壳分离的服务面收益：stores/agents.ts 过渡期作为
// 兼容门面（D13 bridge 同款哲学——旧面转发新事实源）：
//   · app 内（runtime 在场）：门面绑 ctx.roster.core——单一事实源；
//   · 单测（无 runtime）：门面每 pinia 实例自建独立 Core——既有测试
//     零改动（feed/archive 状态机测试族）。
// feed/chat 收尾时门面退役、消费面全量切 ctx.roster。
// 可摘除性（D19）：卸载本插件 → ctx.roster 不可解析 → 名册/选择消费面
// 经门面回落独立 Core（宿主不残废）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { VIEWER_ID } from '../constants';
import type { AgentInfo } from '../types';
import type { AgentPresetInfo } from '../api/roster';
import { fetchAgentPresets, fetchAgents } from '../api/roster';
import { saveLastContext, clearLastContextIf, loadLastContext } from '../utils/lastContext';
import { traceSwitch } from '../utils/switchTrace';

/** 名册核心（纯 reactive；零 cordis——门面独立模式复用） */
export class RosterCore {
  readonly agents: Ref<AgentInfo[]> = ref([]);
  readonly activeAgentId: Ref<string> = ref('');
  /** 预设 Agent 目录（agents/presets RPC——ac-agent-presets 物化；拉取失败回退空，defaultPresetId 落 '__standard__' 字面量） */
  readonly presets: Ref<AgentPresetInfo[]> = ref([]);

  private lastActiveAgent = '';

  /** 名册刷新（Port B）：fetchAgents 汇聚 → setAgents；可选回调承接
   *  恢复选中链（chat store 的 tryRestore 逻辑在响应后执行）。 */
  requestAgents(onLoaded?: (agents: AgentInfo[]) => void): void {
    void fetchAgents().then((d) => {
      this.setAgents(d.agents);
      onLoaded?.(d.agents);
    }).catch(() => undefined);
    void this.fetchPresets();
  }

  async fetchPresets(): Promise<void> {
    try {
      const d = await fetchAgentPresets();
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

export interface RosterClientOptions {
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
  }

  getAgentAvatar(id: string) { return this.core.getAgentAvatar(id); }
  getAgentName(id: string) { return this.core.getAgentName(id); }
  isPreset(id: string) { return this.core.isPreset(id); }

  // ── 写面（名册刷新/选中/活跃提升/头像同步）──
  requestAgents(onLoaded?: (agents: AgentInfo[]) => void) { this.core.requestAgents(onLoaded); }
  fetchPresets() { return this.core.fetchPresets(); }
  selectAgent(agentId: string) { this.core.selectAgent(agentId); }
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

/** roster 域插件（装配序列第④步：in-bundle） */
export const rosterDomainPlugin = clientPlugin({
  name: 'webui-domain-roster',
  async apply(ctx: ClientContext) {
    await ctx.plugin(RosterService);
  },
});
