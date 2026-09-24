<!-- TranscriptList.vue —— 会话消息区统一组件（会话区重构 B 路线抽取）
  原 DialogView / PairDialogView 各持一份的「滚动容器 + 分隔符 + 逐轮渲染 +
  回到底部 + 空态/加载指示」整块收拢单源；四视角（direct/group/single/
  pair·readonly）共用。滚动外壳（useChatShell）随容器住在本地——宿主经
  defineExpose 拿 scrollToBottom/reset/container（发送后滚底、切换会话重置、
  历史前插滚动补偿需要容器元素）。
  空态 gate：无消息 && 首载未回（firstLoadPending）→ 加载占位而非「开始
  对话」——首开有历史的会话不再被误导成空白新会话。 -->
<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { formatRelativeTime } from './format.ts';
import { useChatShell } from './useChatShell.ts';
import type { DisplayItem } from './types.ts';
import TurnDisplayItem from './Message/TurnDisplayItem.vue';

const props = defineProps<{
  /** 渲染管线产物（useTurnDisplayItems） */
  items: DisplayItem[];
  /** 消息总数（空态 gate；滚动信号之一） */
  messageCount: number;
  /** 流式尾部长度（滚动跟随信号——流式期间不判「用户上翻」） */
  streamingTailLen: number;
  /** 上翻阈值回调（宿主编排历史加载：direct 续拉 / group·pair 前插） */
  onTopThreshold: () => void;
  /** 顶部加载指示（续拉/加载进行中；空态时由加载占位承担，避免双重提示） */
  loading: boolean;
  /** 首载未回（无消息且加载中 → 加载占位） */
  firstLoadPending: boolean;
  /** 空态文案（形态各异，宿主供） */
  emptyText: string;
  /** 轮内操作（regenerate/edit/…；group 与 readonly 形态传 false） */
  showActions: boolean;
  /** 左右对齐基准（用户消息靠右——镜像 TurnDisplayItem 同名 prop，透传） */
  settingsAgentId: string;
  /** 所在会话键（M32 文件预览工作区推导；透传 TurnDisplayItem） */
  conversationId?: string;
  /** 分支能力接线（single 形态传 true；透传 TurnDisplayItem.canFork） */
  canFork?: boolean;
}>();

const emit = defineEmits<{
  (e: 'preview-file', payload: string | { filePath: string; agentId?: string; conversationId?: string }): void;
  (e: 'regenerate', msgId: string): void;
  (e: 'delete-message', msgId: string): void;
  (e: 'edit', msgId: string, newContent: string): void;
  (e: 'fork-from-message', msgId: string): void;
}>();

const messagesContainer = ref<HTMLElement>();

// ── 滚动外壳（统一四形态；signal = 消息数 + 流式尾长）──
const shell = useChatShell({
  container: messagesContainer,
  onTopThreshold: () => props.onTopThreshold(),
  signal: () => [props.messageCount, props.streamingTailLen] as const,
});
const isUserScrolledUp = computed(() => shell.isUserScrolledUp.value);

// ── 窗口化挂载（2026-01 首载分帧引入；2026-12 收口为「首载窗口 + 上翻分帧」）──
// 背景：历史首载时页内全部 thinking/正文/工具输出在同一次 Vue flush 里同步跑
// markdown-it + highlight.js（基准实测重页 ~60ms 主线程阻塞；大会话 800+ 条
// 单帧挂载 = 秒级卡顿）。现行语义：
//   · 切入/首载只挂尾部 INITIAL_WINDOW 条（最新消息在视口内）；
//   · 更旧条目仅当用户上翻时分帧补挂（REFILL_BATCH × 16ms 让出主线程）；
//   · 补挂按「用户是否在底部」二选一补偿——贴底态重贴底（视口静止）；
//     上翻态保持距顶偏移（不跳）。
// 流式追加与续拉前插不回退窗口（renderFrom 归零后不再置位）。
const INITIAL_WINDOW = 24;
const REFILL_BATCH = 24;

/** 渲染窗口起始索引（0 = 全量已挂） */
const renderFrom = ref(0);
let refillTimer: ReturnType<typeof setTimeout> | null = null;

function clearRefill() {
  if (refillTimer !== null) {
    clearTimeout(refillTimer);
    refillTimer = null;
  }
}

/** 分帧补挂进行中（重入短路判据：进行中的分帧说明本会话尚未完整挂载） */
function refilling(): boolean {
  return refillTimer !== null;
}

/** 逐批补挂（批次之间让出主线程；补齐即停；归零登记见 renderFrom watch） */
function scheduleRefill() {
  if (refillTimer !== null || renderFrom.value === 0) return;
  refillTimer = setTimeout(() => {
    refillTimer = null;
    if (renderFrom.value === 0) return;
    const box = messagesContainer.value;
    const keepBottom = !shell.isUserScrolledUp.value;
    const prevHeight = box?.scrollHeight ?? 0;
    const prevTop = box?.scrollTop ?? 0;
    renderFrom.value = Math.max(0, renderFrom.value - REFILL_BATCH);
    void nextTick(() => {
      const el = messagesContainer.value;
      if (el) {
        el.scrollTop = keepBottom
          ? el.scrollHeight - el.clientHeight          // 贴底：视口静止
          : prevTop + (el.scrollHeight - prevHeight);  // 上翻：保持距顶偏移
      }
      scheduleRefill();
    });
  }, 16);
}

// fullyMounted = 本组件实例内「已完整挂载过」的会话键记忆：同实例切回
//（single→single，DOM 还在）命中即不重置 renderFrom——已挂组件树零重建。
// 组件重挂（视角切换 talk↔single）后记忆随实例消亡——重挂恒窗口化是
// 有意为之（旧 DOM 已销毁，全量重建没有意义；「切回即全量恢复」曾按
// 模块级记忆实现过，方向反了——窗口化才是切换的预期成本）。
const fullyMounted = new Set<string>();
const currentCid = computed(() => props.conversationId);
// watch immediate 覆盖重挂路径（视角切换后分区缓存已就位、items 挂载即
// 全量）：首调 prevCid undefined → switched=false 走 firstLoad 窗口化——
// 此前无 immediate 时 mount 首触发不跑，renderFrom 保持 0 = 单帧全量挂载。
watch(
  [() => props.conversationId, () => props.items.length],
  ([cid, len], [prevCid, prevLen]) => {
    const switched = cid !== prevCid && prevCid !== undefined;
    const firstLoad = (prevLen ?? 0) === 0 && len > 0;
    if (!switched && !firstLoad) return;
    // 重入短路（仅同实例切换）：已完整挂载过且窗口未越界 → 不重置
    // renderFrom（已挂组件树零重建）。越界守卫：上个会话是大列表时窗口
    // 起点可能已超本会话条数——不拦会一条不渲染且无人再调度补挂。
    // 重挂场景（immediate 首调 prevCid undefined）不走短路——恒窗口化。
    if (switched && typeof cid === 'string' && fullyMounted.has(cid) && !refilling()
      && renderFrom.value < len) {
      return;
    }
    clearRefill();
    // 首载窗口化：只挂尾部 INITIAL_WINDOW 条，不自动逐批补挂（自动补挂
    // 的逐批强制 layout 是切换卡顿主体）；用户上翻时才分帧补挂。
    renderFrom.value = len > INITIAL_WINDOW ? len - INITIAL_WINDOW : 0;
    if (renderFrom.value === 0 && typeof cid === 'string') fullyMounted.add(cid); // 小列表天然全量
  },
  { immediate: true },
);
// 补挂归零（用户上翻分帧补完）→ 登记当前会话为已完整挂载
watch(
  () => renderFrom.value,
  (from) => { if (from === 0 && currentCid.value) fullyMounted.add(currentCid.value); },
);

// 用户上翻：分帧补挂剩余条目（旧语义「立即全量」在大会话 = 一次性渲染
// 千余组件的长任务；复用 16ms 分帧让出主线程，滚动保持跟手）
watch(() => shell.isUserScrolledUp.value, (up) => {
  if (!up || renderFrom.value === 0) return;
  clearRefill();
  scheduleRefill();
});

onBeforeUnmount(clearRefill);

defineExpose({
  scrollToBottom: () => shell.scrollToBottom(),
  reset: () => shell.reset(),
  container: () => messagesContainer.value,
});
</script>

<template>
  <div class="messages-wrapper">
    <div ref="messagesContainer" class="messages-container" @scroll="shell.onScroll">
      <div class="messages-content">
        <!-- 空态 gate（首载未回 = 加载占位，不显示「开始对话」） -->
        <div v-if="messageCount === 0" class="empty-state">
          <template v-if="firstLoadPending">
            <span class="history-spinner empty-state-spinner"></span>
            <p>正在加载历史消息…</p>
          </template>
          <template v-else>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>{{ emptyText }}</p>
          </template>
        </div>

        <!-- 加载更多历史消息指示器（空态时由上方加载占位承担） -->
        <div v-if="messageCount > 0 && loading" class="history-loading">
          <span class="history-spinner"></span>
          <span class="history-loading-text">加载历史消息中…</span>
        </div>

        <template v-for="(item, idx) in items" :key="item.key ?? `${item.type}-${idx}`">
          <!-- 首载分帧：窗口外的（更旧）条目在后续帧补挂 -->
          <template v-if="idx >= renderFrom">
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
            :settings-agent-id="settingsAgentId"
            :show-actions="showActions"
            :continuation="item.continuation"
            :conversation-id="conversationId"
            :can-fork="canFork"
            @regenerate="emit('regenerate', $event)"
            @delete-message="emit('delete-message', $event)"
            @edit="(msgId: any, newContent: any) => emit('edit', msgId, newContent)"
            @preview-file="emit('preview-file', $event)"
            @fork-from-message="emit('fork-from-message', $event)"
          />
          </template>
        </template>
      </div>
    </div>

    <Transition name="scroll-btn">
      <button v-if="isUserScrolledUp" class="scroll-to-bottom-btn" @click="shell.scrollToBottomAndReset" title="回到底部">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
/* 消息区 */
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
.event-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; width: 100%; max-width: 720px; margin: 4px auto; padding-left: min(42px, 10%); padding-right: min(42px, 10%); }
/* run 中插播事件（前后均為同 agent 轮）：紧凑居中——文字直接复用下方通用
   .event-separator-text（无背景/边框，与时间分隔控件同视觉，只要文字）；
   仅保留行距与时间隐藏，弱化对阅读流的切断感 */
.event-separator--inline { margin: 1px auto; padding: 0 12px; }
.event-separator--inline .event-separator-time { display: none; }
.event-separator-time { font-size: 11px; color: var(--color-text-tertiary, #999); letter-spacing: 0.3px; line-height: 1.4; }
.event-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; white-space: pre-line; text-align: center; word-break: break-word; overflow-wrap: anywhere; max-width: 100%; }
.error-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; margin: 4px 0; padding-left: min(42px, 10%); padding-right: min(42px, 10%); }
.error-separator-time { font-size: 11px; color: color-mix(in srgb, var(--color-error, #e74c3c) 70%, transparent); letter-spacing: 0.3px; line-height: 1.4; }
.error-separator-text { font-size: 12px; color: var(--color-error, #e74c3c); padding: 2px 12px; letter-spacing: 0.5px; text-align: center; word-break: break-word; }

.history-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 0; color: var(--color-text-muted); font-size: 13px; }
.history-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--color-border-primary); border-top-color: var(--color-primary); border-radius: 50%; animation: history-spin 0.6s linear infinite; }
/* 空态加载占位中的 spinner（居中大号；对齐空态 svg 的 margin-bottom） */
.empty-state-spinner { width: 28px; height: 28px; border-width: 3px; margin-bottom: 12px; }
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
}
</style>
