// ============================================================
// client/header/TokenGauge.vue —— 上下文占用仪表（会话头 chip）
//（会话区重构自 ConversationView 内联抽取：conversation:header-widget
//  出厂贡献 order 20——direct/single 形态的 Token 仪表：头部占用 gauge
//  (26px) + 点击详情弹层（四段堆叠条 + KV 走势，cr-231）。数据面：
//  fetchSessionTokens（agents rosterApi）+ chatStore 固定开销估算 +
//  session/kv-timeline；归档入口随弹层底部。）
// ============================================================

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { BusyRing, RingProgress, Tooltip } from '@agentchat/webui-kit';
import { useClientContext, VIEWER_ID } from 'ac-client-runtime';
import { fetchSessionTokens } from 'ac-client-ui-agents/client/rosterApi.ts';
import { fetchKvTimeline, type KvTimelinePoint } from '../tokens.ts';
import type { SingleSession } from 'ac-client-ui-singles/client';
import { useChatStore } from '../chatStore.ts';
import { estimateTokens, fmtTokenCount } from '../tokens.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ConversationView 经 SlotOutlet data 传入） */
  data: {
    /** 头部目标 Agent（direct = 激活 Agent；single = 会话承载 Agent；群 = 群主） */
    agentId?: string | null;
    /** 独立会话（非空 = single 形态，会话键 = sid） */
    single?: SingleSession | null;
    /** 会话形态（direct/single/group 显示仪表；pair 只读无仪表） */
    form?: 'direct' | 'group' | 'single' | 'pair';
    /** 会话键（群 = gid——按群主视角分析） */
    conversationId?: string | null;
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
  avgTokensPerMsg: number; estimatedMsgsRemaining: number; status: 'normal' | 'high' | 'critical';
  cache?: SessionTokensCache;
}
const sessionTokens = ref<SessionTokens | null>(null);

async function fetchTokenBaseline(clearFirst = false) {
  // single：会话键 = sid、承载 Agent = data.agentId（元数据 agentId 空 =
  //   默认预设——不补全则后端以 sid 为 viewer 估算，占用严重偏低）；
  // group：会话键 = gid、Agent = 群主（后端群分支按群主视角 historyFor 估算
  //   ——每成员上下文 = 同一群本体按读者派生，群主是代表读者）；
  // direct：data.agentId（后端按对桶推导会话键）。agentId 未选 → 跳过。
  const agentId = props.data.agentId || '';
  if (!agentId || !rpc.value) return;
  if (clearFirst) sessionTokens.value = null;
  const seq = ++tokenFetchSeq; // 竞态守卫：快速切换会话时 A 的迟到响应不得覆盖 B
  try {
    const data = await fetchSessionTokens(agentId, rpc.value,
      props.data.single
        ? { conversationId: props.data.single.id, agentId }
        : props.data.form === 'group' && props.data.conversationId
          ? { conversationId: props.data.conversationId, agentId }
          : undefined);
    if (seq !== tokenFetchSeq) return;
    sessionTokens.value = {
      tokenCount: data.tokenCount ?? 0,
      messageCount: data.messageCount ?? 0,
      maxContextTokens: data.maxContextTokens ?? 1_000_000,
      usagePercent: data.usagePercent ?? 0,
      avgTokensPerMsg: data.avgTokensPerMsg ?? 0,
      estimatedMsgsRemaining: data.estimatedMsgsRemaining ?? 0,
      status: data.status ?? 'normal',
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

// 重取时机（自内核原样迁入）：目标 Agent 切换 / single 切换 / 步终值
// （loop/after-step——工具步先于工具执行，长工具运行中即重取；此前挂
// after-run 要等整轮收束）/ 历史拉尽（估算口径补全）/ 归档完成（compact
// 重写会话——无 run 结束）
watch(() => props.data.agentId, () => { fetchTokenBaseline(true); tokenPanelOpen.value = false; }, { immediate: true });
watch(() => props.data.single?.id, () => { fetchTokenBaseline(true); tokenPanelOpen.value = false; });
watch(() => chatStore.lastStepEndAt, () => { fetchTokenBaseline(); if (tokenPanelOpen.value) fetchKv(); });
watch(() => chatStore.hasMoreHistory, () => { if (!chatStore.hasMoreHistory) fetchTokenBaseline(); });
watch(() => chatStore.sessionArchivedAt, () => { fetchTokenBaseline(); });
// 会话模式/浏览器档快照变化（ChatInput 写口 bump——run 间隙生效）→ 装配面
/** 重拉固定开销构成（系统提示/工具定义——打开面板/装配面变化时：人格/
 *  记忆/生效工具集都可能变化）；群形态带 gid（记忆桶/群共享记忆按 gid
 *  装配）；single/direct 传会话键——后端按会话模式/浏览器档收窄生效集
 * （程序化会话仅 run_code），估算与真实 run 的 LLM 可见面同口径 */
function refetchOverhead() {
  if (!props.data.agentId) return;
  const convId = props.data.form === 'group'
    ? props.data.conversationId
    : props.data.single?.id ?? undefined;
  // direct 不传 convId（后端按 viewer 对桶键推导——requestSystemPrompt 同口径）
  if (convId) {
    chatStore.requestSystemPrompt(props.data.agentId, { conversationId: convId });
    chatStore.requestToolDefs(props.data.agentId, { conversationId: convId });
  } else {
    chatStore.requestSystemPrompt(props.data.agentId);
    chatStore.requestToolDefs(props.data.agentId);
  }
}
function toggleTokenPanel() {
  tokenPanelOpen.value = !tokenPanelOpen.value;
  if (tokenPanelOpen.value) {
    refetchOverhead();
    fetchKv();
    // 点击外部关闭（gauge 点击带 .stop 不触达 document）
    setTimeout(() => document.addEventListener('click', closeTokenPanel, { once: true }), 0);
  }
}
// 会话模式/浏览器档快照变化（ChatInput 写口 bump——run 间隙生效）→ 装配面
// 已变（工具 schema/SDK 投影块进/出）；面板开着则立即重拉固定开销构成
watch(() => [chatStore.convToolMode, chatStore.convBrowserTier] as const, () => {
  if (tokenPanelOpen.value) refetchOverhead();
});
function closeTokenPanel() { tokenPanelOpen.value = false; }

// ── 固定开销（≈ 展示口径：与后端 ac-text-budget 同款字符估算）──
// 弹层打开时经 agents/system-prompt（before-run 三档干跑——与真实 run
// 同源装配）+ agents/tool-defs（router 同口径生效集）取实值估算；未打开
// 时为 0。计数行恒示实值；占用比例按 "若有取实值，否则 0" 并入——避免
// 每步重取干跑（开销大），也不虚假抬高占用（弹层从未打开 = 用户未看过
// 明细，比例维持会话净占用）。
const systemPromptTokens = computed(() => estimateTokens(chatStore.systemPromptContent));
const toolDefsTokens = computed(() =>
  (chatStore.toolDefs as unknown[]).reduce<number>((n, d) => n + estimateTokens(JSON.stringify(d)), 0));
const overheadLoading = computed(() => chatStore.systemPromptLoading || chatStore.toolDefsLoading);

/** 占用比例（含固定开销）：分子 = 会话净占用 + 系统提示/工具定义实值
 *  估算（未取 = 0）；分母 = maxContextTokens。status 阈值档与后端
 *  session/tokens 的档位判定（<75/<90）同款（cr-122 三档收敛）。 */
const usageWithOverhead = computed(() => {
  const st = sessionTokens.value;
  if (!st) return { pct: 0, status: 'normal' as const };
  const total = st.tokenCount + systemPromptTokens.value + toolDefsTokens.value;
  const p = Math.min(100, (total / st.maxContextTokens) * 100);
  const s = p < 75 ? 'normal' : p < 90 ? 'high' : 'critical';
  return { pct: p, status: s as SessionTokens['status'] };
});

/** 四段堆叠条（cr-231；cr-234 三轮反馈定案）：视觉从左到右 = 工具定义 →
 *  系统提示词 → 会话上下文 → 余量——固定开销紧贴上限一侧（装配面开销
 *  相对恒定，靠近「总量」侧与头行 ~占用/上限 的减法语义对齐）。色带取
 *  星色板（starColor nebula 档）浅淡 hex 直取——刻意脱离语义色/tt-* 体系
 *  （用户指定，非身份派生不参与哈希）；余量段透明但占位（条不满宽 =
 *  真实占比，恒 100% 会丢掉「还剩多少」的直觉）。固定开销未取实值按 0
 *  并入（与 usageWithOverhead 同口径）；微段保底 2px 可见（flex-grow 真比例
 *  + flex-basis 2px——大段正常、微段不消失）。 */
const stackSegments = computed(() => {
  const st = sessionTokens.value;
  if (!st) return [];
  const used = st.tokenCount + systemPromptTokens.value + toolDefsTokens.value;
  const rest = Math.max(0, st.maxContextTokens - used);
  return [
    { key: 'tooldefs', label: '工具定义', tokens: toolDefsTokens.value, color: '#ecc59a' },
    { key: 'sysprompt', label: '系统提示词', tokens: systemPromptTokens.value, color: '#c9a7ec' },
    { key: 'context', label: '会话上下文', tokens: st.tokenCount, color: '#8fb8e6' },
    { key: 'rest', label: '余量', tokens: rest, color: '' },
  ];
});

// ── KV 缓存率走势（cr-231）：弹层打开时拉取，等距 run 序号 ──
const kvPoints = ref<KvTimelinePoint[]>([]);
/** 懒加载态（cr-236 #2）：开面板首拉期间转圈；完成前走势区不渲染 */
const kvLoading = ref(false);
/** 走势桶键：与 fetchTokenBaseline 同款推导（direct 对桶 / single sid / group gid） */
const kvConversationId = computed(() =>
  props.data.single?.id
  ?? (props.data.form === 'group' ? props.data.conversationId : undefined)
  ?? (props.data.agentId ? [VIEWER_ID.value, props.data.agentId].sort().join('~') : null));
let kvFetchSeq = 0;
async function fetchKv() {
  const convId = kvConversationId.value;
  if (!convId || !rpc.value) { kvPoints.value = []; kvLoading.value = false; return; }
  const seq = ++kvFetchSeq;
  kvLoading.value = true;
  try {
    const points = await fetchKvTimeline(convId, rpc.value);
    if (seq !== kvFetchSeq) return; // 竞态守卫（同 tokenFetchSeq）
    kvPoints.value = points;
  } catch { /* 失败保留旧值 */ }
  finally { if (seq === kvFetchSeq) kvLoading.value = false; }
}
/** 走势点视图模型（cr-232 步粒度）：命中率 0~1（hit+miss=0 的步无计量 → null 不绘点） */
const kvRatePoints = computed(() =>
  kvPoints.value.map((p) => {
    const total = p.hit + p.miss;
    return total > 0 ? p.hit / total : null;
  }));

// sparkline 几何（等距 run 序号；逻辑宽 220 = 面板 min-width 248 - padding 28——
// 与容器同尺寸避免 preserveAspectRatio="none" 的非均匀拉伸歪描边）
const kvView = { W: 220, H: 44, padT: 4, padB: 4 } as const;
const kvCx = (i: number): number => {
  const n = kvRatePoints.value.length;
  if (n <= 1) return kvView.W / 2;
  return (i / (n - 1)) * kvView.W;
};
const kvCy = (rate: number): number => {
  const inner = kvView.H - kvView.padT - kvView.padB;
  return kvView.padT + (1 - rate) * inner;
};
/** 参考虚线（0/1 线即上下边界不画）：50% 弱线 +
 *  95% 健康基准线（cr-243：使用情况定——命中率跌破即缓存接近失效，与 50% 线同在但描边加粗区分） */
const kvGridY = [
  { y: kvCy(0.5), kind: 'half' },
  { y: kvCy(0.95), kind: 'base' },
];
/** 折线段数组：null 点断线——无数据的 run 不连线糊弄 */
const kvPolyline = computed(() => {
  const segs: string[] = [];
  let cur: string[] = [];
  kvRatePoints.value.forEach((r, i) => {
    if (r === null) {
      if (cur.length > 1) segs.push(cur.join(' '));
      cur = [];
    } else {
      cur.push(`${kvCx(i).toFixed(2)},${kvCy(r).toFixed(2)}`);
    }
  });
  if (cur.length > 1) segs.push(cur.join(' '));
  return segs;
});
/** hover 索引（-1 = 无）：mousemove 在 svg 上捕获，等距反推序号 */
const kvHoverIdx = ref(-1);
function onKvMove(e: MouseEvent): void {
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const n = kvRatePoints.value.length;
  kvHoverIdx.value = Math.round(frac * (n - 1));
}
/** hover 提示文案（kit Tooltip 即显；无 hover = 引导语） */
const kvHoverText = computed(() => {
  const i = kvHoverIdx.value;
  if (i < 0) return 'hover 查看各步命中率';
  const rate = kvRatePoints.value[i];
  const rateText = rate === null ? '无计量' : `${(rate * 100).toFixed(1)}%`;
  return `步 #${i + 1} · ${rateText} · ${kvTimeOf(i)}`;
});
function kvTimeOf(i: number): string {
  const ts = kvPoints.value[i]?.ts;
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 压缩对话：触发 Agent 整理记忆后裁剪消息 */
function handleCompress() {
  if (!props.data.agentId || chatStore.turnInProgress || chatStore.compressPending) return;
  chatStore.compressSession();
}

/** 形态 gate：direct/single/群且有会话数据时渲染（群 = 群主视角占用；
 *  pair 只读无仪表） */
const applicable = computed(() =>
  (props.data.form === 'direct' || props.data.form === 'single' || props.data.form === 'group')
  && !!sessionTokens.value && sessionTokens.value.messageCount > 0);
</script>

<template>
  <div
    v-if="applicable"
    class="session-token-gauge"
    :class="{ 'is-open': tokenPanelOpen }"
    role="button"
    :aria-label="`上下文占用 ${Math.round(usageWithOverhead.pct)}% · 点击查看详情`"
    @click.stop="toggleTokenPanel()"
  >
    <!-- 环形进度条：占用率在环中心，语义色随状态（低→临界）
         （占用比例含系统提示/工具定义固定开销——值取后实值并入，未取 = 0） -->
    <!-- title 挂触发区（环）而非含弹层的根节点（cr-239：弹层内悬停会弹原生 title 与 kit Tooltip 同屏双显）；读屏语义由根节点 aria-label 承担 -->
    <RingProgress
      class="gauge-ring"
      :title="`上下文占用 ${Math.round(usageWithOverhead.pct)}% · 点击查看详情`"
      :tone="usageWithOverhead.status"
      :value="usageWithOverhead.pct"
      :size="26"
      :stroke="3"
    >
      <span class="gauge-ring-pct" :class="usageWithOverhead.status">{{ Math.round(usageWithOverhead.pct) }}</span>
    </RingProgress>
    <transition name="fade">
      <div v-if="tokenPanelOpen" class="token-panel" @click.stop>
        <!-- 四段水平堆叠条（cr-231；cr-232 反馈迭代）：头行 = 占用率 + 占用/上限；
             条 = 真比例 flex-grow + 微段 2px 保底；图例一例一行（数值随段色） -->
        <div class="token-panel__bar-row">
          <div class="token-bar-topline">
            <span class="token-bar-pct">上下文占用 <strong>{{ Math.round(usageWithOverhead.pct) }}%</strong></span>
            <span class="token-bar-limit">~{{ fmtTokenCount(sessionTokens!.tokenCount + systemPromptTokens + toolDefsTokens) }} / {{ fmtTokenCount(sessionTokens!.maxContextTokens) }}</span>
          </div>
          <div
            class="token-stack"
            role="img"
            :aria-label="`上下文占用 ${Math.round(usageWithOverhead.pct)}%（会话上下文 ${fmtTokenCount(sessionTokens!.tokenCount)} + 系统提示词 ~${fmtTokenCount(systemPromptTokens)} + 工具定义 ~${fmtTokenCount(toolDefsTokens)} / 上限 ${fmtTokenCount(sessionTokens!.maxContextTokens)}）`"
          >
            <div
              v-for="(seg, i) in stackSegments"
              :key="seg.key"
              class="token-stack__seg"
              :class="{ 'is-rest': seg.key === 'rest', 'is-gap-before': i > 0 }"
              :style="{ flexGrow: Math.max(seg.tokens, 0.001), flexBasis: '2px', ...(seg.color ? { background: seg.color } : {}) }"
              :title="`${seg.label} ${seg.key === 'rest' ? fmtTokenCount(seg.tokens) : overheadLoading && seg.key !== 'context' ? '…' : '~ ' + fmtTokenCount(seg.tokens)}`"
            ></div>
          </div>
          <div class="token-legend">
            <div v-for="seg in stackSegments" :key="seg.key" class="token-legend__row">
              <span class="token-legend__name"><i class="token-legend__dot" :style="seg.color ? { background: seg.color } : {}"></i>{{ seg.label }}</span>
              <span class="token-legend__val">{{ seg.key === 'rest' ? fmtTokenCount(seg.tokens) : overheadLoading && seg.key !== 'context' ? '…' : `~ ${fmtTokenCount(seg.tokens)}` }}</span>
            </div>
          </div>
        </div>
        <!-- KV 缓存区（cr-232 反馈：原「最近一次」行已被走势覆盖删除）：走势 +
             本会话累计。命中部分按服务商折扣价计费。 -->
        <template v-if="kvRatePoints.length > 0 || kvLoading">
          <div class="token-panel__cache">
            <!-- KV 缓存率走势（cr-231/232 步粒度）：等距步序号，X = 步序，Y = 命中率；
                 hover 竖线 + 数值气泡（时间/命中率进 meta——步间隔不均，
                 序号等距避免长间隔把最近走势挤扁） -->
            <div v-if="kvLoading" class="kv-spark kv-spark--loading"><BusyRing :size="13" label="正在拉取 KV 缓存走势…" /></div>
            <div v-else-if="kvRatePoints.length > 1" class="kv-spark">
              <span class="kv-spark__label">KV 缓存率走势 · 全部 {{ kvRatePoints.length }} 步</span>
              <Tooltip :text="kvHoverText" placement="bottom">
                <svg
                  class="kv-spark__svg"
                  :viewBox="`0 0 ${kvView.W} ${kvView.H}`"
                  role="img"
                  aria-label="KV 缓存命中率走势（最近若干步）"
                  @mousemove="onKvMove"
                  @mouseleave="kvHoverIdx = -1"
                >
                  <line v-for="g in kvGridY" :key="g.kind" class="kv-spark__grid" :class="`is-${g.kind}`" :x1="0" :y1="g.y" :x2="kvView.W" :y2="g.y" />
                  <polyline v-for="(seg, si) in kvPolyline" :key="si" class="kv-spark__line" :points="seg" />

                  <line v-if="kvHoverIdx >= 0" class="kv-spark__cursor" :x1="kvCx(kvHoverIdx)" :y1="kvView.padT" :x2="kvCx(kvHoverIdx)" :y2="kvView.H - kvView.padB" />
                </svg>
              </Tooltip>
            </div>
          </div>
        </template>

        <!-- 归档入口：占用量与归档动作同屏——超阈值时顺手整理；run 进行中/整理中禁用。
             群形态不显示（群归档走后端轮转：达阈值先给群主跑 [群归档整理] run） -->
        <Tooltip
          v-if="props.data.form !== 'group'"
          :text="chatStore.compressPending ? '正在归档整理记忆…' : chatStore.turnInProgress ? '回复进行中，结束后再归档' : '归档对话：先整理记忆，再归档早期消息'"
          placement="top"
        >
          <button
            class="token-panel__action"
            :disabled="chatStore.turnInProgress || chatStore.compressPending"
            :aria-label="chatStore.compressPending ? '正在归档整理记忆…' : chatStore.turnInProgress ? '回复进行中，结束后再归档' : '归档对话：先整理记忆，再归档早期消息'"
            @click="handleCompress()"
          >
            <svg v-if="!chatStore.compressPending" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
            <BusyRing v-else :size="13" />
            {{ chatStore.compressPending ? '正在归档整理记忆…' : '归档对话' }}
          </button>
        </Tooltip>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.session-token-gauge { position: relative; display: flex; align-items: center; gap: 6px; padding: 2px 4px; flex-shrink: 0; cursor: pointer; border-radius: var(--radius-sm); }
.session-token-gauge:hover, .session-token-gauge.is-open { background: var(--bg-surface); }
/* 头部环形占用（数值在环心，单位 % 省略——title 补全语义） */
.gauge-ring { display: block; }
.gauge-ring-pct { font-size: 9px; font-weight: 700; font-variant-numeric: tabular-nums; }
.gauge-ring-pct.normal { color: var(--ok-status); }
.gauge-ring-pct.high { color: var(--warn-status); }
.gauge-ring-pct.critical { color: var(--err-status); }

/* Token 详情弹层（点击仪表盘展开，悬挂于头部下方——不与相邻控件重叠） */
.token-panel {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
  min-width: 248px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
  background: var(--bg-base); border: 1px solid var(--line-strong);
  border-radius: var(--radius-md, 10px); box-shadow: var(--shadow-pop);
  cursor: default; text-align: left;
}

/* 四段堆叠条区（cr-231；cr-232 反馈迭代）：头行（11px 对齐图例字号）+ 6px 条 + 一例一行图例 */
.token-panel__bar-row { display: flex; flex-direction: column; gap: 5px; padding: 2px 0; }
.token-bar-topline { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
/* 头行（cr-235 #3）：「上下文占用」常规字重（text-2），数值 strong 加粗（text-1） */
.token-bar-pct { font-size: 11px; font-weight: 400; color: var(--text-2); font-variant-numeric: tabular-nums; }
.token-bar-pct strong { font-weight: 700; color: var(--text-1); }
.token-bar-limit { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.token-stack { display: flex; width: 100%; height: 6px; border-radius: 3px; overflow: hidden; background: var(--bg-inset); }
/* 段 = 真比例 flex-grow（token 数）+ flex-basis 2px 微段保底；段色 = 星色板
   hex 内联（cr-234 #2：浅淡色带，用户指定脱离令牌体系）；余量段透明占位
   （底色即余量视觉）；段间 1.5px 缝（is-gap-before margin，底色透出成缝） */
.token-stack__seg { flex-shrink: 1; }
.token-stack__seg.is-rest { background: transparent !important; }
.token-stack__seg.is-gap-before { margin-left: 1.5px; }
.token-legend { display: flex; flex-direction: column; gap: 2px; }
.token-legend__row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11px; }
.token-legend__name { color: var(--text-2); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
/* 数值色降一档 text-2（cr-241：与键名同档，颜色只留色点一个通道）；色点 = 段同色内联 */
.token-legend__val { color: var(--text-2); font-variant-numeric: tabular-nums; }
.token-legend__dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; background: var(--bg-inset); }
.token-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; }
.token-row .k { color: var(--text-2); white-space: nowrap; }
.token-row .v { color: var(--text-1); font-variant-numeric: tabular-nums; text-align: right; }
.token-row--sub .k { color: var(--text-3); padding-left: 6px; }
.token-row--sub .v { color: var(--text-2); }
/* 缓存命中区（上分隔线） */
.token-panel__cache { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line-strong); padding-top: 8px; margin-top: 2px; }
/* KV 缓存率走势（cr-231）：等距 run 序号 sparkline；线 = ok 状态档（缓存好=绿）
   与命中条同语义；50% 参考线 = 弱线 */
.kv-spark { display: flex; flex-direction: column; gap: 3px; }
.kv-spark--loading { align-items: flex-start; }
.kv-spark__label { font-size: 10px; color: var(--text-3); }
.kv-spark__svg { display: block; width: 100%; height: 44px; }
.kv-spark__grid { stroke: var(--line); stroke-width: 0.5; stroke-dasharray: 2 2; }
/* 95% 健康基准线比 50% 弱参考线强一档（描边提亮 + 线宽翻倍） */
.kv-spark__grid.is-base { stroke: var(--line-strong); stroke-width: 1; stroke-dasharray: 3 2; }
.kv-spark__line { fill: none; stroke: var(--ok-status); stroke-width: 1.5; stroke-linejoin: round; }

.kv-spark__cursor { stroke: var(--primary); stroke-width: 0.8; }
/* Tooltip 根（.ui-tip inline-flex）随走势块拉满——svg 与提示锚同宽 */
.kv-spark :deep(.ui-tip) { width: 100%; }

/* 归档动作行（占用量与归档动作同屏；cr-233 #4 填满面板宽——Tooltip 根
   同步拉满，按钮 100%） */
/* 归档行上缘分割线（cr-238 #2：与走势图分隔；随归档行 v-if 同显隐） */
.token-panel :deep(.ui-tip:last-of-type) { width: 100%; margin-top: 4px; border-top: 1px solid var(--line-strong); padding-top: 8px; }
.token-panel__action {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 6px 10px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--line-strong); border-radius: var(--radius-sm, 6px);
  background: var(--bg-base); color: var(--text-2);
  transition: background .15s, color .15s;
}
.token-panel__action:hover:not(:disabled) { background: var(--bg-surface); color: var(--text-1); }
.token-panel__action:disabled { opacity: 0.55; cursor: not-allowed; }

.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
