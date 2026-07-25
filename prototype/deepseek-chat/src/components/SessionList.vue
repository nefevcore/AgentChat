<script setup lang="ts">
import { ref } from 'vue';
import type { Session } from '../types';

const props = defineProps<{
  sessions: Session[];
  activeId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  create: [];
  delete: [id: string];
  rename: [id: string, name: string];
  openSettings: [];
}>();

const editingId = ref('');
const editingName = ref('');

function startRename(session: Session) {
  editingId.value = session.id;
  editingName.value = session.name;
}

function confirmRename() {
  const name = editingName.value.trim();
  if (name && editingId.value) {
    emit('rename', editingId.value, name);
  }
  editingId.value = '';
  editingName.value = '';
}

function cancelRename() {
  editingId.value = '';
  editingName.value = '';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
</script>

<template>
  <div class="session-list">
    <!-- 顶部操作栏 -->
    <div class="session-list-header">
      <span class="title">会话列表</span>
      <button class="btn-icon" @click="emit('create')" title="新建会话">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>

    <!-- 会话项 -->
    <div class="session-items">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === activeId }"
        @click="emit('select', s.id)"
      >
        <div class="session-item-content">
          <!-- 名称（可编辑） -->
          <div v-if="editingId === s.id" class="rename-input-wrap" @click.stop>
            <input
              v-model="editingName"
              class="rename-input"
              @keydown.enter="confirmRename"
              @keydown.escape="cancelRename"
              @blur="confirmRename"
              autofocus
            />
          </div>
          <div v-else class="session-name" @dblclick.stop="startRename(s)">
            {{ s.name }}
          </div>

          <!-- 元信息 -->
          <div class="session-meta">
            <span>{{ s.messages.length }} 条消息</span>
            <span>·</span>
            <span>{{ formatTime(s.updatedAt) }}</span>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="session-actions" v-if="editingId !== s.id">
          <button
            class="action-btn"
            title="重命名"
            @click.stop="startRename(s)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>
          <button
            class="action-btn"
            title="删除"
            @click.stop="emit('delete', s.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="sessions.length === 0" class="empty-sessions">
        <p>暂无会话</p>
        <button class="btn-primary" @click="emit('create')">创建新会话</button>
      </div>
    </div>

    <!-- 底部设置 -->
    <div class="session-list-footer">
      <button class="btn-settings" @click="emit('openSettings')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -3px; margin-right: 6px;">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        设置
      </button>
    </div>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
}

.title {
  font-weight: 700;
  font-size: 16px;
  color: var(--text-primary);
}

.btn-icon {
  background: var(--accent-color);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 18px;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
}

.btn-icon:hover {
  opacity: 0.85;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;
}

.session-item:hover {
  background: var(--hover-bg);
}

.session-item.active {
  background: var(--active-bg);
}

.session-item-content {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.session-meta {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 3px;
  display: flex;
  gap: 4px;
}

.session-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.action-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background 0.15s;
}

.action-btn:hover {
  background: var(--hover-bg);
}

.rename-input-wrap {
  width: 100%;
}

.rename-input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--accent-color);
  border-radius: 6px;
  font-size: 14px;
  background: var(--input-bg);
  color: var(--text-primary);
  outline: none;
}

.empty-sessions {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 16px;
  color: var(--text-secondary);
  gap: 12px;
}

.btn-primary {
  background: var(--accent-color);
  color: #fff;
  border: none;
  padding: 8px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: opacity 0.15s;
}

.btn-primary:hover {
  opacity: 0.85;
}

.session-list-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

.btn-settings {
  width: 100%;
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}

.btn-settings:hover {
  background: var(--hover-bg);
}
</style>
