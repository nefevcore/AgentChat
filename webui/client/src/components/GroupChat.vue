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
const editingDescription = ref('');
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
    editingDescription.value = props.group?.description ?? '';
    memberSearchQuery.value = '';

  }
}

async function saveGroupInfo() {
  if (!props.group) return;
  if (!editingName.value.trim()) return;
  renameError.value = '';
  renameSaved.value = false;
  try {
    const body: Record<string, string> = { name: editingName.value.trim() };
    if (editingDescription.value !== (props.group.description ?? '')) {
      body.description = editingDescription.value;
    }
    const resp = await fetch(`/api/groups/${encodeURIComponent(props.group.group_id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) { renameError.value = data.error || '保存失败'; return; }
    if (props.group) props.group.description = editingDescription.value;
    renameSaved.value = true;
    setTimeout(() => { renameSaved.value = false; }, 2000);
  } catch (err: any) { renameError.value = `保存失败: ${err.message}`; }
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

function leaveGroup() {
  // 退出群聊（预留，后续接入 WS group.leave）
}

/** 文件预览 */
const previewVisible = ref(false);
const previewFilePath = ref('');
function handlePreviewFile(filePath: string) { previewFilePath.value = filePath; previewVisible.value = true; }
function closePreview() { previewVisible.value = false; previewFilePath.value = ''; }

function getMemberAvatar(agentId: string): string | undefined {
  return agentStore.getAgentAvatar(agentId) || undefined;
}
function getMemberName(agentId: string): string {
  return agentStore.getAgentName(agentId) || agentId;
}

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

      <!-- ═══ 右侧抽屉 ═══ -->
      <Transition name="drawer-slide">
        <div v-if="showDrawer" class="drawer-panel" @click.stop>
          <!-- 群成员 -->
          <div class="drawer-section">
            <div class="drawer-section-title">群成员 ({{ group.participants.length }})</div>
            <div class="drawer-search-box">
              <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input v-model="memberSearchQuery" type="text" class="drawer-search-input" placeholder="搜索成员..." />
            </div>
            <div class="drawer-member-list">
              <div v-for="p in filteredParticipants" :key="p" class="drawer-member-item">
                <div class="member-avatar">
                  <img v-if="getMemberAvatar(p)" :src="getMemberAvatar(p)" :alt="getMemberName(p)" />
                  <div v-else class="member-avatar-placeholder">{{ getMemberName(p).charAt(0).toUpperCase() }}</div>
                </div>
                <span class="member-name">{{ getMemberName(p) }}</span>
                <span class="member-avatar">{{ p.charAt(0).toUpperCase() }}</span>
                <span class="member-name">{{ p }}</span>
              </div>
              <div v-if="filteredParticipants.length === 0" class="drawer-empty">未找到匹配的成员</div>
            </div>
          </div>

          <!-- 群聊名称 -->
          <div class="drawer-section">
            <div class="drawer-section-title">群聊名称</div>
            <div class="drawer-name-row">
              <input v-model="editingName" type="text" class="drawer-name-input" placeholder="输入群聊名称..." @keyup.enter="saveGroupInfo" />
              <button class="drawer-save-btn" :class="{ saved: renameSaved }" @click="saveGroupInfo" :disabled="!editingName.trim() || editingName === group.name">{{ renameSaved ? '已保存' : '保存' }}</button>
            </div>
            <div v-if="renameError" class="drawer-error">{{ renameError }}</div>
          </div>

          <!-- 群聊简介 -->
          <div class="drawer-section">
            <div class="drawer-section-title">群聊简介</div>
            <textarea
              v-model="editingDescription"
              class="drawer-desc-input"
              placeholder="添加群聊简介..."
              rows="3"
            ></textarea>
          </div>

          <!-- 退出 / 删除 -->
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
            <p class="delete-warning">确定要删除群组 <strong>{{ group.name }}</strong> 吗？</p>
            <p class="delete-detail">此操作将删除该群组的所有消息记录，<br/><span class="delete-emphasis">不可恢复，不可撤销。</span></p>
            <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
            <div class="dialog-actions">
              <button class="btn-cancel" @click="showDeleteConfirm = false" :disabled="deleting">取消</button>
              <button class="btn-delete" @click="confirmDelete" :disabled="deleting">{{ deleting ? '删除中…' : '确认删除' }}</button>
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

/* ═══ 右侧抽屉 ═══ */
.drawer-panel {
  width: 280px; flex-shrink: 0; border-left: 1px solid var(--color-border-secondary);
  background: var(--color-bg-surface); display: flex; flex-direction: column;
  overflow-y: auto;
}
.drawer-section { padding: 14px 16px; border-bottom: 1px solid var(--color-border-secondary); }
.drawer-section-title { font-size: 13px; font-weight: 600; color: var(--color-text-primary); margin-bottom: 8px; }
.drawer-search-box { position: relative; display: flex; align-items: center; margin-bottom: 8px; }
.drawer-search-box .search-icon { position: absolute; left: 8px; color: var(--color-text-tertiary); pointer-events: none; }
.drawer-search-input {
  width: 100%; padding: 5px 8px 5px 28px; border: 1px solid var(--color-border-secondary); border-radius: 6px;
  font-size: 12px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none;
}
.drawer-search-input:focus { border-color: var(--color-primary); }
.drawer-member-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; max-height: 320px; overflow-y: auto; }
.drawer-member-item { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 5px 2px; }
.member-avatar { width: 40px; height: 40px; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.member-avatar img { width: 100%; height: 100%; object-fit: cover; }
.member-avatar-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: var(--color-primary-light, rgba(79,70,229,0.12)); color: var(--color-primary, #4f46e5); font-size: 15px; font-weight: 600; }
.member-name { font-size: 11px; color: var(--color-text-primary); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60px; margin-top: 2px; }
.drawer-empty { padding: 12px 0; font-size: 12px; color: var(--color-text-tertiary); text-align: center; }

.drawer-name-row { display: flex; gap: 6px; }
.drawer-name-input {
  flex: 1; padding: 6px 8px; border: 1px solid var(--color-border-secondary); border-radius: 6px;
  font-size: 13px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none;
}
.drawer-name-input:focus { border-color: var(--color-primary); }
.drawer-save-btn {
  padding: 4px 12px; border: none; border-radius: 4px; font-size: 12px;
  background: var(--color-primary, #6366f1); color: #fff; cursor: pointer; white-space: nowrap;
}
.drawer-save-btn:disabled { opacity: 0.5; cursor: default; }
.drawer-save-btn.saved { background: #27ae60; }
.drawer-desc-input {
  width: 100%; padding: 8px 10px; border: 1px solid var(--color-border-secondary); border-radius: 6px;
  font-size: 12px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none;
  resize: vertical; font-family: inherit; line-height: 1.5; min-height: 52px;
}
.drawer-desc-input:focus { border-color: var(--color-primary); }
.drawer-error { font-size: 11px; color: #e74c3c; margin-top: 4px; }

.drawer-section-bottom { border-bottom: none; display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.drawer-leave-btn, .drawer-delete-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px;
  border: none; border-radius: 6px; font-size: 13px; cursor: pointer; text-align: left;
}
.drawer-leave-btn { background: none; color: var(--color-text-secondary); }
.drawer-leave-btn:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.drawer-delete-btn { background: none; color: #e74c3c; }
.drawer-delete-btn:hover { background: #fdecea; }

.drawer-slide-enter-active, .drawer-slide-leave-active { transition: width 0.2s ease, opacity 0.2s; overflow: hidden; }
.drawer-slide-enter-from, .drawer-slide-leave-to { width: 0 !important; opacity: 0; padding: 0; }

/* ═══ 删除确认对话框 ═══ */
.dialog-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 600; }
.delete-dialog {
  background: var(--color-bg-page); border-radius: 12px; padding: 28px 24px 20px;
  width: 380px; max-width: 90vw; box-shadow: 0 12px 48px rgba(0,0,0,0.18); text-align: center;
}
.delete-icon { margin-bottom: 12px; }
.delete-dialog h4 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--color-text-primary); }
.delete-warning { margin: 0 0 4px; font-size: 14px; color: var(--color-text-secondary); }
.delete-detail { margin: 0 0 16px; font-size: 12px; color: var(--color-text-tertiary); line-height: 1.6; }
.delete-emphasis { color: #e74c3c; font-weight: 600; }
.delete-error { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: center; gap: 10px; }
.btn-cancel {
  padding: 8px 20px; border: 1px solid var(--color-border-secondary); border-radius: 6px;
  background: var(--color-bg-page); color: var(--color-text-secondary); font-size: 13px; cursor: pointer;
}
.btn-cancel:hover { background: var(--color-bg-surface); }
.btn-delete {
  padding: 8px 20px; border: none; border-radius: 6px;
  background: #e74c3c; color: #fff; font-size: 13px; cursor: pointer; font-weight: 500;
}
.btn-delete:hover { background: #c0392b; }
.btn-delete:disabled { opacity: 0.6; cursor: default; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
