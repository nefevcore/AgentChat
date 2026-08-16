<script setup lang="ts">
// ============================================================
// ExtToolsPane.vue —— 扩展与工具（左右布局，全局/Agent 双模式复用）
// P2：数据源迁移到 AssemblyView / PluginCatalog（单真相源）——
//   · 左侧：插件分组 + 7 种 hook kind + 工具
//   · agent：插件开关写 decl.presets，钩子开关/拖拽写 decl.hooks（清单即启用集），
//            工具开关写 decl.tools（include/exclude 单一意图）；装配启用集合来自 AssemblyView
//   · global：插件/钩子/工具仅只读目录 + 默认配置入口
// ============================================================
import { ref, computed } from 'vue';
import type { HookInfo, AgentToolInfo, PluginInfo, PluginPermissionsView } from '../types';
import { Icon, Modal, Button } from '@/ui';
import NsFieldList from './NsFieldList.vue';

const props = defineProps<{
  mode: 'agent' | 'global';
  /** 钩子目录（kind + 元数据；来自 /api/plugins/catalog 或 assembly.hooks.catalog） */
  hooks: HookInfo[];
  /** 插件目录（权限徽章 / 开关写 decl.presets） */
  plugins: PluginInfo[];
  /** 当前装配声明：{ presets, tools:{include,exclude}, hooks 启用清单 }（global 只读可传 null） */
  decl: {
    presets: string[];
    tools: { include: string[]; exclude: string[] };
    hooks: Record<string, string[]>;
  } | null;
  /** 编辑声明（agent 且非 legacy 只读时提供） */
  onDecl?: (patch: {
    presets?: string[];
    tools?: { include?: string[]; exclude?: string[] };
    hooks?: Record<string, string[]>;
  }) => void;
  /** 工具数据：catalog 全量目录 + enabled（agent 装配快照）+ include/exclude 意图覆盖 */
  tools: { catalog: AgentToolInfo[]; enabled: string[]; include: string[]; exclude: string[] };
  /** 权限词汇表（徽章判定；缺省用契约内建值） */
  permissions?: PluginPermissionsView | null;
  /** agent 能力标签（toolStatus/canAddTool/hasTag 用；global 传空） */
  tags?: string[];
  /** 命名空间 schema（弹窗配置表单） */
  nsSchemas: Record<string, any[]>;
  /** 弹窗配置编辑对象（钩子/工具命名空间配置均写全局） */
  config: Record<string, any>;
  /** agent 路径白名单（security-check 弹窗只读概览用） */
  allowedPaths?: string[];
  /** legacy 旧契约只读标记（保存时由后端归一化迁移） */
  readonly?: boolean;
}>();

const isAgent = computed(() => props.mode === 'agent');
const isEditable = computed(() => isAgent.value && props.readonly !== true && !!props.onDecl);

// ── 权限徽章判定（优先 /api/plugins/permissions，契约缺省兜底） ──
const defaultGranted = computed(() => new Set(props.permissions?.defaultGranted ?? ['fs', 'network']));
const explicitRequired = computed(() => new Set(props.permissions?.explicitRequired ?? ['process', 'shell', 'ui']));
function permissionBadges(p: PluginInfo): Array<{ text: string; cls: string; title: string }> {
  const granted = new Set(p.grantedPermissions ?? []);
  return (p.permissions ?? []).map((perm) => {
    if (defaultGranted.value.has(perm)) {
      return { text: perm, cls: 'default', title: '默认授予' };
    }
    if (granted.has(perm)) {
      return { text: perm, cls: 'granted', title: '已显式授予' };
    }
    return { text: perm, cls: 'required', title: explicitRequired.value.has(perm) ? '需显式授予' : '未授予' };
  });
}
/** 声明但未授予的权限差异（P4：重启后可能加载失败告警） */
function permissionMissing(p: PluginInfo): string[] {
  const granted = new Set(p.grantedPermissions ?? []);
  return (p.permissions ?? []).filter((perm) => !defaultGranted.value.has(perm) && !granted.has(perm));
}
const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置', installed: '已安装', dev: '开发中', session: '会话级',
};

// ── 左侧导航 ──
const HOOK_KIND_NAV: { kind: string; label: string }[] = [
  { kind: 'runStart', label: '请求前' },
  { kind: 'stepStart', label: '步骤开始' },
  { kind: 'toolExecutionStart', label: '工具执行前' },
  { kind: 'toolExecutionEnd', label: '工具执行后' },
  { kind: 'stepEnd', label: '步骤结束' },
  { kind: 'runEnd', label: '响应后' },
  { kind: 'fallback', label: '兜底' },
];
const selectedKind = ref<string>('plugin');

function kindCount(kind: string): number { return props.hooks.filter(p => p.kind === kind).length; }
const pluginCount = computed(() => props.plugins.length);
const toolCount = computed(() => props.tools.catalog.length);
/** 插件目录：按 ID（插件名）字典序展示 */
const sortedPlugins = computed(() => [...props.plugins].sort((a, b) => a.name.localeCompare(b.name)));
/** 工具目录：按 ID（工具名）字典序展示 */
const sortedTools = computed(() => [...props.tools.catalog].sort((a, b) => a.name.localeCompare(b.name)));

// ── 搜索过滤（ID / 显示名 / 描述，不区分大小写） ──
const pluginQuery = ref('');
const toolQuery = ref('');
function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(q));
}
const filteredPlugins = computed(() => {
  const q = pluginQuery.value;
  return sortedPlugins.value.filter((p) => matchesQuery(q, p.name, p.label, p.description));
});
const filteredTools = computed(() => {
  const q = toolQuery.value;
  return sortedTools.value.filter((t) => matchesQuery(q, t.name, t.label, t.description));
});
function kindLabelOf(kind: string): string {
  return HOOK_KIND_NAV.find(k => k.kind === kind)?.label ?? kind;
}

// ── 插件组 ──
function enabledPresets(): string[] { return props.decl?.presets ?? []; }
function togglePlugin(name: string, on: boolean): void {
  if (!isEditable.value) return;
  const cur = enabledPresets();
  const nextPresets = on ? (cur.includes(name) ? cur : [...cur, name]) : cur.filter(n => n !== name);
  const patch: {
    presets: string[];
    hooks?: Record<string, string[]>;
    tools?: { include?: string[]; exclude?: string[] };
  } = { presets: nextPresets };

  if (!on) {
    // 停用插件：同步修剪其钩子/工具的意图条目（与后端 saveAssembly 的 owner 修剪一致）
    const hookOwner = new Map(props.hooks.map(p => [p.name, p.owner]));
    const hooksPatch: Record<string, string[]> = {};
    for (const k of HOOK_KIND_NAV.map(x => x.kind)) {
      const next = orderNamesOf(k).filter(n => hookOwner.get(n) !== name);
      if (next.length !== orderNamesOf(k).length) hooksPatch[k] = next;
    }
    const toolOwner = new Map(props.tools.catalog.map(t => [t.name, t.owner]));
    const include = props.decl?.tools.include.filter(n => toolOwner.get(n) !== name) ?? [];
    const exclude = props.decl?.tools.exclude.filter(n => toolOwner.get(n) !== name) ?? [];
    if (Object.keys(hooksPatch).length > 0) patch.hooks = hooksPatch;
    patch.tools = { include, exclude };
  }
  props.onDecl!(patch);
}

// ── 钩子清单（新契约：清单即启用集，不在清单里 = 停用） ──
function orderNamesOf(kind: string): string[] {
  const arr = props.decl?.hooks?.[kind];
  return Array.isArray(arr) ? arr : [];
}
/** 推荐顺序：kind → (name → order)，来自后端注册目录（旧后端缺 order 时按数组下标兜底） */
function defaultOrderIndexOf(kind: string, name: string): number {
  const list = props.hooks.filter(p => p.kind === kind);
  const found = list.find(p => p.name === name);
  return found ? (found.order ?? list.indexOf(found)) : Number.MAX_SAFE_INTEGER;
}
/** 已启用钩子：按 config.hooks 顺序展示（顺序即执行顺序）；automatic 不在清单里，单独成区 */
function activeHooksOfKind(kind: string): (HookInfo & { enabled: boolean; listed: boolean })[] {
  const byName = new Map<string, HookInfo>(props.hooks.filter(p => p.kind === kind).map(p => [p.name, p]));
  return orderNamesOf(kind)
    .map(n => byName.get(n))
    .filter((p): p is HookInfo => !!p)
    .map(p => ({ ...p, enabled: ownerEnabled(p), listed: true }));
}
/** 清单内启用区（含被显式列出的 automatic：它们在清单位置执行，视觉位置必须一致） */
function listedActiveHooksOfKind(kind: string): (HookInfo & { enabled: boolean; listed: boolean })[] {
  return activeHooksOfKind(kind);
}
/** automatic 基础设施钩子（未在清单中：collect 追加在显式钩子之后执行，视觉同样放显式区之后） */
function automaticHooksOfKind(kind: string): (HookInfo & { enabled: boolean; listed: boolean })[] {
  const listed = new Set(orderNamesOf(kind));
  return props.hooks
    .filter(p => p.kind === kind && p.automatic && !listed.has(p.name))
    .sort((a, b) => defaultOrderIndexOf(kind, a.name) - defaultOrderIndexOf(kind, b.name))
    .map(p => ({ ...p, enabled: ownerEnabled(p), listed: false }));
}
/** 未启用钩子：推荐顺序补齐（agent 才需要展示；global 展示全量目录） */
function inactiveHooksOfKind(kind: string): (HookInfo & { enabled: boolean; listed: boolean })[] {
  if (!isAgent.value) return [];
  const active = new Set(orderNamesOf(kind));
  return props.hooks
    .filter(p => p.kind === kind && !p.automatic && !active.has(p.name))
    .map(p => ({ ...p, enabled: false, listed: false }))
    .sort((a, b) => defaultOrderIndexOf(kind, a.name) - defaultOrderIndexOf(kind, b.name));
}
/** 该 kind 清单：agent = 清单顺序（执行顺序）→ 未列出的 automatic → 未启用；global = 推荐顺序（与 Agent 未启用区一致） */
function hooksOfKind(kind: string): (HookInfo & { enabled: boolean; listed: boolean })[] {
  if (!isAgent.value) {
    return props.hooks
      .filter(p => p.kind === kind)
      .sort((a, b) => defaultOrderIndexOf(kind, a.name) - defaultOrderIndexOf(kind, b.name))
      .map(p => ({ ...p, enabled: false, listed: false }));
  }
  return [...listedActiveHooksOfKind(kind), ...automaticHooksOfKind(kind), ...inactiveHooksOfKind(kind)];
}
/** 钩子所属插件是否已启用（无主钩子始终视为可用；presets 缺省 = 旧契约不过滤） */
function ownerEnabled(p: HookInfo): boolean {
  if (!p.owner) return true;
  const presets = props.decl?.presets;
  if (!Array.isArray(presets)) return true;
  return presets.includes(p.owner);
}
function isHookEnabled(kind: string, name: string): boolean {
  const p = props.hooks.find(h => h.kind === kind && h.name === name);
  if (!p) return false;
  if (p.automatic) return ownerEnabled(p);
  return orderNamesOf(kind).includes(name) && ownerEnabled(p);
}
function hookToggleDisabled(p: HookInfo): boolean {
  return !isEditable.value || !ownerEnabled(p) || p.automatic === true;
}
/** 开启钩子：按推荐顺序锚点插入（插到第一个推荐顺序在它之后的已启用钩子前），不打乱既有相对顺序 */
function toggleHook(kind: string, name: string, on: boolean): void {
  if (!isEditable.value) return;
  const p = props.hooks.find(h => h.kind === kind && h.name === name);
  if (!p || !ownerEnabled(p) || p.automatic) return;
  const order = orderNamesOf(kind);
  let next: string[];
  if (!on) {
    next = order.filter(n => n !== name);
  } else if (order.includes(name)) {
    next = order;
  } else {
    const def = defaultOrderIndexOf(kind, name);
    const idx = order.findIndex(n => defaultOrderIndexOf(kind, n) > def);
    next = idx === -1 ? [...order, name] : [...order.slice(0, idx), name, ...order.slice(idx)];
  }
  props.onDecl!({ hooks: { [kind]: next } });
}
/** 一键按推荐顺序重排当前启用清单（只排序、不改开关状态） */
function sortHooksByRecommended(kind: string): void {
  if (!isEditable.value) return;
  const order = [...orderNamesOf(kind)];
  order.sort((a, b) => defaultOrderIndexOf(kind, a) - defaultOrderIndexOf(kind, b));
  props.onDecl!({ hooks: { [kind]: order } });
}

// ── 详情/配置弹窗（钩子；configNs / security 由后端 hook 目录透出，无前端硬编码） ──
function cfgNs(p: HookInfo): string { return p.configNs ?? ''; }
function hasHookCfg(p: HookInfo): boolean {
  return (p.configNs ?? '') !== '' || p.security === true;
}
const detailHook = ref<{ kind: string; p: HookInfo } | null>(null);
function openDetail(kind: string, p: HookInfo) { detailHook.value = { kind, p }; }

// ── 工具区（新契约：include/exclude 单一意图覆盖） ──
type ToolStatus = 'auto' | 'explicit' | 'off';
function toolIncludeNames(): string[] {
  return props.decl?.tools.include ?? [];
}
function toolExcludeNames(): string[] {
  return props.decl?.tools.exclude ?? [];
}
function toolDisabled(name: string): boolean {
  return toolExcludeNames().includes(name);
}
/** 工具所属插件是否已启用（无主工具始终可用；presets 缺省 = 旧契约不过滤） */
function toolOwnerEnabled(t: AgentToolInfo): boolean {
  if (!t.owner) return true;
  const presets = props.decl?.presets;
  if (!Array.isArray(presets)) return true;
  return presets.includes(t.owner);
}
function toolStatus(name: string): ToolStatus {
  if (!isAgent.value) return 'off';
  if (toolDisabled(name)) return 'off';
  if (toolIncludeNames().includes(name) || props.tools.include.includes(name)) return 'explicit';
  if (props.tools.enabled.includes(name)) return 'auto';
  // 本地已把停用工具重新打开：后端 enabled 快照尚未更新，这里按标签/owner 推演默认启用状态
  const t = props.tools.catalog.find(x => x.name === name);
  if (t && (t.requires?.length ?? 0) > 0 && canAddTool(t) && toolOwnerEnabled(t)) return 'auto';
  return 'off';
}
function canAddTool(t: AgentToolInfo): boolean {
  if (!t.requires || t.requires.length === 0) return true;
  const tags = new Set(['base', ...(props.tags ?? []).map(tag => tag === 'agent' ? 'base' : tag)]);
  return t.requires.every(r => tags.has(r));
}
function hasTag(r: string): boolean {
  const tags = new Set(['base', ...(props.tags ?? []).map(tag => tag === 'agent' ? 'base' : tag)]);
  return tags.has(r);
}
/** 工具开关是否可用：标签不足或所属插件未启用时不可手动打开 */
function toolToggleDisabled(t: AgentToolInfo): boolean {
  if (!isEditable.value) return true;
  if (toolStatus(t.name) !== 'off') return false;
  return !canAddTool(t) || !toolOwnerEnabled(t);
}
function toggleTool(name: string, on: boolean): void {
  if (!isEditable.value) return;
  const t = props.tools.catalog.find(x => x.name === name);
  if (!t) return;
  if (on && !canAddTool(t)) return;

  let include = [...toolIncludeNames()];
  let exclude = [...toolExcludeNames()];
  if (on) {
    exclude = exclude.filter(n => n !== name);
    // requires 为空的工具无默认启用：必须写入 include 显式开启
    if ((!t.requires || t.requires.length === 0) && !include.includes(name)) include = [...include, name];
  } else {
    include = include.filter(n => n !== name);
    exclude = exclude.includes(name) ? exclude : [...exclude, name];
  }
  props.onDecl!({ tools: { include, exclude } });
}
function hasToolCfg(t: AgentToolInfo): boolean {
  return !!t.ns && !!(props.nsSchemas as any)[t.ns];
}
const toolDetail = ref<AgentToolInfo | null>(null);
function openToolDetail(t: AgentToolInfo) { toolDetail.value = t; }

// ── 拖拽排序（agent；只对启用清单排序） ──
const dragType = ref('');
const dragIndex = ref(-1);
function activeCount(kind: string): number { return listedActiveHooksOfKind(kind).length; }
function onDragStart(kind: string, idx: number) { dragType.value = kind; dragIndex.value = idx; }
function onDrop(kind: string, targetIdx: number): void {
  if (!isEditable.value || dragType.value !== kind || dragIndex.value === targetIdx) return;
  if (targetIdx < 0 || targetIdx >= activeCount(kind)) return; // 只允许落在启用区
  const visible = hooksOfKind(kind);
  const source = visible[dragIndex.value];
  if (!source || !source.enabled) return;

  const arr = [...orderNamesOf(kind)];
  if (source.listed) {
    if (dragIndex.value < 0 || dragIndex.value >= arr.length) return;
    arr.splice(dragIndex.value, 1);
  }
  // 未列入清单的 automatic：拖入启用区 = 把它写进 config.hooks 对应位置（toggle 仍禁用）
  arr.splice(targetIdx, 0, source.name);
  props.onDecl!({ hooks: { [kind]: arr } });
  dragType.value = '';
  dragIndex.value = -1;
}
</script>

<template>
  <div class="ext-pane">
    <div v-if="!isAgent" class="ext-global-hint">全局插件/钩子/工具为目录与默认配置（启用/停用在各 Agent 面板「扩展与工具」）</div>
    <div v-else-if="readonly" class="ext-global-hint ext-readonly-hint">旧契约配置为只读展示：点击底部「保存配置」后自动迁移为 presets / tools / hooks 新契约</div>
    <div class="ext-layout">
      <!-- 左侧导航 -->
      <div class="ext-side">
        <div class="ext-side-item" :class="{ active: selectedKind === 'plugin' }" @click="selectedKind = 'plugin'">
          <span>插件</span>
          <span class="ext-side-count">{{ pluginCount }}</span>
        </div>
        <div
          v-for="k in HOOK_KIND_NAV" :key="k.kind"
          class="ext-side-item" :class="{ active: selectedKind === k.kind }"
          @click="selectedKind = k.kind"
        >
          <span>{{ k.label }}</span>
          <span class="ext-side-count">{{ kindCount(k.kind) }}</span>
        </div>
        <div class="ext-side-item" :class="{ active: selectedKind === 'tool' }" @click="selectedKind = 'tool'">
          <span>工具</span>
          <span class="ext-side-count">{{ toolCount }}</span>
        </div>
      </div>

      <!-- 右侧清单 -->
      <div class="ext-main">
        <!-- 插件组（presets 开关） -->
        <template v-if="selectedKind === 'plugin'">
          <div class="ext-main-head">
            <span class="ext-main-title">插件</span>
            <span class="ext-main-count">{{ pluginCount }} 个</span>
            <input v-model="pluginQuery" class="ext-search" type="search" placeholder="搜索插件 ID / 名称" />
          </div>
          <div class="info-desc" v-if="isAgent">启用插件 = 写入 config.presets（插件级候选过滤；顺序无意义）。已安装但未启用的插件置灰展示。</div>
          <div class="info-desc" v-else>全局插件目录：内置 + 已安装 + 开发中 + 会话级（启用在各 Agent 面板配置）</div>
          <div v-if="plugins.length === 0" class="ext-hint">暂无插件</div>
          <div v-else-if="filteredPlugins.length === 0" class="ext-hint">没有匹配「{{ pluginQuery }}」的插件</div>
          <div v-else class="ext-tool-list">
            <div
              v-for="p in filteredPlugins" :key="'p-' + p.name"
              class="hook-row" :class="{ off: isAgent && !enabledPresets().includes(p.name) }"
              :title="p.description ?? p.name"
            >
              <span class="hook-drag-off">·</span>
              <div class="hook-main">
                <span class="hook-name-row">
                  <span class="hook-name">{{ p.label || p.name }}</span>
                  <span class="ext-id-badge" title="插件 ID（cordis 插件 name = presets id）">{{ p.name }}</span>
                  <span class="plugin-source-badge" :class="'src-' + p.source">{{ SOURCE_LABELS[p.source] ?? p.source }}</span>
                  <span class="plugin-version" v-if="p.version">v{{ p.version }}</span>
                  <span v-for="b in permissionBadges(p)" :key="b.text" class="perm-badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
                </span>
                <span class="hook-desc">{{ p.description }}</span>
                <span v-if="permissionMissing(p).length" class="perm-missing">声明但未授予：{{ permissionMissing(p).join(', ') }}（重启后可能加载失败）</span>
              </div>
              <label v-if="isAgent" class="hook-toggle" :title="enabledPresets().includes(p.name) ? '停用插件' : '启用插件'" @click.stop>
                <input type="checkbox" :checked="enabledPresets().includes(p.name)" :disabled="!isEditable" @change="togglePlugin(p.name, ($event.target as HTMLInputElement).checked)" />
              </label>
            </div>
          </div>
        </template>

        <!-- 工具区 -->
        <template v-else-if="selectedKind === 'tool'">
          <div class="ext-main-head">
            <span class="ext-main-title">工具</span>
            <span class="ext-main-count">{{ toolCount }} 个</span>
            <input v-model="toolQuery" class="ext-search" type="search" placeholder="搜索工具 ID / 名称" />
          </div>
          <div class="info-desc" v-if="isAgent">工具随启用插件默认提供（受 requires 标签门禁）；开关写 tools.include / tools.exclude（exclude 优先）</div>
          <div class="info-desc" v-else>全局工具目录：各 Agent 按 presets 插件与能力标签装配；命名空间配置可在此调整默认值</div>
          <div v-if="tools.catalog.length === 0" class="ext-hint">暂无可用工具</div>
          <div v-else-if="filteredTools.length === 0" class="ext-hint">没有匹配「{{ toolQuery }}」的工具</div>
          <div v-else class="ext-tool-list">
            <div
              v-for="t in filteredTools" :key="'t-' + t.name"
              class="hook-row" :class="{ off: isAgent && toolStatus(t.name) === 'off' }"
              @click="openToolDetail(t)"
            >
              <span class="hook-drag-off">·</span>
              <div class="hook-main">
                <span class="hook-name-row">
                  <span class="hook-name">{{ t.label || t.name }}</span>
                  <span class="ext-id-badge" title="工具 ID（注册名，config.tools 引用的名字）">{{ t.name }}</span>
                  <span v-if="hasToolCfg(t)" class="cfg-badge" title="可配置，点击行查看">配置</span>
                </span>
                <span class="hook-desc">{{ t.description }}</span>
              </div>
              <span v-if="t.requires && t.requires.length" class="tool-tags tool-requires-side">
                <span
                  v-for="r in t.requires" :key="r"
                  class="tool-tag" :class="{ on: hasTag(r), miss: !hasTag(r) }"
                  :title="hasTag(r) ? '已具备此标签' : '缺少此标签，无法启用'"
                >{{ r }}</span>
              </span>
              <template v-if="isAgent">
                <span v-if="toolDisabled(t.name)" class="tool-badge off" title="已停用（tools.exclude）">已停用</span>
                <span v-else-if="toolStatus(t.name) === 'auto'" class="tool-badge auto" title="随插件默认启用（requires 标签门禁通过）">默认</span>
                <span v-else-if="toolStatus(t.name) === 'explicit'" class="tool-badge exp" title="已在 tools.include 显式启用">显式</span>
                <label
                  class="hook-toggle"
                  :title="!isEditable ? '' : toolStatus(t.name) === 'off' ? ((!canAddTool(t) || !toolOwnerEnabled(t)) ? '缺少所需标签或所属插件未启用' : '启用工具') : '停用工具'"
                  @click.stop
                >
                  <input
                    type="checkbox"
                    :checked="toolStatus(t.name) !== 'off'"
                    :disabled="toolToggleDisabled(t)"
                    @change="toggleTool(t.name, ($event.target as HTMLInputElement).checked)"
                  />
                </label>
              </template>
            </div>
          </div>
        </template>

        <!-- 钩子区 -->
        <template v-else>
          <div class="ext-main-head">
            <span class="ext-main-title">{{ kindLabelOf(selectedKind) }}</span>
            <span class="ext-main-count">{{ kindCount(selectedKind) }} 个能力</span>
            <button
              v-if="isAgent && orderNamesOf(selectedKind).length > 1"
              class="ext-sort-btn"
              :disabled="!isEditable"
              title="将当前启用清单按插件注册的推荐顺序重排（只排序，不改开关）"
              @click="sortHooksByRecommended(selectedKind)"
            >按推荐顺序排序</button>
          </div>
          <div class="info-desc" v-if="isAgent">开启钩子会自动插入推荐位置；拖动启用区可调整执行顺序（config.hooks） · 开关 = 加入/移出启用清单</div>
          <div class="info-desc" v-else>全局目录：点击行查看该能力的默认配置</div>
          <div v-if="hooksOfKind(selectedKind).length === 0" class="ext-hint">暂无该类型的能力</div>
          <div
            v-for="(p, idx) in hooksOfKind(selectedKind)" :key="'h-' + p.name"
            class="hook-row" :class="{ off: isAgent && !p.enabled, auto: p.automatic === true }"
            :draggable="isEditable && p.enabled"
            @dragstart="isEditable && p.enabled && onDragStart(selectedKind, idx)"
            @dragover.prevent
            @drop="onDrop(selectedKind, idx)"
            @click="openDetail(selectedKind, p)"
          >
            <span v-if="isEditable && p.enabled" class="hook-drag" title="拖动排序"><Icon name="grip-vertical" :size="13" /></span>
            <span v-else class="hook-drag-off">·</span>
            <div class="hook-main">
              <span class="hook-name-row">
                <span class="hook-name">{{ p.label }}</span>
                <span class="ext-id-badge" title="钩子 ID（注册名，config.hooks 引用的名字）">{{ p.name }}</span>
                <span v-if="p.automatic" class="hook-auto-badge" title="基础设施钩子：自动进入每个 run，不可停用">automatic</span>
                <span v-if="hasHookCfg(p)" class="cfg-badge" title="可配置，点击行查看">配置</span>
              </span>
              <span class="hook-desc">{{ p.description }}</span>
            </div>
            <label v-if="isAgent" class="hook-toggle" :title="p.automatic ? 'automatic：基础设施钩子自动启用，不可停用' : (!ownerEnabled(p) ? '所属插件未启用' : (p.enabled ? '停用' : '启用'))" @click.stop>
              <input type="checkbox" :checked="p.enabled" :disabled="hookToggleDisabled(p)" @change="toggleHook(selectedKind, p.name, ($event.target as HTMLInputElement).checked)" />
            </label>
          </div>
        </template>
      </div>
    </div>

    <!-- 钩子详情弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="!!detailHook" :title="detailHook ? detailHook.p.label + ' · ' + detailHook.p.name : ''" :width="440" :z-index="1200" @close="detailHook = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ detailHook?.p.description }}</div>
        <div class="ext-modal-status" v-if="detailHook && isAgent">
          当前状态：{{ detailHook.p.automatic ? 'automatic（自动启用，不可停用）' : (isHookEnabled(detailHook.kind, detailHook.p.name) ? '已启用' : '已停用') }}
          <span class="ext-modal-owner">（提供者：{{ detailHook.p.owner }}）</span>
        </div>
        <div class="ext-modal-status" v-else-if="detailHook">全局默认配置（各 Agent 可覆盖）</div>
        <template v-if="detailHook?.p.configNs">
          <div class="ext-modal-cfg">
            <div class="ext-modal-cfg-title">配置项</div>
            <NsFieldList :ns-key="detailHook.p.configNs" :config="config" :schema="(nsSchemas as any)[detailHook.p.configNs]" :title="'配置'" />
          </div>
        </template>
        <template v-else-if="detailHook?.p.security">
          <div class="ext-modal-cfg">
            <div class="ext-modal-cfg-title">当前路径白名单</div>
            <div v-if="(allowedPaths?.length ?? 0) > 0" class="ext-sec-paths">
              <div v-for="p in allowedPaths" :key="p" class="ext-sec-path">{{ p }}</div>
            </div>
            <div v-else class="ext-sec-none">{{ isAgent ? '未配置 — 仅允许工作区内路径' : '全局未配置（白名单在各 Agent 安全页签）' }}</div>
            <div v-if="isAgent" class="ext-sec-goto">路径白名单在「安全」页签编辑</div>
          </div>
        </template>
        <div v-else-if="detailHook" class="ext-modal-none">此能力无额外配置项</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="detailHook = null">关闭</Button>
      </template>
    </Modal>

    <!-- 工具配置弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="!!toolDetail" :title="toolDetail ? (toolDetail.label || toolDetail.name) + ' · ' + toolDetail.name : ''" :width="440" :z-index="1200" @close="toolDetail = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ toolDetail?.description }}</div>
        <div class="ext-modal-status" v-if="toolDetail && isAgent">
          {{ toolStatus(toolDetail.name) === 'auto' ? '随插件默认启用（requires 门禁通过）' : toolStatus(toolDetail.name) === 'explicit' ? '已在 tools.include 显式启用' : '未启用（tools.exclude 或未开启）' }}
          <span v-if="toolDetail.requires && toolDetail.requires.length" class="ext-modal-tags">
            <span v-for="r in toolDetail.requires" :key="r" class="tool-tag" :class="{ on: hasTag(r), miss: !hasTag(r) }">{{ r }}</span>
          </span>
        </div>
        <div class="ext-modal-status" v-else-if="toolDetail">全局工具（各 Agent 按 presets 插件与能力标签装配）</div>
        <template v-if="toolDetail?.ns && (nsSchemas as any)[toolDetail.ns]">
          <div class="ext-modal-cfg">
            <div class="ext-modal-cfg-title">配置项</div>
            <NsFieldList :ns-key="toolDetail.ns" :config="config" :schema="(nsSchemas as any)[toolDetail.ns]" :title="'配置'" />
          </div>
        </template>
        <div v-else-if="toolDetail" class="ext-modal-none">此工具无额外配置项</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="toolDetail = null">关闭</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ── 左右布局（与 Agent 面板一致） ──
   根元素 .ext-pane 需 :global（scoped 不命中组件自身根），唯一使用者无冲突 */
:global(.ext-pane) { display: flex; flex-direction: column; gap: 10px; height: 100%; flex: 1; min-height: 0; }
.ext-global-hint { font-size: 11px; color: var(--text-3); background: var(--bg-hover); border-radius: var(--r-sm); padding: 6px 10px; }
.ext-readonly-hint { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); }
.ext-layout { display: flex; gap: 12px; min-height: 0; flex: 1; height: 100%; }
.ext-side { width: 150px; flex-shrink: 0; display: flex; flex-direction: column; gap: 3px; border-right: 1px solid var(--line); padding-right: 10px; overflow-y: auto; }
.ext-side-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 6px 10px; border-radius: var(--r-md); font-size: 12px; color: var(--text-2);
  cursor: pointer; transition: background var(--dur-fast), color var(--dur-fast);
}
.ext-side-item:hover { background: var(--bg-hover); }
.ext-side-item.active { background: var(--primary-light); color: var(--primary); font-weight: 500; }
.ext-side-count { font-size: 10px; min-width: 18px; text-align: center; padding: 0 5px; border-radius: var(--r-full); background: var(--bg-hover); color: var(--text-3); }
.ext-side-item.active .ext-side-count { background: var(--primary); color: #fff; }
.ext-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; padding-right: 6px; }
.ext-main-head { display: flex; align-items: center; gap: 8px; }
.ext-main-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.ext-main-count { font-size: 11px; color: var(--text-3); }
.ext-sort-btn {
  margin-left: auto; border: 1px solid var(--line); background: transparent;
  color: var(--text-2); font-size: 11px; padding: 2px 9px; border-radius: var(--r-md);
  cursor: pointer; transition: border-color var(--dur-fast), color var(--dur-fast), background var(--dur-fast);
}
.ext-sort-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
.ext-sort-btn:disabled { opacity: .5; cursor: not-allowed; }
.ext-search {
  margin-left: auto; width: 200px; max-width: 45%; flex-shrink: 1;
  padding: 4px 9px; font-size: 11px; color: var(--text-1);
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface); outline: none;
  transition: border-color var(--dur-fast);
}
.ext-search::placeholder { color: var(--text-3); }
.ext-search:focus { border-color: var(--primary); }
.ext-hint { font-size: 12px; color: var(--text-3); padding: 2px 0; }
.info-desc { font-size: 11px; color: var(--text-3); }

/* ── 行 ── */
.hook-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface); cursor: pointer;
  transition: opacity var(--dur-fast), border-color var(--dur-fast);
}
.hook-row:hover { border-color: color-mix(in srgb, var(--primary) 40%, transparent); }
.hook-row.off { opacity: .55; }
.hook-row.auto { border-style: dashed; }
.hook-auto-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; flex-shrink: 0;
  font-family: var(--font-mono); white-space: nowrap;
  color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.hook-drag { display: inline-flex; align-items: center; color: var(--text-3); cursor: grab; flex-shrink: 0; }
.hook-drag-off { color: var(--line-strong); font-size: 12px; flex-shrink: 0; }
.hook-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hook-name { font-size: 12px; font-weight: 500; color: var(--text-1); }
.hook-row.off .hook-name { color: var(--text-3); font-weight: 400; }
.hook-desc { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hook-toggle input { accent-color: var(--primary); cursor: pointer; }
.hook-toggle input:disabled { cursor: not-allowed; opacity: .5; }
.hook-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.hook-name-row .hook-name { white-space: nowrap; }

/* ── 插件组（P2） ── */
.plugin-source-badge, .plugin-version {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px;
  color: var(--text-3); background: var(--bg-hover); white-space: nowrap;
}
.plugin-source-badge.src-installed { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.plugin-source-badge.src-dev { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plugin-source-badge.src-session { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.perm-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px;
  font-family: var(--font-mono); white-space: nowrap;
}
.perm-badge.default { color: var(--text-2); background: var(--bg-hover); }
.perm-badge.granted { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.perm-badge.required { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.perm-missing { font-size: 11px; color: var(--warn); }

/* ── 工具 ── */
.tool-tags { display: inline-flex; gap: 3px; flex-shrink: 0; overflow: hidden; }
.tool-tag {
  font-size: 11px; line-height: 1; padding: 2px 8px; border-radius: 999px;
  font-family: var(--font-mono); white-space: nowrap;
}
.tool-tag.on { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.tool-tag.miss { color: var(--text-3); background: var(--bg-hover); }
.ext-modal-tags { display: inline-flex; gap: 4px; margin-left: 8px; vertical-align: middle; }
.ext-modal-owner { margin-left: 6px; color: var(--text-3); font-size: 11px; }
.ext-id-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; flex-shrink: 0;
  font-family: var(--font-mono); color: var(--text-3); background: var(--bg-hover); white-space: nowrap;
}
.cfg-badge {
  font-size: 10px; line-height: 1; padding: 2px 6px; border-radius: 999px; flex-shrink: 0;
  color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.tool-badge { flex-shrink: 0; font-size: 10px; line-height: 1; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.tool-badge.auto { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.tool-badge.exp { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.tool-badge.off { color: var(--text-3); background: var(--bg-hover); }
.tool-act {
  flex-shrink: 0; border: none; background: transparent;
  color: var(--text-2); font-size: 11px; padding: 3px 10px; border-radius: var(--r-md);
  cursor: pointer; transition: border-color var(--dur-fast), color var(--dur-fast);
}
.tool-act:hover { background: var(--bg-hover); color: var(--text-1); }
.tool-act.danger { color: var(--err); }
.tool-act.danger:hover { background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); }

/* ── 弹窗 ── */
.ext-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.ext-modal-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; }
.ext-modal-status { font-size: 12px; color: var(--text-1); }
.ext-modal-cfg { border: 1px solid var(--line); border-radius: var(--r-md); padding: 8px 10px; background: var(--bg-base); }
.ext-modal-cfg-title { font-size: 12px; font-weight: 600; color: var(--text-1); margin-bottom: 6px; }
.ext-modal-none { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.ext-sec-paths { display: flex; flex-direction: column; gap: 4px; }
.ext-sec-path { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); background: var(--bg-base); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 8px; word-break: break-all; }
.ext-sec-none { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.ext-sec-goto { font-size: 12px; color: var(--primary); padding-top: 2px; }
</style>
