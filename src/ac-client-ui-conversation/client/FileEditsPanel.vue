<script setup lang="ts">
// ============================================================
// client/FileEditsPanel.vue —— 文件编辑 aux 选区面板
//
// 当前会话的文件编辑纵览（cr-86 抬头工具化：原折叠卡列表形态退役）：
// 固定抬头工具行——文件下拉（切被编辑文件，最近编辑序，同基名多文件
// 附目录段消歧）+ 版本下拉（初版→终版 / 当前内容 / 单次编辑 #N）+
// 上一版/下一版本步进 + 自动换行开关 + 本地打开；下方单文件视图 = 元信息行（路径 +
// 徽章 + ±统计）+ 填满剩余高度的 diff。数据 = feedStore.activeDialog
// .rawMessages → fileEdits 纯函数层（提取/重放/diff）。
//
// 选中态语义（2026-09-23 裁决承袭）：默认选中首文件只是初始形态——
// 流式刷新（files 高频重算）不能抢走用户正在看的文件；选中项自清单
// 消失（会话切换/文件移出）回落首项。版本下拉与上一/下一版本步进
// 是同一选择面的两个入口（cr-88：编辑时间线退役）。
//
// 会话上下文（同 TasksPanel）：1v1 / single 直连；群聊视角支持
//（多 Agent 编辑事件均带 agent_id——逐条署名）。bash 等间接写
// 不可追踪——底部提示。断链（存量文件打头）降级为统计展示 + partial
// 提示。
//
// 全量历史（P2）：编辑记录要覆盖整个会话——rawMessages 是分页
// 加载的（首屏一页），面板挂载且有 hasMore 时自动循环翻页拉全
//（loadMoreHistory 自带 loading 门——串行安全）。
//
// 方案 C（快照初版补全）：拉服务端首见快照（fileSnapshots/list）
// 接管存量断链——会话开始前已存在的文件也能完整 diff（快照底 +
// 会话内编辑链重放）。RPC 缺席/失败 = 回落方案 A 纯重放。
// ============================================================
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Button, IconAction, Icon, Select, Tooltip, toastError } from '@agentchat/webui-kit';
import { useClientContext } from 'ac-client-runtime';
import { countLineChanges } from 'ac-edit-core/src/diff.ts';
import { openLocalFile } from 'ac-client-ui-workspace/client/fileApi.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { parseDialogId } from './feed.ts';
import { useFeedStore } from './feedStore.ts';
import {
  extractFileEdits, replayFiles, applySnapshots, applyDiskFinals, diffOfSummary,
  diffOfStep, editStepsOf, diffOfContent,
  type FileEditSummary, type FileDiffResult, type FileEditStep,
  type RemoteSnapshot, type DiskContents,
} from './fileEdits.ts';

const feed = useFeedStore();
const ui = useUiStore();
const ctx = useClientContext();
const rpc = ctx?.rpc ?? null;

/** 活跃对话的原始消息（reactive 锚——流式/历史合并自动重算）。
 * 防抖视图（2026-09-21 性能整改）：analysisCore 管线随每条流式消息重算，
 * 尾沿 250ms 合并——流式 chunk 高频到达时面板不逐条重放。 */
const rawMessagesLive = computed(() => feed.activeDialog?.rawMessages ?? []);
const rawMessages = ref(rawMessagesLive.value);
let rawDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(rawMessagesLive, (msgs) => {
  if (rawDebounceTimer) clearTimeout(rawDebounceTimer);
  rawDebounceTimer = setTimeout(() => {
    rawDebounceTimer = null;
    rawMessages.value = msgs;
  }, 250);
}, { immediate: true });
onBeforeUnmount(() => { if (rawDebounceTimer) clearTimeout(rawDebounceTimer); });
const kind = computed(() => feed.activeDialog?.kind ?? null);

/**
 * 会话键（快照桶键）：pair = 对桶键（feed 内部键即 conversationId
 * 词表）、single = sid、group = 群 id——与工具执行时 loop 装配的
 * call.conversationId 同源。
 */
const conversationId = computed<string | null>(() => {
  const id = feed.activeDialogId;
  if (!id) return null;
  const { kind: k, key } = parseDialogId(id);
  if (k === 'pair') {
    // 对桶键：feed 存 partner，conversationId = bucketKey(viewer, partner)
    // ——直接复用 feed.ts 的 bucketKey 语义
    const partner = feed.activeDialog?.partner;
    return partner ? [partner, 'user'].sort().join('~') : key.replace('|', '~');
  }
  return key;
});

/**
 * 自动拉全历史：activeDialog 有 hasMore → 逐页 loadMoreHistory。
 * feed.loadMoreHistory 内部有 status==='loading' / !hasMore 门——
 * watch 重复触发安全；翻页完成（hasMore=false）后停止。group 分区
 * 一次性拉全无 hasMore——不触发。
 */
watch(
  () => [feed.activeDialogId, feed.hasMoreHistory] as const,
  ([id, hasMore]) => {
    if (!id || !hasMore) return;
    void feed.loadMoreHistory(id);
  },
  { immediate: true },
);

// ── 方案 C：快照拉取（会话切换 / run 收束时刷新）──
const snapshots = ref<RemoteSnapshot[]>([]);
// ── 磁盘终版兜底：仍 partial 的文件（无快照——机制上线前已编辑）──
const diskContents = ref<DiskContents>({});
async function refreshSnapshots(): Promise<void> {
  const cid = conversationId.value;
  if (!cid || !rpc) { snapshots.value = []; diskContents.value = {}; return; }
  try {
    const r = await rpc.call<{ snapshots?: RemoteSnapshot[] }>('fileSnapshots/list', { conversationId: cid });
    snapshots.value = Array.isArray(r.snapshots) ? r.snapshots : [];
  } catch {
    snapshots.value = []; // RPC 缺席（行未装）= 回落方案 A
  }
  // 二段兜底：当前仍 partial 的文件请求磁盘现内容（终版 = 磁盘，
  // 初版逆向回推）。路径需绝对形态——相对路径（沙箱内）无法寻址，
  // 跳过（由快照/方案 A 覆盖）。
  void loadDiskForPartials();
}

/** 收集 partial 文件的绝对路径并批量拉磁盘内容 */
async function loadDiskForPartials(): Promise<void> {
  if (!rpc) { diskContents.value = {}; return; }
  const partialPaths = [...analysisOf().files.values()]
    .filter((s) => s.partial && /^([a-zA-Z]:[\\/]|\/)/.test(s.path)) // 绝对路径形态
    .map((s) => s.path.replace(/\\/g, '/'));
  if (partialPaths.length === 0) {
    // 已空不再赋值：流式期 refreshSnapshots 频率上升（after-execute 逐工具
    // 触发），无谓的 {} 替换会让 analysisCore 连环失效重算
    if (Object.keys(diskContents.value).length > 0) diskContents.value = {};
    return;
  }
  try {
    const r = await rpc.call<{ contents?: DiskContents }>('fileSnapshots/read-current', { paths: partialPaths });
    diskContents.value = r.contents ?? {};
  } catch {
    diskContents.value = {};
  }
}

/** 无快照拉取依赖的中间分析（loadDiskForPartials 判定 partial 用）——
 * 复用轻核心 computed（与主分析同代际，无重复管线） */
function analysisOf() {
  return analysisCore.value;
}

watch(conversationId, () => void refreshSnapshots(), { immediate: true });
// 收束/落盘刷新：run 收束（loop/after-run）+ 写工具执行完毕
//（tool/after-execute——流式过程中刷新，快照首见落盘即生效，不等 run
// 收束；2026-09-21 前端反馈：编辑存量文件时面板陈旧提示「无法重建内容」
// 直到刷新页面——刷新时机粒度过粗所致）。事件均带会话键，异会话跳过。
const offEvents = rpc?.onEvent((type: string, args: unknown[]) => {
  if (type === 'loop/after-run') {
    const [request] = args as Array<{ conversationId?: string } | undefined>;
    if (request?.conversationId && request.conversationId === conversationId.value) {
      void refreshSnapshots();
    }
    return;
  }
  if (type === 'tool/after-execute') {
    const [call] = args as Array<{ name?: string; conversationId?: string } | undefined>;
    if (call?.conversationId !== conversationId.value) return;
    const tool = typeof call.name === 'string' ? call.name : '';
    if (tool !== 'write' && tool !== 'edit' && tool !== 'str_replace_editor') return;
    void refreshSnapshots();
  }
}) ?? (() => undefined);
onBeforeUnmount(() => offEvents());

/**
 * 分析拆分（2026-09-21 性能整改）：原单 computed fileEditsFull 每次重算都对
 * 【全部文件】eager 生成 diff（fileEditsFull 尾段逐文件 diffOfSummary），
 * 但 UI 只看选中文件（cr-86 抬头工具化前为展开卡）。现拆两段：
 *   events+files = 轻管线（提取/重放/快照/磁盘兜底——流式期间可承受）
 *   diffs        = 惰性（依赖 selected，仅选中文件生成 diffOfSummary）
 * 语义对齐 fileEditsFull——只是 diff 从「全量预生成」变「按需」。
 */
const analysisCore = computed(() => {
  const events = extractFileEdits(rawMessages.value);
  let files = applySnapshots(replayFiles(events), events, snapshots.value);
  files = applyDiskFinals(files, events, diskContents.value);
  return { events, files };
});
const analysis = computed(() => ({
  events: analysisCore.value.events,
  files: analysisCore.value.files,
  diffs: lazyDiffs.value,
}));
/** 选中文件的 diff（未选中不在数组——与全量 diffs 数组的消费差异由
 *  diffOf 兜底语义吸收：find 不到 → comparable:false 回退对象）。
 *  折叠卡时期 = 展开卡集合；抬头工具化（cr-86）后 = 选中文件单员。 */
const lazyDiffs = computed(() => {
  const s = sel.value;
  return s ? [diffOfSummary(s)] : [];
});

/** 文件清单（最近编辑在前；无编辑 = 空态） */
const files = computed(() =>
  [...analysis.value.files.values()].sort((a, b) => b.lastAt - a.lastAt),
);

/** 统计条 */
const totalEdits = computed(() => analysis.value.events.filter((e) => e.ok).length);
const totalFiles = computed(() => files.value.length);
/** 卡片统计（工具报告缺失 +0/-0 时以重放初版↔终版 LCS 回填——新建文件可见 +N）。
 * 记忆化（2026-09-21 性能整改）：LCS 回填只在 analysis 代际变化时算一次——
 * 原实现每次渲染每卡片重算（模板/statOf 直调），多文件多版本时是卡顿源之一。 */
const statByPath = computed(() => {
  const m = new Map<string, { added: number; removed: number }>();
  for (const s of analysis.value.files.values()) {
    let stat = { added: s.added, removed: s.removed };
    if ((s.added > 0 || s.removed > 0) || s.finalContent === null) { /* 工具报告值直用 */ }
    else {
      const base = s.partial ? s.partialBase : s.baseContent;
      if (base !== null) stat = countLineChanges(base, s.finalContent);
    }
    m.set(s.path, stat);
  }
  return m;
});
function statOf(s: FileEditSummary): { added: number; removed: number } {
  return statByPath.value.get(s.path) ?? { added: s.added, removed: s.removed };
}
const totalAdded = computed(() => files.value.reduce((n, f) => n + statOf(f).added, 0));
const totalRemoved = computed(() => files.value.reduce((n, f) => n + statOf(f).removed, 0));

/** bash 等间接写提示（会话有 shell 调用但面板只覆盖编辑工具） */
const hasShellCalls = computed(() =>
  rawMessages.value.some((m) =>
    m.role === 'agent' && Array.isArray(m.toolCalls) &&
    (m.toolCalls as Array<{ name?: string }>).some((tc) => tc.name === 'bash'),
  ),
);

// ── 选中文件（抬头工具化：单文件视图）──
/** 选中路径（null = 无——空态/会话无编辑）。默认选中只是初始形态：
 *  流式刷新（files 高频重算）不能抢走用户正在看的文件（2026-09-23
 *  裁决承袭——原「收起全部卡片被强制弹回」的同源语义）；选中项自
 *  清单消失（会话切换/文件移出）回落首项。 */
const selected = ref<string | null>(null);

/** 当前选中文件的汇总（无选中 = null——空态）。读 analysisCore（轻核心）——
 *  读 analysis 会成环：sel → analysis.diffs(lazyDiffs) → sel。 */
const sel = computed<FileEditSummary | null>(() =>
  analysisCore.value.files.get(selected.value ?? '') ?? null);

watch(files, (list) => {
  if (!selected.value || !list.some((s) => s.path === selected.value)) {
    selected.value = list[0]?.path ?? null;
  }
}, { immediate: true });

function selectFile(path: string) {
  selected.value = path;
}

/** 文件下拉项：基名（同基名多文件时附目录段消歧） */
const dupBasenames = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of files.value) {
    const b = fileLabel(s);
    if (seen.has(b)) dup.add(b);
    seen.add(b);
  }
  return dup;
});
function fileOptionLabel(s: FileEditSummary): string {
  const b = fileLabel(s);
  return dupBasenames.value.has(b) ? b + " · " + (dirLabel(s) || s.path) : b;
}

/** 文件下拉选项面（kit Select——cr-192） */
const fileOptions = computed(() =>
  files.value.map((s) => ({ value: s.path, label: fileOptionLabel(s) }))
);

/** diff 自动换行（缺省关 = 横向滚动——与预览页代码视图同语义；
 *  深行 diff 对照时开启软换行免横向拖动） */
const wrap = ref(false);

// ── 逐次回放（视图选择）──
// 选中态 per-path：'' = 总览（初版→终版——默认）；'content' = 当前内容
// （终版全文直读——新建文件等 diff 基底缺失场景的内容可见面）；数字 =
// 单次编辑步序（对应 editStepsOf 索引）。跨文件独立、重放数据变化时归零。
const viewSel = ref<Map<string, number | 'content' | ''>>(new Map());

/** 单文件可回放步（时间序；comparable 文件至少 1 步） */
function stepsOf(s: FileEditSummary): FileEditStep[] {
  return editStepsOf(s, analysis.value.events);
}

/**
 * 视图读取：未选择过时智能缺省——总览 diff 恒空（新建后仅单次写入，
 * 初版=终版）默认「当前内容」，展开即见内容无需手动切换；用户显式
 * 选择后（含选回总览）以选择为准。
 */
function viewOf(path: string): number | 'content' | '' {
  const v = viewSel.value.get(path);
  if (v !== undefined) return v;
  const s = analysis.value.files.get(path);
  if (s && !s.partial && s.finalContent !== null && s.baseContent === s.finalContent) {
    return 'content';
  }
  return '';
}
function setView(path: string, v: number | 'content' | '') {
  viewSel.value = new Map(viewSel.value).set(path, v);
}

/** 当前生效视图：选中步失效（编辑序列变化——越界）时回落总览 */
function effectiveView(s: FileEditSummary): number | 'content' | '' {
  const v = viewOf(s.path);
  if (typeof v === 'number' && v >= stepsOf(s).length) return '';
  return v;
}

/** 视图下拉选中项：步序 → callId 锚（步序列变化时 select 值仍指向
 *  同一编辑事件——比裸索引稳） */
function viewOptionOf(s: FileEditSummary): string {
  const v = effectiveView(s);
  if (v === 'content') return 'content';
  return v === '' ? '' : stepsOf(s)[v]?.event.callId ?? '';
}
function selectViewByOption(s: FileEditSummary, option: string) {
  if (option === '') { setView(s.path, ''); return; }
  if (option === 'content') { setView(s.path, 'content'); return; }
  const idx = stepsOf(s).findIndex((st) => st.event.callId === option);
  setView(s.path, idx >= 0 ? idx : '');
}

/** 视图下拉选项面（kit Select 平铺——cr-192：段界 ⟂ 并入选项文本，
 *  分组语义保留不再依赖 optgroup） */
const viewOptions = computed(() => {
  const s = sel.value;
  if (!s) return [];
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: '初版 → 终版' }];
  for (const st of stepsOf(s)) opts.push({ value: st.event.callId, label: stepOptionLabel(st) });
  if (s.finalContent !== null) opts.push({ value: 'content', label: '当前内容' });
  return opts;
});

/** 视图序列（线性化——上一/下一版本按钮的游标面）：[总览, 编辑
 * #1..#N, 当前内容（若有）]，与下拉选项同序同员。 */
function viewSeq(s: FileEditSummary): Array<number | 'content' | ''> {
  const seq: Array<number | 'content' | ''> = [''];
  const steps = stepsOf(s);
  for (let i = 0; i < steps.length; i++) seq.push(i);
  if (s.finalContent !== null) seq.push('content');
  return seq;
}

/** 当前视图在序列中的游标（不在序列中——如选中步越界被 effectiveView
 * 回落前——安全回落总览位 0） */
function viewCursor(s: FileEditSummary): number {
  const idx = viewSeq(s).indexOf(effectiveView(s));
  return idx >= 0 ? idx : 0;
}

/** 上一/下一版本（边界钳制不动；点击即写入选中态——下拉/时间线联动同步） */
function stepView(s: FileEditSummary, dir: -1 | 1): void {
  const seq = viewSeq(s);
  const next = viewCursor(s) + dir;
  if (next < 0 || next >= seq.length) return;
  setView(s.path, seq[next]);
}

/** 当前视图 diff：总览 = diffOf 既有；单次 = diffOfStep；当前内容 = 全文 + 行。
 * 记忆化（2026-09-21 性能整改）：原实现为模板直调函数——每次渲染每卡重算
 *（模板内被引用两处：统计行 + parseDiff），展开多卡时 diff 生成被放大。
 * 现 per-analysis 代际 × viewSel 代际记忆化：展开卡只算一次，重渲染查表。 */
const viewDiffByPath = computed(() => {
  const m = new Map<string, FileDiffResult>();
  for (const s of analysis.value.files.values()) {
    const v = effectiveView(s);
    if (v === 'content') m.set(s.path, diffOfContent(s));
    else if (v === '') m.set(s.path, diffOf(analysis.value.diffs, s));
    else {
      const step = stepsOf(s).at(Number(v));
      m.set(s.path, step ? diffOfStep(step) : diffOf(analysis.value.diffs, s));
    }
  }
  return m;
});
function viewDiff(s: FileEditSummary): FileDiffResult {
  return viewDiffByPath.value.get(s.path) ?? diffOf(analysis.value.diffs, s);
}

// ── 分段链展示辅助（方案 B）：段界并入下拉选项文本（cr-192——optgroup
//    随原生 select 退役，stepOptionLabel 的 ⟂ 前缀承担分组语义）──

/** 不可回放计数：成功事件数 - 版本点数（mismatches 为重放层失配——取大者展示） */
function unreplayableOf(s: FileEditSummary): number {
  const okCount = s.events.filter((e) => e.ok).length;
  return Math.max(s.mismatches, okCount - stepsOf(s).length);
}

/** 视图标签：总览固定「初版 → 终版」；当前内容「文件当前内容」；单次「编辑 #N」
 *（段首步附注外部修改——分段链：失配点之后以磁盘终态锚定新段基底） */
function viewLabel(s: FileEditSummary): string {
  const v = effectiveView(s);
  if (v === 'content') return '文件当前内容';
  if (v === '') return '初版 → 终版';
  const base = `编辑 #${v + 1}`;
  // 段首步（segment>0 且 segmentStep===0）= 外部修改后首步——附注
  const st = stepsOf(s).at(v);
  return st !== undefined && st.segment > 0 && st.segmentStep === 0 ? `${base}（外部修改后）` : base;
}

/** 下拉项文字：单次编辑 = #N + 时间 + 动作 + 真实行变更（LCS——
 *  与单次 diff 所见一致；工具报告口径在 old/new 含未变上下文时
 *  会偏大，不采用）。段首步前缀 ⟂ = 其前发生过事件流外的外部修改 */
function stepOptionLabel(st: FileEditStep): string {
  const a = ACTION_LABEL[st.event.action] ?? st.event.action;
  const mark = st.segment > 0 && st.segmentStep === 0 ? '⟂ ' : '';
  return `${mark}#${st.index + 1} ${timeOf(st.event.timestamp)} ${a} +${st.added}/-${st.removed}`;
}

/** diff 行解析（generateDiffString 输出：'- 12 内容' / '+ 12 内容' / '  12 内容' / '...'）。
 * 记忆化（2026-09-21 性能整改）：per-path 行数组随视图代际算一次——原模板直调
 * 每次 v-for 重渲染都 split+map（截断提示行还引用第二次）数千行 × 每卡。
 * 三段拆分（cr-90）：'符号 行号 内容' 拆独立三列渲染——符号列窄定宽、
 * 行号列右对齐弱化，正文列 flex:1——不再挤在一串里。 */
interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'sep' | 'plain'; sign: string; num: string; text: string }
const DIFF_LINE_RE = /^([+\- ]) (\d+)(?: (.*))?\r?$/;
function parseDiffLine(raw: string, plain: boolean): DiffLine {
  // CRLF 文件：split('\n') 后行尾残留 '\r'——先剥（否则正则失配全落容错分支）
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line === '...') return { kind: 'sep', sign: '', num: '', text: line };
  const m = DIFF_LINE_RE.exec(line);
  if (m) {
    const sign = m[1] === ' ' ? '' : m[1];
    // 「当前内容」视图：全文非 diff 语义——kind plain、符号列恒空（无 +/-）
    const kind = plain ? 'plain' : sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
    return { kind, sign: plain ? '' : sign, num: m[2], text: String(m[3]) }; // 可选组缺席时 exec 得 null——String() 归空串
  }
  // 非约定格式（容错）：整行入正文列
  return { kind: plain ? 'plain' : 'ctx', sign: '', num: '', text: line };
}
const diffLinesByPath = computed(() => {
  const m = new Map<string, DiffLine[]>();
  for (const [path, d] of viewDiffByPath.value) {
    const s = analysisCore.value.files.get(path);
    const plain = !!s && effectiveView(s) === 'content';
    m.set(path, d.comparable ? d.diff.split('\n').map((line) => parseDiffLine(line, plain)) : []);
  }
  return m;
});
function parseDiffOf(path: string): DiffLine[] {
  return diffLinesByPath.value.get(path) ?? [];
}

/** 行号列宽（cr-191）：按选中文件 diff 的最大行号位数动态计算——定宽在多行号
 *  位数下溢出与正文重叠。全局 border-box：width 须含 padding(6+10) +
 *  border(1)，数字净宽 N×1ch 之外补 17px 常量。两列（del/ctx 或 add/ctx）
 *  同行共用一列渲染，取全行最大值即可。 */
const NUM_COL_EXTRA_PX = 17;
const numColWidth = computed(() => {
  let max = 0;
  for (const line of parseDiffOf(sel.value?.path ?? '')) {
    if (line.num.length > max) max = line.num.length;
  }
  return `calc(${Math.max(max, 2)}ch + ${NUM_COL_EXTRA_PX}px)`;
});

/** 动作中文标签 */
const ACTION_LABEL: Record<string, string> = {
  create: '新建', overwrite: '写入', edit: '编辑', replace: '替换', insert: '插入', unknown: '编辑',
};

function fileLabel(s: FileEditSummary): string {
  return s.path.split(/[/\\]/).pop() || s.path;
}
function dirLabel(s: FileEditSummary): string {
  const idx = Math.max(s.path.lastIndexOf('/'), s.path.lastIndexOf('\\'));
  return idx > 0 ? s.path.slice(0, idx + 1) : '';
}
function timeOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
// ── 本地打开（系统默认程序；服务端按会话/Agent 工作区基准定位路径）──
const openLocalPaths = ref(new Map<string, 'opening' | 'error'>());

/** 读面推导上下文（与 ConversationView.handlePreviewFile 同口径）：
 *  会话键（single = 会话 id，pair = 对桶键）+ 最近编辑者 Agent */
const readContext = computed(() => {
  const dialog = feed.activeDialog;
  if (!dialog) return {};
  const { kind, key } = parseDialogId(dialog.id as never);
  if (kind === 'single') return { conversationId: key };
  if (kind === 'group') return {};
  // pair：key = 'a|b'（排序端点）→ 对桶键 'a~b'（会话文件桶形态）
  const parts = key.split('|');
  if (parts.length === 2) return { conversationId: [parts[0], parts[1]].sort().join('~') };
  return {};
});

function agentOfCard(s: FileEditSummary): string {
  return [...s.events].reverse().find((e) => e.ok && e.agentId)?.agentId ?? '';
}

function openStateOf(path: string): 'opening' | 'error' | undefined {
  return openLocalPaths.value.get(path);
}

async function openLocally(s: FileEditSummary) {
  if (!rpc || openStateOf(s.path) === 'opening') return;
  openLocalPaths.value.set(s.path, 'opening');
  let errMsg = '';
  try {
    const agent = agentOfCard(s);
    const r = await openLocalFile(s.path, { ...readContext.value, ...(agent ? { agentId: agent } : {}) }, rpc);
    if (r.error) errMsg = r.error;
    else openLocalPaths.value.delete(s.path);
  } catch (err: any) {
    errMsg = err?.message ?? String(err);
  }
  if (errMsg) {
    openLocalPaths.value.set(s.path, 'error');
    toastError(`本地打开失败：${errMsg}`, { key: 'open-local', duration: 4000 });
  }
}

// ── 复制（cr-198，cr-199 语义修正：随视图——复制「下面显示的版本」
//    全文。编辑 #N = 该步后全文（version point content）；当前内容 =
//    终版；总览 = 终版。copied/error 态 2s 复位）──
const copyState = ref<'idle' | 'copied' | 'error'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopy(state: 'copied' | 'error') {
  copyState.value = state;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
}
/** 当前视图对应版本全文（视图→版本点分派；无可复制面 = null）。
 *  编辑步取 step.after（该步后全文——editStepsOf 版本点形态） */
function viewContentOf(s: FileEditSummary): string | null {
  const v = effectiveView(s);
  if (v === 'content' || v === '') return s.finalContent;
  return stepsOf(s).at(Number(v))?.after ?? null;
}
function copyViewContent() {
  const s = sel.value;
  const text = s ? viewContentOf(s) : null;
  if (text === null) return;
  navigator.clipboard.writeText(text).then(
    () => flashCopy('copied'),
    () => flashCopy('error'),
  );
}
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });
</script>

<template>
  <div class="fe-panel">
    <div class="fe-head">
      <span class="fe-title">文件编辑</span>
      <span class="fe-ctx">
        <template v-if="kind === 'group'">群聊视角</template>
        <template v-else-if="totalFiles > 0">{{ totalFiles }} 个文件 · {{ totalEdits }} 次编辑 · +{{ totalAdded }}/-{{ totalRemoved }}</template>
        <template v-else>当前会话</template>
      </span>
      <!-- 关闭面板（区域级收起；keepAlive 选区——重开恢复滚动位置）。
           与 FilePreviewPanel 头部关闭钮同语义：ui.auxVisible=false -->
      <Tooltip text="关闭面板" placement="bottom">
        <IconAction icon="x" label="关闭面板" :size="14" suppress-title @click="ui.auxVisible = false" />
      </Tooltip>
    </div>

    <div class="fe-body">
      <!-- 空态 -->
      <div v-if="totalFiles === 0" class="fe-empty">
        <Icon name="file-diff" :size="28" />
        <p>本会话暂无文件编辑记录</p>
        <p class="fe-empty-sub">Agent 使用 write / edit / str_replace_editor 修改文件时会在此汇总</p>
      </div>

      <!-- 单文件视图（抬头工具化）：工具行 + 元信息 + diff + 时间线 -->
      <template v-if="sel">
        <!-- 抬头工具行：文件下拉 + 版本下拉 + 上一/下一版本 + 换行 + 本地打开
             （kit Select/IconAction——cr-192 归一） -->
        <div class="fe-toolbar">
          <Select
            class="fe-file-select"
            :options="fileOptions"
            :model-value="sel.path"
            :title="sel.path"
            @update:model-value="(v) => selectFile(v)"
          />
          <!-- 版本选择（当前内容 / 编辑次数 > 1 才有逐次视角）+ 步进 + 换行 -->
          <Select
            v-if="sel.finalContent !== null || stepsOf(sel).length > 1"
            class="fe-view-select"
            :options="viewOptions"
            :model-value="viewOptionOf(sel)"
            @update:model-value="(v) => sel && selectViewByOption(sel, v)"
          />
          <span class="fe-view-nav">
            <Tooltip text="上一版本" placement="top">
              <IconAction icon="chevron-left" label="上一版本" :size="13" suppress-title :disabled="viewCursor(sel) === 0" @click="stepView(sel, -1)" />
            </Tooltip>
            <Tooltip text="下一版本" placement="top">
              <IconAction icon="chevron-right" label="下一版本" :size="13" suppress-title :disabled="viewCursor(sel) >= viewSeq(sel).length - 1" @click="stepView(sel, 1)" />
            </Tooltip>
          </span>
          <!-- 自动换行（icon 开关 + on 态高亮） -->
          <Tooltip :text="wrap ? '自动换行：开 · 点击关闭' : '自动换行：关 · 点击开启'" placement="bottom">
            <IconAction icon="wrap-text" label="自动换行" :size="14" suppress-title :class="{ on: wrap }" @click="wrap = !wrap" />
          </Tooltip>
          <!-- 复制当前视图版本全文（编辑 #N = 该步后全文；copied 态绿勾 2s） -->
          <Tooltip :text="copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制当前版本内容'" placement="bottom">
            <IconAction
              :icon="copyState === 'copied' ? 'check' : copyState === 'error' ? 'alert-circle' : 'copy'"
              label="复制当前版本内容"
              :size="14"
              suppress-title
              :class="{ ok: copyState === 'copied', error: copyState === 'error' }"
              @click="copyViewContent"
            />
          </Tooltip>
          <!-- 本地打开（系统默认程序；失败态红色警示可重试） -->
          <Tooltip
            v-if="openStateOf(sel.path) !== 'error'"
            :text="openStateOf(sel.path) === 'opening' ? '打开中…' : '本地打开（系统默认程序）'"
            placement="bottom"
          >
            <IconAction
              :icon="openStateOf(sel.path) === 'opening' ? 'loader-circle' : 'external-link'"
              label="本地打开（系统默认程序）"
              :size="14"
              suppress-title
              :class="{ spin: openStateOf(sel.path) === 'opening' }"
              :disabled="openStateOf(sel.path) === 'opening'"
              @click="openLocally(sel)"
            />
          </Tooltip>
          <IconAction
            v-else
            icon="alert-circle"
            label="本地打开失败（路径不可达或平台不支持）"
            :size="14"
            class="error"
            @click="openLocally(sel)"
          />
        </div>

        <!-- 选中文件元信息：完整路径 + 徽章 + 统计 -->
        <div class="fe-meta">
          <span class="fe-file-path" :title="sel.path">{{ sel.path }}</span>
          <span class="fe-badges">
            <span v-if="sel.created" class="ui-badge ok">新建</span>
            <span v-if="sel.partial" class="ui-badge warn">部分</span>
            <span class="fe-stat"><span class="fe-add-num">+{{ statOf(sel).added }}</span><span class="fe-del-num">/-{{ statOf(sel).removed }}</span></span>
            <span class="fe-count">{{ sel.editCount }} 次</span>
          </span>
        </div>

        <!-- 断链提示（存量文件打头） -->
        <div v-if="sel.diskBackfill" class="fe-partial-note">
          此文件无会话首见快照——初版自磁盘终版逆向回推编辑记录（自会话内首次可回推点起算）
        </div>
        <div v-else-if="sel.partial" class="fe-partial-note">
          <template v-if="sel.finalContent !== null">此文件在会话开始前已存在——diff 自会话内首次全量写入起算</template>
          <template v-else>此文件在会话开始前已存在，会话内无全量写入——无法重建内容，仅展示编辑统计</template>
        </div>
        <div v-if="unreplayableOf(sel) > 0" class="fe-partial-note warn">有 {{ unreplayableOf(sel) }} 条编辑无法在重放中定位或回放（外部修改或消息流残缺）——终版可能与实际有偏差</div>

        <!-- diff 视图（可比对 / 当前内容视图） -->
        <template v-if="diffOf(analysis.diffs, sel).comparable || sel.finalContent !== null">
          <div class="fe-diff-meta">
            <span class="fe-view-label">{{ viewLabel(sel) }}</span>
            <span class="fe-diff-stat">+{{ viewDiff(sel).added }} / -{{ viewDiff(sel).removed }}</span>
          </div>
          <div class="fe-diff">
            <!-- 渲染行截断（性能护栏）：超大 diff（数千行——「当前内容」视图或大改写）
                 只渲染首 400 行；容器自身滚动，剩余行以计数提示代替，
                 避免一次性挂载数千 DOM 节点卡死渲染线程 -->
            <div
              v-for="(line, i) in parseDiffOf(sel.path).slice(0, 400)"
              :key="i"
              class="fe-diff-line"
              :class="[wrap ? 'wrap' : '', 'fe-' + line.kind]"
            ><span class="fe-diff-sign">{{ line.sign }}</span><span class="fe-diff-num" :style="{ width: numColWidth }">{{ line.num }}</span><span class="fe-diff-text">{{ line.text }}</span></div>
            <div v-if="parseDiffOf(sel.path).length > 400" class="fe-diff-line ctx">
              <span class="fe-diff-sign"></span><span class="fe-diff-num" :style="{ width: numColWidth }"></span>
              <span class="fe-diff-text">… 仅渲染前 400 行（共 {{ parseDiffOf(sel.path).length }} 行）——完整内容请本地打开</span>
            </div>
          </div>
        </template>
        <!-- 不可比对：仅统计 -->
        <div v-else class="fe-no-diff">无法生成 diff（见上方说明）</div>
      </template>

      <!-- bash 提示 -->
      <div v-if="hasShellCalls && totalFiles > 0" class="fe-shell-note">
        本会话还执行过 shell 命令——命令造成的文件变更不在追踪范围
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** 从 diffs 数组取指定文件的 diff（模板辅助——避免每次重算） */
function diffOf(diffs: FileDiffResult[], s: FileEditSummary): FileDiffResult {
  return diffs.find((d) => d.path === s.path) ?? { path: s.path, comparable: false, diff: '', added: 0, removed: 0, partial: s.partial };
}
export default { name: 'FileEditsPanel' };
</script>

<style scoped>
.fe-panel {
  display: flex; flex-direction: column;
  height: 100%; min-width: 0; overflow: hidden;
  background: var(--bg-base);
}
.fe-head {
  display: flex; align-items: center; gap: 8px;
  height: var(--layout-header-height, 48px); padding: 0 16px; flex-shrink: 0;
  border-bottom: 1px solid var(--line);
}
.fe-title { font-size: 13px; font-weight: 600; flex-shrink: 0; }
.fe-ctx { font-size: 11px; color: var(--text-3); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 头部关闭钮已迁 kit IconAction（cr-192——fe-ctx flex:1 推钮到最右） */

/* 单列填满布局（cr-88 时间线退役）：.fe-body 不再滚动——diff 区
   flex:1 吸收剩余高度并自带滚动，其余行按内容收缩 */
.fe-body { flex: 1; min-height: 0; padding: 12px; display: flex; flex-direction: column; gap: 10px; }

.fe-empty { padding: 32px 12px; text-align: center; color: var(--text-3); display: flex; flex-direction: column; align-items: center; gap: 6px; }
.fe-empty p { margin: 0; font-size: 12px; }
.fe-empty-sub { font-size: 11px; opacity: 0.8; }

/* ── 抬头工具行（文件下拉 + 版本下拉 + 版本步进 + 本地打开——
      控件本体已迁 kit Select/IconAction，cr-192）── */
.fe-toolbar { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
/* 文件下拉（kit Select）：定宽（cr-194——flex:1 随容器伸缩同样漂移后续钮）。
   width 覆写组件根 .ui-sel 的 width:100%（cr-193：100% 在 flex 行内吞满工具行） */
.fe-file-select { width: 240px; flex: 0 0 240px; min-width: 0; }
.fe-file-select :deep(.ui-sel-trigger) { height: 22px; padding: 0 6px; font-size: var(--fs-xs); }

/* 选中文件元信息行（完整路径 + 徽章/统计） */
.fe-meta { display: flex; align-items: center; gap: 8px; min-width: 0; flex-shrink: 0; }
.fe-file-path {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; font-family: 'SF Mono', 'Cascadia Code', monospace;
  color: var(--text-2);
}
/* 徽章行：徽章本体走 kit .ui-badge 族（本组件不再自建徽章样式），此处仅排版 */
.fe-badges { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.fe-stat { font-size: 11px; font-family: 'SF Mono', 'Cascadia Code', monospace; }
/* +N/-M 红绿着色（与 diff 行同色系：增=绿、删=红） */
.fe-add-num { color: var(--ok-status); }
.fe-del-num { color: var(--err-status); }
.fe-count { font-size: 11px; color: var(--text-3); }

/* 本地打开已迁 kit IconAction（cr-192）；失败态红标 + 转圈经宿主类 */

.fe-partial-note { font-size: 11px; color: var(--warn); background: rgba(var(--warn-rgb), 0.08); border: 1px solid rgba(var(--warn-rgb), 0.25); border-radius: var(--radius-sm); padding: 6px 10px; }
.fe-partial-note.warn { color: var(--err); background: rgba(var(--err-rgb), 0.06); border-color: rgba(var(--err-rgb), 0.2); }

.fe-diff-meta { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-3); }
.fe-diff-stat { font-family: 'SF Mono', 'Cascadia Code', monospace; }

/* ── 版本下拉 + 步进钮 + 换行钮已迁 kit Select/IconAction（cr-192）── */
/* 版本下拉（kit Select）：定宽（cr-194——自适应宽随选中项（初版→终版 vs
   编辑 #12 …）伸缩，推挤后续步进钮位置漂移，无法同位连点）；值区 ellipsis
   截长（kit 自带）。覆写组件根 width:100%（100% 会吞满工具行，cr-193）。 */
.fe-view-select { width: 168px; flex: 0 0 168px; min-width: 0; }
.fe-view-select :deep(.ui-sel-trigger) { height: 22px; padding: 0 6px; font-size: var(--fs-xs); }
.fe-view-nav { display: inline-flex; gap: 2px; flex-shrink: 0; }
/* IconAction 宿主态：失败红标 / 复制成功绿标 / 换行开 primary 高亮 / 打开中转圈 */
.fe-toolbar :deep(.ui-icon-action.error) { color: var(--err); }
.fe-toolbar :deep(.ui-icon-action.ok) { color: var(--ok); }
.fe-toolbar :deep(.ui-icon-action.on) { color: var(--primary); background: var(--primary-light); }
.fe-toolbar :deep(.ui-icon-action.spin) svg { animation: fe-spin 0.9s linear infinite; }
@keyframes fe-spin { to { transform: rotate(360deg); } }
.fe-diff {
  flex: 1; min-height: 0; /* 填满剩余高度（cr-88）——工具行/元信息/提示行按内容收缩 */
  border: 1px solid var(--line); border-radius: var(--radius-md);
  background: var(--code-bg); overflow: auto;
}
.fe-diff-line { display: flex; padding: 1px 12px; font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace; font-size: 11.5px; line-height: 1.6; white-space: pre; }
/* 自动换行（cr-89）：软换行替代横向滚动 */
.fe-diff-line.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
/* 三列分块（cr-90）：符号列窄定宽 / 行号列右对齐+右分界线 / 正文列 flex:1。
   成块增强（cr-91）：符号列底色随行、行号列弱底色+分界线、行底色加浓——
   三列视觉成块而非一整串文本 */
.fe-diff-sign {
  width: 16px; flex-shrink: 0; text-align: center; user-select: none;
  margin-left: -12px; padding-left: 2px; /* 行左距让给符号列着色 */
  border-right: 1px solid var(--line);
}
/* 行号列：右对齐；宽度随最大行号位数动态（cr-191——内联 :style 单源） */
.fe-diff-num {
  flex-shrink: 0; text-align: right; padding: 0 10px 0 6px;
  color: var(--text-3); opacity: 0.6; user-select: none;
  border-right: 1px solid var(--line);
}
.fe-diff-text { flex: 1; min-width: 0; }
/* 行底色铺满三列（cr-93 统一——符号/行号列不再独立加深/减弱，去割裂） */
/* 正文回归码色（cr-141·方案 B）：语义由行底 tint + 符号列承载，
   正文用 code-text——大段红绿文字是色噪，且 nebula err 正文 4.25 破 4.5 线。
   符号列墨与行底 tint 同用文字档（cr-146 口径：tint 底构图墨底同源）。
   cr-224 提档：用户反馈行底偏淡——α 统一 0.18（ok 4.64 / err 4.57 on
   Aurora tint，4.5 线安全上限；Nebula 符号墨 4.94/3.99 走 3.0 图形线档，
   正文对比度 10.4 / 7.0 仍宽裕） */
.fe-add { background: rgba(var(--ok-rgb), 0.18); }
.fe-add .fe-diff-sign { color: var(--ok); }
.fe-add .fe-diff-text { color: var(--code-text); }
.fe-del { background: rgba(var(--err-rgb), 0.18); }
.fe-del .fe-diff-sign { color: var(--err); }
.fe-del .fe-diff-text { color: var(--code-text); }
.fe-ctx .fe-diff-text { color: var(--text-1); }
.fe-sep .fe-diff-text { color: var(--text-3); opacity: 0.5; font-style: italic; }
/* 「当前内容」全文视图（cr-89）：非 diff 语义——无 +/- 前缀着色，正文常规色 */
.fe-plain .fe-diff-text { color: var(--text-1); }

.fe-no-diff { font-size: 11px; color: var(--text-3); padding: 8px 4px; }

.fe-shell-note { font-size: 11px; color: var(--text-3); text-align: center; padding: 8px 4px; border-top: 1px dashed var(--line); flex-shrink: 0; }
</style>
