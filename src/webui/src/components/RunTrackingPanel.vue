// AgentChat — 运行跟踪面板（侧边栏第三面板，与 Agent 列表 / 会话列表同级）
//
// 布局对齐会话列表（SessionList）的工作区树形态，自上而下：
//   1. 标题栏（文本「运行跟踪」）+ 移动端关闭
//   2. 运行总览（树内叶节点入口，点击打开/关闭主区运行矩阵）
//   3. 运行中（树节点）→ 运行中会话叶节点（点击跳转对应会话 = 主区由侧边栏选择驱动）
//   4. 后台任务（树节点）→ bash 后台等任务清单：运行中（时长 + 终止）
//      + 最近终态（DSH job_list 同款；stores/jobs 事件驱动刷新）
//   5. 子Agent 调用（树节点）→ subagent 委派清单（kind=subagent 任务：
//      运行中 + 最近终态含结果预览——meta.name/parentId/output）
//
// 数据：运行/会话树与主区矩阵视图共用 stores/runs（单一轮询）；
// 任务清单走 stores/jobs（job/started · job/settled 帧驱动，无轮询）。

<script setup lang="ts">
import { computed, ref, onMounted, inject } from 'vue';
import { Icon, StarAvatar } from '../ui';
import { useRunsStore } from '../stores/runs';
import { useUiStore } from '../stores/ui';
import { useAgentStore } from '../stores/agents';
import { useGroupsStore } from '../stores/groups';
import { useSinglesStore } from '../stores/singles';
import { useChatStore } from '../stores/chat';
import { useThemeStore } from '../stores/theme';
import { VIEWER_ID } from '../constants';
import { starColor } from '../utils/starColor';
import { traceSwitch } from '../utils/switchTrace';
import { interruptRun } from '../api/runs';
import type { RunsRunningEntry } from '../api/runs';
import { useJobsStore } from '../stores/jobs';
import {
  jobIsSubagent,
  jobOutputPreview,
  jobStatusLabel as statusLabel,
  jobStatusIcon as statusIcon,
  splitJobs,
  subagentMeta,
  type WireJob,
} from '../api/jobs';
import { formatDurationMs as fmtDuration } from '../utils/format';

const closeSidebar = inject<() => void>('closeSidebar', () => {});

const runsStore = useRunsStore();
const jobsStore = useJobsStore();
const ui = useUiStore();
const agentStore = useAgentStore();
const groupsStore = useGroupsStore();
const singlesStore = useSinglesStore();
const chatStore = useChatStore();
const themeStore = useThemeStore();

const snapshot = computed(() => runsStore.snapshot);
const now = computed(() => runsStore.now);
const running = computed<RunsRunningEntry[]>(() =>
  [...(snapshot.value?.running ?? [])].sort((a, b) => a.startedAt - b.startedAt));
const coverage = computed(() => snapshot.value?.coverage);

// ── 后台任务/子Agent 调用清单（stores/jobs：job/started·settled 帧驱动）──
/** 最近终态展示上限（服务端登记全保留，这里只展示最近一段） */
const RECENT_SETTLED_CAP = 10;

const allJobs = computed<WireJob[]>(() => jobsStore.jobs ?? []);
const jobsSplit = computed(() => splitJobs(allJobs.value));
const bgRunning = computed(() => jobsSplit.value.running.filter((j) => !jobIsSubagent(j)));
const subRunning = computed(() => jobsSplit.value.running.filter(jobIsSubagent));
const bgSettledAll = computed(() => jobsSplit.value.settled.filter((j) => !jobIsSubagent(j)));
const subSettledAll = computed(() => jobsSplit.value.settled.filter(jobIsSubagent));
const bgSettled = computed(() => bgSettledAll.value.slice(0, RECENT_SETTLED_CAP));
const subSettled = computed(() => subSettledAll.value.slice(0, RECENT_SETTLED_CAP));

/** 任务状态 → 色类（st-<status>；图标/文案共享 api/jobs 词汇） */
function statusClass(s: WireJob['status']): string {
  return `st-${s}`;
}

/** 后台任务行 tooltip：命令 + 身份 + 终态/输出预览 */
function jobTitle(j: WireJob): string {
  const lines = [j.label, `${j.id} · ${j.kind}${j.ownerAgentId ? ` · 归属 ${memberName(j.ownerAgentId)}` : ''}`];
  if (j.status !== 'running' && j.status !== 'stopping') {
    lines.push(`${statusLabel(j.status)}${j.detail ? `：${j.detail}` : ''}`);
    const preview = jobOutputPreview(j);
    if (preview) lines.push(`输出：${preview}`);
  }
  return lines.join('\n');
}

/** 子Agent 行 tooltip：名称/父 + 任务 + 终态/结果预览 */
function subTitle(j: WireJob): string {
  const m = subagentMeta(j);
  const lines = [
    `${m.name ?? '子任务'} · 父 ${memberName(m.parentId ?? j.ownerAgentId ?? '')}`,
    `任务：${j.label}`,
  ];
  if (j.status !== 'running' && j.status !== 'stopping') {
    lines.push(`${statusLabel(j.status)}${j.detail ? `：${j.detail}` : ''}`);
    const preview = jobOutputPreview(j);
    if (preview) lines.push(`结果：${preview}`);
  }
  return lines.join('\n');
}

/** 终止任务（运行中可见的 stop 按钮；killing 态由 store 管理） */
function doKill(id: string) {
  void jobsStore.kill(id);
}

function colorOf(id: string) { return starColor(id, themeStore.theme === 'dark' ? 'nebula' : 'aurora'); }

function memberName(id: string): string {
  const m = snapshot.value?.members.find(x => x.id === id);
  if (m && m.name !== id && !m.name.includes(id)) return m.name;
  return agentStore.getAgentName(id) || id;
}

function memberAvatar(id: string): string | null {
  return agentStore.getAgentAvatar(id);
}

function sourceLabel(r: RunsRunningEntry): string {
  const map: Record<string, string> = {
    user: '用户', agent: 'Agent', system: '系统', timer: '定时',
    group: '群聊', subagent: '子代理', continue: '续推', restart: '重启', archive: '归档',
  };
  return map[r.source?.kind ?? 'system'] ?? r.source?.kind ?? 'system';
}

function sessionTitle(r: RunsRunningEntry): string {
  if (r.kind === 'chat') {
    const seg = r.convKey.split('~').slice(1);
    const other = seg.filter(s => s !== r.agentId)[0] ?? r.agentId;
    return other === r.agentId
      ? `${memberName(r.agentId)}（自会话）`
      : `${memberName(r.agentId)} ↔ ${memberName(other)}`;
  }
  if (r.kind === 'group') {
    const gid = r.convKey.split('~')[1] ?? '';
    return `${memberName(r.agentId)} @ ${memberName(gid)}`;
  }
  const sid = r.convKey.split('~')[1] ?? '';
  const single = snapshot.value?.singles.find(s => s.id === sid);
  return single?.title || memberName(r.agentId || (single?.agentId ?? '')) || sid.slice(0, 8);
}

/** 该运行会话能否在主区打开（前端视角支持：single / 群 / viewer 参与的 1v1；
 *  Agent↔Agent 的 1v1 运行无可打开的聊天视图 → 不可跳转，仅展示） */
function jumpTarget(r: RunsRunningEntry): { kind: 'single' | 'group' | 'agent'; id: string } | null {
  if (r.kind === 'single') return { kind: 'single', id: r.convKey.split('~')[1] ?? '' };
  if (r.kind === 'group') return { kind: 'group', id: r.convKey.split('~')[1] ?? '' };
  const seg = r.convKey.split('~').slice(1);
  const viewer = VIEWER_ID.value;
  if (seg.includes(viewer)) {
    const counterpart = seg.find(s => s !== viewer) ?? viewer;
    return { kind: 'agent', id: counterpart };
  }
  return null;
}

/** 点击运行中会话 → 主区切换到该会话聊天（选择驱动主区；矩阵视图随之让位）。
 *  agent 分支 = 导航语义：不 toggle（selectAgent 同 id 反选成空会让主区毫无
 *  变化），并补齐矩阵 cell 同款导航仪式（清未读 + 加载历史 + 订阅流式——
 *  此前面板跳转只切选中不加载，跳到从未打开过的 Agent 是空白会话）。 */
async function jumpTo(r: RunsRunningEntry) {
  const t = jumpTarget(r);
  if (!t) return;
  traceSwitch('click-panel', `${t.kind}:${t.kind === 'single' ? t.id.slice(-8) : t.id}`);
  if (t.kind === 'single') {
    agentStore.activeAgentId = '';
    groupsStore.deselectGroup();
    if (!singlesStore.loaded) await singlesStore.refresh();
    singlesStore.selectSingle(t.id);
  } else if (t.kind === 'group') {
    agentStore.activeAgentId = '';
    singlesStore.deselectSingle();
    if (!groupsStore.groups.some(g => g.group_id === t.id)) await groupsStore.init();
    groupsStore.selectGroup(t.id);
  } else {
    groupsStore.deselectGroup();
    singlesStore.deselectSingle();
    if (agentStore.activeAgentId !== t.id) agentStore.selectAgent(t.id);
    chatStore.clearUnread(t.id);
    chatStore.loadHistory(VIEWER_ID.value, t.id);
    const a = agentStore.agents.find(x => x.id === t.id);
    if (a?.hasActiveSession) chatStore.subscribeAgent(t.id);
  }
  // 显式收起矩阵/pair 覆盖层：同值重选（跳到当前已在看的会话）时选中三元组
  // 不变，App 的选中 watch（只认非空变化）不会触发
  ui.closeTrackingView(); // 连带清 pairView
  closeSidebar();
}

const interrupting = ref(new Set<string>());

async function doInterrupt(convKey: string) {
  const next = new Set(interrupting.value);
  next.add(convKey);
  interrupting.value = next;
  try { await interruptRun(convKey); } catch { /* 下轮轮询可见结果 */ }
  finally {
    const done = new Set(interrupting.value);
    done.delete(convKey);
    interrupting.value = done;
  }
}

// ── 树展开/收起（默认全展开；记 fold 集合）──
const collapsed = ref(new Set<string>());

function toggleNode(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

/** 运行矩阵入口：打开主区大画布（已打开时再点 = 关闭回聊天） */
function toggleMatrix() {
  if (ui.trackingViewVisible) ui.closeTrackingView();
  else ui.openTrackingView();
}

onMounted(() => {
  runsStore.ensurePolling();
  jobsStore.ensureStarted();
  agentStore.requestAgents();
});
</script>

<template>
  <div class="runs-panel">
    <!-- 1. 标题栏（文本） -->
    <div class="panel-toolbar">
      <span class="toolbar-label">运行跟踪</span>
      <div class="toolbar-actions">
        <button class="mobile-close-btn" @click="closeSidebar" title="关闭菜单">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>
    <div v-if="runsStore.loadError" class="load-error">快照拉取失败：{{ runsStore.loadError }}</div>

    <!-- 2~4. 树列表 -->
    <div class="tree-scroll">
      <!-- 2. 运行总览：叶节点形态的矩阵入口（点击打开/关闭主区运行矩阵；
           叶行非分组节点 → 无展开 chevron/x，保留图标/名称/运行数徽标） -->
      <div class="tree-leaf overview-leaf" :class="{ active: ui.trackingViewVisible }"
        :title="`运行矩阵：会话对 ${coverage?.pairSessions ?? 0} · 群 ${coverage?.groupSessions ?? 0} · 矩阵外独立 ${coverage?.singleSessions ?? 0}（点击${ui.trackingViewVisible ? '关闭' : '打开'}）`"
        @click="toggleMatrix">
        <span class="node-icon kind-overview"><Icon name="activity" :size="14" /></span>
        <span class="leaf-name">运行总览</span>
        <span v-if="running.length > 0" class="node-badge">{{ running.length }}</span>
      </div>

      <!-- 3. 运行中 -->
      <div class="tree-node" @click="toggleNode('running')">
        <span class="node-icon"><Icon :name="collapsed.has('running') ? 'chevron-right' : 'chevron-down'" :size="14" /></span>
        <span class="node-icon kind-running"><Icon name="zap" :size="14" /></span>
        <span class="node-name">运行中</span>
        <span v-if="running.length > 0" class="node-badge">{{ running.length }}</span>
      </div>
      <div v-if="!collapsed.has('running')" class="node-children">
        <div v-if="running.length === 0" class="tree-leaf stat dim-leaf">没有正在运行的会话</div>
        <div v-for="r in running" :key="r.convKey" class="tree-leaf run"
          :class="{ jumpable: !!jumpTarget(r) }"
          :title="jumpTarget(r) ? `${sessionTitle(r)}\n${r.convKey}\n点击进入会话` : `${sessionTitle(r)}\n${r.convKey}`"
          @click="jumpTo(r)">
          <div class="leaf-avatar"><StarAvatar :src="memberAvatar(r.agentId)" :name="memberName(r.agentId)" :size="15" :color="colorOf(r.agentId)" fallback-icon="bot" :running="true" /></div>
          <span class="leaf-name">{{ sessionTitle(r) }}</span>
          <span class="leaf-dur">{{ fmtDuration(now - r.startedAt) }}</span>
          <button class="leaf-stop" :disabled="interrupting.has(r.convKey)" title="中断该 run（软中断）" @click.stop="doInterrupt(r.convKey)">
            <Icon name="stop" :size="10" />
          </button>
        </div>
      </div>

      <!-- 4. 后台任务（bash 后台等；运行中 + 最近终态） -->
      <div class="tree-node" @click="toggleNode('jobs')">
        <span class="node-icon"><Icon :name="collapsed.has('jobs') ? 'chevron-right' : 'chevron-down'" :size="14" /></span>
        <span class="node-icon kind-job"><Icon name="terminal" :size="14" /></span>
        <span class="node-name">后台任务</span>
        <span v-if="bgRunning.length > 0" class="node-badge">{{ bgRunning.length }}</span>
      </div>
      <div v-if="!collapsed.has('jobs')" class="node-children">
        <div v-if="bgRunning.length + bgSettledAll.length === 0" class="tree-leaf stat dim-leaf">暂无后台任务</div>
        <div v-for="j in bgRunning" :key="j.id" class="tree-leaf" :title="jobTitle(j)">
          <span class="leaf-icon" :class="statusClass(j.status)"><Icon :name="statusIcon(j.status)" :size="13" /></span>
          <span class="leaf-name">{{ j.label }}</span>
          <span class="leaf-dur">{{ fmtDuration(now - j.startedAt) }}</span>
          <button class="leaf-stop" :disabled="jobsStore.killing.has(j.id)" title="请求终止（settle 为 killed）" @click.stop="doKill(j.id)">
            <Icon name="stop" :size="10" />
          </button>
        </div>
        <div v-for="j in bgSettled" :key="j.id" class="tree-leaf" :title="jobTitle(j)">
          <span class="leaf-icon" :class="statusClass(j.status)"><Icon :name="statusIcon(j.status)" :size="13" /></span>
          <span class="leaf-name dim">{{ j.label }}</span>
          <span class="leaf-status" :class="statusClass(j.status)">{{ statusLabel(j.status) }}</span>
        </div>
        <div v-if="bgSettledAll.length > bgSettled.length" class="tree-leaf stat dim-leaf">
          仅显示最近 {{ bgSettled.length }} 条（终态共 {{ bgSettledAll.length }} 条）
        </div>
      </div>

      <!-- 5. 子Agent 调用（kind=subagent；运行中 + 最近终态含结果预览） -->
      <div class="tree-node" @click="toggleNode('subs')">
        <span class="node-icon"><Icon :name="collapsed.has('subs') ? 'chevron-right' : 'chevron-down'" :size="14" /></span>
        <span class="node-icon kind-sub"><Icon name="bot" :size="14" /></span>
        <span class="node-name">子Agent 调用</span>
        <span v-if="subRunning.length > 0" class="node-badge">{{ subRunning.length }}</span>
      </div>
      <div v-if="!collapsed.has('subs')" class="node-children">
        <div v-if="subRunning.length + subSettledAll.length === 0" class="tree-leaf stat dim-leaf">暂无子 Agent 调用</div>
        <div v-for="j in subRunning" :key="j.id" class="tree-leaf" :title="subTitle(j)">
          <div class="leaf-avatar"><StarAvatar :src="memberAvatar(subagentMeta(j).parentId ?? j.ownerAgentId ?? '')" :name="memberName(subagentMeta(j).parentId ?? j.ownerAgentId ?? '')" :size="15" :color="colorOf(subagentMeta(j).parentId ?? j.ownerAgentId ?? '')" fallback-icon="bot" :running="true" /></div>
          <span class="leaf-name">{{ subagentMeta(j).name ?? '子任务' }}<span class="dim"> · {{ memberName(subagentMeta(j).parentId ?? j.ownerAgentId ?? '') }}</span></span>
          <span class="leaf-dur">{{ fmtDuration(now - j.startedAt) }}</span>
          <button class="leaf-stop" :disabled="jobsStore.killing.has(j.id)" title="请求终止（abort 子 Agent）" @click.stop="doKill(j.id)">
            <Icon name="stop" :size="10" />
          </button>
        </div>
        <div v-for="j in subSettled" :key="j.id" class="tree-leaf" :title="subTitle(j)">
          <div class="leaf-avatar"><StarAvatar :src="memberAvatar(subagentMeta(j).parentId ?? j.ownerAgentId ?? '')" :name="memberName(subagentMeta(j).parentId ?? j.ownerAgentId ?? '')" :size="15" :color="colorOf(subagentMeta(j).parentId ?? j.ownerAgentId ?? '')" fallback-icon="bot" /></div>
          <span class="leaf-name dim">{{ subagentMeta(j).name ?? '子任务' }}<span class="dim"> · {{ memberName(subagentMeta(j).parentId ?? j.ownerAgentId ?? '') }}</span></span>
          <span class="leaf-status" :class="statusClass(j.status)">{{ statusLabel(j.status) }}</span>
        </div>
        <div v-if="subSettledAll.length > subSettled.length" class="tree-leaf stat dim-leaf">
          仅显示最近 {{ subSettled.length }} 条（终态共 {{ subSettledAll.length }} 条）
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.runs-panel{flex:1;min-width:0;background:var(--color-bg-surface);border-right:1px solid var(--color-border-secondary);display:flex;flex-direction:column;z-index:210;transition:transform .25s ease;position:relative}
html.dark .runs-panel{background:var(--bg-deep,#0a0d14)}

/* 1. 标题栏（对齐 SessionList 的 ws-toolbar 形态） */
.panel-toolbar{display:flex;align-items:center;gap:6px;padding:10px 14px 6px;flex-shrink:0}
.toolbar-label{font-size:12px;font-weight:600;letter-spacing:.5px;color:var(--color-text-tertiary,#a8abb2);user-select:none}
.toolbar-actions{margin-left:auto;display:flex;align-items:center;gap:2px}
.mobile-close-btn{display:none;background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:4px;border-radius:var(--radius-sm);line-height:0}
.mobile-close-btn:hover{background:var(--color-bg-subtle);color:var(--color-text-primary)}
.load-error{padding:4px 12px 6px;font-size:11px;color:#e74c3c;flex-shrink:0}

/* 树滚动区（对齐 SessionList 的 tree-scroll） */
.tree-scroll{flex:1;overflow-y:auto;padding:var(--space-xs);background:var(--color-bg-surface,#f8f9fa);scrollbar-width:none;scrollbar-color:transparent transparent}
html.dark .tree-scroll{background:var(--bg-deep,#0a0d14)}
.tree-scroll::-webkit-scrollbar{width:0;height:0}

/* 树节点（对齐 ws-node：30px 行高 + hover 浮起） */
.tree-node{display:flex;align-items:center;height:30px;padding:0 8px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);color:var(--color-text-secondary);font-size:13px;cursor:pointer;user-select:none;transition:background var(--transition-fast);border:1px solid transparent;gap:6px}
.tree-node:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.node-icon{display:flex;align-items:center;justify-content:center;color:var(--color-text-tertiary,#a8abb2);flex-shrink:0}
.node-icon.kind-overview{color:var(--color-primary,#6366f1)}
.node-icon.kind-running{color:#f59e0b}
.node-icon.kind-job{color:#0ea5e9}
.node-icon.kind-sub{color:#8b5cf6}
.node-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary);line-height:20px}
.node-badge{min-width:16px;height:16px;padding:0 4px;display:flex;align-items:center;justify-content:center;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;font-weight:600;line-height:1;flex-shrink:0}
/* 运行总览：叶节点形态的矩阵入口（不在 .node-children 内 → 叶行样式自带；
 *  30px 高 + hover 与其它叶一致，主色强调 + 选中态保留） */
.overview-leaf{display:flex;align-items:center;height:30px;padding:0 8px 0 28px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);cursor:pointer;user-select:none;transition:background var(--transition-fast),border-color var(--transition-fast),box-shadow var(--transition-fast);border:1px solid transparent;gap:8px}
.overview-leaf:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.overview-leaf .node-icon.kind-overview{color:var(--color-primary,#6366f1)}
.overview-leaf .leaf-name{color:var(--color-primary,#6366f1)}
.overview-leaf.active{background:var(--role-selected-bg,#e6eaff);border-color:transparent}

/* 叶节点（对齐 SessionList 的 list-item：30px + 缩进） */
.node-children .tree-leaf{display:flex;align-items:center;height:30px;padding:0 8px 0 28px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);cursor:default;transition:background var(--transition-fast),border-color var(--transition-fast),box-shadow var(--transition-fast);border:1px solid transparent;gap:8px}
.node-children .tree-leaf:hover{background:var(--role-hover-bg,var(--color-bg-page));border-color:var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.node-children .tree-leaf.jumpable{cursor:pointer}
.node-children .tree-leaf.active{background:var(--role-selected-bg,#e6eaff);border-color:transparent}
.leaf-icon{display:flex;align-items:center;justify-content:center;color:var(--color-text-tertiary,#a8abb2);flex-shrink:0}
.leaf-icon.dim{color:var(--color-text-muted,#999)}
.leaf-name{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:20px;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.leaf-avatar{position:relative;flex-shrink:0}
.leaf-dur{font-size:11px;font-weight:600;color:var(--color-text-primary);font-variant-numeric:tabular-nums;flex-shrink:0}
.dim-leaf{color:var(--color-text-muted);font-size:12px}
.dim{color:var(--color-text-tertiary,#a8abb2)}

/* 任务终态徽标（leaf-status）/状态图标色类（.leaf-icon 本体在上方树样式区）：
 *  running 琥珀 / stopping 灰 / completed 绿 / failed 红 / killed 暗灰 */
.leaf-status{font-size:11px;font-weight:600;flex-shrink:0}
.st-running{color:#f59e0b}
.st-stopping{color:var(--color-text-tertiary,#a8abb2)}
.st-completed{color:#22c55e}
.st-failed{color:#e74c3c}
.st-killed{color:var(--color-text-muted,#999)}

/* 中断按钮：hover 浮现 */
.leaf-stop{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;background:none;color:#e74c3c;cursor:pointer;flex-shrink:0;opacity:0;transition:opacity var(--transition-fast)}
.tree-leaf:hover .leaf-stop{opacity:1}
.leaf-stop:hover:not(:disabled){background:rgba(231,76,60,.1)}
.leaf-stop:disabled{opacity:.4;cursor:wait}

@media(max-width:768px){
  .runs-panel{position:fixed;top:0;left:0;bottom:0;width:min(280px,80vw);transform:translateX(-100%);visibility:hidden;transition:transform .25s ease,visibility .25s;box-shadow:2px 0 16px rgba(0,0,0,.15)}
  .runs-panel.sidebar-mobile-visible{transform:translateX(0);visibility:visible}
  .mobile-close-btn{display:flex;align-items:center;justify-content:center}
}
</style>
