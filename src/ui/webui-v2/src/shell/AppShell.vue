<!-- AppShell.vue —— 布局壳（插槽驱动）
     由 PerspectiveRegistry 决定渲染哪些视角；活动栏/列表面板/主区/弹窗层
     均为插槽，新增视角无需改动本文件。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useUiStore } from '@/stores/ui';
import { getPerspective, getPerspectives } from '@/framework/perspectives';
import ActivityBar from './ActivityBar.vue';
import ListPanel from './ListPanel.vue';
import ModalLayer from './ModalLayer.vue';

const ui = useUiStore();

const perspectives = computed(() => getPerspectives());
const activePerspective = computed(() => getPerspective(ui.activePerspective));
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩 -->
    <Transition name="sidebar-overlay">
      <div v-if="ui.sidebarVisible" class="sidebar-overlay" @click="ui.closeSidebar()" />
    </Transition>

    <!-- 活动栏（插槽：所有注册视角的图标） -->
    <ActivityBar :perspectives="perspectives" />

    <!-- 列表面板（插槽：当前视角的 list 组件） -->
    <ListPanel v-if="activePerspective?.list && ui.listVisible" :perspective="activePerspective" />

    <!-- 主区（插槽：当前视角的 main 组件） -->
    <main class="main-area">
      <component :is="activePerspective?.main" v-if="activePerspective" />
    </main>

    <!-- 弹窗层（插槽：当前视角挂载的全局弹窗） -->
    <ModalLayer :modals="activePerspective?.modals ?? []" />
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
.main-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 110;
}
.sidebar-overlay-enter-active, .sidebar-overlay-leave-active { transition: opacity 0.2s; }
.sidebar-overlay-enter-from, .sidebar-overlay-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .sidebar-overlay { z-index: 110; }
}
</style>
