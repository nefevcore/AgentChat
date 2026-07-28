<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useAgentStore } from '../stores/agents';
import { useThemeStore } from '../stores/theme';

const emit = defineEmits<{
  (e: 'toggleAgents'): void;
  (e: 'toggleGroups'): void;
  (e: 'openGlobalSettings'): void;
  (e: 'openAgentSettings'): void;
  (e: 'openTokenUsage'): void;
  (e: 'showChangelog'): void;
}>();

defineProps<{
  agentsVisible: boolean;
  activeView: 'agents' | 'groups';
}>();

const agentStore = useAgentStore();
const themeStore = useThemeStore();

const currentAvatar = computed(() => agentStore.getAgentAvatar('user') || `/api/agents/user/avatar`);
const currentAgentName = computed(() => agentStore.getAgentName('user') || 'User');
const avatarInitial = computed(() => currentAgentName.value.charAt(0).toUpperCase());

// ── 更多菜单 ──
const moreOpen = ref(false);
const moreTriggerRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const hasUpdate = ref(false);
const currentVersion = ref('');
const latestVersion = ref('');
const updating = ref(false);
const updateMsg = ref('');

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
  closeTimeout = setTimeout(() => { moreOpen.value = false; }, 150);
}

function onMoreMouseEnter() {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
}

function onItemClick(action: () => void) {
  moreOpen.value = false;
  action();
}

async function doUpdate() {
  updating.value = true;
  updateMsg.value = '正在更新...';
  try {
    const res = await fetch('/api/version/update', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      updateMsg.value = data.message;
      // 后端即将重启，前端稍后自动刷新
      setTimeout(() => { window.location.reload(); }, 2000);
    } else {
      updateMsg.value = (data.steps || [data.message]).join(' | ');
      updating.value = false;
    }
  } catch {
    // 后端重启后 fetch 会失败，也算正常，直接刷新
    updateMsg.value = '更新完成，刷新中...';
    setTimeout(() => { window.location.reload(); }, 1500);
  }
}

onMounted(async () => {
  try {
    const simulate = localStorage.getItem('agentchat.simulateUpdate') === '1';
    const url = simulate ? '/api/version?simulate=true' : '/api/version';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    currentVersion.value = data.current || '';
    latestVersion.value = data.latest || '';
    hasUpdate.value = data.hasUpdate || false;
  } catch { /* ignore */ }
});

onUnmounted(() => {
  if (closeTimeout) clearTimeout(closeTimeout);
});
</script>

<template>
  <div class="sidebar">
    <!-- 顶部：当前 Agent 头像 -->
    <button class="sidebar-avatar-btn" @click="emit('openAgentSettings')" :title="`${currentAgentName} 配置`">
      <img
        v-if="currentAvatar" :src="currentAvatar" :alt="currentAgentName"
        class="sidebar-avatar-img"
        @load="($event.target as HTMLImageElement).style.display=''"
        @error="($event.target as HTMLImageElement).style.display='none'"
      />
      <span v-else class="sidebar-avatar-placeholder">{{ avatarInitial }}</span>
    </button>

    <!-- Agent 列表 -->
    <button class="sidebar-btn" :class="{ active: agentsVisible && activeView === 'agents' }" @click="emit('toggleAgents')" title="Agent 列表">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    </button>

    <!-- 群组 -->
    <button class="sidebar-btn" :class="{ active: agentsVisible && activeView === 'groups' }" @click="emit('toggleGroups')" title="群组">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="12" y1="7" x2="12" y2="13"/>
      </svg>
    </button>

    <div class="sidebar-spacer" />

    <!-- Token -->
    <button class="sidebar-btn" @click="emit('openTokenUsage')" title="Token 用量">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
    </button>

    <!-- 主题 -->
    <button class="sidebar-btn" @click="themeStore.toggleTheme()" :title="themeStore.theme === 'dark' ? '切换亮色主题' : '切换暗色主题'">
      <svg v-if="themeStore.theme === 'light'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
      <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    </button>

    <!-- 更多按钮 -->
    <div class="more-wrapper" @mouseleave="onMoreMouseLeave" @mouseenter="onMoreMouseEnter">
      <button ref="moreTriggerRef" class="sidebar-btn more-trigger" :class="{ active: moreOpen }" @click="openMore" title="更多">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
        </svg>
        <span v-if="hasUpdate" class="more-dot" />
      </button>
    </div>
  </div>

  <!-- Teleport 到 body，脱离所有裁切 -->
  <Teleport to="body">
    <Transition name="more-fade">
      <div v-if="moreOpen" class="agentchat-more-menu" :style="menuStyle" @mouseenter="onMoreMouseEnter" @mouseleave="onMoreMouseLeave">
        <div class="agentchat-more-header">
          <span class="agentchat-more-version">v{{ currentVersion }}</span>
          <span v-if="hasUpdate" class="agentchat-more-update-badge">新版本 v{{ latestVersion }}</span>
        </div>
        <button class="agentchat-more-item" @click="onItemClick(() => emit('openGlobalSettings'))">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span>设置</span>
        </button>
        <button class="agentchat-more-item" @click="onItemClick(() => emit('showChangelog'))">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
          </svg>
          <span>更新日志</span>
        </button>

        <!-- 更新按钮：有新版本时显示 -->
        <div v-if="hasUpdate" class="agentchat-more-update-section">
          <button
            class="agentchat-more-item agentchat-more-update-btn"
            :disabled="updating"
            @click="doUpdate()"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            <span>{{ updating ? '更新中...' : `更新到 v${latestVersion}` }}</span>
          </button>
          <div v-if="updateMsg" class="agentchat-more-update-msg">{{ updateMsg }}</div>
        </div>
      </div>
    </Transition>
  </Teleport>
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
  position: relative;
  z-index: 10;
}

.sidebar-avatar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px;
  border: none; border-radius: 6px;
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  margin-bottom: 8px; padding: 0;
  overflow: hidden; flex-shrink: 0; position: relative;
}
.sidebar-avatar-btn:hover {
  transform: scale(1.1);
  box-shadow: 0 0 0 2px var(--color-primary, #4f46e5);
}
.sidebar-avatar-img {
  width: 100%; height: 100%; object-fit: cover;
  position: relative; z-index: 1;
}
.sidebar-avatar-placeholder {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 600;
  color: var(--color-primary, #4f46e5);
  user-select: none;
}

.sidebar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px;
  border: none; border-radius: 6px; background: none;
  color: var(--color-text-tertiary, rgba(255,255,255,0.5));
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
  position: relative;
}
.sidebar-btn:hover {
  color: var(--color-text-primary, #fff);
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
}
.sidebar-btn.active { color: var(--color-text-primary, #fff); }
.sidebar-btn.active::before {
  content: '';
  position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 2px;
  background: var(--color-primary, #4f46e5);
  border-radius: 0 2px 2px 0;
}

.sidebar-spacer { flex: 1; }

.more-wrapper { position: relative; z-index: 10; }

.more-dot {
  position: absolute; top: 6px; right: 6px;
  width: 8px; height: 8px;
  background: #ef4444; border-radius: 50%;
  border: 1.5px solid var(--color-bg-subtle, #333);
  z-index: 1;
}

/* Transition (scoped — 作用于 Teleport 内元素需要在 global style 中定义) */

.more-fade-enter-active, .more-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.more-fade-enter-from, .more-fade-leave-to {
  opacity: 0; transform: translateY(-4px);
}
</style>

<!-- Teleported menu styles (unscoped, rendered in body) -->
<style>
.agentchat-more-menu {
  min-width: 200px;
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  overflow: hidden;
  z-index: 9999;
}

.agentchat-more-header {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--color-text-tertiary, #a8abb2);
  border-bottom: 1px solid var(--color-border-secondary, #f0f0f0);
  display: flex; align-items: center; gap: 8px;
}
.agentchat-more-version {
  font-weight: 600;
  color: var(--color-text-secondary, #7f8c8d);
}
.agentchat-more-update-badge {
  background: #fef2f2; color: #dc2626;
  padding: 1px 6px; border-radius: 10px;
  font-weight: 500; font-size: 10px;
}

.agentchat-more-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 10px 14px;
  border: none; background: none;
  color: var(--color-text-primary, #2c3e50);
  font-size: 13px; cursor: pointer; text-align: left;
  transition: background 0.1s;
}
.agentchat-more-item:hover { background: var(--color-bg-surface, #f5f5f5); }
.agentchat-more-item svg {
  flex-shrink: 0;
  color: var(--color-text-tertiary, #a8abb2);
}
.agentchat-more-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agentchat-more-update-section {
  border-top: 1px solid var(--color-border-secondary, #f0f0f0);
}
.agentchat-more-update-btn {
  color: var(--color-primary, #6366f1);
  font-weight: 500;
}
.agentchat-more-update-btn svg {
  color: var(--color-primary, #6366f1);
}
.agentchat-more-update-msg {
  padding: 6px 14px 10px;
  font-size: 11px;
  color: var(--color-text-tertiary, #a8abb2);
  white-space: pre-line;
}
</style>
