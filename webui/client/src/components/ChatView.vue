<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, inject, type Ref } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import { useWebSocketStore } from '../stores/websocket';
import Message from './chat/Message/Message.vue';
import ThinkingToolGroup from './chat/Message/ThinkingToolGroup.vue';
import ChatInput from './ChatInput.vue';
import type { ChatMessage } from '../types';

const chatStore = useChatStore();
const agentStore = useAgentStore();
const wsStore = useWebSocketStore();
const messagesContainer = ref<HTMLElement>();

/** 注入父组件提供的切换侧边栏方法 */
const toggleSidebar = inject<() => void>('toggleSidebar', () => {});

/** Agent 配置面板可见性（由 App.vue 通过 provide 共享） */
const agentSettingsVisible = inject<Ref<boolean>>('agentSettingsVisible', ref(false));

/** 配置面板目标 Agent ID（由 App.vue 通过 provide 共享） */
const settingsAgentId = inject<Ref<string>>('settingsAgentId', ref('user'));

/** 更多操作菜单 */
const showMoreMenu = ref(false);
const deleteTarget = ref<{ id: string; name: string } | null>(null);
const deleteError = ref('');
const deleting = ref(false);

function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
  if (showMoreMenu.value) {
    setTimeout(() => document.addEventListener('click', closeMoreMenu, { once: true }), 0);
  }
}
function closeMoreMenu() { showMoreMenu.value = false; }

/** 手动归档消息并更新记忆 */
function handleNewSession() {
  if (!agentStore.activeAgentId || chatStore.turnInProgress) return;
  chatStore.archiveSession();
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(deleteTarget.value.id)}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) { deleteError.value = data.error || '删除失败'; return; }
    if (agentStore.activeAgentId === deleteTarget.value.id) {
      agentStore.selectAgent(deleteTarget.value.id);
    }
    deleteTarget.value = null;
    agentStore.requestAgents();
  } catch (err: any) {
    deleteError.value = `删除失败: ${err.message}`;
  } finally {
    deleting.value = false;
  }
}

/** 用户是否手动向上滚动（离开底部时暂停自动滚动） */
const isUserScrolledUp = ref(false);

/** 是否正在加载更多历史消息（滚动到顶部触发） */
const isLoadingMore = ref(false);

/** 滚动到顶部阈值（px） */
const SCROLL_TOP_THRESHOLD = 50;

/** 当前选中 Agent 的显示名称 */
const activeAgentName = computed(() => {
  if (!agentStore.activeAgentId) return '';
  const agent = agentStore.agents.find(a => a.id === agentStore.activeAgentId);
  return agent?.name || agentStore.activeAgentId;
});

/** 判断滚动条是否接近底部（阈值 80px，容纳流式输出时的高度跳动） */
function isNearBottom(): boolean {
  if (!messagesContainer.value) return true;
  const { scrollTop, scrollHeight, clientHeight } = messagesContainer.value;
  return scrollHeight - scrollTop - clientHeight < 80;
}

/** 滚动到底部 */
function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

/** 用户滚动时：若离开底部则暂停自动滚动，若滚回底部则恢复；滚到顶部则加载更多 */
function onScroll() {
  isUserScrolledUp.value = !isNearBottom();

  if (messagesContainer.value) {
    const { scrollTop } = messagesContainer.value;
    if (scrollTop <= SCROLL_TOP_THRESHOLD && chatStore.hasMoreHistory && !chatStore.loadingHistory) {
      triggerLoadMore();
    }
  }
}

/** 加载更多历史消息并保持滚动位置 */
async function triggerLoadMore() {
  if (!messagesContainer.value || isLoadingMore.value) return;
  isLoadingMore.value = true;

  const container = messagesContainer.value;
  const prevScrollHeight = container.scrollHeight;

  chatStore.loadMoreHistory();

  await waitForHistoryLoaded();
  await nextTick();

  container.scrollTop = container.scrollHeight - prevScrollHeight;
  isLoadingMore.value = false;
}

/** 等待历史加载完成（loadingHistory 从 true 变 false） */
function waitForHistoryLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (!chatStore.loadingHistory) {
      resolve();
      return;
    }
    const stop = watch(() => chatStore.loadingHistory, (val) => {
      if (!val) {
        stop();
        resolve();
      }
    });
  });
}

/** 点击回到底部按钮：滚动并恢复自动跟随 */
function scrollToBottomAndReset() {
  scrollToBottom();
  isUserScrolledUp.value = false;
}

// 监听最后一条 assistant 消息的流式内容变化，用于触发自动滚动
const lastStreamingContent = computed(() => {
  const msgs = chatStore.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.isStreaming) {
      return m.content + (m.reasoning_content ?? '') + (m.thinking ?? '');
    }
  }
  return '';
});

// 自动滚到底部：消息数量变化 OR 流式内容变化
watch(
  () => [chatStore.messages.length, lastStreamingContent.value] as const,
  async () => {
    await nextTick();
    if (!isUserScrolledUp.value) {
      scrollToBottom();
    }
  }
);

// ── 消息分组：将连续的 thinking+tool 轮次合并为 ThinkingToolGroup ──
interface DisplayItem {
  type: 'message' | 'thinking-tool-group';
  message?: ChatMessage;
  groupMessages?: ChatMessage[];
  index: number;
  isStreaming?: boolean;
}

function hasThinking(msg: ChatMessage): boolean {
  const r = msg.reasoning_content || msg.thinking || '';
  return msg.role === 'assistant' && (r.trim().length > 0 || !!(msg.toolCalls && msg.toolCalls.length > 0));
}

/** 收集从 start 位置开始的连续 tool 消息 */
function takeTools(msgs: ChatMessage[], start: number): number {
  let i = start;
  while (i < msgs.length && msgs[i].role === 'tool') i++;
  return i;
}

/** 检测后续 assistant 是否有跟随的 tool */
function hasToolsAfter(msgs: ChatMessage[], j: number): boolean {
  return takeTools(msgs, j + 1) > j + 1;
}

const displayItems = computed<DisplayItem[]>(() => {
  const raw = chatStore.messages.filter(
    m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
  );
  const items: DisplayItem[] = [];
  const streaming = raw.some(m => m.isStreaming);

  let i = 0;
  while (i < raw.length) {
    const msg = raw[i];
    void msg.label;

    if (!hasThinking(msg)) {
      items.push({ type: 'message', message: msg, index: i,
        isStreaming: streaming && i === raw.length - 1 && msg.role === 'assistant' });
      i++;
      continue;
    }

    const group: ChatMessage[] = [raw[i]];
    let j = takeTools(raw, i + 1);
    group.push(...raw.slice(i + 1, j));

    if (group.length < 2) {
      items.push({ type: 'message', message: msg, index: i,
        isStreaming: streaming && i === raw.length - 1 && msg.role === 'assistant' });
      i++;
      continue;
    }

    while (j < raw.length && hasThinking(raw[j])) {
      if (!hasToolsAfter(raw, j)) {
        group.push(raw[j]); j++; break;
      }
      group.push(raw[j]); j++;
      const toolEnd = takeTools(raw, j);
      group.push(...raw.slice(j, toolEnd));
      j = toolEnd;
    }

    const last = group[group.length - 1];
    const final = last.role === 'assistant';
    if (final) group[group.length - 1] = { ...last, content: '' };

    items.push({
      type: 'thinking-tool-group', groupMessages: group,
      index: i, isStreaming: streaming && j >= raw.length,
    });

    if (final) {
      items.push({
        type: 'message',
        message: { ...last, reasoning_content: '', thinking: '' },
        index: j - 1, isStreaming: streaming && j >= raw.length,
      });
    }

    i = j;
  }

  return items;
});

// 监听连接状态
watch(
  () => wsStore.connected,
  (connected) => {
    console.log(`🔌 WebSocket 连接状态: ${connected}`);
  }
);

/** 解析消息发送者的头像 URL，兼容旧数据中缺失 agent_id 的情况 */
function resolveAvatar(msg: ChatMessage): string | null {
  // 有 agent_id：优先使用 agent store 中的头像，否则使用默认 API 路径
  if (msg.agent_id) {
    return agentStore.getAgentAvatar(msg.agent_id)
      || `/api/agents/${encodeURIComponent(msg.agent_id)}/avatar`;
  }
  // 旧数据兼容：无 agent_id 时，回退到当前活跃 Agent 的头像
  if (agentStore.activeAgentId) {
    return agentStore.getAgentAvatar(agentStore.activeAgentId)
      || `/api/agents/${encodeURIComponent(agentStore.activeAgentId)}/avatar`;
  }
  return null;
}

/** 解析消息发送者的显示名称，兼容旧数据中缺失 agent_id 的情况 */
function resolveSenderName(msg: ChatMessage): string | undefined {
  if (msg.agent_id) {
    // 始终返回 Agent 名称，确保头像 fallback 有正确的首字母
    // 注意：活跃 Agent 自己的消息也会显示 senderName，避免 fallback 显示 "?"
    return agentStore.getAgentName(msg.agent_id) || msg.agent_id;
  }
  // 旧数据兼容：无 agent_id 时，user 角色显示"我"，assistant 角色不额外显示名称
  if (msg.role === 'user') return '我';
  return undefined;
}

onMounted(() => {
  nextTick(() => {
    scrollToBottom();
  });
});
</script>

<template>
  <div v-if="agentStore.activeAgentId" class="chat-view">
    <div class="chat-header">
      <!-- 汉堡菜单按钮（移动端可见） -->
      <button class="hamburger-btn" @click="toggleSidebar" title="菜单">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <div class="header-info">
        <span class="agent-label">
          {{ agentStore.activeAgentId ? activeAgentName : '选择一个 Agent 开始对话' }}
        </span>
      </div>
      <div class="header-actions">
      <!-- 归档当前会话按钮 -->
      <button
        v-if="agentStore.activeAgentId"
        class="new-session-btn"
        @click="handleNewSession"
        :disabled="chatStore.turnInProgress"
        title="归档当前会话"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" />
        </svg>
        <span class="new-session-label">归档当前会话</span>
      </button>
      <!-- Agent 配置按钮 -->
      <button
        v-if="agentStore.activeAgentId"
        class="settings-btn"
        @click="settingsAgentId = agentStore.activeAgentId; agentSettingsVisible = true"
        title="Agent 配置"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <!-- 更多操作菜单 -->
      <div v-if="agentStore.activeAgentId" class="more-menu-wrapper">
        <button class="settings-btn" @click.stop="toggleMoreMenu" title="更多操作">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
          </svg>
        </button>
        <Transition name="dropdown">
          <div v-if="showMoreMenu" class="more-dropdown" @click.stop>
            <button class="dropdown-item danger" @click="showMoreMenu = false; deleteTarget = { id: agentStore.activeAgentId, name: activeAgentName }">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              删除 Agent
            </button>
          </div>
        </Transition>
      </div>
      </div>

    </div>

    <div v-if="!wsStore.connected" class="connection-status">
      <span>[WARN] 连接已断开，正在重连...</span>
    </div>

    <div class="messages-wrapper">
      <div ref="messagesContainer" class="messages-container" @scroll="onScroll">
        <div class="messages-content">
          <!-- 加载更多历史消息指示器 -->
          <div v-if="isLoadingMore || chatStore.loadingHistory" class="history-loading">
            <span class="history-spinner"></span>
            <span class="history-loading-text">加载历史消息中…</span>
          </div>

          <template v-for="item in displayItems" :key="item.type === 'thinking-tool-group' ? `group-${item.index}` : item.message!.id">
            <ThinkingToolGroup
              v-if="item.type === 'thinking-tool-group'"
              :messages="item.groupMessages!"
              :start-index="item.index"
              :is-streaming="item.isStreaming"
              :sender-avatar="resolveAvatar(item.groupMessages![0])"
            />
            <Message
              v-else
              :message="item.message!"
              :index="item.index"
              :is-streaming="item.isStreaming"
              :active-agent="agentStore.activeAgentId"
              :sender-avatar="resolveAvatar(item.message!)"
              :sender-name="resolveSenderName(item.message!)"
            />
          </template>
        </div>
      </div>

      <!-- 回到底部按钮（贴附在 messages 区域右下角，不随滚动） -->
      <Transition name="scroll-btn">
        <button
          v-if="isUserScrolledUp"
          class="scroll-to-bottom-btn"
          @click="scrollToBottomAndReset"
          title="回到底部"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </Transition>
    </div>

    <ChatInput />

    <!-- 删除确认对话框 -->
    <Transition name="modal">
      <div v-if="deleteTarget" class="dialog-overlay" @mousedown.self="deleteTarget = null">
        <div class="delete-dialog" @click.stop>
          <div class="delete-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h4>永久删除 Agent</h4>
          <p class="delete-warning">
            你确定要永久删除 <strong>{{ deleteTarget.name }}</strong> 吗？
          </p>
          <p class="delete-detail">
            此操作将删除该 Agent 的所有配置、会话历史和凭据，<br/>
            <span class="delete-emphasis">不可恢复，不可撤销。</span>
          </p>
          <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
          <div class="dialog-actions">
            <button class="btn-cancel" @click="deleteTarget = null" :disabled="deleting">取消</button>
            <button class="btn-delete" @click="confirmDelete" :disabled="deleting">
              {{ deleting ? '删除中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
  <div v-else class="chat-view" />
</template>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-primary);
}


.scroll-to-bottom-btn {
  position: absolute;
  right: 24px;
  bottom: 16px;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid var(--color-border-primary, #e0e0e0);
  background: var(--color-bg-primary, #fff);
  color: var(--color-text-secondary, #666);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  z-index: 50;
  transition: box-shadow 0.2s, transform 0.2s, background 0.2s;
}

.scroll-to-bottom-btn:hover {
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  transform: translateY(-1px);
  background: var(--color-bg-secondary, #f5f5f5);
}

.scroll-to-bottom-btn:active {
  transform: translateY(0);
}

/* 按钮出现/消失动画 */
.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.chat-header {
  height: var(--layout-header-height);
  padding: 0 var(--space-md);
  background: var(--color-bg-primary);
  border-bottom: 1px solid var(--color-border-secondary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
  backdrop-filter: blur(8px);
  z-index: 100;
  gap: var(--space-sm);
}

/* 汉堡菜单按钮：默认隐藏 */
.hamburger-btn {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 6px;
  border-radius: var(--radius-sm);
  line-height: 0;
  flex-shrink: 0;
}

.hamburger-btn:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

.settings-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 6px;
  border-radius: var(--radius-sm);
  line-height: 0;
  flex-shrink: 0;
}

.settings-btn:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

/* 右侧操作区（新会话 + 配置 + 更多） */
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 新会话按钮 */
.new-session-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.new-session-btn:hover:not(:disabled) {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  border-color: var(--color-border-primary);
}

.new-session-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.new-session-label {
  white-space: nowrap;
}

/* 更多操作菜单 */
.more-menu-wrapper { position: relative; }
.more-dropdown {
  position: absolute; right: 0; top: 100%; margin-top: 4px;
  background: var(--color-bg-primary, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);
  min-width: 140px; z-index: 300; padding: 4px; overflow: hidden;
}
.dropdown-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 12px; border: none; border-radius: 5px;
  background: none; color: var(--color-text-primary, #2c3e50);
  font-size: 13px; cursor: pointer; text-align: left;
}
.dropdown-item:hover { background: var(--color-bg-secondary, #f5f5f5); }
.dropdown-item.danger { color: #e74c3c; }
.dropdown-item.danger:hover { background: #fde8e8; }
.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }

.agent-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.connection-status {
  text-align: center;
  padding: 6px;
  font-size: 12px;
  color: var(--color-warning);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.messages-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.messages-container {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-md);
}

.messages-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  width: 100%;
  margin: 0 auto;
  min-height: 100%;
}

.messages-container::-webkit-scrollbar {
  width: 6px;
}

.messages-container::-webkit-scrollbar-track {
  background: transparent;
}

.messages-container::-webkit-scrollbar-thumb {
  background: var(--color-border-primary);
  border-radius: 3px;
}

.messages-container::-webkit-scrollbar-thumb:hover {
  background: var(--color-primary);
}

/* ===== 历史消息加载指示器 ===== */
.history-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 0;
  color: var(--color-text-muted);
  font-size: 13px;
}

.history-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border-primary);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: history-spin 0.6s linear infinite;
}

@keyframes history-spin {
  to { transform: rotate(360deg); }
}

.history-loading-text {
  user-select: none;
}

/* ===== 响应式：窄屏 (≤768px) ===== */
@media (max-width: 768px) {
  .hamburger-btn {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .messages-container {
    padding: var(--space-sm);
  }

  .messages-content {
    width: 100%;
  }

  .scroll-to-bottom-btn {
    right: 12px;
    bottom: 12px;
  }
}

/* 删除确认对话框（全局样式，非 scoped 以便覆盖） */
</style>

<style>
.dialog-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center; z-index: 600;
}
.delete-dialog {
  background: var(--color-bg-primary, #fff);
  border-radius: 12px; padding: 24px 28px;
  width: 360px; max-width: 90vw; text-align: center;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}
.delete-icon { margin-bottom: 8px; }
.delete-dialog h4 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.delete-warning { font-size: 14px; color: var(--color-text-primary, #2c3e50); margin: 8px 0 4px; }
.delete-warning strong { color: #e74c3c; }
.delete-detail { font-size: 12px; color: var(--color-text-secondary, #7f8c8d); margin: 0 0 12px; line-height: 1.5; }
.delete-emphasis { color: #e74c3c; font-weight: 600; }
.delete-error { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.btn-cancel { padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; background: var(--color-bg-primary, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-delete { padding: 6px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; background: #e74c3c; border: none; color: #fff; font-weight: 600; }
.btn-delete:hover:not(:disabled) { background: #c0392b; }
.btn-delete:disabled, .btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
