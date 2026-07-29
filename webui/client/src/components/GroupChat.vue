<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, inject } from 'vue';
import type { ChatMessage, GroupInfo, GroupPersistedMessage } from '../types';
import { useWebSocketStore } from '../stores/websocket';
import { useAgentStore } from '../stores/agents';
import { formatTime } from '../utils/format';
import ChatInput from './ChatInput.vue';
import Message from './chat/Message/Message.vue';
import ThinkingToolGroup from './chat/Message/ThinkingToolGroup.vue';
import FilePreviewModal from './chat/FilePreviewModal.vue';

const props = defineProps<{
  group: GroupInfo | null;
}>();

const emit = defineEmits<{
  (e: 'groupDeleted', groupId: string): void;
}>();

const wsStore = useWebSocketStore();
const agentStore = useAgentStore();
const messages = ref<ChatMessage[]>([]);
const turnInProgress = ref(false);
const messagesContainer = ref<HTMLElement>();
const isUserScrolledUp = ref(false);

/** 右侧抽屉 */
const showDrawer = ref(false);
const editingName = ref('');
const memberSearchQuery = ref('');
const renameError = ref('');
const renameSaved = ref(false);

/** 过滤后的参与者列表 */
const filteredParticipants = computed(() => {
  const q = memberSearchQuery.value.toLowerCase().trim();
  if (!q) return props.group?.participants ?? [];
  return (props.group?.participants ?? []).filter(p => p.toLowerCase().includes(q));
});

function toggleDrawer() {
  showDrawer.value = !showDrawer.value;
  if (showDrawer.value) {
    editingName.value = props.group?.name ?? '';
    memberSearchQuery.value = '';
    renameError.value = '';
    renameSaved.value = false;
  }
}

async function saveGroupName() {
  if (!props.group || !editingName.value.trim()) return;
  renameError.value = '';
  renameSaved.value = false;
  try {
    const resp = await fetch(`/api/groups/${encodeURIComponent(props.group.group_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingName.value.trim() }),
    });
    const data = await resp.json();
    if (!resp.ok) { renameError.value = data.error || '重命名失败'; return; }
    renameSaved.value = true;
    setTimeout(() => { renameSaved.value = false; }, 2000);
  } catch (err: any) {
    renameError.value = `重命名失败: ${err.message}`;
  }
}

async function leaveGroup() {
  // 留空：退出群聊的具体逻辑由用户后续定义
}

/** 删除确认 */
const showDeleteConfirm = ref(false);
const deleteError = ref('');
const deleting = ref(false);

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

async function confirmDelete() {
  if (!props.group) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    const resp = await fetch(`/api/groups/${encodeURIComponent(props.group.group_id)}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) { deleteError.value = data.error || '删除失败'; return; }
    emit('groupDeleted', props.group.group_id);
    showDeleteConfirm.value = false;
  } catch (err: any) {
    deleteError.value = `删除失败: ${err.message}`;
  } finally {
    deleting.value = false;
  }
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/** 获取消息发送者的头像 URL */
function getAvatar(agentId: string | undefined): string | null {
  if (!agentId) return null;
  return agentStore.getAgentAvatar(agentId) || `/api/agents/${encodeURIComponent(agentId)}/avatar`;
}

/** 获取消息发送者的显示名称 */
function getSenderName(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  return agentStore.getAgentName(agentId);
}

// ── 滚动逻辑（对齐 ChatView）──
function isNearBottom(): boolean {
  if (!messagesContainer.value) return true;
  const { scrollTop, scrollHeight, clientHeight } = messagesContainer.value;
  return scrollHeight - scrollTop - clientHeight < 80;
}

function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

function scrollToBottomAndReset() {
  scrollToBottom();
  isUserScrolledUp.value = false;
}

function onScroll() {
  isUserScrolledUp.value = !isNearBottom();
}

// ── 消息分组：将连续的 thinking+tool 轮次合并为 ThinkingToolGroup ──

/** 两条消息之间插入时间分隔符的最小间隔（毫秒），默认 5 分钟 */
const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

/** 格式化时间分隔符文本 */
function formatTimeSeparator(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const timeStr = formatTime(d);
  const dYear = d.getFullYear();
  const dMonth = d.getMonth();
  const dDate = d.getDate();
  const nYear = now.getFullYear();
  const nMonth = now.getMonth();
  const nDate = now.getDate();
  const today = new Date(nYear, nMonth, nDate);
  const target = new Date(dYear, dMonth, dDate);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return `今天 ${timeStr}`;
  if (diffDays === 1) return `昨天 ${timeStr}`;
  if (diffDays === 2) return `前天 ${timeStr}`;
  const dateStr = `${String(dMonth + 1).padStart(2, '0')}-${String(dDate).padStart(2, '0')}`;
  if (dYear === nYear) return `${dateStr} ${timeStr}`;
  return `${dYear}-${dateStr} ${timeStr}`;
}

const displayItems = computed(() => {
  const items: Array<{ type: 'message' | 'group' | 'time-separator'; data: any; index: number; timeText?: string }> = [];
  let i = 0;
  while (i < messages.value.length) {
    const msg = messages.value[i];
    if (msg.role === 'tool' && (msg as any)._grouped) { i++; continue; }
    if (msg.role === 'assistant' && (msg.thinking || msg.reasoning_content)) {
      const groupMsgs: ChatMessage[] = [msg];
      let j = i + 1;
      while (j < messages.value.length && messages.value[j].role === 'tool') {
        groupMsgs.push(messages.value[j]);
        (messages.value[j] as any)._grouped = true;
        j++;
      }
      if (groupMsgs.length > 1) {
        items.push({ type: 'group', data: groupMsgs, index: i });
        i = j;
        continue;
      }
    }
    items.push({ type: 'message', data: msg, index: i });
    i++;
  }

  // ── 在时间间隔较大的消息之间插入时间分隔符 ──
  if (items.length > 1) {
    const withSeparators: typeof items = [];
    for (let k = 0; k < items.length; k++) {
      if (k > 0) {
        const prev = items[k - 1];
        const curr = items[k];
        const prevTs = prev.type === 'group' ? prev.data[0]?.timestamp : prev.data?.timestamp;
        const currTs = curr.type === 'group' ? curr.data[0]?.timestamp : curr.data?.timestamp;
        if (prevTs > 0 && currTs > 0 && (currTs - prevTs) >= TIME_SEPARATOR_GAP_MS) {
          withSeparators.push({ type: 'time-separator', data: null, index: -1, timeText: formatTimeSeparator(currTs) });
        }
      }
      withSeparators.push(items[k]);
    }
    return withSeparators;
  }

  return items;
});

// ── 发送消息 ──
function sendGroupMessage(content: string) {
  if (!props.group || !content.trim()) return;
  turnInProgress.value = true;
  scrollToBottom();
  wsStore.send('group.message', { group_id: props.group.group_id, content, from: 'user' });
}

// ── 加载群组历史 ──
async function loadGroupHistory() {
  if (!props.group) return;
  try {
    const resp = await fetch(`/api/groups/${props.group.group_id}/history?limit=50`);
    if (!resp.ok) return;
    const data = await resp.json();
    messages.value = (data.messages ?? []).map((m: GroupPersistedMessage): ChatMessage => ({
      id: uid('hist'),
      role: (m.role === 'tool' ? 'tool' : m.agent_id === 'user' ? 'user' : 'assistant') as ChatMessage['role'],
      content: m.content ?? '',
      agent_id: m.agent_id,
      name: m.name,
      toolName: m.name,
      label: m.label,
      thinking: m.reasoning_content,
      reasoning_content: m.reasoning_content,
      timestamp: new Date(m.timestamp).getTime(),
    }));
    nextTick(() => scrollToBottom());
  } catch { /* ignore */ }
}

// ── WebSocket 事件处理 ──
function handleWSMessage(type: string, data: any) {
  if (data.group_id !== props.group?.group_id) return;
  if (type === 'group.message') {
    messages.value.push({
      id: uid('msg'),
      role: data.from === 'user' ? 'user' : 'assistant',
      content: data.payload ?? data.content ?? '',
      agent_id: data.from,
      timestamp: Date.now(),
    });
    turnInProgress.value = false;
    if (!isUserScrolledUp.value) {
      nextTick(() => scrollToBottom());
    }
  }
}

// 监听群组切换
watch(() => props.group?.group_id, (newId, oldId) => {
  if (newId && newId !== oldId) {
    messages.value = [];
    loadGroupHistory();
  }
}, { immediate: true });

wsStore.onMessage(handleWSMessage);

onMounted(() => {
  if (props.group) loadGroupHistory();
});
</script>

<template>
  <div v-if="group" class="chat-view">
    <!-- 头部（对齐 ChatView） -->
    <div class="chat-header">
      <div class="header-info">
        <span class="group-label">{{ group.name }}</span>
      </div>
      <span class="participant-count">{{ group.participants.length }} 个参与者</span>
      <!-- 更多操作：打开右侧抽屉 -->
      <button class="settings-btn" :class="{ active: showDrawer }" @click.stop="toggleDrawer" title="群聊信息">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
      </button>
    </div>

    <!-- chat-header 下方主体区域：消息区 + 抽屉区 -->
    <div class="chat-body">
      <!-- 消息 + 输入区域 -->
      <div class="chat-main" @click="showDrawer = false">

    <!-- 消息区域（对齐 ChatView 的 messages-wrapper 结构） -->
    <div class="messages-wrapper">
      <div ref="messagesContainer" class="messages-container" @scroll="onScroll">
        <div class="messages-content">
          <div v-if="messages.length === 0" class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>群聊开始 — 发送第一条消息吧</p>
          </div>

          <template v-for="(item, idx) in displayItems" :key="item.type === 'time-separator' ? `time-${idx}` : item.data?.id || item.data?.[0]?.id">
            <div v-if="item.type === 'time-separator'" class="time-separator">
              <span class="time-separator-text">{{ item.timeText }}</span>
            </div>
            <ThinkingToolGroup
              v-else-if="item.type === 'group'"
              :messages="item.data"
              :start-index="idx"
              :is-streaming="false"
              @preview-file="handlePreviewFile"
            />
            <Message
              v-else
              :message="item.data"
              :index="idx"
              :is-streaming="false"
              :sender-avatar="getAvatar(item.data.agent_id)"
              :sender-name="getSenderName(item.data.agent_id)"
              @preview-file="handlePreviewFile"
            />
          </template>
        </div>
      </div>

      <!-- 回到底部按钮（对齐 ChatView：absolute 定位在 wrapper 内） -->
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

    <!-- 输入区域（直接使用 ChatInput，对齐 ChatView） -->
    <ChatInput
      :disabled="turnInProgress"
      :placeholder="turnInProgress ? 'Agent 回复中...' : '输入消息发送到群聊...'"
      :on-send="sendGroupMessage"
    />

      </div><!-- .chat-main -->

      <!-- ===== 右侧抽屉 ===== -->
      <Transition name="drawer-slide">
        <div v-if="showDrawer" class="drawer-panel" @click.stop>
          <!-- 搜索框 + 群成员清单 -->
          <div class="drawer-section">
            <div class="drawer-section-title">群成员 ({{ group.participants.length }})</div>
            <div class="drawer-search-box">
              <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                v-model="memberSearchQuery"
                type="text"
                class="drawer-search-input"
                placeholder="搜索成员..."
              />
            </div>
            <div class="drawer-member-list">
              <div
                v-for="p in filteredParticipants"
                :key="p"
                class="drawer-member-item"
              >
                <span class="member-avatar">{{ p.charAt(0).toUpperCase() }}</span>
                <span class="member-name">{{ p }}</span>
              </div>
              <div v-if="filteredParticipants.length === 0" class="drawer-empty">
                未找到匹配的成员
              </div>
            </div>
          </div>

          <!-- 群聊名称（可修改） -->
          <div class="drawer-section">
            <div class="drawer-section-title">群聊名称</div>
            <div class="drawer-name-row">
              <input
                v-model="editingName"
                type="text"
                class="drawer-name-input"
                placeholder="输入群聊名称..."
                @keyup.enter="saveGroupName"
              />
              <button
                class="drawer-save-btn"
                :class="{ saved: renameSaved }"
                @click="saveGroupName"
                :disabled="!editingName.trim() || editingName === group.name"
              >
                {{ renameSaved ? '已保存' : '保存' }}
              </button>
            </div>
            <div v-if="renameError" class="drawer-error">{{ renameError }}</div>
          </div>

          <!-- 退出群聊 -->
          <div class="drawer-section drawer-section-bottom">
            <button class="drawer-leave-btn" @click="leaveGroup">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              退出群聊
            </button>
            <button class="drawer-delete-btn" @click="showDeleteConfirm = true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              删除群组
            </button>
          </div>
        </div>
      </Transition>
    </div><!-- .chat-body -->

    <!-- 删除确认对话框 -->
    <Transition name="modal">
      <div v-if="showDeleteConfirm" class="dialog-overlay" @mousedown.self="showDeleteConfirm = false">
        <div class="delete-dialog" @click.stop>
          <div class="delete-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h4>删除群聊群组</h4>
          <p class="delete-warning">
            确定要删除群组 <strong>{{ group.name }}</strong> 吗？
          </p>
          <p class="delete-detail">
            此操作将删除该群组的所有消息记录，<br/>
            <span class="delete-emphasis">不可恢复，不可撤销。</span>
          </p>
          <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
          <div class="dialog-actions">
            <button class="btn-cancel" @click="showDeleteConfirm = false" :disabled="deleting">取消</button>
            <button class="btn-delete" @click="confirmDelete" :disabled="deleting">
              {{ deleting ? '删除中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>

  <!-- 未选择群组（对齐 ChatView 的空状态） -->
  <div v-else class="chat-view">
    <div class="empty-view">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.18">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <h3>选择一个群组开始群聊</h3>
    </div>
  </div>

  <!-- 文件预览弹窗 -->
  <FilePreviewModal
    :visible="previewVisible"
    :file-path="previewFilePath"
    @close="closePreview"
  />
</template>

<style scoped>
/* ===== 整体布局（对齐 ChatView .chat-view） ===== */
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-page);
}

/* ===== 头部（对齐 ChatView .chat-header） ===== */
.chat-header {
  height: var(--layout-header-height, 52px);
  padding: 0 var(--space-md, 16px);
  background: var(--color-bg-page);
  border-bottom: 1px solid var(--color-border-secondary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
  backdrop-filter: blur(8px);
  z-index: 100;
  gap: var(--space-sm, 8px);
}

.header-info {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.group-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-id {
  font-size: 11px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
  font-family: monospace;
}

.participant-count {
  font-size: 12px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.45));
  flex-shrink: 0;
  margin-right: auto;
}

/* 更多操作按钮 */
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
.settings-btn:hover,
.settings-btn.active {
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
}
.settings-btn.active {
  background: var(--color-primary, #4f46e5);
  color: #fff;
}

/* ===== chat-header 下方主体（消息区 + 抽屉区） ===== */
.chat-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.settings-btn.active {
  background: var(--color-primary, #4f46e5);
  color: #fff;
}

/* ===== 消息区域（对齐 ChatView .messages-wrapper） ===== */
.messages-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.messages-container {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-md, 16px);
}

.messages-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-md, 16px);
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

/* ===== 回到底部按钮（对齐 ChatView） ===== */
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

.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* ===== 空状态 ===== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 200px;
  gap: 12px;
  color: var(--color-text-muted, rgba(255,255,255,0.3));
}
.empty-state p {
  margin: 0;
  font-size: 14px;
}

.empty-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
}
.empty-view h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
}

/* ===== 右侧抽屉 ===== */
.drawer-panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 300px;
  max-width: 85vw;
  background: var(--color-bg-page, #fff);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-left: 1px solid var(--color-border-secondary, #e0e0e0);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.1);
  z-index: 50;
}

/* 抽屉分区 */
.drawer-section {
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
}

.drawer-section-bottom {
  border-bottom: none;
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.drawer-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-tertiary, rgba(0,0,0,0.45));
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

/* 搜索框 */
.drawer-search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--color-bg-surface, #f5f5f5);
  border-radius: 8px;
  margin-bottom: 8px;
}

.drawer-search-box .search-icon {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.drawer-search-input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 13px;
  color: var(--color-text-primary);
}
.drawer-search-input::placeholder {
  color: var(--color-text-tertiary);
}

/* 成员列表 */
.drawer-member-list {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.drawer-member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: default;
}
.drawer-member-item:hover {
  background: var(--color-bg-surface, #f5f5f5);
}

.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-primary, #4f46e5);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.member-name {
  font-size: 13px;
  color: var(--color-text-primary);
  font-family: monospace;
}

.drawer-empty {
  padding: 12px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-tertiary);
}

/* 名称编辑行 */
.drawer-name-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.drawer-name-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--color-border-primary, #d0d0d0);
  border-radius: 8px;
  font-size: 14px;
  color: var(--color-text-primary);
  background: var(--color-bg-page);
  outline: none;
  transition: border-color 0.2s;
}
.drawer-name-input:focus {
  border-color: var(--color-primary, #4f46e5);
}

.drawer-save-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: var(--color-primary, #4f46e5);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s, opacity 0.2s;
}
.drawer-save-btn:hover:not(:disabled) {
  opacity: 0.9;
}
.drawer-save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.drawer-save-btn.saved {
  background: #27ae60;
}

.drawer-error {
  margin-top: 8px;
  font-size: 12px;
  color: #e74c3c;
}

/* 退出 / 删除按钮 */
.drawer-leave-btn,
.drawer-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.drawer-leave-btn {
  background: var(--color-bg-surface, #f5f5f5);
  color: var(--color-text-primary);
}
.drawer-leave-btn:hover {
  background: var(--color-border-secondary, #e0e0e0);
}

.drawer-delete-btn {
  background: none;
  color: #e74c3c;
}
.drawer-delete-btn:hover {
  background: #fde8e8;
}

/* 抽屉滑入滑出动画 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.28s ease, opacity 0.22s ease;
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .messages-container {
    padding: var(--space-sm, 8px);
  }
  .messages-content {
    max-width: 100%;
  }
  .scroll-to-bottom-btn {
    right: 12px;
    bottom: 12px;
  }
  .drawer-panel {
    width: 100%;
    max-width: 100vw;
  }
}

/* ===== 删除确认等对话框样式保持不变 ===== */
</style>
