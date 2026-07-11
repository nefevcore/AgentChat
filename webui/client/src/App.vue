<script setup lang="ts">
import { ref, provide, readonly, onUnmounted } from 'vue';
import Sidebar from './components/Sidebar.vue';
import AgentList from './components/AgentList.vue';
import ChatView from './components/ChatView.vue';
import GlobalSettings from './components/GlobalSettings.vue';

/** Agent 列表面板可见性 */
const agentsVisible = ref(true);
/** Agent 列表面板宽度 */
const agentListWidth = ref(260);
/** 移动端侧边栏可见性 */
const sidebarVisible = ref(false);
/** 全局配置面板 */
const globalSettingsVisible = ref(false);

const MIN_AGENT_LIST = 160;
const MIN_CHAT = 320;

/** 拖拽调整 Agent 列表宽度 */
const resizing = ref(false);
let resizeStartX = 0;
let resizeStartW = 0;

function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  resizing.value = true;
  resizeStartX = e.clientX;
  resizeStartW = agentListWidth.value;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResizeMove(e: MouseEvent) {
  if (!resizing.value) return;
  const delta = e.clientX - resizeStartX;
  const maxWidth = window.innerWidth - 48 - MIN_CHAT;
  const w = Math.max(MIN_AGENT_LIST, Math.min(resizeStartW + delta, maxWidth));
  agentListWidth.value = w;
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

function toggleAgents() {
  agentsVisible.value = !agentsVisible.value;
}

function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value;
}

function closeSidebar() {
  sidebarVisible.value = false;
}

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
      @toggle-agents="toggleAgents"
      @open-global-settings="globalSettingsVisible = true"
    />

    <!-- 第二层：Agent 列表（含拖拽手柄） -->
    <div v-if="agentsVisible" class="agent-list-wrapper" :style="{ width: agentListWidth + 'px' }">
      <AgentList :class="{ 'sidebar-mobile-visible': sidebarVisible }" />
      <div
        class="resize-handle"
        :class="{ active: resizing }"
        @mousedown="onResizeStart"
      />
    </div>

    <!-- 第三层：会话窗口 -->
    <ChatView />

    <!-- 全局配置面板 -->
    <GlobalSettings
      :visible="globalSettingsVisible"
      @close="globalSettingsVisible = false"
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

/* Agent 列表 + 拖拽手柄 容器 */
.agent-list-wrapper {
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
}
</style>
