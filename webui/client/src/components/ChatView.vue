<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, inject } from 'vue';
import { useChatStore } from '../stores/chat';
import Message from './chat/Message/Message.vue';
import ThinkingToolGroup from './chat/Message/ThinkingToolGroup.vue';
import ChatInput from './ChatInput.vue';
import PluginSettings from './PluginSettings.vue';
import type { ChatMessage } from '../types';

const store = useChatStore();
const messagesContainer = ref<HTMLElement>();

/** 注入父组件提供的切换侧边栏方法 */
const toggleSidebar = inject<() => void>('toggleSidebar', () => {});

/** 插件设置面板可见性 */
const pluginSettingsVisible = ref(false);

/** 用户是否手动向上滚动（离开底部时暂停自动滚动） */
const isUserScrolledUp = ref(false);

/** 是否正在加载更多历史消息（滚动到顶部触发） */
const isLoadingMore = ref(false);

/** 滚动到顶部阈值（px） */
const SCROLL_TOP_THRESHOLD = 50;

/** 当前选中 Agent 的显示名称 */
const activeAgentName = computed(() => {
  if (!store.activeAgent) return '';
  const agent = store.agents.find(a => a.id === store.activeAgent);
  return agent?.name || store.activeAgent;
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

  // 检测是否滚动到顶部，触发加载更多历史消息
  if (messagesContainer.value) {
    const { scrollTop } = messagesContainer.value;
    if (scrollTop <= SCROLL_TOP_THRESHOLD && store.hasMoreHistory && !store.loadingHistory) {
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

  store.loadMoreHistory();

  // 等待 loadingHistory 变为 false（即历史消息已加载并渲染）
  await waitForHistoryLoaded();
  await nextTick();

  // 恢复滚动位置：新 scrollHeight 减去旧 scrollHeight = 新增内容高度
  container.scrollTop = container.scrollHeight - prevScrollHeight;
  isLoadingMore.value = false;
}

/** 等待历史加载完成（loadingHistory 从 true 变 false） */
function waitForHistoryLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (!store.loadingHistory) {
      resolve();
      return;
    }
    const stop = watch(() => store.loadingHistory, (val) => {
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
  const msgs = store.messages;
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
  () => [store.messages.length, lastStreamingContent.value] as const,
  async () => {
    await nextTick();
    if (!isUserScrolledUp.value) {
      scrollToBottom();
    }
  }
);

// ── 消息分组显示：合并连续的 thinking + tool 为 ThinkingToolGroup ──
interface DisplayItem {
  type: 'message' | 'thinking-tool-group';
  message?: ChatMessage;
  groupMessages?: ChatMessage[];
  index: number;
  isStreaming?: boolean;
}

const isStreaming = computed(() => {
  return store.messages.some(m => m.isStreaming && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'));
});

function hasThinking(msg: ChatMessage): boolean {
  const reasoning = msg.reasoning_content || msg.thinking || '';
  return msg.role === 'assistant' && reasoning.trim().length > 0;
}

const displayItems = computed<DisplayItem[]>(() => {
  // 直接用 store.messages（而非 currentMessages），确保 label 等属性变更也能触发重算
  const raw = store.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
  );
  const items: DisplayItem[] = [];
  const streaming = isStreaming.value;

  let i = 0;
  while (i < raw.length) {
    const msg = raw[i];
    void msg.label; // 追踪 label 变更以触发响应式

    if (hasThinking(msg)) {
      const groupStart = i;
      const groupMsgs: ChatMessage[] = [raw[i]];
      let j = i + 1;

      while (j < raw.length && raw[j].role === 'tool') {
        groupMsgs.push(raw[j]);
        j++;
      }

      if (groupMsgs.length >= 2) {
        // 合并后续的思考+工具轮次
        while (j < raw.length && hasThinking(raw[j])) {
          let k = j + 1;
          while (k < raw.length && raw[k].role === 'tool') k++;
          if (k === j + 1) {
            // 该 assistant 后没有工具 → 这是最终回复
            // 思考部分并入思维链，正文部分独立渲染
            groupMsgs.push(raw[j]);
            j++;
            break;
          }
          // 纳入这轮思考+工具
          groupMsgs.push(raw[j]);
          j++;
          while (j < raw.length && raw[j].role === 'tool') {
            groupMsgs.push(raw[j]);
            j++;
          }
        }

        // 组末若是 assistant（最终回复），拆分思考/正文：思考留在链内，正文独立渲染
        const lastInGroup = groupMsgs[groupMsgs.length - 1];
        const hasFinalAnswer = lastInGroup.role === 'assistant';

        if (hasFinalAnswer) {
          // 链内只保留思考（清空正文）
          groupMsgs[groupMsgs.length - 1] = { ...lastInGroup, content: '' };
        }

        const groupIsStreaming = streaming && j >= raw.length;

        items.push({
          type: 'thinking-tool-group',
          groupMessages: groupMsgs,
          index: groupStart,
          isStreaming: groupIsStreaming,
        });

        if (hasFinalAnswer) {
          // 正文独立消息：只带 content，不含思考
          const answerStreaming = streaming && j >= raw.length;
          items.push({
            type: 'message',
            message: { ...lastInGroup, reasoning_content: '', thinking: '' },
            index: j - 1,
            isStreaming: answerStreaming,
          });
        }

        i = j;
        continue;
      }
    }

    items.push({
      type: 'message',
      message: msg,
      index: i,
      isStreaming: streaming && i === raw.length - 1 && msg.role === 'assistant',
    });
    i++;
  }

  return items;
});

// 监听连接状态
watch(
  () => store.connected,
  (connected) => {
    console.log(`🔌 WebSocket 连接状态: ${connected}`);
  }
);

onMounted(() => {
  nextTick(() => {
    scrollToBottom();
  });
});
</script>

<template>
  <div class="chat-view">
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
          {{ store.activeAgent ? activeAgentName : '选择一个 Agent 开始对话' }}
        </span>
      </div>
      <!-- 插件设置按钮 -->
      <button
        v-if="store.activeAgent"
        class="settings-btn"
        @click="pluginSettingsVisible = true"
        title="插件管理"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>

    <div v-if="!store.connected" class="connection-status">
      <span>[WARN] 连接已断开，正在重连...</span>
    </div>

    <div class="messages-wrapper">
      <div ref="messagesContainer" class="messages-container" @scroll="onScroll">
        <div class="messages-content">
          <!-- 加载更多历史消息指示器 -->
          <div v-if="isLoadingMore || store.loadingHistory" class="history-loading">
            <span class="history-spinner"></span>
            <span class="history-loading-text">加载历史消息中…</span>
          </div>

          <div v-if="store.currentMessages.length === 0 && !store.loadingHistory" class="empty-state">
            <div class="empty-icon">
              <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
                <!-- 聊天气泡主体 -->
                <rect x="10" y="12" width="52" height="40" rx="14" stroke="currentColor" stroke-width="2.5" fill="currentColor" fill-opacity="0.06"/>
                <!-- 气泡尾巴 -->
                <path d="M28 52L18 62L30 56Z" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
                <!-- AI 星芒 - 精准居中于气泡矩形 -->
                <path d="M36 22L38 30L46 32L38 34L36 42L34 34L26 32L34 30L36 22Z" fill="currentColor" opacity="0.55"/>
                <!-- 对称装饰小点 -->
                <circle cx="28" cy="44" r="1.8" fill="currentColor" opacity="0.28"/>
                <circle cx="44" cy="44" r="1.8" fill="currentColor" opacity="0.28"/>
              </svg>
            </div>
            <p>选择左侧的 Agent，开始对话</p>
          </div>
          <template v-for="item in displayItems" :key="item.type === 'thinking-tool-group' ? `group-${item.index}` : item.message!.id">
            <ThinkingToolGroup
              v-if="item.type === 'thinking-tool-group'"
              :messages="item.groupMessages!"
              :start-index="item.index"
              :is-streaming="item.isStreaming"
            />
            <Message
              v-else
              :message="item.message!"
              :index="item.index"
              :is-streaming="item.isStreaming"
              :active-agent="store.activeAgent"
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

    <!-- 插件设置面板 -->
    <PluginSettings
      :agent-id="store.activeAgent"
      :visible="pluginSettingsVisible"
      @close="pluginSettingsVisible = false"
      @saved="pluginSettingsVisible = false"
    />
  </div>
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

/* 插件设置按钮 */
.settings-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 6px;
  border-radius: var(--radius-sm);
  line-height: 0;
  flex-shrink: 0;
  margin-left: auto;
}

.settings-btn:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

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
  gap: 4px;
  max-width: var(--layout-content-max-width);
  width: 100%;
  margin: 0 auto;
  min-height: 100%;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  gap: var(--space-md);
}

.empty-icon {
  opacity: 0.5;
  margin-bottom: var(--space-sm);
}

.empty-state p {
  font-size: 15px;
  color: var(--color-text-secondary);
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
    max-width: 100%;
  }

  .scroll-to-bottom-btn {
    right: 12px;
    bottom: 12px;
  }
}
</style>
