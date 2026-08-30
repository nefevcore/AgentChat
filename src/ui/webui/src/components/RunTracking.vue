// AgentChat — Agent 运行跟踪（主区视图：由侧边栏「运行」面板的「运行总览」入口打开）
//
// 头部：标题（文本）+ 日期范围筛选 + 快照时间。矩阵：
//   · 轴集合 = Agent 清单 ∪ 群组清单 ∪ system ∪ 会话残留端点；轴标签用头像；
//   · 会话无方向 → 下三角 + 对角线为主（上三角有会话数据同样可交互）；自会话落对角线；
//   · 着色 = 选中日期范围内的消息量做对数归一化浓度（直观看出范围内 Agent 间活跃程度）；
//     运行中格 = 最深底色 + 流转光环；群参与证据格（无数值）= 证据浅色；
//   · hover：十字聚焦分级 —— hover 格主高亮（放大+强描边+提亮），十字行列次高亮，
//     其余区域置灰；美化 tooltip（两端点、关系、范围内/总量、运行 run）；
//   · 点击格子 → 主区切到该会话：群格子→群聊；viewer 参与的 pair→直接对话（显式
//     加载 direct 历史，修复从矩阵进入时空白会话的 bug）；其余→PairDialogView
//     只读视角（双方左气泡，返回回矩阵）。

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { Avatar, Icon } from '../ui';
import { useAgentStore } from '../stores/agents';
import { useGroupsStore } from '../stores/groups';
import { useSinglesStore } from '../stores/singles';
import { useUiStore } from '../stores/ui';
import { useRunsStore } from '../stores/runs';
import { useChatStore } from '../stores/chat';
import { useWebSocketStore } from '../stores/websocket';
import { WS_SEND } from '../core/events/contract';
import { VIEWER_ID } from '../constants';
import type {
  RunsSnapshot, RunsMember, RunsPairSession, RunsGroupSession, RunsGroupArchive, RunsRunningEntry, WindowCounts,
} from '../core/api/endpoints/runs';
import { formatFileSize, formatRelativeTime } from '../utils/format';
import { traceSwitch } from '../utils/switchTrace';

const agentStore = useAgentStore();
const groupsStore = useGroupsStore();
const singlesStore = useSinglesStore();
const ui = useUiStore();
const runsStore = useRunsStore();
const chatStore = useChatStore();
const wsStore = useWebSocketStore();

const snapshot = computed<RunsSnapshot | null>(() => runsStore.snapshot);
const loading = computed(() => runsStore.loading);
const now = computed(() => runsStore.now);

onMounted(() => { runsStore.ensurePolling(); agentStore.requestAgents(); });

// ============================================================
// 日期范围筛选（浓度 = 范围内消息量对数归一化）
// ============================================================

type RangeId = keyof WindowCounts | 'all';
const ranges: Array<{ id: RangeId; label: string }> = [
  { id: 'h1', label: '1h' },
  { id: 'd1', label: '1天' },
  { id: 'd3', label: '3天' },
  { id: 'd7', label: '1周' },
  { id: 'd30', label: '1月' },
  { id: 'all', label: '全部' },
];
const range = ref<RangeId>('d7');
const rangeLabel = computed(() => ranges.find(r => r.id === range.value)?.label ?? '');

/** 快照是否携带窗口计数（旧后端无 windows 字段 → 浓度回退按总量，矩阵不至全白） */
const hasWindows = computed(() =>
  (snapshot.value?.pairs ?? []).some(p => p.windows)
  || (snapshot.value?.groups ?? []).some(g => g.windows));

/** 旧后端（无 windows）→ 强制「全部」并禁用范围按钮（避免显示与数据不符的活跃范围） */
watch(hasWindows, (ok) => { if (!ok) range.value = 'all'; }, { immediate: true });

/** 会话在选中范围内的消息量（旧后端缺窗口数据时回退总量，保持色阶可比） */
function windowValue(s: { messageCount: number; windows?: WindowCounts }): number {
  if (range.value === 'all') return s.messageCount;
  if (!s.windows) return s.messageCount;
  return s.windows[range.value] ?? 0;
}

/**
 * 浓度上限（固定值，按范围直觉标定）：v 封顶后 log(1+v)/log(1+CAP) 归一。
 * 固定上限的好处：① 图例写死区间（不随数据重算）；② 上限不依赖快照 →
 * 轮询时浓度分档稳定，不触发全矩阵重着色；③ 极值热点不再"吃掉"色阶。
 * 超过上限一律最深档（活跃度已饱和，精确数值看 tooltip）。
 */
const RANGE_CAP: Record<RangeId, number> = { h1: 30, d1: 100, d3: 300, d7: 600, d30: 1500, all: 3000 };

const KIND_RANK: Record<RunsMember['kind'], number> = { agent: 0, virtual: 1, group: 3, system: 4, unknown: 5, preset: 2 };

/** 轴成员：预设不占轴（其会话为 single~，矩阵外）；按类别 + 名称排序 */
const axis = computed<RunsMember[]>(() =>
  [...(snapshot.value?.members ?? [])]
    .filter(m => m.kind !== 'preset')
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true })));

const memberById = computed(() => new Map((snapshot.value?.members ?? []).map(m => [m.id, m])));
function memberName(id: string): string { return memberById.value.get(id)?.name ?? id; }

interface MatrixCell {
  row: RunsMember;
  col: RunsMember;
  pair?: RunsPairSession;
  group?: RunsGroupSession;
  archive?: RunsGroupArchive;
  running: RunsRunningEntry[];
  /** 总消息数（tooltip 展示） */
  messageCount: number;
  lastActivity: number;
  /** 选中日期范围内的消息量（浓度数据源；0 = 范围内无活动） */
  value: number;
  /** 群参与证据格（无消息数值，仅有归档/运行证据 → 固定证据色） */
  evidence: boolean;
}

const pairMap = computed(() => {
  const m = new Map<string, RunsPairSession>();
  for (const p of snapshot.value?.pairs ?? []) m.set(cellKey(p.a, p.b), p);
  return m;
});
const groupMap = computed(() => new Map((snapshot.value?.groups ?? []).map(g => [g.groupId, g])));
const archiveMap = computed(() => {
  const m = new Map<string, RunsGroupArchive>();
  for (const a of snapshot.value?.groupArchives ?? []) m.set(`${a.groupId}|${a.agentId}`, a);
  return m;
});
/** 运行中 run → 格子（chat = 两端点格；group = 群×Agent 格；single 不入矩阵） */
const runningCellMap = computed(() => {
  const m = new Map<string, RunsRunningEntry[]>();
  for (const r of snapshot.value?.running ?? []) {
    let key: string | null = null;
    if (r.kind === 'chat') {
      const seg = r.convKey.split('~');
      if (seg.length >= 3) key = cellKey(seg[1], seg.slice(2).join('~'));
    } else if (r.kind === 'group') {
      const seg = r.convKey.split('~');
      if (seg.length >= 3) key = cellKey(seg[1], seg.slice(2).join('~'));
    }
    if (!key) continue;
    const list = m.get(key);
    if (list) list.push(r);
    else m.set(key, [r]);
  }
  return m;
});

function cellKey(a: string, b: string): string { return [a, b].sort().join('|'); }

function cellOf(row: RunsMember, col: RunsMember): MatrixCell | null {
  const key = cellKey(row.id, col.id);
  const running = runningCellMap.value.get(key) ?? [];
  const runLive = running.length > 0 ? Math.max(...running.map(r => r.startedAt)) : 0;

  if (row.kind === 'group' || col.kind === 'group') {
    const gid = row.kind === 'group' ? row.id : col.id;
    const other = row.kind === 'group' ? col : row;
    if (other.kind === 'group' || other.kind === 'system') return null; // 群×群 / 群×system：无会话语义
    if (row.id === col.id) {
      // 群对角线 = 群本体（范围窗口计数）
      const group = groupMap.value.get(gid);
      if (!group && !runLive) return null;
      return {
        row, col, group, running,
        messageCount: group?.messageCount ?? 0,
        lastActivity: Math.max(group?.lastActivity ?? 0, runLive),
        value: group ? windowValue(group) : 0,
        evidence: false,
      };
    }
    // agent×群：参与证据 = 周归档 / 运行中 / 旧格式群会话键（群本体全员共享，不作个人证据）
    const archive = archiveMap.value.get(`${gid}|${other.id}`);
    const legacyPair = pairMap.value.get(key);
    if (!archive && !legacyPair && !runLive) return null;
    return {
      row, col, archive, ...(legacyPair ? { pair: legacyPair } : {}), running,
      messageCount: legacyPair?.messageCount ?? 0,
      lastActivity: Math.max(archive?.lastActivity ?? 0, legacyPair?.lastActivity ?? 0, runLive),
      value: legacyPair ? windowValue(legacyPair) : 0,
      evidence: !legacyPair && !!archive,
    };
  }

  const pair = pairMap.value.get(key);
  if (!pair && !runLive) return null;
  return {
    row, col, ...(pair ? { pair } : {}), running,
    messageCount: pair?.messageCount ?? 0,
    lastActivity: Math.max(pair?.lastActivity ?? 0, runLive),
    value: pair ? windowValue(pair) : 0,
    evidence: false,
  };
}

interface CellView { col: RunsMember; cell: MatrixCell | null; mirror: boolean; diag: boolean; j: number }
interface RowView { row: RunsMember; i: number; cells: CellView[] }

const matrixRows = computed<RowView[]>(() => axis.value.map((row, i) => ({
  row,
  i,
  cells: axis.value.map((col, j): CellView => ({
    col,
    // cellKey 排序 → 上三角镜像格与下三角对称格共享同一会话数据：
    // 有会话的上三角格也可 hover/点击进入（视觉弱化为镜像态）
    cell: cellOf(row, col),
    mirror: j > i,
    diag: j === i,
    j,
  })),
})));

/**
 * 浓度分档：范围内消息量 v 封顶 CAP 后 log(1+v)/log(1+CAP) 归一 5 档；
 * 运行中格固定最深（heat-live）+ 光环；证据格（无数值）固定浅证据色；v=0 无色。
 */
function densityClass(cell: MatrixCell | null): string {
  if (!cell) return 'heat-none';
  if (cell.running.length > 0) return 'heat-live';
  const v = cell.value;
  if (v > 0) {
    const c = RANGE_CAP[range.value];
    const t = Math.log(1 + Math.min(v, c)) / Math.log(1 + c); // ∈ (0,1]
    if (t <= 0.2) return 'c1';
    if (t <= 0.4) return 'c2';
    if (t <= 0.6) return 'c3';
    if (t <= 0.8) return 'c4';
    return 'c5';
  }
  return cell.evidence ? 'heat-evidence' : 'heat-none';
}

/** 档位阈值（由固定 CAP 反解 v = (1+CAP)^t − 1 取整；仅依赖 range → 切范围才算） */
const thresholds = computed(() => {
  const c = RANGE_CAP[range.value];
  const L = Math.log(1 + c);
  const edge = (t: number) => Math.floor(Math.exp(t * L) - 1);
  return { t1: edge(0.2), t2: edge(0.4), t3: edge(0.6), t4: edge(0.8) };
});

/** 图例区间文案（固定上限下的确定区间，如"≤5 · 6–21 · 22–78 · 79–289 · 290+ 条"） */
const thresholdLabel = computed(() => {
  const th = thresholds.value;
  return `≤${th.t1} · ${th.t1 + 1}–${th.t2} · ${th.t2 + 1}–${th.t3} · ${th.t3 + 1}–${th.t4} · ${th.t4 + 1}+`;
});

// ── 轴头像 ──
function memberAvatar(m: RunsMember): string | null {
  if (m.kind === 'agent' || m.kind === 'virtual') return agentStore.getAgentAvatar(m.id);
  return null;
}
function headIcon(m: RunsMember): string {
  if (m.kind === 'group') return 'users';
  if (m.kind === 'system') return 'zap';
  return 'alert-circle';
}

// ── hover 十字高亮 + tooltip ──
// hover 只存格子身份（ri/ci，仅进出格子时变化）；tooltip 坐标独立 ref——
// 此前每次 mousemove 都替换 hover 对象引用 → 单组件渲染作用域内全部
// 绑定（含 N² 格子的 inCross class、色带、表头高亮）每帧全量重算重 patch。
const hover = ref<{ ri: number; ci: number } | null>(null);
const tipPos = ref({ x: 0, y: 0 });

function onCellEnter(mr: RowView, v: CellView, e: MouseEvent) {
  hover.value = { ri: mr.i, ci: v.j };
  tipPos.value = { x: e.clientX, y: e.clientY };
}
/** tooltip 跟随鼠标：rAF 合并高频 mousemove（只写 tipPos，不触碰 hover） */
let moveRaf = 0;
function onCellMove(e: MouseEvent) {
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    tipPos.value = { x: e.clientX, y: e.clientY };
  });
}
function clearHover() {
  if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
  hover.value = null;
}

function inCross(mr: RowView, v: CellView): boolean {
  return !!hover.value && (hover.value.ri === mr.i || hover.value.ci === v.j);
}
function headActive(kind: 'row' | 'col', idx: number): boolean {
  return !!hover.value && (kind === 'row' ? hover.value.ri === idx : hover.value.ci === idx);
}

/**
 * 十字底色带几何（整行/整列铺色方案）：
 * matrix-grid 为 CSS grid：`190px repeat(N, var(--cell))` 列 × `48px repeat(N, var(--cell))` 行，gap 5px。
 * 注意 gap 同样存在于表头轨道与首个格子轨道之间：
 *   格子行 i 顶边 = headH + gap + i×(cell+gap)；色带高 = cell + 2×gap（两侧各溢出一个 gap 填满空隙）
 *   → 色带 top = headH + i×(cell+gap)（恰好居中盖住本行及其上下 gap）
 * 两层绝对定位色带（横 = hover 行、纵 = hover 列）铺在格子图层之下（z-index:0，
 * 格子自身 background 不透明覆盖其上 → 浓度色不受影响）；色带只填格子间的 gap 与
 * 无色格（heat-none 透明），有浓度色的格子把色带盖住 —— 十字以"底色通道"呈现。
 */
const CROSS = { headW: 190, headH: 48, cell: 40, gap: 5 };
const track = computed(() => {
  const h = hover.value;
  if (!h) return null;
  const band = CROSS.cell + 2 * CROSS.gap; // 色带 = 格子 + 两侧各一个 gap（盖住格间空隙）
  return {
    // 横带（行）：top = 列头高 + 行序 × (格+gap)；left 0 → 铺满整行（含行头下方）
    row: { top: CROSS.headH + h.ri * (CROSS.cell + CROSS.gap), height: band },
    // 纵带（列）：left = 行头宽 + 列序 × (格+gap)；top 0 → 铺满整列（含列头右侧）
    col: { left: CROSS.headW + h.ci * (CROSS.cell + CROSS.gap), width: band },
  };
});

/** tooltip 数据（hover 格子） */
const tip = computed(() => {
  const h = hover.value;
  if (!h) return null;
  const mr = matrixRows.value[h.ri];
  const v = mr?.cells[h.ci];
  if (!mr || !v) return null;
  return { mr, v };
});

const tipStyle = computed(() => {
  const { x: px, y: py } = tipPos.value;
  if (!hover.value) return {};
  const W = 270;
  const x = Math.min(px + 16, window.innerWidth - W - 8);
  const y = Math.min(py + 16, window.innerHeight - 250);
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px`, width: `${W}px` };
});

function relationLabel(row: RunsMember, col: RunsMember): string {
  if (row.id === col.id) return row.kind === 'group' ? '群本体（全员共享功能历史）' : '自会话';
  if (row.kind === 'group' || col.kind === 'group') {
    const gid = row.kind === 'group' ? row.id : col.id;
    const other = row.kind === 'group' ? col.id : row.id;
    return `群参与：${memberName(other)} @ ${memberName(gid)}`;
  }
  return '1v1 会话';
}

function sourceLabel(r: RunsRunningEntry): string {
  const map: Record<string, string> = {
    user: '用户', agent: 'Agent', system: '系统', timer: '定时',
    group: '群聊', subagent: '子代理', continue: '续推', restart: '重启', archive: '归档',
  };
  return map[r.source?.kind ?? 'system'] ?? r.source?.kind ?? 'system';
}

// ── 点击格子 → 主区切到该会话（上/下三角均可，只要有会话数据）──
function openCell(mr: RowView, v: CellView) {
  if (!v.cell) return;
  const { row, col } = v.cell;

  // 群相关格子 → 群聊视图
  if (row.kind === 'group' || col.kind === 'group') {
    const gid = row.kind === 'group' ? row.id : col.id;
    agentStore.activeAgentId = '';
    singlesStore.deselectSingle();
    if (!groupsStore.groups.some(g => g.group_id === gid)) void groupsStore.init();
    groupsStore.selectGroup(gid);
    ui.closeTrackingView();
    return;
  }

  // viewer 参与的 pair → 直接对话（右气泡 = 用户侧）。
  // 矩阵入口没有经过列表中转，必须显式加载 direct 历史 + 清未读 + 订阅流式
  // （此前只切 activeAgentId 不加载历史 → 进入空白会话的 bug）
  const viewer = VIEWER_ID.value;
  if (row.id === viewer || col.id === viewer) {
    const other = row.id === viewer ? col.id : row.id;
    traceSwitch('click-matrix', other);
    groupsStore.deselectGroup();
    singlesStore.deselectSingle();
    if (agentStore.activeAgentId !== other) agentStore.selectAgent(other); // selectAgent 是 toggle，同 id 不重复调
    chatStore.clearUnread(other);
    chatStore.loadHistory(viewer, other);
    const a = agentStore.agents.find(x => x.id === other);
    if (a?.hasActiveSession) wsStore.send(WS_SEND.chatSubscribe, { to: other });
    ui.closeTrackingView();
    return;
  }

  // 其余（Agent↔Agent / 自会话 / ↔system）→ pair 只读视角（双方左气泡）。
  // 不关矩阵视图：返回按钮回到矩阵，避免回到无选中的空白聊天区
  ui.openPairView(row.id, col.id);
}

// ── 覆盖面分析 ──
const coverage = computed(() => snapshot.value?.coverage);
const coverageOpen = ref(false);

// ── 格式化 ──
function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

const snapshotAt = computed(() => (snapshot.value ? new Date(snapshot.value.generatedAt).getTime() : 0));
const loadError = computed(() => runsStore.loadError);
</script>

<template>
  <div class="run-page">
    <!-- 头部：标题（文本）+ 日期范围筛选 + 快照时间 -->
    <div class="page-header">
      <span class="page-title">运行跟踪</span>
      <div
        class="range-toggle"
        :title="hasWindows
          ? `浓度 = ${rangeLabel}范围内消息量（对数归一化）`
          : '后端为旧版本，暂无时间窗口数据 —— 当前按总消息量着色；重启后端（pnpm dev）后可按范围筛选'"
      >
        <button
          v-for="r in ranges" :key="r.id"
          class="range-btn" :class="{ active: range === r.id }"
          :disabled="!hasWindows && r.id !== 'all'"
          @click="range = r.id"
        >{{ r.label }}</button>
      </div>
      <div class="header-side">
        <span v-if="snapshot" class="snap-time" :class="{ loading }" :title="`快照生成于 ${snapshot.generatedAt}`">快照 {{ fmtClock(snapshotAt) }}</span>
      </div>
    </div>
    <div v-if="loadError" class="load-error">快照拉取失败：{{ loadError }}</div>

    <!-- ═══ 矩阵（居中；运行中会话以红点标注）═══ -->
    <div class="tab-body">
      <div class="matrix-scroll">
        <div class="matrix-wrap" @mouseleave="clearHover" @mousemove="onCellMove">
          <div v-if="axis.length === 0" class="empty">暂无成员{{ snapshot ? '' : '（加载中…）' }}</div>
          <div v-else class="matrix-grid" :class="{ 'cross-active': !!hover }" :style="{ gridTemplateColumns: `190px repeat(${axis.length}, var(--cell))` }">
            <!-- 十字底色带（整行/整列铺色，画在格子图层之下：色带只出现在 gap 与无色格上，
                 有浓度色的格子覆盖其上 —— 高亮不再触碰格子颜色；绝对定位不占 grid 单元） -->
            <div v-if="track" class="cross-track cross-row" :style="{ top: `${track.row.top}px`, height: `${track.row.height}px` }"></div>
            <div v-if="track" class="cross-track cross-col" :style="{ left: `${track.col.left}px`, width: `${track.col.width}px` }"></div>
            <!-- 角 + 列头（头像，sticky 顶；hover 十字高亮） -->
            <div class="corner"></div>
            <div
              v-for="(m, j) in axis" :key="'c-' + m.id"
              class="col-head" :class="{ hl: headActive('col', j) }"
              :title="`${m.name}（${m.id}）`"
            >
              <Avatar v-if="memberAvatar(m)" :src="memberAvatar(m)" :name="m.name" :size="30" />
              <span v-else class="head-ic" :class="'kind-' + m.kind"><Icon :name="headIcon(m)" :size="16" /></span>
            </div>
            <!-- 行头（头像 + 名称，sticky 左）+ 格子（有会话即可交互，上/下三角均可点击） -->
            <template v-for="mr in matrixRows" :key="'r-' + mr.row.id">
              <div class="row-head" :class="{ hl: headActive('row', mr.i) }" :title="`${mr.row.name}（${mr.row.id}）`">
                <Avatar v-if="memberAvatar(mr.row)" :src="memberAvatar(mr.row)" :name="mr.row.name" :size="26" />
                <span v-else class="head-ic" :class="'kind-' + mr.row.kind"><Icon :name="headIcon(mr.row)" :size="15" /></span>
                <span class="row-head-name">{{ mr.row.name }}</span>
              </div>
              <div
                v-for="v in mr.cells" :key="`cell-${mr.row.id}-${v.col.id}`"
                class="cell"
                :class="[densityClass(v.cell), { mirror: v.mirror, 'mirror-data': v.mirror && !!v.cell, diag: v.diag, hl: inCross(mr, v) }]"
                @mouseenter="onCellEnter(mr, v, $event)"
                @click="openCell(mr, v)"
              >
                <!-- 运行光环（StarAvatar 同款 transform 旋转方案：合成器线程，零主线程开销）。
                     方形格子不能旋转（变形）→ 光环取内切圆形（视觉更贴近头像光环语言） -->
                <svg v-if="v.cell && v.cell.running.length > 0" class="cell-ring" viewBox="0 0 100 100" aria-hidden="true">
                  <!-- 底环：白色低透明（主色浓底上保持分离度） -->
                  <circle cx="50" cy="50" r="46" fill="none" class="ring-track" stroke-width="7" />
                  <!-- 主流光：白色长弧，旋转组顺时针流转 -->
                  <g class="ring-spin">
                    <circle cx="50" cy="50" r="46" fill="none" class="ring-main" stroke-width="7"
                      stroke-linecap="round" stroke-dasharray="119 289" />
                  </g>
                  <!-- 副流光：强调色短弧，慢速错相 -->
                  <g class="ring-spin ring-spin--sub">
                    <circle cx="50" cy="50" r="46" fill="none" class="ring-sub" stroke-width="7"
                      stroke-linecap="round" stroke-dasharray="50 289" />
                  </g>
                </svg>
              </div>
            </template>
          </div>

          <!-- 图例 + 覆盖面分析 -->
          <div class="legend">
            <span class="lg"><i class="lg-ring"></i>运行中</span>
            <span class="lg scale" :title="`${rangeLabel}范围内消息量（对数刻度，上限 ${RANGE_CAP[range]} 条封顶）：${thresholdLabel} 条`">
              <i class="swatch c1"></i><i class="swatch c2"></i><i class="swatch c3"></i><i class="swatch c4"></i><i class="swatch c5"></i>
              活跃度（{{ rangeLabel }}）：{{ thresholdLabel }} 条
            </span>
            <span class="lg"><i class="swatch heat-evidence"></i>群参与</span>
            <span class="lg note">点击格子进入会话（上/下三角均可）</span>
          </div>
          <button class="coverage-toggle" @click="coverageOpen = !coverageOpen">
            <Icon :name="coverageOpen ? 'chevron-down' : 'chevron-right'" :size="12" />
            覆盖面分析
          </button>
          <div v-if="coverageOpen" class="coverage">
            <div v-if="coverage" class="coverage-body">
              <p>✅ 已入矩阵：1v1 会话（chat~，自会话/旧 chat~x~self 均归一落对角线）{{ coverage.pairSessions }} 个 + 群会话 {{ coverage.groupSessions }} 个；轴集合 = Agent 清单 ∪ 群组清单 ∪ system（无主触发）。agent×群格子仅在有参与证据（周归档 / 运行中 / 旧格式会话键）时点亮——并非所有群成员都实际参与过群聊；群消息按人比例归属为后续增量。</p>
              <p v-if="coverage.singleSessions > 0">⚠️ 矩阵之外：独立会话（single~）{{ coverage.singleSessions }} 个 —— 它们没有两两端点（用户 ↔ 会话引用的 Agent，上下文按会话隔离），结构上无法落入两两格子；其中 {{ coverage.runningSingles }} 个正在运行，请看「运行中会话」。</p>
              <p v-else>独立会话（single~）：0 个 —— 当前全部会话均已入矩阵。</p>
              <p v-if="coverage.unknownMembers.length > 0">⚠️ 残留端点：{{ coverage.unknownMembers.join('、') }} —— 出现在会话键但已无对应 Agent/群组（已删除等），以「未知端点」入轴保留数据。</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- hover tooltip（跟随鼠标，十字定位） -->
    <Teleport to="body">
      <div v-if="tip" class="mx-tip" :style="tipStyle">
        <div class="tip-head">
          <div class="tip-avatars">
            <Avatar v-if="memberAvatar(tip.mr.row)" :src="memberAvatar(tip.mr.row)" :name="tip.mr.row.name" :size="22" />
            <span v-else class="tip-ic"><Icon :name="headIcon(tip.mr.row)" :size="12" /></span>
            <span class="tip-x">×</span>
            <Avatar v-if="memberAvatar(tip.v.col)" :src="memberAvatar(tip.v.col)" :name="tip.v.col.name" :size="22" />
            <span v-else class="tip-ic"><Icon :name="headIcon(tip.v.col)" :size="12" /></span>
          </div>
          <div class="tip-names">
            <span class="tip-name">{{ tip.mr.row.name }}</span>
            <span class="tip-x dim">×</span>
            <span class="tip-name">{{ tip.v.col.name }}</span>
          </div>
        </div>
        <div class="tip-rel">{{ relationLabel(tip.mr.row, tip.v.col) }}</div>
        <template v-if="tip.v.cell">
          <div v-if="tip.v.cell.messageCount > 0" class="tip-row">
            <span class="tip-k">消息</span>
            <span class="tip-v"><template v-if="range !== 'all'">{{ rangeLabel }}内 {{ tip.v.cell.value }} 条 · </template>共 {{ tip.v.cell.messageCount }} 条<template v-if="tip.v.cell.pair"> · {{ formatFileSize(tip.v.cell.pair.bytes) }}</template></span>
          </div>
          <div v-if="tip.v.cell.lastActivity > 0" class="tip-row">
            <span class="tip-k">活跃</span><span class="tip-v">{{ formatRelativeTime(tip.v.cell.lastActivity) }}</span>
          </div>
          <div v-if="tip.v.cell.archive" class="tip-row">
            <span class="tip-k">证据</span><span class="tip-v">周归档（参与过群会话）</span>
          </div>
          <div v-for="r in tip.v.cell.running" :key="r.convKey" class="tip-row run">
            <span class="tip-k">▶ 运行</span>
            <span class="tip-v">{{ sourceLabel(r) }} · {{ fmtDuration(now - r.startedAt) }}<template v-if="r.source?.summary"><br />{{ r.source.summary }}</template></span>
          </div>
        </template>
        <div v-else class="tip-empty">无会话记录</div>
        <div v-if="tip.v.cell" class="tip-foot">点击进入会话</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.run-page{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;background:var(--color-bg-page,#fff);overflow:hidden;position:relative}
html.dark .run-page{background:#11151d}

/* ── 头部：标题 + 范围筛选 ── */
.page-header{display:flex;align-items:center;gap:16px;height:var(--layout-header-height,48px);padding:0 20px;border-bottom:1px solid var(--color-border-secondary);flex-shrink:0}
.page-title{font-size:15px;font-weight:700;color:var(--color-text-primary);letter-spacing:.3px}
.range-toggle{display:flex;gap:2px;padding:3px;border-radius:9px;background:var(--color-bg-subtle,rgba(127,127,127,.1))}
.range-btn{padding:4px 11px;border:none;border-radius:7px;background:none;color:var(--color-text-secondary,#7f8c8d);font-size:12px;font-weight:500;cursor:pointer;transition:background var(--transition-fast),color var(--transition-fast),box-shadow var(--transition-fast)}
.range-btn:hover:not(:disabled){color:var(--color-text-primary)}
.range-btn:disabled{opacity:.35;cursor:not-allowed}
.range-btn.active{background:var(--color-bg-page,#fff);color:var(--color-primary,#6366f1);box-shadow:0 1px 4px rgba(0,0,0,.12)}
html.dark .range-btn.active{background:#1e2530}
.header-side{margin-left:auto;display:flex;align-items:center}
.snap-time{font-size:11px;color:var(--color-text-tertiary,#a8abb2);font-variant-numeric:tabular-nums}
.snap-time.loading{opacity:.45}
.load-error{padding:6px 20px;font-size:12px;color:#e74c3c;background:rgba(231,76,60,.08);flex-shrink:0}

.tab-body{flex:1;min-height:0;display:flex;flex-direction:column}

/* ── 矩阵（居中）── */
.matrix-scroll{flex:1;min-height:0;overflow:auto;display:flex}
.matrix-wrap{margin:auto;padding:20px 24px;display:flex;flex-direction:column;align-items:center;gap:12px}
.matrix-grid{--cell:40px;display:grid;gap:5px;position:relative}

/* 十字底色带：整行/整列铺色（hover 高亮的载体），铺在格子图层之下 ——
 * 只在 gap 与透明格（heat-none）上可见，有浓度色的格子覆盖其上；
 * 色带贯通行头下方/列头右侧，十字以"底色通道"呈现，不触碰任何格子颜色。 */
.cross-track{position:absolute;z-index:0;pointer-events:none;border-radius:8px;background:color-mix(in srgb,var(--color-primary,#6366f1) 10%,transparent)}
.cross-row{left:0;right:0}
.cross-col{top:0;bottom:0}
/* 交汇处（hover 格所在）：横纵带叠加自然加深，无需额外处理 */

/* 格子位于色带之上（不透明浓度色覆盖色带；透明格透出色带形成十字通道） */
.matrix-grid > .cell{z-index:1}

.corner{position:sticky;top:0;left:0;z-index:5;background:var(--color-bg-page,#fff)}
html.dark .corner{background:#11151d}

/* 列头：头像（sticky 顶；十字高亮） */
.col-head{position:sticky;top:0;z-index:2;width:var(--cell);height:48px;display:flex;align-items:center;justify-content:center;background:var(--color-bg-page,#fff);border-radius:10px;transition:background var(--transition-fast)}
html.dark .col-head{background:#11151d}
.col-head.hl{background:color-mix(in srgb,var(--color-primary,#6366f1) 12%,var(--color-bg-page,#fff))}

/* 行头：头像 + 名称（sticky 左；十字高亮） */
.row-head{position:sticky;left:0;z-index:1;height:var(--cell);display:flex;align-items:center;gap:8px;padding:0 10px 0 4px;background:var(--color-bg-page,#fff);min-width:0;border-radius:10px;transition:background var(--transition-fast)}
html.dark .row-head{background:#11151d}
.row-head.hl{background:color-mix(in srgb,var(--color-primary,#6366f1) 12%,var(--color-bg-page,#fff))}
.row-head-name{font-size:12px;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.head-ic{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;flex-shrink:0}
.head-ic.kind-group{color:#10b981;background:rgba(16,185,129,.14)}
.head-ic.kind-system{color:#f59e0b;background:rgba(245,158,11,.15)}
.head-ic.kind-unknown{color:var(--color-text-tertiary,#a8abb2);background:var(--color-bg-subtle,rgba(127,127,127,.1))}

/* ── 格子：方形圆角 + gap，纯颜色浓度；十字聚焦 = 底色带（不触碰格子本身）── */
.cell{width:var(--cell);height:var(--cell);border-radius:10px;position:relative;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(127,127,127,.1);transition:box-shadow .1s ease}
/* hover 格：仅细主色描边指示（不放大、不加光晕、不改颜色 —— 避免拥挤与遮色） */
.cell:hover{box-shadow:inset 0 0 0 2px var(--color-primary,#6366f1)}
.cell:active{box-shadow:inset 0 0 0 2.5px var(--color-primary,#6366f1)}
.cell.hl{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-primary,#6366f1) 25%,rgba(127,127,127,.1))}
.cell.hl.mirror-data{opacity:.85}
/* 上三角镜像：无数据 = 斜纹占位（不可点）；有数据 = 弱化浓度（可点进入同一会话） */
.cell.mirror{cursor:default;opacity:.45}
.cell.mirror:not(.mirror-data){background:repeating-linear-gradient(135deg,transparent 0 4px,var(--color-bg-subtle,rgba(127,127,127,.09)) 4px 8px);box-shadow:inset 0 0 0 1px var(--color-border-secondary,rgba(127,127,127,.12))}
.cell.mirror.mirror-data{cursor:pointer;opacity:.5}
.cell.mirror.mirror-data:hover{opacity:1;box-shadow:inset 0 0 0 2px var(--color-primary,#6366f1)}
.cell.diag{outline:1px dashed rgba(127,127,127,.5);outline-offset:-4px}

/* ── 运行光环（StarAvatar 同款：transform 旋转 SVG 组）──
 * 性能关键：旋转走 transform → 浏览器合成器线程（GPU），主线程零开销 ——
 * 此前的 stroke-dashoffset 方案不在合成器加速白名单，每帧主线程 style→paint，
 * 是持续的基底负载（与其他卡顿源叠加放大）。方形格子不能旋转（变形）→
 * 光环取内切圆形；运行格底色为主色浓底（heat-live）→ 白色主弧 + 强调色副弧保证对比。 */
.cell-ring{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ring-track{stroke:#fff;opacity:.2}
.ring-main{stroke:#fff;opacity:.95}
.ring-sub{stroke:var(--accent,#f472b6);opacity:.85}
/* 旋转：transform-box 对齐 viewBox，绕圆心匀速（周长 2π×46≈289） */
.ring-spin{transform-box:view-box;transform-origin:center;animation:ring-rotate 1.15s linear infinite}
.ring-spin--sub{animation-duration:1.9s;animation-delay:-.6s}
@keyframes ring-rotate{to{transform:rotate(360deg)}}

/* 十字聚焦：hover 时非十字区域置灰（衬托底色带十字）。
 * 只用 opacity（GPU 合成）不用 filter —— 400+ 格子上的 saturate() 会在
 * 每次 hover 切换时触发全矩阵样式重算，是滑动卡顿主因 */
.matrix-grid.cross-active .cell:not(.hl):not(:hover){opacity:.22}
.matrix-grid.cross-active .row-head:not(.hl){opacity:.35}
.matrix-grid.cross-active .col-head:not(.hl){opacity:.35}

/* ── 浓度色阶：范围内消息量对数归一化（c1 最浅 → c5；heat-live 留给运行中）── */
.heat-none{background:transparent}
.heat-live{background:color-mix(in srgb,var(--color-primary,#6366f1) 48%,transparent)}
.c1{background:color-mix(in srgb,var(--color-primary,#6366f1) 6%,transparent)}
.c2{background:color-mix(in srgb,var(--color-primary,#6366f1) 12%,transparent)}
.c3{background:color-mix(in srgb,var(--color-primary,#6366f1) 20%,transparent)}
.c4{background:color-mix(in srgb,var(--color-primary,#6366f1) 30%,transparent)}
.c5{background:color-mix(in srgb,var(--color-primary,#6366f1) 42%,transparent)}
/* 群参与证据格（无消息数值）：中性浅绿与浓度区分 */
.heat-evidence{background:color-mix(in srgb,#10b981 16%,transparent)}

/* ── 图例 + 覆盖面 ── */
.legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;font-size:11px;color:var(--color-text-tertiary,#a8abb2)}
.lg{display:inline-flex;align-items:center;gap:4px}
.swatch{display:inline-block;width:11px;height:11px;border-radius:4px}
/* 图例·运行光环小样：heat-live 底 + 白/accent 交替描边示意流转 */
.lg-ring{display:inline-block;width:11px;height:11px;border-radius:4px;background:color-mix(in srgb,var(--color-primary,#6366f1) 48%,transparent);border:2px solid #fff;animation:lg-ring-alt 1.15s linear infinite}
@keyframes lg-ring-alt{0%,45%{border-color:#fff}55%,100%{border-color:var(--accent,#f472b6)}}
.legend .note{color:var(--color-text-muted,#999)}
.coverage-toggle{display:flex;align-items:center;gap:4px;border:none;background:none;padding:2px 0;font-size:12px;color:var(--color-primary,#6366f1);cursor:pointer}
.coverage-toggle:hover{text-decoration:underline}
.coverage{width:min(680px,100%)}
.coverage-body{font-size:12px;line-height:1.8;color:var(--color-text-secondary)}
.coverage-body p{margin:0 0 4px}
.empty{padding:32px;text-align:center;color:var(--color-text-muted);font-size:13px;line-height:1.8}
/* 图例·浓度渐变小样（c1→c5 紧排成渐变条） */
.lg.scale .swatch{margin-right:-5px;border-radius:3px}
.lg.scale .swatch:last-of-type{margin-right:0;border-radius:3px 4px 4px 3px}

@media(max-width:768px){
  .page-header{padding:0 12px;gap:8px}
  .page-title{font-size:14px}
  .range-btn{padding:3px 8px;font-size:11px}
  .matrix-wrap{padding:12px}
}
</style>

<!-- tooltip 全局样式（Teleport 到 body，不能 scoped） -->
<style>
.mx-tip{position:fixed;z-index:10000;pointer-events:none;background:var(--bg-raised,#fff);border:1px solid var(--color-border-secondary,rgba(127,127,127,.22));border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);padding:10px 12px;display:flex;flex-direction:column;gap:5px;font-size:12px}
html.dark .mx-tip{background:#1c222e;border-color:rgba(255,255,255,.12)}
.mx-tip .tip-head{display:flex;align-items:center;gap:9px}
.mx-tip .tip-avatars{display:flex;align-items:center;gap:3px;flex-shrink:0}
.mx-tip .tip-ic{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;color:#f59e0b;background:rgba(245,158,11,.15)}
.mx-tip .tip-x{font-size:11px;color:var(--color-text-tertiary,#a8abb2)}
.mx-tip .tip-x.dim{color:var(--color-text-muted,#999)}
.mx-tip .tip-names{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden}
.mx-tip .tip-name{font-size:13px;font-weight:600;color:var(--color-text-primary);white-space:nowrap}
.mx-tip .tip-rel{font-size:11px;color:var(--color-primary,#6366f1);padding-bottom:4px;border-bottom:1px dashed var(--color-border-secondary,rgba(127,127,127,.2))}
.mx-tip .tip-row{display:flex;align-items:flex-start;gap:8px;line-height:1.5}
.mx-tip .tip-k{flex-shrink:0;min-width:38px;font-size:11px;color:var(--color-text-tertiary,#a8abb2)}
.mx-tip .tip-v{color:var(--color-text-secondary);min-width:0;word-break:break-word}
.mx-tip .tip-row.run .tip-v{color:var(--color-text-primary)}
.mx-tip .tip-empty{font-size:11.5px;color:var(--color-text-muted,#999);padding:2px 0}
.mx-tip .tip-foot{margin-top:3px;padding-top:5px;border-top:1px solid var(--color-border-secondary,rgba(127,127,127,.14));font-size:10.5px;color:var(--color-text-tertiary,#a8abb2);text-align:center}
</style>
