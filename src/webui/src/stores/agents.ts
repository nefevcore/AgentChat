// ============================================================
// Agent Store —— Agent 列表、选择、排序
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { VIEWER_ID } from '../constants';
import type { AgentInfo } from '../types';
import type { AgentPresetInfo } from '../api/roster';
import { fetchAgentPresets, fetchAgents } from '../api/roster';
import { saveLastContext, clearLastContextIf, loadLastContext } from '../utils/lastContext';
import { traceSwitch } from '../utils/switchTrace';

export const useAgentStore = defineStore('agents', () => {
  // ── State ──
  const agents = ref<AgentInfo[]>([]);
  const activeAgentId = ref('');
  /** 预设 Agent 目录（agents/presets RPC——ac-agent-presets 物化；拉取失败回退空，defaultPresetId 落 '__standard__' 字面量） */
  const presets = ref<AgentPresetInfo[]>([]);

  let lastActiveAgent = '';

  // ── Actions ──

  /** 名册刷新（Port B）：fetchAgents 汇聚 → setAgents；可选回调承接
   *  恢复选中链（chat store 的 tryRestore 逻辑在响应后执行）。 */
  function requestAgents(onLoaded?: (agents: AgentInfo[]) => void): void {
    void fetchAgents().then((d) => {
      setAgents(d.agents);
      onLoaded?.(d.agents);
    }).catch(() => undefined);
    void fetchPresets();
  }

  async function fetchPresets(): Promise<void> {
    try {
      const d = await fetchAgentPresets();
      presets.value = d.presets ?? [];
    } catch { /* 预设目录拉取失败：保持空（Session 下拉退化为普通 Agent 列表） */ }
  }

  /** 默认预设（空 Agent 会话的路由目标；未拉到时回退 __standard__） */
  const defaultPreset = computed<AgentPresetInfo | null>(() =>
    presets.value.find(p => p.default) ?? presets.value[0] ?? null);
  const defaultPresetId = computed(() => defaultPreset.value?.id ?? '__standard__');

  function selectAgent(agentId: string): void {
    traceSwitch('active-id', agentId || '(反选为空)');
    // Toggle: 点击已选中的 Agent 取消选择
    if (activeAgentId.value === agentId) {
      activeAgentId.value = '';
      clearLastContextIf('agent');
      return;
    }
    activeAgentId.value = agentId;
    saveLastContext({ kind: 'agent', id: agentId });
  }

  function setAgents(list: AgentInfo[]): void {
    agents.value = list.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  function bumpAgent(role: string, content: string): void {
    bumpAgentById(activeAgentId.value, role, content);
  }

  function bumpAgentById(agentId: string, role: string, content: string): void {
    if (!agentId || !content) return;
    const idx = agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;
    agents.value[idx] = {
      ...agents.value[idx],
      lastMessage: { role, agent_id: role === 'user' ? VIEWER_ID.value : agentId, content: content.slice(0, 80), timestamp: new Date().toISOString() },
      lastActivity: Date.now(),
    };
    agents.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  /** 刷新恢复：上次上下文是 agent pair 时恢复选中（single/group 上下文不在此恢复） */
  function tryRestoreLastAgent(): string | null {
    const ctx = loadLastContext();
    if (ctx?.kind === 'agent' && !activeAgentId.value) {
      lastActiveAgent = ctx.id;
      const found = agents.value.find(a => a.id === lastActiveAgent);
      if (found) {
        selectAgent(lastActiveAgent);
        lastActiveAgent = '';
        return ctx.id;
      }
    }
    return null;
  }

  /** 根据 agent_id 获取头像 URL */
  function getAgentAvatar(id: string): string | null {
    const agent = agents.value.find(a => a.id === id);
    return agent?.avatar ?? null;
  }

  /** 头像变更（上传/删除成功）后同步名册：名册头像恒指常量端点
   *  /api/agents/:id/avatar——浏览器不会对同 src 重新请求，Avatar 的 404
   *  回退也只在 src 变化时复位，常量 URL 永不自愈。上传 → 加时间戳强制
   *  各视图 <img> 重取；删除 → 置 null 回退首字。 */
  function refreshAvatar(agentId: string, present: boolean): void {
    const idx = agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;
    agents.value[idx] = {
      ...agents.value[idx],
      avatar: present ? `/api/agents/${encodeURIComponent(agentId)}/avatar?t=${Date.now()}` : null,
    };
  }

  /** 根据 agent_id 获取显示名称（Agent 列表 → 预设目录 → id 兜底） */
  function getAgentName(id: string): string {
    const agent = agents.value.find(a => a.id === id);
    if (agent?.name) return agent.name;
    const preset = presets.value.find(p => p.id === id);
    return preset?.name || id;
  }

  /** 是否预设 Agent（插件内置预设；无实体配置，设置面板不适用） */
  function isPreset(id: string): boolean {
    return presets.value.some(p => p.id === id);
  }

  return { agents, activeAgentId, presets, defaultPreset, defaultPresetId, requestAgents, fetchPresets, selectAgent, setAgents, bumpAgent, bumpAgentById, tryRestoreLastAgent, getAgentAvatar, refreshAvatar, getAgentName, isPreset };
});
