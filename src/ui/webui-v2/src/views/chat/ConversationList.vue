<!-- ConversationList.vue —— 统一会话列表（Agent + 群组混排）
     数据来源：agentStore.agents + groupStore.groups，按 lastActivity 排序。 -->
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useAgentStore, VIEWER_ID } from '@/stores/agents';
import { useGroupStore } from '@/stores/groups';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import type { AgentInfo, GroupInfo } from '@/domain/types';
import { formatRelativeTime } from '@/domain/format';

const agentStore = useAgentStore();
const groupStore = useGroupStore();
const chatStore = useChatStore();
const ui = useUiStore();

const searchQuery = ref('');

interface UnifiedItem {
  type: 'agent' | 'group';
  id: string;
  name: string;
  lastActivity: number;
  agent?: AgentInfo;
  group?: GroupInfo;
}

const unifiedList = computed<UnifiedItem[]>(() => {
  const items: UnifiedItem[] = [];
  for (const a of agentStore.agents) items.push({ type: 'agent', id: a.id, name: a.name || a.id, lastActivity: a.lastActivity ?? 0, agent: a });
  for (const g of groupStore.groups) items.push({ type: 'group', id: g.group_id, name: g.name, lastActivity: g.lastActivity ?? 0, group: g });
  items.sort((a, b) => b.lastActivity - a.lastActivity);
  return items;
});

const filteredItems = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return unifiedList.value;
  return unifiedList.value.filter(i => i.name.toLowerCase().includes(q));
});

const isActive = (item: UnifiedItem) => {
  const ref = chatStore.activeRef;
  if (!ref) return false;
  return (ref.kind === 'agent' && ref.id === item.id) || (ref.kind === 'group' && ref.id === item.id && item.type === 'group');
};

function selectItem(item: UnifiedItem) {
  if (item.type === 'agent') {
    chatStore.selectConversation({ kind: 'agent', id: item.id });
  } else if (item.group) {
    chatStore.selectConversation({ kind: 'group', id: item.id });
  }
  if (window.innerWidth <= 768) ui.closeSidebar();
}

const activeAgentName = computed(() => {
  const ref = chatStore.activeRef;
  if (ref?.kind === 'agent') return agentStore.getAgentName(ref.id);
  return '';
});

onMounted(() => {
  groupStore.fetchGroups();
  agentStore.requestAgents();
});

function lastMessageText(item: UnifiedItem): string {
  if (item.type === 'agent') return item.agent?.lastMessage?.content ?? '';
  return '';
}
</script>

<template>
  <div class="conversation-list">
    <div class="list-header">
      <input v-model="searchQuery" type="text" class="search-input" placeholder="搜索会话..." />
      <button class="new-group-btn" title="创建群组" @click="ui.createGroupVisible = true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" /></svg>
      </button>
    </div>

    <div class="list-body">
      <div v-if="activeAgentName" class="list-section-label">当前：{{ activeAgentName }}</div>

      <div
        v-for="item in filteredItems"
        :key="item.type + ':' + item.id"
        class="list-item"
        :class="{ active: isActive(item) }"
        @click="selectItem(item)"
      >
        <div class="item-avatar">
          <template v-if="item.type === 'agent'">
            <img v-if="item.agent?.avatar" :src="item.agent.avatar" class="avatar-img" alt="" />
            <span v-else class="avatar-fallback">{{ item.name.charAt(0).toUpperCase() }}</span>
          </template>
          <template v-else>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
          </template>
          <span v-if="item.type === 'agent' && chatStore.unreadAgents.has(item.id)" class="unread-dot" />
        </div>
        <div class="item-info">
          <div class="item-name-row">
            <span class="item-name">{{ item.name }}</span>
            <span v-if="item.lastActivity" class="item-time">{{ formatRelativeTime(item.lastActivity) }}</span>
          </div>
          <div class="item-last">
            {{ lastMessageText(item) || (item.type === 'group' ? `${item.group?.participants.length ?? 0} 个参与者` : '') }}
          </div>
        </div>
      </div>

      <div v-if="filteredItems.length === 0" class="empty-hint">暂无会话</div>
    </div>
  </div>
</template>

<style scoped>
.conversation-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--color-bg-panel, #1e1e22);
  border-right: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
}
.list-header {
  display: flex;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
}
.search-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  background: var(--color-bg-input, rgba(255, 255, 255, 0.04));
  color: var(--color-text-primary);
  font-size: 13px;
}
.new-group-btn {
  width: 32px;
  border: none;
  border-radius: 6px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.new-group-btn:hover { color: var(--color-text-primary); }
.list-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.list-section-label {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--color-text-tertiary, #a8abb2);
}
.list-item {
  display: flex;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.list-item:hover { background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); }
.list-item.active { background: var(--color-primary-soft, rgba(99, 102, 241, 0.15)); }
.item-avatar {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-primary-soft, rgba(99, 102, 241, 0.2));
  color: var(--color-primary, #6366f1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}
.avatar-img { width: 100%; height: 100%; object-fit: cover; }
.avatar-fallback { font-size: 14px; font-weight: 600; }
.unread-dot {
  position: absolute;
  top: 0;
  right: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e74c3c;
  border: 2px solid var(--color-bg-panel);
}
.item-info { flex: 1; min-width: 0; }
.item-name-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
}
.item-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-time { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); flex-shrink: 0; }
.item-last {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.empty-hint {
  padding: 24px;
  text-align: center;
  color: var(--color-text-tertiary, #a8abb2);
  font-size: 13px;
}
</style>
