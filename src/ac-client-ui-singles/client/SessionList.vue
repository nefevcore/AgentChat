// AgentChat — 会话列表（独立会话页，与 Agent 列表同级的活动栏入口）
//
// 布局（自上而下）：
//   1. 新增按钮（新建会话，占满一行）
//   2. 工具栏：搜索会话（标题过滤——树切扁平结果）— 间隔 — 新增工作区（纯 ICON）
//   3. 树列表：用户工作区为根节点（按名称排列，整行点击展开/收起，
//      文件夹开合图标即状态；hover 显示 更多（重命名/删除）+ 新增会话），
//      各 session 为单行叶节点（头像 - 标题 - 删除；未挂工作区的会话
//      归入固定「未分组」根，排在末尾）；工作区内会话按最近活动分桶
//      （今天/一周/其他）分批展开：桶头点击
//      开合，桶内默认只渲染最近一页（5 条）、「展开更多」渐进追加；
//      工作区节点折叠后再展开恢复缺省态（不记录「展开全部/很多」）
//
// 用户工作区 = 用户登记的本机文件夹：挂在其下的会话运行时工作目录
// 指向该文件夹（会话级工作目录——后端 sandboxWorkdir 会话感知链路）。

<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted } from 'vue';

import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useClientContext } from 'ac-client-runtime';
import { useFeedStore } from 'ac-client-ui-conversation/client/feedStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { StarAvatar, Modal, Icon, toastError } from '@agentchat/webui-kit';
import { starColor } from '@agentchat/webui-kit';
import { singleDialog } from 'ac-client-ui-conversation/client/feed.ts';
import { traceSwitch } from 'ac-client-ui-conversation/client/switchTrace.ts';
import { loadComposePrefs } from 'ac-client-ui-conversation/client/composePrefs.ts';
import { loadCollapsed, saveCollapsed } from './sessionTreePrefs.ts';
import { bucketByTime, bucketLimitOf, growBucket, resetGroupReveal, toggleBucketHead, BUCKET_PAGE_SIZE, type RevealMap, type TimeBucket } from './sessionTimeBuckets.ts';
import { formatRelativeTime } from '@agentchat/webui-kit';
import EntryPickerModal from 'ac-client-ui-workspace/client/EntryPickerModal.vue';
import { pickFolder, openLocalDir } from 'ac-client-ui-workspace/client/fileApi.ts';
import type { Workspace } from 'ac-client-ui-workspace/client';

const emit = defineEmits<{
  (e: 'deselectGroup'): void;
}>();

const roster = useRosterCore();
// 注意：useClientContext = inject()，只能在 setup 期调用——事件处理器内调用
// 恒 undefined（曾因此误判"无 RPC"直接落兜底弹窗）。所需面在 setup 顶部取好。
const rpcFace = useClientContext()?.rpc ?? null;
const singlesBoard = useClientContext()?.singleBoard;
const activeSingles = computed(() => singlesBoard?.activeSingles.value ?? []);
const activeSingleId = computed(() => singlesBoard?.activeSingleId.value ?? '');
const wsBoard = useClientContext()?.workspaceBoard;
const wsList = computed(() => wsBoard?.workspaces.value ?? []);
const feedStore = useFeedStore();
const ui = useUiStore();
const themeStore = useThemeStore();

/** Agent 星色（主题响应式：切换主题自动更新） */
function colorOf(id: string) { return starColor(id, themeStore.theme === 'dark' ? 'nebula' : 'aurora'); }

/** 会话是否正在运行（其 single 对话处于流式运行中 → 头像显示流转光环） */
function isSessionRunning(id: string): boolean { return feedStore.getDialog(singleDialog(id))?.streaming ?? false; }

const closeDrawer = inject<() => void>('closeDrawer', () => {});

// ── 删除会话确认（硬删：元数据+消息，不可恢复）──
const deleteTarget = ref<{ id: string; title: string } | null>(null);
const deleteBusy = ref(false);
const deleteError = ref('');

async function confirmDelete() {
  if (!deleteTarget.value || deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = '';
  try {
    await singlesBoard?.remove(deleteTarget.value.id);
    deleteTarget.value = null;
  } catch (err: any) {
    deleteError.value = `删除失败: ${err?.message ?? String(err)}`;
  } finally {
    deleteBusy.value = false;
  }
}

// ── 重命名会话（title 覆盖；自动标题有 title 即不再触发，手改名稳居）──
// 初值 = 显示标题的原始形态：已具名取 title，未具名（自动标题未出）取
// 空串——不预填合成名（「Agent · 日期」只是显示回落，不是会话数据）。
const renameSessionTarget = ref<{ id: string; title: string } | null>(null);
const renameSessionValue = ref('');
const renameSessionBusy = ref(false);
const renameSessionError = ref('');

function startRenameSession(s: { id: string; title: string }) {
  const raw = singlesBoard?.singles.value.find(x => x.id === s.id);
  renameSessionTarget.value = { id: s.id, title: s.title };
  renameSessionValue.value = raw?.title ?? '';
  renameSessionError.value = '';
}

async function confirmRenameSession() {
  if (!renameSessionTarget.value || renameSessionBusy.value) return;
  const title = renameSessionValue.value.trim();
  if (!title) { renameSessionError.value = '标题不能为空'; return; }
  renameSessionBusy.value = true;
  renameSessionError.value = '';
  try {
    await singlesBoard?.updateSession(renameSessionTarget.value.id, { title });
    renameSessionTarget.value = null;
  } catch (err: any) {
    renameSessionError.value = `重命名失败: ${err?.message ?? String(err)}`;
  } finally {
    renameSessionBusy.value = false;
  }
}

interface SessionItem {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  workspaceId: string;
  lastActivity: number;
}

const sessionItems = computed<SessionItem[]>(() =>
  activeSingles.value
    .map(s => ({
      id: s.id,
      title: singlesBoard?.titleOf(s, (id) => roster.getAgentName(id) || id) ?? s.title ?? s.id,
      agentId: s.agentId,
      agentName: s.agentId ? (roster.getAgentName(s.agentId) || s.agentId) : (roster.defaultPreset.value?.label || '标准'),
      workspaceId: s.workspaceId || '',
      lastActivity: s.lastActivity ? new Date(s.lastActivity).getTime() : new Date(s.createdAt).getTime(),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity),
);

// ── 标题搜索（纯前端过滤：activeSingles 全量在内存，title 包含匹配）──
// 搜索态接管树列表：q 非空 → 树/桶整体让位扁平结果（跨工作区、按
// 最近活动降序，行内带归属副标——跨组结果需要归属线索）；清空即回
// 树视图。只搜会话标题（工作区名不参与——搜的是会话不是容器）。
const searchQuery = ref('');
const searching = computed(() => searchQuery.value.trim() !== '');
const searchResults = computed<SessionItem[]>(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return [];
  return sessionItems.value.filter(s => s.title.toLowerCase().includes(q));
});

/** 会话所属工作区名（搜索结果归属副标；未挂 = 未分组） */
function wsNameOf(item: SessionItem): string {
  return wsList.value.find(w => w.id === item.workspaceId)?.name ?? '未分组';
}

interface WorkspaceGroup {
  key: string;
  name: string;
  /** undefined = 未分组（固定根） */
  workspace?: Workspace;
  sessions: SessionItem[];
  /** 按最近活动的时间分桶（近→远，空桶不出现；随 sessions 变化重算——
   *  桶界锚重算时刻的「今天 00:00」，长闲置跨界由下次 singles 刷新校正） */
  buckets: TimeBucket<SessionItem>[];
}

/** 树模型：工作区根（按名称排序）+ 未分组固定根（有会话才出现） */
const treeGroups = computed<WorkspaceGroup[]>(() => {
  const now = Date.now();
  const groups: WorkspaceGroup[] = wsList.value.map(w => ({
    key: w.id, name: w.name, workspace: w, sessions: [], buckets: [],
  }));
  // 已按名称排序（后端 localeCompare numeric）；此处再排一次保持确定序
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ungrouped: WorkspaceGroup = { key: '__ungrouped__', name: '未分组', sessions: [], buckets: [] };
  for (const item of sessionItems.value) {
    const g = item.workspaceId ? groups.find(g => g.key === item.workspaceId) : undefined;
    (g ?? ungrouped).sessions.push(item);
  }
  const out = groups; // 空工作区也显示（可挂新会话）
  if (ungrouped.sessions.length > 0) out.push(ungrouped);
  // sessions 已按最近活动降序（sessionItems 契约）——单趟分桶
  for (const g of out) g.buckets = bucketByTime(g.sessions, now);
  return out;
});

// ── 展开/收起（默认展开；记住用户折叠状态——localStorage 持久化，
//    切换视图/刷新不丢；与 composePrefs 同款降级手法）──
const collapsed = ref(loadCollapsed());

function toggleGroup(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
  saveCollapsed(next);
  // 折叠即弃置该组桶展开记录——重开回到「首桶+激活桶」缺省态，
  // 不把「展开全部」越折越积地记下去（分批展开可回退）
  if (next.has(key)) reveal.value = resetGroupReveal(reveal.value, key);
}

// ── 工作区内会话分批展开：按最近活动分桶（今天/一周/其他），
//    桶头点击开合，桶内默认只渲染最近一页（5 条）、
//    尾部「展开更多」渐进追加——空间效率优先，不再一次铺出全量。
//    桶显示上限 = 显式记录（group key → bucket key → 上限，纯函数住
//    sessionTimeBuckets）：无记录走「首桶 + 激活会话所在桶各一页」
//    缺省规则；工作区节点折叠即弃置记录，重开恢复缺省态（不记住
//    「展开很多/全部」）──
const reveal = ref<RevealMap>(new Map());

/** 该组缺省显示上限：首桶 + 激活会话所在桶各一页（选中态不被折叠藏掉） */
function defaultLimitsOf(group: WorkspaceGroup): Map<string, number> {
  const limits = new Map<string, number>();
  if (group.buckets.length === 0) return limits;
  limits.set(group.buckets[0].key, BUCKET_PAGE_SIZE);
  const activeKey = group.buckets.find(b => b.items.some(s => s.id === activeSingleId.value))?.key;
  if (activeKey && !limits.has(activeKey)) limits.set(activeKey, BUCKET_PAGE_SIZE);
  return limits;
}

/** 桶当前显示上限（显式记录优先，无记录回落缺省规则） */
function bucketLimit(group: WorkspaceGroup, bucketKey: string): number {
  return bucketLimitOf(reveal.value, group.key, bucketKey, defaultLimitsOf(group).get(bucketKey) ?? 0);
}

/** 桶内实际渲染的会话（前 limit 条；桶内序 = 最近活动序） */
function visibleItemsOf(group: WorkspaceGroup, bucket: TimeBucket<SessionItem>): SessionItem[] {
  return bucket.items.slice(0, bucketLimit(group, bucket.key));
}

/** 桶头点击：开 ↔ 合（合后再开回一页——不记住「展开很多」） */
function toggleBucket(group: WorkspaceGroup, bucketKey: string) {
  reveal.value = toggleBucketHead(reveal.value, group.key, bucketKey, defaultLimitsOf(group));
}

/** 桶内「展开更多」：追加一页 */
function growBucketItems(group: WorkspaceGroup, bucket: TimeBucket<SessionItem>) {
  reveal.value = growBucket(reveal.value, group.key, bucket.key, bucket.items.length, defaultLimitsOf(group));
}

/** 桶内未渲染条数（= 桶全量 - 实际渲染；满额恒 0） */
function bucketHiddenOf(group: WorkspaceGroup, bucket: TimeBucket<SessionItem>): number {
  return bucket.items.length - visibleItemsOf(group, bucket).length;
}

function timeOf(ts: number): string { return formatRelativeTime(ts); }

// ── 新建会话：顶部按钮 = 未分组空会话；工作区节点 + = 挂该工作区 ──
// 上次组合偏好（输入栏四项选择的 localStorage 记录）随创建透传：
// Agent/模型作为创建参数（服务端校验，失效抛错→回退空会话创建——
// 偏好过期〔Agent 已删/provider 未注册〕不应阻断新建）；effort/
// elevation 由 ChatInput 挂载时回放（不属会话元数据）。
// agentId/model 的 '' = 明确选回默认（2026-09 修复）——不透传创建参数
// （缺省即默认预设/默认模型），走原路径；否则会残留旧模式（用户选回
// 默认后新会话仍带旧 Agent）。
// 工作区上下文（2026-12 会话开场重设计）：新建即固化——顶部按钮也
// 透传当前激活工作区（若有）；「新会话开场卡」内改选工作区经
// singles/update 即时生效（开场后工具栏隐藏工作区入口）。
const creatingSession = ref(false);
async function createSession(workspaceId?: string) {
  if (creatingSession.value) return; // 双击守卫：快速双击会创建两个空会话
  creatingSession.value = true;
  // 工作区上下文：显式参数 > 激活工作区（新建动作从哪个工作区发起就挂哪个）
  const wsCtx = workspaceId ?? activeWorkspaceIdOfSelected();
  const prefs = loadComposePrefs();
  const carry = {
    ...(wsCtx ? { workspaceId: wsCtx } : {}),
    ...(prefs?.agentId ? { agentId: prefs.agentId } : {}),
    ...(prefs?.model ? { model: prefs.model } : {}),
  };
  const carryEmpty = !('agentId' in carry || 'model' in carry);
  try {
    if (carryEmpty) {
      if (wsCtx) await singlesBoard?.create({ workspaceId: wsCtx });
      else await singlesBoard?.createQuick(); // 未分组：reuse 复用空白会话
    } else {
      // 有 Agent/模型偏好：带参创建（校验失败回退空会话——过期偏好不阻断）
      try {
        await singlesBoard?.create(carry);
      } catch (err: any) {
        console.warn('[SessionList] 按上次偏好创建失败，回退空会话:', err?.message ?? err);
        if (wsCtx) await singlesBoard?.create({ workspaceId: wsCtx });
        else await singlesBoard?.createQuick();
      }
    }
  } finally {
    creatingSession.value = false;
  }
}

/** 选中会话所在工作区 id（未选中/未挂 = ''——新建落在未分组） */
function activeWorkspaceIdOfSelected(): string {
  const sid = activeSingleId.value;
  if (!sid) return '';
  return singlesBoard?.singles.value.find(s => s.id === sid)?.workspaceId || '';
}

/** 进入独立会话：清 Agent/群组选中（互斥），列表只切上下文，历史由 ConversationView 加载。
 *  显式收起运行矩阵/pair 只读视角：点击「当前已激活」的会话时选中三元组不变，
 *  App 的选中 watch（只认非空变化）不触发，不显式收起则主区无变化 */
function selectSingle(sessionId: string) {
  traceSwitch('click-single', sessionId);
  roster.activeAgentId.value = '';
  emit('deselectGroup');
  singlesBoard?.selectSingle(sessionId);
  ui.exitOverlays(); // 进入会话：收矩阵 + 清 pair 视角（含同值重选边界）
  closeDrawer();
}

// ── 新增工作区（弹窗：系统原生文件夹选择 → 名称确认）──
const showWsDialog = ref(false);
const wsPath = ref('');
const wsName = ref('');
const wsBusy = ref(false);
const wsError = ref('');
/** 系统原生选择进行中（对话框已弹出——按钮防重入 + 表单内等待提示） */
const wsPicking = ref(false);
/** 应用内浏览弹层（原生选择不可用时的兜底：EntryPickerModal mode 'dir'
 *  ——workspace/browse-dirs 服务端浏览） */
const wsBrowsing = ref(false);

function openWsDialog() {
  showWsDialog.value = true;
  wsPath.value = '';
  wsName.value = '';
  wsError.value = '';
  wsPicking.value = false;
  wsBrowsing.value = false;
}

/** 目录选定回填：路径 + 名称缺省 = 文件夹名（用户可改） */
function onPickFolder(path: string) {
  wsPath.value = path;
  wsError.value = '';
  if (!wsName.value.trim()) wsName.value = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/** 「选择」= 本机系统原生文件夹选择对话框（workspace/pick-folder RPC，
 *  阻塞至用户在系统弹窗完成操作）；不可用（error/异常）降级回应用内
 *  浏览弹窗；用户取消静默收场 */
const wsPickSeq = { current: 0 }; // 会话序号：「取消等待」后晚到的结果按过期丢弃

async function chooseWsFolder() {
  if (wsPicking.value) return;
  const rpc = rpcFace;
  if (!rpc) {
    wsBrowsing.value = true; // 无 RPC 面（孤立挂载）→ 直接走兜底
    return;
  }
  const seq = ++wsPickSeq.current;
  wsPicking.value = true;
  try {
    const r = await pickFolder(rpc, '选择工作区文件夹');
    if (seq !== wsPickSeq.current) return; // 已被「取消等待」放弃
    if (r.path) onPickFolder(r.path);
    else if (r.error && showWsDialog.value) {
      wsError.value = `系统选择框不可用（${r.error}），已切换为内置目录浏览`;
      wsBrowsing.value = true;
    }
    // cancelled → 静默收场（用户主动放弃）
  } catch (err: any) {
    if (seq !== wsPickSeq.current) return;
    if (showWsDialog.value) {
      wsError.value = `系统选择框调用失败: ${err?.message ?? String(err)}，已切换为内置目录浏览`;
      wsBrowsing.value = true;
    }
  } finally {
    if (seq === wsPickSeq.current) wsPicking.value = false;
  }
}

/** 取消等待（没看到系统弹窗/不想等了）：本地放弃本次等待；系统弹窗若已
 *  弹出会挂到服务端超时（10 分钟）后自动关闭，不影响后续再选 */
function cancelWsPick() {
  wsPickSeq.current++;
  wsPicking.value = false;
}

async function confirmCreateWorkspace() {
  if (wsBusy.value) return;
  if (!wsPath.value.trim()) {
    wsError.value = '请选择或输入文件夹路径';
    return;
  }
  wsBusy.value = true;
  wsError.value = '';
  try {
    await wsBoard?.create({ path: wsPath.value, name: wsName.value.trim() || undefined });
    showWsDialog.value = false;
  } catch (err: any) {
    wsError.value = `添加失败: ${err?.message ?? String(err)}`;
  } finally {
    wsBusy.value = false;
  }
}

// ── 删除工作区确认（会话保留 → 未分组）──
const deleteWsTarget = ref<{ id: string; name: string } | null>(null);
const deleteWsBusy = ref(false);
const deleteWsError = ref('');

async function confirmDeleteWorkspace() {
  if (!deleteWsTarget.value || deleteWsBusy.value) return;
  deleteWsBusy.value = true;
  deleteWsError.value = '';
  try {
    await wsBoard?.remove(deleteWsTarget.value.id);
    deleteWsTarget.value = null;
  } catch (err: any) {
    deleteWsError.value = `删除失败: ${err?.message ?? String(err)}`;
  } finally {
    deleteWsBusy.value = false;
  }
}

// ── 树列表滚动条：默认零宽不占位，hover 列表时浮现（与 AgentList 同款机制）──
const treeScrollRef = ref<HTMLElement>();
function onTreeEnter() { treeScrollRef.value?.classList.add('scroll-visible'); }
function onTreeLeave() { treeScrollRef.value?.classList.remove('scroll-visible'); }

// ── 工作区「更多」菜单（重命名 / 删除；单开，点击外部关闭）──
const wsMenuOpen = ref<string | null>(null);

function toggleWsMenu(key: string) {
  wsMenuOpen.value = wsMenuOpen.value === key ? null : key;
}

function onDocClick() { wsMenuOpen.value = null; }

// ── 本地资源管理器（工作区节点：系统文件管理器打开该登记文件夹）──
const wsExplorerKey = ref<string | null>(null); // 打开中的节点 key（互斥单飞）
const wsExplorerFailed = ref(false); // 最近一次失败标记（错误经全局 toast 呈现）

async function openWsInExplorer(group: WorkspaceGroup) {
  if (!rpcFace || wsExplorerKey.value) return;
  wsExplorerKey.value = group.key;
  wsExplorerFailed.value = false;
  let errMsg = '';
  try {
    const r = await openLocalDir(rpcFace, { workspaceId: group.workspace?.id });
    if (r.error) errMsg = r.error;
  } catch (err: any) {
    errMsg = err?.message ?? String(err);
  } finally {
    wsExplorerKey.value = null;
    if (errMsg) {
      wsExplorerFailed.value = true;
      toastError(`打开文件夹失败：${errMsg}`, { key: 'open-dir', duration: 4000 });
    }
  }
}

// ── 重命名工作区 ──
const renameTarget = ref<{ id: string; name: string } | null>(null);
const renameValue = ref('');
const renameBusy = ref(false);
const renameError = ref('');

function startRename(w: Workspace) {
  wsMenuOpen.value = null;
  renameTarget.value = { id: w.id, name: w.name };
  renameValue.value = w.name;
  renameError.value = '';
}

async function confirmRename() {
  if (!renameTarget.value || renameBusy.value) return;
  const name = renameValue.value.trim();
  if (!name) { renameError.value = '名称不能为空'; return; }
  renameBusy.value = true;
  renameError.value = '';
  try {
    await wsBoard?.rename(renameTarget.value.id, name);
    renameTarget.value = null;
  } catch (err: any) {
    renameError.value = `重命名失败: ${err?.message ?? String(err)}`;
  } finally {
    renameBusy.value = false;
  }
}

onMounted(() => {
  roster.requestAgents();
  void singlesBoard?.refresh();
  void wsBoard?.refresh();
  document.addEventListener('click', onDocClick);
  treeScrollRef.value?.addEventListener('mouseenter', onTreeEnter);
  treeScrollRef.value?.addEventListener('mouseleave', onTreeLeave);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  treeScrollRef.value?.removeEventListener('mouseenter', onTreeEnter);
  treeScrollRef.value?.removeEventListener('mouseleave', onTreeLeave);
});
</script>

<template>
  <div class="session-list">
    <!-- 1. 新增按钮（新建会话，占满一行） -->
    <div class="create-row">
      <button class="create-btn" @click="createSession()" title="新建会话（已有空会话时复用）">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        <span>新增</span>
      </button>
    </div>

    <!-- 2. 工具栏：搜索会话（标题过滤）— 间隔 — 新增工作区（纯 ICON） -->
    <div class="ws-toolbar">
      <div class="search-box">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input v-model="searchQuery" type="text" class="search-input" placeholder="搜索会话…" @keydown.esc="searchQuery = ''" />
      </div>
      <div class="ws-toolbar-actions">
        <button class="ws-add-btn" @click="openWsDialog" title="新增工作区（登记一个文件夹白名单区域）">
          <Icon name="folder-plus" :size="16" />
        </button>
        <button class="mobile-close-btn" @click="closeDrawer" title="关闭菜单">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>

    <!-- 3. 树列表：搜索态 → 跨工作区扁平结果；常态 → 工作区根节点（按名称排列）→ 各 session 叶节点 -->
    <div ref="treeScrollRef" class="tree-scroll">
     <!-- 搜索态：扁平结果（跨工作区、按最近活动降序；行：头像 - 标题/归属 - 删除） -->
     <div v-if="searching" class="search-results">
       <div v-for="item in searchResults" :key="item.id" class="list-item"
         :class="{ active: activeSingleId === item.id }"
         :title="`${item.title} · ${item.agentName} · ${timeOf(item.lastActivity)}`"
         @click="selectSingle(item.id)">
         <div class="item-avatar-wrap"><StarAvatar :src="roster.getAgentAvatar(item.agentId)" :name="item.agentName" :size="15" :color="colorOf(item.agentId)" fallback-icon="bot" plain-fallback :running="isSessionRunning(item.id)" /></div>
         <div class="item-info">
           <div class="item-name">{{ item.title }}</div>
           <div class="item-sub">{{ wsNameOf(item) }} · {{ item.agentName }}</div>
         </div>
         <button class="item-delete" title="重命名会话" @click.stop="startRenameSession(item)"><Icon name="pencil" :size="13" /></button>
         <button class="item-delete" title="删除会话（含消息，不可恢复）" @click.stop="deleteTarget = { id: item.id, title: item.title }">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
         </button>
       </div>
       <div v-if="searchResults.length === 0" class="empty">
         没有标题匹配「{{ searchQuery.trim() }}」的会话
       </div>
     </div>
     <!-- 常态：工作区树（分桶分批展开同前） -->
     <template v-else>
        <template v-for="group in treeGroups" :key="group.key">
          <!-- 根节点：工作区 / 未分组（点击整行展开/收起；文件夹开合图标即状态） -->
          <div class="ws-node" :class="{ ungrouped: !group.workspace }" :title="group.workspace ? `${group.name}\n${group.workspace.path}` : '未挂工作区的会话'" @click="toggleGroup(group.key)">
            <span class="ws-icon"><Icon :name="collapsed.has(group.key) ? 'folder' : 'folder-open'" :size="15" /></span>
            <span class="ws-name">{{ group.name }}</span>
            <!-- hover 操作：资源管理器 · 更多（重命名/删除）· 新增会话（未分组根无操作） -->
            <template v-if="group.workspace">
              <button class="ws-act" :class="{ active: wsMenuOpen === group.key }"
                :title="wsExplorerFailed ? '打开失败（详见全局提示）' : (wsExplorerKey === group.key ? '正在打开…' : `在本地资源管理器中打开\n${group.workspace.path}`)"
                @click.stop="openWsInExplorer(group)">
                <Icon v-if="wsExplorerKey === group.key" name="loader-circle" :size="14" class="ws-spin" />
                <Icon v-else-if="wsExplorerFailed" name="alert-circle" :size="14" />
                <Icon v-else name="external-link" :size="14" />
              </button>
              <div class="ws-more-wrap" @click.stop>
                <button class="ws-act" :class="{ active: wsMenuOpen === group.key }" title="更多" @click.stop="toggleWsMenu(group.key)">
                  <Icon name="more-horizontal" :size="14" />
                </button>
                <Transition name="menu-fade">
                  <div v-if="wsMenuOpen === group.key" class="ws-menu">
                    <button class="ws-menu-item" @click="startRename(group.workspace!)">
                      <Icon name="pencil" :size="13" />
                      <span>重命名</span>
                    </button>
                    <button class="ws-menu-item ws-menu-danger" @click="wsMenuOpen = null; deleteWsTarget = { id: group.workspace!.id, name: group.workspace!.name }">
                      <Icon name="trash" :size="13" />
                      <span>删除</span>
                    </button>
                  </div>
                </Transition>
              </div>
              <button class="ws-act" title="在此工作区新建会话" @click.stop="createSession(group.workspace.id)">
                <Icon name="plus" :size="14" />
              </button>
            </template>
          </div>
          <!-- 叶节点：会话按时间分桶分批展开（桶头开合 + 桶内分页；行：头像 - 标题 - 删除） -->
          <div v-if="!collapsed.has(group.key)" class="ws-children">
            <template v-for="bucket in group.buckets" :key="bucket.key">
              <!-- 桶头：时间分组标签 + 条数（点击开合；chevron 随桶显示状态） -->
              <button class="bucket-head" type="button" :aria-expanded="bucketLimit(group, bucket.key) > 0"
                :title="bucketLimit(group, bucket.key) > 0 ? `收起「${bucket.label}」（共 ${bucket.items.length} 条）` : `展开「${bucket.label}」的最近 ${Math.min(BUCKET_PAGE_SIZE, bucket.items.length)} 条会话（共 ${bucket.items.length} 条）`"
                @click.stop="toggleBucket(group, bucket.key)">
                <span class="bucket-chevron" :class="{ open: bucketLimit(group, bucket.key) > 0 }"><Icon name="chevron-down" :size="14" /></span>
                <span class="bucket-label">{{ bucket.label }}</span>
                <span class="bucket-count">{{ bucket.items.length }}</span>
              </button>
              <!-- 桶内会话行（前 limit 条；尾部「展开更多」渐进追加） -->
              <template v-if="bucketLimit(group, bucket.key) > 0">
                <div v-for="item in visibleItemsOf(group, bucket)" :key="item.id" class="list-item"
                  :class="{ active: activeSingleId === item.id }"
                  :title="`${item.title} · ${item.agentName} · ${timeOf(item.lastActivity)}`"
                  @click="selectSingle(item.id)">
                  <div class="item-avatar-wrap"><StarAvatar :src="roster.getAgentAvatar(item.agentId)" :name="item.agentName" :size="15" :color="colorOf(item.agentId)" fallback-icon="bot" plain-fallback :running="isSessionRunning(item.id)" /></div>
                  <div class="item-info">
                    <div class="item-name">{{ item.title }}</div>
                  </div>
                  <button class="item-delete" title="重命名会话" @click.stop="startRenameSession(item)"><Icon name="pencil" :size="13" /></button>
                  <button class="item-delete" title="删除会话（含消息，不可恢复）" @click.stop="deleteTarget = { id: item.id, title: item.title }">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
                  </button>
                </div>
                <!-- 桶内分页闸门：还有未渲染条目时尾部「展开更多」 -->
                <button v-if="bucketHiddenOf(group, bucket) > 0" class="expand-more" type="button"
                  :title="`再展开 ${bucketHiddenOf(group, bucket)} 条中的最近 ${Math.min(BUCKET_PAGE_SIZE, bucketHiddenOf(group, bucket))} 条`"
                  @click.stop="growBucketItems(group, bucket)">
                  <span class="expand-more-dots">···</span>
                  <span>展开更多（{{ bucketHiddenOf(group, bucket) }}）</span>
                </button>
              </template>
            </template>
          </div>
        </template>

        <div v-if="treeGroups.length === 0" class="empty">
          暂无会话<br /><span class="empty-hint">点击「新增」直接开始；「+」登记文件夹工作区分组管理会话</span>
        </div>
     </template>
    </div>

    <!-- 删除会话确认弹窗 -->
    <!-- 重命名会话弹窗 -->
    <Modal :visible="!!renameSessionTarget" :width="380" @close="renameSessionTarget = null">
      <div class="ws-dialog">
        <h4>重命名会话</h4>
        <div class="ws-form-group">
          <label>标题</label>
          <input v-model="renameSessionValue" type="text" placeholder="会话标题" maxlength="60" @keyup.enter="confirmRenameSession" />
        </div>
        <div v-if="renameSessionError" class="del-error">{{ renameSessionError }}</div>
        <div class="del-actions">
          <button class="del-cancel" :disabled="renameSessionBusy" @click="renameSessionTarget = null">取消</button>
          <button class="ws-save-btn" :disabled="renameSessionBusy" @click="confirmRenameSession">{{ renameSessionBusy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </Modal>

    <Modal :visible="!!deleteTarget" :width="380" @close="deleteTarget = null">
      <div class="del-dialog">
        <h4>删除会话</h4>
        <p class="del-text">确定要删除 <strong>{{ deleteTarget?.title }}</strong> 吗？</p>
        <p class="del-warn">会话消息将一并删除，<span class="del-strong">不可恢复</span>。</p>
        <div v-if="deleteError" class="del-error">{{ deleteError }}</div>
        <div class="del-actions">
          <button class="del-cancel" :disabled="deleteBusy" @click="deleteTarget = null">取消</button>
          <button class="del-confirm" :disabled="deleteBusy" @click="confirmDelete">{{ deleteBusy ? '删除中…' : '删除' }}</button>
        </div>
      </div>
    </Modal>

    <!-- 新增工作区弹窗（目录选择弹层 + 手输兜底） -->
    <Modal :visible="showWsDialog" :width="420" @close="showWsDialog = false">
      <div class="ws-dialog">
        <h4>新增工作区</h4>
        <p class="ws-dialog-hint">登记一个本机文件夹作为会话分组；挂在此工作区的会话，其 Agent 可访问该文件夹（沙箱白名单）。</p>
        <div class="ws-form-group">
          <label>文件夹</label>
          <div class="ws-path-row">
            <!-- 允许手动输入/粘贴路径：原生选择与内置浏览之外的常驻录入通道 -->
            <input v-model="wsPath" type="text" class="ws-path-input" placeholder="点击右侧按钮选择文件夹，或直接输入/粘贴绝对路径" @keyup.enter="confirmCreateWorkspace" />
            <button v-if="!wsPicking" class="ws-pick-btn" @click="chooseWsFolder">选择</button>
            <button v-else class="ws-pick-btn" title="放弃等待本次系统弹窗（若弹窗在别处，服务端超时后会自动关闭）" @click="cancelWsPick">取消等待</button>
          </div>
          <!-- 原生选择等待提示（系统对话框在屏幕上，不在页面里） -->
          <div v-if="wsPicking" class="ws-picking-hint">已打开系统文件夹选择对话框，请在系统弹窗中完成选择（10 分钟内有效；若未见到弹窗，请查看任务栏或其他窗口后面，也可点「取消等待」改用手动输入）…</div>
        </div>
        <div class="ws-form-group">
          <label>名称 <span class="optional-hint">（可选，缺省 = 文件夹名）</span></label>
          <input v-model="wsName" type="text" placeholder="如 我的项目" @keyup.enter="confirmCreateWorkspace" />
        </div>
        <div v-if="wsError" class="del-error">{{ wsError }}</div>
        <div class="del-actions">
          <button class="del-cancel" :disabled="wsBusy" @click="showWsDialog = false">取消</button>
          <button class="ws-save-btn" :disabled="wsBusy" @click="confirmCreateWorkspace">{{ wsBusy ? '添加中…' : '添加' }}</button>
        </div>
      </div>
    </Modal>

    <!-- 应用内目录浏览弹层（原生选择不可用的兜底；宿主弹窗之上：z-index 1200 > Modal 缺省 600） -->
    <EntryPickerModal :visible="wsBrowsing" mode="dir" title="选择工作区文件夹" @close="wsBrowsing = false" @pick="onPickFolder" />

    <!-- 重命名工作区弹窗 -->
    <Modal :visible="!!renameTarget" :width="380" @close="renameTarget = null">
      <div class="ws-dialog">
        <h4>重命名工作区</h4>
        <div class="ws-form-group">
          <label>名称</label>
          <input v-model="renameValue" type="text" placeholder="工作区名称" @keyup.enter="confirmRename" />
        </div>
        <div v-if="renameError" class="del-error">{{ renameError }}</div>
        <div class="del-actions">
          <button class="del-cancel" :disabled="renameBusy" @click="renameTarget = null">取消</button>
          <button class="ws-save-btn" :disabled="renameBusy" @click="confirmRename">{{ renameBusy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </Modal>

    <!-- 删除工作区确认弹窗 -->
    <Modal :visible="!!deleteWsTarget" :width="380" @close="deleteWsTarget = null">
      <div class="del-dialog">
        <h4>删除工作区</h4>
        <p class="del-text">确定要删除工作区 <strong>{{ deleteWsTarget?.name }}</strong> 吗？</p>
        <p class="del-warn">会话保留并移入「未分组」；文件夹本身不受影响。</p>
        <div v-if="deleteWsError" class="del-error">{{ deleteWsError }}</div>
        <div class="del-actions">
          <button class="del-cancel" :disabled="deleteWsBusy" @click="deleteWsTarget = null">取消</button>
          <button class="del-confirm" :disabled="deleteWsBusy" @click="confirmDeleteWorkspace">{{ deleteWsBusy ? '删除中…' : '删除' }}</button>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.session-list{flex:1;min-width:0;background:var(--color-bg-surface);display:flex;flex-direction:column;z-index:210;transition:transform .25s ease;position:relative}
/* 右缘分界线退役：分界统一由布局骨架 ResizeHandle 细线担当 */
/* 暗色层级修复：列表用最深底，与内容区(#1a1a1a)拉开层次 */
html.dark .session-list{background:var(--bg-deep,#0a0d14)}

/* 1. 新增按钮（占满一行）：虚线幽灵样式 + 主文字色 —— 可辨识但不抢戏 */
.create-row{padding:10px 12px 4px;flex-shrink:0}
.create-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:32px;border:1px dashed var(--color-border-secondary,#c5c5c5);border-radius:var(--radius-md);background:var(--color-bg-page,#fff);color:var(--color-text-primary,#2c3e50);font-size:13px;font-weight:600;cursor:pointer;transition:border-color var(--transition-fast),background var(--transition-fast)}
.create-btn:hover{border-color:var(--color-primary,#6366f1);background:var(--color-primary-light,rgba(99,102,241,.05))}
.create-btn:active{transform:scale(.985)}
html.dark .create-btn{background:transparent;color:var(--color-text-primary,#e5e7eb)}

/* 2. 工具栏：工作区（文本）— 间隔 — 新增工作区（纯 ICON） */
.ws-toolbar{display:flex;align-items:center;gap:6px;padding:8px 14px 6px;flex-shrink:0}
.ws-label{font-size:12px;font-weight:600;letter-spacing:.5px;color:var(--color-text-tertiary,#a8abb2);text-transform:none;user-select:none}
.ws-toolbar-actions{margin-left:auto;display:flex;align-items:center;gap:2px}
.ws-add-btn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:6px;background:none;color:var(--color-text-tertiary,#a8abb2);cursor:pointer;transition:background var(--transition-fast),color var(--transition-fast)}
.ws-add-btn:hover{background:var(--color-bg-subtle);color:var(--color-primary,#6366f1)}

/* 搜索框（标题过滤——输入即树切扁平结果，Esc 清空回树；与 AgentList
   同款视觉语言，尺寸压到工具栏一档） */
.search-box{flex:1;min-width:0;position:relative;display:flex;align-items:center}
.search-icon{position:absolute;left:8px;color:var(--color-text-tertiary,#a8abb2);pointer-events:none}
.search-input{width:100%;padding:4px 8px 4px 26px;border:1px solid var(--color-border-secondary,#ddd);border-radius:var(--radius-sm,6px);background:var(--color-bg-page,#fff);color:var(--color-text-primary,#2c3e50);font-size:12.5px;outline:none;transition:border-color var(--transition-fast)}
.search-input:focus{border-color:var(--color-primary,#6366f1)}
.search-input::placeholder{color:var(--color-text-tertiary,#a8abb2)}

/* 搜索态扁平结果行（跨工作区、按最近活动降序；与树叶节点同视觉语言，
   左侧不缩进——无层级嵌套；归属副标给跨组结果以线索） */
.search-results .list-item{display:flex;align-items:center;height:30px;padding:0 8px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);cursor:pointer;transition:background var(--transition-fast),border-color var(--transition-fast),box-shadow var(--transition-fast);border:1px solid transparent;gap:8px}
.search-results .list-item:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.search-results .list-item.active{background:var(--role-selected-bg,#e6eaff);border-color:transparent;box-shadow:none}
.item-sub{font-size:11px;line-height:14px;color:var(--color-text-tertiary,#a8abb2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mobile-close-btn{display:none;background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:4px;border-radius:var(--radius-sm);line-height:0}
.mobile-close-btn:hover{background:var(--color-bg-subtle);color:var(--color-text-primary)}

/* 3. 树列表：节点统一行高 30px、垂直间距 --space-xs、同款圆角/hover/视觉密度
   （树节点与叶节点仅以缩进和图标区分层级，风格完全一致） */
.tree-scroll{flex:1;overflow-y:auto;padding:var(--space-xs);background:var(--color-bg-surface,#f8f9fa);scrollbar-width:none;scrollbar-color:transparent transparent}
html.dark .tree-scroll{background:var(--bg-deep,#0a0d14)}
.tree-scroll::-webkit-scrollbar{width:0;height:0}
.tree-scroll::-webkit-scrollbar-track{background:var(--color-bg-surface,#f8f9fa)}
html.dark .tree-scroll::-webkit-scrollbar-track{background:var(--bg-deep,#0a0d14)}
.tree-scroll::-webkit-scrollbar-thumb{background:transparent}
/* hover 列表时滚动条浮现（与 AgentList 同款细滚动条样式） */
.tree-scroll.scroll-visible{scrollbar-width:thin;scrollbar-color:var(--color-border-primary) transparent}
.tree-scroll.scroll-visible::-webkit-scrollbar{width:6px;height:6px}
.tree-scroll.scroll-visible::-webkit-scrollbar-thumb{background:var(--color-border-primary);border-radius:var(--r-full,999px)}
.tree-scroll.scroll-visible::-webkit-scrollbar-thumb:hover{background:var(--color-primary)}

/* 根节点：工作区（整行点击展开/收起；文件夹开合图标即状态） */
.ws-node{display:flex;align-items:center;height:30px;padding:0 8px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);color:var(--color-text-secondary);font-size:13px;cursor:pointer;user-select:none;transition:background var(--transition-fast);border:1px solid transparent;gap:8px}
.ws-node:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ws-icon{display:flex;align-items:center;justify-content:center;color:var(--color-text-tertiary,#a8abb2);flex-shrink:0}
.ws-node.ungrouped .ws-icon{color:var(--color-text-muted,#999)}
.ws-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary);line-height:20px}
.ws-act{display:none;align-items:center;justify-content:center;width:22px;height:22px;border:none;border-radius:var(--radius-sm);background:none;color:var(--color-text-tertiary,#a8abb2);cursor:pointer;flex-shrink:0;line-height:0}
.ws-node:hover .ws-act{display:flex}
.ws-act:hover,.ws-act.active{background:var(--color-bg-subtle);color:var(--color-primary,#6366f1)}
/* 本地资源管理器：打开中的 loader 旋转 */
.ws-spin{animation:ws-spin-rot 1s linear infinite}
@keyframes ws-spin-rot{to{transform:rotate(360deg)}}

/* 「更多」下拉（重命名 / 删除） */
.ws-more-wrap{position:relative;display:flex;flex-shrink:0}
.ws-menu{position:absolute;top:100%;right:0;margin-top:4px;min-width:130px;background:var(--bg-raised,var(--color-bg-page));border:1px solid var(--line,var(--color-border-secondary));border-radius:var(--radius-md);box-shadow:var(--shadow-pop);padding:4px;z-index:300}
.ws-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:6px;background:none;color:var(--text-1,var(--color-text-primary));font-size:13px;cursor:pointer;text-align:left}
.ws-menu-item:hover{background:var(--role-hover-bg,var(--bg-hover))}
.ws-menu-item svg{flex-shrink:0;color:var(--color-text-tertiary,#a8abb2)}
.ws-menu-danger{color:var(--err,#e74c3c)}
.ws-menu-danger svg{color:var(--err,#e74c3c)}
.ws-menu-danger:hover{background:color-mix(in srgb,var(--err,#e74c3c) 12%,transparent)}
.menu-fade-enter-active,.menu-fade-leave-active{transition:opacity .12s ease,transform .12s ease}
.menu-fade-enter-from,.menu-fade-leave-to{opacity:0;transform:translateY(-4px)}

/* 叶节点：会话（一行：头像 - 标题 - 删除；与树节点同高度/同间距/同风格） */
.ws-children .list-item{display:flex;align-items:center;height:30px;padding:0 8px 0 28px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);cursor:pointer;transition:background var(--transition-fast),border-color var(--transition-fast),box-shadow var(--transition-fast);border:1px solid transparent;gap:8px}
.ws-children .list-item:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
/* 选中态：角色色板（主色系底，色系身份而非浓度渐变；名称保持默认色） */
.ws-children .list-item.active{background:var(--role-selected-bg,#e6eaff);border-color:transparent;box-shadow:none}
.item-avatar-wrap{position:relative;flex-shrink:0}
.item-info{flex:1;min-width:0}
.item-name{font-size:13px;font-weight:500;line-height:20px;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 删除按钮：hover 条目时浮现 */
.item-delete{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:none;border-radius:var(--radius-sm);background:none;color:var(--color-text-tertiary,#a8abb2);cursor:pointer;opacity:0;transition:opacity var(--transition-fast),background var(--transition-fast),color var(--transition-fast);flex-shrink:0}
.ws-children .list-item:hover .item-delete{opacity:1}
.item-delete:hover{background:rgba(231,76,60,.1);color:#e74c3c}

/* 时间分桶桶头：「今天/一周/其他」标签 + 条数胶囊——与叶节点近似
   缩进、轻量小字行（比会话行矮一档，层级从视觉密度读出）；点击开合，
   chevron 收起指右、展开向下（与工作区文件夹开合同语言） */
.bucket-head{display:flex;align-items:center;gap:6px;height:24px;width:100%;margin:2px 0 var(--space-xs);padding:0 8px 0 16px;border:none;border-radius:var(--radius-sm);background:none;color:var(--color-text-tertiary,#a8abb2);font-size:11.5px;font-weight:600;letter-spacing:.3px;cursor:pointer;user-select:none;transition:color var(--transition-fast),background var(--transition-fast)}
.bucket-head:hover{background:var(--role-hover-bg,var(--color-bg-page));color:var(--color-primary,#6366f1)}
.bucket-chevron{display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--color-text-muted,#999);transition:transform .15s ease;transform:rotate(-90deg)}
.bucket-chevron.open{transform:rotate(0deg)}
.bucket-label{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bucket-count{flex-shrink:0;min-width:18px;text-align:center;padding:0 6px;line-height:16px;border-radius:var(--r-full,999px);font-size:10.5px;font-weight:500;color:var(--color-text-muted,#999);background:var(--color-bg-subtle,rgba(0,0,0,.06))}
html.dark .bucket-count{background:rgba(255,255,255,.07)}

/* 桶内分页闸门：「··· 展开更多（N）」——与桶内会话行同缩进、轻量
   幽灵样式（渐进追加一页；满额自然消失） */
.expand-more{display:flex;align-items:center;gap:8px;height:24px;width:100%;margin:0 0 var(--space-xs);padding:0 8px 0 28px;border:none;border-radius:var(--radius-sm);background:none;color:var(--color-text-muted,#999);font-size:11.5px;font-weight:500;cursor:pointer;user-select:none;transition:color var(--transition-fast),background var(--transition-fast)}
.expand-more:hover{background:var(--role-hover-bg,var(--color-bg-page));color:var(--color-primary,#6366f1)}
.expand-more-dots{flex-shrink:0;letter-spacing:1px;font-weight:700;line-height:1}
.empty{padding:var(--space-lg);text-align:center;color:var(--color-text-muted);font-size:14px}
.empty-hint{font-size:12px;color:var(--color-text-tertiary,#a8abb2)}

/* 弹窗通用（删除确认 / 新增工作区） */
.del-dialog{padding:20px 24px}
.del-dialog h4{margin:0 0 12px;font-size:15px;font-weight:600;color:var(--color-text-primary,#2c3e50)}
.del-text{margin:0 0 6px;font-size:13px;color:var(--color-text-primary,#2c3e50);line-height:1.6}
.del-text strong{font-weight:600}
.del-warn{margin:0 0 12px;font-size:12px;color:var(--color-text-secondary,#7f8c8d);line-height:1.6}
.del-strong{color:#e74c3c;font-weight:600}
.del-error{font-size:12px;color:#e74c3c;margin-bottom:8px}
.del-actions{display:flex;justify-content:flex-end;gap:8px}
.del-cancel,.del-confirm{padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer}
.del-cancel{background:var(--color-bg-page,#fff);border:1px solid var(--color-border-secondary,#ddd);color:var(--color-text-secondary,#7f8c8d)}
.del-confirm{background:#e74c3c;border:none;color:#fff}
.del-confirm:hover:not(:disabled){background:#c0392b}
.del-confirm:disabled,.del-cancel:disabled{opacity:.6;cursor:not-allowed}

/* 新增工作区弹窗 */
.ws-dialog{padding:20px 24px}
.ws-dialog h4{margin:0 0 6px;font-size:15px;font-weight:600;color:var(--color-text-primary,#2c3e50)}
.ws-dialog-hint{margin:0 0 14px;font-size:12px;color:var(--color-text-secondary,#7f8c8d);line-height:1.6}
.ws-form-group{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.ws-form-group label{font-size:12px;font-weight:500;color:var(--color-text-secondary,#7f8c8d)}
.optional-hint{color:var(--color-text-tertiary,#a8abb2);font-weight:400}
.ws-path-row{display:flex;gap:6px}
.ws-path-input{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--color-border-secondary,#ddd);border-radius:6px;font-size:12px;background:var(--color-bg-surface,#f8f9fa);color:var(--color-text-primary,#2c3e50);outline:none}
.ws-path-input::placeholder{color:var(--color-text-tertiary,#a8abb2)}
.ws-pick-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--color-border-secondary,#ddd);background:var(--color-bg-page,#fff);color:var(--color-text-secondary,#7f8c8d);font-size:13px;cursor:pointer;flex-shrink:0}
.ws-pick-btn:hover:not(:disabled){color:var(--color-primary,#6366f1);border-color:var(--color-primary,#6366f1)}
.ws-pick-btn:disabled{opacity:.6;cursor:not-allowed}
.ws-picking-hint{font-size:11.5px;color:var(--color-text-tertiary,#a8abb2);line-height:1.5;padding:2px 0 0}
.ws-form-group input{padding:7px 10px;border:1px solid var(--color-border-secondary,#ddd);border-radius:6px;font-size:13px;background:var(--color-bg-page,#fff);color:var(--color-text-primary,#2c3e50);outline:none}
.ws-form-group input:focus{border-color:var(--color-primary,#6366f1)}
.ws-save-btn{padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;background:var(--color-primary,#6366f1);border:none;color:#fff}
.ws-save-btn:hover:not(:disabled){background:var(--color-primary-hover,#4f46e5)}
.ws-save-btn:disabled{opacity:.6;cursor:not-allowed}

@media(max-width:768px){.session-list{position:fixed;top:0;left:0;bottom:0;width:min(280px,80vw);transform:translateX(-100%);visibility:hidden;transition:transform .25s ease,visibility .25s;box-shadow:2px 0 16px rgba(0,0,0,.15)}.session-list.drawer-visible{transform:translateX(0);visibility:visible}.mobile-close-btn{display:flex;align-items:center;justify-content:center}}
</style>
