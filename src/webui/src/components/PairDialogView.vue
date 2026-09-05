// AgentChat — Agent 会话对（pair）只读视角
//
// 入口：运行矩阵格子点击（两端点都非 viewer 的会话关系 —— Agent↔Agent /
// Agent 自会话 / Agent↔system）。
//
// 布局与样式完全复用 DialogView 的消息区（同一套 messages-container /
// time-separator / event-separator / error-separator / TurnDisplayItem /
// 回到底部按钮 / useChatShell 滚动外壳），风格与 direct/群聊/独立会话统一。
//   · 对齐基准 settingsAgentId = viewer（user）：两端点都不是 user →
//     全部消息左气泡（头像 + 名称区分发言人）；
//   · 数据：feed 分区 pair:a|b（REST /api/history 分页，上翻前插保持位置）；
//   · 只读：无输入框 / 无操作按钮（show-actions=false）。

<script setup lang="ts">
import { ref, watch, nextTick, computed, inject, type Ref } from 'vue';
import { Avatar, Icon } from '../ui';
import { VIEWER_ID } from '../constants';
import { useAgentStore } from '../stores/agents';
import { useUiStore } from '../stores/ui';
import { useFeedStore } from '../stores/feed';
import { pairDialog } from '../utils/feed';
import type { DisplayItem } from '../types';
import { formatRelativeTime, insertTimeSeparators } from '../utils/format';
import { useChatShell } from '../composables/useChatShell';
import TurnDisplayItem from './chat/Message/TurnDisplayItem.vue';

const props = defineProps<{ a: string; b: string }>();

const agentStore = useAgentStore();
const ui = useUiStore();
const feed = useFeedStore();

/** 对齐基准：viewer（两端非 user → 双方全部左气泡，与用户要求一致） */
const settingsAgentId = inject<Ref<string>>('settingsAgentId', ref(VIEWER_ID.value));

const messagesContainer = ref<HTMLElement>();

const dialogId = computed(() => pairDialog(props.a, props.b));
const rawMessages = computed(() => feed.getRaw(dialogId.value));
const feedDialog = computed(() => feed.getDialog(dialogId.value));

/** 端点展示信息 */
function endpointOf(id: string) {
  const isSystem = id === 'system';
  return {
    id,
    name: isSystem ? 'system（系统触发）' : (agentStore.getAgentName(id) || id),
    avatar: isSystem ? null : agentStore.getAgentAvatar(id),
  };
}
const epA = computed(() => endpointOf(props.a));
const epB = computed(() => endpointOf(props.b));

// ── 历史加载（首屏 + 上翻前插）──
const isLoadingMore = ref(false);

async function loadOlder() {
  if (isLoadingMore.value || feedDialog.value?.status === 'loading' || !feedDialog.value?.hasMore) return;
  isLoadingMore.value = true;
  try {
    const container = messagesContainer.value;
    const prevHeight = container ? container.scrollHeight : 0;
    const older = await feed.loadOlderPairHistory(dialogId.value, props.a, props.b);
    if (older && older.length > 0) {
      nextTick(() => {
        if (container) container.scrollTop = container.scrollHeight - prevHeight;
      });
    }
  } finally {
    isLoadingMore.value = false;
  }
}

// ── 滚动外壳（与 DialogView 同款；先于 immediate watch 定义）──
const shell = useChatShell({
  container: messagesContainer,
  onTopThreshold: () => { void loadOlder(); },
  signal: () => [rawMessages.value.length, 0] as const,
});
const isUserScrolledUp = computed(() => shell.isUserScrolledUp.value);

watch(() => [props.a, props.b], async ([a, b], _old, onCleanup) => {
  if (!a || !b) return;
  shell.reset(); // 切换格子：清掉滚动外壳闭包残留（同 DialogView）
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  await feed.loadPairHistory(dialogId.value, a, b);
  if (cancelled) return;
  nextTick(() => shell.scrollToBottom());
}, { immediate: true });

// ── 渲染模型（与 DialogView 完全一致的管线：turn + time/event/error 分隔）──
const turns = computed(() => feed.getTurns(dialogId.value).value);

const turnDisplayItems = computed<DisplayItem[]>(() => {
  const turnList = turns.value;
  if (turnList.length === 0) return [];
  const items: DisplayItem[] = [];
  for (let i = 0; i < turnList.length; i++) {
    const t = turnList[i];
    // 稳定 key（同 DialogView：历史前插时下标平移会导致整列表重建）
    const ts = t.final?.timestamp ?? t.steps[0]?.assistant.timestamp ?? i;
    const stableKey = `turn-${t.agent_id}-${ts}-${t.final?.content?.length ?? 0}-${t.steps.length}`;
    if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'event') {
      const label = (t.final.content || t.final.source?.summary || '').trim();
      items.push({ type: 'event', index: -1, timeText: label, timestamp: t.final.timestamp, key: `event-${ts}-${label.length}` });
      continue;
    }
    if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'error') {
      items.push({ type: 'error', index: -1, timeText: t.final.content, timestamp: t.final.timestamp, key: `error-${ts}-${t.final.content?.length ?? 0}` });
      continue;
    }
    items.push({ type: 'turn' as const, turn: t, index: i, key: stableKey });
  }
  // run 中插播 event 的观感优化（同 DialogView：夹心 event 紧凑化、延续轮去重起头）
  for (let i = 0; i < items.length; i++) {
    if (items[i].type !== 'event') continue;
    let p = i - 1;
    while (p >= 0 && items[p].type === 'event') p--;
    let n = i + 1;
    while (n < items.length && items[n].type === 'event') n++;
    const prev = p >= 0 ? items[p] : undefined;
    const next = n < items.length ? items[n] : undefined;
    if (prev?.type === 'turn' && next?.type === 'turn'
      && prev.turn?.agent_id && prev.turn.agent_id === next.turn?.agent_id
      && prev.turn.agent_id !== VIEWER_ID.value) {
      items[i].midRun = true;
      next.continuation = true;
    }
  }
  return insertTimeSeparators(items);
});

const loading = computed(() => feedDialog.value?.status === 'loading');

/** 文件预览（只读视角也可能有文件路径输出） */
function handlePreviewFile(payload: string | { filePath: string; agentId?: string }) {
  if (typeof payload === 'string') ui.openPreview(payload, props.a || props.b);
  else ui.openPreview(payload.filePath, payload.agentId || props.a || props.b);
}
</script>

<template>
  <div class="chat-view">
    <!-- ═══ 头部：返回按钮 + 双端点信息（结构对齐 DialogView 的 chat-header）═══ -->
    <div class="chat-header">
      <button class="back-btn" title="返回会话" @click="ui.closePairView()">
        <Icon name="arrow-left" :size="20" />
      </button>
      <div class="header-info">
        <div class="pair-title">
          <div class="pair-avatars">
            <Avatar v-if="epA.avatar" :src="epA.avatar" :name="epA.name" :size="26" />
            <span v-else class="ep-ic"><Icon name="zap" :size="13" /></span>
            <span class="pair-x"><Icon name="x" :size="9" /></span>
            <Avatar v-if="epB.avatar" :src="epB.avatar" :name="epB.name" :size="26" />
            <span v-else class="ep-ic"><Icon name="zap" :size="13" /></span>
          </div>
          <span class="agent-label">{{ epA.name }} × {{ epB.name }}</span>
          <span class="pair-sub">只读 · 双方视角</span>
        </div>
      </div>
    </div>

    <!-- ═══ 消息区（结构与类名对齐 DialogView：messages-wrapper/container/content）═══ -->
    <div class="chat-body">
      <div class="chat-main">
        <div class="messages-wrapper">
          <div ref="messagesContainer" class="messages-container" @scroll="shell.onScroll">
            <div class="messages-content">
              <div v-if="rawMessages.length === 0 && !loading" class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <p>这两个对象之间暂无会话记录</p>
              </div>

              <!-- 加载更多历史消息指示器（与 DialogView 同款） -->
              <div v-if="isLoadingMore || loading" class="history-loading">
                <span class="history-spinner"></span>
                <span class="history-loading-text">加载历史消息中…</span>
              </div>

              <template v-for="(item, idx) in turnDisplayItems" :key="item.key ?? `${item.type}-${idx}`">
                <div v-if="item.type === 'time-separator'" class="time-separator">
                  <span class="time-separator-text">{{ item.timeText }}</span>
                </div>
                <div v-else-if="item.type === 'event'" class="event-separator" :class="{ 'event-separator--inline': item.midRun }">
                  <span v-if="item.timestamp && item.showTime !== false" class="event-separator-time">{{ formatRelativeTime(item.timestamp) }}</span>
                  <span class="event-separator-text">{{ item.timeText }}</span>
                </div>
                <div v-else-if="item.type === 'error'" class="error-separator">
                  <span v-if="item.timestamp && item.showTime !== false" class="error-separator-time">{{ formatRelativeTime(item.timestamp) }}</span>
                  <span class="error-separator-text">{{ item.timeText }}</span>
                </div>
                <TurnDisplayItem
                  v-else
                  :turn="item.turn!"
                  :index="item.index"
                  :settings-agent-id="settingsAgentId"
                  :show-actions="false"
                  :continuation="item.continuation"
                  @preview-file="handlePreviewFile"
                />
              </template>
            </div>
          </div>

          <Transition name="scroll-btn">
            <button v-if="isUserScrolledUp" class="scroll-to-bottom-btn" @click="shell.scrollToBottomAndReset" title="回到底部">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          </Transition>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 以下结构与类名对齐 DialogView.vue（视觉统一）── */
.chat-view {
  flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--color-bg-page);
}
.chat-header {
  display: flex; align-items: center; gap: 10px;
  height: var(--layout-header-height); padding: 0 16px;
  border-bottom: 1px solid var(--color-border-secondary);
  background: var(--color-bg-page); flex-shrink: 0;
  backdrop-filter: blur(8px); z-index: 100;
}
.header-info { flex: 1; min-width: 0; }
.agent-label { font-size: 15px; font-weight: 600; color: var(--color-text-primary); }

/* 返回按钮（最左）：hamburger-btn 同款形态 */
.back-btn {
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer;
  color: var(--color-text-secondary); padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.back-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }

/* 双端点标题 */
.pair-title{display:flex;align-items:center;gap:10px;min-width:0}
.pair-avatars{display:flex;align-items:center;gap:4px;flex-shrink:0}
.pair-x{display:inline-flex;align-items:center;color:var(--color-text-tertiary,#a8abb2)}
.pair-sub{font-size:11px;color:var(--color-text-tertiary,#a8abb2);white-space:nowrap;margin-left:4px}
.ep-ic{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;color:#f59e0b;background:rgba(245,158,11,.15);flex-shrink:0}

.chat-body { flex: 1; display: flex; overflow: hidden; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.messages-wrapper { flex: 1; position: relative; overflow: hidden; }
.messages-container { height: 100%; overflow-y: auto; overflow-x: hidden; padding: var(--space-md); scrollbar-width: thin; scrollbar-color: transparent transparent; }
.messages-content { display: flex; flex-direction: column; gap: var(--space-sm); width: 100%; max-width: 100%; margin: 0 auto; min-height: 100%; }
/* 滚动条仅悬停会话区域时可见：默认拇指透明（6px 槽位常驻，避免悬停时内容宽度跳变） */
.messages-container:hover { scrollbar-color: var(--color-border-primary) transparent; }
.messages-container::-webkit-scrollbar { width: 6px; }
.messages-container::-webkit-scrollbar-track { background: transparent; }
.messages-container::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
.messages-container:hover::-webkit-scrollbar-thumb { background: var(--color-border-primary); }
.messages-container::-webkit-scrollbar-thumb:hover { background: var(--color-primary); }

.empty-state { text-align: center; padding: 40px; color: var(--color-text-muted); }
.empty-state svg { margin-bottom: 12px; }
.empty-state p { font-size: 15px; }

.time-separator { display: flex; align-items: center; justify-content: center; user-select: none; }
.time-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; }
.event-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; width: 100%; max-width: 720px; margin: 4px auto; padding-left: 42px; padding-right: 42px; }
/* run 中插播事件（前后均為同 agent 轮）：紧凑内联 pill（同 DialogView） */
.event-separator--inline { margin: 1px auto; padding: 0 12px; }
.event-separator--inline .event-separator-time { display: none; }
.event-separator--inline .event-separator-text {
  font-size: 11px; color: var(--color-text-tertiary, #999);
  background: var(--color-bg-surface, #f8f8f8);
  border: 1px solid var(--color-border-secondary, rgba(0, 0, 0, 0.05));
  border-radius: var(--radius-sm, 4px);
  padding: 1px 8px; letter-spacing: 0.3px; white-space: normal;
}
.event-separator-time { font-size: 11px; color: var(--color-text-tertiary, #999); letter-spacing: 0.3px; line-height: 1.4; }
.event-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; white-space: pre-line; text-align: center; word-break: break-word; overflow-wrap: anywhere; max-width: 100%; }
.error-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; margin: 4px 0; padding-left: 42px; padding-right: 42px; }
.error-separator-time { font-size: 11px; color: color-mix(in srgb, var(--color-error, #e74c3c) 70%, transparent); letter-spacing: 0.3px; line-height: 1.4; }
.error-separator-text { font-size: 12px; color: var(--color-error, #e74c3c); padding: 2px 12px; letter-spacing: 0.5px; text-align: center; word-break: break-word; }

.history-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 0; color: var(--color-text-muted); font-size: 13px; }
.history-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--color-border-primary); border-top-color: var(--color-primary); border-radius: 50%; animation: history-spin 0.6s linear infinite; }
@keyframes history-spin { to { transform: rotate(360deg); } }
.history-loading-text { user-select: none; }

.scroll-to-bottom-btn {
  position: absolute; bottom: 12px; right: 16px;
  width: 40px; height: 40px; border: 1px solid var(--color-border-primary, #e0e0e0);
  border-radius: 50%; background: var(--color-bg-page, #fff); color: var(--color-text-secondary, #666);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12); z-index: 50; padding: 0;
  transition: box-shadow 0.2s, transform 0.2s, background 0.2s;
}
.scroll-to-bottom-btn:hover { box-shadow: 0 4px 14px rgba(0,0,0,0.18); transform: translateY(-1px); background: var(--color-bg-surface, #f5f5f5); }
.scroll-to-bottom-btn:active { transform: translateY(0); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.2s, transform 0.2s; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; transform: translateY(8px); }

@media (max-width: 768px) {
  .messages-container { padding: var(--space-sm); }
  .scroll-to-bottom-btn { right: 12px; bottom: 12px; }
  .pair-sub { display: none; }
}
</style>
