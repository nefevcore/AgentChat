<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, inject, type Ref } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import { useWebSocketStore } from '../stores/websocket';
import TurnDisplayItem from './chat/Message/TurnDisplayItem.vue';
import FilePreviewModal from './chat/FilePreviewModal.vue';
import ChatInput from './ChatInput.vue';
import type { Turn, DisplayItem } from '../types';

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

/** System Prompt 预览弹窗 */
const showSystemPrompt = ref(false);

/** 工具定义预览弹窗 */
const showToolDefs = ref(false);

/** 将工具定义格式化为 LLM 常用的 XML 格式 */
const toolDefsXml = computed(() => {
  const defs = chatStore.toolDefs;
  if (!defs.length) return '';
  const lines: string[] = ['<functions>'];
  for (const def of defs) {
    const fn = def.function;
    lines.push(`  <function>`);
    lines.push(`    <name>${escapeXml(fn.name)}</name>`);
    lines.push(`    <description>${escapeXml(fn.description)}</description>`);
    lines.push(`    <parameters>${JSON.stringify(fn.parameters, null, 6)}</parameters>`);
    lines.push(`  </function>`);
  }
  lines.push('</functions>');
  return lines.join('\n');
});

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyText(text: string) {
  // 优先使用 Clipboard API，失败时回退到 execCommand
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      chatStore.copyFeedback = true;
      setTimeout(() => { chatStore.copyFeedback = false; }, 2000);
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    chatStore.copyFeedback = true;
    setTimeout(() => { chatStore.copyFeedback = false; }, 2000);
  } catch {
    // 复制失败，静默处理
  }
  document.body.removeChild(textarea);
}

/** 文件预览 */
const previewVisible = ref(false);
const previewFilePath = ref('');

function handlePreviewFile(filePath: string) {
    previewFilePath.value = filePath;
    previewVisible.value = true;
}

function closePreview() {
    previewVisible.value = false;
    previewFilePath.value = '';
}

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
    if (m.role === 'agent' && m.isStreaming) {
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

// ── turns 直接平铺渲染（含时间分隔符）──
const turnDisplayItems = computed<DisplayItem[]>(() => {
  const turnList = chatStore.turns;
  if (turnList.length === 0) return [];

  const items: DisplayItem[] = turnList.map((t, i) => ({ type: 'turn' as const, turn: t, index: i }));
  return insertTimeSeparators(items);
});


/** 两条消息之间插入时间分隔符的最小间隔（毫秒），默认 5 分钟 */
const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

function getItemTimestamp(item: DisplayItem): number {
  if (item.turn?.steps[0]) return item.turn.steps[0].assistant.timestamp;
  if (item.turn?.final) return item.turn.final.timestamp;
  return 0;
}

function insertTimeSeparators(items: DisplayItem[]): DisplayItem[] {
  if (items.length <= 1) return items;
  const out: DisplayItem[] = [];
  for (let k = 0; k < items.length; k++) {
    if (k > 0) {
      const prevTs = getItemTimestamp(items[k - 1]);
      const currTs = getItemTimestamp(items[k]);
      if (prevTs > 0 && currTs > 0 && (currTs - prevTs) >= TIME_SEPARATOR_GAP_MS) {
        const d = new Date(currTs);
        out.push({ type: 'time-separator', index: -1, timeText: `[${d.toLocaleString()}]` });
      }
    }
    out.push(items[k]);
  }
  return out;
}

// 监听连接状态
watch(
  () => wsStore.connected,
  (connected) => {
    console.log(`🔌 WebSocket 连接状态: ${connected}`);
  }
);


onMounted(() => {
  nextTick(() => {
    scrollToBottom();
    tryAutoLoadMore();
  });
});

/** 首屏加载后自动续拉：内容高度 < 视口高度且有更多历史 → 触发加载 */
function tryAutoLoadMore() {
  if (!chatStore.hasMoreHistory || !messagesContainer.value || isLoadingMore.value) return;
  const h = messagesContainer.value;
  if (h.scrollHeight <= h.clientHeight) triggerLoadMore();
}

// 每次历史加载完成后也检查一次
watch(() => chatStore.loadingHistory, (loading, wasLoading) => {
  if (!loading && wasLoading && chatStore.hasMoreHistory) {
    nextTick(() => tryAutoLoadMore());
  }
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
      <!-- System Prompt 预览按钮 -->
      <button
        v-if="agentStore.activeAgentId"
        class="settings-btn"
        @click="chatStore.requestSystemPrompt(); showSystemPrompt = true"
        :disabled="chatStore.systemPromptLoading"
        title="预览 System Prompt"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
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
            <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
          </svg>
        </button>
        <Transition name="dropdown">
          <div v-if="showMoreMenu" class="more-dropdown" @click.stop>
            <button class="dropdown-item" @click="showMoreMenu = false; chatStore.requestToolDefs(); showToolDefs = true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              工具定义预览
            </button>
            <button
              class="dropdown-item"
              :disabled="chatStore.turnInProgress"
              @click="showMoreMenu = false; handleNewSession()"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" />
              </svg>
              归档当前会话
            </button>
            <div class="dropdown-divider"></div>
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

          <template v-for="(item, idx) in turnDisplayItems" :key="item.type === 'time-separator' ? `time-${idx}` : `turn-${item.index}`">
            <div v-if="item.type === 'time-separator'" class="time-separator">
              <span class="time-separator-text">{{ item.timeText }}</span>
            </div>
            <TurnDisplayItem
              v-else
              :turn="item.turn!"
              :index="item.index"
              @regenerate="chatStore.regenerateMessage"
              @delete-message="chatStore.deleteMessage"
              @edit="(msgId: any, newContent: any) => chatStore.editMessage(msgId, newContent)"
              @continue-generation="chatStore.continueGeneration()"
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

    <!-- System Prompt 预览弹窗 -->
    <Transition name="modal">
      <div v-if="showSystemPrompt" class="dialog-overlay" @mousedown.self="showSystemPrompt = false; chatStore.clearSystemPrompt()">
        <div class="system-prompt-dialog" @click.stop>
          <div class="sp-header">
            <h4>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              System Prompt · {{ activeAgentName }}
            </h4>
            <button class="close-btn" @click="showSystemPrompt = false; chatStore.clearSystemPrompt()" title="关闭">×</button>
          </div>
          <div class="sp-body">
            <!-- 加载中 -->
            <div v-if="chatStore.systemPromptLoading" class="sp-loading">
              <span class="history-spinner"></span>
              <span>正在组装 System Prompt…</span>
            </div>
            <!-- 错误 -->
            <div v-else-if="chatStore.systemPromptError" class="sp-error">
              {{ chatStore.systemPromptError }}
            </div>
            <!-- 内容 -->
            <pre v-else class="sp-content">{{ chatStore.systemPromptContent }}</pre>
          </div>
          <div class="sp-footer">
            <span class="sp-info">共 {{ chatStore.systemPromptContent.length }} 字符</span>
            <div class="sp-actions">
              <button class="btn-refresh" @click="chatStore.requestSystemPrompt()" :disabled="chatStore.systemPromptLoading" title="刷新">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                刷新
              </button>
              <button class="btn-copy" @click="copyText(chatStore.systemPromptContent)" :disabled="chatStore.copyFeedback" title="复制到剪贴板">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {{ chatStore.copyFeedback ? '已复制 ✓' : '复制' }}
              </button>
              <button class="btn-cancel" @click="showSystemPrompt = false; chatStore.clearSystemPrompt()">关闭</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 工具定义预览弹窗 -->
    <Transition name="modal">
      <div v-if="showToolDefs" class="dialog-overlay" @mousedown.self="showToolDefs = false; chatStore.clearToolDefs()">
        <div class="system-prompt-dialog" @click.stop>
          <div class="sp-header">
            <h4>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              工具定义 · {{ activeAgentName }}
            </h4>
            <button class="close-btn" @click="showToolDefs = false; chatStore.clearToolDefs()" title="关闭">×</button>
          </div>
          <div class="sp-body">
            <div v-if="chatStore.toolDefsLoading" class="sp-loading">
              <span class="history-spinner"></span>
              <span>正在获取工具定义…</span>
            </div>
            <div v-else-if="chatStore.toolDefsError" class="sp-error">
              {{ chatStore.toolDefsError }}
            </div>
            <div v-else-if="!chatStore.toolDefs.length" class="sp-loading">
              该 Agent 没有注册任何工具
            </div>
            <pre v-else class="sp-content">{{ toolDefsXml }}</pre>
          </div>
          <div class="sp-footer">
            <span class="sp-info">{{ chatStore.toolDefs.length }} 个工具</span>
            <div class="sp-actions">
              <button class="btn-refresh" @click="chatStore.requestToolDefs()" :disabled="chatStore.toolDefsLoading" title="刷新">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                刷新
              </button>
              <button class="btn-copy" @click="copyText(toolDefsXml)" :disabled="chatStore.copyFeedback" title="复制到剪贴板">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {{ chatStore.copyFeedback ? '已复制 ✓' : '复制' }}
              </button>
              <button class="btn-cancel" @click="showToolDefs = false; chatStore.clearToolDefs()">关闭</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
  <div v-else class="chat-view" />

  <!-- 文件预览弹窗 -->
  <FilePreviewModal
    :visible="previewVisible"
    :file-path="previewFilePath"
    @close="closePreview"
  />
</template>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-page);
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
  background: var(--color-bg-page, #fff);
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
  background: var(--color-bg-surface, #f5f5f5);
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
  background: var(--color-bg-page);
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
  background: var(--color-bg-surface);
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
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
}

.settings-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 右侧操作区（预览 + 配置 + 更多） */
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 更多操作菜单 */
.more-menu-wrapper { position: relative; }
.more-dropdown {
  position: absolute; right: 0; top: 100%; margin-top: 4px;
  background: var(--color-bg-page, #fff);
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
.dropdown-item:hover { background: var(--color-bg-surface, #f5f5f5); }
.dropdown-item:disabled { opacity: 0.4; cursor: not-allowed; }
.dropdown-item.danger { color: #e74c3c; }
.dropdown-item.danger:hover { background: #fde8e8; }
.dropdown-divider {
  height: 1px; background: var(--color-border-secondary, #e0e0e0);
  margin: 4px 8px;
}
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
  background: var(--color-bg-surface);
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

/* ===== 时间分隔符 ===== */
.time-separator {
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.time-separator-text {
  font-size: 12px;
  color: var(--color-text-muted, #999);
  padding: 2px 12px;
  letter-spacing: 0.5px;
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
  background: var(--color-bg-page, #fff);
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
.btn-cancel { padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.close-btn {
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  border: none; background: none; font-size: 20px; color: var(--color-text-secondary, #7f8c8d);
  cursor: pointer; border-radius: 6px; line-height: 1; flex-shrink: 0;
}
.close-btn:hover { background: var(--color-bg-surface, #f0f0f0); color: var(--color-text-primary, #2c3e50); }
.btn-delete { padding: 6px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; background: #e74c3c; border: none; color: #fff; font-weight: 600; }
.btn-delete:hover:not(:disabled) { background: #c0392b; }
.btn-delete:disabled, .btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

/* ===== System Prompt 预览弹窗 ===== */
.system-prompt-dialog {
  background: var(--color-bg-page, #fff);
  border-radius: 12px;
  width: 700px;
  max-width: 92vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}
.sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.sp-header h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary, #2c3e50);
}
.sp-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 200px;
}
.sp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--color-text-muted);
  font-size: 13px;
}
.sp-error {
  color: #e74c3c;
  padding: 20px;
  text-align: center;
  font-size: 13px;
}
.sp-content {
  margin: 0;
  padding: 12px 16px;
  background: var(--color-bg-surface, #f8f9fa);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text-primary, #2c3e50);
  max-height: 55vh;
  overflow-y: auto;
  user-select: text;
  -webkit-user-select: text;
}
.sp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.sp-info {
  font-size: 12px;
  color: var(--color-text-muted);
}
.sp-actions {
  display: flex;
  gap: 8px;
}
.btn-refresh {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #ddd);
  color: var(--color-text-secondary, #7f8c8d);
}
.btn-refresh:hover:not(:disabled) {
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
}
.btn-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  background: var(--color-primary, #4a90d9);
  border: none;
  color: #fff;
  transition: background 0.2s;
}
.btn-copy:hover:not(:disabled) {
  opacity: 0.9;
}
.btn-copy:disabled {
  opacity: 0.7;
  cursor: default;
  background: #27ae60;
}
</style>
