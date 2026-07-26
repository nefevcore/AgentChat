<script setup lang="ts">
import { ref, computed } from 'vue';
import { useAgentStore } from '../stores/agents';
import { useThemeStore } from '../stores/theme';

const emit = defineEmits<{
  (e: 'toggleAgents'): void;
  (e: 'toggleRooms'): void;
  (e: 'openGlobalSettings'): void;
  (e: 'openAgentSettings'): void;
  (e: 'openTokenUsage'): void;
}>();

defineProps<{
  agentsVisible: boolean;
  activeView: 'agents' | 'rooms';
}>();

const agentStore = useAgentStore();
const themeStore = useThemeStore();

/** 当前登录用户（User）的头像 URL */
const currentAvatar = computed(() => {
  return agentStore.getAgentAvatar('user')
    || `/api/agents/user/avatar`;
});

/** 当前登录用户（User）的显示名称 */
const currentAgentName = computed(() => {
  return agentStore.getAgentName('user') || 'User';
});

/** 首字母占位 */
const avatarInitial = computed(() => currentAgentName.value.charAt(0).toUpperCase());
</script>

<template>
  <div class="sidebar">
    <!-- 顶部：当前 Agent 头像 -->
    <button
      class="sidebar-avatar-btn"
      @click="emit('openAgentSettings')"
      :title="`${currentAgentName} 配置`"
    >
      <img
        v-if="currentAvatar"
        :src="currentAvatar"
        :alt="currentAgentName"
        class="sidebar-avatar-img"
        @load="($event.target as HTMLImageElement).style.display=''"
        @error="($event.target as HTMLImageElement).style.display='none'"
      />
      <span v-else class="sidebar-avatar-placeholder">{{ avatarInitial }}</span>
    </button>

    <!-- Agent 列表图标 -->
    <button
      class="sidebar-btn"
      :class="{ active: agentsVisible && activeView === 'agents' }"
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

    <!-- 房间列表图标 -->
    <button
      class="sidebar-btn"
      :class="{ active: agentsVisible && activeView === 'rooms' }"
      @click="emit('toggleRooms')"
      title="群聊房间"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <line x1="9" y1="10" x2="15" y2="10" />
        <line x1="12" y1="7" x2="12" y2="13" />
      </svg>
    </button>

    <!-- 底部空白区域 -->
    <div class="sidebar-spacer" />

    <!-- Token 用量图标 -->
    <button
      class="sidebar-btn"
      @click="emit('openTokenUsage')"
      title="Token 用量"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </button>

    <!-- 主题切换图标 -->
    <button
      class="sidebar-btn"
      @click="themeStore.toggleTheme()"
      :title="themeStore.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'"
    >
      <!-- 月亮图标（当前为亮色，点击切换暗色） -->
      <svg v-if="themeStore.theme === 'light'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      <!-- 太阳图标（当前为暗色，点击切换亮色） -->
      <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    </button>

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
  background: var(--color-bg-subtle, #333);
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  padding: 8px 0;
  gap: 4px;
  border-right: 1px solid var(--color-border-secondary, rgba(255,255,255,0.08));
}

/* Agent 头像按钮 */
.sidebar-avatar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 6px;
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  margin-bottom: 8px;
  padding: 0;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}

.sidebar-avatar-btn:hover {
  transform: scale(1.1);
  box-shadow: 0 0 0 2px var(--color-primary, #4f46e5);
}

.sidebar-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  position: relative;
  z-index: 1;
}

.sidebar-avatar-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-primary, #4f46e5);
  user-select: none;
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
