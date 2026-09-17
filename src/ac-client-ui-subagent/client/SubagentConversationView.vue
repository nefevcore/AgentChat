<script setup lang="ts">
// ============================================================
// SubagentConversationView.vue —— 子 Agent 会话只读视角
//（subagent-session-view-plan R3/R4：独立组件复用 conversation 渲染内核，
// 不并入 ConversationView 第五形态——子会话不是对桶，寻址语义不同构）
//
// 数据链（全现成纯函数复用）：
//   subagents/history RPC → toHistoryMessages（steps[] 按步展开：工具卡/
//   思维链折叠栏/已思考耗时/步级 ts 排序）→ pairMessageToChatMessage →
//   buildTurns → useTurnDisplayItems → TranscriptList。
// 刷新驱动：jobBoard 中该 subId 条目状态变化（job/settled 帧已由 jobBoard
// 订阅）+ 手动刷新钮（WS 断线兜底）。P0 纯历史回放——live 流式见计划 §七 P1。
// 上翻分页：limit/offset 从尾部往回取（RPC 形状对齐 session/history）。
// ============================================================
import { computed, ref, watch, nextTick } from 'vue';
import { Icon, StarAvatar } from '@agentchat/webui-kit';
import { starColor } from '@agentchat/webui-kit';
import { useClientContext, clientRuntime } from 'ac-client-runtime';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import {
  toHistoryMessages,
  type PSessionRecord,
} from 'ac-client-ui-conversation/client/historyApi.ts';
import { pairMessageToChatMessage, buildTurns } from 'ac-client-ui-conversation/client/feed.ts';
import { useTurnDisplayItems } from 'ac-client-ui-conversation/client/useTurnDisplayItems.ts';
import TranscriptList from 'ac-client-ui-conversation/client/TranscriptList.vue';
import { jobIsRunning, subagentMeta, type WireJob } from 'ac-client-ui-jobs/client';
import type { Turn } from 'ac-client-ui-conversation/client/types.ts';

const props = defineProps<{
  subId: string;
  name?: string;
  parentId?: string;
}>();

const ui = useUiStore();
const themeStore = useThemeStore();
const roster = useRosterCore();
const rpc = useClientContext()?.rpc ?? null;
const jobBoard = useClientContext()?.jobBoard;

// ── 状态徽章（jobBoard 运行态权威；缺席回落 props 名单外的 unknown） ──
const job = computed<WireJob | undefined>(() =>
  (jobBoard?.jobs.value ?? []).find((j) => subagentMeta(j).subagentId === props.subId));
const isRunning = computed(() => job.value !== undefined && jobIsRunning(job.value));

function parentName(id: string): string {
  return roster.getAgentName(id) || id;
}

// ── 历史数据（分页：首屏 50 条，上翻前插） ──
const PAGE_SIZE = 50;
const records = ref<PSessionRecord[]>([]);
const loading = ref(false);
const loadError = ref('');
const hasMore = ref(false);
const offset = ref(0);

async function loadInitial(): Promise<void> {
  offset.value = 0;
  const r = await fetchPage(0);
  records.value = r;
  nextTick(() => transcript.value?.scrollToBottom());
}

async function loadOlder(): Promise<void> {
  if (loading.value || !hasMore.value) return;
  const next = offset.value + PAGE_SIZE;
  const older = await fetchPage(next);
  const container = transcript.value?.container();
  const prevHeight = container ? container.scrollHeight : 0;
  records.value = [...older, ...records.value];
  offset.value = next;
  nextTick(() => {
    if (container) container.scrollTop = container.scrollHeight - prevHeight;
  });
}

async function fetchPage(pageOffset: number): Promise<PSessionRecord[]> {
  if (!rpc) return [];
  loading.value = true;
  loadError.value = '';
  try {
    const r = await rpc.call<{ records?: PSessionRecord[]; hasMore?: boolean }>('subagents/history', {
      id: props.subId,
      limit: PAGE_SIZE,
      offset: pageOffset,
    });
    hasMore.value = r.hasMore === true;
    return r.records ?? [];
  } catch (err: unknown) {
    loadError.value = (err as { message?: string })?.message ?? String(err);
    return [];
  } finally {
    loading.value = false;
  }
}

// ── 渲染管线（现成纯函数链——与 pair 历史回放同构） ──
const messages = computed(() => {
  const expanded = toHistoryMessages(records.value, props.subId) as Array<Record<string, unknown>>;
  return expanded.map((m) => pairMessageToChatMessage(m as never, props.subId));
});
const turns = computed<Turn[]>(() => buildTurns(messages.value));
const turnDisplayItems = useTurnDisplayItems(turns);

const transcript = ref<InstanceType<typeof TranscriptList>>();

function streamingTailLen(): number { return 0; } // P0 纯历史（live 见 P1）

// ── 刷新驱动：jobBoard 该 subId 条目 settled（新 run 收束 → 重拉历史） ──
watch(
  () => job.value?.status,
  (cur, prev) => {
    // 终态变化（running→completed/failed/killed）= 新 run 收束——重拉历史
    if (prev !== undefined && prev !== 'running' && cur !== 'running') return;
    if (prev !== 'running') return;
    void loadInitial();
  },
);
// subId 切换（视角复用）：重载
watch(() => props.subId, () => { void loadInitial(); }, { immediate: true });

function refresh() { void loadInitial(); }
</script>

<template>
  <div class="sub-chat">
    <!-- 头部：返回 + 子信息 + 状态徽章 + 刷新 -->
    <div class="chat-header">
      <button class="back-btn" title="返回" @click="ui.closeSubagentView()">
        <Icon name="arrow-left" :size="20" />
      </button>
      <div class="header-info">
        <div class="pair-title">
          <div class="pair-avatars">
            <StarAvatar :name="props.name || props.subId" :size="26" :color="starColor(props.subId, themeStore.theme === 'dark' ? 'nebula' : 'aurora')" fallback-icon="bot" />
            <span class="pair-x"><Icon name="x" :size="9" /></span>
            <StarAvatar :name="parentName(props.parentId || '')" :size="26" :color="starColor(props.parentId || '', themeStore.theme === 'dark' ? 'nebula' : 'aurora')" fallback-icon="bot" />
          </div>
          <span class="agent-label">{{ props.name || '子 Agent' }}</span>
          <span class="pair-sub">
            <Icon name="bot" :size="10" style="vertical-align: -1px" /> 只读 · 父 {{ parentName(props.parentId || '') }}
            <code class="sub-id">{{ props.subId }}</code>
          </span>
        </div>
      </div>
      <div class="header-actions">
        <span v-if="isRunning" class="st-badge st-running"><Icon name="zap" :size="11" /> 运行中</span>
        <span v-else-if="job" class="st-badge st-idle">{{ job.status }}</span>
        <button class="refresh-btn" title="刷新（重拉历史）" :disabled="loading" @click="refresh">
          <Icon :name="loading ? 'loader' : 'refresh-cw'" :size="15" :class="{ spin: loading }" />
        </button>
      </div>
    </div>

    <div v-if="loadError" class="load-error">历史拉取失败：{{ loadError }}</div>

    <div class="chat-body">
      <TranscriptList
        ref="transcript"
        :items="turnDisplayItems"
        :message-count="messages.length"
        :streaming-tail-len="streamingTailLen()"
        :on-top-threshold="() => loadOlder()"
        :loading="loading"
        :first-load-pending="loading && records.length === 0"
        empty-text="该子 Agent 暂无会话记录"
        :show-actions="false"
        :settings-agent-id="props.subId"
      />
    </div>
  </div>
</template>

<style scoped>
.sub-chat {
  flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--color-bg-page);
}

.chat-header {
  display: flex; align-items: center; gap: 10px;
  height: var(--layout-header-height); padding: 0 16px;
  border-bottom: 1px solid var(--color-border-secondary);
  flex-shrink: 0;
}
.back-btn {
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border: none; border-radius: var(--radius-md);
  background: none; color: var(--color-text-secondary); cursor: pointer;
}
.back-btn:hover { background: var(--color-bg-subtle); color: var(--color-text-primary); }
.header-info { flex: 1; min-width: 0; }
.pair-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pair-avatars { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
.pair-x { color: var(--color-text-muted); display: flex; }
.agent-label { font-size: 14px; font-weight: 600; color: var(--color-text-primary); }
.pair-sub { font-size: 11px; color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub-id {
  font-family: 'SF Mono', Consolas, monospace; font-size: 10px;
  color: var(--color-primary, #6366f1); background: var(--color-primary-light, rgba(79, 70, 229, 0.08));
  padding: 0 5px; border-radius: 4px; margin-left: 4px;
}
.header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.refresh-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: var(--radius-sm);
  background: none; color: var(--color-text-secondary); cursor: pointer;
}
.refresh-btn:hover:not(:disabled) { background: var(--color-bg-subtle); color: var(--color-text-primary); }
.refresh-btn:disabled { opacity: .5; cursor: wait; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.st-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px;
}
.st-running { color: #e6a817; background: rgba(230, 168, 23, 0.1); }
.st-idle { color: var(--color-text-tertiary); background: var(--color-bg-subtle); }

.load-error { padding: 4px 16px 6px; font-size: 11px; color: #e74c3c; flex-shrink: 0; }
.chat-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
</style>
