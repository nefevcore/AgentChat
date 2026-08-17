<script setup lang="ts">
import { ref, watch, computed, onUnmounted, nextTick } from 'vue';
import { useAgentStore } from '../stores/agents';
import { useThemeStore } from '../stores/theme';
import { Chart, BarElement, BarController, CategoryScale, LinearScale, Legend, Tooltip, Title } from 'chart.js';
import { chord, ribbon } from 'd3-chord';
import Modal from '../ui/Modal.vue';
import Button from '../ui/Button.vue';
import { fetchUsageTokens, type UsageRangeParams } from '../core/api/endpoints/system';

Chart.register(BarElement, BarController, CategoryScale, LinearScale, Legend, Tooltip, Title);

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const agentStore = useAgentStore();
const themeStore = useThemeStore();

interface AgentUsage {
  agent: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_steps: number;
  total_cache_hit: number;
  total_cache_miss: number;
  total_cache_hit_count: number;
  total_cache_miss_count: number;
  record_count: number;
  last_used: string;
}

interface DailyUsage {
  date: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  record_count: number;
}

/** 按 LLM 模型聚合的用量 */
interface LlmUsage {
  llm: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_steps: number;
  total_cache_hit: number;
  total_cache_miss: number;
  total_cache_hit_count: number;
  total_cache_miss_count: number;
  record_count: number;
  last_used: string;
}

/** 按 agent 对聚合的用量（云图连接线） */
interface PairUsage {
  a: string;
  b: string;
  total_tokens: number;
  record_count: number;
}

interface UsageSummary {
  overall: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_react_steps: number;
    total_cache_hit: number;
    total_cache_miss: number;
    total_cache_hit_count: number;
    total_cache_miss_count: number;
    total_records: number;
  };
  by_agent: AgentUsage[];
  by_day: DailyUsage[];
  by_llm: LlmUsage[];
  by_pair: PairUsage[];
  /** 数据实际覆盖的日期区间（后端按筛选范围返回） */
  range?: { from: string | null; to: string | null };
}

const loading = ref(false);
const error = ref('');
const data = ref<UsageSummary | null>(null);
const activeTab = ref<'agents' | 'daily' | 'llm' | 'cloud'>('cloud');
/** 弦图：是否包含 user / self（自己↔自己）流量（默认排除，聚焦 Agent 间协作） */
const includeUserSelf = ref(false);
/** 上次成功刷新时间 */
const lastUpdated = ref('');
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const AUTO_REFRESH_MS = 30_000;

// ── 日期筛选（默认近 30 天）──
type RangeMode = '7' | '30' | '90' | 'all' | 'custom';
const RANGE_PRESETS: Array<{ value: RangeMode; label: string }> = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: 'all', label: '全部' },
  { value: 'custom', label: '自定义' },
];
const rangeMode = ref<RangeMode>('30');
const customFrom = ref('');
const customTo = ref('');
/** 自定义日期已修改但未点「应用」 */
const customDirty = ref(false);
/** 当前生效的数据覆盖区间（来自响应） */
const appliedRange = ref<{ from: string | null; to: string | null } | null>(null);

function dayStr(d: Date): string { return d.toISOString().slice(0, 10); }

function initCustomDates() {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 29);
  customFrom.value = dayStr(from);
  customTo.value = dayStr(to);
  customDirty.value = false;
}

const DATE_FMT = /^\d{4}-\d{2}-\d{2}$/;
const customValid = computed(() => DATE_FMT.test(customFrom.value) && DATE_FMT.test(customTo.value));

/** 自定义区间参数（起止颠倒自动交换） */
const customRangeParam = computed<UsageRangeParams>(() => {
  let f = customFrom.value, t = customTo.value;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
});

/** 当前筛选对应的请求参数（未选完整时回退 30 天） */
function currentRangeParams(): UsageRangeParams {
  if (rangeMode.value === 'all') return {};
  if (rangeMode.value === 'custom') return customValid.value ? customRangeParam.value : { days: 30 };
  return { days: Number(rangeMode.value) };
}

// ── 排序 ──
type AgentSortKey = keyof AgentUsage | 'label';
const agentSortKey = ref<AgentSortKey>('total_tokens');
const agentSortDir = ref<-1 | 1>(-1);

function toggleSort(key: AgentSortKey) {
  if (agentSortKey.value === key) { agentSortDir.value = (agentSortDir.value * -1) as -1 | 1; }
  else { agentSortKey.value = key; agentSortDir.value = -1; }
}

function sortArrow(key: AgentSortKey): string {
  if (agentSortKey.value !== key) return '';
  return agentSortDir.value === -1 ? ' ▼' : ' ▲';
}

const sortedAgents = computed(() => {
  if (!data.value) return [];
  const arr = [...data.value.by_agent];
  const key = agentSortKey.value;
  const dir = agentSortDir.value;
  arr.sort((a, b) => {
    if (key === 'label') {
      const va = agentStore.getAgentName(a.agent);
      const vb = agentStore.getAgentName(b.agent);
      return dir * va.localeCompare(vb);
    }
    const va = a[key]; const vb = b[key];
    if (typeof va === 'string' && typeof vb === 'string') return dir * va.localeCompare(vb);
    return dir * ((va as number) - (vb as number));
  });
  return arr;
});

// ── LLM 排序 ──
type LlmSortKey = keyof LlmUsage;
const llmSortKey = ref<LlmSortKey>('total_tokens');
const llmSortDir = ref<-1 | 1>(-1);

function toggleLlmSort(key: LlmSortKey) {
  if (llmSortKey.value === key) { llmSortDir.value = (llmSortDir.value * -1) as -1 | 1; }
  else { llmSortKey.value = key; llmSortDir.value = -1; }
}
function llmSortArrow(key: LlmSortKey): string {
  if (llmSortKey.value !== key) return '';
  return llmSortDir.value === -1 ? ' ▼' : ' ▲';
}

const sortedLlms = computed(() => {
  if (!data.value) return [];
  const arr = [...(data.value.by_llm ?? [])];
  const key = llmSortKey.value;
  const dir = llmSortDir.value;
  arr.sort((a, b) => {
    const va = a[key]; const vb = b[key];
    if (typeof va === 'string' && typeof vb === 'string') return dir * va.localeCompare(vb);
    return dir * ((va as number) - (vb as number));
  });
  return arr;
});

// ── 汇总指标 ──
const totalInput = computed(() => {
  if (!data.value) return 0;
  return data.value.overall.total_prompt_tokens + data.value.overall.total_cache_hit;
});
const cacheHitVal = computed(() => data.value?.overall.total_cache_hit ?? 0);
const cachePct = computed(() => {
  if (!data.value || totalInput.value === 0) return 0;
  return (data.value.overall.total_cache_hit / totalInput.value) * 100;
});

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadData() {
  loading.value = true; error.value = '';
  try {
    const summary = await fetchUsageTokens(currentRangeParams()) as UsageSummary;
    data.value = summary;
    appliedRange.value = summary?.range ?? null;
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err: any) {
    console.error('[TokenUsage] 加载失败:', err);
    error.value = `加载失败: ${err.message || err}`;
  } finally { loading.value = false; }
}

// 打开时立即加载 + 每 30s 自动刷新（实时反映 Agent 用量变化）；每次打开默认进入总览
watch(() => props.visible, (v) => {
  if (v) {
    activeTab.value = 'cloud';
    if (!customFrom.value || !customTo.value) initCustomDates();
    loadData();
    if (!refreshTimer) refreshTimer = setInterval(loadData, AUTO_REFRESH_MS);
  } else {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }
});

// 预设切换立即生效；自定义等「应用」
watch(rangeMode, (m) => {
  if (m === 'custom') { if (!customFrom.value || !customTo.value) initCustomDates(); return; }
  loadData();
});
watch([customFrom, customTo], () => { customDirty.value = true; });
function applyCustomRange() {
  if (!customValid.value) return;
  customDirty.value = false;
  loadData();
}

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
});

// ── 按日期柱状图 ──
const chartCanvas = ref<HTMLCanvasElement | null>(null);
let chartInstance: Chart | null = null;

function destroyChart() { if (chartInstance) { chartInstance.destroy(); chartInstance = null; } }

function renderChart() {
  if (!chartCanvas.value || !data.value || data.value.by_day.length === 0) return;
  const days = [...data.value.by_day].sort((a, b) => a.date.localeCompare(b.date));
  destroyChart();
  const isDark = document.documentElement.classList.contains('dark');
  const textColor = isDark ? '#bdc3c7' : '#7f8c8d';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  chartInstance = new Chart(chartCanvas.value, {
    type: 'bar',
    data: {
      labels: days.map(d => d.date.slice(5)),
      datasets: [
        { label: '输入 Token（计费）', data: days.map(d => d.total_prompt_tokens), backgroundColor: isDark ? '#818cf8' : '#6366f1' },
        { label: '输出 Token', data: days.map(d => d.total_completion_tokens), backgroundColor: isDark ? '#a78bfa' : '#8b5cf6' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, padding: 16, usePointStyle: true, pointStyleWidth: 10 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.raw as number)}` } },
      },
      scales: {
        x: { stacked: true, ticks: { color: textColor, maxRotation: 45, font: { size: 11 } }, grid: { color: gridColor } },
        y: { stacked: true, ticks: { color: textColor, callback: (v) => formatNumber(v as number) }, grid: { color: gridColor } },
      },
    },
  });
}

// ===== Token 云图（气泡图）：气泡面积 ∝ √total_tokens，一眼看出最活跃 Agent =====
const CLOUD_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#10b981',
  '#06b6d4', '#3b82f6', '#a855f7', '#ef4444', '#84cc16', '#14b8a6',
  '#f97316', '#8b5cf6', '#22d3ee', '#fb7185', '#a3e635', '#facc15',
];
/** Agent ID → 恒定颜色（哈希取模） */
function agentColor(agent: string): string {
  let h = 0;
  for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
  return CLOUD_COLORS[h % CLOUD_COLORS.length];
}

/** 复合图 SVG 容器 */
const cloudSvg = ref<SVGSVGElement | null>(null);

/** 扇形环段路径（内半径→外半径，起始角→结束角） */
function arcBand(cx: number, cy: number, r1: number, r2: number, a1: number, a2: number): string {
  const x1 = cx + Math.cos(a1) * r2, y1 = cy + Math.sin(a1) * r2;
  const x2 = cx + Math.cos(a2) * r2, y2 = cy + Math.sin(a2) * r2;
  const x3 = cx + Math.cos(a2) * r1, y3 = cy + Math.sin(a2) * r1;
  const x4 = cx + Math.cos(a1) * r1, y4 = cy + Math.sin(a1) * r1;
  const large = a2 - a1 > Math.PI ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r2} ${r2} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${r1} ${r1} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
}

/** 群聊会话前缀（弦图始终排除；group~ / group: / room:，后续单独群聊图谱） */
const isGroupCp = (id: string) => id.startsWith('group') || id.startsWith('room');

/** 弦图可用 1v1 流量对：self / 群聊排除；user 视 includeUserSelf 而定 */
const chordPairs = computed<PairUsage[]>(() => {
  if (!data.value) return [];
  return (data.value.by_pair ?? []).filter(p =>
    p.a !== p.b
    && !isGroupCp(p.a) && !isGroupCp(p.b)
    && (includeUserSelf.value || (p.a !== 'user' && p.b !== 'user')),
  );
});
/** 是否存在可绘制的协作流量（没有则弦图留白，模板显示引导文案） */
const hasChordFlow = computed(() => chordPairs.value.length > 0);

/** 弦图（Chord Diagram，基于 d3-chord）：弧段长度 ∝ 协作流量占比，小占比合并为「其他」；
 *  标记字符串一次性 innerHTML 重建（替代逐节点 createElementNS），悬停经事件委托联动高亮 */
let lastCloudSvg: SVGSVGElement | null = null;
let lastCloudKey = '';
/** 渐变 id 自增序号（避免同文档多次渲染 id 撞车） */
let cloudRenderSeq = 0;
/** 弦图悬停元数据（renderCloud 时刷新，供事件委托/tooltip 读取） */
const arcMetas = new Map<string, { name: string; tokens: number; pct: number }>();
let chordFlowTotal = 1;
/** 自定义 tooltip 容器（绝对定位于 .cloud-canvas-wrap 内） */
const cloudTip = ref<HTMLDivElement | null>(null);

/** 属性/文本转义（innerHTML 注入前必转义，防 Agent 名含 &<>"' 破坏标记） */
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderCloud() {
  if (!cloudSvg.value || !data.value || data.value.by_agent.length === 0) return;
  const svg = cloudSvg.value;
  // 无可绘制的协作流量：清空画布（引导文案由模板显示）
  if (!hasChordFlow.value) {
    svg.innerHTML = '';
    lastCloudSvg = svg; lastCloudKey = 'empty';
    return;
  }
  // 数据 / SVG / 主题均未变化时跳过重绘（避免 30s 自动刷新闪烁）；
  // SVG 元素重建（弹窗重开/重渲染）或明暗主题切换时必须重新渲染配色
  const cloudKey = `${includeUserSelf.value}|${themeStore.theme}|${data.value.by_agent.length}|${data.value.by_pair?.length ?? 0}|` +
    `${JSON.stringify(data.value.by_agent.map(a => a.total_tokens))}|${JSON.stringify(data.value.by_pair?.map(p => [p.a, p.b, p.total_tokens]) ?? [])}`;
  if (svg === lastCloudSvg && cloudKey === lastCloudKey) return;
  lastCloudSvg = svg;
  lastCloudKey = cloudKey;
  arcMetas.clear();

  const W = 660, H = 660;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const cx = W / 2, cy = H / 2;
  const rOuter = 205;   // 外环弧中心半径
  const arcW = 18;      // 外环弧宽
  const rInner = rOuter - arcW / 2; // 弦端连接在弧带内缘
  const isDark = document.documentElement.classList.contains('dark');
  const OTHER_COLOR = isDark ? '#8b93a7' : '#9ca3af';
  const uid = `tc${++cloudRenderSeq}`;

  // ---- user / self 流量（勾选关闭时从弧段与矩阵中排除）----
  const userSelfExcl = new Map<string, number>();
  if (!includeUserSelf.value) {
    for (const p of data.value.by_pair ?? []) {
      if (p.a === p.b) {
        userSelfExcl.set(p.a, (userSelfExcl.get(p.a) ?? 0) + p.total_tokens);
      } else if (p.a === 'user' || p.b === 'user') {
        const agent = p.a === 'user' ? p.b : p.a;
        userSelfExcl.set(agent, (userSelfExcl.get(agent) ?? 0) + p.total_tokens);
      }
    }
  }
  // ---- 群聊流量（始终排除，仅用于弧段口径扣减；前缀判断见 isGroupCp）----
  const groupExcl = new Map<string, number>();
  for (const p of data.value.by_pair ?? []) {
    if (p.a === p.b) continue;
    if (isGroupCp(p.a) || isGroupCp(p.b)) {
      const agent = isGroupCp(p.a) ? p.b : p.a;
      groupExcl.set(agent, (groupExcl.get(agent) ?? 0) + p.total_tokens);
    }
  }
  // 弧段用量有效值（排除 user/self 与群聊后）
  const effTokens = (agent: string, raw: number) => {
    let v = raw;
    if (!includeUserSelf.value) v -= userSelfExcl.get(agent) ?? 0;
    v -= groupExcl.get(agent) ?? 0; // 群聊始终排除
    return Math.max(0, v);
  };
  const effTotal = data.value.by_agent.reduce((s, a) => s + effTokens(a.agent, a.total_tokens), 0) || 1;

  // ---- 按占比分组：占比 < 阈值 → 「其他」 ----
  const THRESHOLD_PCT = 2;
  const sortedByTokens = [...data.value.by_agent].sort((a, b) => effTokens(b.agent, b.total_tokens) - effTokens(a.agent, a.total_tokens));
  let main = data.value.by_agent.filter(a => (effTokens(a.agent, a.total_tokens) / effTotal) * 100 >= THRESHOLD_PCT);
  if (main.length < 5) main = sortedByTokens.slice(0, 5); // 保底 top 5
  const mainSet = new Set(main.map(a => a.agent));
  const otherTokens = data.value.by_agent.filter(a => !mainSet.has(a.agent)).reduce((s, a) => s + effTokens(a.agent, a.total_tokens), 0);

  // ---- 节点：main 按 agent_id 排序位置稳定，其他放末尾 ----
  const nodes: Array<{ agent: string; tokens: number; isOther: boolean }> = [];
  for (const a of [...data.value.by_agent].filter(x => mainSet.has(x.agent)).sort((x, y) => x.agent.localeCompare(y.agent))) {
    nodes.push({ agent: a.agent, tokens: effTokens(a.agent, a.total_tokens), isOther: false });
  }
  if (otherTokens > 0) nodes.push({ agent: 'other', tokens: otherTokens, isOther: true });
  const n = nodes.length;
  const nodeIndex = new Map<string, number>();
  nodes.forEach((nd, i) => nodeIndex.set(nd.agent, i));
  const otherIdx = n - 1;
  // 悬停 tooltip 用的节点名（先建好，弦 tooltip 也要用）
  for (const nd of nodes) {
    arcMetas.set(nd.agent, {
      name: nd.isOther ? `其他 Agent（${data.value.by_agent.length - main.length} 个）` : agentStore.getAgentName(nd.agent) || nd.agent,
      tokens: 0, pct: 0,
    });
  }

  // ---- 对称矩阵：非对角 = 1v1 用量，对角 = 0（弦只按 1v1 分割弧段，保证弦宽饱满）----
  // 过滤口径统一收敛在 chordPairs computed（self/群聊排除；user 视 includeUserSelf）
  const pairTokens = new Map<string, number>();
  for (const p of chordPairs.value) {
    const ia = nodeIndex.get(p.a) ?? otherIdx;
    const ib = nodeIndex.get(p.b) ?? otherIdx;
    if (ia === ib) continue; // 两端归并进同一「其他」节点时无独立弦
    const key = ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
    pairTokens.set(key, (pairTokens.get(key) ?? 0) + p.total_tokens);
  }
  const matrix: number[][] = nodes.map(() => new Array(n).fill(0));
  for (const [key, v] of pairTokens) {
    const [i, j] = key.split('-').map(Number);
    matrix[i][j] = v; matrix[j][i] = v;
  }

  // ---- 弧段分配（∝ 矩阵行和 = 该 agent 的协作连接流量，与弦覆盖同口径，消除空白）----
  const rowSum = matrix.map(row => row.reduce((s, v) => s + v, 0));
  const rowTotal = rowSum.reduce((s, v) => s + v, 0) || 1;
  chordFlowTotal = rowTotal;
  nodes.forEach((nd, i) => {
    nd.tokens = rowSum[i];
    const m = arcMetas.get(nd.agent);
    if (m) { m.tokens = rowSum[i]; m.pct = (rowSum[i] / rowTotal) * 100; }
  });
  const segs: Array<{ agent: string; start: number; end: number }> = [];
  let cursor = -Math.PI / 2;
  nodes.forEach((nd, i) => {
    const frac = rowSum[i] / rowTotal;
    segs.push({ agent: nd.agent, start: cursor, end: cursor + frac * Math.PI * 2 });
    cursor += frac * Math.PI * 2;
  });
  const segByAgent = new Map<string, { agent: string; start: number; end: number }>();
  segs.forEach(s => segByAgent.set(s.agent, s));

  // ---- d3 chord 布局（对角=0）：只用于弦端在弧段内的相对区间（顺序占满 + 标准弧线）----
  const chords = chord().padAngle(0.02)(matrix);
  const groups = chords.groups;

  // ---- ① 弦（d3 ribbon 标准弧线），先画让弧盖住端点 ----
  const drawChords = chords
    .filter(c => c.source.index !== c.target.index && c.source.value > 0)
    .sort((a, b) => b.source.value - a.source.value);
  const maxChordValue = Math.max(...drawChords.map(c => c.source.value)) || 1;
  const ribbonGen = ribbon().radius(rInner);
  // 标记字符串一次性拼接（替代逐节点 createElementNS，重建更快）
  const defsParts: string[] = [];
  const chordParts: string[] = [];
  let gradSeq = 0;

  // 弧段间隙（弦端映射也缩进，与弧段两端完全对齐）
  const gap = 0.008;
  // 把 d3 弦区间（相对 d3 弧段的比例）映射到 ∝ total_tokens 的弧段上
  const mapSub = (sub: { startAngle: number; endAngle: number }, idx: number) => {
    const g = groups[idx];
    const span = (g.endAngle - g.startAngle) || 1;
    const seg = segByAgent.get(nodes[idx].agent)!;
    const segStart = seg.start + gap, segEnd = seg.end - gap;
    const sspan = segEnd - segStart;
    return {
      startAngle: segStart + ((sub.startAngle - g.startAngle) / span) * sspan,
      endAngle: segStart + ((sub.endAngle - g.startAngle) / span) * sspan,
    };
  };

  for (const c of drawChords) {
    const ratio = c.source.value / maxChordValue;
    const src = mapSub(c.source, c.source.index);
    const tgt = mapSub(c.target, c.target.index);
    // 统一弦端宽度：两端取较小值、各自居中，保证"流量对得上"
    const wSrc = src.endAngle - src.startAngle;
    const wTgt = tgt.endAngle - tgt.startAngle;
    const w = Math.min(wSrc, wTgt);
    const sMid = (src.startAngle + src.endAngle) / 2;
    const tMid = (tgt.startAngle + tgt.endAngle) / 2;
    const srcU = { startAngle: sMid - w / 2, endAngle: sMid + w / 2 };
    const tgtU = { startAngle: tMid - w / 2, endAngle: tMid + w / 2 };
    // d3 ribbon 内部把角度减 π/2（惯例 0=12点），补回使弦端对齐屏幕角度（12点=-π/2）
    const d = ribbonGen({
      source: { startAngle: srcU.startAngle + Math.PI / 2, endAngle: srcU.endAngle + Math.PI / 2, radius: rInner },
      target: { startAngle: tgtU.startAngle + Math.PI / 2, endAngle: tgtU.endAngle + Math.PI / 2, radius: rInner },
    }) as unknown as string | null;
    if (!d) continue;
    const sa = sMid;
    const ta = tMid;
    const psa = { x: Math.cos(sa) * rInner, y: Math.sin(sa) * rInner };
    const pta = { x: Math.cos(ta) * rInner, y: Math.sin(ta) * rInner };
    const srcNode = nodes[c.source.index].agent;
    const tgtNode = nodes[c.target.index].agent;
    const colorA = nodes[c.source.index].isOther ? OTHER_COLOR : agentColor(srcNode);
    const colorB = nodes[c.target.index].isOther ? OTHER_COLOR : agentColor(tgtNode);
    // 渐变用弦端点坐标（与弦同坐标系：圆心平移后的局部坐标）
    const gid = `${uid}-g${gradSeq++}`;
    defsParts.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${psa.x.toFixed(1)}" y1="${psa.y.toFixed(1)}" x2="${pta.x.toFixed(1)}" y2="${pta.y.toFixed(1)}">` +
      `<stop offset="0" stop-color="${colorA}"/><stop offset="1" stop-color="${colorB}"/></linearGradient>`);
    const op = (0.35 + ratio * 0.5).toFixed(2);
    // data-na/nb = 弧节点键（含 other，悬停联动匹配用）；data-tokens = 弦流量（tooltip 用）
    chordParts.push(`<path class="tc-chord" d="${d}" fill="url(#${gid})" opacity="${op}" data-op="${op}" ` +
      `data-na="${escHtml(srcNode)}" data-nb="${escHtml(tgtNode)}" data-tokens="${c.source.value}"/>`);
  }

  // ---- ② 外环弧（弧长 ∝ 协作流量占比，画在弦之上盖住弦端点）----
  const arcParts: string[] = [];
  const arcFillOp = isDark ? '0.85' : '0.9';
  for (const seg of segs) {
    const s1 = seg.start + gap, s2 = seg.end - gap;
    if (s2 - s1 < 0.003) continue;
    const nd = nodes[nodeIndex.get(seg.agent)!];
    const d = arcBand(cx, cy, rInner, rOuter + arcW / 2, s1, s2);
    const fill = nd.isOther ? OTHER_COLOR : agentColor(nd.agent);
    arcParts.push(`<path class="tc-arc" d="${d}" fill="${fill}" fill-opacity="${arcFillOp}" ` +
      `data-fill-op="${arcFillOp}" data-agent="${escHtml(nd.agent)}"/>`);
  }

  // ---- ③ 标签：主 agent（按用量 top 10）+ 其他（弧段够大时）；径向竖排完整显示 ----
  const labelFill = isDark ? '#cbd5e1' : '#4b5563';
  const lr = rOuter + arcW / 2 + 18;
  const labelTargets: Array<{ name: string; angle: number; isOther?: boolean }> = [];
  for (const a of [...main].sort((x, y) => effTokens(y.agent, y.total_tokens) - effTokens(x.agent, x.total_tokens)).slice(0, 10)) {
    const seg = segByAgent.get(a.agent);
    if (!seg) continue;
    labelTargets.push({ name: a.agent, angle: (seg.start + seg.end) / 2 });
  }
  const last = nodes[n - 1];
  if (last.isOther) {
    const seg = segByAgent.get('other');
    if (seg && seg.end - seg.start > 0.12) {
      labelTargets.push({ name: 'other', angle: (seg.start + seg.end) / 2, isOther: true });
    }
  }
  // 超长名截断（完整名仍可悬停弧段在 tooltip 中看到）
  const MAX_LABEL_CHARS = 12;
  const labelParts: string[] = [];
  for (const t of labelTargets) {
    const raw = t.isOther ? '其他' : agentStore.getAgentName(t.name) || t.name;
    let chars = Array.from(raw);
    if (chars.length > MAX_LABEL_CHARS) chars = [...chars.slice(0, MAX_LABEL_CHARS - 1), '…'];
    // 径向排列：字符沿半径方向逐个排列，每个字符横躺（阅读方向朝外）
    // 左侧弧段（cos < 0）翻转 180° 并沿径向向内排布，避免文字上下颠倒；
    // 起始半径需外移 (n-1)*step，否则整串文字尾部会侵入弧带
    const dx = Math.cos(t.angle), dy = Math.sin(t.angle);
    const flip = dx < 0;
    const rotDeg = flip
      ? Math.atan2(dy, dx) * 180 / Math.PI + 180
      : Math.atan2(dy, dx) * 180 / Math.PI;
    const ox = flip ? -dx : dx;
    const oy = flip ? -dy : dy;
    const step = 12;
    const labelR = flip ? lr + (chars.length - 1) * step : lr;
    const lx = cx + Math.cos(t.angle) * labelR;
    const ly = cy + Math.sin(t.angle) * labelR;
    const texts = chars.map((ch, i) => {
      const x = lx + ox * i * step;
      const y = ly + oy * i * step;
      return `<text x="0" y="0" text-anchor="middle" dominant-baseline="central" ` +
        `transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotDeg.toFixed(1)})">${escHtml(ch)}</text>`;
    }).join('');
    labelParts.push(`<g font-size="12" font-weight="700" fill="${labelFill}" pointer-events="none">${texts}</g>`);
  }

  // 一次性重建（标记字符串拼接远快于逐节点 createElementNS）；弦组平移到圆心坐标系
  svg.innerHTML =
    `<defs>${defsParts.join('')}</defs>` +
    `<g class="tc-cloud-fade" transform="translate(${cx} ${cy})">${chordParts.join('')}</g>` +
    `<g class="tc-cloud-fade">${arcParts.join('')}${labelParts.join('')}</g>`;
  bindCloudHover(svg);
}

// ── 悬停联动 + 自定义 tooltip（事件委托：innerHTML 重建后监听依然有效，只绑一次）──
function setChordKeep(keep: (na: string, nb: string) => boolean): void {
  cloudSvg.value?.querySelectorAll<SVGElement>('.tc-chord').forEach(el => {
    el.style.opacity = keep(el.getAttribute('data-na') ?? '', el.getAttribute('data-nb') ?? '')
      ? (el.getAttribute('data-op') ?? '')
      : '0.05';
  });
}
function setArcKeep(keep: (agent: string) => boolean): void {
  cloudSvg.value?.querySelectorAll<SVGElement>('.tc-arc').forEach(el => {
    el.style.fillOpacity = keep(el.getAttribute('data-agent') ?? '')
      ? (el.getAttribute('data-fill-op') ?? '')
      : '0.25';
  });
}
function showCloudTip(html: string): void {
  const t = cloudTip.value;
  if (!t) return;
  t.innerHTML = html;
  t.style.display = 'block';
}
function hideCloudTip(): void {
  const t = cloudTip.value;
  if (t) t.style.display = 'none';
}
function positionCloudTip(e: PointerEvent): void {
  const t = cloudTip.value;
  const wrap = t?.parentElement;
  if (!t || !wrap || t.style.display === 'none') return;
  const r = wrap.getBoundingClientRect();
  let x = e.clientX - r.left + 14;
  let y = e.clientY - r.top + 14;
  // 防溢出：越界时翻转到指针另一侧
  if (x + t.offsetWidth > r.width - 6) x = e.clientX - r.left - t.offsetWidth - 14;
  if (y + t.offsetHeight > r.height - 6) y = e.clientY - r.top - t.offsetHeight - 14;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}
function clearCloudHover(): void {
  setChordKeep(() => true);
  setArcKeep(() => true);
  hideCloudTip();
}
function bindCloudHover(svg: SVGSVGElement): void {
  const flag = svg as unknown as { __tcBound?: boolean };
  if (flag.__tcBound) return;
  flag.__tcBound = true;
  svg.addEventListener('pointerover', (ev) => {
    const target = (ev.target as Element | null)?.closest?.('.tc-chord, .tc-arc') as SVGElement | null;
    if (!target) { clearCloudHover(); return; } // 移入空白区即取消高亮
    const na = target.getAttribute('data-na');
    if (na !== null) {
      // 悬停弦：只亮自身与两端弧段，其余压暗
      const nb = target.getAttribute('data-nb') ?? '';
      setChordKeep((a, b) => (a === na && b === nb) || (a === nb && b === na));
      setArcKeep(ag => ag === na || ag === nb);
      const mA = arcMetas.get(na), mB = arcMetas.get(nb);
      const v = Number(target.getAttribute('data-tokens') ?? 0);
      showCloudTip(
        `<div class="tt-title">${escHtml(mA?.name ?? na)} ↔ ${escHtml(mB?.name ?? nb)}</div>` +
        `<div class="tt-row">${formatNumber(v)} tokens · ${(v / chordFlowTotal * 100).toFixed(1)}% 协作流量</div>`,
      );
    } else {
      // 悬停弧段：点亮该 Agent 的全部协作弦
      const ag = target.getAttribute('data-agent');
      if (ag === null) return;
      setChordKeep((a, b) => a === ag || b === ag);
      setArcKeep(x => x === ag);
      const m = arcMetas.get(ag);
      showCloudTip(
        `<div class="tt-title">${escHtml(m?.name ?? ag)}</div>` +
        `<div class="tt-row">${formatNumber(m?.tokens ?? 0)} tokens · ${(m?.pct ?? 0).toFixed(1)}% 协作流量</div>`,
      );
    }
  });
  svg.addEventListener('pointermove', (ev) => positionCloudTip(ev as PointerEvent));
  svg.addEventListener('pointerleave', clearCloudHover);
}

watch(activeTab, async (tab) => {
  if (tab === 'daily') { await nextTick(); renderChart(); }
  else if (tab === 'cloud') { await nextTick(); renderCloud(); }
  else destroyChart();
});
watch(() => data.value, async (d) => {
  if (d && activeTab.value === 'daily') { await nextTick(); renderChart(); }
  else if (d && activeTab.value === 'cloud') { await nextTick(); renderCloud(); }
});
watch(includeUserSelf, async () => {
  if (activeTab.value === 'cloud') { await nextTick(); renderCloud(); }
});
// 明暗主题切换 → 弦图配色需重算
watch(() => themeStore.theme, async () => {
  if (activeTab.value === 'cloud') { await nextTick(); renderCloud(); }
});
onUnmounted(() => { destroyChart(); });
</script>

<template>
  <Modal :visible="visible" title="Token 用量统计" :width="1120" height="min(80vh, 780px)" @close="emit('close')">
    <template #head-extra>
      <span v-if="lastUpdated" class="last-updated">更新于 {{ lastUpdated }}</span>
    </template>

    <div class="usage-body">
      <!-- 首次加载全屏占位；已有数据时后台刷新/切筛选不闪占位（内容随 data 更新） -->
      <div v-if="loading && !data" class="status-msg">加载中...</div>
      <div v-else-if="error && !data" class="status-msg error">{{ error }}</div>
      <template v-else-if="data">
        <!-- ═══ 左右布局：左侧摘要+页签，右侧内容（云图无需滚动看全）═══ -->
        <div class="usage-layout">
          <!-- 左侧：日期筛选 + 摘要 + 竖向页签 -->
          <aside class="usage-side">
            <!-- 日期筛选（默认近 30 天，作用于全部页签） -->
            <div class="range-filter">
              <div class="range-head">
                <span class="range-title">统计范围</span>
                <span v-if="rangeMode === 'custom' && customDirty" class="range-dirty">未应用</span>
              </div>
              <select v-model="rangeMode" class="range-select" title="筛选统计的时间范围（默认近 30 天）">
                <option v-for="p in RANGE_PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
              <div v-if="rangeMode === 'custom'" class="range-custom">
                <input v-model="customFrom" type="date" class="range-date" aria-label="开始日期" />
                <span class="range-sep">~</span>
                <input v-model="customTo" type="date" class="range-date" aria-label="结束日期" />
                <button class="range-apply" :disabled="!customValid || !customDirty" @click="applyCustomRange">应用</button>
              </div>
              <div v-if="appliedRange?.from" class="range-coverage">数据覆盖 {{ appliedRange.from }} ~ {{ appliedRange.to }}</div>
              <div v-else-if="!loading" class="range-coverage">范围内暂无记录</div>
            </div>

            <div class="summary-bar">
              <div class="summary-bar-label">
                <span class="summary-bar-title">缓存命中 / 总输入</span>
                <span class="summary-bar-value">
                  <strong>{{ formatNumber(cacheHitVal) }}</strong> / {{ formatNumber(totalInput) }}
                  <span class="summary-bar-pct">({{ cachePct.toFixed(1) }}%)</span>
                </span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: cachePct + '%' }"></div>
              </div>
              <div class="summary-bar-mini">
                <span>总输出 {{ formatNumber(data.overall.total_completion_tokens) }}</span>
                <span>总步数 {{ data.overall.total_react_steps }}</span>
                <span>请求 {{ data.overall.total_records }}</span>
              </div>
            </div>

            <!-- 竖向 Tab -->
            <div class="tab-bar">
              <button :class="{ active: activeTab === 'cloud' }" @click="activeTab = 'cloud'">总览</button>
              <button :class="{ active: activeTab === 'agents' }" @click="activeTab = 'agents'">按 Agent</button>
              <button :class="{ active: activeTab === 'llm' }" @click="activeTab = 'llm'">按 LLM</button>
              <button :class="{ active: activeTab === 'daily' }" @click="activeTab = 'daily'">按日期</button>
            </div>
          </aside>

          <!-- 右侧：内容区 -->
          <div class="usage-main">
            <!-- ═══ 云图（弦图）═══ -->
            <div v-if="activeTab === 'cloud'" class="cloud-tab">
          <div class="cloud-hint">弦图：外环弧段 = Agent（长度 ∝ 协作流量，颜色区分），弦（色带）连接 1v1 会话，宽度与颜色渐变 ∝ 用量；悬停弧段/弦查看明细。</div>
          <label class="cloud-toggle" title="取消勾选可排除 user↔agent 与自身(self)对话流量；群聊流量始终排除（后续单独图谱）">
            <input type="checkbox" v-model="includeUserSelf" />
            包含 user / self 流量
          </label>
          <div class="cloud-canvas-wrap">
            <svg ref="cloudSvg" class="cloud-svg"></svg>
            <!-- 弦图悬停明细（renderCloud 内联注入内容） -->
            <div ref="cloudTip" class="cloud-tip"></div>
            <!-- 无协作流量时的引导 -->
            <div v-if="!hasChordFlow" class="cloud-empty">
              <div>当前范围内没有 Agent 间 1v1 协作流量</div>
              <div class="cloud-empty-sub">可勾选「包含 user / self 流量」或调整左侧统计范围</div>
            </div>
          </div>
          <div v-if="data.by_agent.length === 0" class="status-msg">暂无数据</div>
        </div>

        <!-- ═══ 按 Agent ═══ -->
        <div v-if="activeTab === 'agents'" class="table-tab">
          <table class="usage-table">
            <thead>
              <tr>
                <th class="sortable" @click="toggleSort('agent')">Agent{{ sortArrow('agent') }}</th>
                <th class="sortable" @click="toggleSort('label')">名称{{ sortArrow('label') }}</th>
                <th class="num sortable" @click="toggleSort('total_tokens')">总 Token{{ sortArrow('total_tokens') }}</th>
                <th class="num sortable" @click="toggleSort('total_prompt_tokens')">输入{{ sortArrow('total_prompt_tokens') }}</th>
                <th class="num sortable" @click="toggleSort('total_completion_tokens')">输出{{ sortArrow('total_completion_tokens') }}</th>
                <th class="num sortable" @click="toggleSort('total_react_steps')">步数{{ sortArrow('total_react_steps') }}</th>
                <th class="num sortable" @click="toggleSort('total_cache_hit')">缓存命中{{ sortArrow('total_cache_hit') }}</th>
                <th class="num sortable" @click="toggleSort('record_count')">请求{{ sortArrow('record_count') }}</th>
                <th class="sortable" @click="toggleSort('last_used')">最后活跃{{ sortArrow('last_used') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="agent in sortedAgents" :key="agent.agent">
                <td class="agent-name">{{ agent.agent }}</td>
                <td>{{ agentStore.getAgentName(agent.agent) }}</td>
                <td class="num">{{ formatNumber(agent.total_tokens) }}</td>
                <td class="num">{{ formatNumber(agent.total_prompt_tokens) }}</td>
                <td class="num">{{ formatNumber(agent.total_completion_tokens) }}</td>
                <td class="num">{{ agent.total_react_steps }}</td>
                <td class="num">{{ formatNumber(agent.total_cache_hit) }}</td>
                <td class="num">{{ agent.record_count }}</td>
                <td class="date-cell">{{ formatDateTime(agent.last_used) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="data.by_agent.length === 0" class="status-msg">暂无数据</div>
        </div>

        <!-- ═══ 按 LLM ═══ -->
        <div v-if="activeTab === 'llm'" class="table-tab">
          <table class="usage-table">
            <thead>
              <tr>
                <th class="sortable" @click="toggleLlmSort('llm')">模型{{ llmSortArrow('llm') }}</th>
                <th class="num sortable" @click="toggleLlmSort('total_tokens')">总 Token{{ llmSortArrow('total_tokens') }}</th>
                <th class="num sortable" @click="toggleLlmSort('total_prompt_tokens')">输入{{ llmSortArrow('total_prompt_tokens') }}</th>
                <th class="num sortable" @click="toggleLlmSort('total_completion_tokens')">输出{{ llmSortArrow('total_completion_tokens') }}</th>
                <th class="num sortable" @click="toggleLlmSort('total_react_steps')">步数{{ llmSortArrow('total_react_steps') }}</th>
                <th class="num sortable" @click="toggleLlmSort('total_cache_hit')">缓存命中{{ llmSortArrow('total_cache_hit') }}</th>
                <th class="num sortable" @click="toggleLlmSort('record_count')">请求{{ llmSortArrow('record_count') }}</th>
                <th class="sortable" @click="toggleLlmSort('last_used')">最后活跃{{ llmSortArrow('last_used') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="llm in sortedLlms" :key="llm.llm">
                <td class="agent-name llm-name">{{ llm.llm }}</td>
                <td class="num">{{ formatNumber(llm.total_tokens) }}</td>
                <td class="num">{{ formatNumber(llm.total_prompt_tokens) }}</td>
                <td class="num">{{ formatNumber(llm.total_completion_tokens) }}</td>
                <td class="num">{{ llm.total_react_steps }}</td>
                <td class="num">{{ formatNumber(llm.total_cache_hit) }}</td>
                <td class="num">{{ llm.record_count }}</td>
                <td class="date-cell">{{ formatDateTime(llm.last_used) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="!(data.by_llm && data.by_llm.length)" class="status-msg">暂无数据</div>
        </div>

        <!-- ═══ 按日期 ═══ -->
        <div v-if="activeTab === 'daily'" class="chart-tab">
          <div class="chart-wrapper"><canvas ref="chartCanvas"/></div>
          <div v-if="data.by_day.length === 0" class="status-msg">暂无数据</div>
        </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Footer（ui/Button 统一按钮语言） -->
    <template #footer>
      <Button variant="ghost" icon="refresh-cw" :disabled="loading" @click="loadData">刷新</Button>
      <Button variant="ghost" @click="emit('close')">关闭</Button>
    </template>
  </Modal>
</template>

<style scoped>
.last-updated { font-size: 12px; color: var(--text-3); }

/* body 直接作为 Modal 内 flex 容器（sticky 吸附 + 图表填满剩余高度） */
.usage-body { display: contents; }

.status-msg { text-align: center; padding: 40px; color: var(--text-3); font-size: 13px; }
.status-msg.error { color: var(--err); }

/* ═══ 左右布局：左侧摘要+页签，右侧内容 ═══ */
.usage-layout { display: flex; flex: 1; min-height: 0; }
.usage-side {
  width: 216px; flex-shrink: 0;
  border-right: 1px solid var(--line);
  background: var(--bg-raised);
  display: flex; flex-direction: column;
  padding: 14px 16px;
  overflow-y: auto;
}

/* ═══ 日期筛选 ═══ */
.range-filter {
  display: flex; flex-direction: column; gap: 6px;
  padding-bottom: 12px; margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.range-head { display: flex; align-items: center; justify-content: space-between; }
.range-title { font-size: 12px; font-weight: 500; color: var(--text-2); }
.range-dirty { font-size: 11px; color: var(--warn); }
.range-select {
  width: 100%; padding: 5px 8px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg-base); color: var(--text-1);
  font-size: 12px; cursor: pointer;
}
.range-custom { display: flex; align-items: center; gap: 4px; }
.range-date {
  flex: 1; min-width: 0; padding: 4px 6px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg-base); color: var(--text-1);
  font-size: 11px;
}
.range-sep { color: var(--text-3); font-size: 11px; }
.range-apply {
  flex-shrink: 0; padding: 4px 10px;
  border: none; border-radius: var(--r-sm);
  background: var(--primary); color: #fff;
  font-size: 11px; cursor: pointer;
  transition: opacity var(--dur-fast);
}
.range-apply:disabled { opacity: 0.45; cursor: default; }
.range-coverage { font-size: 11px; color: var(--text-3); }
.usage-main {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  overflow-y: auto;
}
.summary-bar { padding: 0 0 14px; }
.summary-bar-label {
  display: flex; flex-direction: column; gap: 4px;
  margin-bottom: 8px;
}
.summary-bar-title { font-size: 12px; font-weight: 500; color: var(--text-2); }
.summary-bar-value { font-size: 13px; color: var(--text-1); font-variant-numeric: tabular-nums; }
.summary-bar-value strong { color: var(--ok); }
.summary-bar-pct { font-size: 12px; color: var(--text-3); margin-left: 4px; }

.progress-track {
  height: 8px; border-radius: var(--r-full);
  background: var(--bg-hover);
  overflow: hidden;
}
.progress-fill {
  height: 100%; border-radius: var(--r-full);
  background: var(--ok);
  transition: width 0.4s ease;
}

.summary-bar-mini {
  display: flex; flex-direction: column; gap: 4px; margin-top: 8px;
  font-size: 11px; color: var(--text-3);
}

/* ═══ 竖向 Tab（左侧栏）═══ */
.tab-bar { display: flex; flex-direction: column; gap: 2px; padding: 0; }
.tab-bar button {
  padding: 8px 12px; border: none; border-radius: var(--r-sm);
  background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer;
  text-align: left;
  transition: color var(--dur-fast), background var(--dur-fast);
}
.tab-bar button:hover { color: var(--text-1); background: var(--bg-hover); }
.tab-bar button.active { color: var(--primary); background: var(--primary-light, rgba(99,102,241,0.1)); font-weight: 500; }

/* ═══ 总览（双环复合图）═══ */
/* 自适应填满右侧内容区（正方形 viewBox 等比缩放，无需滚动看全） */
.cloud-tab {
  display: flex; flex-direction: column;
  flex: 1; min-height: 0;
  padding: 8px 12px 12px;
}
.cloud-hint {
  font-size: 12px; color: var(--text-3);
  margin-bottom: 6px;
}
.cloud-toggle {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-2);
  margin-bottom: 6px; cursor: pointer; user-select: none;
}
.cloud-toggle input { cursor: pointer; accent-color: var(--primary); }
.cloud-canvas-wrap { flex: 1; min-height: 0; position: relative; }
.cloud-svg { width: 100%; height: 100%; display: block; }
.cloud-svg :deep(.tc-chord), .cloud-svg :deep(.tc-arc) { cursor: crosshair; }

/* 悬停明细 tooltip（内容为运行时注入，子元素需 :deep） */
.cloud-tip {
  position: absolute; display: none; z-index: 5;
  max-width: 280px; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-raised);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}
.cloud-tip :deep(.tt-title) { font-size: 12px; font-weight: 600; color: var(--text-1); word-break: break-all; }
.cloud-tip :deep(.tt-row) { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; margin-top: 2px; }

/* 无协作流量引导 */
.cloud-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--text-3); font-size: 13px;
  pointer-events: none;
}
.cloud-empty-sub { font-size: 12px; margin-top: 4px; }

/* ═══ Table ═══ */
/* 限高 + 内部滚动：表格占满右侧内容区，表头吸顶、横向滚动条固定可见（无需滑到底） */
.table-tab { flex: 1; min-height: 0; overflow: auto; padding: 6px 18px 18px; }
.usage-table {
  width: 100%; border-collapse: collapse;
  font-size: 13px; font-variant-numeric: tabular-nums;
}
.usage-table thead th {
  position: sticky; top: 0; background: var(--bg-raised); z-index: 1;
}
.usage-table th {
  text-align: left; padding: 10px 10px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text-2); font-weight: 600; white-space: nowrap;
  user-select: none;
}
.usage-table th.sortable { cursor: pointer; }
.usage-table th.sortable:hover { color: var(--primary); }
.usage-table th.num { text-align: right; }
.usage-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--text-1);
}
.usage-table td.num { text-align: right; }
.usage-table .agent-name { font-weight: 500; }
.usage-table .date-cell { color: var(--text-3); white-space: nowrap; }
.usage-table tbody tr:hover { background: var(--bg-hover); }

/* ═══ Chart ═══ */
/* 自适应填满右侧内容区 */
.chart-tab {
  padding: 12px 18px 18px;
  display: flex; flex-direction: column;
  flex: 1; min-height: 0;
}
.chart-wrapper { flex: 1; min-height: 0; position: relative; }
</style>

<style>
/* 弦图重绘淡入：SVG 内容由 renderCloud innerHTML 注入（无 scoped data 属性），需全局样式 */
.tc-cloud-fade { animation: tc-cloud-fade 0.4s ease both; }
@keyframes tc-cloud-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
