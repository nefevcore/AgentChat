<script setup lang="ts">
import { ref, provide, readonly } from 'vue';
import AgentList from './components/AgentList.vue';
import ChatView from './components/ChatView.vue';

/** 侧边栏在移动端是否可见 */
const sidebarVisible = ref(false);

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

    <AgentList :class="{ 'sidebar-mobile-visible': sidebarVisible }" />
    <ChatView />
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
