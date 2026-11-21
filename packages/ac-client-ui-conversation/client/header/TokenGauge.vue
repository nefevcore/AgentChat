// ============================================================
// client/header/TokenGauge.vue —— 上下文占用仪表（会话头 chip）
//（会话区重构自 ConversationView 内联抽取：conversation:header-widget
//  出厂贡献 order 20——direct/single 形态的 Token 仪表：头部占用 gauge
//  (26px) + 点击详情弹层（四段堆叠条 + KV 走势，cr-231）。数据面：
//  fetchSessionTokens（agents rosterApi）+ chatStore 固定开销估算 +
//  session/kv-timeline；归档入口随弹层底部。cr-1135：盘读态经锚点
//  校准比率（lastRunPrompt/tokenCount，idle 采样）吸收估算系统偏差，
//  收束/续聊切换点连续。）
// ============================================================

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { BusyRing, RingProgress, Tooltip } from '@agentchat/webui-kit';
import { useClientContext, VIEWER_ID } from 'ac-client-runtime';
import { fetchSessionTokens } from 'ac-client-ui-agents/client/rosterApi.ts';
import { downsampleKvSteps, fetchKvTimeline, type KvSample, type KvTimelinePoint } from '../tokens.ts';
import type { SingleSession } from 'ac-client-ui-singles/client';
import { useChatStore } from '../chatStore.ts';
import { estimateTokens, fmtTokenCount, gaugeViewKeyOf } from '../tokens.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ConversationView 经 SlotOutlet data 传入） */
  data: {
    /** 头部目标 Agent（direct = 激活 Agent；single = 会话承载 Agent；群 = 群主） */
    agentId?: string | null;
    /** 独立会话（非空 = single 形态，会话键 = sid） */
    single?: SingleSession | null;
    /** 会话形态（direct/single 显示仪表；group 暂隐 cr-309、pair 只读——均无仪表） */
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
  /** 压缩史（cr-1160 §2.8——弹层「压缩历史」区数据源） */
  compactions?: Array<{ domain: string; generation: number; endTs: number; summaryLen: number | null; summaryTokens?: number | null; stats: { shadowedRows?: number; estimatedTokens?: number } | null }>;
}
const sessionTokens = ref<SessionTokens | null>(null);

// ── 锚点校准比率（cr-1135 收束/续聊跳变根修）──
// 根因：displayTotal 在「run 中 = API 真实 prompt」与「收束后 = 回放估算
// +固定开销」两套异构口径间硬切换，估算器系统偏差（系数/chat 模板/
// 未取实值开销）在切换帧整体显现为跳变。修法（DSH token-meter 同思路
// 的乘法形式）：idle 采样拍上锚点 P=cache.lastRunPrompt（最近一次 API
// prompt，含系统提示/工具定义/模板全部真实开销）与盘读估算 E=tokenCount
// 同拍配对，比率 r=P/E 吸收全部系统偏差；盘读态显示 E×r——切换点按
// 构造连续（E×r=P），后续增长沿校准估算器走。归档使 E 骤缩而 P 停留
// 旧值（r 失真）——归档即清除，回落无锚点口径直到下次 run 重校准。
// 采样只在 idle 拍（turnInProgress=false）：run 中 fetch 的 P 仍是上一
// run 的（计量桶 run 收束才更新），配对失真。钳制 [0.5,4] 防病态对。
const anchorRatio = ref<number | null>(null);
function sampleAnchorRatio(st: SessionTokens): void {
  if (chatStore.turnInProgress) return;
  const p = st.cache?.lastRunPrompt ?? 0;
  if (p > 0 && st.tokenCount > 0) {
    // cr-1191 跨代断层守卫：压缩后 P（旧代末 run prompt）与 E（新代盘读）
    // 分属两代，比率病态（实测 451K/149K=3.03 落在原钳制带 [0.5,4] 内被
    // 采信 → 校准值 450K 与归档清锚值 149K 来回拉锯）。超界弃样保持
    // null（回落净估算口径），不再钳制采信。界 [0.33, 3]：正常系统偏差
    //（估算系数/固定开销）<3x，跨代断层 ≥3x——分界保守取 3。
    const r = p / st.tokenCount;
    if (r >= 0.33 && r <= 3) anchorRatio.value = r;
  }
}

async function fetchTokenBaseline(clearFirst = false) {
  // single：会话键 = sid、承载 Agent = data.agentId（元数据 agentId 空 =
  //   默认预设——不补全则后端以 sid 为 viewer 估算，占用严重偏低）；
  // direct：data.agentId（后端按对桶推导会话键）。agentId 未选 → 跳过。
  const agentId = props.data.agentId || '';
  // 群暂隐 cr-309：基线拉取一并停（隐藏后 watcher 仍在跑——不 gate 则每步
  // 终值空打一次 session/tokens）
  if (props.data.form === 'group' || !agentId || !rpc.value) return;
  if (clearFirst) sessionTokens.value = null;
  const seq = ++tokenFetchSeq; // 竞态守卫：快速切换会话时 A 的迟到响应不得覆盖 B
  try {
    const data = await fetchSessionTokens(agentId, rpc.value,
      props.data.single
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
      status: data.status ?? 'normal',
      ...(data.compactions ? { compactions: data.compactions } : {}),
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
  // idle 拍采样锚点（cr-1135；见 anchorRatio 注释）——基于同拍数据
  if (sessionTokens.value) sampleAnchorRatio(sessionTokens.value);
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
// cr-1162：切换会话时固定开销面复位（见 overheadKey 注释——本组件侧判定，
// 不碰 chatStore 全局状态：那是 TokenGauge 与 SystemPromptPanel 共用的，
// 就地清空会作废 SystemPromptPanel 正在飞的响应、让它空白且不重试）。
watch(() => props.data.agentId, () => { anchorRatio.value = null; fetchTokenBaseline(true); tokenPanelOpen.value = false; }, { immediate: true });
watch(() => props.data.single?.id, () => { anchorRatio.value = null; fetchTokenBaseline(true); tokenPanelOpen.value = false; });
watch(() => chatStore.lastStepEndAt, () => {
  fetchTokenBaseline();
  // 实时占用（cr-761）：run 进行中也拉 KV 步流——最新步 prompt 驱动占用环
  if (tokenPanelOpen.value || chatStore.turnInProgress) fetchKv();
});
watch(() => chatStore.hasMoreHistory, () => { if (!chatStore.hasMoreHistory) fetchTokenBaseline(); });
// run 收束（cr-1135）：fresh 锚点对的采样拍——usage 自报信经邮局异步入账，
// 收束帧先行；双拍重取（即时 + 800ms 迟到补采）跨过信封竞态
watch(() => chatStore.lastRunSettledAt, () => {
  fetchTokenBaseline();
  setTimeout(() => { fetchTokenBaseline(); }, 800);
});
// 归档（cr-1135）：P 停留旧值而 E 骤缩——比率失真，清除回落无锚点口径；
// cr-1191：KV 尾点同清——livePrompt 倒序捞「最近有 prompt 的点」会捞到
// 旧代 451K 尾点（归档后新 run 未起时占位旧读数）
watch(() => chatStore.sessionArchivedAt, () => {
  anchorRatio.value = null;
  kvPoints.value = [];
  fetchTokenBaseline();
});
// 会话模式/浏览器档快照变化（ChatInput 写口 bump——run 间隙生效）→ 装配面
// ── 开销归属键（cr-1162：切换会话读数不跟随的根修）──
// 根因：systemPromptContent/toolDefs 是 chatStore 全局单例（还与 SystemPromptPanel
// 共用），而本组件无锚点态分子 = tokenCount + 系统提示 + 工具定义。切换会话后
// 旧会话的开销仍留在分子里 → ①占比不跟随（只有点开弹层 refetchOverhead 才刷）
// ②读数系统性偏高。
// 判据：记下「本组件取开销时的视图键」，与当前视图键不符即视为 0（回落既有
// 「弹层从未打开 = 比例维持会话净占用」口径）。**为什么不在切换时清全局状态**：
// 那会作废 SystemPromptPanel 正在飞的请求（它有自己的切换清空+重取，L83-88），
// 造成面板空白且不重试——本组件只判自己的读数，不动共享状态。
/** 当前视图键（判据单源 = gaugeViewKeyOf，cr-1162） */
const viewKey = computed<string | null>(() => gaugeViewKeyOf(props.data));
/** 本组件最近一次取开销时的视图键（null = 从未取过——按 0 并入，与旧口径等价） */
const overheadKey = ref<string | null>(null);
/** 开销数据是否属于当前视图（false → 视为无明细，不并入分子） */
const overheadFresh = computed(() => overheadKey.value !== null && overheadKey.value === viewKey.value);

/** 重拉固定开销构成（系统提示/工具定义——打开面板/装配面变化时：人格/
 *  记忆/生效工具集都可能变化）；群形态带 gid（记忆桶/群共享记忆按 gid
 *  装配）；single/direct 传会话键——后端按会话模式/浏览器档收窄生效集
 * （程序化会话仅 run_code），估算与真实 run 的 LLM 可见面同口径 */
function refetchOverhead() {
  if (!props.data.agentId) return;
  overheadKey.value = viewKey.value; // 标记本次开销归属（cr-1162）
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
// cr-1162：只并入属于当前视图的开销（overheadFresh）——全局状态里可能是别的
// 会话留下的（切换后的旧值、或 SystemPromptPanel 为别的视图取的）。
const systemPromptTokens = computed(() =>
  overheadFresh.value ? estimateTokens(chatStore.systemPromptContent) : 0);
const toolDefsTokens = computed(() =>
  overheadFresh.value
    ? (chatStore.toolDefs as unknown[]).reduce<number>((n, d) => n + estimateTokens(JSON.stringify(d)), 0)
    : 0);
const overheadLoading = computed(() =>
  overheadFresh.value ? (chatStore.systemPromptLoading || chatStore.toolDefsLoading) : false);

/** 运行中实时占用（cr-761）：最新步的 prompt = 本步请求真实上下文 token
 *  （含 system/工具定义/全部历史/在途步——比盘读估算准且每步更新）。run
 *  进行中在场即用；收束后盘读基线（session/tokens）追上接管——两通道
 *  每步终值同拍重拉，切换无缝。 */
const livePrompt = computed(() => {
  if (!chatStore.turnInProgress) return undefined;
  for (let i = kvPoints.value.length - 1; i >= 0; i--) {
    const p = kvPoints.value[i].prompt;
    if (typeof p === 'number' && p > 0) return p;
  }
  return undefined;
});
/** 展示用总占用（cr-1135）：实时态优先（真实值）；盘读态有锚点按校准
 * 估算（E×r——r 已吸收系统提示/工具定义/模板全部固定偏差，不再叠加
 * 估算值防双计）；无锚点回落旧口径（净估算 + 固定开销实值/0） */
const displayTotal = computed(() => {
  const st = sessionTokens.value;
  if (!st) return 0;
  if (livePrompt.value !== undefined) return livePrompt.value;
  if (anchorRatio.value !== null) return Math.round(st.tokenCount * anchorRatio.value);
  return st.tokenCount + systemPromptTokens.value + toolDefsTokens.value;
});
/** 会话上下文段（四段条/aria 共源）：总量减固定开销估算（clamp ≥0）——
 * 有锚点/实时态时总量已含真实固定开销，差值即上下文净量；无锚点回落
 * 盘读净估算（与旧口径恒等） */
const contextTokens = computed(() => {
  const st = sessionTokens.value;
  if (!st) return 0;
  if (livePrompt.value !== undefined || anchorRatio.value !== null) {
    return Math.max(0, displayTotal.value - systemPromptTokens.value - toolDefsTokens.value);
  }
  return st.tokenCount;
});

/** 占用比例：分子 = displayTotal（cr-1135 三档：实时值 / 锚点校准值 /
 *  净估算+固定开销）；分母 = maxContextTokens。status 阈值档与后端
 *  session/tokens 的档位判定（<75/<90）同款（cr-122 三档收敛）。 */
const usageWithOverhead = computed(() => {
  const st = sessionTokens.value;
  if (!st) return { pct: 0, status: 'normal' as const };
  const p = Math.min(100, (displayTotal.value / st.maxContextTokens) * 100);
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
  // cr-1135：context 段与头行同 displayTotal 口径（contextTokens computed
  // 共源——实时/锚点态减固定开销估算，无锚点回落净估算）。
  const rest = Math.max(0, st.maxContextTokens - displayTotal.value);
  return [
    { key: 'tooldefs', label: '工具定义', tokens: toolDefsTokens.value, color: '#ecc59a' },
    { key: 'sysprompt', label: '系统提示词', tokens: systemPromptTokens.value, color: '#c9a7ec' },
    { key: 'context', label: '会话上下文', tokens: contextTokens.value, color: '#8fb8e6' },
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
/** 走势代表点（cr-311 min-max 降采样）：x 定位用原始步号 i——超限降采样后
 *  横向比例仍与全量一致；hover 显示真实步号。empty = 无计量（null 不绘点）。
 *  ≤440 点直通，走势形状分毫不变。 */
const kvSamples = computed(() => downsampleKvSteps(kvPoints.value));

// sparkline 几何（等距步序号；逻辑宽 220 = 面板 min-width 248 - padding 28——
// 与容器同尺寸避免 preserveAspectRatio="none" 的非均匀拉伸歪描边）
const kvView = { W: 220, H: 44, padT: 4, padB: 4 } as const;
// x 定位基准 = 原始步号全域（kvPoints 长度，非样本数）：降采样后样本稀疏段
// 仍按真实步序落位，首末样本贴边框两端（0 与 W）
const kvCx = (i: number): number => {
  const n = kvPoints.value.length;
  if (n <= 1) return kvView.W / 2;
  return (i / (n - 1)) * kvView.W;
};
const kvCy = (rate: number): number => {
  const inner = kvView.H - kvView.padT - kvView.padB;
  return kvView.padT + (1 - rate) * inner;
};
/** 95% 健康基准虚线（cr-243：使用情况定——命中率跌破即缓存接近
 *  失效；50% 弱线已删（cr-244：太浅未察觉——信息价值低于视觉噪音）） */
const kvGridY = [{ y: kvCy(0.95) }];
/** 折线段数组：empty 样本断线——无计量的步不连线糊弄（cr-311 降采样后占位语义不变） */
const kvPolyline = computed(() => {
  const segs: string[] = [];
  let cur: string[] = [];
  kvSamples.value.forEach((s) => {
    if (s.empty) {
      if (cur.length > 1) segs.push(cur.join(' '));
      cur = [];
    } else {
      const total = s.hit + s.miss;
      cur.push(`${kvCx(s.i).toFixed(2)},${kvCy(s.hit / total).toFixed(2)}`);
    }
  });
  if (cur.length > 1) segs.push(cur.join(' '));
  return segs;
});
/** hover 样本索引（-1 = 无）：mousemove 在 svg 上捕获，按原始步号反推最近样本 */
const kvHoverIdx = ref(-1);
function onKvMove(e: MouseEvent): void {
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const total = kvPoints.value.length;
  if (total <= 1) { kvHoverIdx.value = 0; return; }
  // 原始步号 → 样本索引：取 |x(i) - 鼠标x| 最小者（样本按 i 升序，可提前终止）
  const stepNo = frac * (total - 1);
  let best = 0, bestD = Infinity;
  for (let k = 0; k < kvSamples.value.length; k++) {
    const d = Math.abs(kvSamples.value[k].i - stepNo);
    if (d < bestD) { bestD = d; best = k; }
    if (kvSamples.value[k].i > stepNo + 1) break;
  }
  kvHoverIdx.value = best;
}
/** hover 提示文案（kit Tooltip 即显；无 hover = 引导语）。样本反查用原始步号域：
 *  kvHoverIdx(-1) 越界在 TS 索引签名上不可判空——noUncheckedIndexedAccess 关闭时
 *  索引访问恒非空，判空即 no-unnecessary-condition（cr-311 踩坑） */
const kvHoverText = computed(() => {
  if (kvHoverIdx.value < 0) return 'hover 查看各步命中率';
  const s = kvSamples.value[kvHoverIdx.value];
  const rateText = s.empty ? '无计量' : `${((s.hit / (s.hit + s.miss)) * 100).toFixed(1)}%`;
  return `步 #${s.i + 1} · ${rateText} · ${kvTimeOf(s.ts)}`;
});
function kvTimeOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 压缩对话：触发 Agent 整理记忆后裁剪消息 */
function handleCompress() {
  if (!props.data.agentId || chatStore.turnInProgress || chatStore.compressPending) return;
  chatStore.archiveSession();
}

/** 形态 gate：direct/single 且有会话数据时渲染（pair 只读无仪表；群暂隐
 *  cr-309——占用/KV 走势按群主/群 gid 单视角聚合多 agent 步流，展示口径
 *  待重定，想清后恢复） */
const applicable = computed(() =>
  (props.data.form === 'direct' || props.data.form === 'single')
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
         （占用比例分子 = displayTotal 三档口径；cr-1135 锚点校准值已含固定开销） -->
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
            <span class="token-bar-limit">{{ livePrompt !== undefined || anchorRatio !== null ? '' : '~' }}{{ fmtTokenCount(displayTotal) }} / {{ fmtTokenCount(sessionTokens!.maxContextTokens) }}</span>
          </div>
          <div
            class="token-stack"
            role="img"
            :aria-label="`上下文占用 ${Math.round(usageWithOverhead.pct)}%（会话上下文 ${fmtTokenCount(contextTokens)} + 系统提示词 ~${fmtTokenCount(systemPromptTokens)} + 工具定义 ~${fmtTokenCount(toolDefsTokens)} / 上限 ${fmtTokenCount(sessionTokens!.maxContextTokens)}）`"
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
        <template v-if="kvSamples.length > 0 || kvLoading">
          <div class="token-panel__cache">
            <!-- KV 缓存率走势（cr-231/232 步粒度）：等距步序号，X = 步序，Y = 命中率；
                 hover 竖线 + 数值气泡（时间/命中率进 meta——步间隔不均，
                 序号等距避免长间隔把最近走势挤扁） -->
            <div v-if="kvLoading" class="kv-spark kv-spark--loading"><BusyRing :size="13" label="正在拉取 KV 缓存走势…" /></div>
            <div v-else-if="kvSamples.length > 0" class="kv-spark">
              <span class="kv-spark__label">KV 缓存率走势 · 全部 {{ kvPoints.length }} 步<template v-if="kvSamples.length < kvPoints.length">（{{ kvSamples.length }} 代表点）</template></span>
              <Tooltip :text="kvHoverText" placement="bottom">
                <svg
                  class="kv-spark__svg"
                  :viewBox="`0 0 ${kvView.W} ${kvView.H}`"
                  role="img"
                  aria-label="KV 缓存命中率走势（最近若干步）"
                  @mousemove="onKvMove"
                  @mouseleave="kvHoverIdx = -1"
                >
                  <line v-for="g in kvGridY" :key="g.y" class="kv-spark__grid is-base" :x1="0" :y1="g.y" :x2="kvView.W" :y2="g.y" />
                  <polyline v-for="(seg, si) in kvPolyline" :key="si" class="kv-spark__line" :points="seg" />
                  <!-- 单点圆标记：折线段需 ≥2 点，单计量步无折线可画（cr-235 删点
                       针对多步走势噪点——此处是唯一视觉表达，不属该裁决辖域） -->
                  <circle
                    v-if="kvSamples.length === 1 && !kvSamples[0].empty"
                    class="kv-spark__dot"
                    :cx="kvCx(0)"
                    :cy="kvCy(kvSamples[0].hit / (kvSamples[0].hit + kvSamples[0].miss))"
                    r="2"
                  />

                  <line v-if="kvHoverIdx >= 0 && kvSamples[kvHoverIdx]" class="kv-spark__cursor" :x1="kvCx(kvSamples[kvHoverIdx].i)" :y1="kvView.padT" :x2="kvCx(kvSamples[kvHoverIdx].i)" :y2="kvView.H - kvView.padB" />
                </svg>
              </Tooltip>
            </div>
          </div>
        </template>

        <!-- 压缩历史（cr-1160 §2.8）：每代一行——时刻/压缩前估算/shadowed 行数；
             无压缩事件的会话不渲染 -->
        <template v-if="sessionTokens?.compactions?.length">
          <div class="token-panel__compactions">
            <span class="compactions-label">压缩历史 · {{ sessionTokens.compactions.length }} 轮</span>
            <div v-for="c in sessionTokens.compactions" :key="c.domain + c.generation" class="compactions-row">
              <span class="compactions-gen">#{{ c.generation }}</span>
              <span class="compactions-at">{{ kvTimeOf(c.endTs) }}</span>
              <span class="compactions-stats">{{ c.summaryLen === null ? '概要未更新' : (c.summaryTokens != null ? '概要 ~' + fmtTokenCount(c.summaryTokens) : '') }}{{ c.stats?.shadowedRows != null ? ' · 移出 ' + c.stats.shadowedRows + ' 行' : '' }}</span>
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
/* 压缩历史区（cr-1160 §2.8——上分隔线同款） */
.token-panel__compactions { display: flex; flex-direction: column; gap: 3px; border-top: 1px solid var(--line-strong); padding-top: 8px; margin-top: 2px; }
.compactions-label { font-size: 10px; color: var(--text-3); }
.compactions-row { display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.compactions-gen { color: var(--text-3); min-width: 22px; }
.compactions-at { min-width: 84px; }
.compactions-stats { margin-left: auto; text-align: right; }

/* 缓存命中区（上分隔线） */
.token-panel__cache { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line-strong); padding-top: 8px; margin-top: 2px; }
/* KV 缓存率走势（cr-231）：等距 run 序号 sparkline；线 = ok 状态档（缓存好=绿）
   与命中条同语义；50% 参考线 = 弱线 */
.kv-spark { display: flex; flex-direction: column; gap: 3px; }
.kv-spark--loading { align-items: flex-start; }
.kv-spark__label { font-size: 10px; color: var(--text-3); }
.kv-spark__svg { display: block; width: 100%; height: 44px; }
/* 95% 健康基准虚线（唯一参考线，cr-244 删 50% 弱线） */
.kv-spark__grid.is-base { stroke: var(--line-strong); stroke-width: 1; stroke-dasharray: 3 2; }
.kv-spark__line { fill: none; stroke: var(--ok-status); stroke-width: 1.5; stroke-linejoin: round; }

.kv-spark__cursor { stroke: var(--primary); stroke-width: 0.8; }
.kv-spark__dot { fill: var(--ok-status); }
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
