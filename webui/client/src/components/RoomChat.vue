<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, inject } from 'vue';
import type { ChatMessage, RoomInfo, RoomPersistedMessage } from '../types';
import { useWebSocketStore } from '../stores/websocket';
import { useAgentStore } from '../stores/agents';
import ChatInput from './ChatInput.vue';
import Message from './chat/Message/Message.vue';
import ThinkingToolGroup from './chat/Message/ThinkingToolGroup.vue';
import FilePreviewModal from './chat/FilePreviewModal.vue';

const props = defineProps<{
  room: RoomInfo | null;
}>();

const emit = defineEmits<{
  (e: 'roomDeleted', roomId: string): void;
}>();

const wsStore = useWebSocketStore();
const agentStore = useAgentStore();
const messages = ref<ChatMessage[]>([]);
const turnInProgress = ref(false);
const messagesContainer = ref<HTMLElement>();
const isUserScrolledUp = ref(false);

/** �Ҳ���� */
const showDrawer = ref(false);
const editingName = ref('');
const memberSearchQuery = ref('');
const renameError = ref('');
const renameSaved = ref(false);

/** ���˺�Ĳ������б� */
const filteredParticipants = computed(() => {
  const q = memberSearchQuery.value.toLowerCase().trim();
  if (!q) return props.room?.participants ?? [];
  return (props.room?.participants ?? []).filter(p => p.toLowerCase().includes(q));
});

function toggleDrawer() {
  showDrawer.value = !showDrawer.value;
  if (showDrawer.value) {
    editingName.value = props.room?.name ?? '';
    memberSearchQuery.value = '';
    renameError.value = '';
    renameSaved.value = false;
  }
}

async function saveRoomName() {
  if (!props.room || !editingName.value.trim()) return;
  renameError.value = '';
  renameSaved.value = false;
  try {
    const resp = await fetch(`/api/groups/${encodeURIComponent(props.group.room_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingName.value.trim() }),
    });
    const data = await resp.json();
    if (!resp.ok) { renameError.value = data.error || '������ʧ��'; return; }
    renameSaved.value = true;
    setTimeout(() => { renameSaved.value = false; }, 2000);
  } catch (err: any) {
    renameError.value = `������ʧ��: ${err.message}`;
  }
}

async function leaveGroup() {
  // ��գ��˳�Ⱥ�ĵľ����߼����û���������
}

/** ɾ��ȷ�� */
const showDeleteConfirm = ref(false);
const deleteError = ref('');
const deleting = ref(false);

/** �ļ�Ԥ�� */
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
  if (!props.room) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    const resp = await fetch(`/api/groups/${encodeURIComponent(props.group.room_id)}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) { deleteError.value = data.error || 'ɾ��ʧ��'; return; }
    emit('roomDeleted', props.group.room_id);
    showDeleteConfirm.value = false;
  } catch (err: any) {
    deleteError.value = `ɾ��ʧ��: ${err.message}`;
  } finally {
    deleting.value = false;
  }
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/** ��ȡ��Ϣ�����ߵ�ͷ�� URL */
function getAvatar(agentId: string | undefined): string | null {
  if (!agentId) return null;
  return agentStore.getAgentAvatar(agentId) || `/api/agents/${encodeURIComponent(agentId)}/avatar`;
}

/** ��ȡ��Ϣ�����ߵ���ʾ���� */
function getSenderName(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  return agentStore.getAgentName(agentId);
}

// ���� �����߼������� ChatView������
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

// ���� ��Ϣ���飺�������� thinking+tool �ִκϲ�Ϊ ThinkingToolGroup ����
const displayItems = computed(() => {
  const items: Array<{ type: 'message' | 'group'; data: any; index: number }> = [];
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
  return items;
});

// ���� ������Ϣ ����
function sendGroupMessage(content: string) {
  if (!props.room || !content.trim()) return;
  turnInProgress.value = true;
  scrollToBottom();
  wsStore.send('group.message', { room_id: props.group.room_id, content, from: 'user' });
}

// ���� ���ط�����ʷ ����
async function loadGroupHistory() {
  if (!props.room) return;
  try {
    const resp = await fetch(`/api/groups/${props.group.room_id}/history?limit=50`);
    if (!resp.ok) return;
    const data = await resp.json();
    messages.value = (data.messages ?? []).map((m: RoomPersistedMessage): ChatMessage => ({
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

// ���� WebSocket �¼����� ����
function handleWSMessage(type: string, data: any) {
  if (data.room_id !== props.room?.room_id) return;
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

// ���������л�
watch(() => props.room?.room_id, (newId, oldId) => {
  if (newId && newId !== oldId) {
    messages.value = [];
    loadGroupHistory();
  }
}, { immediate: true });

wsStore.onMessage(handleWSMessage);

onMounted(() => {
  if (props.room) loadGroupHistory();
});
</script>

<template>
  <div v-if="room" class="chat-view">
    <!-- ͷ�������� ChatView�� -->
    <div class="chat-header">
      <div class="header-info">
        <span class="room-label">{{ group.name }}</span>
      </div>
      <span class="participant-count">{{ group.participants.length }} ��������</span>
      <!-- ������������Ҳ���� -->
      <button class="settings-btn" :class="{ active: showDrawer }" @click.stop="toggleDrawer" title="Ⱥ����Ϣ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
        </svg>
      </button>
    </div>

    <!-- chat-header �·�����������Ϣ�� + ������ -->
    <div class="chat-body">
      <!-- ��Ϣ + �������� -->
      <div class="chat-main" @click="showDrawer = false">

    <!-- ��Ϣ���򣨶��� ChatView �� messages-wrapper �ṹ�� -->
    <div class="messages-wrapper">
      <div ref="messagesContainer" class="messages-container" @scroll="onScroll">
        <div class="messages-content">
          <div v-if="messages.length === 0" class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>Ⱥ�Ŀ�ʼ �� ���͵�һ����Ϣ��</p>
          </div>

          <template v-for="(item, idx) in displayItems" :key="item.data.id || item.data[0]?.id">
            <ThinkingToolGroup
              v-if="item.type === 'group'"
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

      <!-- �ص��ײ���ť������ ChatView��absolute ��λ�� wrapper �ڣ� -->
      <Transition name="scroll-btn">
        <button
          v-if="isUserScrolledUp"
          class="scroll-to-bottom-btn"
          @click="scrollToBottomAndReset"
          title="�ص��ײ�"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </Transition>
    </div>

    <!-- ��������ֱ��ʹ�� ChatInput������ ChatView�� -->
    <ChatInput
      :disabled="turnInProgress"
      :placeholder="turnInProgress ? 'Agent �ظ���...' : '������Ϣ���͵�Ⱥ��...'"
      :on-send="sendGroupMessage"
    />

      </div><!-- .chat-main -->

      <!-- ===== �Ҳ���� ===== -->
      <Transition name="drawer-slide">
        <div v-if="showDrawer" class="drawer-panel" @click.stop>
          <!-- ������ + Ⱥ��Ա�嵥 -->
          <div class="drawer-section">
            <div class="drawer-section-title">Ⱥ��Ա ({{ group.participants.length }})</div>
            <div class="drawer-search-box">
              <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                v-model="memberSearchQuery"
                type="text"
                class="drawer-search-input"
                placeholder="������Ա..."
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
                δ�ҵ�ƥ��ĳ�Ա
              </div>
            </div>
          </div>

          <!-- Ⱥ�����ƣ����޸ģ� -->
          <div class="drawer-section">
            <div class="drawer-section-title">Ⱥ������</div>
            <div class="drawer-name-row">
              <input
                v-model="editingName"
                type="text"
                class="drawer-name-input"
                placeholder="����Ⱥ������..."
                @keyup.enter="saveRoomName"
              />
              <button
                class="drawer-save-btn"
                :class="{ saved: renameSaved }"
                @click="saveRoomName"
                :disabled="!editingName.trim() || editingName === group.name"
              >
                {{ renameSaved ? '�ѱ���' : '����' }}
              </button>
            </div>
            <div v-if="renameError" class="drawer-error">{{ renameError }}</div>
          </div>

          <!-- �˳�Ⱥ�� -->
          <div class="drawer-section drawer-section-bottom">
            <button class="drawer-leave-btn" @click="leaveGroup">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              �˳�Ⱥ��
            </button>
            <button class="drawer-delete-btn" @click="showDeleteConfirm = true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              ɾ������
            </button>
          </div>
        </div>
      </Transition>
    </div><!-- .chat-body -->

    <!-- ɾ��ȷ�϶Ի��� -->
    <Transition name="modal">
      <div v-if="showDeleteConfirm" class="dialog-overlay" @mousedown.self="showDeleteConfirm = false">
        <div class="delete-dialog" @click.stop>
          <div class="delete-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h4>ɾ��Ⱥ�ķ���</h4>
          <p class="delete-warning">
            ȷ��Ҫɾ������ <strong>{{ group.name }}</strong> ��
          </p>
          <p class="delete-detail">
            �˲�����ɾ���÷����������Ϣ��¼��<br/>
            <span class="delete-emphasis">���ɻָ������ɳ�����</span>
          </p>
          <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
          <div class="dialog-actions">
            <button class="btn-cancel" @click="showDeleteConfirm = false" :disabled="deleting">ȡ��</button>
            <button class="btn-delete" @click="confirmDelete" :disabled="deleting">
              {{ deleting ? 'ɾ���С�' : 'ȷ��ɾ��' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>

  <!-- δѡ�񷿼䣨���� ChatView �Ŀ�״̬�� -->
  <div v-else class="chat-view">
    <div class="empty-view">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.18">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <h3>ѡ��һ�����俪ʼȺ��</h3>
    </div>
  </div>

  <!-- �ļ�Ԥ������ -->
  <FilePreviewModal
    :visible="previewVisible"
    :file-path="previewFilePath"
    @close="closePreview"
  />
</template>

<style scoped>
/* ===== ���岼�֣����� ChatView .chat-view�� ===== */
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-page);
}

/* ===== ͷ�������� ChatView .chat-header�� ===== */
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

.room-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-id {
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

/* ���������ť */
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

/* ===== chat-header �·����壨��Ϣ�� + �������� ===== */
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

/* ===== ��Ϣ���򣨶��� ChatView .messages-wrapper�� ===== */
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

/* ===== �ص��ײ���ť������ ChatView�� ===== */
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

/* ===== ��״̬ ===== */
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

/* ===== �Ҳ���� ===== */
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

/* ������� */
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

/* ������ */
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

/* ��Ա�б� */
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

/* ���Ʊ༭�� */
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

/* �˳� / ɾ����ť */
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

/* ���뻬�뻬������ */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.28s ease, opacity 0.22s ease;
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* ===== ��Ӧʽ ===== */
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

/* ===== ɾ��ȷ�ϵȶԻ�����ʽ���ֲ��� ===== */
</style>
