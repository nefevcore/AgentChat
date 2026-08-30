<script setup lang="ts">
// ============================================================
// PluginLibraryPane.vue —— 插件库（M24 P4 目录信息架构重构）
//   两页签「目录 | 插件市场」（M23 四页签退役——行卡片、四态徽章、执行链、
//   安全模式横幅等已落地组件原样搬入目录视图）：
//     · 目录 = 左导航（插件 / 工具 / 事件 三视图）+ 右面板（独立滚动——
//       2026-08-30 起滚动收口在右侧清单区，左导航/页签头不随滚）
//       - 插件视图：内置组卡片（Agent 清单同风格：名称/版本/可配置徽章 +
//         右侧红绿装配 toggle；点击卡片弹配置弹窗）+ 本地组 + 待审
//       - 工具视图：requiredTags 徽章 + 参数表格化详情弹窗（非双 JSON 块）
//       - 事件视图：树状结构（run/host 两根 → 事件 → 监听器叶节点，
//         SessionList 同款交互；叶节点带注册时自述 description）
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
  /** 目录装载失败（RPC 面不可用——行停用级联下线 ac-web-api 等）；
   *  非空时清单区呈现错误横幅 + 手工急救指引（而非误导性"空清单"） */
  catalogError?: string;
  /** 数据根（plugin/dev-scan 透出；dev 路径提示用） */
  root?: string;
  session: PluginInfo[];
  permissions: PluginPermissionsView | null;
  /** cordis 装配行清单（plugin/rows；行偏好开关锚点 entryId） */
  rows: AssemblyRowInfo[];
  /** 扩展目录（plugin/extension-catalog；配置弹窗数据源） */
  extensions: ExtensionEntry[];
  /** 工具目录（tools/list 只读；工具视图详情弹窗） */
  tools: AgentToolInfo[];
  /** 事件执行链（events/listeners；事件视图底座——listeners 附注册自述） */
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

// ── 行偏好层 cordis.patch.yml（内置组装配 toggle；锚点 = yml 行 entryId） ──
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
    // RPC 面自毁检测：级联闭包含 ac-web-api（或本行即 RPC 面行）→ 确认后
    // 本设置界面的后端全部下线，UI 内无法恢复——确认弹窗必须给出手工急救
    // 路径（2026-08-30 事故：停用 ac-agent-loop 级联 router→conversation→
    // web-api，设置面板静默变空清单且无法自救）
    const killsRpcFace =
      b.name === 'ac-web-api' ||
      b.name === 'ac-web-server' ||
      cascades.includes('ac-web-api') ||
      cascades.includes('ac-web-server');
    if (isProtected || killsRpcFace || cascades.length > 0) {
      const ok = await confirmRef.value?.ask({
        title: killsRpcFace
          ? `停用 ${b.name} 将关闭设置界面后端？`
          : isProtected
            ? `停用保护行 ${b.name}？`
            : `停用 ${b.name}？`,
        message: killsRpcFace
          ? `级联断链 ${cascades.length} 个注入方（${cascades.join('、')}），其中包含 ac-web-api——确认后本设置界面的后端 RPC 大部分下线（目录清单消失，出现急救横幅）。恢复路径：目录页急救区重新启用（热恢复），或编辑数据根下 cordis.patch.yml 删除 id 为 "${id}" 的条目后重启进程。`
          : isProtected
            ? `${b.name} 是保护行（安全防线）。停用后全部 Agent 失去对应防线；级联断链：${cascades.length > 0 ? cascades.join('、') : '（无下游注入方）'}。自担风险。`
            : `该行为承重行——停用将级联断链 ${cascades.length} 个注入方：${cascades.join('、')}。（声明式 inject 依赖；ctx.get 软依赖不在图内。）`,
        confirmLabel: killsRpcFace
          ? '停用（后端面将大幅下线，自担风险）'
          : isProtected
            ? '停用保护行（自担风险）'
            : '停用（级联断链）',
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
    // 提示文案按用户视角写清两件事：做了什么（装配/停用哪个行）+ 何时生效
    if (result.state === 'hot') {
      flash(on
        ? `已装配「${b.name}」——立即生效，重启后保持`
        : `已停用「${b.name}」——立即生效，重启后保持停用`);
    } else if (result.state === 'no-include-row') {
      flash(`已记录${on ? '装配' : '停用'}「${b.name}」——当前进程非配置驱动启动，重启后生效`);
    } else {
      flash(`已记录${on ? '装配' : '停用'}「${b.name}」——重启后生效`);
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
function openCardConfig(b: { row: CatalogBuiltinRow; ext?: ExtensionEntry }): void {
  if (b.ext) configEntry.value = b.ext;
}

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

// ── 工具视图：详情弹窗（参数表格化——JSON Schema object 形状） ──
const toolDetail = ref<AgentToolInfo | null>(null);
interface ToolParamRow {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description?: string;
  enumVals?: string[];
}
/** 标准 JSON Schema object → 参数表行；非标准形状返回 null（原文回落） */
const toolParamRows = computed<ToolParamRow[] | null>(() => {
  const p = toolDetail.value?.parameters as Record<string, unknown> | undefined;
  if (!p || p.type !== 'object' || typeof p.properties !== 'object' || p.properties === null) return null;
  const defs = p.properties as Record<string, Record<string, unknown>>;
  const req = new Set(
    Array.isArray(p.required) ? (p.required as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  );
  return Object.entries(defs).map(([name, def]) => ({
    name,
    type: typeof def?.type === 'string' ? def.type : '?',
    required: req.has(name),
    default: def?.default === undefined ? undefined : JSON.stringify(def.default),
    description: typeof def?.description === 'string' ? def.description : undefined,
    enumVals: Array.isArray(def?.enum) ? (def.enum as unknown[]).map(String) : undefined,
  }));
});

// ── 事件视图（M25 P2：树状结构 + 描述 + 治理开关） ──
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

/** 树开合（SessionList 同款：scope 根默认展开；事件节点默认收拢——点开看监听器） */
const evtCollapsed = ref(new Set<string>());
function toggleEvtNode(key: string): void {
  const next = new Set(evtCollapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  evtCollapsed.value = next;
}
const EVT_SCOPE_ROOTS = [
  { key: '@run', label: 'run', hint: '发生在某 Agent 执行上下文内（可 per-Agent 门控：agentGate）', list: runEvents },
  { key: '@host', label: 'host', hint: '宿主/进程生命周期（仅治理面——不可 per-Agent 门控）', list: hostEvents },
];

/** 描述查找：owner::event（声明目录角色注释——注册自述缺位时兜底） */
function descOf(owner: string, event: string): EventDescriptionEntry | undefined {
  return (props.eventDescriptions ?? []).find((d) => d.owner === owner && d.event === event);
}
/** 叶节点描述：注册时自述（events/listeners 附带）优先，声明目录 role 兜底 */
function listenerDesc(l: { owner: string; description?: string }, event: string): string {
  return l.description ?? descOf(l.owner, event)?.role ?? '';
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

/** 急救重启用（后端 RPC 面下线时的自救通道——行偏好 RPC 住在
 *  ac-plugin-registry 行，不在 agent-loop 级联闭包内；热通道反向恢复整棵树） */
async function rescueReenable(p: PluginPatchEntry): Promise<void> {
  busyName.value = p.id;
  error.value = '';
  try {
    const result = await api.setPluginPatch(p.id, false);
    patches.value = result.patches;
    if (result.state === 'hot') {
      flash(`已重新启用「${p.id}」——立即生效，后端面应随级联恢复`);
    } else {
      flash(`已清除「${p.id}」停用条目——重启进程后恢复`);
    }
    emit('refresh');
  } catch (e: any) {
    error.value = `急救启用失败: ${e.message}`;
  } finally {
    busyName.value = '';
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
void runMarketSearch(); // 打开即取默认结果（keywords:agentchat-plugin）

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

    <!-- ══════ 页签 1：目录（左导航三视图 + 右面板——右面板独立滚动） ══════ -->
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
        <!-- ▸ 视图：插件（内置组 Agent 清单风格卡片 + 本地组 + 待审） -->
        <div v-if="view === 'plugins'" class="pl-list">
          <div v-if="patchWarnings.length" class="pl-warn">cordis.patch.yml 告警：{{ patchWarnings.join('；') }}</div>

          <!-- 内置组：包源清单 × 装配交叉（Agent 清单同款行风格；toggle = 装配开关） -->
          <div class="pl-zone-title" :title="patchFile ? `行偏好文件：${patchFile}` : ''">
            内置（{{ catalogBuiltin.length }}）—— 包源清单；右侧开关 = 装配（写 cordis.patch.yml，重启生效）
          </div>
          <div v-if="catalogBuiltin.length === 0 && catalogError" class="pl-error">
            插件目录加载失败：{{ catalogError }}
            ——常见原因：行停用级联下线了设置后端（ac-web-api）。手工恢复：编辑数据根下的 cordis.patch.yml 删除对应停用条目，重启进程。
            <div v-if="patches.some((p) => p.disabled)" class="pl-rescue">
              <div class="pl-rescue-title">急救（行偏好通道独立存活）——重新启用停用行：</div>
              <div v-for="p in patches.filter((x) => x.disabled)" :key="p.id" class="pl-rescue-item">
                <code>{{ p.id }}</code>
                <span class="plugin-state-badge off">停用中</span>
                <button class="pl-btn" :disabled="busyName === p.id" @click="rescueReenable(p)">
                  {{ busyName === p.id ? '启用中…' : '重新启用' }}
                </button>
              </div>
            </div>
          </div>
          <div v-else-if="catalogBuiltin.length === 0" class="pl-empty">{{ catalogNote ?? '内置目录为空（生产 bundle 首期不内置清单——仅开发形态可用）' }}</div>
          <div v-for="b in builtinWithExt" :key="'b-' + b.row.name"
            class="plugin-item"
            :class="{ inactive: !b.row.assembled, clickable: !!b.ext }"
            :title="b.ext ? '点击卡片配置（全局默认层）' : ''"
            @click="openCardConfig(b)"
          >
            <div class="plugin-info">
              <div class="plugin-title-row">
                <span class="plugin-name">{{ b.row.name }}</span>
                <span v-if="b.row.version" class="plugin-version">v{{ b.row.version }}</span>
                <span v-if="b.ext" class="plugin-cfg-badge">⚙ 可配置</span>
                <span v-if="patchDisabled(b.row.name)" class="plugin-state-badge off" title="行偏好已停用（cordis.patch.yml）——重启后该行不再装载">偏好停用</span>
                <span v-else-if="!b.row.assembled" class="plugin-state-badge dim" title="不在当前组合（cordis.yml）——装配 = 编辑 yml">未装配</span>
              </div>
              <div class="plugin-desc">{{ b.row.description ?? '（行包无描述）' }}</div>
            </div>
            <div class="plugin-actions" @click.stop>
              <label
                v-if="canPatch(b.row)"
                class="switch"
                :title="patchDisabled(b.row.name)
                  ? '装配开关（当前停用）：开启 = 立即装载该行（清除 cordis.patch.yml 停用条目）'
                  : '装配开关（当前装载）：关闭 = 立即卸载该行（写入 cordis.patch.yml，重启后保持停用）'"
              >
                <input
                  type="checkbox"
                  :checked="!patchDisabled(b.row.name)"
                  :disabled="busyName === b.row.name"
                  @change="toggleRowPatch(b.row, ($event.target as HTMLInputElement).checked)"
                />
                <span class="switch-track"><span class="switch-dot" /></span>
              </label>
              <span v-else-if="!b.row.assembled" class="plugin-hint">装配 = 编辑 cordis.yml</span>
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
          <div v-for="p in catalogPending" :key="'p-' + p.pendingId" class="plugin-item">
            <div class="plugin-info">
              <div class="plugin-title-row">
                <span class="plugin-name">{{ p.name }}</span>
                <span class="plugin-version">v{{ p.version }}</span>
                <span class="plugin-state-badge wait" title="暂存待人审">待审</span>
                <span class="plugin-meta">owner: {{ p.owner }}</span>
              </div>
              <div class="plugin-desc">暂存待人审——安装前可查看全部文件（只读代理）与内容哈希</div>
            </div>
            <div class="plugin-actions" @click.stop>
              <button class="pl-btn" :disabled="busyName === p.name" @click="reviewRecord = pendingToStaging(p)">审查文件与授予</button>
              <button class="pl-btn danger" :disabled="busyName === p.name" @click="rejectPending(p)">拒绝</button>
            </div>
          </div>

          <!-- 本地行（六态徽章 + 动作） -->
          <div v-if="catalogLocal.length === 0 && catalogPending.length === 0" class="pl-empty">暂无本地插件（安装 / 开发 / 会话装载均空）</div>
          <div v-for="l in catalogLocal" :key="'l-' + l.name" class="plugin-item">
            <div class="plugin-info">
              <div class="plugin-title-row">
                <span class="plugin-name">{{ l.name }}</span>
                <span v-if="l.version" class="plugin-version">v{{ l.version }}</span>
                <span class="plugin-state-badge" :class="STATE_LABELS[l.state]?.cls" :title="STATE_LABELS[l.state]?.title">
                  {{ STATE_LABELS[l.state]?.text ?? l.state }}
                </span>
                <span v-if="l.owner" class="plugin-meta" title="归属 Agent（开发/安装者）">owner: {{ l.owner }}</span>
                <span v-if="l.sessionOnly" class="plugin-state-badge session" title="会话级装载（重启即失）">会话级</span>
                <span v-if="l.uiNonIsolated" class="plugin-state-badge auto" title="M23 F7：携带非隔离 UI（可读会话流/以用户身份调 RPC）">非隔离 UI</span>
              </div>
              <div class="plugin-desc">
                {{ l.description ?? l.dir ?? '' }}
                <span v-if="l.state === 'failed' && l.error" class="pl-fail-note" :title="l.error">（{{ l.error.slice(0, 80) }}）</span>
                <span v-if="l.state === 'skipped' && l.reason" class="pl-fail-note">（{{ l.reason }}）</span>
              </div>
            </div>
            <div class="plugin-actions" @click.stop>
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

        <!-- ▸ 视图：工具（requiredTags 徽章 + 参数表格化弹窗） -->
        <div v-else-if="view === 'tools'" class="pl-list">
          <div class="pl-zone-title">工具目录（{{ tools.length }}）—— 详情看参数表；启停/暴露在 Agent「装配 · 工具」视图</div>
          <div v-if="tools.length === 0" class="pl-empty">暂无工具</div>
          <div v-for="t in tools" :key="'tool-' + t.name" class="plugin-item clickable" @click="toolDetail = t">
            <div class="plugin-info">
              <div class="plugin-title-row">
                <span class="plugin-name">{{ t.label || t.name }}</span>
                <span class="plugin-version">{{ t.name }}</span>
                <span v-for="r in t.requiredTags ?? []" :key="r" class="plugin-state-badge dim" title="能力标签（AND）——调用方能力集须全含才可用">{{ r }}</span>
              </div>
              <div class="plugin-desc">{{ t.description }}</div>
            </div>
            <div class="plugin-actions">
              <span class="plugin-hint">详情 →</span>
            </div>
          </div>
        </div>

        <!-- ▸ 视图：事件（树状：scope 根 → 事件 → 监听器叶节点——SessionList 同款交互） -->
        <div v-else class="pl-list">
          <div class="pl-zone-title">
            事件清单（{{ runEvents.length }} run + {{ hostEvents.length }} host）——
            全量以声明目录为准；叶节点 × = 进程级治理（owner::event）
          </div>

          <div class="evt-tree">
            <template v-for="root in EVT_SCOPE_ROOTS" :key="root.key">
              <div class="evt-scope-node" :class="root.key === '@run' ? 'run' : 'host'" :title="root.hint" @click="toggleEvtNode(root.key)">
                <span class="evt-caret">{{ evtCollapsed.has(root.key) ? '▸' : '▾' }}</span>
                <span class="evt-scope-name">@scope {{ root.label }}</span>
                <span class="evt-scope-count">{{ root.list.value.length }}</span>
              </div>
              <template v-if="!evtCollapsed.has(root.key)">
                <template v-for="ev in root.list.value" :key="root.key + ev.name">
                  <div class="evt-node" @click="toggleEvtNode(ev.name)">
                    <span class="evt-caret">{{ evtCollapsed.has(ev.name) ? '▸' : '▾' }}</span>
                    <span class="evt-node-name">{{ ev.name }}</span>
                    <span class="evt-node-count">{{ ev.listeners?.length ?? 0 }} 监听</span>
                    <span v-if="(ev.listeners ?? []).some((l) => l.prepend)" class="evt-pre-badge" title="链首有 prepend 监听器（插队执行）">prepend</span>
                    <button
                      class="evt-gov"
                      :class="{ off: ev.listeners?.length ? ev.listeners.every((l) => isPolicyDisabled(l.owner, ev.name)) : false }"
                      title="治理开关：owner::event 停用集（写 config events.disabled）"
                      @click.stop="openGov(ev.listeners?.[0]?.owner ?? '(anonymous)', ev.name)"
                    >治理</button>
                  </div>
                  <div v-if="!evtCollapsed.has(ev.name)" class="evt-leaves">
                    <div v-if="ev.descriptions.length" class="evt-node-desc">{{ ev.descriptions[0].description }}</div>
                    <div v-for="(l, i) in ev.listeners" :key="i"
                      class="evt-leaf"
                      :class="{ dim: isPolicyDisabled(l.owner, ev.name) }"
                    >
                      <span class="evt-leaf-owner" :title="`owner: ${l.owner}${l.prepend ? '（prepend）' : ''}`">{{ l.row ?? l.owner }}</span>
                      <span class="evt-leaf-desc">{{ listenerDesc(l, ev.name) }}</span>
                      <span v-if="l.prepend" class="evt-leaf-tag">prepend</span>
                      <span v-if="isPolicyDisabled(l.owner, ev.name)" class="evt-leaf-tag off">已停用 · 重启生效</span>
                      <button
                        v-if="!isPolicyDisabled(l.owner, ev.name)"
                        class="evt-gov mini"
                        title="关停该监听器（owner::event 进程级治理键）"
                        @click.stop="openGov(l.owner, ev.name)"
                      >×</button>
                    </div>
                    <div v-if="!ev.listeners?.length" class="evt-leaf-empty">零监听器——声明目录条目</div>
                  </div>
                </template>
                <div v-if="root.list.value.length === 0" class="pl-empty">暂无 {{ root.label }} 域事件</div>
              </template>
            </template>
          </div>

          <div class="pl-anno">
            治理键 = <code>owner::event</code>（owner 原文；停用集存 config <code>events.disabled</code>）。生效时机：注册期吞注册 + boot 末清扫——已注册条目需重启进程（yml 行）或重载插件。承重半边关停可破坏插件内部不变量（session 桶一致性、archive 三闸、供应链防线）——关停前看清角色注释。机械上不做监听器间依赖分析（数据流不可见）。
          </div>
        </div>
      </div>
    </div>

    <!-- ══════ 页签 2：插件市场（M24 P5） ══════ -->
    <div v-else class="pl-list pl-market">
      <div class="mkt-search">
        <input
          v-model="marketQuery"
          class="mkt-input"
          type="search"
          placeholder="搜索 npm / github（npm keywords:agentchat-plugin / github topic:agentchat-plugin）"
          @keyup.enter="runMarketSearch"
        />
        <button class="pl-btn primary" :disabled="marketLoading" @click="runMarketSearch">{{ marketLoading ? '搜索中…' : '搜索' }}</button>
      </div>
      <div v-if="marketError" class="pl-error">{{ marketError }}</div>
      <div v-if="!marketLoading && marketResults.length === 0" class="pl-empty">无搜索结果（第三方供应链维持人审——安装即暂存待审）</div>
      <div v-for="(r, i) in marketResults" :key="'m-' + i" class="plugin-item">
        <div class="plugin-info">
          <div class="plugin-title-row">
            <span class="plugin-name">{{ r.name }}</span>
            <span v-if="r.version" class="plugin-version">v{{ r.version }}</span>
            <span class="plugin-state-badge dim">{{ SOURCE_LABELS[r.source] ?? r.source }}</span>
          </div>
          <div class="plugin-desc">
            {{ r.description ?? '（无描述）' }}
            <span v-if="r.downloads !== undefined" class="plugin-meta">↓ {{ r.downloads }}/周</span>
            <span v-if="r.stars !== undefined" class="plugin-meta">★ {{ r.stars }}</span>
          </div>
        </div>
        <div class="plugin-actions" @click.stop>
          <a v-if="r.url" class="pl-link" :href="r.url" target="_blank" rel="noreferrer">来源</a>
          <button class="pl-btn primary" @click="installTarget = r">安装</button>
        </div>
      </div>
      <div class="pl-anno">安装流：第三方来源 = 供应链人审（M23 B2 裁决维持）——安装 → <b>暂存</b>进入「目录 · 插件 · 本地」组（待审徽章 + 审查文件弹窗：只读文件树 / 哈希 / 权限快照 / 来源锚定）→ 人审批准 → 安装装载。与 Agent 自开发免审流（install_plugin）分立。</div>
    </div>

    <!-- 配置弹窗（全局默认层实例——插件库卡片专用；enabled 分区 = 行为门控） -->
    <ExtensionSettingsModal
      :entry="configEntry"
      mode="global"
      @close="configEntry = null"
      @saved="emit('refresh')"
    />

    <!-- 工具详情弹窗（头部结构化 + 参数表格；非标准 schema 回落原文） -->
    <Modal :visible="!!toolDetail" :title="toolDetail ? (toolDetail.label || toolDetail.name) + ' · 工具详情' : ''" :width="560" :z-index="1200" @close="toolDetail = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ toolDetail?.description }}</div>
        <div v-if="toolDetail?.requiredTags?.length" class="tool-meta-row">
          <span class="tool-meta-label">能力标签</span>
          <span v-for="r in toolDetail.requiredTags" :key="r" class="plugin-state-badge dim" title="能力标签（AND）——调用方能力集（base ∪ tags ∪ agent:<id>）须全含才可用">{{ r }}</span>
        </div>
        <template v-if="toolParamRows">
          <div class="tool-meta-label">参数（JSON Schema）</div>
          <table class="tool-params">
            <thead>
              <tr><th>参数</th><th>类型</th><th>必填</th><th>默认</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in toolParamRows" :key="p.name">
                <td class="tp-name">{{ p.name }}</td>
                <td class="tp-type">{{ p.type }}<span v-if="p.enumVals" class="tp-enum">（{{ p.enumVals.join(' | ') }}）</span></td>
                <td :class="p.required ? 'tp-req' : ''">{{ p.required ? '必填' : '可选' }}</td>
                <td class="tp-default">{{ p.default ?? '—' }}</td>
                <td class="tp-desc">{{ p.description ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <template v-else>
          <div class="tool-meta-label">参数 Schema（非标准形状，原文呈现）</div>
          <pre class="pl-schema">{{ JSON.stringify(toolDetail?.parameters ?? {}, null, 2) }}</pre>
        </template>
        <div class="pl-anno">「能力标签」与调用方能力集交叉（base ∪ tags ∪ agent:&lt;id&gt;，AND 语义）；「必填」指模型调用时参数必给——两者是不同的门。</div>
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
/* 根：填充高度 + 隐藏外溢——滚动收口在右侧清单区（左导航/页签头固定） */
.plugin-library { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
.pl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
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
.pl-success { padding: 6px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--ok) 10%, transparent); color: var(--ok); font-size: 12px; flex-shrink: 0; }
.pl-error { padding: 6px 10px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); font-size: 12px; flex-shrink: 0; }
/* 急救区（行偏好通道独立存活——RPC 面下线时的 UI 自救） */
.pl-rescue {
  margin-top: 8px; padding-top: 8px;
  border-top: 1px dashed color-mix(in srgb, var(--err) 40%, transparent);
  display: flex; flex-direction: column; gap: 6px;
}
.pl-rescue-title { font-weight: 600; }
.pl-rescue-item { display: flex; align-items: center; gap: 8px; }
.pl-rescue-item code {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-1);
  background: var(--bg-hover); padding: 1px 6px; border-radius: 4px;
}
.pl-safemode {
  padding: 8px 12px; border-radius: var(--r-md); font-size: 12px; line-height: 1.5;
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  flex-shrink: 0;
}
.pl-warn { padding: 5px 10px; border-radius: var(--r-sm); font-size: 11px; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); word-break: break-all; }

/* 目录布局：左导航固定 + 右面板独立滚动 */
.pl-catalog { flex: 1; min-height: 0; display: flex; gap: 14px; align-items: stretch; }
.pl-leftnav { width: 128px; flex: none; display: flex; flex-direction: column; gap: 3px; align-self: flex-start; }
.pl-navitem {
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  padding: 7px 11px; border-radius: var(--r-md); border: 1px solid transparent;
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.pl-navitem:hover { background: var(--bg-hover); }
.pl-navitem.active { background: var(--bg-surface); color: var(--text-1); font-weight: 500; border-color: var(--line-strong); }
.pl-navcount { font-size: 10px; color: var(--text-3); background: var(--bg-hover); padding: 0 6px; border-radius: var(--r-full); }
.pl-pane { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding-right: 2px; }
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

/* 市场页签：整页滚动收口在本区域 */
.pl-market { flex: 1; min-height: 0; overflow-y: auto; }

/* ── 插件卡片（Agent 清单同风格：左信息右动作、hover 主色边框） ── */
.plugin-item {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface);
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.plugin-item.clickable { cursor: pointer; }
.plugin-item.clickable:hover { border-color: var(--primary); }
.plugin-item.inactive { opacity: .6; }
.plugin-item + .plugin-item { margin-top: 0; }
.plugin-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.plugin-title-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.plugin-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.plugin-version { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.plugin-cfg-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
  font-family: var(--font-mono);
  color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.plugin-state-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
  font-family: var(--font-mono); color: var(--text-3); background: var(--bg-hover);
}
.plugin-state-badge.on { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.plugin-state-badge.off { color: var(--text-3); background: var(--bg-hover); }
.plugin-state-badge.wait { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
.plugin-state-badge.fail { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); }
.plugin-state-badge.fuse { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-state-badge.dyn { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
.plugin-state-badge.auto { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-state-badge.session { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-state-badge.dim { color: var(--text-3); background: var(--bg-hover); }
.plugin-meta { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
.plugin-desc {
  font-size: 11px; color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.plugin-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-shrink: 0; }
.plugin-hint { font-size: 10.5px; color: var(--text-3); white-space: nowrap; }

/* ── 红绿装配 toggle（绿 = 装载；红 = 偏好停用） ── */
.switch { display: inline-flex; align-items: center; cursor: pointer; user-select: none; }
.switch input { display: none; }
.switch-track {
  display: inline-block; width: 34px; height: 18px; border-radius: 999px; position: relative;
  background: color-mix(in srgb, var(--err) 55%, transparent);
  transition: background .15s ease;
}
.switch-dot {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: left .15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
}
.switch input:checked + .switch-track { background: color-mix(in srgb, var(--ok) 60%, transparent); }
.switch input:checked + .switch-track .switch-dot { left: 18px; }
.switch input:disabled + .switch-track { opacity: .5; cursor: wait; }

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

/* ── 工具详情弹窗（结构化头部 + 参数表） ── */
.tool-meta-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tool-meta-label { font-size: 11px; letter-spacing: .5px; color: var(--text-3); font-weight: 600; }
.tool-params { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tool-params th {
  text-align: left; padding: 5px 8px; color: var(--text-3); font-weight: 500;
  border-bottom: 1px solid var(--line); white-space: nowrap;
}
.tool-params td { padding: 5px 8px; border-bottom: 1px solid var(--line); color: var(--text-2); vertical-align: top; }
.tool-params tr:last-child td { border-bottom: none; }
.tp-name { font-family: var(--font-mono); color: var(--text-1); white-space: nowrap; }
.tp-type { font-family: var(--font-mono); color: var(--text-3); white-space: nowrap; }
.tp-enum { color: var(--text-3); font-size: 10px; }
.tp-req { color: var(--warn); font-weight: 500; white-space: nowrap; }
.tp-default { font-family: var(--font-mono); color: var(--text-3); white-space: nowrap; }
.tp-desc { line-height: 1.5; }

/* ── 事件视图（树状：scope 根 → 事件 → 监听器叶节点——SessionList 同款行风） ── */
.evt-tree { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.evt-caret { width: 14px; flex: none; color: var(--text-3); font-size: 10px; text-align: center; }
.evt-scope-node {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; margin-top: 6px;
  border-radius: var(--r-md); color: var(--text-2); font-size: 12px; cursor: pointer; user-select: none;
  border: 1px solid transparent;
}
.evt-scope-node:hover { background: var(--bg-hover); border-color: var(--line-strong); }
.evt-scope-name { font-family: var(--font-mono); font-weight: 600; color: var(--text-1); }
.evt-scope-node.run .evt-scope-name { color: var(--primary); }
.evt-scope-node.host .evt-scope-name { color: var(--warn); }
.evt-scope-count {
  font-size: 10px; color: var(--text-3); background: var(--bg-hover);
  padding: 1px 7px; border-radius: 999px; font-family: var(--font-mono);
}
.evt-node {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 22px;
  border-radius: var(--r-md); border: 1px solid transparent; cursor: pointer; user-select: none;
  transition: background var(--dur-fast), border-color var(--dur-fast);
}
.evt-node:hover { background: var(--bg-hover); border-color: var(--line-strong); }
.evt-node-name { font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; color: var(--text-1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.evt-node-count { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); white-space: nowrap; }
.evt-pre-badge { font-size: 10px; color: var(--warn); white-space: nowrap; }
.evt-gov {
  padding: 1px 9px; border: 1px solid var(--line-strong); border-radius: var(--r-full);
  background: transparent; color: var(--text-2); font-size: 10px; cursor: pointer; flex: none;
}
.evt-gov:hover { border-color: var(--err); color: var(--err); }
.evt-gov.off { color: var(--err); border-color: color-mix(in srgb, var(--err) 45%, transparent); }
.evt-gov.mini {
  padding: 0 6px; border: none; color: var(--text-3);
  font-size: 12px; line-height: 1; flex: none;
}
.evt-gov.mini:hover { color: var(--err); }
.evt-leaves { display: flex; flex-direction: column; gap: 2px; padding: 2px 8px 6px 44px; }
.evt-node-desc { font-size: 11px; color: var(--text-2); padding: 2px 0 4px; }
.evt-leaf {
  display: flex; align-items: center; gap: 8px; padding: 3px 8px;
  border-radius: var(--r-sm); background: var(--bg-hover);
}
.evt-leaf.dim .evt-leaf-owner { text-decoration: line-through; opacity: .5; }
.evt-leaf-owner {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-1);
  background: var(--bg-surface); border: 1px solid var(--line); border-radius: 4px;
  padding: 1px 7px; white-space: nowrap; flex: none;
}
.evt-leaf-desc { font-size: 11px; color: var(--text-3); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.evt-leaf-tag {
  font-size: 10px; color: var(--primary); font-family: var(--font-mono); white-space: nowrap; flex: none;
}
.evt-leaf-tag.off { color: var(--err); }
.evt-leaf-empty { font-size: 11px; color: var(--text-3); padding: 2px 0; }
.evt-gov-ack {
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2);
  padding: 4px 0;
}
.evt-gov-ack input { accent-color: var(--primary); }

/* 市场页签 */
.mkt-search { display: flex; gap: 8px; flex-shrink: 0; }
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
