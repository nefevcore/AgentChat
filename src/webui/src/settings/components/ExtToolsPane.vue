<script setup lang="ts">
// ============================================================
// ExtToolsPane.vue —— Agent「装配」页（M22 P2 重构；M24 P4 目录同构；
// 2026-08-30 完全对齐插件库页——卡片解剖/左导航/事件树/工具参数表全部
// 复用 PluginLibraryPane 的形态与 .ui-row 公共底座；P11 收窄：
//   · 左侧导航 插件 | 工具 | 事件 三视图（pl-navitem 同规格）：
//     - 插件 = 差异层配置覆盖（插件库「插件」视图同款卡片 + 「只看可配置」
//       默认开；启停面移除——软停用走配置弹窗 enabled 字段）+ 动态装载只读区
//     - 工具 = include/exclude 三态 + 能力标签；详情弹窗参数表格化
//       （与插件库工具视图同款）
//     - 事件 = 本 Agent 生效链（插件库事件树同款：scope 根 → 事件 →
//       监听器叶；灰 = 本 Agent 软停用，facet 感知）
//   · 顺序编辑已删除（D3）：waterfall 执行序 = 监听器注册序，不可配置。
// ============================================================
import { ref, computed } from 'vue';
import type { ExtensionEntry, AgentToolInfo, PluginInfo, PluginPermissionsView, EventChainEntry, EventDescriptionEntry } from '../types';
import { Icon, Modal, Button } from '@/ui';
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

// ── 左侧导航（三视图——插件库 pl-navitem 同规格） ──
const selectedKind = ref<'ext' | 'tool' | 'event'>('ext');
function pick(kind: 'ext' | 'tool' | 'event'): void {
  selectedKind.value = kind;
}

// ── 事件落点徽章（已知落点 → 人类标签；A1 注册制后落点自由生长，未知回落原文） ──
const TARGET_LABELS: Partial<Record<string, string>> = {
  'loop/before-run': '运行前',
  'tool/before-execute': '工具前',
  'tool/transform-result': '结果变换',
  'loop/transform-run': '运行变换',
  'loop/after-run': '运行后',
};
function targetLabel(t: string): string {
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
    return { text: '会话级·已装载', cls: 'session', title: '会话级装载（重启即失）；卸载在插件库「目录 · 插件 · 本地」组' };
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

// ── 扩展（P11：对齐插件库「插件」视图——只保留差异层配置覆盖） ──
// 启停面移除：软停用经配置弹窗的 enabled 字段（声明了 enabled 的行）；
// 进程级启停在插件库。本页 = 参数差异层编辑 + 只读目录。
const onlyConfigurable = ref(true);
function extHasParams(e: ExtensionEntry): boolean {
  return (e.fields?.length ?? 0) > 0;
}
const configurableCount = computed(() => props.extensions.filter((e) => extHasParams(e)).length);
/** 可见清单 = 搜索命中 ∩（默认）只看可配置；基础设施行混排（虚线 + 徽章标注） */
const visibleExts = computed(() => {
  const list = props.extensions.filter((e) =>
    matchesQuery(extQuery.value, e.name, e.label, e.description),
  );
  return onlyConfigurable.value ? list.filter((e) => extHasParams(e)) : list;
});
function extConfigOf(name: string): Record<string, unknown> {
  const cfg = props.decl?.settings?.[name];
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg)
    ? { ...(cfg as Record<string, unknown>) }
    : {};
}

// ── 扩展配置弹窗（配置弹窗双实例 · 差异层——M24 P4 共享组件） ──
// 对齐插件库卡片交互：有参数的卡片点击直接弹配置（差异层），不再两段跳
const configEntry = ref<ExtensionEntry | null>(null);
function openCardConfig(e: ExtensionEntry): void {
  if (extHasParams(e)) configEntry.value = e;
}
/** 差异层补丁（ExtensionSettingsModal agent 模式回调；null = 删除该 name 配置） */
function onSettingsPatch(name: string, next: Record<string, unknown> | null): void {
  if (!isEditable.value) return;
  props.onDecl!({ settings: { [name]: next } });
}

// ── 本 Agent 生效链（事件视图：插件库事件树同款 × settings 门控态） ──
/** 监听器 owner（fiber/行名）→ 扩展目录条目（settings 键锚点） */
function extOfOwner(owner: string): ExtensionEntry | undefined {
  return props.extensions.find((e) => e.row === owner || e.name === owner);
}
/** owner::event 的声明（facet 感知） */
function declOf(owner: string, event: string): EventDescriptionEntry | undefined {
  return (props.eventDescriptions ?? []).find((d) => d.owner === owner && d.event === event);
}
/** 叶节点描述：注册自述优先，声明目录 role 兜底（插件库同款） */
function listenerDesc(l: { owner: string; description?: string }, event: string): string {
  return l.description ?? declOf(l.owner, event)?.role ?? '';
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
/** @scope 判定式（前端推断，与 owning 包 JSDoc / 插件库同口径） */
function scopeOfEvent(name: string): 'run' | 'host' {
  if (/^(loop|tool|router|llm)\//.test(name) || name === 'conversation/steered') return 'run';
  return 'host';
}
const runEvents = computed(() => agentEventChains.value.filter((e) => scopeOfEvent(e.name) === 'run'));
const hostEvents = computed(() => agentEventChains.value.filter((e) => scopeOfEvent(e.name) === 'host'));
/** 树开合（插件库事件树同款：scope 根默认展开；事件节点默认收拢） */
const evtCollapsed = ref(new Set<string>());
function toggleEvtNode(key: string): void {
  const next = new Set(evtCollapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  evtCollapsed.value = next;
}
const EVT_SCOPE_ROOTS = [
  { key: '@run', label: 'run', hint: '发生在某 Agent 执行上下文内（本 Agent 可经 settings 软停用）', list: runEvents },
  { key: '@host', label: 'host', hint: '宿主/进程生命周期（本 Agent 不可门控——进程级治理在插件库 · 事件）', list: hostEvents },
];

// ── 搜索过滤（ID / 显示名 / 描述，不区分大小写） ──
const extQuery = ref('');
const toolQuery = ref('');
function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(q));
}
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
  if (t && (t.requiredTags?.length ?? 0) > 0 && canAddTool(t)) return 'auto';
  return 'off';
}
function canAddTool(t: AgentToolInfo): boolean {
  if (!t.requiredTags || t.requiredTags.length === 0) return true;
  const tags = new Set(['base', ...(props.tags ?? []).map(tag => tag === 'agent' ? 'base' : tag), ...(props.agentId ? ['agent:' + props.agentId] : [])]);
  return t.requiredTags.every(r => tags.has(r));
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
    // requiredTags 为空的工具无默认启用：必须写入 include 显式开启
    if ((!t.requiredTags || t.requiredTags.length === 0) && !include.includes(name)) include = [...include, name];
  } else {
    include = include.filter(n => n !== name);
    exclude = exclude.includes(name) ? exclude : [...exclude, name];
  }
  props.onDecl!({ tools: { include, exclude } });
}

// ── 工具详情弹窗（插件库工具视图同款：参数表格化——JSON Schema object 形状） ──
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
</script>

<template>
  <div class="ext-pane">
    <div class="ext-layout">
      <!-- 左侧导航（三视图——插件库 pl-navitem 同规格） -->
      <div class="ext-side">
        <button class="ext-side-item" :class="{ active: selectedKind === 'ext' }" @click="pick('ext')">
          <span>插件</span><span class="ext-side-count">{{ extensions.length }}</span>
        </button>
        <button class="ext-side-item" :class="{ active: selectedKind === 'tool' }" @click="pick('tool')">
          <span>工具</span><span class="ext-side-count">{{ tools.catalog.length }}</span>
        </button>
        <button class="ext-side-item" :class="{ active: selectedKind === 'event' }" @click="pick('event')">
          <span>事件</span><span class="ext-side-count">{{ agentEventChains.length }}</span>
        </button>
      </div>

      <!-- 右侧主区（独立滚动——插件库 pl-pane 同构） -->
      <div class="ext-main">
        <!-- ▸ 视图：插件（P11：对齐插件库「插件」视图——纯差异层配置覆盖，无启停面） -->
        <template v-if="selectedKind === 'ext'">
          <div class="ext-anno">
            点击带 ⚙ 的卡片编辑本 Agent 差异层（只存差异项，空 = 继承全局默认；生效 = settingsOf 合成，差异优先）。软停用 = 配置弹窗内 enabled 字段（声明该字段的行）；进程级启停在插件库。
          </div>
          <div class="ext-filter-bar">
            <input v-model="extQuery" class="ext-search" type="search" placeholder="搜索插件 / settings 键 / 描述" />
            <label class="ext-check" title="只显示带可配置参数（fields 非空）的插件——快速定位 ⚙ 可配置项">
              <input v-model="onlyConfigurable" type="checkbox" />只看可配置
            </label>
          </div>

          <!-- 插件区（插件库内置组同款卡片：名称/键徽章/⚙/落点徽章 + 描述；基础设施行虚线混排） -->
          <div class="ext-zone-title">
            插件（{{ onlyConfigurable ? `${visibleExts.length} / ` : '' }}{{ extensions.length }}）—— 点击 ⚙ 卡片配置（本 Agent 差异层）
          </div>
          <div v-if="extensions.length === 0" class="ext-empty">暂无扩展（扩展目录随行装载增删）</div>
          <div v-else-if="visibleExts.length === 0" class="ext-empty">无命中「只看可配置」的插件（{{ configurableCount }}/{{ extensions.length }} 项带配置面）——取消勾选查看全部</div>
          <div
            v-for="e in visibleExts" :key="'e-' + e.name"
            class="plugin-item ui-row"
            :class="{ clickable: extHasParams(e), 'is-auto': e.automatic === true }"
            :title="extHasParams(e) ? '点击卡片配置（本 Agent 差异层）' : ''"
            @click="openCardConfig(e)"
          >
            <div class="plugin-info">
              <div class="plugin-title-row">
                <!-- P12 统一卡片命名：主名 = 人类可读标签，ID 徽章 = 装配行包名
                     （与插件库同锚点）；settings 键（配置锚点）进 tooltip -->
                <span class="plugin-name">{{ e.label }}</span>
                <span v-if="e.row !== e.label" class="plugin-version" :title="`AgentConfig.settings 键：${e.name}（装配行 ${e.row}）`">{{ e.row }}</span>
                <span v-if="extHasParams(e)" class="plugin-cfg-badge">⚙ 可配置</span>
                <span v-if="e.automatic" class="plugin-state-badge auto" title="基础设施行：自动进入每个 run，装载即生效">基础设施</span>
                <span v-for="t in e.targets" :key="t" class="plugin-state-badge dim" :title="`事件落点：${t}`">{{ targetLabel(t) }}</span>
                <span v-if="e.targets.length === 0" class="plugin-state-badge dim" title="纯能力供给行（非事件拦截）">能力供给</span>
              </div>
              <div class="plugin-desc">{{ e.description }}</div>
            </div>
          </div>

          <!-- 动态装载插件（只读徽章；启停/卸载在插件库） -->
          <template v-if="filteredDynPlugins.length > 0">
            <div class="ext-zone-title">动态装载（{{ filteredDynPlugins.length }}）—— 只读；启停与卸载在插件库</div>
            <div
              v-for="p in filteredDynPlugins" :key="'p-' + p.name"
              class="plugin-item ui-row"
              :title="p.description ?? p.name"
            >
              <div class="plugin-info">
                <div class="plugin-title-row">
                  <span class="plugin-name">{{ p.label || p.name }}</span>
                  <span class="plugin-version" :title="`插件 ID（manifest.name）：${p.name}`">{{ p.name }}</span>
                  <span v-if="p.version" class="plugin-version">v{{ p.version }}</span>
                  <span class="plugin-state-badge dim" :title="`来源：${SOURCE_LABELS[p.source] ?? p.source}`">{{ SOURCE_LABELS[p.source] ?? p.source }}</span>
                  <span v-for="b in permissionBadges(p)" :key="b.text" class="plugin-state-badge dim" :class="b.cls === 'granted' ? 'on' : b.cls === 'required' ? 'warn' : ''" :title="b.title">{{ b.text }}</span>
                </div>
                <div class="plugin-desc">
                  {{ p.description }}
                  <span v-if="permissionMissing(p).length" class="plugin-meta">声明但未授予：{{ permissionMissing(p).join(', ') }}（重启后可能加载失败）</span>
                </div>
              </div>
              <div class="plugin-actions">
                <span class="plugin-state-badge" :class="pluginBadge(p).cls === 'installed' ? 'on' : pluginBadge(p).cls === 'session' ? 'session' : 'dim'" :title="pluginBadge(p).title">{{ pluginBadge(p).text }}</span>
              </div>
            </div>
          </template>
        </template>

        <!-- ▸ 视图：工具（插件库工具视图同款卡片 + 参数表详情弹窗 + 意图开关） -->
        <template v-else-if="selectedKind === 'tool'">
          <div class="ext-anno">
            工具按能力标签门禁默认提供；开关写 tools.include / tools.exclude（exclude 优先）。点击卡片看参数表。
          </div>
          <div class="ext-filter-bar">
            <input v-model="toolQuery" class="ext-search" type="search" placeholder="搜索工具 ID / 名称 / 描述" />
          </div>
          <div class="ext-zone-title">工具目录（{{ filteredTools.length }}{{ filteredTools.length !== tools.catalog.length ? ` / ${tools.catalog.length}` : '' }}）—— 详情看参数表；启停 = 本 Agent 工具意图</div>
          <div v-if="tools.catalog.length === 0" class="ext-empty">暂无可用工具</div>
          <div v-else-if="filteredTools.length === 0" class="ext-empty">没有匹配「{{ toolQuery }}」的工具</div>
          <div
            v-for="t in filteredTools" :key="'t-' + t.name"
            class="plugin-item ui-row clickable"
            :class="{ inactive: toolStatus(t.name) === 'off' }"
            @click="toolDetail = t"
          >
            <div class="plugin-info">
              <div class="plugin-title-row">
                <span class="plugin-name">{{ t.label || t.name }}</span>
                <span v-if="t.label && t.label !== t.name" class="plugin-version" :title="`工具 ID（注册名，config.tools 引用的名字）：${t.name}`">{{ t.name }}</span>
                <span
                  v-for="r in t.requiredTags ?? []" :key="r"
                  class="plugin-state-badge dim" :class="hasTag(r) ? 'tag-on' : 'tag-miss'"
                  :title="hasTag(r) ? '已具备此能力标签' : '缺少此能力标签，无法启用（补标签 = Agent tags）'"
                >{{ r }}</span>
                <span v-if="toolDisabled(t.name)" class="plugin-state-badge off" title="已停用（tools.exclude，本 Agent 差异层）">已停用</span>
                <span v-else-if="toolStatus(t.name) === 'auto'" class="plugin-state-badge dim" title="默认启用（能力标签门禁通过）">默认</span>
                <span v-else-if="toolStatus(t.name) === 'explicit'" class="plugin-state-badge on" title="已在 tools.include 显式启用">显式</span>
              </div>
              <div class="plugin-desc">{{ t.description }}</div>
            </div>
            <div class="plugin-actions" @click.stop>
              <label
                class="ui-switch"
                :title="!isEditable ? '' : toolStatus(t.name) === 'off' ? (!canAddTool(t) ? '缺少所需能力标签' : '启用工具') : '停用工具（写入 tools.exclude）'"
              >
                <input
                  type="checkbox"
                  :checked="toolStatus(t.name) !== 'off'"
                  :disabled="toolToggleDisabled(t)"
                  @change="toggleTool(t.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="ui-switch-track"><span class="ui-switch-dot" /></span>
              </label>
            </div>
          </div>
        </template>

        <!-- ▸ 视图：事件（本 Agent 生效链——插件库事件树同款 × settings 门控态） -->
        <template v-else>
          <div class="ext-zone-title">
            生效链（{{ runEvents.length }} run + {{ hostEvents.length }} host）——
            灰 = 本 Agent 软停用（settingsOf 门控，分发时跳过、链继续）
          </div>
          <div class="evt-tree">
            <template v-for="root in EVT_SCOPE_ROOTS" :key="root.key">
              <div class="evt-scope-node" :class="root.key === '@run' ? 'run' : 'host'" :title="root.hint" @click="toggleEvtNode(root.key)">
                <span class="evt-caret"><Icon :name="evtCollapsed.has(root.key) ? 'chevron-right' : 'chevron-down'" :size="14" /></span>
                <span class="evt-row-name">@scope {{ root.label }}</span>
                <span class="evt-row-count">{{ root.list.value.length }}</span>
              </div>
              <template v-if="!evtCollapsed.has(root.key)">
                <template v-for="ev in root.list.value" :key="root.key + ev.name">
                  <div class="evt-node" @click="toggleEvtNode(ev.name)">
                    <span class="evt-caret"><Icon :name="evtCollapsed.has(ev.name) ? 'chevron-right' : 'chevron-down'" :size="14" /></span>
                    <span class="evt-row-name">{{ ev.name }}</span>
                    <span class="evt-row-count">{{ ev.listeners?.length ?? 0 }} 监听</span>
                    <span v-if="(ev.listeners ?? []).some((l) => l.prepend)" class="evt-pre-badge" title="链首有 prepend 监听器（插队执行）">prepend</span>
                  </div>
                  <div v-if="!evtCollapsed.has(ev.name)" class="evt-leaves">
                    <div
                      v-for="(l, i) in ev.listeners" :key="i"
                      class="evt-leaf"
                      :class="{ dim: listenerDisabledForAgent(l.owner, ev.name) }"
                      :title="listenerDisabledForAgent(l.owner, ev.name)
                        ? (declOf(l.owner, ev.name)?.facet
                            ? `facet:${declOf(l.owner, ev.name)!.facet} 本 Agent 已停用（子键覆盖回落行为级）`
                            : '本 Agent 已软停用（settings[具名].enabled=false）')
                        : (l.prepend ? 'prepend：插队到链首' : '')"
                    >
                      <span class="evt-leaf-icon"><Icon name="activity" :size="13" /></span>
                      <span class="evt-leaf-owner">{{ l.owner }}</span>
                      <span class="evt-leaf-desc">{{ listenerDesc(l, ev.name) }}</span>
                      <span v-if="l.prepend" class="evt-leaf-tag">prepend</span>
                      <span v-if="declOf(l.owner, ev.name)?.facet" class="evt-leaf-tag" :title="`facet 切面（settings[名][facet].enabled ?? enabled）`">facet:{{ declOf(l.owner, ev.name)!.facet }}</span>
                      <span v-if="listenerDisabledForAgent(l.owner, ev.name)" class="evt-leaf-tag off">本 Agent 已停用</span>
                    </div>
                    <div v-if="!ev.listeners?.length" class="evt-leaf-empty">零监听器</div>
                  </div>
                </template>
                <div v-if="root.list.value.length === 0" class="ext-empty">暂无 {{ root.label }} 域事件</div>
              </template>
            </template>
          </div>
          <div class="ext-anno">
            粒度边界：per-Agent 停到「行为 / facet」为止——本页无事件粒度开关，owner::event 进程级治理在插件库 · 目录 · 事件。
            <template v-if="agentEventChains.some((ev) =>
              ev.listeners.some((l) => !extOfOwner(l.owner)) ||
              ev.listeners.some((l) => listenerRespectsEnabled(l.owner) === false))">
              注：部分监听器属声明目录未覆盖的行、或未声明 respectsEnabled——「停用未必生效」（该行未承诺自查 enabled；agentGate 普及后自然收敛）。
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- 配置弹窗（差异层实例——M24 P4 双实例共享组件；卡片点击直达） -->
    <ExtensionSettingsModal
      :entry="configEntry"
      mode="agent"
      :agent-value="configEntry ? extConfigOf(configEntry.name) : {}"
      @close="configEntry = null"
      @patch="(name, next) => { onSettingsPatch(name, next); }"
    />

    <!-- 工具详情弹窗（插件库工具视图同款：结构化头部 + 参数表；非标准 schema 回落原文） -->
    <Modal :visible="!!toolDetail" :title="toolDetail ? (toolDetail.label || toolDetail.name) + ' · 工具详情' : ''" :width="560" :z-index="1200" @close="toolDetail = null">
      <div class="ext-modal-body">
        <div class="ext-modal-desc">{{ toolDetail?.description }}</div>
        <div v-if="toolDetail?.requiredTags?.length" class="tool-meta-row">
          <span class="tool-meta-label">能力标签</span>
          <span
            v-for="r in toolDetail.requiredTags" :key="r"
            class="plugin-state-badge dim" :class="hasTag(r) ? 'tag-on' : 'tag-miss'"
            :title="hasTag(r) ? '已具备此能力标签' : '缺少此能力标签（调用方能力集 base ∪ tags ∪ agent:<id> 须全含）'"
          >{{ r }}</span>
        </div>
        <div class="tool-meta-row">
          <span class="tool-meta-label">本 Agent 状态</span>
          <span class="plugin-state-badge" :class="toolStatus(toolDetail?.name ?? '') === 'explicit' ? 'on' : toolStatus(toolDetail?.name ?? '') === 'off' ? 'off' : 'dim'">
            {{ toolStatus(toolDetail?.name ?? '') === 'auto' ? '默认启用（能力标签门禁通过）' : toolStatus(toolDetail?.name ?? '') === 'explicit' ? 'tools.include 显式启用' : '未启用（tools.exclude 或未开启）' }}
          </span>
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
          <pre class="ext-schema">{{ JSON.stringify(toolDetail?.parameters ?? {}, null, 2) }}</pre>
        </template>
        <div class="ext-anno">「能力标签」与调用方能力集交叉（base ∪ tags ∪ agent:&lt;id&gt;，AND 语义）；「必填」指模型调用时参数必给——两者是不同的门。</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="toolDetail = null">关闭</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ── 根布局（:global——scoped 不命中组件自身根，唯一使用者无冲突） ── */
:global(.ext-pane) { display: flex; flex-direction: column; gap: 10px; height: 100%; flex: 1; min-height: 0; }
/* 左导航固定 + 右面板独立滚动（插件库 pl-catalog/pl-leftnav/pl-navitem 同规格） */
.ext-layout { display: flex; gap: 14px; min-height: 0; flex: 1; height: 100%; align-items: stretch; }
.ext-side { width: 128px; flex: none; display: flex; flex-direction: column; gap: 3px; align-self: flex-start; }
.ext-side-item {
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  padding: 7px 11px; border-radius: var(--r-md); border: 1px solid transparent;
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.ext-side-item:hover { background: var(--bg-hover); }
.ext-side-item.active { background: var(--bg-surface); color: var(--text-1); font-weight: 500; border-color: var(--line-strong); }
.ext-side-count { font-size: 10px; color: var(--text-3); background: var(--bg-hover); padding: 0 6px; border-radius: var(--r-full); }
.ext-main { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }

/* ── 过滤行 / 搜索（插件库 pl-filter-row + mkt-input 同规格） ── */
.ext-filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ext-search {
  flex: 1; min-width: 160px; max-width: 260px; padding: 5px 10px;
  border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: var(--bg-surface); color: var(--text-1); font-size: 12px; outline: none;
}
.ext-search:focus { border-color: var(--primary); }
.ext-check {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--text-2); cursor: pointer; user-select: none; white-space: nowrap;
}
.ext-check input { accent-color: var(--primary); cursor: pointer; }
.ext-check:hover { color: var(--text-1); }
.ext-anno { font-size: 11px; color: var(--text-3); line-height: 1.7; }
.ext-empty { text-align: center; padding: 18px; color: var(--text-3); font-size: 12px; }
.ext-zone-title {
  margin-top: 6px; padding: 3px 0; font-size: 11px; color: var(--text-3);
  border-bottom: 1px dashed var(--line);
}

/* ── 卡片解剖（插件库 plugin-item 家族同款——底座 .ui-row 在 ui/row.css） ── */
.plugin-item { padding: 8px 12px; }
.plugin-item.clickable { cursor: pointer; }
.plugin-item.inactive { opacity: .6; }
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
.plugin-state-badge.auto { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-state-badge.session { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-state-badge.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.plugin-state-badge.tag-on { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plugin-state-badge.tag-miss { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); }
.plugin-state-badge.dim { color: var(--text-3); background: var(--bg-hover); }
.plugin-meta { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
.plugin-desc {
  font-size: 11px; color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.plugin-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-shrink: 0; }

/* ── 事件树（插件库事件视图同款——run/host 根 → 事件 → 监听器叶） ── */
.evt-tree { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.evt-scope-node, .evt-node {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px;
  border-radius: var(--r-md); border: 1px solid transparent;
  cursor: pointer; user-select: none;
  transition: background var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.evt-scope-node { margin-top: 6px; }
.evt-node { padding-left: 22px; }
.evt-scope-node:hover, .evt-node:hover {
  background: var(--bg-hover); border-color: var(--line-strong);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .05);
}
.evt-caret { display: flex; align-items: center; justify-content: center; width: 16px; flex: none; color: var(--text-3); }
.evt-row-name {
  font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-1);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.evt-node .evt-row-name { font-size: 11.5px; font-weight: 500; }
.evt-scope-node.run .evt-row-name { color: var(--primary); }
.evt-scope-node.host .evt-row-name { color: var(--warn); }
.evt-row-count {
  font-size: 10px; color: var(--text-3); background: var(--bg-hover);
  padding: 1px 7px; border-radius: 999px; font-family: var(--font-mono); flex: none;
}
.evt-pre-badge { font-size: 10px; color: var(--warn); white-space: nowrap; flex: none; }
.evt-leaves { display: flex; flex-direction: column; gap: 2px; padding: 0 8px 6px 38px; }
.evt-leaf {
  display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 8px;
  border-radius: var(--r-md); border: 1px solid transparent;
  transition: background var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.evt-leaf:hover {
  background: var(--bg-hover); border-color: var(--line-strong);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .05);
}
.evt-leaf-icon { display: flex; align-items: center; justify-content: center; width: 16px; flex: none; color: var(--text-3); }
.evt-leaf.dim .evt-leaf-icon { opacity: .5; }
.evt-leaf.dim .evt-leaf-owner { text-decoration: line-through; opacity: .5; }
.evt-leaf-owner {
  font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text-1);
  white-space: nowrap; flex: none;
}
.evt-leaf-desc { font-size: 11px; color: var(--text-3); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.evt-leaf-tag {
  font-size: 10px; color: var(--primary); font-family: var(--font-mono); white-space: nowrap; flex: none;
}
.evt-leaf-tag.off { color: var(--err); }
.evt-leaf-empty { font-size: 11px; color: var(--text-3); padding: 3px 8px; }

/* ── 工具详情弹窗（插件库同款：结构化头部 + 参数表） ── */
.ext-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.ext-modal-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; }
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
.tp-type { font-family: var(--font-mono); color: var(--text-2); white-space: nowrap; }
.tp-enum { color: var(--text-2); font-size: 10px; }
.tp-req { color: var(--warn); font-weight: 500; white-space: nowrap; }
.tp-default { font-family: var(--font-mono); color: var(--text-2); white-space: nowrap; }
.tp-desc { line-height: 1.5; color: var(--text-2); }
.ext-schema {
  margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg-base); color: var(--text-2);
  font-family: var(--font-mono); font-size: 11px; line-height: 1.6;
  overflow: auto; white-space: pre-wrap; word-break: break-all;
}
</style>
