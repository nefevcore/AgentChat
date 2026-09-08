<script setup lang="ts">
// ============================================================
// client/AgentSettingsHost.vue —— Agent 设置节宿主
//（settings:section 贡献，M28 P2：原 settings SettingsPanel 内联
// agents 节迁入——列表/编辑双态 + 全 props 绑线经 settings 共享
// store 跨包直连）
//
// 编辑态语义随选举形态微调：节切走即卸载（editingAgent 不跨节驻留）；
// 面板关闭的「已放弃编辑不复活」防护 = 壳侧 resetAgent（SettingsPanel
// 关闭 watch）+ 本宿主卸载态重置，双层成立。
// ============================================================
import { ref, watch } from 'vue';
import AgentPane from './AgentPane.vue';
import AgentListPane from './AgentListPane.vue';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useUiStore } from 'ac-client-ui-sidebar/client/uiStore.ts';

const settings = useSettings();
const roster = useRosterCore();
const ui = useUiStore();

const editingAgent = ref('');
/** Agent 定时保存态（TimerPane save 按钮 spinner——原壳 saving 传递语义） */
const savingTimers = ref(false);
async function saveTimers(): Promise<void> {
  savingTimers.value = true;
  try {
    await settings.saveTimers();
  } finally {
    savingTimers.value = false;
  }
}

// 入口定位（聊天页/侧边栏「Agent 设置」）：uiStore.settingsAgentTarget
// 变化即进入对应编辑器（原 SettingsPanel initialAgentId watch 语义）
watch(
  () => [ui.globalSettingsVisible, ui.settingsAgentTarget] as const,
  ([visible, target]) => {
    if (visible && target) editingAgent.value = target;
  },
  { immediate: true },
);

function openAgentEditor(agentId: string) {
  if (agentId !== settings.agentId.value) settings.loadAgent(agentId);
  editingAgent.value = agentId;
}
function backToAgentList() {
  editingAgent.value = '';
}
/** 头像上传/删除成功（AgentPane avatar-changed）：名册（侧栏/会话/气泡）经
 *  store 改写 URL 强制 <img> 重取；列表 brief 同步，返回列表即时可见。 */
function onAgentAvatarChanged(agentId: string, present: boolean) {
  roster.refreshAvatar(agentId, present);
  const i = settings.agents.value.findIndex(a => a.id === agentId);
  if (i !== -1) {
    settings.agents.value[i] = {
      ...settings.agents.value[i],
      avatar: present ? `/api/agents/${encodeURIComponent(agentId)}/avatar?t=${Date.now()}` : null,
    };
  }
}
async function createAgent(payload: { id?: string; name: string; provider?: string; llm?: Record<string, unknown> }) {
  const ok = await settings.createAgent(payload);
  if (ok && payload.id) openAgentEditor(payload.id);
}
async function removeAgent(agentId: string) {
  await settings.removeAgent(agentId);
  if (editingAgent.value === agentId) editingAgent.value = '';
}
</script>

<template>
  <div v-if="editingAgent" class="agent-editor">
    <AgentPane
      :agent-id="editingAgent"
      :agents="settings.agents.value"
      :raw="settings.agentRaw.value"
      :effective="settings.agentEffective.value"
      :sys-content="settings.sysContent.value"
      :sys-enabled="settings.sysEnabled.value"
      :agent-content="settings.agentContent.value"
      :agent-enabled="settings.agentEnabled.value"
      :timers="settings.agentTimers.value"
      :assembly="settings.agentAssembly.value"
      :assembly-error="settings.agentAssemblyError.value"
      :extensions="settings.pluginCatalog.value?.extensions ?? []"
      :plugins="settings.pluginCatalog.value?.plugins ?? []"
      :permissions="settings.pluginPermissions.value"
      :event-chains="settings.eventChains.value"
      :event-descriptions="settings.eventDescriptions.value"
      :llm-schemas="settings.llmSchemas.value"
      :search-schemas="settings.searchSchemas.value"
      :pools="settings.pools.value"
      :saving="savingTimers"
      @update:raw="settings.agentRaw.value = $event"
      @update:sys-content="settings.sysContent.value = $event"
      @update:sys-enabled="settings.sysEnabled.value = $event"
      @update:agent-content="settings.agentContent.value = $event"
      @update:agent-enabled="settings.agentEnabled.value = $event"
      @update:timers="settings.agentTimers.value = $event"
      @switch="openAgentEditor"
      @back="backToAgentList"
      @save-timers="saveTimers()"
      @avatar-changed="onAgentAvatarChanged"
    />
  </div>
  <AgentListPane
    v-else
    :agents="settings.agents.value"
    :llm-schemas="settings.llmSchemas.value"
    @edit="openAgentEditor"
    @create="createAgent"
    @delete="removeAgent"
  />
</template>
