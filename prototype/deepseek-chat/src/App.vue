<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import {
  loadSessions,
  createSession,
  deleteSession,
  updateSessionName,
  getActiveSessionId,
  loadSettings,
} from './utils/storage';
import type { Session, ApiSettings } from './types';

// ── 状态 ──
const sessions = ref<Session[]>(loadSessions());
const activeSessionId = ref(getActiveSessionId());
const settings = ref<ApiSettings>(loadSettings());
const showSettings = ref(false);
const sidebarVisible = ref(true);

// ── 活跃会话 ──
const activeSession = computed(() =>
  sessions.value.find(s => s.id === activeSessionId.value) || null
);

// 刷新会话列表
function refreshSessions() {
  sessions.value = loadSessions();
}

// 创建新会话
function handleCreateSession() {
  const s = createSession();
  activeSessionId.value = s.id;
  refreshSessions();
}

// 选中会话
function handleSelectSession(id: string) {
  activeSessionId.value = id;
  // 会话内消息可能在 ChatView 中已更新到 localStorage，刷新列表以同步排序
  refreshSessions();
}

// 删除会话
function handleDeleteSession(id: string) {
  deleteSession(id);
  activeSessionId.value = getActiveSessionId();
  refreshSessions();
}

// 重命名会话
function handleRenameSession(id: string, name: string) {
  updateSessionName(id, name);
  refreshSessions();
}

// 保存设置
function handleSaveSettings(s: ApiSettings) {
  settings.value = s;
}

// 监听会话更新（从 ChatView 触发刷新）
function onSessionUpdated() {
  refreshSessions();
}

// 移动端切换侧边栏
function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value;
}

// 如果没有会话，自动创建一个
if (sessions.value.length === 0) {
  handleCreateSession();
}
</script>

<template>
  <div class="app-layout">
    <!-- 侧边栏：会话列表 -->
    <aside class="sidebar" :class="{ hidden: !sidebarVisible }">
      <SessionList
        :sessions="sessions"
        :activeId="activeSessionId"
        @select="handleSelectSession"
        @create="handleCreateSession"
        @delete="handleDeleteSession"
        @rename="handleRenameSession"
        @open-settings="showSettings = true"
      />
    </aside>

    <!-- 主聊天区 -->
    <main class="chat-area">
      <!-- 顶部栏 -->
      <header class="chat-header">
        <button class="btn-icon toggle-sidebar" @click="toggleSidebar" title="切换侧边栏">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <button
          v-if="!sidebarVisible"
          class="btn-icon new-session-btn"
          @click="handleCreateSession"
          title="新建会话"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
        <span class="session-name">{{ activeSession?.name || 'DeepSeek Chat' }}</span>
      </header>

      <!-- 聊天视图 -->
      <ChatView
        v-if="activeSession"
        :key="activeSession.id"
        :session="activeSession"
        :settings="settings"
        @updated="onSessionUpdated"
      />
      <div v-else class="empty-state">
        <p>选择或创建一个会话开始聊天</p>
      </div>
    </main>

    <!-- 设置弹窗 -->
    <SettingsDialog
      v-if="showSettings"
      :settings="settings"
      @save="handleSaveSettings"
      @close="showSettings = false"
    />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  width: 280px;
  min-width: 280px;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  transition: margin-left 0.25s ease;
}

.sidebar.hidden {
  margin-left: -280px;
}

.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--chat-bg);
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 16px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.session-name {
  flex: 1;
  font-weight: 600;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: 6px;
}

.btn-icon {
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 6px;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.btn-icon:hover {
  background: var(--hover-bg);
}

.new-session-btn {
  color: var(--accent-color);
  opacity: 0.85;
}

.new-session-btn:hover {
  opacity: 1;
  background: var(--active-bg);
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 16px;
}
</style>
