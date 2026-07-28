<script setup lang="ts">
import { ref, provide, readonly, onUnmounted, onMounted, watch } from 'vue';
import Sidebar from './components/Sidebar.vue';
import AgentList from './components/AgentList.vue';
import ChatView from './components/ChatView.vue';
import GroupList from './components/GroupList.vue';
import GroupChat from './components/GroupChat.vue';
import CreateGroupDialog from './components/CreateGroupDialog.vue';
import GlobalSettings from './components/GlobalSettings.vue';
import AgentSettings from './components/AgentSettings.vue';
import TokenUsage from './components/TokenUsage.vue';
import { useWebSocketStore } from './stores/websocket';
import { useThemeStore } from './stores/theme';
import type { GroupInfo } from './types';

/** 当前活动视图 */
const activeView = ref<'agents' | 'groups'>('agents');

// 持久化 activeView
watch(activeView, (val) => {
  try { localStorage.setItem('agentchat.lastView', val); } catch { /* ignore */ }
});

// 初始化主题（自动应用 html.dark/html.light class）
useThemeStore();
/** Agent 列表面板可见性 */
const agentsVisible = ref(true);
/** Agent 列表面板宽度 */
const agentListWidth = ref(260);
/** 群组列表面板宽度 */
const groupListWidth = ref(260);
/** 移动端侧边栏可见性 */
const sidebarVisible = ref(false);
/** 全局配置面板 */
const globalSettingsVisible = ref(false);
/** Token 用量面板 */
const tokenUsageVisible = ref(false);

/** Agent 配置面板可见性（通过 provide 共享给 Sidebar 和 ChatView） */
const agentSettingsVisible = ref(false);
provide('agentSettingsVisible', agentSettingsVisible);

/** 配置面板目标 Agent ID（User 或选中的 Agent） */
const settingsAgentId = ref('user');
provide('settingsAgentId', settingsAgentId);

/** 群组状态 */
const groups = ref<GroupInfo[]>([]);
const activeGroupId = ref('');
const showCreateGroup = ref(false);

const wsStore = useWebSocketStore();

const MIN_LIST = 160;
const MIN_CHAT = 320;

/** 拖拽调整列表宽度 */
const resizing = ref(false);
let resizeStartX = 0;
let resizeStartW = 0;
let resizeTarget = 'agents' as 'agents' | 'groups';

function onResizeStart(e: MouseEvent, target: 'agents' | 'groups') {
  e.preventDefault();
  resizing.value = true;
  resizeStartX = e.clientX;
  resizeStartW = target === 'agents' ? agentListWidth.value : groupListWidth.value;
  resizeTarget = target;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResizeMove(e: MouseEvent) {
  if (!resizing.value) return;
  const delta = e.clientX - resizeStartX;
  const maxWidth = window.innerWidth - 48 - MIN_CHAT;
  const w = Math.max(MIN_LIST, Math.min(resizeStartW + delta, maxWidth));
  if (resizeTarget === 'agents') agentListWidth.value = w;
  else groupListWidth.value = w;
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

/** 是否为窄屏模式 */
function isNarrow() { return window.innerWidth <= 768; }

// ── 面板切换 ──
function toggleAgents() {
  if (activeView.value !== 'agents') {
    activeView.value = 'agents';
    agentsVisible.value = true;
    if (isNarrow()) sidebarVisible.value = true;
  } else if (isNarrow()) {
    sidebarVisible.value = !sidebarVisible.value;
  } else {
    agentsVisible.value = !agentsVisible.value;
  }
}

function toggleGroups() {
  if (activeView.value !== 'groups') {
    activeView.value = 'groups';
    agentsVisible.value = true;
    fetchGroups();
    if (isNarrow()) sidebarVisible.value = true;
  } else if (isNarrow()) {
    sidebarVisible.value = !sidebarVisible.value;
  } else {
    agentsVisible.value = !agentsVisible.value;
  }
}

function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value;
}

function closeSidebar() {
  sidebarVisible.value = false;
}

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

function selectGroup(groupId: string) {
  activeGroupId.value = groupId;
  // 持久化
  try { localStorage.setItem('agentchat.lastGroup', groupId); } catch { /* ignore */ }
}

function openCreateGroup() {
  showCreateGroup.value = true;
}

function onGroupCreated(groupId: string) {
  // 先加载群组列表，确保 groups 数组有数据后再选中
  fetchGroups().then(() => {
    selectGroup(groupId);
  });
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
      // 新消息时更新群组排序（将活跃群组排到前面）
      const idx = groups.value.findIndex(r => r.group_id === data.group_id);
      if (idx > 0) {
        const [group] = groups.value.splice(idx, 1);
        groups.value.unshift(group);
      }
      break;
    }
  }
}

onMounted(() => {
  // 确保 WebSocket 连接已建立（不依赖 chatStore 初始化）
  wsStore.init();
  wsStore.onMessage(handleGroupWS);

  // 预加载群组清单（切换侧边栏时立即可用）
  fetchGroups();

  // 恢复上次的视图和节点（Agent 会话 / 群组）
  try {
    const lastView = localStorage.getItem('agentchat.lastView') as 'agents' | 'groups' | null;
    const lastGroup = localStorage.getItem('agentchat.lastGroup');

    if (lastView === 'groups' && lastGroup) {
      // 恢复群组视图
      activeView.value = 'groups';
      fetchGroups().then(() => {
        activeGroupId.value = lastGroup;
      });
    } else {
      // 默认恢复 Agent 会话视图（tryRestoreLastAgent 在 agent.list 响应中自动调用）
      activeView.value = 'agents';
    }
  } catch { /* ignore */ }
});

provide('sidebarVisible', readonly(sidebarVisible));
provide('toggleSidebar', toggleSidebar);
provide('closeSidebar', closeSidebar);
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩层 -->
    <Transition name="sidebar-overlay">
      <div
        v-if="sidebarVisible"
        class="sidebar-overlay"
        @click="closeSidebar"
      />
    </Transition>

    <!-- 第一层：侧边栏（VS Code 风格） -->
    <Sidebar
      :agents-visible="agentsVisible"
      :active-view="activeView"
      @toggle-agents="toggleAgents"
      @toggle-groups="toggleGroups"
      @open-global-settings="globalSettingsVisible = true"
      @open-agent-settings="settingsAgentId = 'user'; agentSettingsVisible = true"
      @open-token-usage="tokenUsageVisible = true"
    />

    <!-- 第二层：Agent 列表（agents 模式） -->
    <div v-if="agentsVisible && activeView === 'agents'" class="list-panel-wrapper" :style="{ width: agentListWidth + 'px' }">
      <AgentList :class="{ 'sidebar-mobile-visible': sidebarVisible }" />
      <div
        class="resize-handle"
        :class="{ active: resizing }"
        @mousedown="onResizeStart($event, 'agents')"
      />
    </div>

    <!-- 第二层：群组列表（groups 模式） -->
    <div v-if="agentsVisible && activeView === 'groups'" class="list-panel-wrapper" :style="{ width: groupListWidth + 'px' }">
      <GroupList
        :class="{ 'sidebar-mobile-visible': sidebarVisible }"
        :groups="groups"
        :active-group-id="activeGroupId"
        @select-group="selectGroup"
        @create-group="openCreateGroup"
      />
      <div
        class="resize-handle"
        :class="{ active: resizing }"
        @mousedown="onResizeStart($event, 'groups')"
      />
    </div>

    <!-- 第三层：会话窗口 -->
    <ChatView v-if="activeView === 'agents'" />
    <GroupChat
      v-else
      :group="groups.find(r => r.group_id === activeGroupId) ?? null"
      @group-deleted="onGroupDeleted"
    />

    <!-- 创建群组对话框 -->
    <CreateGroupDialog
      v-if="showCreateGroup"
      @close="showCreateGroup = false"
      @created="onGroupCreated"
    />

    <!-- 全局配置面板 -->
    <GlobalSettings
      :visible="globalSettingsVisible"
      @close="globalSettingsVisible = false"
    />

    <!-- Token 用量面板 -->
    <TokenUsage
      :visible="tokenUsageVisible"
      @close="tokenUsageVisible = false"
    />

    <!-- Agent 配置面板（侧边栏头像点击时始终可用） -->
    <AgentSettings
      :agent-id="settingsAgentId"
      :visible="agentSettingsVisible"
      @close="agentSettingsVisible = false"
      @saved="agentSettingsVisible = false"
    />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  position: relative;
}

/* 列表面板 + 拖拽手柄 容器 */
.list-panel-wrapper {
  display: flex;
  flex-shrink: 0;
  overflow: hidden;
}

/* 拖拽手柄 */
.resize-handle {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle.active {
  background: var(--color-primary, #4f46e5);
}

/* 移动端遮罩 */
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 200;
}

/* 遮罩过渡动画 */
.sidebar-overlay-enter-active,
.sidebar-overlay-leave-active {
  transition: opacity 0.25s ease;
}
.sidebar-overlay-enter-from,
.sidebar-overlay-leave-to {
  opacity: 0;
}

/* ===== 响应式：窄屏 (≤768px) ===== */
@media (max-width: 768px) {
  .sidebar-overlay {
    display: block;
  }

  /* 列表面板脱离 flex 流，由内层 fixed 定位的列表自行控制显隐 */
  .list-panel-wrapper {
    position: absolute;
    width: 0 !important;
    overflow: visible;
    z-index: 250;
  }
}
</style>
