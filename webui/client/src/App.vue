<script setup lang="ts">
import { ref, provide, readonly, onUnmounted, onMounted, watch } from 'vue';
import Sidebar from './components/Sidebar.vue';
import AgentList from './components/AgentList.vue';
import ChatView from './components/ChatView.vue';
import RoomList from './components/RoomList.vue';
import RoomChat from './components/RoomChat.vue';
import CreateRoomDialog from './components/CreateRoomDialog.vue';
import GlobalSettings from './components/GlobalSettings.vue';
import AgentSettings from './components/AgentSettings.vue';
import TokenUsage from './components/TokenUsage.vue';
import { useWebSocketStore } from './stores/websocket';
import { useThemeStore } from './stores/theme';
import type { RoomInfo } from './types';

/** 当前活动视图 */
const activeView = ref<'agents' | 'rooms'>('agents');

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
/** 房间列表面板宽度 */
const roomListWidth = ref(260);
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

/** 房间状态 */
const rooms = ref<RoomInfo[]>([]);
const activeRoomId = ref('');
const showCreateRoom = ref(false);

const wsStore = useWebSocketStore();

const MIN_LIST = 160;
const MIN_CHAT = 320;

/** 拖拽调整列表宽度 */
const resizing = ref(false);
let resizeStartX = 0;
let resizeStartW = 0;
let resizeTarget = 'agents' as 'agents' | 'rooms';

function onResizeStart(e: MouseEvent, target: 'agents' | 'rooms') {
  e.preventDefault();
  resizing.value = true;
  resizeStartX = e.clientX;
  resizeStartW = target === 'agents' ? agentListWidth.value : roomListWidth.value;
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
  else roomListWidth.value = w;
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

function toggleRooms() {
  if (activeView.value !== 'rooms') {
    activeView.value = 'rooms';
    agentsVisible.value = true;
    fetchRooms();
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

// ── 房间操作 ──
async function fetchRooms() {
  try {
    const resp = await fetch('/api/rooms');
    if (resp.ok) {
      const data = await resp.json();
      rooms.value = data.rooms ?? [];
    }
  } catch { /* ignore */ }
}

function selectRoom(roomId: string) {
  activeRoomId.value = roomId;
  // 持久化
  try { localStorage.setItem('agentchat.lastRoom', roomId); } catch { /* ignore */ }
}

function openCreateRoom() {
  showCreateRoom.value = true;
}

function onRoomCreated(roomId: string) {
  // 先加载房间列表，确保 rooms 数组有数据后再选中
  fetchRooms().then(() => {
    selectRoom(roomId);
  });
}

function onRoomDeleted(roomId: string) {
  if (activeRoomId.value === roomId) {
    activeRoomId.value = '';
    try { localStorage.removeItem('agentchat.lastRoom'); } catch { /* ignore */ }
  }
  fetchRooms();
}

// ── WS 房间事件 ──
function handleRoomWS(type: string, data: any) {
  switch (type) {
    case 'room.created':
    case 'room.deleted':
    case 'room.join':
    case 'room.leave':
      fetchRooms();
      break;
    case 'room.message': {
      // 新消息时更新房间排序（将活跃房间排到前面）
      const idx = rooms.value.findIndex(r => r.room_id === data.room_id);
      if (idx > 0) {
        const [room] = rooms.value.splice(idx, 1);
        rooms.value.unshift(room);
      }
      break;
    }
  }
}

onMounted(() => {
  // 确保 WebSocket 连接已建立（不依赖 chatStore 初始化）
  wsStore.init();
  wsStore.onMessage(handleRoomWS);

  // 恢复上次的视图和节点（Agent 会话 / 群聊房间）
  try {
    const lastView = localStorage.getItem('agentchat.lastView') as 'agents' | 'rooms' | null;
    const lastRoom = localStorage.getItem('agentchat.lastRoom');

    if (lastView === 'rooms' && lastRoom) {
      // 恢复群聊视图
      activeView.value = 'rooms';
      fetchRooms().then(() => {
        activeRoomId.value = lastRoom;
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
      @toggle-rooms="toggleRooms"
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

    <!-- 第二层：房间列表（rooms 模式） -->
    <div v-if="agentsVisible && activeView === 'rooms'" class="list-panel-wrapper" :style="{ width: roomListWidth + 'px' }">
      <RoomList
        :class="{ 'sidebar-mobile-visible': sidebarVisible }"
        :rooms="rooms"
        :active-room-id="activeRoomId"
        @select-room="selectRoom"
        @create-room="openCreateRoom"
      />
      <div
        class="resize-handle"
        :class="{ active: resizing }"
        @mousedown="onResizeStart($event, 'rooms')"
      />
    </div>

    <!-- 第三层：会话窗口 -->
    <ChatView v-if="activeView === 'agents'" />
    <RoomChat
      v-else
      :room="rooms.find(r => r.room_id === activeRoomId) ?? null"
      @room-deleted="onRoomDeleted"
    />

    <!-- 创建房间对话框 -->
    <CreateRoomDialog
      v-if="showCreateRoom"
      @close="showCreateRoom = false"
      @created="onRoomCreated"
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
