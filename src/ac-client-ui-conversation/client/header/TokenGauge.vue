// ============================================================
// client/header/TokenGauge.vue —— 上下文占用仪表（会话头 chip）
//（会话区重构自 ConversationView 内联抽取：conversation:header-widget
//  出厂贡献 order 20——direct/single 形态的 Token 仪表：头部占用 gauge
//  (26px) + 点击详情弹层(56px)。数据面不变：fetchSessionTokens（agents
//  rosterApi）+ chatStore 固定开销估算；归档入口随弹层底部。）
// ============================================================

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RingProgress } from '@agentchat/webui-kit';
import { useClientContext } from 'ac-client-runtime';
import { fetchSessionTokens } from 'ac-client-ui-agents/client/rosterApi.ts';
import type { SingleSession } from 'ac-client-ui-singles/client';
import { useChatStore } from '../chatStore.ts';
import { estimateTokens, fmtTokenCount } from '../tokens.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ConversationView 经 SlotOutlet data 传入） */
  data: {
    /** 头部目标 Agent（direct = 激活 Agent；single = 会话承载 Agent） */
    agentId?: string | null;
    /** 独立会话（非空 = single 形态，会话键 = sid） */
    single?: SingleSession | null;
    /** 会话形态（仅 direct/single 显示仪表） */
    form?: 'direct' | 'group' | 'single' | 'pair';
  };
}>();

const chatStore = useChatStore();
// rpc 契约面（宿主 'rpc' 服务——wireRpc 薄壳）
const rpc = computed(() => useClientContext()?.rpc ?? null);

// ════════════ direct/single 特有：Token 仪表盘（自内核原样迁入）════════════
interface SessionTokensCache {
  lastHit: number; lastMiss: number; hit: number; miss: number; lastRunPrompt: number;
}
interface SessionTokens {
  tokenCount: number; messageCount: number; maxContextTokens: number; usagePercent: number;
  avgTokensPerMsg: number; estimatedMsgsRemaining: number; status: 'low' | 'moderate' | 'high' | 'critical';
  cache?: SessionTokensCache;
}
const sessionTokens = ref<SessionTokens | null>(null);

async function fetchTokenBaseline(clearFirst = false) {
  // single：会话键 = sid、承载 Agent = data.agentId（元数据 agentId 空 =
  //   默认预设——不补全则后端以 sid 为 viewer 估算，占用严重偏低）；
  // direct：data.agentId（后端按对桶推导会话键）。agentId 未选 → 跳过。
  const agentId = props.data.agentId || '';
  if (!agentId || !rpc.value) return;
  if (clearFirst) sessionTokens.value = null;
  const seq = ++tokenFetchSeq; // 竞态守卫：快速切换会话时 A 的迟到响应不得覆盖 B
  try {
    const data = await fetchSessionTokens(agentId, rpc.value, props.data.single
      ? { conversationId: props.data.single.id, agentId }
      : undefined);
    if (seq !== tokenFetchSeq) return;
    sessionTokens.value = {
      tokenCount: data.tokenCount ?? 0,
      messageCount: data.messageCount ?? 0,
      maxContextTokens: data.maxContextTokens ?? 1_000_000,
      usagePercent: data.usagePercent ?? 0,
      avgTokensPerMsg: data.avgTokensPerMsg ?? 0,
      estimatedMsgsRemaining: data.estimatedMsgsRemaining ?? 0,
      status: data.status ?? 'low',
      ...(data.cache
        ? {
            cache: {
              lastHit: data.cache.lastHit ?? 0,
              lastMiss: data.cache.lastMiss ?? 0,
              hit: data.cache.hit ?? 0,
              miss: data.cache.miss ?? 0,
              lastRunPrompt: data.cache.lastRunPrompt ?? 0,
            },
          }
        : {}),
    };
  } catch { /* 失败保留旧值，不闪烁 */ }
}
let tokenFetchSeq = 0;

// Token 弹层开关（须先于下方 immediate watch 声明：immediate 回调在注册时
// 同步执行，后置 const 会触发 TDZ ReferenceError——setup 在此中断，席位
// 条目被 EntryErrorBoundary 捕获退位，仪表整枝消失。原内核 2026-09-05
// 事故同款，随抽取迁移时须保持此声明序）
const tokenPanelOpen = ref(false);

// 重取时机（自内核原样迁入）：目标 Agent 切换 / single 切换 / run 结束 /
// 历史拉尽（估算口径补全）/ 归档完成（compact 重写会话——无 run 结束）
watch(() => props.data.agentId, () => { fetchTokenBaseline(true); tokenPanelOpen.value = false; }, { immediate: true });
watch(() => props.data.single?.id, () => { fetchTokenBaseline(true); tokenPanelOpen.value = false; });
watch(() => chatStore.lastRunEndAt, () => { fetchTokenBaseline(); });
watch(() => chatStore.hasMoreHistory, () => { if (!chatStore.hasMoreHistory) fetchTokenBaseline(); });
watch(() => chatStore.sessionArchivedAt, () => { fetchTokenBaseline(); });

const TOKEN_STATUS_LABEL: Record<SessionTokens['status'], string> = {
  low: '正常', moderate: '偏高', high: '接近上限', critical: '临界',
};
function toggleTokenPanel() {
  tokenPanelOpen.value = !tokenPanelOpen.value;
  if (tokenPanelOpen.value) {
    // 懒加载固定开销构成（系统提示/工具定义——每次打开重取：人格/记忆/
    // 生效工具集都可能变化）
    if (props.data.agentId) {
      chatStore.requestSystemPrompt(props.data.agentId);
      chatStore.requestToolDefs(props.data.agentId);
    }
    // 点击外部关闭（gauge 点击带 .stop 不触达 document）
    setTimeout(() => document.addEventListener('click', closeTokenPanel, { once: true }), 0);
  }
}
function closeTokenPanel() { tokenPanelOpen.value = false; }

// ── 固定开销（≈ 展示口径：与后端 ac-text-budget 同款字符估算）──
const systemPromptTokens = computed(() => estimateTokens(chatStore.systemPromptContent));
const toolDefsTokens = computed(() =>
  (chatStore.toolDefs as unknown[]).reduce<number>((n, d) => n + estimateTokens(JSON.stringify(d)), 0));
const overheadLoading = computed(() => chatStore.systemPromptLoading || chatStore.toolDefsLoading);

// ── 缓存命中（provider prompt cache；命中率 = hit / (hit + miss)） ──
const cacheRate = (hit: number, miss: number): number | null =>
  hit + miss > 0 ? hit / (hit + miss) : null;
const lastCacheRate = computed(() => {
  const c = sessionTokens.value?.cache;
  return c ? cacheRate(c.lastHit, c.lastMiss) : null;
});
const totalCacheRate = computed(() => {
  const c = sessionTokens.value?.cache;
  return c ? cacheRate(c.hit, c.miss) : null;
});
const pct = (r: number | null, digits = 1): string =>
  r === null ? '—' : `${(r * 100).toFixed(digits)}%`;

/** 压缩对话：触发 Agent 整理记忆后裁剪消息 */
function handleCompress() {
  if (!props.data.agentId || chatStore.turnInProgress || chatStore.compressPending) return;
  chatStore.compressSession();
}

/** 形态 gate：仅 direct/single 且有会话数据时渲染（群无单一会话上下文、pair 只读无仪表） */
const applicable = computed(() =>
  (props.data.form === 'direct' || props.data.form === 'single')
  && !!sessionTokens.value && sessionTokens.value.messageCount > 0);
</script>

<template>
  <div
    v-if="applicable"
    class="session-token-gauge"
    :class="{ 'is-open': tokenPanelOpen }"
    :title="`上下文占用 ${Math.round(sessionTokens!.usagePercent)}% · 点击查看详情`"
    @click.stop="toggleTokenPanel()"
  >
    <!-- 环形进度条：占用率在环中心，语义色随状态（低→临界） -->
    <RingProgress
      class="gauge-ring"
      :tone="sessionTokens!.status"
      :value="sessionTokens!.usagePercent"
      :size="26"
      :stroke="3"
    >
      <span class="gauge-ring-pct" :class="sessionTokens!.status">{{ Math.round(sessionTokens!.usagePercent) }}</span>
    </RingProgress>
    <transition name="fade">
      <div v-if="tokenPanelOpen" class="token-panel" @click.stop>
        <div class="token-panel__head">
          <span class="token-panel__title">上下文占用</span>
          <span class="token-panel__status" :class="sessionTokens!.status">{{ TOKEN_STATUS_LABEL[sessionTokens!.status] }}</span>
        </div>
        <!-- 环形占用仪表：中心 = 占用率；右侧 = 会话上下文 / 上限 -->
        <div class="token-panel__ring-row">
          <RingProgress
            class="token-ring"
            :tone="sessionTokens!.status"
            :value="sessionTokens!.usagePercent"
            :size="56"
            :stroke="5"
          >
            <span class="token-ring-pct" :class="sessionTokens!.status">{{ Math.round(sessionTokens!.usagePercent) }}%</span>
            <span class="token-ring-sub">已占用</span>
          </RingProgress>
          <div class="token-ring-side">
            <div class="token-row"><span class="k">会话上下文</span><span class="v">{{ fmtTokenCount(sessionTokens!.tokenCount) }}</span></div>
            <div class="token-row"><span class="k">上下文上限</span><span class="v">{{ fmtTokenCount(sessionTokens!.maxContextTokens) }}</span></div>
          </div>
        </div>
        <div class="token-row"><span class="k">工具定义</span><span class="v">{{ overheadLoading ? '…' : `≈ ${fmtTokenCount(toolDefsTokens)}` }}</span></div>
        <div class="token-row"><span class="k">系统提示词</span><span class="v">{{ overheadLoading ? '…' : `≈ ${fmtTokenCount(systemPromptTokens)}` }}</span></div>
        <!-- 缓存命中（provider prompt cache；命中部分按服务商折扣价计费） -->
        <template v-if="lastCacheRate !== null || totalCacheRate !== null">
          <div class="token-panel__cache">
            <div class="token-row"><span class="k">缓存命中 · 最近一次</span><span class="v">{{ pct(lastCacheRate) }}</span></div>
            <div v-if="lastCacheRate !== null" class="cache-bar" :title="`命中 ${sessionTokens!.cache!.lastHit.toLocaleString()} / 未命中 ${sessionTokens!.cache!.lastMiss.toLocaleString()}`">
              <div class="cache-bar__hit" :style="{ width: (lastCacheRate * 100) + '%' }"></div>
            </div>
            <div v-if="lastCacheRate !== null" class="token-row token-row--sub"><span class="k">命中 {{ fmtTokenCount(sessionTokens!.cache!.lastHit) }} · 未命中 {{ fmtTokenCount(sessionTokens!.cache!.lastMiss) }}</span><span class="v"></span></div>
            <div v-if="totalCacheRate !== null" class="token-row"><span class="k">缓存命中 · 本会话累计</span><span class="v">{{ pct(totalCacheRate) }}</span></div>
          </div>
        </template>
        <div class="token-note">≈ 为估算值；缓存命中部分按折扣价计费。</div>
        <!-- 归档入口：占用量与归档动作同屏——超阈值时顺手整理；run 进行中/整理中禁用 -->
        <button
          class="token-panel__action"
          :disabled="chatStore.turnInProgress || chatStore.compressPending"
          :title="chatStore.compressPending ? '正在归档整理记忆…' : chatStore.turnInProgress ? '回复进行中，结束后再归档' : '归档对话：先整理记忆，再归档早期消息'"
          @click="handleCompress()"
        >
          <svg v-if="!chatStore.compressPending" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
          <span v-else class="token-panel__action-spinner"></span>
          {{ chatStore.compressPending ? '正在归档整理记忆…' : '归档对话' }}
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.session-token-gauge { position: relative; display: flex; align-items: center; gap: 6px; margin-left: 6px; padding: 2px 4px; flex-shrink: 0; cursor: pointer; border-radius: var(--radius-sm); }
.session-token-gauge:hover, .session-token-gauge.is-open { background: var(--color-bg-surface); }
/* 头部环形占用（数值在环心，单位 % 省略——title 补全语义） */
.gauge-ring { display: block; }
.gauge-ring-pct { font-size: 9px; font-weight: 700; font-variant-numeric: tabular-nums; }
.gauge-ring-pct.low { color: #22c55e; }
.gauge-ring-pct.moderate { color: #eab308; }
.gauge-ring-pct.high { color: #f97316; }
.gauge-ring-pct.critical { color: #ef4444; }

/* Token 详情弹层（点击仪表盘展开，悬挂于头部下方——不与相邻控件重叠） */
.token-panel {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
  min-width: 248px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
  background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-primary, #e0e0e0);
  border-radius: var(--radius-md, 8px); box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  cursor: default; text-align: left;
}
.token-panel__head { display: flex; align-items: center; justify-content: space-between; }
.token-panel__title { font-size: 12px; font-weight: 600; color: var(--color-text-primary); }
.token-panel__status { font-size: 11px; font-weight: 600; }
.token-panel__status.low { color: #22c55e; }
.token-panel__status.moderate { color: #eab308; }
.token-panel__status.high { color: #f97316; }
.token-panel__status.critical { color: #ef4444; }
/* 弹层环形占用仪表：左环（占用率）+ 右侧上下文/上限行 */
.token-panel__ring-row { display: flex; align-items: center; gap: 14px; padding: 2px 0; }
.token-ring { flex-shrink: 0; }
.token-ring-pct { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.token-ring-pct.low { color: #22c55e; }
.token-ring-pct.moderate { color: #eab308; }
.token-ring-pct.high { color: #f97316; }
.token-ring-pct.critical { color: #ef4444; }
.token-ring-sub { font-size: 10px; color: var(--color-text-tertiary, #999); margin-top: 3px; }
.token-ring-side { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.token-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; }
.token-row .k { color: var(--color-text-secondary); white-space: nowrap; }
.token-row .v { color: var(--color-text-primary); font-variant-numeric: tabular-nums; text-align: right; }
.token-row--sub .k { color: var(--color-text-tertiary, #999); padding-left: 6px; }
.token-row--sub .v { color: var(--color-text-secondary); }
/* 缓存命中区（上分隔线 + 命中比例小条） */
.token-panel__cache { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--color-border-primary, #e0e0e0); padding-top: 8px; margin-top: 2px; }
.cache-bar { width: 100%; height: 5px; border-radius: 2.5px; background: var(--color-bg-hover, rgba(0,0,0,0.10)); overflow: hidden; }
.cache-bar__hit { height: 100%; border-radius: 2.5px; background: #14b8a6; transition: width 0.3s ease; }
.token-note { font-size: 11px; line-height: 1.5; color: var(--color-text-tertiary, #999); border-top: 1px solid var(--color-border-primary, #e0e0e0); padding-top: 6px; margin-top: 2px; }
/* 归档动作行（占用量与归档动作同屏） */
.token-panel__action {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  margin-top: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--color-border-primary, #e0e0e0); border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-page, #fff); color: var(--color-text-secondary);
  transition: background .15s, color .15s;
}
.token-panel__action:hover:not(:disabled) { background: var(--color-bg-surface); color: var(--color-text-primary); }
.token-panel__action:disabled { opacity: 0.55; cursor: not-allowed; }
.token-panel__action-spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; display: inline-block; animation: tg-history-spin .7s linear infinite; }
@keyframes tg-history-spin { to { transform: rotate(360deg); } }

.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
