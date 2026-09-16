<script setup lang="ts">
// ============================================================
// client/FileEditsPanel.vue —— 文件编辑 aux 选区面板
//
// 当前会话的文件编辑纵览：逐文件折叠卡（统计 + 初版↔终版 diff）+
// 展开后的编辑事件时间线。数据 = feedStore.activeDialog.rawMessages
// → fileEdits 纯函数层（提取/重放/diff）。
//
// 逐次回放（本次新增）：卡片 diff 区顶「视图」下拉——初版→终版
// / 当前内容（终版全文直读）/ 单次编辑 #N（事件 + 说明 + ±N）。选中后
// diff 区切换为对应视角（单次 = 该步 before→after；当前内容 = 全文
// +行——新建文件 diff 基底缺失时的内容可见面）；时间线行点击直达该
// 次编辑（双向联动——下拉与时间线是同一选择面的两个入口）。
//
// 会话上下文（同 TasksPanel）：1v1 / single 直连；群聊视角支持
//（多 Agent 编辑事件均带 agent_id——逐条署名）。bash 等间接写
// 不可追踪——底部提示。断链（存量文件打头）卡降级为统计展示 +
// partial 提示。
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
import { Icon, Tooltip, toastError } from '@agentchat/webui-kit';
import { useClientContext } from 'ac-client-runtime';
import { countLineChanges } from 'ac-edit-core/src/diff.ts';
import { openLocalFile } from 'ac-client-ui-workspace/client/fileApi.ts';
import { parseDialogId } from './feed.ts';
import { useFeedStore } from './feedStore.ts';
import {
  fileEditsFull, fileEditsWithSnapshots, diffOfStep, editStepsOf, diffOfContent,
  type FileEditSummary, type FileDiffResult, type FileEditStep,
  type FileEditEvent, type RemoteSnapshot, type DiskContents,
} from './fileEdits.ts';

const feed = useFeedStore();
const ctx = useClientContext();
const rpc = ctx?.rpc ?? null;

/** 活跃对话的原始消息（reactive 锚——流式/历史合并自动重算） */
const rawMessages = computed(() => feed.activeDialog?.rawMessages ?? []);
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
    snapshots.value = Array.isArray(r?.snapshots) ? r.snapshots : [];
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
  if (partialPaths.length === 0) { diskContents.value = {}; return; }
  try {
    const r = await rpc.call<{ contents?: DiskContents }>('fileSnapshots/read-current', { paths: partialPaths });
    diskContents.value = r?.contents ?? {};
  } catch {
    diskContents.value = {};
  }
}

/** 无快照拉取依赖的中间分析（loadDiskForPartials 判定 partial 用） */
function analysisOf() {
  return fileEditsWithSnapshots(rawMessages.value, snapshots.value);
}

watch(conversationId, () => void refreshSnapshots(), { immediate: true });
// run 收束刷新（编辑落盘后新快照生效）——loop/after-run 事件带会话键
const offRun = rpc?.onEvent((type: string, args: unknown[]) => {
  if (type !== 'loop/after-run') return;
  const [request] = args as Array<{ conversationId?: string } | undefined>;
  if (request?.conversationId && request.conversationId === conversationId.value) {
    void refreshSnapshots();
  }
}) ?? (() => undefined);
onBeforeUnmount(() => offRun());

const analysis = computed(() => fileEditsFull(rawMessages.value, snapshots.value, diskContents.value));

/** 文件清单（最近编辑在前；无编辑 = 空态） */
const files = computed(() =>
  [...analysis.value.files.values()].sort((a, b) => b.lastAt - a.lastAt),
);

/** 统计条 */
const totalEdits = computed(() => analysis.value.events.filter((e) => e.ok).length);
const totalFiles = computed(() => files.value.length);
/** 卡片统计（工具报告缺失 +0/-0 时以重放初版↔终版 LCS 回填——新建文件可见 +N） */
function statOf(s: FileEditSummary): { added: number; removed: number } {
  if ((s.added > 0 || s.removed > 0) || s.finalContent === null) return { added: s.added, removed: s.removed };
  const base = s.partial ? s.partialBase : s.baseContent;
  if (base === null) return { added: s.added, removed: s.removed };
  return countLineChanges(base, s.finalContent);
}
const totalAdded = computed(() => files.value.reduce((n, f) => n + statOf(f).added, 0));
const totalRemoved = computed(() => files.value.reduce((n, f) => n + statOf(f).removed, 0));

/** bash 等间接写提示（会话有 shell 调用但面板只覆盖编辑工具） */
const hasShellCalls = computed(() =>
  rawMessages.value.some((m) =>
    m.role === 'agent' && Array.isArray(m.toolCalls) &&
    (m.toolCalls as Array<{ name?: string }>).some((tc) => tc?.name === 'bash'),
  ),
);

/** 展开态（per-path；默认第一个文件展开） */
const expanded = ref<Set<string>>(new Set());
watch(files, (list) => {
  if (expanded.value.size === 0 && list.length > 0) {
    expanded.value = new Set([list[0].path]);
  }
}, { immediate: true });

function toggle(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

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

/** 当前视图 diff：总览 = diffOf 既有；单次 = diffOfStep；当前内容 = 全文 + 行 */
function viewDiff(s: FileEditSummary): FileDiffResult {
  const v = effectiveView(s);
  if (v === 'content') return diffOfContent(s);
  if (v === '') return diffOf(analysis.value.diffs, s);
  const step = stepsOf(s)[v];
  return step ? diffOfStep(step) : diffOf(analysis.value.diffs, s);
}

/** 时间线行点击 = 查看该次编辑（失败/越界回落总览） */
function jumpToStep(s: FileEditSummary, ev: FileEditEvent) {
  const idx = stepsOf(s).findIndex((st) => st.event.callId === ev.callId);
  setView(s.path, idx >= 0 ? idx : '');
}

/** 视图标签：总览固定「初版 → 终版」；当前内容「文件当前内容」；单次「编辑 #N」 */
function viewLabel(s: FileEditSummary): string {
  const v = effectiveView(s);
  if (v === 'content') return '文件当前内容';
  return v === '' ? '初版 → 终版' : `编辑 #${v + 1}`;
}

/** 下拉项文字：单次编辑 = #N + 时间 + 动作 + 真实行变更（LCS——
 *  与单次 diff 所见一致；工具报告口径在 old/new 含未变上下文时
 *  会偏大，不采用） */
function stepOptionLabel(st: FileEditStep): string {
  const a = ACTION_LABEL[st.event.action] ?? st.event.action;
  return `#${st.index + 1} ${timeOf(st.event.timestamp)} ${a} +${st.added}/-${st.removed}`;
}

/** diff 行解析（generateDiffString 输出：'- 12 内容' / '+ 12 内容' / '  12 内容' / '...'） */
interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'sep'; text: string }
function parseDiff(diff: FileDiffResult): DiffLine[] {
  if (!diff.comparable) return [];
  return diff.diff.split('\n').map((line) => {
    if (line === '...') return { kind: 'sep', text: line };
    if (line.startsWith('+ ')) return { kind: 'add', text: line };
    if (line.startsWith('- ')) return { kind: 'del', text: line };
    return { kind: 'ctx', text: line };
  });
}

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
function eventLine(ev: FileEditEvent, s?: FileEditSummary): string {
  const base = ACTION_LABEL[ev.action] ?? ev.action;
  if (!ev.ok) return `${base}（失败）`;
  // 选中同一编辑时与单次 diff 所见一致（LCS 真实变更）；不可回放
  // 文件/失败步回落工具报告口径
  const step = s ? stepsOf(s).find((st) => st.event.callId === ev.callId) : undefined;
  const added = step ? step.added : ev.added;
  const removed = step ? step.removed : ev.removed;
  const hasStat = added !== undefined || removed !== undefined;
  return `${base}${hasStat ? ` +${added ?? 0}/-${removed ?? 0}` : ''}`;
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
    </div>

    <div class="fe-body">
      <!-- 空态 -->
      <div v-if="totalFiles === 0" class="fe-empty">
        <Icon name="file-diff" :size="28" />
        <p>本会话暂无文件编辑记录</p>
        <p class="fe-empty-sub">Agent 使用 write / edit / str_replace_editor 修改文件时会在此汇总</p>
      </div>

      <!-- 文件折叠卡列表 -->
      <div v-for="s in files" :key="s.path" class="fe-card" :class="{ open: expanded.has(s.path) }">
        <!-- 头部（div role=button：内部嵌「本地打开」按钮——button 不可嵌套 button） -->
        <div class="fe-card-head" role="button" tabindex="0" @click="toggle(s.path)" @keydown.enter.prevent="toggle(s.path)">
          <Icon name="file-diff" :size="15" class="fe-file-icon" />
          <span class="fe-file-name" :title="s.path">{{ fileLabel(s) }}</span>
          <span v-if="dirLabel(s)" class="fe-file-dir" :title="s.path">{{ dirLabel(s) }}</span>
          <span class="fe-badges">
            <span v-if="s.created" class="fe-badge new">新建</span>
            <span v-if="s.partial" class="fe-badge partial">部分</span>
            <span class="fe-stat"><span class="fe-add-num">+{{ statOf(s).added }}</span><span class="fe-del-num">/-{{ statOf(s).removed }}</span></span>
            <span class="fe-count">{{ s.editCount }} 次</span>
          </span>
          <!-- 本地打开（系统默认程序；icon 按钮 + tooltip——与预览页
               fpt-icon-btn 同形态；不冒泡防触发卡片折叠） -->
          <Tooltip
            v-if="openStateOf(s.path) !== 'error'"
            :text="openStateOf(s.path) === 'opening' ? '打开中…' : '本地打开（系统默认程序）'"
            placement="bottom"
          >
            <button
              class="fe-open-local"
              :disabled="openStateOf(s.path) === 'opening'"
              @click.stop="openLocally(s)"
            >
              <Icon v-if="openStateOf(s.path) === 'opening'" name="loader-circle" :size="14" class="fe-spin" />
              <Icon v-else name="external-link" :size="14" />
            </button>
          </Tooltip>
          <button
            v-else
            class="fe-open-local error"
            :title="'本地打开失败（路径不可达或平台不支持）'"
            @click.stop="openLocally(s)"
          ><Icon name="alert-circle" :size="14" /></button>
        </div>

        <div v-if="expanded.has(s.path)" class="fe-card-body">
          <!-- 断链提示（存量文件打头） -->
          <div v-if="s.diskBackfill" class="fe-partial-note">
            此文件无会话首见快照——初版自磁盘终版逆向回推编辑记录（自会话内首次可回推点起算）
          </div>
          <div v-else-if="s.partial" class="fe-partial-note">
            <template v-if="s.finalContent !== null">此文件在会话开始前已存在——diff 自会话内首次全量写入起算</template>
            <template v-else>此文件在会话开始前已存在，会话内无全量写入——无法重建内容，仅展示编辑统计</template>
          </div>
          <div v-if="s.mismatches > 0" class="fe-partial-note warn">有 {{ s.mismatches }} 条编辑无法在重放中定位（外部修改或消息流残缺）——终版可能与实际有偏差</div>

          <!-- diff 视图（可比对 / 当前内容视图）：视图下拉 = 总览 / 当前内容 / 某次编辑 -->
          <template v-if="diffOf(analysis.diffs, s).comparable || s.finalContent !== null">
            <div class="fe-diff-meta">
              <span class="fe-view-label">{{ viewLabel(s) }}</span>
              <span class="fe-diff-stat">+{{ viewDiff(s).added }} / -{{ viewDiff(s).removed }}</span>
            </div>
            <!-- 视图选择（当前内容 / 编辑次数 > 1 才有逐次视角） -->
            <div v-if="s.finalContent !== null || stepsOf(s).length > 1" class="fe-view-row">
              <span class="fe-view-caption">查看</span>
              <select
                class="fe-view-select"
                :value="viewOptionOf(s)"
                @change="selectViewByOption(s, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">初版 → 终版</option>
                <option value="content">当前内容</option>
                <option v-for="st in stepsOf(s)" :key="st.event.callId" :value="st.event.callId">
                  {{ stepOptionLabel(st) }}
                </option>
              </select>
            </div>
            <div class="fe-diff">
              <div
                v-for="(line, i) in parseDiff(viewDiff(s))"
                :key="i"
                class="fe-diff-line"
                :class="'fe-' + line.kind"
              ><span class="fe-diff-text">{{ line.text }}</span></div>
            </div>
          </template>
          <!-- 不可比对：仅统计 -->
          <div v-else class="fe-no-diff">无法生成 diff（见上方说明）</div>

          <!-- 编辑时间线（成功行可点击 = 查看该次编辑；与视图下拉联动） -->
          <div class="fe-timeline">
            <div
              v-for="ev in s.events"
              :key="ev.callId"
              class="fe-ev"
              :class="{ fail: !ev.ok, active: viewOptionOf(s) !== '' && viewOptionOf(s) === ev.callId }"
              role="button"
              tabindex="0"
              @click="jumpToStep(s, ev)"
              @keydown.enter.prevent="jumpToStep(s, ev)"
            >
              <span class="fe-ev-time">{{ timeOf(ev.timestamp) }}</span>
              <span class="fe-ev-action">{{ eventLine(ev, s) }}</span>
              <span class="fe-ev-agent" :title="ev.agentId">{{ ev.agentId }}</span>
              <Icon v-if="ev.ok" name="file-diff" :size="12" class="fe-ev-go" />
            </div>
          </div>
        </div>
      </div>

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
  background: var(--color-bg-page, #fff);
}
.fe-head {
  display: flex; align-items: center; gap: 8px;
  height: var(--layout-header-height, 48px); padding: 0 16px; flex-shrink: 0;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
}
.fe-title { font-size: 13px; font-weight: 600; flex-shrink: 0; }
.fe-ctx { font-size: 11px; color: var(--color-text-tertiary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fe-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }

.fe-empty { padding: 32px 12px; text-align: center; color: var(--color-text-tertiary); display: flex; flex-direction: column; align-items: center; gap: 6px; }
.fe-empty p { margin: 0; font-size: 12px; }
.fe-empty-sub { font-size: 11px; opacity: 0.8; }

/* 卡片不收缩：flex 列容器里缺省 flex-shrink:1 会把卡片压扁而不是
   溢出——置 0 后内容超出 .fe-body（overflow-y:auto）即出滚动条 */
.fe-card { border: 1px solid var(--color-border-light, #e5e7eb); border-radius: var(--radius-md); background: var(--color-bg-surface, #fff); overflow: hidden; flex-shrink: 0; }
.fe-card-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; border: none; background: none; cursor: pointer;
  font-size: 12px; color: var(--color-text-primary); text-align: left;
}
.fe-card-head:hover { background: var(--color-bg-hover, rgba(0,0,0,0.03)); }
.fe-file-icon { color: #8b5cf6; flex-shrink: 0; }
.fe-file-name { font-weight: 600; font-family: 'SF Mono', 'Cascadia Code', monospace; white-space: nowrap; }
.fe-file-dir { font-size: 10px; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.fe-badges { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.fe-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-sm); border: 1px solid var(--color-border-light, #e5e7eb); color: var(--color-text-tertiary); }
.fe-badge.new { color: #22c55e; border-color: rgba(34,197,94,0.4); }
.fe-badge.partial { color: #e6a817; border-color: rgba(230,168,23,0.4); }
.fe-stat { font-size: 11px; font-family: 'SF Mono', 'Cascadia Code', monospace; }
/* +N/-M 红绿着色（与 diff 行同色系：增=绿、删=红） */
.fe-add-num { color: #22c55e; }
.fe-del-num { color: #ef4444; }
.fe-count { font-size: 11px; color: var(--color-text-tertiary); }

/* 本地打开（卡片头部右侧 icon 按钮；与预览页 fpt-icon-btn 同形态——
   24×22 透明图标钮 + hover 底色，不随 badges 收缩） */
.fe-open-local {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.fe-open-local:hover {
  background: var(--color-bg-hover, rgba(0,0,0,0.06));
  color: var(--color-text-primary);
}
.fe-open-local:disabled { opacity: 0.6; cursor: default; }
.fe-open-local.error { color: #ef4444; }
/* 打开中 spinner 旋转 */
.fe-spin { animation: fe-rotate 0.8s linear infinite; }
@keyframes fe-rotate { to { transform: rotate(360deg); } }

.fe-card-body { border-top: 1px solid var(--color-border-light, #e5e7eb); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }

.fe-partial-note { font-size: 11px; color: #8a6d1a; background: rgba(230,168,23,0.08); border: 1px solid rgba(230,168,23,0.25); border-radius: var(--radius-sm); padding: 6px 10px; }
.fe-partial-note.warn { color: #b45309; background: rgba(239,68,68,0.06); border-color: rgba(239,68,68,0.2); }

.fe-diff-meta { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--color-text-tertiary); }
.fe-diff-stat { font-family: 'SF Mono', 'Cascadia Code', monospace; }

/* ── 逐次回放视图选择（查看：总览 / 某次编辑）── */
.fe-view-row { display: flex; align-items: center; gap: 6px; }
.fe-view-caption { font-size: 11px; color: var(--color-text-tertiary); flex-shrink: 0; }
.fe-view-select {
  flex: 1; min-width: 0;
  font-size: 11px; font-family: inherit;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border-light, #e5e7eb);
  background: var(--color-bg-surface, #fff);
  color: var(--color-text-primary);
  cursor: pointer;
}
.fe-view-select:focus { outline: none; border-color: var(--primary, #6366f1); }
.fe-view-select:hover { border-color: var(--color-border-secondary, #d1d5db); }
.fe-diff {
  border: 1px solid var(--color-border-light, #e5e7eb); border-radius: var(--radius-md);
  background: var(--color-code-bg, #1e1e2e); overflow-x: auto; max-height: 360px; overflow-y: auto;
}
.fe-diff-line { display: flex; padding: 1px 12px; font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace; font-size: 11.5px; line-height: 1.6; white-space: pre; }
.fe-diff-text { flex: 1; }
.fe-add { background: rgba(34,197,94,0.1); }
.fe-add .fe-diff-text { color: #4ade80; }
.fe-del { background: rgba(239,68,68,0.12); }
.fe-del .fe-diff-text { color: #f87171; }
.fe-ctx .fe-diff-text { color: var(--color-text-tertiary); opacity: 0.75; }
.fe-sep .fe-diff-text { color: var(--color-text-tertiary); opacity: 0.5; font-style: italic; }

.fe-no-diff { font-size: 11px; color: var(--color-text-tertiary); padding: 8px 4px; }

.fe-timeline { display: flex; flex-direction: column; gap: 3px; }
.fe-ev { display: flex; align-items: center; gap: 8px; font-size: 11px; }
/* 成功行可点击（查看该次编辑）：hover 底色 + active 选中态（左侧主色条） */
.fe-ev:not(.fail) { cursor: pointer; border-radius: var(--radius-sm); padding: 1px 4px; margin: 0 -4px; }
.fe-ev:not(.fail):hover { background: var(--color-bg-hover, rgba(0,0,0,0.04)); }
.fe-ev.active { background: rgba(99,102,241,0.08); box-shadow: inset 2px 0 0 var(--primary, #6366f1); }
.fe-ev-time { color: var(--color-text-tertiary); font-family: 'SF Mono', 'Cascadia Code', monospace; flex-shrink: 0; }
.fe-ev-action { color: var(--color-text-secondary); }
.fe-ev.fail .fe-ev-action { color: #ef4444; text-decoration: line-through; }
.fe-ev-agent { margin-left: auto; color: var(--color-text-tertiary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.fe-ev-go { color: var(--color-text-tertiary); flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
.fe-ev:not(.fail):hover .fe-ev-go, .fe-ev.active .fe-ev-go { opacity: 1; }

.fe-shell-note { font-size: 11px; color: var(--color-text-tertiary); text-align: center; padding: 8px 4px; border-top: 1px dashed var(--color-border-light, #e5e7eb); flex-shrink: 0; }
</style>
