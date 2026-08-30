// AgentChat — 会话列表（独立会话页，与 Agent 列表同级的活动栏入口）
//
// 布局（自上而下）：
//   1. 新增按钮（新建会话，占满一行）
//   2. 工具栏：工作区（文本）— 间隔 — 新增工作区（纯 ICON）
//   3. 树列表：用户工作区为根节点（按名称排列，整行点击展开/收起，
//      文件夹开合图标即状态；hover 显示 更多（重命名/删除）+ 新增会话），
//      各 session 为单行叶节点（头像 - 标题 - 删除；未挂工作区的会话
//      归入固定「未分组」根，排在末尾）
//
// 用户工作区 = 用户登记的本机文件夹（白名单区域）：挂在其下的会话
// 运行时把该文件夹并入沙箱路径白名单（后端 extraAllowedPaths 链路）。

<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted } from 'vue';

import { useAgentStore } from '../stores/agents';
import { useSinglesStore } from '../stores/singles';
import { useWorkspacesStore } from '../stores/workspaces';
import { useFeedStore } from '../stores/feed';
import { useUiStore } from '../stores/ui';
import { useThemeStore } from '../stores/theme';
import { StarAvatar, Modal, Icon } from '../ui';
import { starColor } from '../utils/starColor';
import { singleDialog } from '../utils/feed';
import { traceSwitch } from '../utils/switchTrace';
import { formatRelativeTime } from '../utils/format';
import { browseFolder } from '../api/files';
import type { Workspace } from '../api/files';

const emit = defineEmits<{
  (e: 'deselectGroup'): void;
}>();

const agentStore = useAgentStore();
const singlesStore = useSinglesStore();
const workspacesStore = useWorkspacesStore();
const feedStore = useFeedStore();
const ui = useUiStore();
const themeStore = useThemeStore();

/** Agent 星色（主题响应式：切换主题自动更新） */
function colorOf(id: string) { return starColor(id, themeStore.theme === 'dark' ? 'nebula' : 'aurora'); }

/** 会话是否正在运行（其 single 对话处于流式运行中 → 头像显示流转光环） */
function isSessionRunning(id: string): boolean { return feedStore.getDialog(singleDialog(id))?.streaming ?? false; }

const closeSidebar = inject<() => void>('closeSidebar', () => {});

// ── 删除会话确认（硬删：元数据+消息，不可恢复）──
const deleteTarget = ref<{ id: string; title: string } | null>(null);
const deleteBusy = ref(false);
const deleteError = ref('');

async function confirmDelete() {
  if (!deleteTarget.value || deleteBusy.value) return;
  deleteBusy.value = true;
  deleteError.value = '';
  try {
    await singlesStore.remove(deleteTarget.value.id);
    deleteTarget.value = null;
  } catch (err: any) {
    deleteError.value = `删除失败: ${err?.message ?? String(err)}`;
  } finally {
    deleteBusy.value = false;
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
  singlesStore.activeSingles
    .map(s => ({
      id: s.id,
      title: singlesStore.titleOf(s, (id) => agentStore.getAgentName(id) || id),
      agentId: s.agentId,
      agentName: s.agentId ? (agentStore.getAgentName(s.agentId) || s.agentId) : (agentStore.defaultPreset?.label || '标准'),
      workspaceId: s.workspaceId || '',
      lastActivity: s.lastActivity ? new Date(s.lastActivity).getTime() : new Date(s.createdAt).getTime(),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity),
);

interface WorkspaceGroup {
  key: string;
  name: string;
  /** undefined = 未分组（固定根） */
  workspace?: Workspace;
  sessions: SessionItem[];
}

/** 树模型：工作区根（按名称排序）+ 未分组固定根（有会话才出现） */
const treeGroups = computed<WorkspaceGroup[]>(() => {
  const groups: WorkspaceGroup[] = workspacesStore.workspaces.map(w => ({
    key: w.id, name: w.name, workspace: w, sessions: [],
  }));
  // 已按名称排序（后端 localeCompare numeric）；此处再排一次保持确定序
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ungrouped: WorkspaceGroup = { key: '__ungrouped__', name: '未分组', sessions: [] };
  for (const item of sessionItems.value) {
    const g = item.workspaceId ? groups.find(g => g.key === item.workspaceId) : undefined;
    (g ?? ungrouped).sessions.push(item);
  }
  const out = groups; // 空工作区也显示（可挂新会话）
  if (ungrouped.sessions.length > 0) out.push(ungrouped);
  return out;
});

// ── 展开/收起（默认展开；记住用户折叠状态）──
const collapsed = ref(new Set<string>());

function toggleGroup(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

function timeOf(ts: number): string { return formatRelativeTime(ts); }

// ── 新建会话：顶部按钮 = 未分组空会话；工作区节点 + = 挂该工作区 ──
const creatingSession = ref(false);
async function createSession(workspaceId?: string) {
  if (creatingSession.value) return; // 双击守卫：快速双击会创建两个空会话
  creatingSession.value = true;
  try {
    if (workspaceId) await singlesStore.create({ workspaceId });
    else await singlesStore.createQuick();
  } finally {
    creatingSession.value = false;
  }
}

/** 进入独立会话：清 Agent/群组选中（互斥），列表只切上下文，历史由 DialogView 加载。
 *  显式收起运行矩阵/pair 只读视角：点击「当前已激活」的会话时选中三元组不变，
 *  App 的选中 watch（只认非空变化）不触发，不显式收起则主区无变化 */
function selectSingle(sessionId: string) {
  traceSwitch('click-single', sessionId);
  agentStore.activeAgentId = '';
  emit('deselectGroup');
  singlesStore.selectSingle(sessionId);
  ui.closeTrackingView(); // 连带清 pairView（幂等）
  closeSidebar();
}

// ── 新增工作区（弹窗：原生文件夹选择 → 名称确认）──
const showWsDialog = ref(false);
const wsPath = ref('');
const wsName = ref('');
const wsBusy = ref(false);
const wsError = ref('');
/** 文件夹选择对话框打开中（后端已弹出系统窗口，等待用户选择） */
const wsPicking = ref(false);

function openWsDialog() {
  showWsDialog.value = true;
  wsPath.value = '';
  wsName.value = '';
  wsError.value = '';
  wsPicking.value = false;
}

async function pickFolder() {
  if (wsBusy.value) return;
  wsBusy.value = true;
  wsPicking.value = true;
  wsError.value = '';
  try {
    const d = await browseFolder('选择工作区文件夹');
    if (d.success && d.path) {
      wsPath.value = d.path;
      // 名称缺省 = 文件夹名（用户可改）
      if (!wsName.value.trim()) wsName.value = d.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || d.path;
    } else if (d.error) {
      // 超时自动关闭等带原因的失败（纯取消 cancelled 无 error，静默）
      wsError.value = d.error;
    }
  } catch (err: any) {
    wsError.value = `打开文件夹对话框失败: ${err?.message ?? String(err)}`;
  } finally {
    wsBusy.value = false;
    wsPicking.value = false;
  }
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
    await workspacesStore.create({ path: wsPath.value, name: wsName.value.trim() || undefined });
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
    await workspacesStore.remove(deleteWsTarget.value.id);
    deleteWsTarget.value = null;
  } catch (err: any) {
    deleteWsError.value = `删除失败: ${err?.message ?? String(err)}`;
  } finally {
    deleteWsBusy.value = false;
  }
}

// ── 工作区「更多」菜单（重命名 / 删除；单开，点击外部关闭）──
const wsMenuOpen = ref<string | null>(null);

function toggleWsMenu(key: string) {
  wsMenuOpen.value = wsMenuOpen.value === key ? null : key;
}

function onDocClick() { wsMenuOpen.value = null; }

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
    await workspacesStore.rename(renameTarget.value.id, name);
    renameTarget.value = null;
  } catch (err: any) {
    renameError.value = `重命名失败: ${err?.message ?? String(err)}`;
  } finally {
    renameBusy.value = false;
  }
}

onMounted(() => {
  agentStore.requestAgents();
  void singlesStore.refresh();
  void workspacesStore.refresh();
  document.addEventListener('click', onDocClick);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
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

    <!-- 2. 工具栏：工作区（文本）— 间隔 — 新增工作区（纯 ICON） -->
    <div class="ws-toolbar">
      <span class="ws-label">工作区</span>
      <div class="ws-toolbar-actions">
        <button class="ws-add-btn" @click="openWsDialog" title="新增工作区（登记一个文件夹白名单区域）">
          <Icon name="folder-plus" :size="16" />
        </button>
        <button class="mobile-close-btn" @click="closeSidebar" title="关闭菜单">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>

    <!-- 3. 树列表：工作区根节点（按名称排列）→ 各 session 叶节点 -->
    <div class="tree-scroll">
      <template v-for="group in treeGroups" :key="group.key">
        <!-- 根节点：工作区 / 未分组（点击整行展开/收起；文件夹开合图标即状态） -->
        <div class="ws-node" :class="{ ungrouped: !group.workspace }" :title="group.workspace ? `${group.name}\n${group.workspace.path}` : '未挂工作区的会话'" @click="toggleGroup(group.key)">
          <span class="ws-icon"><Icon :name="collapsed.has(group.key) ? 'folder' : 'folder-open'" :size="15" /></span>
          <span class="ws-name">{{ group.name }}</span>
          <!-- hover 操作：更多（重命名/删除）· 新增会话（未分组根无操作） -->
          <template v-if="group.workspace">
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
        <!-- 叶节点：会话（一行：头像 - 标题 - 删除） -->
        <div v-if="!collapsed.has(group.key)" class="ws-children">
          <div v-for="item in group.sessions" :key="item.id" class="list-item"
            :class="{ active: singlesStore.activeSingleId === item.id }"
            :title="`${item.title} · ${item.agentName} · ${timeOf(item.lastActivity)}`"
            @click="selectSingle(item.id)">
            <div class="item-avatar-wrap"><StarAvatar :src="agentStore.getAgentAvatar(item.agentId)" :name="item.agentName" :size="15" :color="colorOf(item.agentId)" fallback-icon="bot" :running="isSessionRunning(item.id)" /></div>
            <div class="item-info">
              <div class="item-name">{{ item.title }}</div>
            </div>
            <button class="item-delete" title="删除会话（含消息，不可恢复）" @click.stop="deleteTarget = { id: item.id, title: item.title }">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
            </button>
          </div>
        </div>
      </template>

      <div v-if="treeGroups.length === 0" class="empty">
        暂无会话<br /><span class="empty-hint">点击「新增」直接开始；「+」登记文件夹工作区分组管理会话</span>
      </div>
    </div>

    <!-- 删除会话确认弹窗 -->
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

    <!-- 新增工作区弹窗（原生文件夹选择） -->
    <Modal :visible="showWsDialog" :width="420" @close="showWsDialog = false">
      <div class="ws-dialog">
        <h4>新增工作区</h4>
        <p class="ws-dialog-hint">登记一个本机文件夹作为会话分组；挂在此工作区的会话，其 Agent 可访问该文件夹（沙箱白名单）。</p>
        <div class="ws-form-group">
          <label>文件夹</label>
          <div class="ws-path-row">
            <!-- 允许手动输入/粘贴路径：对话框异常时的兜底录入通道 -->
            <input v-model="wsPath" type="text" class="ws-path-input" placeholder="点击右侧按钮选择文件夹，或直接输入/粘贴绝对路径" @keyup.enter="confirmCreateWorkspace" />
            <button class="ws-pick-btn" :disabled="wsBusy" @click="pickFolder">{{ wsBusy ? '…' : '选择' }}</button>
          </div>
          <!-- 对话框打开中提示：告知用户去系统弹窗操作（模态窗口可能在其他窗口后） -->
          <p v-if="wsPicking" class="ws-picking-hint">已打开系统文件夹选择对话框，请在弹出的窗口中选择（10 分钟内有效；也可直接手动输入路径）…</p>
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
.session-list{flex:1;min-width:0;background:var(--color-bg-surface);border-right:1px solid var(--color-border-secondary);display:flex;flex-direction:column;z-index:210;transition:transform .25s ease;position:relative}
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

/* 根节点：工作区（整行点击展开/收起；文件夹开合图标即状态） */
.ws-node{display:flex;align-items:center;height:30px;padding:0 8px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);color:var(--color-text-secondary);font-size:13px;cursor:pointer;user-select:none;transition:background var(--transition-fast);border:1px solid transparent;gap:8px}
.ws-node:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ws-icon{display:flex;align-items:center;justify-content:center;color:var(--color-text-tertiary,#a8abb2);flex-shrink:0}
.ws-node.ungrouped .ws-icon{color:var(--color-text-muted,#999)}
.ws-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary);line-height:20px}
.ws-act{display:none;align-items:center;justify-content:center;width:22px;height:22px;border:none;border-radius:5px;background:none;color:var(--color-text-tertiary,#a8abb2);cursor:pointer;flex-shrink:0;line-height:0}
.ws-node:hover .ws-act{display:flex}
.ws-act:hover,.ws-act.active{background:var(--color-bg-subtle);color:var(--color-primary,#6366f1)}

/* 「更多」下拉（重命名 / 删除） */
.ws-more-wrap{position:relative;display:flex;flex-shrink:0}
.ws-menu{position:absolute;top:100%;right:0;margin-top:4px;min-width:130px;background:var(--bg-raised,var(--color-bg-page));border:1px solid var(--line,var(--color-border-secondary));border-radius:8px;box-shadow:var(--shadow-pop,0 4px 16px rgba(0,0,0,.12));padding:4px;z-index:300}
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
.item-delete{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:none;border-radius:5px;background:none;color:var(--color-text-tertiary,#a8abb2);cursor:pointer;opacity:0;transition:opacity var(--transition-fast),background var(--transition-fast),color var(--transition-fast);flex-shrink:0}
.ws-children .list-item:hover .item-delete{opacity:1}
.item-delete:hover{background:rgba(231,76,60,.1);color:#e74c3c}
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
/* 对话框打开中提示（非错误，用主色弱化） */
.ws-picking-hint{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--color-primary,#6366f1)}
.ws-path-input{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--color-border-secondary,#ddd);border-radius:6px;font-size:12px;background:var(--color-bg-surface,#f8f9fa);color:var(--color-text-primary,#2c3e50);outline:none}
.ws-path-input::placeholder{color:var(--color-text-tertiary,#a8abb2)}
.ws-pick-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--color-border-secondary,#ddd);background:var(--color-bg-page,#fff);color:var(--color-text-secondary,#7f8c8d);font-size:13px;cursor:pointer;flex-shrink:0}
.ws-pick-btn:hover:not(:disabled){color:var(--color-primary,#6366f1);border-color:var(--color-primary,#6366f1)}
.ws-pick-btn:disabled{opacity:.6;cursor:not-allowed}
.ws-form-group input{padding:7px 10px;border:1px solid var(--color-border-secondary,#ddd);border-radius:6px;font-size:13px;background:var(--color-bg-page,#fff);color:var(--color-text-primary,#2c3e50);outline:none}
.ws-form-group input:focus{border-color:var(--color-primary,#6366f1)}
.ws-save-btn{padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;background:var(--color-primary,#6366f1);border:none;color:#fff}
.ws-save-btn:hover:not(:disabled){background:var(--color-primary-hover,#4f46e5)}
.ws-save-btn:disabled{opacity:.6;cursor:not-allowed}

@media(max-width:768px){.session-list{position:fixed;top:0;left:0;bottom:0;width:min(280px,80vw);transform:translateX(-100%);visibility:hidden;transition:transform .25s ease,visibility .25s;box-shadow:2px 0 16px rgba(0,0,0,.15)}.session-list.sidebar-mobile-visible{transform:translateX(0);visibility:visible}.mobile-close-btn{display:flex;align-items:center;justify-content:center}}
</style>
