<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, inject, type Ref } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import { useWebSocketStore } from '../stores/websocket';
import TurnDisplayItem from './chat/Message/TurnDisplayItem.vue';
import FilePreviewModal from './chat/FilePreviewModal.vue';
import ChatInput from './ChatInput.vue'
import { Modal, Icon } from '../ui';
import { VIEWER_ID } from '../constants';
import { deleteAgent, fetchSessionTokens } from '../core/api/endpoints/agents';
import type { Turn, DisplayItem } from '../types';
import { formatRelativeTime, insertTimeSeparators } from '../utils/format';

const chatStore = useChatStore();
const agentStore = useAgentStore();
const wsStore = useWebSocketStore();
const messagesContainer = ref<HTMLElement>();

/** 注入父组件提供的切换侧边栏方法 */
const toggleSidebar = inject<() => void>('toggleSidebar', () => {});

/** 消息左右对齐基准（用户消息靠右） */
const settingsAgentId = inject<Ref<string>>('settingsAgentId', ref(VIEWER_ID.value));
/** 打开 Agent 设置（由 App.vue provide，定位到该 Agent） */
const openAgentSettings = inject<(agentId: string) => void>('openAgentSettings', () => {});

/** 更多操作菜单 */
const showMoreMenu = ref(false);
const deleteTarget = ref<{ id: string; name: string } | null>(null);
const deleteError = ref('');
const deleting = ref(false);

/** System Prompt 预览弹窗 */
const showSystemPrompt = ref(false);

/** 工具定义预览弹窗 */
const showToolDefs = ref(false);

// ── 会话 Token 占用预测 ──
// 完全由后端权威数据驱动：GET /api/sessions/:agentId/tokens 统计磁盘 messages.jsonl
//（仅未归档活跃消息，归档后自动反映截断）。前端不再本地估算流式增量
//（复刻算法易漂移、thinking/reasoning 口径不一导致数值不稳定），
// 改为在 会话结束（chat.end，消息已落盘）/ 归档完成 / 切换 Agent 时刷新。
interface SessionTokens { tokenCount: number; messageCount: number; maxContextTokens: number; usagePercent: number; avgTokensPerMsg: number; estimatedMsgsRemaining: number; status: 'low' | 'moderate' | 'high' | 'critical'; }

const sessionTokens = ref<SessionTokens | null>(null);

async function fetchTokenBaseline(clearFirst = false) {
  const agentId = agentStore.activeAgentId;
  if (!agentId) return;
  if (clearFirst) sessionTokens.value = null;
  try {
    const data = await fetchSessionTokens(agentId);
    sessionTokens.value = {
      tokenCount: data.tokenCount ?? 0,
      messageCount: data.messageCount ?? 0,
      maxContextTokens: data.maxContextTokens ?? 1_000_000,
      usagePercent: data.usagePercent ?? 0,
      avgTokensPerMsg: data.avgTokensPerMsg ?? 0,
      estimatedMsgsRemaining: data.estimatedMsgsRemaining ?? 0,
      status: data.status ?? 'low',
    };
  } catch { /* 失败保留旧值，不闪烁 */ }
}
// 切换 Agent 时先清空（避免串显示上一 Agent 数据）；run 结束（落盘后）与归档完成时刷新
watch(() => agentStore.activeAgentId, () => { fetchTokenBaseline(true); }, { immediate: true });
watch(() => chatStore.lastRunEndAt, () => { fetchTokenBaseline(); });
watch(() => chatStore.hasMoreHistory, () => { if (!chatStore.hasMoreHistory) fetchTokenBaseline(); });

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
const previewFallbackAgentId = ref('');

function handlePreviewFile(payload: string | { filePath: string; agentId?: string }) {
  if (typeof payload === 'string') {
    previewFilePath.value = payload;
    previewFallbackAgentId.value = agentStore.activeAgentId || '';
  } else {
    previewFilePath.value = payload.filePath;
    previewFallbackAgentId.value = payload.agentId || agentStore.activeAgentId || '';
  }
  previewVisible.value = true;
}

function closePreview() {
  previewVisible.value = false;
  previewFilePath.value = '';
  previewFallbackAgentId.value = '';
}

function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
  if (showMoreMenu.value) {
    setTimeout(() => document.addEventListener('click', closeMoreMenu, { once: true }), 0);
  }
}
function closeMoreMenu() { showMoreMenu.value = false; }

/** 压缩对话：触发 Agent 整理记忆后裁剪消息 */
async function handleCompress() {
  if (!agentStore.activeAgentId || chatStore.turnInProgress || chatStore.compressPending) return;
  chatStore.compressSession();
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await deleteAgent(deleteTarget.value.id);
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

/** 滚动到底部（双重 rAF 确保浏览器完成布局） */
function scrollToBottom() {
  const el = messagesContainer.value;
  if (!el) return;
  requestAnimationFrame(() => {
    if (!messagesContainer.value) return;
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    lastScrollTop = messagesContainer.value.scrollTop;
    requestAnimationFrame(() => {
      if (!messagesContainer.value) return;
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
      lastScrollTop = messagesContainer.value.scrollTop;
    });
  });
}

/** 用户滚动时：若离开底部则暂停自动滚动，若滚回底部则恢复；滚到顶部则加载更多 */
let lastScrollTop = 0;
function onScroll() {
  const el = messagesContainer.value;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const atBottom = scrollHeight - scrollTop - clientHeight < 80;

  // 滚动方向检测：向上滚动（scrollTop 减小）→ 立即暂停自动跟随。
  // 原实现用“离开底部 80px”判定，用户一次滚轮仍在阈值内 → 流式输出
  // 又 scrollToBottom 拉回底部，需滚多次才能上去。方向检测一次即可脱离。
  if (scrollTop < lastScrollTop - 1) {
    isUserScrolledUp.value = true;
  } else if (atBottom) {
    isUserScrolledUp.value = false;
  }
  lastScrollTop = scrollTop;

  if (scrollTop <= SCROLL_TOP_THRESHOLD && chatStore.hasMoreHistory && !chatStore.loadingHistory) {
    triggerLoadMore();
  }
}

/** 加载更多历史消息并保持滚动位置（新增消息插入顶部，scrollTop 同步下移，视觉不动） */
async function triggerLoadMore() {
  if (!messagesContainer.value || isLoadingMore.value) return;
  isLoadingMore.value = true;

  const container = messagesContainer.value;
  // 加载前：记录距顶部已滚过的距离 + 总高度
  const prevScrollTop = container.scrollTop;
  const prevScrollHeight = container.scrollHeight;

  chatStore.loadMoreHistory();

  await waitForHistoryLoaded();
  await nextTick();

  // 新消息插在顶部上方 → scrollHeight 增大。保持视觉位置不动：
  // 顶部新增内容高度 = 新高度 - 旧高度，把 scrollTop 下移该高度（即距底部距离不变）。
  const addedHeight = container.scrollHeight - prevScrollHeight;
  container.scrollTop = prevScrollTop + addedHeight;
  isLoadingMore.value = false;

  // 内容仍不足一屏且还有更多 → 继续续拉。
  // 避免无滚动条时（内容高度 ≤ 视口高度）用户无法滚动触发加载而卡死；
  // 加载到内容超出一屏（有滚动条）或没有更多历史时停止。
  if (chatStore.hasMoreHistory && container.scrollHeight <= container.clientHeight) {
    await nextTick();
    void triggerLoadMore();
  }
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

// 监听最后一条 assistant 消息的流式内容变化，用于触发自动滚动。
// 只用"长度"做触发信号：避免每个 delta 拼接完整字符串（随内容增长 O(n)）
const streamingTailLen = computed(() => {
  const msgs = chatStore.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'agent' && m.isStreaming) {
      return (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0) + (m.thinking?.length ?? 0);
    }
  }
  return 0;
});

// 自动滚到底部：按帧合并（同一帧多次流式更新只触发一次滚动，避免布局抖动）。
// Vue 的 DOM 更新在微任务中冲刷，早于 rAF，因此 rAF 回调里滚动是安全的。
let scrollScheduled = false;
function scheduleAutoScroll() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    if (!isUserScrolledUp.value) {
      scrollToBottom();
    }
  });
}
watch(
  () => [chatStore.messages.length, streamingTailLen.value] as const,
  () => scheduleAutoScroll()
);

// ── turns 直接平铺渲染（含时间分隔符 + trigger 消息）──
const turnDisplayItems = computed<DisplayItem[]>(() => {
  const turnList = chatStore.turns;
  if (turnList.length === 0) return [];

  const items: DisplayItem[] = [];
  for (let i = 0; i < turnList.length; i++) {
    const t = turnList[i];
    // trigger 消息 → 特殊分隔符
    if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'trigger') {
      const raw = t.final.content;
      const label = (raw.match(/^<trigger>([\s\S]*)<\/trigger>$/)?.[1] ?? raw).trim();
      items.push({ type: 'trigger', index: -1, timeText: label });
      continue;
    }
    // error 消息（如 LLM 调用失败）→ 红色错误分隔符（同 trigger 分隔）
    if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'error') {
      items.push({ type: 'error', index: -1, timeText: t.final.content });
      continue;
    }
    items.push({ type: 'turn' as const, turn: t, index: i });
  }
  return insertTimeSeparators(items);
});


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

// 每次历史加载完成后：首次加载 → 滚动到底部；续拉 → 保持位置
const isInitialHistoryLoad = ref(true);

watch(() => chatStore.loadingHistory, (loading, wasLoading) => {
  if (!loading && wasLoading) {
    if (isInitialHistoryLoad.value) {
      isInitialHistoryLoad.value = false;
      nextTick(() => scrollToBottom());
    }
    if (chatStore.hasMoreHistory) nextTick(() => tryAutoLoadMore());
  }
});

// 切换 Agent 时滚动到底部 + 标记为首次加载
watch(() => agentStore.activeAgentId, () => {
  isInitialHistoryLoad.value = true;
  isUserScrolledUp.value = false;
  nextTick(() => scrollToBottom());
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
      <div v-if="sessionTokens && sessionTokens.messageCount > 0" class="session-token-gauge" :title="`${sessionTokens.tokenCount.toLocaleString()} / ${sessionTokens.maxContextTokens.toLocaleString()} tokens · ${sessionTokens.messageCount} 条消息 · 约 ${sessionTokens.estimatedMsgsRemaining} 条后需归档`">
        <div class="gauge-bar">
          <div class="gauge-fill" :class="sessionTokens.status" :style="{ width: sessionTokens.usagePercent + '%' }"></div>
        </div>
        <span class="gauge-pct" :class="sessionTokens.status">{{ Math.round(sessionTokens.usagePercent) }}%</span>
      </div>
      <!-- 归档对话（先整理记忆后归档） -->
      <div class="compress-wrap">
      <button
        v-if="agentStore.activeAgentId && sessionTokens && sessionTokens.messageCount > 0"
        class="compress-btn"
        :class="{ 'compress-btn--pending': chatStore.compressPending }"
        :disabled="chatStore.turnInProgress || chatStore.compressPending"
        @click="handleCompress()"
        :title="chatStore.compressPending ? '正在归档整理记忆…' : '归档对话：先整理记忆，再归档早期消息'"
      >
        <svg v-if="!chatStore.compressPending" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 14 10 14 10 20" />
          <polyline points="20 10 14 10 14 4" />
          <line x1="14" y1="10" x2="21" y2="3" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
        <span v-else class="compress-btn__spinner"></span>
      </button>
      <transition name="fade">
        <span v-if="chatStore.compressFeedback" class="compress-feedback" :class="{ 'compress-feedback--ok': chatStore.compressFeedback.startsWith('✅') }">
          {{ chatStore.compressFeedback }}
        </span>
      </transition>
      <transition name="fade">
        <span v-if="chatStore.busyFeedback" class="busy-feedback">{{ chatStore.busyFeedback }}</span>
      </transition>
      </div>
      <!-- System Prompt 预览按钮 -->
      <button
        v-if="agentStore.activeAgentId"
        class="settings-btn"
        @click="chatStore.requestSystemPrompt(); showSystemPrompt = true"
        :disabled="chatStore.systemPromptLoading"
        title="预览 System Prompt"
      >
        <Icon name="file-text" :size="18" />
      </button>
      <!-- Agent 配置按钮 -->
      <button
        v-if="agentStore.activeAgentId"
        class="settings-btn"
        @click="openAgentSettings(agentStore.activeAgentId)"
        title="Agent 配置"
      >
        <Icon name="settings" :size="18" />
      </button>

      <!-- 更多操作菜单 -->
      <div v-if="agentStore.activeAgentId" class="more-menu-wrapper">
        <button class="settings-btn" @click.stop="toggleMoreMenu" title="更多操作">
          <Icon name="more-horizontal" :size="18" />
        </button>
        <Transition name="dropdown">
          <div v-if="showMoreMenu" class="more-dropdown" @click.stop>
            <button class="dropdown-item" @click="showMoreMenu = false; chatStore.requestToolDefs(); showToolDefs = true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              工具定义预览
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

          <template v-for="(item, idx) in turnDisplayItems" :key="item.type === 'time-separator' || item.type === 'trigger' || item.type === 'error' ? `${item.type}-${idx}` : `turn-${item.index}`">
            <div v-if="item.type === 'time-separator'" class="time-separator">
              <span class="time-separator-text">{{ item.timeText }}</span>
            </div>
            <div v-else-if="item.type === 'trigger'" class="trigger-separator">
              <span class="trigger-separator-text">{{ item.timeText }}</span>
            </div>
            <div v-else-if="item.type === 'error'" class="error-separator">
              <span class="error-separator-text">{{ item.timeText }}</span>
            </div>
            <TurnDisplayItem
              v-else
              :turn="item.turn!"
              :index="item.index"
              :settings-agent-id="settingsAgentId"
              @regenerate="chatStore.regenerateMessage"
              @delete-message="chatStore.deleteMessage"
              @edit="(msgId: any, newContent: any) => chatStore.editMessage(msgId, newContent)"
              @continue-generation="chatStore.continueGeneration()"
              @preview-file="handlePreviewFile"
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
    <Modal :visible="!!deleteTarget" :width="360" @close="deleteTarget = null">
      <div class="delete-dialog">
          <div class="delete-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h4>永久删除 Agent</h4>
          <p class="delete-warning">
            你确定要永久删除 <strong>{{ deleteTarget?.name }}</strong> 吗？
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
    </Modal>

    <!-- System Prompt 预览弹窗 -->
    <Modal :visible="showSystemPrompt" :width="700" @close="showSystemPrompt = false; chatStore.clearSystemPrompt()">
      <div class="system-prompt-dialog">
          <div class="prompt-header">
            <h4>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              System Prompt · {{ activeAgentName }}
            </h4>
            <button class="close-btn" @click="showSystemPrompt = false; chatStore.clearSystemPrompt()" title="关闭">×</button>
          </div>
          <div class="prompt-body">
            <!-- 加载中 -->
            <div v-if="chatStore.systemPromptLoading" class="prompt-loading">
              <span class="history-spinner"></span>
              <span>正在组装 System Prompt…</span>
            </div>
            <!-- 错误 -->
            <div v-else-if="chatStore.systemPromptError" class="prompt-error">
              {{ chatStore.systemPromptError }}
            </div>
            <!-- 内容 -->
            <pre v-else class="prompt-content">{{ chatStore.systemPromptContent }}</pre>
          </div>
          <div class="prompt-footer">
            <span class="prompt-info">共 {{ chatStore.systemPromptContent.length }} 字符</span>
            <div class="prompt-actions">
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
    </Modal>

    <!-- 工具定义预览弹窗 -->
    <Modal :visible="showToolDefs" :width="700" @close="showToolDefs = false; chatStore.clearToolDefs()">
      <div class="system-prompt-dialog">
          <div class="prompt-header">
            <h4>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              工具定义 · {{ activeAgentName }}
            </h4>
            <button class="close-btn" @click="showToolDefs = false; chatStore.clearToolDefs()" title="关闭">×</button>
          </div>
          <div class="prompt-body">
            <div v-if="chatStore.toolDefsLoading" class="prompt-loading">
              <span class="history-spinner"></span>
              <span>正在获取工具定义…</span>
            </div>
            <div v-else-if="chatStore.toolDefsError" class="prompt-error">
              {{ chatStore.toolDefsError }}
            </div>
            <div v-else-if="!chatStore.toolDefs.length" class="prompt-loading">
              该 Agent 没有注册任何工具
            </div>
            <pre v-else class="prompt-content">{{ toolDefsXml }}</pre>
          </div>
          <div class="prompt-footer">
            <span class="prompt-info">{{ chatStore.toolDefs.length }} 个工具</span>
            <div class="prompt-actions">
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
    </Modal>
  </div>
  <div v-else class="chat-view" />

  <!-- 文件预览弹窗 -->
  <FilePreviewModal
    :visible="previewVisible"
    :file-path="previewFilePath"
    :fallback-agent-id="previewFallbackAgentId"
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

/* ── 会话 Token 占用指示器 ── */
.session-token-gauge {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  padding: 2px 0;
  flex-shrink: 0;
}

.gauge-bar {
  width: 72px;
  height: 6px;
  border-radius: 3px;
  background: var(--color-bg-hover, rgba(0,0,0,0.06));
  overflow: hidden;
}

.gauge-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.gauge-fill.low { background: #22c55e; }
.gauge-fill.moderate { background: #eab308; }
.gauge-fill.high { background: #f97316; }
.gauge-fill.critical { background: #ef4444; }

.gauge-pct {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.gauge-pct.low { color: #22c55e; }
.gauge-pct.moderate { color: #eab308; }
.gauge-pct.high { color: #f97316; }
.gauge-pct.critical { color: #ef4444; }

/* ── 压缩对话按钮 ── */
.compress-btn {
  display: flex;
  align-items: center;
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  cursor: pointer;
  color: var(--color-text-muted, #888);
  line-height: 0;
  flex-shrink: 0;
  transition: color .15s;
  margin-left: 4px;
}
.compress-btn:hover { color: var(--color-primary, #6366f1); background: var(--color-bg-surface); }
.compress-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.compress-btn--pending { color: var(--color-primary, #6366f1); }
.compress-btn__spinner {
  width: 13px; height: 13px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: compress-spin .7s linear infinite;
}
@keyframes compress-spin { to { transform: rotate(360deg); } }

/* 压缩反馈提示（按钮旁小标签） */
.compress-wrap { position: relative; display: flex; align-items: center; }
.compress-feedback {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-muted, #888);
  background: var(--color-bg-surface, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  box-shadow: 0 2px 6px rgba(0,0,0,.08);
  pointer-events: none;
}
.compress-feedback--ok { color: #16a34a; }
.busy-feedback {
  font-size: 12px; color: var(--color-warning, #e67e22);
  background: rgba(230, 126, 34, 0.08);
  border: 1px solid rgba(230, 126, 34, 0.25);
  border-radius: 4px; padding: 2px 8px;
  white-space: nowrap;
}
.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 更多操作菜单 */
.more-menu-wrapper { position: relative; }
.more-dropdown {
  position: absolute; right: 0; top: 100%; margin-top: 4px;
  background: var(--bg-raised, var(--color-bg-page));
  border: 1px solid var(--line, var(--color-border-secondary));
  border-radius: 10px; box-shadow: var(--shadow-pop, 0 4px 16px rgba(0,0,0,0.1));
  min-width: 180px; z-index: 300; padding: 4px; overflow: hidden;
}
.dropdown-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 12px; border: none; border-radius: 6px;
  background: none; color: var(--text-1, var(--color-text-primary));
  font-size: 13px; cursor: pointer; text-align: left;
}
.dropdown-item:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.dropdown-item:disabled { opacity: 0.4; cursor: not-allowed; }
.dropdown-item.danger { color: var(--err, #e74c3c); }
.dropdown-item.danger:hover { background: color-mix(in srgb, var(--err) 12%, transparent); color: var(--err); }
.dropdown-divider {
  height: 1px; background: var(--line, var(--color-border-secondary));
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
  max-width: 100%;
  margin: 0 auto;
  min-height: 100%;
  overflow: hidden;
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

/* ===== trigger 消息分隔符（样式对齐时间分隔符） ===== */
.trigger-separator {
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  margin: 4px 0;
  /* 左右缩进 = 头像(32) + gap(10) = 42px，使 hint 与消息气泡边界对齐 */
  padding-left: 42px;
  padding-right: 42px;
}

.trigger-separator-text {
  font-size: 12px;
  color: var(--color-text-muted, #999);
  padding: 2px 12px;
  letter-spacing: 0.5px;
}

/* ===== error 消息分隔符（红色，样式对齐 trigger） ===== */
.error-separator {
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  margin: 4px 0;
  padding-left: 42px;
  padding-right: 42px;
}

.error-separator-text {
  font-size: 12px;
  color: var(--color-error, #e74c3c);
  padding: 2px 12px;
  letter-spacing: 0.5px;
  text-align: center;
  word-break: break-word;
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
.delete-dialog {
  padding: 24px 28px; text-align: center;
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

/* ===== System Prompt 预览弹窗 ===== */
.system-prompt-dialog {
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}
.prompt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.prompt-header h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary, #2c3e50);
}
.prompt-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 200px;
}
.prompt-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--color-text-muted);
  font-size: 13px;
}
.prompt-error {
  color: #e74c3c;
  padding: 20px;
  text-align: center;
  font-size: 13px;
}
.prompt-content {
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
.prompt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.prompt-info {
  font-size: 12px;
  color: var(--color-text-muted);
}
.prompt-actions {
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
