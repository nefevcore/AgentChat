<!-- ConversationView.vue —— 统一会话视图
     单 Agent 会话与群聊收敛为同一渲染管线：
     - 数据源：chatStore（按 conversationKey 归一化）
     - 渲染：turns → TurnDisplayItem（消息视图插槽分发）
     - 滚动/分页/时间分隔符：唯一实现
     - 输入：ChatInput（onSend 按会话类型路由） -->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useAgentStore, VIEWER_ID } from '@/stores/agents';
import { useGroupStore } from '@/stores/groups';
import { useUiStore } from '@/stores/ui';
import TurnDisplayItem from './messages/TurnDisplayItem.vue';
import ChatInput from './ChatInput.vue';
import type { DisplayItem } from '@/view-model/display';
import { insertTimeSeparators } from '@/view-model/display';
import { agentApi } from '@/services/api';
import { formatRelativeTime } from '@/domain/format';

const chatStore = useChatStore();
const agentStore = useAgentStore();
const groupStore = useGroupStore();
const ui = useUiStore();

const messagesContainer = ref<HTMLElement>();
const isUserScrolledUp = ref(false);
const isLoadingMore = ref(false);
const SCROLL_TOP_THRESHOLD = 50;

// ── 头部信息 ──
const activeTitle = computed(() => {
  const ref = chatStore.activeRef;
  if (!ref) return '';
  if (ref.kind === 'agent') return agentStore.getAgentName(ref.id);
  return groupStore.groups.find(g => g.group_id === ref.id)?.name || ref.id;
});
const activeSubtitle = computed(() => {
  const ref = chatStore.activeRef;
  if (!ref) return '';
  if (ref.kind === 'group') {
    const g = groupStore.groups.find(x => x.group_id === ref.id);
    return g ? `${g.participants.length} 个参与者` : '';
  }
  return '';
});
const isGroup = computed(() => chatStore.activeRef?.kind === 'group');

// ── 渲染数据（统一：turns + 时间分隔符）──
const displayItems = computed<DisplayItem[]>(() => {
  const items: DisplayItem[] = chatStore.turns.map((t, i) => ({ type: 'turn' as const, turn: t, index: i }));
  return insertTimeSeparators(items);
});

// ── Token 占用预测 ──
interface SessionTokens {
  tokenCount: number; messageCount: number; maxContextTokens: number;
  usagePercent: number; avgTokensPerMsg: number; estimatedMsgsRemaining: number;
  status: 'low' | 'moderate' | 'high' | 'critical';
}
const sessionTokens = ref<SessionTokens | null>(null);

async function fetchTokenBaseline(clearFirst = false) {
  const ref = chatStore.activeRef;
  if (!ref || ref.kind !== 'agent') { sessionTokens.value = null; return; }
  if (clearFirst) sessionTokens.value = null;
  try {
    const data = await agentApi.tokens(ref.id);
    sessionTokens.value = {
      tokenCount: data.tokenCount ?? 0,
      messageCount: data.messageCount ?? 0,
      maxContextTokens: data.maxContextTokens ?? 1_000_000,
      usagePercent: data.usagePercent ?? 0,
      avgTokensPerMsg: data.avgTokensPerMsg ?? 0,
      estimatedMsgsRemaining: data.estimatedMsgsRemaining ?? 0,
      status: data.status ?? 'low',
    };
  } catch { /* 保留旧值 */ }
}

watch(() => chatStore.activeKey, () => { fetchTokenBaseline(true); }, { immediate: true });
watch(() => chatStore.lastRunEndAt, () => fetchTokenBaseline());
watch(() => chatStore.conversations[chatStore.activeKey]?.hasMoreHistory, (v) => { if (!v) fetchTokenBaseline(); });

// ── 滚动 ──
function isNearBottom(): boolean {
  const el = messagesContainer.value;
  if (!el) return true;
  const { scrollTop, scrollHeight, clientHeight } = el;
  return scrollHeight - scrollTop - clientHeight < 80;
}
function scrollToBottom() {
  const el = messagesContainer.value;
  if (!el) return;
  requestAnimationFrame(() => {
    if (!messagesContainer.value) return;
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    requestAnimationFrame(() => {
      if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    });
  });
}
function scrollToBottomAndReset() { scrollToBottom(); isUserScrolledUp.value = false; }

let lastScrollTop = 0;
function onScroll() {
  const el = messagesContainer.value;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const atBottom = scrollHeight - scrollTop - clientHeight < 80;
  if (scrollTop < lastScrollTop - 1) isUserScrolledUp.value = true;
  else if (atBottom) isUserScrolledUp.value = false;
  lastScrollTop = scrollTop;

  const conv = chatStore.conversations[chatStore.activeKey];
  if (conv && scrollTop <= SCROLL_TOP_THRESHOLD && conv.hasMoreHistory && !conv.loadingHistory) {
    triggerLoadMore();
  }
}

async function triggerLoadMore() {
  const conv = chatStore.conversations[chatStore.activeKey];
  const el = messagesContainer.value;
  if (!el || isLoadingMore.value || !conv || !conv.hasMoreHistory) return;
  isLoadingMore.value = true;
  const prevScrollTop = el.scrollTop;
  const prevScrollHeight = el.scrollHeight;

  if (conv.kind === 'agent') chatStore.loadMoreHistory();
  else await chatStore.loadOlderGroupHistory();

  await waitForLoaded();
  await nextTick();
  const addedHeight = el.scrollHeight - prevScrollHeight;
  el.scrollTop = prevScrollTop + addedHeight;
  isLoadingMore.value = false;

  if (conv.hasMoreHistory && el.scrollHeight <= el.clientHeight) {
    await nextTick();
    void triggerLoadMore();
  }
}

function waitForLoaded(): Promise<void> {
  const conv = chatStore.conversations[chatStore.activeKey];
  return new Promise((resolve) => {
    if (!conv || !conv.loadingHistory) { resolve(); return; }
    const stop = watch(() => chatStore.conversations[chatStore.activeKey]?.loadingHistory, (v) => {
      if (!v) { stop(); resolve(); }
    });
  });
}

// 流式内容变化 → 自动滚动
const lastStreamingContent = computed(() => {
  const msgs = chatStore.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'agent' && m.isStreaming) return m.content + (m.reasoning_content ?? '') + (m.thinking ?? '');
  }
  return '';
});
watch(lastStreamingContent, () => {
  if (!isUserScrolledUp.value) nextTick(() => scrollToBottom());
});
watch(() => chatStore.turns.length, () => {
  if (!isUserScrolledUp.value) nextTick(() => scrollToBottom());
});

// ── 消息动作（转发到 chat store）──
function onRegenerate(msgId: string) { chatStore.regenerateMessage(msgId); }
function onDelete(msgId: string) { chatStore.deleteMessage(msgId); }
function onEdit(msgId: string, content: string) { chatStore.editMessage(msgId, content); }
function onContinue() { chatStore.continueGeneration(); }

// ── 会话操作 ──
function handleCompress() {
  const conv = chatStore.conversations[chatStore.activeKey];
  if (!conv || conv.turnInProgress || chatStore.compressPending) return;
  chatStore.compressSession();
}

// ── 更多菜单 ──
const showMoreMenu = ref(false);
function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
  if (showMoreMenu.value) setTimeout(() => document.addEventListener('click', closeMoreMenu, { once: true }), 0);
}
function closeMoreMenu() { showMoreMenu.value = false; }

// ── 发送 ──
function onSend(text: string) {
  if (isGroup.value) chatStore.sendGroupMessage(text);
  else chatStore.sendMessage(text);
}

const turnInProgress = computed(() => chatStore.conversations[chatStore.activeKey]?.turnInProgress ?? false);
const isStreaming = computed(() => {
  const conv = chatStore.conversations[chatStore.activeKey];
  return conv?.messages.some(m => m.isStreaming) ?? false;
});

const emptyTitle = computed(() => isGroup.value ? '群聊开始 — 发送第一条消息吧' : '选择一个 Agent 开始对话');
</script>

<template>
  <div class="conversation-view">
    <!-- 头部 -->
    <div v-if="chatStore.activeRef" class="chat-header">
      <div class="header-info">
        <span class="title">{{ activeTitle }}</span>
        <span v-if="activeSubtitle" class="subtitle">{{ activeSubtitle }}</span>
      </div>
      <div v-if="sessionTokens" class="token-gauge" :class="sessionTokens.status" :title="`Token 占用 ${sessionTokens.usagePercent}%`">
        {{ Math.round(sessionTokens.usagePercent) }}%
      </div>
      <div class="header-actions">
        <button v-if="!isGroup" class="icon-btn" title="归档整理记忆" @click="handleCompress">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>
        </button>
        <button class="icon-btn" title="更多" @click="toggleMoreMenu">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
        </button>
        <div v-if="showMoreMenu" class="more-menu">
          <button v-if="!isGroup" @click="chatStore.requestSystemPrompt()">查看 System Prompt</button>
          <button v-if="!isGroup" @click="chatStore.requestToolDefs()">查看工具定义</button>
        </div>
      </div>
    </div>

    <!-- 消息区 -->
    <div class="chat-body">
      <div ref="messagesContainer" class="messages-container" @scroll="onScroll">
        <div class="messages-content">
          <div v-if="!chatStore.activeRef" class="empty-state">
            <p>{{ emptyTitle }}</p>
          </div>
          <div v-else-if="displayItems.length === 0 && !turnInProgress" class="empty-state">
            <p>{{ emptyTitle }}</p>
          </div>

          <template v-for="(item, idx) in displayItems" :key="item.type === 'time-separator' ? `t-${idx}` : `turn-${item.index}`">
            <div v-if="item.type === 'time-separator'" class="time-separator">
              <span class="time-separator-text">{{ item.timeText }}</span>
            </div>
            <div v-else-if="item.type === 'trigger'" class="trigger-separator">
              <span class="trigger-separator-text">{{ item.turn?.final?.content }}</span>
            </div>
            <TurnDisplayItem
              v-else
              :turn="item.turn!"
              :index="item.index"
              :show-actions="!isGroup"
              @regenerate="onRegenerate"
              @delete-message="onDelete"
              @edit="onEdit"
              @continue-generation="onContinue"
              @preview-file="ui.openPreview"
            />
          </template>
        </div>
      </div>

      <Transition name="scroll-btn">
        <button v-if="isUserScrolledUp" class="scroll-to-bottom-btn" @click="scrollToBottomAndReset" title="回到底部">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      </Transition>
    </div>

    <!-- 输入 -->
    <ChatInput
      :disabled="turnInProgress"
      :placeholder="isStreaming ? 'Agent 回复中...' : (isGroup ? '输入消息发送到群聊...' : '输入消息...')"
      :on-send="onSend"
    />
  </div>
</template>

<style scoped>
.conversation-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--color-bg-page, #161619);
}
.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  min-height: 50px;
}
.header-info { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.title { font-size: 15px; font-weight: 600; color: var(--color-text-primary); }
.subtitle { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); }
.header-actions { display: flex; align-items: center; gap: 4px; position: relative; }
.icon-btn {
  width: 30px; height: 30px;
  border: none; border-radius: 6px;
  background: transparent; color: var(--color-text-secondary);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.icon-btn:hover { background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); color: var(--color-text-primary); }
.more-menu {
  position: absolute; right: 0; top: 34px;
  background: var(--color-bg-panel, #1e1e22);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 50;
  display: flex; flex-direction: column; min-width: 160px;
}
.more-menu button {
  border: none; background: transparent;
  color: var(--color-text-primary); font-size: 13px;
  padding: 8px 12px; border-radius: 6px; text-align: left; cursor: pointer;
}
.more-menu button:hover { background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); }
.token-gauge {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  font-weight: 600;
}
.token-gauge.low { background: rgba(46, 204, 113, 0.15); color: #2ecc71; }
.token-gauge.moderate { background: rgba(241, 196, 15, 0.15); color: #f1c40f; }
.token-gauge.high { background: rgba(230, 126, 34, 0.15); color: #e67e22; }
.token-gauge.critical { background: rgba(231, 76, 60, 0.15); color: #e74c3c; }

.chat-body { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
.messages-container { flex: 1; overflow-y: auto; }
.messages-content { padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; }
.empty-state {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--color-text-tertiary, #a8abb2);
  font-size: 14px;
}
.time-separator { display: flex; justify-content: center; margin: 4px 0; }
.time-separator-text {
  font-size: 11px; color: var(--color-text-tertiary, #a8abb2);
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.04));
  padding: 2px 10px; border-radius: 10px;
}
.trigger-separator { display: flex; justify-content: center; margin: 4px 0; }
.trigger-separator-text {
  font-size: 12px; color: var(--color-text-tertiary, #a8abb2);
  background: var(--color-bg-panel, #1e1e22);
  border: 1px dashed var(--color-border, rgba(255, 255, 255, 0.15));
  padding: 4px 14px; border-radius: 8px;
}
.scroll-to-bottom-btn {
  position: absolute; right: 20px; bottom: 12px;
  width: 36px; height: 36px; border-radius: 50%;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  background: var(--color-bg-panel, #1e1e22);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.scroll-to-bottom-btn:hover { color: var(--color-text-primary); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.2s; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; }
</style>
