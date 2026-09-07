// ============================================================
// stores/agents.ts —— Agent 门面（M27 S2：兼容桥接 ctx.roster）
//
// D13 bridge 同款哲学：本门面是旧消费面（组件 / chat·feed store /
// 既有测试族）到新事实源的转发层——
//   · app 内（client runtime 在场）：绑定 ctx.roster.core（单一事实源，
//     §0.3 层 2 身份面 + agents 域写面）；
//   · 单测（无 runtime）：每 pinia 实例自建独立 RosterCore——既有
//     feed/archive 状态机测试族零改动。
// feed/chat 收尾时本门面退役，消费面全量切 ctx.roster。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from '../runtime/clientRuntime';
import { RosterCore } from 'ac-client-ui-agents/client';
import type { AgentInfo } from '../types';
import type { AgentPresetInfo } from '../api/roster';

export const useAgentStore = defineStore('agents', () => {
  const core = clientRuntime()?.roster?.core ?? new RosterCore();

  return {
    agents: core.agents,
    activeAgentId: core.activeAgentId,
    presets: core.presets,
    defaultPreset: core.defaultPreset,
    defaultPresetId: core.defaultPresetId,
    requestAgents: core.requestAgents.bind(core),
    fetchPresets: core.fetchPresets.bind(core),
    selectAgent: core.selectAgent.bind(core),
    setAgents: core.setAgents.bind(core),
    bumpAgent: core.bumpAgent.bind(core),
    bumpAgentById: core.bumpAgentById.bind(core),
    tryRestoreLastAgent: core.tryRestoreLastAgent.bind(core),
    getAgentAvatar: core.getAgentAvatar.bind(core),
    refreshAvatar: core.refreshAvatar.bind(core),
    getAgentName: core.getAgentName.bind(core),
    isPreset: core.isPreset.bind(core),
  };
});

export type { AgentInfo, AgentPresetInfo };
