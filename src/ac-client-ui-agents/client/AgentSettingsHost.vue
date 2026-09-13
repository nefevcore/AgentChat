<script setup lang="ts">
// ============================================================
// client/AgentSettingsHost.vue —— Agent 设置节宿主
//（settings:section 贡献，M28 P2：原 settings SettingsPanel 内联
// agents 节迁入；M29 P1-3b：编辑编排归域——useAgentSettings 本包
// 自足〔agent CRUD/装配/元数据/wire 热刷新〕，修复 M28 P2.5 节宿主
// 实例无人装载的静默回归〔列表空/编辑不可保存〕——保存钮随编辑器
// 内迁，不再依赖设置壳的「保存配置」）
//
// 编辑态语义：节切走即卸载（editingAgent 不跨节驻留）；卸载态重置
// = composable resetAgent（宿主卸载自然触发）。
// ============================================================
import { ref, watch, onUnmounted } from 'vue';
import AgentPane from './AgentPane.vue';
import AgentListPane from './AgentListPane.vue';
import { useAgentSettings } from './useAgentSettings.ts';
import { useRosterCore } from './rosterAccess.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
// 定时任务数据面（M29 P1-3c：timerApi 归 ui-timer——.vue 媒介注入编排
// composable，agents .ts 不直连 domain 行数据面）
import * as timerApi from 'ac-client-ui-timer/client/timerApi.ts';

const settings = useAgentSettings(timerApi);
const roster = useRosterCore();
const ui = useUiStore();

const editingAgent = ref('');
/** 保存态（AgentPane 保存钮 spinner——含配置与定时任务） */
const savingConfig = ref(false);
async function saveAgent(): Promise<void> {
  savingConfig.value = true;
  try {
    await settings.saveAgent();
  } finally {
    savingConfig.value = false;
  }
}
async function saveTimers(): Promise<void> {
  savingConfig.value = true;
  try {
    await settings.saveTimers();
  } finally {
    savingConfig.value = false;
  }
}

// 节挂载即装载元数据（修复 M28 P2.5：列表/模型页签数据此前无人装载）
void settings.loadMeta();
// 节卸载：撤 wire 订阅 + 重置编辑态（「已放弃」的编辑不复活）+
// 清壳层 dirty 发布（设置壳关闭守护消费此标志——卸载后无编辑在场）
onUnmounted(() => {
  settings.disposeWs();
  settings.resetAgent();
  ui.agentEditorDirty = false;
});
// 编辑 dirty 发布（壳层关闭/切节守护的跨包数据源——编辑编排归域后
// 壳不引编辑态，经 uiStore 单向发布）
watch(
  () => settings.agentDirty.value || settings.agentAssemblyDirty.value,
  (dirty) => { ui.agentEditorDirty = dirty; },
  { immediate: true },
);

// 入口定位（聊天页/侧边栏「Agent 设置」）：uiStore.settingsAgentTarget
// 变化即进入对应编辑器（原 SettingsPanel initialAgentId watch 语义）。
// 走 openAgentEditor 而非直接赋值 editingAgent——前者携带 loadAgent 数据
// 装载（修复：迁移时简化为纯赋值，会话头入口进入的编辑器全程空数据，
// 与 Agent 清单「编辑」入口行为不一致；同 id 守卫防重复装载）
watch(
  () => [ui.globalSettingsVisible, ui.settingsAgentTarget] as const,
  ([visible, target]) => {
    if (visible && target) openAgentEditor(target);
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
      :llm-schemas="settings.llmSchemas.value"
      :pools="settings.pools.value"
      :saving="savingConfig"
      :dirty="settings.agentDirty.value || settings.agentAssemblyDirty.value"
      @update:raw="settings.agentRaw.value = $event"
      @update:sys-content="settings.sysContent.value = $event"
      @update:sys-enabled="settings.sysEnabled.value = $event"
      @update:agent-content="settings.agentContent.value = $event"
      @update:agent-enabled="settings.agentEnabled.value = $event"
      @update:timers="settings.agentTimers.value = $event"
      @switch="openAgentEditor"
      @back="backToAgentList"
      @save="saveAgent()"
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

<style scoped>
/* Agent 编辑态根布局（原 SettingsPanel 壳经父作用域回穿透施加——跨包
   隐藏耦合，随 owning 件收编；同选择器同元素，视觉零差） */
.agent-editor { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }
</style>
