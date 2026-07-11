<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{
  (e: 'toggleAgents'): void;
  (e: 'openGlobalSettings'): void;
}>();

defineProps<{
  agentsVisible: boolean;
}>();
</script>

<template>
  <div class="sidebar">
    <!-- 顶部：Agent 列表图标 -->
    <button
      class="sidebar-btn"
      :class="{ active: agentsVisible }"
      @click="emit('toggleAgents')"
      title="Agent 列表"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    </button>

    <!-- 底部空白区域 -->
    <div class="sidebar-spacer" />

    <!-- 底部：全局配置图标 -->
    <button
      class="sidebar-btn"
      @click="emit('openGlobalSettings')"
      title="全局配置"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.sidebar {
  width: 48px;
  background: var(--color-bg-tertiary, #333);
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  padding: 8px 0;
  gap: 4px;
  border-right: 1px solid var(--color-border-secondary, rgba(255,255,255,0.08));
}

.sidebar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--color-text-tertiary, rgba(255,255,255,0.5));
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
  position: relative;
}

.sidebar-btn:hover {
  color: var(--color-text-primary, #fff);
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
}

.sidebar-btn.active {
  color: var(--color-text-primary, #fff);
}

.sidebar-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--color-primary, #4f46e5);
  border-radius: 0 3px 3px 0;
}

.sidebar-spacer {
  flex: 1;
}
</style>
