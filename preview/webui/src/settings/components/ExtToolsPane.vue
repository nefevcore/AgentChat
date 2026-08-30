<script setup lang="ts">
// ============================================================
// ExtToolsPane.vue —— Agent「装配」页（M22 P2 重构；M24 P4 目录同构）
//   · 左侧导航 扩展 | 工具 | 事件 三视图（与插件库目录同构拷贝）：
//     - 扩展 = settings 差异层编辑（enabled/参数；配置弹窗双实例之
//       差异层——写 agents/update-config）+ 基础设施行 + 动态装载只读区
//     - 工具 = include/exclude 三态 + 能力标签（M24 X4：tags 单源）
//     - 事件 = 本 Agent 生效链（events/listeners × settings 门控态，
//       前端可算；facet 感知随 M25）
//   · 顺序编辑已删除（D3）：waterfall 执行序 = 监听器注册序，不可配置。
// ============================================================
import { ref, computed } from 'vue';
import type { ExtensionEntry, ExtensionTarget, AgentToolInfo, PluginInfo, PluginPermissionsView, EventChainEntry, EventDescriptionEntry } from '../types';
import { Modal, Button } from '@/ui';
import ExtensionSettingsModal from './ExtensionSettingsModal.vue';

const props = defineProps<{
  /** 扩展目录（plugin/extension-catalog × plugin/rows；后端词汇表） */
  extensions: ExtensionEntry[];
  /** 动态装载插件（session/installed 源；只读徽章区） */
  plugins: PluginInfo[];
  /** 当前装配声明：{ tools:{include,exclude}, settings=具名设置对象 } */
  decl: {
    tools: { include: string[]; exclude: string[] };
    settings: Record<string, unknown>;
  } | null;
  /** 编辑声明 */
  onDecl?: (patch: {
    tools?: { include?: string[]; exclude?: string[] };
    settings?: Record<string, Record<string, unknown> | null>;
  }) => void;
  /** 工具数据：catalog 全量目录 + enabled（装配快照）+ include/exclude 意图覆盖 */
  tools: { catalog: AgentToolInfo[]; enabled: string[]; include: string[]; exclude: string[] };
  /** 权限词汇表（徽章判定；缺省用契约内建值） */
  permissions?: PluginPermissionsView | null;
  /** agent 能力标签（toolStatus/canAddTool/hasTag 用） */
  tags?: string[];
  /** 当前 Agent id（P2：能力集合成 agent:<自己的id>，与后端门禁语义对齐） */
  agentId?: string;
  /** 事件执行链（M24 P4 事件视图：本 Agent 生效链数据源） */
  eventChains?: EventChainEntry[];
  /** 事件描述声明（M25 P2：facet 感知灰显——声明目录携带 facet） */
  eventDescriptions?: EventDescriptionEntry[];
}>();

const isEditable = computed(() => !!props.onDecl);

// ── 左侧导航（三视图——目录同构） ──
const selectedKind = ref<'ext' | 'tool' | 'event'>('ext');
function pick(kind: 'ext' | 'tool' | 'event'): void {
  selectedKind.value = kind;
}

// ── 事件落点徽章（preview 事件词汇 → 三组人类标签） ──
const TARGET_LABELS: Record<ExtensionTarget, string> = {
  'loop/before-run': '运行前',
  'tool/before-execute': '工具前',
  'tool/transform-result': '结果变换',
  'loop/transform-run': '运行变换',
  'loop/after-run': '运行后',
};
function targetLabel(t: ExtensionTarget): string {
  return TARGET_LABELS[t] ?? t;
}

// ── 权限徽章判定（优先 plugin/permissions，契约缺省兜底） ──
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
function permissionMissing(p: PluginInfo): string[] {
  const granted = new Set(p.grantedPermissions ?? []);
  return (p.permissions ?? []).filter((perm) => !defaultGranted.value.has(perm) && !granted.has(perm));
}
const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置', installed: '已安装', dev: '开发中', session: '会话级',
};
/** 动态装载插件状态徽章（M22 D2：per-Agent 启停面已删除，只读表达） */
function pluginBadge(p: PluginInfo): { text: string; cls: string; title: string } {
  if (p.source === 'session') {
    return { text: '会话级·已装载', cls: 'session', title: '会话级装载（重启即失）；卸载在插件库「开发与会话」页签' };
  }
  if (p.source === 'installed') {
    return { text: '已装载', cls: 'installed', title: '安装态在 registry.json，boot 扫描装载；卸载在插件库' };
  }
  return { text: '装载即生效', cls: 'builtin', title: 'cordis.yml 装配行：进程级启停 = 编辑行组合并重启，UI 不重复表达' };
}
/** 动态装载区 = session/installed 源（builtin 装配行即扩展目录与工具，不在此重复） */
const dynamicPlugins = computed(() =>
  props.plugins.filter((p) => p.source === 'session' || p.source === 'installed'),
);

// ── 扩展行 ──
const toggleableExts = computed(() => props.extensions.filter((e) => !e.automatic));
const automaticExts = computed(() => props.extensions.filter((e) => e.automatic === true));
// P4 过滤开关：按插件（装配行包）分组展示 / 仅显示有参数的插件
const groupByRow = ref(true);
const onlyWithParams = ref(false);
/** 启用判据 = configs[name].enabled !== false（缺省启用；legacy string 形状同样视为启用） */
function extEnabled(name: string): boolean {
  const cfg = props.decl?.settings?.[name];
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    return (cfg as { enabled?: unknown }).enabled !== false;
  }
  return true;
}
function extHasParams(e: ExtensionEntry): boolean {
  return (e.fields?.length ?? 0) > 0;
}
/** onlyWithParams=true：无参数条目过滤掉（automatic 基础设施行同样过滤） */
function applyParamFilter(list: ExtensionEntry[]): ExtensionEntry[] {
  return onlyWithParams.value ? list.filter((e) => extHasParams(e)) : list;
}
/** 可开关扩展行渲染块（P4：groupByRow=true → 按 e.row 分组带组标题；false → 单块平铺） */
type ExtBlock = { key: string; title?: string; entries: ExtensionEntry[] };
const extBlocks = computed<ExtBlock[]>(() => {
  const entries = applyParamFilter(filteredExts(toggleableExts.value));
  if (!groupByRow.value) return [{ key: 'flat', entries }];
  const byRow = new Map<string, ExtensionEntry[]>();
  for (const e of entries) {
    if (!byRow.has(e.row)) byRow.set(e.row, []);
    byRow.get(e.row)!.push(e);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([row, es]) => ({ key: `row-${row}`, title: row, entries: es }));
});
/** 基础设施行过滤结果（搜索 + onlyWithParams） */
const visibleAutomaticExts = computed(() => applyParamFilter(filteredExts(automaticExts.value)));
/** 开关写 settings['<名>'].enabled（浅合并语义在服务端；既有参数字段不动） */
function toggleExt(e: ExtensionEntry, on: boolean): void {
  if (!isEditable.value || e.automatic) return;
  const base = extConfigOf(e.name);
  props.onDecl!({ settings: { [e.name]: { ...base, enabled: on } } });
}
function extConfigOf(name: string): Record<string, unknown> {
  const cfg = props.decl?.settings?.[name];
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg)
    ? { ...(cfg as Record<string, unknown>) }
    : {};
}

// ── 扩展参数弹窗（配置弹窗双实例 · 差异层——M24 P4 共享组件） ──
const detailExt = ref<ExtensionEntry | null>(null);
const configEntry = ref<ExtensionEntry | null>(null);
function openExtDetail(e: ExtensionEntry): void {
  detailExt.value = e;
}
/** 差异层补丁（ExtensionSettingsModal agent 模式回调；null = 删除该 name 配置） */
function onSettingsPatch(name: string, next: Record<string, unknown> | null): void {
  if (!isEditable.value) return;
  props.onDecl!({ settings: { [name]: next } });
}

// ── 本 Agent 生效链（事件视图：events/listeners × settings 门控态，前端可算） ──
/** 监听器 owner（fiber/行名）→ 扩展目录条目（settings 键锚点） */
function extOfOwner(owner: string): ExtensionEntry | undefined {
  return props.extensions.find((e) => e.row === owner || e.name === owner);
}
/** owner::event 的声明（facet 感知） */
function declOf(owner: string, event: string): EventDescriptionEntry | undefined {
  return (props.eventDescriptions ?? []).find((d) => d.owner === owner && d.event === event);
}
/** facet 子键读取（agentGate 同语义：settings[name][facet].enabled ?? enabled） */
function facetDisabledForAgent(ext: ExtensionEntry, facet: string | undefined): boolean {
  const cfg = props.decl?.settings?.[ext.name];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  const c = cfg as Record<string, unknown>;
  if (facet !== undefined) {
    const sub = c[facet];
    if (sub !== undefined && sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
      const subEnabled = (sub as { enabled?: unknown }).enabled;
      if (subEnabled !== undefined) return subEnabled === false;
    }
  }
  return c.enabled === false;
}
/**
 * 该监听器对本 Agent 是否被 settings 软停用（facet 感知——M25 P2：
 * 声明目录携带 facet → 停用态灰显对应监听器，与 agentGate 同语义）。
 */
function listenerDisabledForAgent(owner: string, event: string): boolean {
  const ext = extOfOwner(owner);
  if (!ext) return false; // 声明目录未覆盖的行：门控态未知（UI 注明"停用未必生效"）
  const decl = declOf(owner, event);
  return facetDisabledForAgent(ext, decl?.facet);
}
/** 该监听器是否经声明目录声明 respectsEnabled（未声明 → UI 注明停用未必生效） */
function listenerRespectsEnabled(owner: string): boolean | undefined {
  const ext = extOfOwner(owner);
  if (!ext) return undefined;
  return (props.eventDescriptions ?? []).some((d) => d.owner === owner && d.respectsEnabled === true);
}
/** 生效链事件 = 有监听器的全部事件（host 域也如实呈现——门控列仅对 run 域有意义） */
const agentEventChains = computed(() => props.eventChains ?? []);

// ── 搜索过滤（ID / 显示名 / 描述，不区分大小写） ──
const extQuery = ref('');
const toolQuery = ref('');
function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(q));
}
const filteredExts = (list: ExtensionEntry[]) => list.filter((e) => matchesQuery(extQuery.value, e.name, e.label, e.description));
const filteredTools = computed(() => {
  const q = toolQuery.value;
  return [...props.tools.catalog]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((t) => matchesQuery(q, t.name, t.label, t.description));
});
const filteredDynPlugins = computed(() =>
  dynamicPlugins.value
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((p) => matchesQuery(extQuery.value, p.name, p.label, p.description)),
);

// ── 工具区（include/exclude 单一意图覆盖；三态徽章） ──
type ToolStatus = 'auto' | 'explicit' | 'off';
// P2：调用方能力集 = base ∪ 显式 tags ∪ agent:<自己的id>（与后端门禁语义
// 同步合成；'agent' 旧标签归一为 base 全等匹配保持现状）
function toolDisabled(name: string): boolean {
  return (props.decl?.tools.exclude ?? []).includes(name);
}
function toolStatus(name: string): ToolStatus {
  if (toolDisabled(name)) return 'off';
  if ((props.decl?.tools.include ?? props.tools.include).includes(name)) return 'explicit';
  if (props.tools.enabled.includes(name)) return 'auto';
  // 本地已把停用工具重新打开：后端 enabled 快照尚未更新，按标签推演默认启用状态
  const t = props.tools.catalog.find(x => x.name === name);
  if (t && (t.requires?.length ?? 0) > 0 && canAddTool(t)) return 'auto';
  return 'off';
}
function canAddTool(t: AgentToolInfo): boolean {
  if (!t.requires || t.requires.length === 0) return true;
  const tags = new Set(['base', ...(props.tags ?? []).map(tag => tag === 'agent' ? 'base' : tag), ...(props.agentId ? ['agent:' + props.agentId] : [])]);
  return t.requires.every(r => tags.has(r));
}
function hasTag(r: string): boolean {
  const tags = new Set(['base', ...(props.tags ?? []).map(tag => tag === 'agent' ? 'base' : tag), ...(props.agentId ? ['agent:' + props.agentId] : [])]);
  return tags.has(r);
}
/** 工具开关是否可用：能力标签不足时不可手动打开 */
function toolToggleDisabled(t: AgentToolInfo): boolean {
  if (!isEditable.value) return true;
  if (toolStatus(t.name) !== 'off') return false;
  return !canAddTool(t);
}
function toggleTool(name: string, on: boolean): void {
  if (!isEditable.value) return;
  const t = props.tools.catalog.find(x => x.name === name);
  if (!t) return;
  if (on && !canAddTool(t)) return;

  let include = [...(props.decl?.tools.include ?? [])];
  let exclude = [...(props.decl?.tools.exclude ?? [])];
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
const toolDetail = ref<AgentToolInfo | null>(null);
function openToolDetail(t: AgentToolInfo) { toolDetail.value = t; }
</script>

<template>
  <div class="ext-pane">
    <div class="ext-layout">
      <!-- 左侧导航（三视图——目录同构） -->
      <div class="ext-side">
        <div class="ext-side-item" :class="{ active: selectedKind === 'ext' }" @click="pick('ext')">
          <span>扩展</span>
          <span class="ext-side-count">{{ extensions.length }}</span>
        </div>
        <div class="ext-side-item" :class="{ active: selectedKind === 'tool' }" @click="pick('tool')">
          <span>工具</span>
          <span class="ext-side-count">{{ tools.catalog.length }}</span>
        </div>
        <div class="ext-side-item" :class="{ active: selectedKind === 'event' }" @click="pick('event')">
          <span>事件</span>
          <span class="ext-side-count">{{ agentEventChains.length }}</span>
        </div>
      </div>

      <!-- 右侧主区 -->
      <div class="ext-main">
        <!-- 扩展分区 -->
        <template v-if="selectedKind === 'ext'">
          <div class="ext-main-head">
            <span class="ext-main-title">扩展</span>
            <span class="ext-main-count">{{ extensions.length }} 个扩展行</span>
            <input v-model="extQuery" class="ext-search" type="search" placeholder="搜索扩展 / 插件" />
          </div>
          <div class="info-desc">per-Agent 只控制软停用（settings['&lt;名&gt;'].enabled）、参数与工具意图；进程级启停 = 行组合（cordis.yml / 插件库）。</div>
          <!-- P4 过滤开关：按插件分组 / 仅显示有参数的插件 -->
          <div class="ext-filter-bar">
            <label class="ext-filter" title="按装配行包名（e.row）分组展示扩展条目">
              <input v-model="groupByRow" type="checkbox" />按插件分组
            </label>
            <label class="ext-filter" title="隐藏无可配置参数（fields 为空）的条目；基础设施行同样过滤">
              <input v-model="onlyWithParams" type="checkbox" />仅显示有参数的插件
            </label>
          </div>
          <div v-if="extBlocks.every((b) => b.entries.length === 0)" class="ext-hint">暂无扩展（扩展目录随行装载增删）</div>
          <template v-else>
            <template v-for="block in extBlocks" :key="block.key">
              <div v-if="block.title" class="ext-zone-title" :title="`装配行包：${block.title}`">{{ block.title }}</div>
              <div class="ext-tool-list">
                <div
                  v-for="e in block.entries" :key="'e-' + e.name"
                  class="hook-row" :class="{ off: !extEnabled(e.name) }"
                  @click="openExtDetail(e)"
                >
                  <span class="hook-drag-off">·</span>
                  <div class="hook-main">
                    <span class="hook-name-row">
                      <span class="hook-name">{{ e.label }}</span>
                      <span class="ext-id-badge" :title="`AgentConfig.settings 键（${e.row} 行）`">{{ e.name }}</span>
                      <span v-for="t in e.targets" :key="t" class="target-badge" :title="`事件落点：${t}`">{{ targetLabel(t) }}</span>
                      <span v-if="e.targets.length === 0" class="target-badge none" title="纯能力供给行（非事件拦截）">能力供给</span>
                      <span v-if="extHasParams(e)" class="cfg-badge" title="可配置参数，点击行编辑">参数</span>
                    </span>
                    <span class="hook-desc">{{ e.description }}</span>
                  </div>
                  <label class="hook-toggle" :title="extEnabled(e.name) ? '软停用（settings 单 Agent 生效，行仍装载）' : '启用'" @click.stop>
                    <input type="checkbox" :checked="extEnabled(e.name)" :disabled="!isEditable" @change="toggleExt(e, ($event.target as HTMLInputElement).checked)" />
                  </label>
                </div>
              </div>
            </template>
          </template>

          <!-- 基础设施行（装载即生效，不可关） -->
          <template v-if="visibleAutomaticExts.length > 0">
            <div class="ext-zone-title">基础设施行（装载即生效，不可关）</div>
            <div class="ext-tool-list">
              <div
                v-for="e in visibleAutomaticExts" :key="'a-' + e.name"
                class="hook-row auto" @click="openExtDetail(e)"
              >
                <span class="hook-drag-off">·</span>
                <div class="hook-main">
                  <span class="hook-name-row">
                    <span class="hook-name">{{ e.label }}</span>
                    <span class="ext-id-badge" :title="`AgentConfig.settings 键（${e.row} 行）`">{{ e.name }}</span>
                    <span class="hook-auto-badge" title="基础设施行：自动进入每个 run，不可 per-Agent 停用">auto</span>
                    <span v-for="t in e.targets" :key="t" class="target-badge" :title="`事件落点：${t}`">{{ targetLabel(t) }}</span>
                    <span v-if="e.targets.length === 0" class="target-badge none" title="纯能力供给行（非事件拦截）">能力供给</span>
                    <span v-if="extHasParams(e)" class="cfg-badge" title="可配置参数，点击行编辑">参数</span>
                  </span>
                  <span class="hook-desc">{{ e.description }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- 动态装载插件（只读徽章；启停/卸载在插件库） -->
          <template v-if="filteredDynPlugins.length > 0">
            <div class="ext-zone-title">动态装载插件（只读；启停与卸载在插件库）</div>
            <div class="ext-tool-list">
              <div
                v-for="p in filteredDynPlugins" :key="'p-' + p.name"
                class="hook-row" :title="p.description ?? p.name"
              >
                <span class="hook-drag-off">·</span>
                <div class="hook-main">
                  <span class="hook-name-row">
                    <span class="hook-name">{{ p.label || p.name }}</span>
                    <span class="ext-id-badge" title="插件 ID（manifest.name）">{{ p.name }}</span>
                    <span class="plugin-source-badge" :class="'src-' + p.source">{{ SOURCE_LABELS[p.source] ?? p.source }}</span>
                    <span class="plugin-version" v-if="p.version">v{{ p.version }}</span>
                    <span v-for="b in permissionBadges(p)" :key="b.text" class="perm-badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
                  </span>
                  <span class="hook-desc">{{ p.description }}</span>
                  <span v-if="permissionMissing(p).length" class="perm-missing">声明但未授予：{{ permissionMissing(p).join(', ') }}（重启后可能加载失败）</span>
                </div>
                <span class="plugin-load-badge" :class="pluginBadge(p).cls" :title="pluginBadge(p).title">{{ pluginBadge(p).text }}</span>
              </div>
            </div>
          </template>
        </template>

        <!-- 工具分区 -->
        <template v-else-if="selectedKind === 'tool'">
          <div class="ext-main-head">
            <span class="ext-main-title">工具</span>
            <span class="ext-main-count">{{ tools.catalog.length }} 个</span>
            <input v-model="toolQuery" class="ext-search" type="search" placeholder="搜索工具 ID / 名称" />
          </div>
          <div class="info-desc">工具按能力标签门禁默认提供；开关写 tools.include / tools.exclude（exclude 优先）</div>
          <div v-if="tools.catalog.length === 0" class="ext-hint">暂无可用工具</div>
          <div v-else-if="filteredTools.length === 0" class="ext-hint">没有匹配「{{ toolQuery }}」的工具</div>
          <div v-else class="ext-tool-list">
            <div
              v-for="t in filteredTools" :key="'t-' + t.name"
              class="hook-row" :class="{ off: toolStatus(t.name) === 'off' }"
              @click="openToolDetail(t)"
            >
              <span class="hook-drag-off">·</span>
              <div class="hook-main">
                <span class="hook-name-row">
                  <span class="hook-name">{{ t.label || t.name }}</span>
                  <span class="ext-id-badge" title="工具 ID（注册名，config.tools 引用的名字）">{{ t.name }}</span>
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
              <span v-if="toolDisabled(t.name)" class="tool-badge off" title="已停用（tools.exclude）">已停用</span>
              <span v-else-if="toolStatus(t.name) === 'auto'" class="tool-badge auto" title="默认启用（requires 标签门禁通过）">默认</span>
              <span v-else-if="toolStatus(t.name) === 'explicit'" class="tool-badge exp" title="已在 tools.include 显式启用">显式</span>
              <label
                class="hook-toggle"
                :title="!isEditable ? '' : toolStatus(t.name) === 'off' ? (!canAddTool(t) ? '缺少所需能力标签' : '启用工具') : '停用工具'"
                @click.stop
              >
                <input
                  type="checkbox"
                  :checked="toolStatus(t.name) !== 'off'"
                  :disabled="toolToggleDisabled(t)"
                  @change="toggleTool(t.name, ($event.target as HTMLInputElement).checked)"
                />
              </label>
            </div>
          </div>
        </template>

        <!-- 事件分区（本 Agent 生效链 × settings 门控态——M24 P4 同构；facet 感知随 M25） -->
        <template v-else>
          <div class="ext-main-head">
            <span class="ext-main-title">事件</span>
            <span class="ext-main-count">{{ agentEventChains.length }} 个事件</span>
          </div>
          <div class="info-desc">
            本 Agent 视角的执行链（灰 = 经 settings 软停用，分发时跳过、链继续）；粒度边界：per-Agent 停到「行为 / facet」为止——本页无事件粒度开关，owner::event 进程级治理在插件库 · 目录 · 事件。
          </div>
          <div v-if="agentEventChains.length === 0" class="ext-hint">暂无事件监听器</div>
          <div v-for="ev in agentEventChains" :key="'ev-' + ev.name" class="evt-card">
            <div class="evt-head">
              <span class="evt-name">{{ ev.name }}</span>
              <span v-if="declOf(ev.listeners?.[0]?.owner ?? '', ev.name)?.facet" class="evt-facet-tag" title="facet 切面（settings[名][facet].enabled ?? enabled）">
                facet:{{ declOf(ev.listeners[0].owner, ev.name)!.facet }}
              </span>
            </div>
            <div class="evt-chain">
              <template v-for="(l, i) in ev.listeners" :key="i">
                <span v-if="i > 0" class="evt-arrow">→</span>
                <span
                  class="evt-listener"
                  :class="{ dim: listenerDisabledForAgent(l.owner, ev.name), prepend: l.prepend }"
                  :title="listenerDisabledForAgent(l.owner, ev.name)
                    ? (declOf(l.owner, ev.name)?.facet
                        ? `facet:${declOf(l.owner, ev.name)!.facet} 本 Agent 已停用（子键覆盖回落行为级）`
                        : '本 Agent 已软停用（settings[具名].enabled=false）')
                    : (l.prepend ? 'prepend：插队到链首' : '')"
                >
                  {{ l.owner }}{{ l.prepend ? ' ⏫' : '' }}
                  <span v-if="declOf(l.owner, ev.name)?.facet && !listenerDisabledForAgent(l.owner, ev.name)" class="evt-why">·{{ declOf(l.owner, ev.name)!.facet }}</span>
                  <span v-if="listenerDisabledForAgent(l.owner, ev.name)" class="evt-why">本 Agent 已停用</span>
                </span>
              </template>
            </div>
            <div v-if="ev.listeners.some((l) => !extOfOwner(l.owner)) || ev.listeners.some((l) => listenerRespectsEnabled(l.owner) === false)" class="evt-note">
              注：部分监听器属声明目录未覆盖的行、或未声明 respectsEnabled——「停用未必生效」（该行未承诺自查 enabled；agentGate 普及后自然收敛）。
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 扩展详情（弹窗信息面） -->
    <Modal :visible="!!detailExt" :title="detailExt ? detailExt.label + ' · ' + detailExt.name : ''" :width="460" :z-index="1200" @close="detailExt = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ detailExt?.description }}</div>
        <div class="ext-modal-meta" v-if="detailExt">
          装配行 <code>{{ detailExt.row }}</code>
          <template v-if="detailExt.targets.length">
            · 落点 <code v-for="t in detailExt.targets" :key="t" class="ext-modal-target">{{ t }}</code>
          </template>
          <template v-else>· 纯能力供给行</template>
        </div>
        <div class="ext-modal-status">
          当前状态：{{ detailExt?.automatic ? '基础设施（装载即生效，不可 per-Agent 停用）' : (detailExt && extEnabled(detailExt.name) ? '已启用' : '已停用') }}
        </div>
        <div class="ext-modal-none">
          per-Agent 参数（差异层）经「配置」弹窗编辑（只存差异项，空 = 继承全局默认；生效 = settingsOf 合成）。
        </div>
      </div>
      <template #footer>
        <Button v-if="detailExt && !detailExt.automatic && isEditable" variant="primary" @click="configEntry = detailExt; detailExt = null">配置（差异层）</Button>
        <Button variant="ghost" @click="detailExt = null">关闭</Button>
      </template>
    </Modal>

    <!-- 配置弹窗（差异层实例——M24 P4 双实例共享组件） -->
    <ExtensionSettingsModal
      :entry="configEntry"
      mode="agent"
      :agent-value="configEntry ? extConfigOf(configEntry.name) : {}"
      @close="configEntry = null"
      @patch="(name, next) => { onSettingsPatch(name, next); }"
    />

    <!-- 工具详情弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="!!toolDetail" :title="toolDetail ? (toolDetail.label || toolDetail.name) + ' · ' + toolDetail.name : ''" :width="440" :z-index="1200" @close="toolDetail = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ toolDetail?.description }}</div>
        <div class="ext-modal-status" v-if="toolDetail">
          {{ toolStatus(toolDetail.name) === 'auto' ? '默认启用（requires 门禁通过）' : toolStatus(toolDetail.name) === 'explicit' ? '已在 tools.include 显式启用' : '未启用（tools.exclude 或未开启）' }}
          <span v-if="toolDetail.requires && toolDetail.requires.length" class="ext-modal-tags">
            <span v-for="r in toolDetail.requires" :key="r" class="tool-tag" :class="{ on: hasTag(r), miss: !hasTag(r) }">{{ r }}</span>
          </span>
        </div>
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
/* P4 过滤开关条（按插件分组 / 仅显示有参数的插件） */
.ext-filter-bar { display: flex; align-items: center; gap: 14px; }
.ext-filter {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text-2); cursor: pointer; user-select: none;
}
.ext-filter input { accent-color: var(--primary); cursor: pointer; }
.ext-zone-title {
  margin-top: 8px; padding: 3px 0; font-size: 11px; color: var(--text-3);
  border-bottom: 1px dashed var(--line);
}

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
.hook-drag-off { color: var(--line-strong); font-size: 12px; flex-shrink: 0; }
.hook-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hook-name { font-size: 12px; font-weight: 500; color: var(--text-1); }
.hook-row.off .hook-name { color: var(--text-3); font-weight: 400; }
.hook-desc { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hook-toggle input { accent-color: var(--primary); cursor: pointer; }
.hook-toggle input:disabled { cursor: not-allowed; opacity: .5; }
.hook-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.hook-name-row .hook-name { white-space: nowrap; }

/* ── 徽章 ── */
.ext-id-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; flex-shrink: 0;
  font-family: var(--font-mono); color: var(--text-3); background: var(--bg-hover); white-space: nowrap;
}
.target-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px; flex-shrink: 0;
  color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); white-space: nowrap;
}
.target-badge.none { color: var(--text-3); background: var(--bg-hover); }
.cfg-badge {
  font-size: 10px; line-height: 1; padding: 2px 6px; border-radius: 999px; flex-shrink: 0;
  color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.plugin-source-badge, .plugin-version {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px;
  color: var(--text-3); background: var(--bg-hover); white-space: nowrap;
}
.plugin-source-badge.src-installed { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.plugin-source-badge.src-dev { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plugin-source-badge.src-session { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-load-badge {
  flex-shrink: 0; font-size: 10px; line-height: 1; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
  color: var(--text-2); background: var(--bg-hover); cursor: default;
}
.plugin-load-badge.installed { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.plugin-load-badge.session { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
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
.tool-badge { flex-shrink: 0; font-size: 10px; line-height: 1; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.tool-badge.auto { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.tool-badge.exp { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.tool-badge.off { color: var(--text-3); background: var(--bg-hover); }

/* ── 弹窗 ── */
.ext-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.ext-modal-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; }
.ext-modal-meta { font-size: 11px; color: var(--text-3); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ext-modal-meta code, .ext-modal-target {
  font-family: var(--font-mono); font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: var(--bg-hover); color: var(--text-2);
}
.ext-modal-status { font-size: 12px; color: var(--text-1); }
.ext-modal-cfg { border: 1px solid var(--line); border-radius: var(--r-md); padding: 8px 10px; background: var(--bg-base); display: flex; flex-direction: column; gap: 8px; }
.ext-modal-cfg-title { font-size: 12px; font-weight: 600; color: var(--text-1); }
.ext-modal-none { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.ext-field { display: flex; flex-direction: column; gap: 4px; }
.ext-field-label { font-size: 12px; color: var(--text-1); }
.ext-field-label code { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); background: var(--bg-hover); padding: 1px 6px; border-radius: 999px; }
.ext-field-bool input { accent-color: var(--primary); cursor: pointer; }
.ext-field-input {
  padding: 5px 9px; font-size: 12px; color: var(--text-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--input-bg, var(--bg-surface)); outline: none;
}
.ext-field-input:focus { border-color: var(--primary); }
.ext-field-input:disabled { opacity: .55; cursor: not-allowed; }
.ext-field-textarea { resize: vertical; font-family: var(--font-mono); }

/* ── 事件视图（本 Agent 生效链） ── */
.evt-card {
  border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
  padding: 8px 12px; display: flex; flex-direction: column; gap: 6px;
}
.evt-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.evt-name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-1); }
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
.evt-note { font-size: 11px; color: var(--warn); }
.evt-facet-tag {
  font-family: var(--font-mono); font-size: 10px; color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
  border-radius: 4px; padding: 0 5px;
}
</style>
