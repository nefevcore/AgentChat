<script setup lang="ts">
import { ref, watch, nextTick, computed, inject } from 'vue';
import type { GroupInfo, DisplayItem } from '../types';
import { VIEWER_ID } from '../constants';
import { WS_SEND } from '../core/events/contract';
import { updateGroup, deleteGroup } from '../core/api/endpoints/groups';
import { useWebSocketStore } from '../stores/websocket';
import { useAgentStore } from '../stores/agents';
import { useFeedStore } from '../stores/feed';
import { groupDialog } from '../utils/feed';
import { Modal, Icon, Avatar } from '../ui';
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
const feed = useFeedStore();
const turnInProgress = ref(false);
const messagesContainer = ref<HTMLElement>();
const isUserScrolledUp = ref(false);
const loadingMore = ref(false);

/** 当前群组的 dialogId（group:${groupId}） */
const dialogId = computed(() => props.group ? groupDialog(props.group.group_id) : null);
/** rawMessages 来自统一信息流（单一真相源） */
const rawMessages = computed(() => dialogId.value ? feed.getRaw(dialogId.value) : []);

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

/** 抽屉成员列表：一次性解析名称/头像，避免模板内重复调用 */
const memberItems = computed(() =>
  filteredParticipants.value.map(id => ({
    id,
    name: getMemberName(id),
    avatar: getMemberAvatar(id) ?? null,
    isViewer: id === VIEWER_ID.value,
  }))
);

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
    await updateGroup(props.group.group_id, body);
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
    await deleteGroup(props.group.group_id);
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
const previewFallbackAgentId = ref('');
function handlePreviewFile(payload: string | { filePath: string; agentId?: string }) {
  if (typeof payload === 'string') {
    previewFilePath.value = payload;
  } else {
    previewFilePath.value = payload.filePath;
    previewFallbackAgentId.value = payload.agentId || '';
  }
  previewVisible.value = true;
}
function closePreview() { previewVisible.value = false; previewFilePath.value = ''; previewFallbackAgentId.value = ''; }

function getMemberAvatar(agentId: string): string | undefined {
  return agentStore.getAgentAvatar(agentId) || undefined;
}
function getMemberName(agentId: string): string {
  return agentStore.getAgentName(agentId) || agentId;
}

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
function onScroll() {
  isUserScrolledUp.value = !isNearBottom();
  // 上翻接近顶部 → 加载更早历史
  const el = messagesContainer.value;
  if (el && el.scrollTop < 120) void loadOlderHistory();
}

const settingsAgentId = inject<string>('settingsAgentId') || '';

/** turns 由统一信息流派生（buildTurns），与 ChatView 同一渲染管线 */
const turns = computed(() => dialogId.value ? feed.getTurns(dialogId.value).value : []);

const displayItems = computed<DisplayItem[]>(() => {
  const items: DisplayItem[] = turns.value.map((t, i) => ({ type: 'turn' as const, turn: t, index: i }));
  return insertTimeSeparators(items);
});

// ── 发送消息 ──
function sendGroupMessage(content: string) {
  if (!props.group || !content.trim()) return;
  turnInProgress.value = true;
  scrollToBottom();
  wsStore.send(WS_SEND.groupMessage, { group_id: props.group.group_id, content, from: VIEWER_ID.value });
}

// ── 群组历史加载（委托统一信息流 feed） ──
function loadGroupHistory() {
  if (!props.group || !dialogId.value) return;
  feed.loadGroupHistory(dialogId.value, props.group.group_id).then(() => {
    nextTick(() => scrollToBottom());
  });
}

/** 上翻加载更早历史：委托 feed 前插，保持滚动位置 */
async function loadOlderHistory() {
  if (!props.group || !dialogId.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const container = messagesContainer.value;
    const prevHeight = container ? container.scrollHeight : 0;
    const older = await feed.loadOlderGroupHistory(dialogId.value, props.group.group_id);
    if (older && older.length > 0) {
      nextTick(() => {
        if (container) container.scrollTop = container.scrollHeight - prevHeight;
      });
    }
  } finally {
    loadingMore.value = false;
  }
}

// ── 群组切换：加载该群组历史（实时 group.message 由 feed.ingest 统一处理） ──
watch(() => props.group?.group_id, (newId, oldId) => {
  if (newId && newId !== oldId) loadGroupHistory();
}, { immediate: true });
</script>

<template>
  <div v-if="group" class="chat-view">
    <!-- 头部 -->
    <div class="chat-header">
      <div class="header-info"><span class="group-label">{{ group.name }}</span></div>
      <span class="participant-count">{{ group.participants.length }} 个参与者</span>
      <button class="settings-btn" :class="{ active: showDrawer }" @click.stop="toggleDrawer" title="群聊信息">
        <Icon name="more-horizontal" :size="18" />
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

              <template v-for="(item, idx) in displayItems" :key="item.type === 'time-separator' || item.type === 'event' ? `${item.type}-${idx}` : `turn-${item.index}`">
                <div v-if="item.type === 'time-separator'" class="time-separator">
                  <span class="time-separator-text">{{ item.timeText }}</span>
                </div>
                <div v-else-if="item.type === 'event'" class="event-separator">
                  <span class="event-separator-text">{{ item.timeText }}</span>
                </div>
                <TurnDisplayItem
                  v-else
                  :turn="item.turn!"
                  :index="item.index"
                  :settings-agent-id="settingsAgentId"
                  :show-actions="false"
                  @preview-file="handlePreviewFile"
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
              <div v-for="m in memberItems" :key="m.id" class="drawer-member-item" :title="m.id">
                <div class="member-avatar-wrap">
                  <Avatar :src="m.avatar" :name="m.name" :size="40" shape="circle" />
                  <span v-if="m.isViewer" class="member-me">我</span>
                </div>
                <span class="member-name" :title="m.name">{{ m.name }}</span>
              </div>
              <div v-if="memberItems.length === 0" class="drawer-empty">未找到匹配的成员</div>
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
      <Modal :visible="showDeleteConfirm" :width="380" @close="showDeleteConfirm = false">
        <div class="delete-dialog">
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
      </Modal>

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

  <FilePreviewModal :visible="previewVisible" :file-path="previewFilePath" :fallback-agent-id="previewFallbackAgentId" @close="closePreview" />
</template>

<style scoped>
.chat-view {
  flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--color-bg-page);
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
.messages-content { display: flex; flex-direction: column; gap: var(--space-sm); width: 100%; max-width: 100%; overflow: hidden; }

.time-separator { display: flex; align-items: center; justify-content: center; user-select: none; }
.time-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; }

.event-separator { display: flex; align-items: center; justify-content: center; user-select: none; width: 100%; max-width: 720px; margin: 4px auto; }
.event-separator-text { font-size: 13px; color: var(--color-text-muted, #999); padding: 3px 16px; background: var(--color-bg-subtle, #f0f0f0); border-radius: 4px; white-space: pre-line; text-align: center; word-break: break-word; overflow-wrap: anywhere; max-width: 100%; }

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
.drawer-member-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 4px; max-height: 320px; overflow-y: auto; padding: 4px 0; }
.drawer-member-item {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 6px 2px; border-radius: 8px; cursor: default; min-width: 0;
  transition: background 0.15s ease;
}
.drawer-member-item:hover { background: var(--color-bg-hover, rgba(0,0,0,0.04)); }
.member-avatar-wrap {
  position: relative; flex-shrink: 0;
  /* flex 容器 → Avatar 的 inline-flex span 被块化，避免行内布局多出的基线高度 */
  display: flex; align-items: center; justify-content: center;
  line-height: 0;
}
.member-me {
  position: absolute; right: -5px; bottom: -3px;
  font-size: 9px; font-weight: 600; color: #fff; line-height: 14px;
  padding: 0 4px; border-radius: 8px;
  background: var(--color-primary, #6366f1);
  border: 1.5px solid var(--color-bg-surface);
}
.member-name {
  font-size: 11px; color: var(--color-text-primary); text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  width: 100%; max-width: 100%; margin-top: 2px;
}
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
.delete-dialog {
  padding: 28px 24px 20px; text-align: center;
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
</style>
