<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useAgentStore } from '../stores/agents';
import { VIEWER_ID } from '../constants';
import { useThemeStore } from '../stores/theme';

const emit = defineEmits<{
  (e: 'toggleList'): void;
  (e: 'openGlobalSettings'): void;
  (e: 'openAgentSettings'): void;
  (e: 'openTokenUsage'): void;
  (e: 'showVersion'): void;
}>();

defineProps<{
  listVisible: boolean;
}>();

const agentStore = useAgentStore();
const themeStore = useThemeStore();

const currentAvatar = computed(() => agentStore.getAgentAvatar(VIEWER_ID) || `/api/agents/user/avatar`);
const currentAgentName = computed(() => agentStore.getAgentName(VIEWER_ID) || 'User');
const avatarInitial = computed(() => currentAgentName.value.charAt(0).toUpperCase());

// ── 更多菜单 ──
const moreOpen = ref(false);
const moreTriggerRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const hasUpdate = ref(false);

let closeTimeout: ReturnType<typeof setTimeout> | null = null;

function updateMenuPosition() {
  if (!moreTriggerRef.value) return;
  const rect = moreTriggerRef.value.getBoundingClientRect();
  menuStyle.value = {
    position: 'fixed',
    left: `${rect.right + 4}px`,
    bottom: `${window.innerHeight - rect.bottom}px`,
  };
}

function openMore() {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  moreOpen.value = !moreOpen.value;
  if (moreOpen.value) nextTick(() => updateMenuPosition());
}

function onMoreMouseLeave() {
  closeTimeout = setTimeout(() => { moreOpen.value = false; }, 300);
}

function onMoreMouseEnter() {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
}

function onItemClick(action: () => void) {
  moreOpen.value = false;
  action();
}

onMounted(async () => {
  try {
    const simulate = localStorage.getItem('agentchat.simulateUpdate') === '1';
    const url = simulate ? '/api/version?simulate=true' : '/api/version';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    hasUpdate.value = data.hasUpdate || false;
  } catch { /* ignore */ }
});

onUnmounted(() => {
  if (closeTimeout) clearTimeout(closeTimeout);
});
</script>

<template>
  <div class="sidebar">
    <button class="sidebar-avatar-btn" @click="emit('openAgentSettings')" :title="`${currentAgentName} 配置`">
      <img
        v-if="currentAvatar" :src="currentAvatar" :alt="currentAgentName"
        class="sidebar-avatar-img"
        @load="($event.target as HTMLImageElement).style.display=''"
        @error="($event.target as HTMLImageElement).style.display='none'"
      />
      <span v-else class="sidebar-avatar-placeholder">{{ avatarInitial }}</span>
    </button>

    <button class="sidebar-btn" :class="{ active: listVisible }" @click="emit('toggleList')" title="会话列表">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    </button>

    <div class="sidebar-spacer" />

    <button class="sidebar-btn" @click="emit('openTokenUsage')" title="Token 用量">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
    </button>

    <button class="sidebar-btn" @click="themeStore.toggleTheme()" :title="themeStore.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'">
      <svg v-if="themeStore.theme === 'light'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
      <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    </button>

    <div class="more-wrapper">
      <button ref="moreTriggerRef" class="sidebar-btn more-trigger" :class="{ active: moreOpen }" @click="openMore" title="更多">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
        <span v-if="hasUpdate" class="more-dot" />
      </button>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="more-fade">
      <div v-if="moreOpen" class="agentchat-more-menu" :style="menuStyle" @mouseenter="onMoreMouseEnter" @mouseleave="onMoreMouseLeave">
        <button class="agentchat-more-item" @click="onItemClick(() => emit('openGlobalSettings'))">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span>设置</span>
        </button>
        <button class="agentchat-more-item" @click="onItemClick(() => emit('showVersion'))">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>检查更新</span>
          <span v-if="hasUpdate" class="agentchat-more-item-dot" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sidebar {
  width: 48px;
  background: var(--color-bg-subtle, #333);
  display: flex; flex-direction: column; align-items: center;
  flex-shrink: 0; padding: 8px 0; gap: 4px;
  border-right: 1px solid var(--color-border-secondary, rgba(255,255,255,0.08));
  position: relative; z-index: 10;
}

.sidebar-avatar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: none; border-radius: 6px;
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  cursor: pointer; transition: transform 0.15s, box-shadow 0.15s;
  margin-bottom: 8px; padding: 0; overflow: hidden; flex-shrink: 0; position: relative;
}
.sidebar-avatar-btn:hover { transform: scale(1.1); box-shadow: 0 0 0 2px var(--color-primary, #4f46e5); }
.sidebar-avatar-img { width: 100%; height: 100%; object-fit: cover; position: relative; z-index: 1; }
.sidebar-avatar-placeholder {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 600; color: var(--color-primary, #4f46e5); user-select: none;
}

.sidebar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border: none; border-radius: 6px; background: none;
  color: var(--color-text-tertiary, rgba(255,255,255,0.5)); cursor: pointer;
  transition: color 0.15s, background 0.15s; position: relative;
}
.sidebar-btn:hover { color: var(--color-text-primary, #fff); background: var(--color-bg-hover, rgba(255,255,255,0.08)); }
.sidebar-btn.active { color: var(--color-text-primary, #fff); }
.sidebar-btn.active::before {
  content: ''; position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 2px; background: var(--color-primary, #4f46e5); border-radius: 0 2px 2px 0;
}

.sidebar-spacer { flex: 1; }
.more-wrapper { position: relative; z-index: 10; }

.more-dot {
  position: absolute; top: 6px; right: 6px; width: 8px; height: 8px;
  background: #ef4444; border-radius: 50%; border: 1.5px solid var(--color-bg-subtle, #333); z-index: 1;
}

.more-fade-enter-active, .more-fade-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.more-fade-enter-from, .more-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

<style>
.agentchat-more-menu {
  min-width: 180px;
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  overflow: hidden; z-index: 9999;
}

.agentchat-more-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 10px 14px; border: none; background: none;
  color: var(--color-text-primary, #2c3e50); font-size: 13px;
  cursor: pointer; text-align: left; transition: background 0.1s; position: relative;
}
.agentchat-more-item:hover { background: var(--color-bg-surface, #f5f5f5); }
.agentchat-more-item svg { flex-shrink: 0; color: var(--color-text-tertiary, #a8abb2); }

.agentchat-more-item-dot {
  margin-left: auto; width: 7px; height: 7px;
  background: #ef4444; border-radius: 50%; flex-shrink: 0;
}
</style>
