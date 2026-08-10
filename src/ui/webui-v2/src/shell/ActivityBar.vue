<!-- ActivityBar.vue —— 活动栏（视角图标插槽）
     遍历 PerspectiveRegistry 渲染图标按钮，点击切换视角。 -->
<script setup lang="ts">
import { useUiStore } from '@/stores/ui';
import { useThemeStore } from '@/stores/theme';
import type { Perspective } from '@/framework/perspectives';

defineProps<{ perspectives: Perspective[] }>();

const ui = useUiStore();
const theme = useThemeStore();
</script>

<template>
  <nav class="activity-bar">
    <div class="activity-items">
      <button
        v-for="p in perspectives"
        :key="p.id"
        class="activity-item"
        :class="{ active: ui.activePerspective === p.id }"
        :title="p.label"
        @click="ui.activePerspective = p.id"
      >
        <span class="activity-icon" v-html="p.icon" />
      </button>
    </div>

    <div class="activity-footer">
      <button class="activity-item" title="切换主题" @click="theme.toggleTheme()">
        <span class="activity-icon">
          <svg v-if="theme.theme === 'dark'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
        </span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.activity-bar {
  width: 48px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  background: var(--color-bg-sidebar, var(--color-bg-panel));
  border-right: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  z-index: 100;
}
.activity-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  align-items: center;
}
.activity-footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  align-items: center;
}
.activity-item {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary, #a8abb2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.activity-item:hover {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-primary);
}
.activity-item.active {
  background: var(--color-primary, #6366f1);
  color: #fff;
}
.activity-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
