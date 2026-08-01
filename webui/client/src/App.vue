<script setup lang="ts">
import { ref, provide, readonly, onUnmounted, onMounted } from 'vue';
import Sidebar from './components/Sidebar.vue';
import AgentList from './components/AgentList.vue';
import ChatView from './components/ChatView.vue';
import GroupChat from './components/GroupChat.vue';
import CreateGroupDialog from './components/CreateGroupDialog.vue';
import GlobalSettings from './components/GlobalSettings.vue';
import AgentSettings from './components/AgentSettings.vue';
import TokenUsage from './components/TokenUsage.vue';
import VersionDialog from './components/VersionDialog.vue';
import { useAgentStore } from './stores/agents';
import { useWebSocketStore } from './stores/websocket';
import { useThemeStore } from './stores/theme';
import { VIEWER_ID } from './constants';
import type { GroupInfo } from './types';

// 初始化主题
useThemeStore();

const agentStore = useAgentStore();

/** 统一列表面板可见性 */
const listVisible = ref(true);
/** 列表面板宽度 */
const listWidth = ref(260);
/** 移动端侧边栏可见性 */
const sidebarVisible = ref(false);

/** 全局配置面板 */
const globalSettingsVisible = ref(false);
/** Token 用量面板 */
const tokenUsageVisible = ref(false);
/** 版本信息弹窗 */
const versionVisible = ref(false);

/** Agent 配置面板 */
const agentSettingsVisible = ref(false);
provide('agentSettingsVisible', agentSettingsVisible);
const settingsAgentId = ref(VIEWER_ID.value);
provide('settingsAgentId', settingsAgentId);
/** Agent 配置面板目标（独立于 settingsAgentId，避免干扰 turn-item 左右对齐） */
const editingAgentId = ref(VIEWER_ID.value);
provide('editingAgentId', editingAgentId);

/** 群组状态 */
const groups = ref<GroupInfo[]>([]);
const activeGroupId = ref('');
const showCreateGroup = ref(false);

const wsStore = useWebSocketStore();

const MIN_LIST = 160;
const MIN_CHAT = 320;

// ── 拖拽调整列表宽度 ──
const resizing = ref(false);
let resizeStartX = 0;
let resizeStartW = 0;

function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  resizing.value = true;
  resizeStartX = e.clientX;
  resizeStartW = listWidth.value;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResizeMove(e: MouseEvent) {
  if (!resizing.value) return;
  const delta = e.clientX - resizeStartX;
  const maxWidth = window.innerWidth - 48 - MIN_CHAT;
  listWidth.value = Math.max(MIN_LIST, Math.min(resizeStartW + delta, maxWidth));
}

function onResizeEnd() {
  resizing.value = false;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
});

function isNarrow() { return window.innerWidth <= 768; }

function toggleList() {
  if (isNarrow()) {
    sidebarVisible.value = !sidebarVisible.value;
  } else {
    listVisible.value = !listVisible.value;
  }
  if (listVisible.value && isNarrow()) sidebarVisible.value = true;
}

function toggleSidebar() { sidebarVisible.value = !sidebarVisible.value; }
function closeSidebar() { sidebarVisible.value = false; }

// ── 群组操作 ──
async function fetchGroups() {
  try {
    const resp = await fetch('/api/groups');
    if (resp.ok) {
      const data = await resp.json();
      groups.value = data.groups ?? [];
    }
  } catch { /* ignore */ }
}

/** 选中群组 — 同步清除 Agent 选中，确保互斥 */
function selectGroup(groupId: string) {
  agentStore.activeAgentId = '';
  try { localStorage.removeItem('agentchat.lastAgent'); } catch { /* ignore */ }
  activeGroupId.value = groupId;
  try { localStorage.setItem('agentchat.lastGroup', groupId); } catch { /* ignore */ }
}

function deselectGroup() {
  activeGroupId.value = '';
  try { localStorage.removeItem('agentchat.lastGroup'); } catch { /* ignore */ }
}

function openCreateGroup() { showCreateGroup.value = true; }
function closeCreateGroup() { showCreateGroup.value = false; }

function onGroupCreated(groupId: string) {
  fetchGroups().then(() => selectGroup(groupId));
}

function onGroupDeleted(groupId: string) {
  if (activeGroupId.value === groupId) {
    activeGroupId.value = '';
    try { localStorage.removeItem('agentchat.lastGroup'); } catch { /* ignore */ }
  }
  fetchGroups();
}

// ── WS 群组事件 ──
function handleGroupWS(type: string, data: any) {
  switch (type) {
    case 'group.created':
    case 'group.deleted':
    case 'group.join':
    case 'group.leave':
      fetchGroups();
      break;
    case 'group.message': {
      const idx = groups.value.findIndex(r => r.group_id === data.group_id);
      if (idx >= 0) {
        groups.value[idx] = { ...groups.value[idx], lastActivity: Date.now() };
        groups.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      }
      break;
    }
  }
}

onMounted(() => {
  wsStore.init();
  wsStore.onMessage(handleGroupWS);
  fetchGroups();

  // 恢复上次的群组选中
  try {
    const lastGroup = localStorage.getItem('agentchat.lastGroup');
    if (lastGroup) selectGroup(lastGroup);
  } catch { /* ignore */ }
});

provide('sidebarVisible', readonly(sidebarVisible));
provide('toggleSidebar', toggleSidebar);
provide('closeSidebar', closeSidebar);
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩 -->
    <Transition name="sidebar-overlay">
      <div v-if="sidebarVisible" class="sidebar-overlay" @click="closeSidebar" />
    </Transition>

    <!-- 第一层：侧边栏 -->
    <Sidebar
      :list-visible="listVisible"
      @toggle-list="toggleList"
      @open-global-settings="globalSettingsVisible = true"
      @open-agent-settings="editingAgentId = VIEWER_ID; agentSettingsVisible = true"
      @open-token-usage="tokenUsageVisible = true"
      @show-version="versionVisible = true"
    />

    <!-- 第二层：统一列表（Agent + 群组） -->
    <div v-if="listVisible" class="list-panel-wrapper" :style="{ width: listWidth + 'px' }">
      <AgentList
        :class="{ 'sidebar-mobile-visible': sidebarVisible }"
        :groups="groups"
        :active-group-id="activeGroupId"
        @select-group="selectGroup"
        @deselect-group="deselectGroup"
        @create-group="openCreateGroup"
      />
      <div class="resize-handle" :class="{ active: resizing }" @mousedown="onResizeStart" />
    </div>

    <!-- 第三层：会话窗口 -->
    <GroupChat
      v-if="activeGroupId"
      :group="groups.find(r => r.group_id === activeGroupId) ?? null"
      @group-deleted="onGroupDeleted"
    />
    <ChatView v-else />

    <!-- 创建群组对话框 -->
    <CreateGroupDialog v-if="showCreateGroup" @close="closeCreateGroup" @created="onGroupCreated" />

    <!-- 全局配置面板 -->
    <GlobalSettings :visible="globalSettingsVisible" @close="globalSettingsVisible = false" />

    <!-- Token 用量面板 -->
    <TokenUsage :visible="tokenUsageVisible" @close="tokenUsageVisible = false" />

    <!-- Agent 配置面板 -->
    <AgentSettings :agent-id="editingAgentId" :visible="agentSettingsVisible" @close="agentSettingsVisible = false" @saved="agentSettingsVisible = false" />
  </div>

  <!-- 版本信息弹窗 -->
  <VersionDialog :visible="versionVisible" @close="versionVisible = false" />
</template>

<style scoped>
.app-layout {
  display: flex; height: 100vh; width: 100vw; overflow: hidden; position: relative;
}

.list-panel-wrapper {
  display: flex; flex-shrink: 0; overflow: hidden;
}

.sidebar-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 50;
}
.sidebar-overlay-enter-active, .sidebar-overlay-leave-active { transition: opacity 0.2s; }
.sidebar-overlay-enter-from, .sidebar-overlay-leave-to { opacity: 0; }

.resize-handle {
  width: 3px; cursor: col-resize; background: transparent;
  transition: background 0.15s; flex-shrink: 0;
}
.resize-handle:hover, .resize-handle.active { background: var(--color-primary, #6366f1); }

@media (max-width: 768px) {
  .list-panel-wrapper {
    position: fixed; left: 0; top: 0; bottom: 0;
    z-index: 49; box-shadow: 2px 0 12px rgba(0,0,0,0.15);
  }
}
</style>
