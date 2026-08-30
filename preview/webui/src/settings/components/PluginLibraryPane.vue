<script setup lang="ts">
// ============================================================
// PluginLibraryPane.vue —— 插件库（M24 P4 目录信息架构重构）
//   两页签「目录 | 插件市场」（M23 四页签退役——行卡片、四态徽章、执行链、
//   安全模式横幅等已落地组件原样搬入目录视图）：
//     · 目录 = 左导航（插件 / 工具 / 事件 三视图）+ 右面板
//       - 插件视图：内置组（包源清单 plugin/catalog.builtin × cordis
//         registry 装配交叉 + 行偏好开关）+ 本地组（registry ∪ devScan ∪
//         会话装载单一清单 + 待审暂存并入徽章态）+ 配置弹窗（全局默认层
//         写 config/set → settings.<configNs>）
//       - 工具视图：仅 schema 查看（可配置项已移至所属插件卡片）
//       - 事件视图：事件执行链（描述/治理开关随 M25）
//     · 插件市场（M24 P5）：npm/github 搜索 + 暂存人审安装流（第三方
//       供应链维持人审，与 Agent 自开发免审流分立）
// ============================================================
import { ref, computed, watch } from 'vue';
import type {
  PluginInfo, PluginPermissionsView, StagingRecord,
  ExtensionEntry, AgentToolInfo, DevPluginInfo,
  EventChainEntry, EventDescriptionEntry, PluginPatchEntry, AssemblyRowInfo,
} from '../types';
import type { CatalogBuiltinRow, CatalogLocalRow, CatalogPendingRow, MarketResult } from '../api';
import * as api from '../api';
import { Icon, Modal, Button } from '@/ui';
import PluginDevCard from './PluginDevCard.vue';
import StagingReviewModal from './StagingReviewModal.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import ExtensionSettingsModal from './ExtensionSettingsModal.vue';

const props = defineProps<{
  /** 目录信息架构（M24 P3：plugin/catalog 两分组 + 待审并入） */
  catalogBuiltin: CatalogBuiltinRow[];
  catalogLocal: CatalogLocalRow[];
  catalogPending: CatalogPendingRow[];
  catalogNote?: string;
  /** 数据根（plugin/dev-scan 透出；dev 路径提示用） */
  root?: string;
  session: PluginInfo[];
  permissions: PluginPermissionsView | null;
  /** cordis 装配行清单（plugin/rows；行偏好开关锚点 entryId） */
  rows: AssemblyRowInfo[];
  /** 扩展目录（plugin/extension-catalog；配置弹窗数据源） */
  extensions: ExtensionEntry[];
  /** 工具目录（tools/list 只读；工具视图 schema 弹窗） */
  tools: AgentToolInfo[];
  /** 事件执行链（events/listeners；事件视图底座） */
  eventChains?: EventChainEntry[];
  /** 事件描述声明 × 执行链交叉（M25 P2：events/descriptions） */
  eventDescriptions?: EventDescriptionEntry[];
  eventChainsByEvent?: Record<string, EventChainEntry['listeners']>;
  /** 治理停用集（M25 P2：events/policy-list） */
  eventPolicy?: { disabled: string[]; live: string[] };
  /** 安全模式（plugin/loaded.safeMode；顶部横幅） */
  safeMode?: boolean;
}>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

const tab = ref<'catalog' | 'market'>('catalog');
const view = ref<'plugins' | 'tools' | 'events'>('plugins');
const busyName = ref('');
const error = ref('');
const success = ref('');
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
const reviewRecord = ref<StagingRecord | null>(null);

function flash(msg: string) {
  success.value = msg;
  setTimeout(() => { success.value = ''; }, 3500);
}

// ── 行偏好层 cordis.patch.yml（内置组启停开关；锚点 = yml 行 entryId） ──
const patches = ref<PluginPatchEntry[]>([]);
const patchFile = ref('');
const patchWarnings = ref<string[]>([]);
async function loadPatches(): Promise<void> {
  try {
    const r = await api.getPatchList();
    patches.value = r.patches;
    patchFile.value = r.file;
    patchWarnings.value = r.warnings;
  } catch {
    /* fail-soft：无 patch 面 → 停用开关按缺省（全部启用）呈现 */
  }
}
watch(tab, (t) => { if (t === 'catalog') void loadPatches(); });
watch(view, () => { void loadPatches(); });
/** 行（包名 → yml entryId）当前是否被偏好层停用 */
const entryIdOf = computed(() => {
  const byName = new Map<string, string>();
  for (const r of props.rows) {
    if (r.entryId && !byName.has(r.name)) byName.set(r.name, r.entryId);
  }
  return (pkgName: string): string | undefined => byName.get(pkgName);
});
function patchDisabled(pkgName: string): boolean {
  const id = entryIdOf.value(pkgName);
  const key = id ?? pkgName;
  const entry = patches.value.find((p) => p.id === key || p.id === pkgName);
  return entry?.disabled === true;
}
/** 可 patch 的内置行（有 yml entryId 才有开关；未装配行也允许预写偏好） */
function canPatch(b: CatalogBuiltinRow): boolean {
  return entryIdOf.value(b.name) !== undefined;
}
/** 反依赖图（M25 P3：停用承重行级联警告；组件内自取——与 patches 同生命周期） */
const depGraph = ref<Awaited<ReturnType<typeof api.getDepGraph>>['rows']>([]);
async function loadDepGraph(): Promise<void> {
  try {
    depGraph.value = (await api.getDepGraph()).rows;
  } catch {
    depGraph.value = []; // fail-soft：无此面 → 无级联提示（不阻断开关）
  }
}
const PROTECTED_ROW_PKGS = new Set(['ac-security', 'ac-plugin-gates']);
async function toggleRowPatch(b: CatalogBuiltinRow, on: boolean): Promise<void> {
  const id = entryIdOf.value(b.name);
  if (!id) {
    error.value = `行 "${b.name}" 无装配树 entry id（未装配包不可预写偏好）`;
    return;
  }
  // M25 P3：停用承重行级联警告（反依赖图 dependents 传递闭包）+ 保护行
  // 二次确认特殊文案（不指望图——清单硬编码）
  if (!on) {
    if (depGraph.value.length === 0) await loadDepGraph();
    const entry = depGraph.value.find((r) => r.name === b.name);
    const cascades = entry?.dependents ?? [];
    const isProtected = PROTECTED_ROW_PKGS.has(b.name);
    if (isProtected || cascades.length > 0) {
      const ok = await confirmRef.value?.ask({
        title: isProtected ? `停用保护行 ${b.name}？` : `停用 ${b.name}？`,
        message: isProtected
          ? `${b.name} 是保护行（安全防线）。停用后全部 Agent 失去对应防线；级联断链：${cascades.length > 0 ? cascades.join('、') : '（无下游注入方）'}。自担风险。`
          : `该行为承重行——停用将级联断链 ${cascades.length} 个注入方：${cascades.join('、')}。（声明式 inject 依赖；ctx.get 软依赖不在图内。）`,
        confirmLabel: isProtected ? '停用保护行（自担风险）' : '停用（级联断链）',
        danger: true,
      });
      if (!ok) return;
    }
  }
  busyName.value = b.name;
  error.value = '';
  try {
    const result = await api.setPluginPatch(id, !on);
    patches.value = result.patches;
    if (result.state === 'no-include-row') {
      flash('已写入偏好文件，但当前进程非配置驱动启动（无 include 行），重启后生效');
    } else if (result.state === 'hot') {
      flash('行偏好已热更新（当前进程行已重组合）');
    } else {
      flash('已写入行偏好（重启后生效）');
    }
    emit('refresh');
  } catch (e: any) {
    error.value = `写入行偏好失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

// ── 配置弹窗（全局默认层实例；Agent 差异层实例在 Agent 装配页） ──
const configEntry = ref<ExtensionEntry | null>(null);
/** 内置行 → 可配置（扩展目录命中且带 configNs） */
function extOf(pkgName: string): ExtensionEntry | undefined {
  return props.extensions.find((e) => e.row === pkgName && e.configNs);
}
const builtinWithExt = computed(() =>
  props.catalogBuiltin.map((b) => ({ row: b, ext: extOf(b.name) })),
);

// ── 本地组：状态徽章 + 动作 ──
const STATE_LABELS: Record<CatalogLocalRow['state'], { text: string; cls: string; title: string }> = {
  loaded: { text: '已装载', cls: 'on', title: '进程内已装载' },
  installed: { text: '已安装·未装载', cls: 'off', title: 'registry.json 安装态；boot 扫描恢复装载' },
  failed: { text: '装载失败', cls: 'fail', title: '最近一次装载失败（见 error）' },
  skipped: { text: '已熔断', cls: 'fuse', title: '连续装载失败熔断；复位 = bump version 重装 / 卸载 / 删 .load-health.json' },
  dev: { text: '开发面', cls: 'dyn', title: 'devScan 扫描到、未安装——可装载试跑或暂存发布' },
  pending: { text: '待审', cls: 'wait', title: '暂存待人审' },
};

async function unloadLocal(l: CatalogLocalRow): Promise<void> {
  const ok = await confirmRef.value?.ask({
    title: '卸载装载？',
    message: `插件 "${l.name}" 将从当前进程卸载（目录保留；已安装行重启后自动恢复装载，会话行重启即失）。`,
    confirmLabel: '卸载装载',
    danger: true,
  });
  if (!ok) return;
  busyName.value = l.name;
  error.value = '';
  try {
    await api.unloadSessionPlugin(l.name);
    flash(`"${l.name}" 已从当前进程卸载（目录保留）`);
    emit('refresh');
  } catch (e: any) {
    error.value = `卸载装载失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

async function uninstallLocal(l: CatalogLocalRow): Promise<void> {
  const ok = await confirmRef.value?.ask({
    title: '永久卸载？',
    message: `将把插件 "${l.name}" 从插件库移除（装载回收，目录移动到 .backup/<name>-<version>-<ts>）。`,
    confirmLabel: '永久卸载',
    danger: true,
  });
  if (!ok) return;
  busyName.value = l.name;
  error.value = '';
  try {
    const result = await api.uninstallPlugin(l.name);
    flash(`已卸载 "${l.name}"${result.backupDir ? `，备份到 ${result.backupDir}` : ''}`);
    emit('refresh');
  } catch (e: any) {
    error.value = `卸载失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

/** 开发面装载（dev 卡片注册：目录 → 会话级装载） */
async function registerLocal(l: CatalogLocalRow): Promise<void> {
  if (!l.dir) {
    error.value = `开发插件 "${l.name}" 缺少目录信息`;
    return;
  }
  busyName.value = l.name;
  error.value = '';
  try {
    const result = await api.registerSessionPlugin(l.dir, l.owner);
    flash(`"${l.name}" 已装载（${result.status === 'replaced' ? '已替换旧实例' : '已加载'}；重启即失）。`);
    emit('refresh');
  } catch (e: any) {
    error.value = `装载失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

/** 开发面暂存发布（dev → staging 人审） */
async function stageLocal(l: CatalogLocalRow): Promise<void> {
  if (!l.dir) {
    error.value = `开发插件 "${l.name}" 缺少目录信息`;
    return;
  }
  busyName.value = l.name;
  error.value = '';
  try {
    const result = await api.stagePlugin(l.dir, l.owner ?? 'user');
    flash(`"${l.name}" 已暂存待审（id: ${result.staging.id}）`);
    emit('refresh');
  } catch (e: any) {
    error.value = `暂存失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

// ── 待审暂存（M23 staging 组件复用） ──
const pendingToStaging = (p: CatalogPendingRow): StagingRecord =>
  ({
    id: p.pendingId,
    manifest: { name: p.name, version: p.version },
    owner: p.owner,
    createdAt: p.createdAt,
    requiredGrants: p.requiredGrants as StagingRecord['requiredGrants'],
    hash: '',
    sourceDir: '',
    stagedDir: '',
  }) as unknown as StagingRecord;

async function rejectPending(p: CatalogPendingRow): Promise<void> {
  const ok = await confirmRef.value?.ask({
    title: '拒绝暂存插件？',
    message: `将拒绝插件 "${p.name}" 的安装请求并移除暂存记录。`,
    confirmLabel: '拒绝安装',
    danger: true,
  });
  if (!ok) return;
  busyName.value = p.name;
  error.value = '';
  try {
    await api.rejectPlugin(p.pendingId);
    flash(`已拒绝 "${p.name}"`);
    emit('refresh');
  } catch (e: any) {
    error.value = `拒绝失败: ${e.message}`;
  } finally {
    busyName.value = '';
  }
}

function onReviewDone(kind: 'approved' | 'rejected') {
  reviewRecord.value = null;
  flash(kind === 'approved' ? '暂存插件已批准安装' : '暂存插件已拒绝');
  emit('refresh');
}

// ── 工具视图：schema 弹窗（tools/list 现有形状，零后端改动） ──
const toolDetail = ref<AgentToolInfo | null>(null);

// ── 事件视图（M25 P2：@scope 分组 + 描述声明 + 治理开关 + 承重警示） ──
/** @scope 判定式（前端推断，与 owning 包 JSDoc 同口径）：run = loop/tool/router/llm 前缀 + conversation/steered */
function scopeOfEvent(name: string): 'run' | 'host' {
  if (/^(loop|tool|router|llm)\//.test(name) || name === 'conversation/steered') return 'run';
  return 'host';
}
/** 全量事件清单 = 声明目录（描述/角色/facet）∪ 执行链（零监听器声明事件也呈现） */
const eventView = computed(() => {
  const byEvent = new Map<string, { name: string; scope: 'run' | 'host'; descriptions: EventDescriptionEntry[]; listeners: EventChainEntry['listeners'] }>();
  for (const ev of props.eventChains ?? []) {
    byEvent.set(ev.name, {
      name: ev.name,
      scope: scopeOfEvent(ev.name),
      descriptions: [],
      listeners: ev.listeners,
    });
  }
  for (const d of props.eventDescriptions ?? []) {
    const cur = byEvent.get(d.event) ?? {
      name: d.event,
      scope: scopeOfEvent(d.event),
      descriptions: [],
      listeners: props.eventChainsByEvent?.[d.event] ?? [],
    };
    cur.descriptions.push(d);
    byEvent.set(d.event, cur);
  }
  return [...byEvent.values()].sort((a, b) => a.name.localeCompare(b.name));
});
const runEvents = computed(() => eventView.value.filter((e) => e.scope === 'run'));
const hostEvents = computed(() => eventView.value.filter((e) => e.scope === 'host'));

/** 描述查找：owner::event（执行链渲染角色注释） */
function descOf(owner: string, event: string): EventDescriptionEntry | undefined {
  return (props.eventDescriptions ?? []).find((d) => d.owner === owner && d.event === event);
}
/** 承重行判定（关停破坏插件内部不变量——UI 警示 + 二次确认补偿） */
const BEARING_ROWS = new Set(['ac-session', 'ac-security', 'ac-usage', 'ac-archive', 'ac-plugin-gates', 'ac-event-policy']);
/** 保护行（二次确认特殊文案——不指望反依赖图） */
const PROTECTED_ROWS = new Set(['ac-security', 'ac-plugin-gates']);
function isPolicyDisabled(owner: string, event: string): boolean {
  return (props.eventPolicy?.disabled ?? []).includes(`${owner}::${event}`);
}
/** 治理关停确认弹窗（承重警示 + 保护行特殊文案 + 影响时机） */
const govTarget = ref<{ owner: string; event: string } | null>(null);
const govAck = ref(false);
const govBusy = ref(false);
function openGov(owner: string, event: string): void {
  govAck.value = false;
  govTarget.value = { owner, event };
}
async function applyGov(): Promise<void> {
  const t = govTarget.value;
  if (!t) return;
  govBusy.value = true;
  error.value = '';
  try {
    const next = await api.setEventPolicy(`${t.owner}::${t.event}`, !isPolicyDisabled(t.owner, t.event));
    flash(`治理键已更新（停用集 ${next.disabledList.length} 条）——${next.note ?? ''}`);
    govTarget.value = null;
    emit('refresh');
  } catch (e: any) {
    error.value = `治理写入失败: ${e.message}`;
  } finally {
    govBusy.value = false;
  }
}

// ── 插件市场（M24 P5） ──
const marketQuery = ref('');
const marketResults = ref<MarketResult[]>([]);
const marketLoading = ref(false);
const marketError = ref('');
const installTarget = ref<MarketResult | null>(null);
const installStaging = ref(false);

async function runMarketSearch(): Promise<void> {
  marketLoading.value = true;
  marketError.value = '';
  try {
    const r = await api.marketSearch(marketQuery.value);
    marketResults.value = r.results;
  } catch (e: any) {
    marketError.value = `搜索失败: ${e.message}`;
    marketResults.value = [];
  } finally {
    marketLoading.value = false;
  }
}
void runMarketSearch(); // 打开即取默认结果（agentchat 话题）

/** 安装确认 → 暂存待审（第三方供应链维持人审） */
async function stageFromMarket(): Promise<void> {
  const target = installTarget.value;
  if (!target) return;
  installStaging.value = true;
  marketError.value = '';
  try {
    const r = await api.marketStage(target.spec, 'user');
    flash(`"${target.name}" 已暂存待审（来源锚定 ${r.source.spec ?? target.spec}）——请到「目录 · 插件 · 本地」组审查`);
    installTarget.value = null;
    tab.value = 'catalog';
    view.value = 'plugins';
    emit('refresh');
  } catch (e: any) {
    marketError.value = `暂存失败: ${e.message}`;
  } finally {
    installStaging.value = false;
  }
}

const SOURCE_LABELS: Record<string, string> = {
  npm: 'npm',
  github: 'github',
};
</script>

<template>
  <div class="plugin-library">
    <!-- 安全模式横幅（M23 L8：动态插件本次全部未装载） -->
    <div v-if="safeMode" class="pl-safemode">
      安全模式生效中——动态插件本次全部未装载（AGENTCHAT_SAFE_MODE 或 .safe-mode 标记）；yml 装配行不受影响。删除数据根下的 .safe-mode 文件并重启可恢复。
    </div>

    <!-- ══ 页签：目录 | 插件市场（M24 P4 IA） ══ -->
    <div class="pl-head">
      <div class="pl-tabs">
        <button class="pl-tab" :class="{ active: tab === 'catalog' }" @click="tab = 'catalog'">目录</button>
        <button class="pl-tab" :class="{ active: tab === 'market' }" @click="tab = 'market'">插件市场</button>
      </div>
      <button class="pl-refresh" title="刷新插件库" @click="emit('refresh')"><Icon name="refresh-cw" :size="13" />刷新</button>
    </div>
    <div v-if="success" class="pl-success">{{ success }}</div>
    <div v-if="error" class="pl-error">{{ error }}</div>

    <!-- ══════ 页签 1：目录（左导航三视图 + 右面板） ══════ -->
    <div v-if="tab === 'catalog'" class="pl-catalog">
      <div class="pl-leftnav">
        <button class="pl-navitem" :class="{ active: view === 'plugins' }" @click="view = 'plugins'">
          <span>插件</span><span class="pl-navcount">{{ catalogBuiltin.length + catalogLocal.length + catalogPending.length }}</span>
        </button>
        <button class="pl-navitem" :class="{ active: view === 'tools' }" @click="view = 'tools'">
          <span>工具</span><span class="pl-navcount">{{ tools.length }}</span>
        </button>
        <button class="pl-navitem" :class="{ active: view === 'events' }" @click="view = 'events'">
          <span>事件</span><span class="pl-navcount">{{ (eventChains ?? []).length }}</span>
        </button>
      </div>

      <div class="pl-pane">
        <!-- ▸ 视图：插件（内置组 + 本地组） -->
        <div v-if="view === 'plugins'" class="pl-list">
          <div v-if="patchWarnings.length" class="pl-warn">cordis.patch.yml 告警：{{ patchWarnings.join('；') }}</div>

          <!-- 内置组：包源清单 × 装配交叉（cordis.yml 只答装了什么——目录答有什么可装） -->
          <div class="pl-zone-title" :title="patchFile ? `行偏好文件：${patchFile}` : ''">
            内置（{{ catalogBuiltin.length }}）—— 包源清单（dev 扫描 preview/ac-*/）；装配状态与 cordis registry 交叉
          </div>
          <div v-if="catalogBuiltin.length === 0" class="pl-empty">{{ catalogNote ?? '内置目录为空（生产 bundle 首期不内置清单——仅开发形态可用）' }}</div>
          <div v-for="b in builtinWithExt" :key="'b-' + b.row.name" class="row-card slim" :class="{ inactive: !b.row.assembled }">
            <div class="row-head">
              <span class="row-name">{{ b.row.name }}</span>
              <span v-if="b.row.version" class="row-version">v{{ b.row.version }}</span>
              <span class="row-badge" :class="b.row.assembled ? 'on' : 'off'">
                {{ b.row.assembled ? `已装配 · ${b.row.fibers} fiber` : '未装配' }}
              </span>
              <span v-if="patchDisabled(b.row.name)" class="row-badge off" title="行偏好已停用该行（cordis.patch.yml；重启后行不再装载）">偏好停用</span>
            </div>
            <div class="row-desc">{{ b.row.description ?? '（行包无描述）' }}</div>
            <div class="row-actions">
              <button
                v-if="b.ext"
                class="pl-btn" title="配置全局默认层（config/set → settings.<configNs>；Agent 层覆盖）"
                @click="configEntry = b.ext!"
              >配置</button>
              <label
                v-if="canPatch(b.row)"
                class="pl-patch-toggle"
                :title="patchDisabled(b.row.name) ? '停用中：重启后该行不再装载（写 cordis.patch.yml）' : '启用中：行正常装载（cordis.patch.yml 无停用条目）'"
                @click.stop
              >
                <input
                  type="checkbox"
                  :checked="!patchDisabled(b.row.name)"
                  :disabled="busyName === b.row.name"
                  @change="toggleRowPatch(b.row, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ busyName === b.row.name ? '写入中…' : '启用' }}</span>
              </label>
              <span v-else-if="!b.row.assembled" class="row-meta-inline">装配 = 编辑 cordis.yml</span>
            </div>
          </div>

          <!-- 本地组：registry ∪ devScan ∪ 会话装载（待审暂存并入徽章态） -->
          <div class="pl-zone-title">
            本地（{{ catalogLocal.length + catalogPending.length }}）—— 扫描 &lt;数据根&gt;/plugins/（安装态 ∪ 开发面 ∪ 会话装载）
          </div>
          <div class="pl-dev-hint">
            开发目录布局：<code>{{ root ?? '<数据根>' }}/plugins/&lt;agentId&gt;/&lt;name&gt;/</code>（含 manifest.json + 入口）
          </div>

          <!-- 待审（徽章态；市场/发布暂存在此人审） -->
          <div v-for="p in catalogPending" :key="'p-' + p.pendingId" class="row-card slim">
            <div class="row-head">
              <span class="row-name">{{ p.name }}</span>
              <span class="row-version">v{{ p.version }}</span>
              <span class="row-badge wait" title="暂存待人审">待审</span>
              <span class="row-meta-inline">owner: {{ p.owner }}</span>
            </div>
            <div class="row-desc">暂存待人审——安装前可查看全部文件（只读代理）与内容哈希</div>
            <div class="row-actions">
              <button class="pl-btn" :disabled="busyName === p.name" @click="reviewRecord = pendingToStaging(p)">审查文件与授予</button>
              <button class="pl-btn danger" :disabled="busyName === p.name" @click="rejectPending(p)">拒绝</button>
            </div>
          </div>

          <!-- 本地行（六态徽章 + 动作） -->
          <div v-if="catalogLocal.length === 0 && catalogPending.length === 0" class="pl-empty">暂无本地插件（安装 / 开发 / 会话装载均空）</div>
          <div v-for="l in catalogLocal" :key="'l-' + l.name" class="row-card slim">
            <div class="row-head">
              <span class="row-name">{{ l.name }}</span>
              <span v-if="l.version" class="row-version">v{{ l.version }}</span>
              <span class="row-badge" :class="STATE_LABELS[l.state]?.cls" :title="STATE_LABELS[l.state]?.title">
                {{ STATE_LABELS[l.state]?.text ?? l.state }}
              </span>
              <span v-if="l.owner" class="row-meta-inline" title="归属 Agent（开发/安装者）">owner: {{ l.owner }}</span>
              <span v-if="l.sessionOnly" class="row-badge session" title="会话级装载（重启即失）">会话级</span>
              <span v-if="l.uiNonIsolated" class="row-badge auto" title="M23 F7：携带非隔离 UI（可读会话流/以用户身份调 RPC）">非隔离 UI</span>
            </div>
            <div class="row-desc">
              {{ l.description ?? l.dir ?? '' }}
              <span v-if="l.state === 'failed' && l.error" class="pl-fail-note" :title="l.error">（{{ l.error.slice(0, 80) }}）</span>
              <span v-if="l.state === 'skipped' && l.reason" class="pl-fail-note">（{{ l.reason }}）</span>
            </div>
            <div class="row-actions">
              <template v-if="l.state === 'dev'">
                <button class="pl-btn" :disabled="busyName === l.name" @click="registerLocal(l)">装载</button>
                <button class="pl-btn" :disabled="busyName === l.name" @click="stageLocal(l)">暂存发布</button>
              </template>
              <template v-else-if="l.state === 'loaded'">
                <button class="pl-btn" :disabled="busyName === l.name" @click="unloadLocal(l)">卸载装载</button>
                <button class="pl-btn danger" :disabled="busyName === l.name" @click="uninstallLocal(l)">永久卸载</button>
              </template>
              <template v-else-if="l.state === 'installed' || l.state === 'failed' || l.state === 'skipped'">
                <button class="pl-btn danger" :disabled="busyName === l.name" @click="uninstallLocal(l)">永久卸载</button>
              </template>
            </div>
          </div>
        </div>

        <!-- ▸ 视图：工具（仅 schema 查看；可配置项已移至所属插件卡片） -->
        <div v-else-if="view === 'tools'" class="pl-list">
          <div class="pl-zone-title">工具目录（{{ tools.length }}）—— schema 查看；启停/暴露在 Agent「装配 · 工具」视图</div>
          <div v-if="tools.length === 0" class="pl-empty">暂无工具</div>
          <div v-for="t in tools" :key="'tool-' + t.name" class="row-card slim click" @click="toolDetail = t">
            <div class="row-head">
              <span class="row-name">{{ t.label || t.name }}</span>
              <span class="ext-id-badge">{{ t.name }}</span>
              <span v-for="r in t.requires ?? []" :key="r" class="row-badge dim" :title="`能力门禁标签（AND）`">{{ r }}</span>
              <span class="pl-schema-hint">schema →</span>
            </div>
            <div class="row-desc">{{ t.description }}</div>
          </div>
        </div>

        <!-- ▸ 视图：事件（@scope 分组 + 描述声明 + 治理开关——M25 P2） -->
        <div v-else class="pl-list">
          <div class="pl-zone-title">
            事件清单（{{ runEvents.length }} run + {{ hostEvents.length }} host）——
            全量以声明目录为准；每行开关 = 进程级治理（owner::event）
          </div>

          <div class="evt-scope-label run">@scope run · 发生在某 Agent 执行上下文内（可 per-Agent 门控：agentGate）</div>
          <div v-if="runEvents.length === 0" class="pl-empty">暂无 run 域事件</div>
          <div v-for="ev in runEvents" :key="'ev-' + ev.name" class="evt-card">
            <div class="evt-head">
              <span class="evt-name">{{ ev.name }}</span>
              <span v-if="(ev.listeners ?? []).some((l) => l.prepend)" class="evt-pre-badge">prepend 在场</span>
              <button
                class="evt-gov"
                :class="{ off: ev.listeners?.length ? ev.listeners.every((l) => isPolicyDisabled(l.owner, ev.name)) : false }"
                title="治理开关：owner::event 停用集（写 config events.disabled）"
                @click="openGov(ev.listeners?.[0]?.owner ?? '(anonymous)', ev.name)"
              >治理</button>
            </div>
            <div v-if="ev.descriptions.length" class="evt-desc">{{ ev.descriptions[0].description }}</div>
            <div class="evt-chain">
              <template v-for="(l, i) in ev.listeners" :key="i">
                <span v-if="i > 0" class="evt-arrow">→</span>
                <span
                  class="evt-listener"
                  :class="{ dim: isPolicyDisabled(l.owner, ev.name), prepend: l.prepend }"
                  :title="descOf(l.owner, ev.name)?.role ?? (l.prepend ? 'prepend：插队到链首' : '')"
                >
                  {{ l.owner }}{{ l.prepend ? ' ⏫' : '' }}
                  <span v-if="descOf(l.owner, ev.name)?.role" class="evt-why">{{ descOf(l.owner, ev.name)!.role }}</span>
                  <span v-if="isPolicyDisabled(l.owner, ev.name)" class="evt-why">已停用 · 重启生效</span>
                </span>
                <button
                  v-if="!isPolicyDisabled(l.owner, ev.name)"
                  class="evt-gov mini"
                  title="关停该监听器（owner::event 进程级治理键）"
                  @click="openGov(l.owner, ev.name)"
                >×</button>
              </template>
              <span v-if="!ev.listeners?.length" class="evt-note-inline">（零监听器——声明目录条目）</span>
            </div>
          </div>

          <div class="evt-scope-label host">@scope host · 宿主/进程生命周期（仅治理面——不可 per-Agent 门控）</div>
          <div v-if="hostEvents.length === 0" class="pl-empty">暂无 host 域事件</div>
          <div v-for="ev in hostEvents" :key="'evh-' + ev.name" class="evt-card">
            <div class="evt-head">
              <span class="evt-name">{{ ev.name }}</span>
              <button
                class="evt-gov"
                :class="{ off: ev.listeners?.length ? ev.listeners.every((l) => isPolicyDisabled(l.owner, ev.name)) : false }"
                title="治理开关：owner::event 停用集"
                @click="openGov(ev.listeners?.[0]?.owner ?? '(anonymous)', ev.name)"
              >治理</button>
            </div>
            <div v-if="ev.descriptions.length" class="evt-desc">{{ ev.descriptions[0].description }}</div>
            <div class="evt-chain">
              <template v-for="(l, i) in ev.listeners" :key="i">
                <span v-if="i > 0" class="evt-arrow">→</span>
                <span class="evt-listener" :class="{ dim: isPolicyDisabled(l.owner, ev.name) }">{{ l.owner }}</span>
                <button
                  v-if="!isPolicyDisabled(l.owner, ev.name)"
                  class="evt-gov mini"
                  @click="openGov(l.owner, ev.name)"
                >×</button>
              </template>
              <span v-if="!ev.listeners?.length" class="evt-note-inline">（零监听器——声明目录条目）</span>
            </div>
          </div>

          <div class="pl-anno">
            治理键 = <code>owner::event</code>（owner 原文；停用集存 config <code>events.disabled</code>）。生效时机：注册期吞注册 + boot 末清扫——已注册条目需重启进程（yml 行）或重载插件。承重半边关停可破坏插件内部不变量（session 桶一致性、archive 三闸、供应链防线）——关停前看清角色注释。机械上不做监听器间依赖分析（数据流不可见）。
          </div>
        </div>
      </div>
    </div>

    <!-- ══════ 页签 2：插件市场（M24 P5） ══════ -->
    <div v-else class="pl-list">
      <div class="mkt-search">
        <input
          v-model="marketQuery"
          class="mkt-input"
          type="search"
          placeholder="搜索 npm / github 话题（如 agentchat weather、pdf reader）"
          @keyup.enter="runMarketSearch"
        />
        <button class="pl-btn primary" :disabled="marketLoading" @click="runMarketSearch">{{ marketLoading ? '搜索中…' : '搜索' }}</button>
      </div>
      <div v-if="marketError" class="pl-error">{{ marketError }}</div>
      <div v-if="!marketLoading && marketResults.length === 0" class="pl-empty">无搜索结果（第三方供应链维持人审——安装即暂存待审）</div>
      <div v-for="(r, i) in marketResults" :key="'m-' + i" class="row-card slim">
        <div class="row-head">
          <span class="row-name">{{ r.name }}</span>
          <span v-if="r.version" class="row-version">v{{ r.version }}</span>
          <span class="row-badge dim">{{ SOURCE_LABELS[r.source] ?? r.source }}</span>
          <span v-if="r.downloads !== undefined" class="row-meta-inline">↓ {{ r.downloads }}/周</span>
          <span v-if="r.stars !== undefined" class="row-meta-inline">★ {{ r.stars }}</span>
        </div>
        <div class="row-desc">{{ r.description ?? '（无描述）' }}</div>
        <div class="row-actions">
          <a v-if="r.url" class="pl-link" :href="r.url" target="_blank" rel="noreferrer">来源</a>
          <button class="pl-btn primary" @click="installTarget = r">安装</button>
        </div>
      </div>
      <div class="pl-anno">安装流：第三方来源 = 供应链人审（M23 B2 裁决维持）——安装 → <b>暂存</b>进入「目录 · 插件 · 本地」组（待审徽章 + 审查文件弹窗：只读文件树 / 哈希 / 权限快照 / 来源锚定）→ 人审批准 → 安装装载。与 Agent 自开发免审流（install_plugin）分立。</div>
    </div>

    <!-- 配置弹窗（全局默认层实例——插件库卡片专用） -->
    <ExtensionSettingsModal
      :entry="configEntry"
      mode="global"
      @close="configEntry = null"
      @saved="emit('refresh')"
    />

    <!-- 工具 schema 弹窗 -->
    <Modal :visible="!!toolDetail" :title="toolDetail ? (toolDetail.label || toolDetail.name) + ' · Tool Schema' : ''" :width="520" :z-index="1200" @close="toolDetail = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ toolDetail?.description }}</div>
        <pre class="pl-schema">{{ JSON.stringify({ name: toolDetail?.name, description: toolDetail?.description, requires: toolDetail?.requires ?? [] }, null, 2) }}</pre>
        <div class="pl-anno">形状 = tools/list RPC 现有返回（parameters schema 见下）；requires 标签态与调用方能力集交叉（base ∪ tags ∪ agent:&lt;id&gt;）。</div>
        <pre class="pl-schema">{{ JSON.stringify((toolDetail as any)?.parameters ?? {}, null, 2) }}</pre>
      </div>
      <template #footer>
        <Button variant="ghost" @click="toolDetail = null">关闭</Button>
      </template>
    </Modal>

    <!-- 市场安装确认弹窗（来源与权限声明 + ui 高亮） -->
    <Modal :visible="!!installTarget" :title="installTarget ? `安装 ${installTarget.name}${installTarget.version ? ' ' + installTarget.version : ''}？` : ''" :width="460" :z-index="1250" @close="installTarget = null">
      <div class="ext-modal-body" v-if="installTarget">
        <div class="mkt-warn">
          来源：<code>{{ installTarget.source }}</code>（第三方供应链）· 定位 <code>{{ installTarget.spec }}</code><br />
          第三方来源经<strong>暂存 → 人审 → 安装</strong>（与 Agent 自开发免审流分立）：安装将把包下载进暂存区并在「目录 · 插件 · 本地」生成待审条目；人审可查看全部文件（只读代理）与内容哈希。声明权限以暂存 manifest 快照为准（ui 权限 = 浏览器会话上下文执行，将高亮提示）。
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="installTarget = null">取消</Button>
        <Button variant="primary" :disabled="installStaging" @click="stageFromMarket">{{ installStaging ? '下载暂存中…' : '暂存并待审' }}</Button>
      </template>
    </Modal>

    <!-- 治理关停确认弹窗（承重警示 + 保护行特殊文案 + 影响时机——M25 P2） -->
    <Modal
      :visible="!!govTarget"
      :title="govTarget ? `关停 ${govTarget.owner} 的 ${govTarget.event} 监听？` : ''"
      :width="460"
      :z-index="1280"
      @close="govTarget = null"
    >
      <div class="ext-modal-body" v-if="govTarget">
        <div class="mkt-warn">
          <template v-if="PROTECTED_ROWS.has(govTarget.owner)">
            <strong>⚠ 保护行：</strong>{{ govTarget.owner }} 承担安全防线（门禁/沙箱/供应链 gate）。关停后<strong>全部 Agent</strong> 失去该防线——自担风险。
          </template>
          <template v-else-if="BEARING_ROWS.has(govTarget.owner)">
            <strong>⚠ 承重警示：</strong>该监听器承担插件内部不变量（如会话桶一致性 / 用量记账）。关停可破坏对应功能。
          </template>
          <template v-else>
            治理键 <code>{{ govTarget.owner }}::{{ govTarget.event }}</code>
          </template>
          <br /><br />
          生效时机：注册期——已注册条目需重启进程（yml 行）或重载插件。吞注册 ≠ veto：剩余监听器自动构链照常跑。
        </div>
        <label class="evt-gov-ack" v-if="PROTECTED_ROWS.has(govTarget.owner) || BEARING_ROWS.has(govTarget.owner)">
          <input v-model="govAck" type="checkbox" />
          <span>我了解关停后果（{{ BEARING_ROWS.has(govTarget.owner) ? '承重行' : '保护行' }}），自担风险</span>
        </label>
      </div>
      <template #footer>
        <Button variant="ghost" @click="govTarget = null">取消</Button>
        <Button
          variant="danger"
          :disabled="govBusy || ((PROTECTED_ROWS.has(govTarget?.owner ?? '') || BEARING_ROWS.has(govTarget?.owner ?? '')) && !govAck)"
          @click="applyGov"
        >{{ govBusy ? '写入中…' : '确认关停' }}</Button>
      </template>
    </Modal>

    <!-- 暂存人审弹窗（M23 组件复用） -->
    <StagingReviewModal
      :record="reviewRecord"
      :permissions="permissions"
      @close="reviewRecord = null"
      @done="onReviewDone"
    />
    <ConfirmDialog ref="confirmRef" />
  </div>
</template>

<style scoped>
.plugin-library { display: flex; flex-direction: column; gap: 10px; }
.pl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pl-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.pl-tab {
  padding: 7px 14px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.pl-tab:hover { color: var(--text-1); background: var(--bg-hover); }
.pl-tab.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 500; }
.pl-refresh {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
  border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer;
}
.pl-refresh:hover { background: var(--bg-hover); color: var(--text-1); }
.pl-success { padding: 6px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--ok) 10%, transparent); color: var(--ok); font-size: 12px; }
.pl-error { padding: 6px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); font-size: 12px; }
.pl-safemode {
  padding: 8px 12px; border-radius: var(--r-md); font-size: 12px; line-height: 1.5;
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
}
.pl-warn { padding: 5px 10px; border-radius: var(--r-sm); font-size: 11px; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); word-break: break-all; }

/* 目录布局：左导航 + 右面板 */
.pl-catalog { display: flex; gap: 14px; align-items: flex-start; min-height: 0; }
.pl-leftnav { width: 128px; flex: none; display: flex; flex-direction: column; gap: 3px; }
.pl-navitem {
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  padding: 7px 11px; border-radius: var(--r-md); border: 1px solid transparent;
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.pl-navitem:hover { background: var(--bg-hover); }
.pl-navitem.active { background: var(--bg-surface); color: var(--text-1); font-weight: 500; border-color: var(--line-strong); }
.pl-navcount { font-size: 10px; color: var(--text-3); background: var(--bg-hover); padding: 0 6px; border-radius: var(--r-full); }
.pl-pane { flex: 1; min-width: 0; }
.pl-list { display: flex; flex-direction: column; gap: 8px; }
.pl-empty { text-align: center; padding: 18px; color: var(--text-3); font-size: 12px; }
.pl-zone-title {
  margin-top: 6px; padding: 3px 0; font-size: 11px; color: var(--text-3);
  border-bottom: 1px dashed var(--line);
}
.pl-zone-title:first-child { margin-top: 0; }
.pl-dev-hint { font-size: 11px; color: var(--text-3); word-break: break-all; }
.pl-dev-hint code { font-family: var(--font-mono); }
.pl-anno { font-size: 11px; color: var(--text-3); line-height: 1.7; margin-top: 6px; }
.pl-fail-note { color: var(--err); font-size: 11px; }
.pl-link { font-size: 11px; color: var(--primary); text-decoration: none; }
.pl-link:hover { text-decoration: underline; }
.pl-schema-hint { font-size: 11px; color: var(--primary); margin-left: auto; }

.pl-btn {
  padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.pl-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.pl-btn.danger { color: var(--err); }
.pl-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--err) 10%, transparent); }
.pl-btn.primary { color: var(--primary); border-color: color-mix(in srgb, var(--primary) 45%, transparent); }
.pl-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 10%, transparent); }
.pl-btn:disabled { opacity: .5; cursor: not-allowed; }

/* 行卡片 */
.row-card {
  display: flex; flex-direction: column; gap: 5px;
  padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
}
.row-card.slim { padding: 6px 10px; gap: 3px; }
.row-card.click { cursor: pointer; }
.row-card.click:hover { border-color: color-mix(in srgb, var(--primary) 40%, transparent); }
.row-card.inactive { opacity: .6; }
.row-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.row-name { font-size: 12px; font-weight: 600; color: var(--text-1); }
.row-version { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.row-desc { font-size: 11px; color: var(--text-3); }
.row-actions { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
.row-meta-inline { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
.row-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
  font-family: var(--font-mono); color: var(--text-3); background: var(--bg-hover);
}
.row-badge.on { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.row-badge.off { color: var(--text-3); background: var(--bg-hover); }
.row-badge.wait { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
.row-badge.fail { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); }
.row-badge.fuse { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.row-badge.dyn { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
.row-badge.auto { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.row-badge.session { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.row-badge.dim { color: var(--text-3); background: var(--bg-hover); }
.pl-patch-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text-2); cursor: pointer; user-select: none;
}
.pl-patch-toggle input { accent-color: var(--primary); cursor: pointer; }
.pl-patch-toggle input:disabled { cursor: wait; opacity: .6; }
.ext-id-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px;
  font-family: var(--font-mono); color: var(--text-3); background: var(--bg-hover); white-space: nowrap;
}

/* 事件视图（M25 P2：@scope 分组 + 治理） */
.evt-scope-label {
  margin-top: 12px; margin-bottom: 6px;
  font-family: var(--font-mono); font-size: 10.5px; color: var(--primary);
  display: flex; gap: 8px; align-items: center;
}
.evt-scope-label.host { color: var(--warn); }
.evt-card {
  border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
  padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px;
}
.evt-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.evt-name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-1); }
.evt-pre-badge { font-size: 10px; color: var(--warn); }
.evt-desc { font-size: 11.5px; color: var(--text-2); }
.evt-chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.evt-listener {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  background: var(--bg-hover); border: 1px solid var(--line); border-radius: 4px; padding: 1px 7px;
}
.evt-listener.prepend { color: var(--primary); }
.evt-listener.dim { opacity: .45; text-decoration: line-through; }
.evt-listener .evt-why { color: var(--text-3); font-size: 10px; }
.evt-arrow { color: var(--text-3); font-size: 11px; }
.evt-note-inline { font-size: 11px; color: var(--text-3); }
.evt-gov {
  margin-left: auto; padding: 1px 9px; border: 1px solid var(--line-strong); border-radius: var(--r-full);
  background: transparent; color: var(--text-2); font-size: 10px; cursor: pointer;
}
.evt-gov:hover { border-color: var(--err); color: var(--err); }
.evt-gov.off { color: var(--err); border-color: color-mix(in srgb, var(--err) 45%, transparent); }
.evt-gov.mini {
  margin-left: 0; padding: 0 6px; border: none; color: var(--text-3);
  font-size: 12px; line-height: 1;
}
.evt-gov.mini:hover { color: var(--err); }
.evt-gov-ack {
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2);
  padding: 4px 0;
}
.evt-gov-ack input { accent-color: var(--primary); }

/* 旧执行链行（兼容保留） */
.pl-event-row {
  display: flex; align-items: baseline; gap: 8px; padding: 3px 0;
  font-family: var(--font-mono); font-size: 10px; word-break: break-all;
}
.pl-event-name { color: var(--text-2); white-space: nowrap; }
.pl-event-chain { color: var(--text-3); display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
.pl-event-arrow { color: var(--text-3); }
.pl-event-owner { color: var(--text-2); }
.pl-event-owner.prepend { color: var(--primary); }

/* 市场页签 */
.mkt-search { display: flex; gap: 8px; }
.mkt-input {
  flex: 1; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: var(--bg-surface); color: var(--text-1); font-size: 12px; outline: none;
}
.mkt-input:focus { border-color: var(--primary); }
.mkt-warn {
  font-size: 12px; color: var(--text-2); line-height: 1.75; padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  border-radius: var(--r-md);
}
.mkt-warn code { font-family: var(--font-mono); font-size: 11px; color: var(--text-1); }

/* 弹窗 */
.ext-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.ext-modal-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; }
.pl-schema {
  margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg-base); color: var(--text-2);
  font-family: var(--font-mono); font-size: 11px; line-height: 1.6;
  overflow: auto; white-space: pre-wrap; word-break: break-all;
}
</style>
