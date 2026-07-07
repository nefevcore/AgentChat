<script setup lang="ts">
import { onMounted, inject } from 'vue';
import { useChatStore } from '../stores/chat';
import type { AgentInfo } from '../types';

const store = useChatStore();

/** 注入父组件提供的关闭侧边栏方法 */
const closeSidebar = inject<() => void>('closeSidebar', () => {});

onMounted(() => {
  store.requestAgents();
});

function selectAndClose(id: string) {
  store.selectAgent(id);
  closeSidebar();
}

function formatLastMessage(lastMessage: AgentInfo['lastMessage']): string {
  if (!lastMessage || !lastMessage.content) return '';
  const prefix = lastMessage.role === 'user' ? '你: ' : '';
  return prefix + lastMessage.content;
}
</script>

<template>
  <div class="agent-list">
    <div class="header">
      <h3>Agent 列表</h3>
      <!-- 移动端关闭按钮 -->
      <button class="mobile-close-btn" @click="closeSidebar" title="关闭菜单">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div class="agents">
      <div
        v-for="agent in store.agents"
        :key="agent.id"
        class="agent-item"
        :class="{ active: store.activeAgent === agent.id }"
        @click="selectAndClose(agent.id)"
      >
        <div class="agent-name">{{ agent.name || agent.id }}</div>
        <div class="agent-last-msg">{{ formatLastMessage(agent.lastMessage) }}</div>
      </div>
      <div v-if="store.agents.length === 0" class="empty">
        暂无可用的 Agent
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-list {
  width: var(--layout-sidebar-width);
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-secondary);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  z-index: 210;
  transition: transform 0.25s ease;
}

.header {
  padding: var(--space-md);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--color-border-secondary);
}

.header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
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
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.agents {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-sm);
}

.agent-item {
  padding: 12px;
  margin-bottom: var(--space-xs);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  border: 1px solid transparent;
}

.agent-item:hover {
  background: var(--color-bg-primary);
  border-color: var(--color-border-secondary);
}

.agent-item.active {
  background: var(--color-primary-light);
  border: 1px solid var(--color-primary);
}

.agent-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: var(--space-xs);
  color: var(--color-text-primary);
}

.agent-last-msg {
  font-size: 12px;
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
  .agent-list {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(280px, 80vw);
    transform: translateX(-100%);
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.15);
  }

  /* 展开状态 */
  .agent-list.sidebar-mobile-visible {
    transform: translateX(0);
  }

  .mobile-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
