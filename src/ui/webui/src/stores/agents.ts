// ============================================================
// Agent Store —— Agent 列表、选择、排序
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { VIEWER_ID } from '../constants';
import { WS_SEND } from '../core/events/contract';
import type { AgentInfo } from '../types';
import type { AgentPresetInfo } from '../core/api/endpoints/agentPresets';
import { fetchAgentPresets } from '../core/api/endpoints/agentPresets';
import { useWebSocketStore } from './websocket';
import { saveLastContext, clearLastContextIf, loadLastContext } from '../utils/lastContext';

export const useAgentStore = defineStore('agents', () => {
  // ── State ──
  const agents = ref<AgentInfo[]>([]);
  const activeAgentId = ref('');
  /** 预设 Agent 目录（/api/agent-presets；不在 Agent 列表，Session 选用） */
  const presets = ref<AgentPresetInfo[]>([]);

  let lastActiveAgent = '';

  // ── Actions ──

  function requestAgents(): void {
    useWebSocketStore().send(WS_SEND.agentList, {});
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

  return { agents, activeAgentId, presets, defaultPreset, defaultPresetId, requestAgents, fetchPresets, selectAgent, setAgents, bumpAgent, bumpAgentById, tryRestoreLastAgent, getAgentAvatar, getAgentName, isPreset };
});
