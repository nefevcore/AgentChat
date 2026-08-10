// ============================================================
// stores/agents.ts —— Agent 列表 / 选中 / 排序（纯数据）
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AgentInfo } from '@/domain/types';
import { useWebSocketStore } from './websocket';

export const VIEWER_ID = 'user';

const LAST_AGENT_KEY = 'agentchat.v2.lastAgent';

export const useAgentStore = defineStore('agents', () => {
  const agents = ref<AgentInfo[]>([]);

  function requestAgents(): void {
    useWebSocketStore().send('agent.list', {});
  }

  function setAgents(list: AgentInfo[]): void {
    agents.value = [...list].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  function bumpAgentById(agentId: string, role: string, content: string): void {
    if (!agentId || !content) return;
    const idx = agents.value.findIndex(a => a.id === agentId);
    if (idx === -1) return;
    agents.value[idx] = {
      ...agents.value[idx],
      lastMessage: {
        role,
        agent_id: role === 'user' ? VIEWER_ID : agentId,
        content: content.slice(0, 80),
        timestamp: new Date().toISOString(),
      },
      lastActivity: Date.now(),
    };
    agents.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  function persistLastAgent(agentId: string): void {
    try { localStorage.setItem(LAST_AGENT_KEY, agentId); } catch { /* ignore */ }
  }
  function clearLastAgent(): void {
    try { localStorage.removeItem(LAST_AGENT_KEY); } catch { /* ignore */ }
  }
  function restoreLastAgent(): string | null {
    try { return localStorage.getItem(LAST_AGENT_KEY); } catch { return null; }
  }

  function getAgentAvatar(id: string): string | null {
    return agents.value.find(a => a.id === id)?.avatar ?? null;
  }

  function getAgentName(id: string): string {
    return agents.value.find(a => a.id === id)?.name || id;
  }

  return {
    agents,
    requestAgents, setAgents, bumpAgentById,
    persistLastAgent, clearLastAgent, restoreLastAgent,
    getAgentAvatar, getAgentName,
  };
});
