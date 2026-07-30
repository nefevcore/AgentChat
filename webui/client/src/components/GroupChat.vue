<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, inject } from 'vue';
import type { ChatMessage, GroupInfo, GroupPersistedMessage, Turn, DisplayItem } from '../types';
import { useWebSocketStore } from '../stores/websocket';
import { useAgentStore } from '../stores/agents';
import { insertTimeSeparators } from '../utils/format';
import TurnDisplayItem from './chat/Message/TurnDisplayItem.vue';
import ChatInput from './ChatInput.vue';
import FilePreviewModal from './chat/FilePreviewModal.vue';

const props = defineProps<{
  group: GroupInfo | null;
}>();

const emit = defineEmits<{
  (e: 'groupDeleted', groupId: string): void;
}>();

const wsStore = useWebSocketStore();
const agentStore = useAgentStore();
const rawMessages = ref<ChatMessage[]>([]);
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
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingName.value.trim() }),
    });
    const data = await resp.json();
    if (!resp.ok) { renameError.value = data.error || '重命名失败'; return; }
    renameSaved.value = true;
    setTimeout(() => { renameSaved.value = false; }, 2000);
  } catch (err: any) { renameError.value = `重命名失败: ${err.message}`; }
}

const showDeleteConfirm = ref(false);
const deleteError = ref('');
const deleting = ref(false);

async function confirmDelete() {
  if (!props.group) return;
  deleting.value = true; deleteError.value = '';
  try {
    const resp = await fetch(`/api/groups/${encodeURIComponent(props.group.group_id)}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) { deleteError.value = data.error || '删除失败'; return; }
    emit('groupDeleted', props.group.group_id);
    showDeleteConfirm.value = false;
  } catch (err: any) { deleteError.value = `删除失败: ${err.message}`; }
  finally { deleting.value = false; }
}

/** 文件预览 */
const previewVisible = ref(false);
const previewFilePath = ref('');
function handlePreviewFile(filePath: string) { previewFilePath.value = filePath; previewVisible.value = true; }
function closePreview() { previewVisible.value = false; previewFilePath.value = ''; }

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

// ── 滚动 ──
function isNearBottom(): boolean {
  if (!messagesContainer.value) return true;
  const { scrollTop, scrollHeight, clientHeight } = messagesContainer.value;
  return scrollHeight - scrollTop - clientHeight < 80;
}
function scrollToBottom() {
  if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
}
function scrollToBottomAndReset() { scrollToBottom(); isUserScrolledUp.value = false; }
function onScroll() { isUserScrolledUp.value = !isNearBottom(); }

// ── Turn 转换：群聊消息按 agent_id 分组 → Turn[] ──
function messagesToTurns(msgs: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: ChatMessage[] = [];
  let curAgent = '';

  for (const msg of msgs) {
    if (msg.role !== 'agent') continue;
    const aid = msg.agent_id || '';
    if (aid !== curAgent && cur.length > 0) {
      turns.push({ agent_id: curAgent, steps: [], final: finalFromMsgs(cur) });
      cur = [];
    }
    curAgent = aid;
    cur.push(msg);
  }
  if (cur.length > 0) turns.push({ agent_id: curAgent, steps: [], final: finalFromMsgs(cur) });
  return turns;
}

function finalFromMsgs(msgs: ChatMessage[]): ChatMessage {
  // 最后一条消息作为 final，前面的合并到 thinking
  const last = msgs[msgs.length - 1];
  if (msgs.length === 1) return { ...last, thinking: '', reasoning_content: '', toolCalls: [] };
  // 多条连贯消息：前面的作为 thinking 拼接
  const thinking = msgs.slice(0, -1).map(m => m.content).filter(Boolean).join('\n');
  return { ...last, thinking, reasoning_content: thinking, toolCalls: [] };
}

const turns = computed<Turn[]>(() => messagesToTurns(rawMessages.value));

const settingsAgentId = inject<string>('settingsAgentId') || '';

const displayItems = computed<DisplayItem[]>(() => {
  const items: DisplayItem[] = turns.value.map((t, i) => ({ type: 'turn' as const, turn: t, index: i }));
  return insertTimeSeparators(items);
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
    rawMessages.value = (data.messages ?? []).map((m: GroupPersistedMessage): ChatMessage => ({
      id: uid('hist'),
      role: (m.role === 'tool' ? 'tool' : 'agent') as ChatMessage['role'],
      content: m.content ?? '',
      agent_id: m.agent_id,
      name: m.name,
      label: m.label,
      timestamp: new Date(m.timestamp).getTime(),
    }));
    nextTick(() => scrollToBottom());
  } catch { /* ignore */ }
}

// ── WebSocket 事件 ──
function handleWSMessage(type: string, data: any) {
  if (data.group_id !== props.group?.group_id) return;
  if (type === 'group.message') {
    rawMessages.value.push({
      id: uid('msg'),
      role: 'agent',
      content: data.payload ?? data.content ?? '',
      agent_id: data.from,
      timestamp: Date.now(),
    });
    turnInProgress.value = false;
    if (!isUserScrolledUp.value) nextTick(() => scrollToBottom());
  }
}

watch(() => props.group?.group_id, (newId, oldId) => {
  if (newId && newId !== oldId) { rawMessages.value = []; loadGroupHistory(); }
}, { immediate: true });

wsStore.onMessage(handleWSMessage);

onMounted(() => { if (props.group) loadGroupHistory(); });
</script>

<template>
  <div v-if="group" class="chat-view">
    <!-- 头部 -->
    <div class="chat-header">
      <div class="header-info"><span class="group-label">{{ group.name }}</span></div>
      <span class="participant-count">{{ group.participants.length }} 个参与者</span>
      <button class="settings-btn" :class="{ active: showDrawer }" @click.stop="toggleDrawer" title="群聊信息">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
      </button>
    </div>

    <!-- list-panel-wrapper 不存在时 ChatInput 会被撑到底部，需要 body 包裹 -->
    <div class="chat-body">
      <div class="chat-main" @click="showDrawer = false">
        <div class="messages-wrapper">
          <div ref="messagesContainer" class="messages-container" @scroll="onScroll">
            <div class="messages-content">
              <div v-if="rawMessages.length === 0" class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <p>群聊开始 — 发送第一条消息吧</p>
              </div>

              <template v-for="(item, idx) in displayItems" :key="item.type === 'time-separator' || item.type === 'trigger' ? `${item.type}-${idx}` : `turn-${item.index}`">
                <div v-if="item.type === 'time-separator'" class="time-separator">
                  <span class="time-separator-text">{{ item.timeText }}</span>
                </div>
                <div v-else-if="item.type === 'trigger'" class="trigger-separator">
                  <span class="trigger-separator-text">{{ item.timeText }}</span>
                </div>
                <TurnDisplayItem
                  v-else
                  :turn="item.turn!"
                  :index="item.index"
                  :settings-agent-id="settingsAgentId"
                />
              </template>
            </div>
          </div>

          <Transition name="scroll-btn">
            <button v-if="isUserScrolledUp" class="scroll-to-bottom-btn" @click="scrollToBottomAndReset" title="回到底部">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </Transition>
        </div>

        <ChatInput
          :disabled="turnInProgress"
          :placeholder="turnInProgress ? 'Agent 回复中...' : '输入消息发送到群聊...'"
          :on-send="sendGroupMessage"
        />
      </div>

      <!-- 右侧抽屉 -->
      <Transition name="drawer-slide">
        <div v-if="showDrawer" class="group-drawer">
          <h4>群聊信息</h4>
          <div class="drawer-section">
            <label>群聊名称</label>
            <div class="name-row">
              <input v-model="editingName" type="text" @keyup.enter="saveGroupName" />
              <button class="save-name-btn" @click="saveGroupName">保存</button>
            </div>
            <span v-if="renameSaved" class="saved-hint">已保存</span>
            <span v-if="renameError" class="error-hint">{{ renameError }}</span>
          </div>
          <div class="drawer-section">
            <label>参与者（{{ group.participants.length }}）</label>
            <input v-model="memberSearchQuery" type="text" placeholder="搜索参与者..." />
            <ul>
              <li v-for="p in filteredParticipants" :key="p">{{ p }}</li>
            </ul>
          </div>
          <div class="drawer-actions">
            <button class="btn-danger" @click="showDeleteConfirm = true">删除群聊</button>
          </div>
        </div>
      </Transition>

      <!-- 删除确认 -->
      <Transition name="modal">
        <div v-if="showDeleteConfirm" class="dialog-overlay" @mousedown.self="showDeleteConfirm = false">
          <div class="dialog-panel" @click.stop>
            <h4>确认删除</h4>
            <p>确定要删除群聊「{{ group.name }}」吗？此操作不可撤销。</p>
            <div v-if="deleteError" class="error-text">{{ deleteError }}</div>
            <div class="dialog-actions">
              <button class="btn-cancel" @click="showDeleteConfirm = false">取消</button>
              <button class="btn-save" style="background:#e74c3c" @click="confirmDelete" :disabled="deleting">删除</button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
  <div v-else class="chat-view empty-chat">
    <div class="empty-state">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.15">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <p>选择一个群组开始聊天</p>
    </div>
  </div>

  <FilePreviewModal :visible="previewVisible" :file-path="previewFilePath" @close="closePreview" />
</template>

<style scoped>
.chat-view {
  flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
}
.empty-chat {
  align-items: center; justify-content: center;
  background: var(--color-bg-page); color: var(--color-text-muted);
}
.empty-state { text-align: center; padding: 40px; }
.empty-state svg { margin-bottom: 12px; }
.empty-state p { font-size: 15px; }

.chat-header {
  display: flex; align-items: center; gap: 10px;
  height: var(--layout-header-height); padding: 0 16px;
  border-bottom: 1px solid var(--color-border-secondary);
  background: var(--color-bg-surface); flex-shrink: 0;
}
.header-info { flex: 1; min-width: 0; }
.group-label { font-size: 15px; font-weight: 600; color: var(--color-text-primary); }
.participant-count { font-size: 12px; color: var(--color-text-tertiary); }
.settings-btn {
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border: none; border-radius: 6px;
  background: none; color: var(--color-text-secondary); cursor: pointer;
}
.settings-btn:hover, .settings-btn.active { background: var(--color-bg-hover); color: var(--color-text-primary); }

.chat-body { flex: 1; display: flex; overflow: hidden; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* 消息区 */
.messages-wrapper { flex: 1; position: relative; overflow: hidden; }
.messages-container { height: 100%; overflow-y: auto; overflow-x: hidden; padding: var(--space-md); }
.messages-content { display: flex; flex-direction: column; gap: var(--space-sm); width: 100%; }

.time-separator { display: flex; align-items: center; justify-content: center; user-select: none; }
.time-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; }

.trigger-separator { display: flex; align-items: center; justify-content: center; user-select: none; margin: 4px 0; }
.trigger-separator-text { font-size: 13px; color: var(--color-text-muted, #999); padding: 3px 16px; background: var(--color-bg-subtle, #f0f0f0); border-radius: 4px; }

.scroll-to-bottom-btn {
  position: absolute; bottom: 12px; right: 16px;
  width: 36px; height: 36px; border: 1px solid var(--color-border-secondary);
  border-radius: 50%; background: var(--color-bg-page); color: var(--color-text-secondary);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1); z-index: 10; padding: 0;
}
.scroll-to-bottom-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.2s, transform 0.2s; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; transform: translateY(8px); }

/* 抽屉 */
.group-drawer {
  width: 260px; flex-shrink: 0; border-left: 1px solid var(--color-border-secondary);
  background: var(--color-bg-surface); padding: 16px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px;
}
.group-drawer h4 { font-size: 15px; font-weight: 600; margin: 0; color: var(--color-text-primary); }
.drawer-section { display: flex; flex-direction: column; gap: 4px; }
.drawer-section label { font-size: 12px; font-weight: 500; color: var(--color-text-secondary); }
.drawer-section input {
  padding: 6px 8px; border: 1px solid var(--color-border-secondary); border-radius: 6px;
  font-size: 13px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none;
}
.drawer-section input:focus { border-color: var(--color-primary); }
.drawer-section ul { list-style: none; padding: 0; margin: 4px 0 0; font-size: 13px; color: var(--color-text-secondary); }
.drawer-section li { padding: 2px 0; }
.name-row { display: flex; gap: 6px; }
.name-row input { flex: 1; }
.save-name-btn { padding: 4px 10px; border: none; border-radius: 4px; font-size: 12px; background: var(--color-primary); color: #fff; cursor: pointer; }
.saved-hint { font-size: 11px; color: #27ae60; }
.error-hint { font-size: 11px; color: #e74c3c; }
.drawer-actions { margin-top: auto; }
.btn-danger {
  width: 100%; padding: 8px; border: 1px solid #e74c3c; border-radius: 6px;
  background: none; color: #e74c3c; font-size: 13px; cursor: pointer;
}
.btn-danger:hover { background: #fdecea; }

.drawer-slide-enter-active, .drawer-slide-leave-active { transition: width 0.2s ease, opacity 0.2s; overflow: hidden; }
.drawer-slide-enter-from, .drawer-slide-leave-to { width: 0 !important; opacity: 0; padding: 0; }

/* 对话框 */
.dialog-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 600; }
.dialog-panel { background: var(--color-bg-page); border-radius: 10px; padding: 20px 24px; width: 360px; max-width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
.dialog-panel h4 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
.dialog-panel p { margin: 0 0 12px; font-size: 13px; color: var(--color-text-secondary); }
.error-text { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn-cancel, .btn-save { padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.btn-cancel { background: var(--color-bg-page); border: 1px solid var(--color-border-secondary); color: var(--color-text-secondary); }
.btn-save { background: var(--color-primary); border: none; color: #fff; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
