<script setup lang="ts">
import { ref, computed, inject, watch } from 'vue';
import type { GroupInfo } from '../types';
import { useAgentStore } from '../stores/agents';

const emit = defineEmits<{
  (e: 'selectGroup', groupId: string): void;
  (e: 'createGroup'): void;
}>();

const props = defineProps<{
  groups: GroupInfo[];
  activeGroupId: string;
}>();

const agentStore = useAgentStore();
const closeSidebar = inject<() => void>('closeSidebar', () => {});

const searchQuery = ref('');
/** 每个群组的最新一条消息缓存：room_id → 消息文本 */
const lastMessages = ref<Record<string, string>>({});

const filteredGroups = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return props.groups;
  return props.groups.filter(r =>
    r.room_id.toLowerCase().includes(q) ||
    r.name.toLowerCase().includes(q)
  );
});

function selectAndClose(groupId: string) {
  emit('selectGroup', groupId);
  closeSidebar();
}

/** 获取群组最新消息文本 */
function lastMessageLabel(room: GroupInfo): string {
  return lastMessages.value[room.room_id] || '';
}

/** 加载所有群组的最新一条消息 */
async function fetchlastMessages() {
  for (const room of props.groups) {
    try {
      const resp = await fetch(`/api/groups/${encodeURIComponent(room.room_id)}/history?limit=1`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const msgs = data.messages ?? [];
      if (msgs.length > 0) {
        const m = msgs[msgs.length - 1];
        lastMessages.value[room.room_id] = (m.content ?? '').slice(0, 40);
      }
    } catch { /* ignore */ }
  }
}

watch(() => props.groups, fetchlastMessages, { immediate: true, deep: false });

// ── 群聊合并头像 ──

/** 参与者头像信息 */
interface ParticipantAvatar {
  avatar: string | null;
  name: string;
}

/** 获取群组前 9 个参与者的头像信息 */
function getGroupParticipantAvatars(room: GroupInfo): ParticipantAvatar[] {
  return room.participants.slice(0, 9).map(id => ({
    avatar: agentStore.getAgentAvatar(id),
    name: agentStore.getAgentName(id),
  }));
}

/** 根据人数返回 grid 行列布局 */
function gridLayout(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}
</script>

<template>
  <div class="group-list">
    <div class="header">
      <div class="search-box">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="搜索群组..."
        />
      </div>
      <button class="add-btn" @click="emit('createGroup')" title="创建群组">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button class="mobile-close-btn" @click="closeSidebar" title="关闭菜单">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div class="groups">
      <div
        v-for="room in filteredGroups"
        :key="room.room_id"
        class="room-item"
        :class="{ active: activeGroupId === room.room_id }"
        @click="selectAndClose(room.room_id)"
      >
        <div
          class="room-avatar"
          :style="{
            display: 'grid',
            gridTemplateColumns: `repeat(${gridLayout(getGroupParticipantAvatars(room).length).cols}, 1fr)`,
            gridTemplateRows: `repeat(${gridLayout(getGroupParticipantAvatars(room).length).rows}, 1fr)`,
          }"
        >
          <template v-for="(p, idx) in getGroupParticipantAvatars(room)" :key="idx">
            <img
              v-if="p.avatar"
              :src="p.avatar"
              :alt="p.name"
              class="group-avatar-cell"
            />
            <span v-else class="group-avatar-cell group-avatar-placeholder">{{ p.name.charAt(0).toUpperCase() }}</span>
          </template>
          <!-- 只有一个参与者时用大图标 -->
          <svg
            v-if="getGroupParticipantAvatars(room).length === 0"
            width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div class="room-info">
          <div class="room-name">{{ room.name }}</div>
          <div class="room-participants">{{ lastMessageLabel(room) }}</div>
        </div>
      </div>
      <div v-if="filteredGroups.length === 0 && groups.length > 0" class="empty">
        无匹配的群组
      </div>
      <div v-else-if="groups.length === 0" class="empty">
        暂无群聊群组
      </div>
    </div>
  </div>
</template>

<style scoped>
.group-list {
  flex: 1;
  min-width: 0;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border-secondary);
  display: flex;
  flex-direction: column;
  z-index: 210;
  transition: transform 0.25s ease;
}

.header {
  height: var(--layout-header-height);
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--color-border-secondary);
  flex-shrink: 0;
}

/* 搜索框 */
.search-box {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 8px;
  color: var(--color-text-tertiary, #a8abb2);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 5px 8px 5px 28px;
  border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 6px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary, #2c3e50);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus {
  border-color: var(--color-primary, #6366f1);
}
.search-input::placeholder {
  color: var(--color-text-tertiary, #a8abb2);
}

/* 新增按钮 */
.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--color-text-secondary, #7f8c8d);
  cursor: pointer;
  flex-shrink: 0;
}
.add-btn:hover {
  background: var(--color-bg-page, #fff);
  color: var(--color-primary, #6366f1);
}

/* 移动端关闭按钮：默认隐藏 */
.mobile-close-btn {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 4px;
  border-radius: var(--radius-sm);
  line-height: 0;
}
.mobile-close-btn:hover {
  background: var(--color-bg-subtle);
  color: var(--color-text-primary);
}

/* 群组列表 */
.groups {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-sm);
}

.room-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: var(--space-xs);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  border: 1px solid transparent;
  gap: 6px;
}
.room-item:hover {
  background: var(--color-bg-page);
  border-color: var(--color-border-secondary);
}
.room-item.active {
  background: var(--color-primary-light);
  border: 1px solid var(--color-primary);
}
.room-avatar {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  color: var(--color-primary, #4f46e5);
  flex-shrink: 0;
  gap: 1px;
  padding: 2px;
  box-sizing: border-box;
  overflow: hidden;
}

/* 群组合并头像的每个单元格 */
.group-avatar-cell {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: var(--color-primary, #4f46e5);
  min-width: 0;
  min-height: 0;
}

.group-avatar-placeholder {
  text-transform: uppercase;
  line-height: 1;
}
.room-info {
  flex: 1;
  min-width: 0;
}

.room-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 19px;
  margin-bottom: 2px;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-participants {
  font-size: 11px;
  line-height: 19px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: var(--space-lg);
  text-align: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

/* ===== 响应式：窄屏 (≤768px) ===== */
@media (max-width: 768px) {
  .group-list {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(280px, 80vw);
    transform: translateX(-100%);
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.15);
  }

  /* 展开状态 */
  .group-list.sidebar-mobile-visible {
    transform: translateX(0);
  }

  .mobile-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
