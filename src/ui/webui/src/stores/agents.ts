// ============================================================
// Agent Store —— Agent 列表、选择、排序
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { VIEWER_ID } from '../constants';
import { WS_SEND } from '../core/events/contract';
import type { AgentInfo } from '../types';
import { useWebSocketStore } from './websocket';

export const useAgentStore = defineStore('agents', () => {
  // ── State ──
  const agents = ref<AgentInfo[]>([]);
  const activeAgentId = ref('');

  let lastActiveAgent = '';

  // ── Actions ──

  function requestAgents(): void {
    useWebSocketStore().send(WS_SEND.agentList, {});
  }

  function selectAgent(agentId: string): void {
    // Toggle: 点击已选中的 Agent 取消选择
    if (activeAgentId.value === agentId) {
      activeAgentId.value = '';
      localStorage.removeItem('agentchat.lastAgent');
      return;
    }
    activeAgentId.value = agentId;
    localStorage.setItem('agentchat.lastAgent', agentId);
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

  function tryRestoreLastAgent(): string | null {
    const saved = localStorage.getItem('agentchat.lastAgent');
    if (saved && !activeAgentId.value) {
      lastActiveAgent = saved;
      const found = agents.value.find(a => a.id === lastActiveAgent);
      if (found) {
        selectAgent(lastActiveAgent);
        lastActiveAgent = '';
        return saved;
      }
    }
    return null;
  }

  /** 根据 agent_id 获取头像 URL */
  function getAgentAvatar(id: string): string | null {
    const agent = agents.value.find(a => a.id === id);
    return agent?.avatar ?? null;
  }

  /** 根据 agent_id 获取显示名称 */
  function getAgentName(id: string): string {
    const agent = agents.value.find(a => a.id === id);
    return agent?.name || id;
  }

  return { agents, activeAgentId, requestAgents, selectAgent, setAgents, bumpAgent, bumpAgentById, tryRestoreLastAgent, getAgentAvatar, getAgentName };
});
