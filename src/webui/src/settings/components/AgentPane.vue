<script setup lang="ts">
// ============================================================
// AgentPane.vue —— Agent 配置（tabs：基本信息 / 模型 / 定时任务 / 插件配置）
// 「插件配置」（原「装配」，2026-10 与插件库页签统一命名）：扩展行为/差异层
// + 工具意图——与插件库「插件配置」同词汇（软停用 per-Agent 覆盖）；
// 沙箱白名单（settings.security.allowedPaths）的配置入口也在此
// （security 扩展卡片——原「安全」页签已收口并入）。
// 展示读 effective（后端解析），编辑写 raw（差异）
// ============================================================
import { ref, computed, watch } from 'vue';
import type { FieldMeta, TimerEntry, AssemblyData, AssemblyPatch, ExtensionEntry, PluginInfo, PluginPermissionsView, EventChainEntry, EventDescriptionEntry } from '../types';
import type { AgentBrief } from '../useSettings';
import { toFields, filterFields } from '../schema';
import { Icon } from '@/ui';
import SettingField from './SettingField.vue';
import TimerPane from './TimerPane.vue';
import ExtToolsPane from './ExtToolsPane.vue';
import { fetchAgentModels, fetchLlmProviders, uploadAvatar, deleteAvatar, poolModelEntries, type LlmProviderStat } from '../../api/roster';
import { sortedAgentSettingsTabs, resolveTabProps } from '@/core/extensions/slots';

const props = defineProps<{
  agentId: string;
  agents: AgentBrief[];
  raw: Record<string, any>;
  effective: Record<string, any>;
  sysContent: string; sysEnabled: boolean;
  agentContent: string; agentEnabled: boolean;
  timers: TimerEntry[];
  assembly: AssemblyData | null;
  assemblyError?: string;
  /** 扩展目录（plugin/extension-catalog × rows；「装配」页数据源） */
  extensions: ExtensionEntry[];
  plugins: PluginInfo[];
  permissions: PluginPermissionsView | null;
  /** 事件执行链（M24 P4：装配 · 事件视图 = 本 Agent 生效链数据源） */
  eventChains?: EventChainEntry[];
  /** 事件描述声明（M25 P2：facet 感知灰显） */
  eventDescriptions?: EventDescriptionEntry[];
  llmSchemas: Record<string, any[]>;
  searchSchemas: Record<string, any[]>;
  pools: { llmProviders: Record<string, any>; searchProviders: Record<string, any> };
  saving?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:raw', v: Record<string, any>): void;
  (e: 'update:sysContent', v: string): void;
  (e: 'update:sysEnabled', v: boolean): void;
  (e: 'update:agentContent', v: string): void;
  (e: 'update:agentEnabled', v: boolean): void;
  (e: 'update:timers', v: TimerEntry[]): void;
  (e: 'switch', agentId: string): void;
  (e: 'back'): void;
  (e: 'saveTimers'): void;
  (e: 'avatar-changed', agentId: string, present: boolean): void;
}>();

const tab = ref<string>('info');
const llmModelsError = ref('');
const llmModelOptions = ref<string[]>([]);
/** Provider 注册面快照（llm/providers；模型页签 provider/模型选择器数据源） */
const llmStats = ref<LlmProviderStat[]>([]);
/** 切换 Agent（上/下导航）时保持当前页签选择，仅重置本地派生状态：
 *  llmModelOptions 若不重置，B Agent 的模型下拉会显示 A 的 provider
 *  拉取的模型列表（UI 级串台）。返回列表再进入 = 组件重挂载，页签自然
 *  回到基本信息 */
watch(() => props.agentId, () => {
  llmModelOptions.value = [];
  llmModelsError.value = '';
  // 停留模型页签时重建清单：同 provider 切换 watch(llmProvider) 不触发，
  // 解锁 tried 后手动补拉（有池发现缓存即短路，不重复请求）
  if (tab.value === 'llm') {
    llmModelsAutoTried.delete(llmProvider.value);
    void ensureLlmModels();
  }
});

// ── 插件 Agent 设置页签（settings-tab:agent slot） ──
const pluginTab = computed(() => sortedAgentSettingsTabs.value.find(t => t.id === tab.value) ?? null);
const pluginTabProps = computed<Record<string, unknown>>(() => {
  const t = pluginTab.value;
  if (!t) return {};
  return resolveTabProps(t, {
    agentId: props.agentId,
    raw: props.raw,
    effective: props.effective,
    emit,
  });
});

// ── 顶部导航：Agent 名 + 上/下切换 ──
const agentName = computed(() => (props.raw.name ?? props.effective.name ?? props.agentId) as string);
const agentIndex = computed(() => props.agents.findIndex(a => a.id === props.agentId));
const prevAgent = computed(() => (agentIndex.value > 0 ? props.agents[agentIndex.value - 1] : null));
const nextAgent = computed(() => (agentIndex.value >= 0 && agentIndex.value < props.agents.length - 1 ? props.agents[agentIndex.value + 1] : null));

// ── 装配声明（M22 P2 + M24 X1）：tools/settings（具名设置对象）两字段 patch ──
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? (v.filter((x): x is string => typeof x === 'string')) : [];
}
function toolOverridesOf(v: unknown): { include: string[]; exclude: string[] } {
  if (Array.isArray(v)) return { include: strArray(v), exclude: [] };
  if (v && typeof v === 'object') {
    return { include: strArray((v as Record<string, any>).include), exclude: strArray((v as Record<string, any>).exclude) };
  }
  return { include: [], exclude: [] };
}
function settingsConfigsOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}
const decl = computed(() => ({
  tools: toolOverridesOf(props.raw.tools),
  settings: settingsConfigsOf(props.raw.settings),
}));
/** settings per-name 浅合并 / null 删除（服务端语义——M22 D5） */
function patchDecl(patch: AssemblyPatch): void {
  emit('update:raw', {
    ...props.raw,
    tools: {
      include: patch.tools?.include ?? decl.value.tools.include,
      exclude: patch.tools?.exclude ?? decl.value.tools.exclude,
    },
    settings: { ...decl.value.settings, ...(patch.settings ?? {}) },
  });
}
// ── 模型配置（effective 展示 / raw 编辑） ──
const llmEffective = computed<Record<string, any>>(() => {
  const raw = props.effective.llm;
  if (!raw) return {};
  if (typeof raw === 'string') return { $ref: raw };
  return raw;
});
const llmRaw = computed<Record<string, any>>(() => {
  const raw = props.raw.llm;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
});
/** 当前 provider：raw 显式 > effective > 注册面首个（无连接 = 空） */
const llmProvider = computed(() => {
  const p = llmRaw.value.provider || llmEffective.value.provider;
  if (p) return p as string;
  return llmStats.value[0]?.name ?? '';
});
/** 字段表：任意 provider 共用一份（连接字段已收敛；按名取不到时回落首表） */
const llmFields = computed<FieldMeta[]>(() => {
  const schemas = props.llmSchemas;
  return toFields(schemas[llmProvider.value] ?? schemas[Object.keys(schemas)[0] ?? ''] ?? []);
});
const llmFiltered = computed(() => filterFields(llmFields.value, llmRaw.value, ''));

// 模型参数分组：采样 / 边界 / 推理
// 移除：logprobs / top_logprobs / tool_choice（工具默认 auto，无需配置）；
// thinking（「思考输出」勾选退役——由「推理力度=无」替代：'none' 在投递
// 边界翻译为 thinking disabled）
const HIDDEN_LLM_KEYS = new Set(['logprobs', 'top_logprobs', 'tool_choice']);
const LLM_GROUPS: { label: string; fields: string[] }[] = [
  { label: '推理', fields: ['reasoning_effort'] },
  { label: '采样', fields: ['temperature', 'top_p'] },
  { label: '边界', fields: ['max_tokens', 'stop', 'response_format'] },
];
const llmVisible = computed(() => llmFiltered.value.filter(f => !HIDDEN_LLM_KEYS.has(f.key)));
const llmBasic = computed(() => llmVisible.value.filter(f => !LLM_GROUPS.some(g => g.fields.includes(f.key))));
/** 扁平化渲染序列：provider 选择 → 基础字段 → 分组标题 → 分组字段 */
const llmSections = computed(() => {
  const sections: Array<{ type: 'provider' } | { type: 'title'; label: string } | { type: 'field'; f: FieldMeta }> = [
    { type: 'provider' },
    ...llmBasic.value.map(f => ({ type: 'field' as const, f })),
  ];
  for (const g of LLM_GROUPS) {
    const fields = llmVisible.value.filter(f => g.fields.includes(f.key));
    if (fields.length === 0) continue;
    sections.push({ type: 'title', label: g.label });
    sections.push(...fields.map(f => ({ type: 'field' as const, f })));
  }
  return sections;
});

/** 进模型页签即拉注册面（provider 清单 + 发现缓存），随后自动补拉模型
 *  清单；失败静默（下拉回落池条目/发现缓存） */
watch(tab, (t) => {
  if (t === 'llm') void refreshLlmStats().then(() => ensureLlmModels());
}, { immediate: true });
/** 切换 provider（含注册面快照到位后的回填）→ 自动补拉新连接的清单 */
watch(llmProvider, (p) => {
  if (p && tab.value === 'llm') void ensureLlmModels();
});
async function refreshLlmStats(): Promise<void> {
  try {
    const r = await fetchLlmProviders();
    llmStats.value = r.stats;
  } catch { /* ignore */ }
}

/** 已尝试自动读取的 provider（每连接一次——ChatInput ensureDiscovered 同款防抖） */
const llmModelsAutoTried = new Set<string>();
/** 所选连接是否已有模型清单来源（池发现缓存 ∪ 本地读取；不含当前值保显） */
function hasModelSource(): boolean {
  const cached = props.pools.llmProviders[llmProvider.value]?.models;
  return (Array.isArray(cached) && cached.length > 0) || llmModelOptions.value.length > 0;
}
/** 模型清单自动读取（llm/models 真 /models 代理：后端附加 pool:<name> 凭据；
 *  「读取」按钮退役后的唯一清单来源——无缓存才拉、静默失败） */
async function ensureLlmModels(): Promise<void> {
  const provider = llmProvider.value;
  if (!provider || llmModelsAutoTried.has(provider) || hasModelSource()) return;
  llmModelsAutoTried.add(provider);
  try {
    const data = await fetchAgentModels(provider, true);
    if (data.models?.length) {
      llmModelOptions.value = data.models;
      llmModelsError.value = '';
      // 本地注册面同步（发现缓存已回写 config → 热更重挂，下次拉取自然带出）
      const stat = llmStats.value.find((s) => s.name === provider);
      if (stat) stat.models = data.models;
      else llmStats.value.push({ name: provider, models: data.models });
    } else {
      llmModelsError.value = '未获取到模型清单（连接不可用或未配置凭据）';
    }
  } catch {
    llmModelsError.value = '模型清单读取失败（连接不可用或未配置凭据）';
  }
}

/** 所选 provider 的模型选项——【只列真实存在的模型】：池条目发现缓存
 *  （/models 拉取回写 config 的清单）∪ 本地读取结果 ∪ 当前值（保显）。
 *  静态缺省清单（注册面 meta.models）不进选项——调不通的模型选了没意义。
 *  【能力元数据】宽容双形态归一 + hidden 过滤（当前值保显不受隐藏影响）。 */
const llmModelOptionsMerged = computed(() => {
  const cached = poolModelEntries(props.pools.llmProviders[llmProvider.value]?.models);
  const list = [
    ...cached.filter((e) => e.hidden !== true).map((e) => e.model),
    ...llmModelOptions.value,
  ];
  const cur = getLLM('model');
  if (typeof cur === 'string' && cur && !list.includes(cur)) list.push(cur);
  return [...new Set(list)];
});

/** 选择 provider：写 raw.llm.provider；当前模型不在新 provider 的发现
 *  清单 → 自动换成其首个已发现模型（避免 provider/model 错配；无清单
 *  保持现值——由自动读取或连接默认补齐） */
function selectLlmProvider(name: string): void {
  const cached = props.pools.llmProviders[name]?.models;
  const models = Array.isArray(cached) ? cached.filter((m): m is string => typeof m === 'string') : [];
  const cur = getLLM('model');
  const nextModel = models.length && typeof cur === 'string' && cur && !models.includes(cur)
    ? models[0]
    : cur;
  const next = { ...props.raw };
  next.llm = { ...llmRaw.value, provider: name, ...(nextModel ? { model: nextModel } : {}) };
  emit('update:raw', next);
}
function setLLM(key: string, v: unknown): void {
  // 推理力度选「默认」= 删除覆盖（不发送推理参数，跟随服务商缺省）
  if (key === 'reasoning_effort' && v === '') {
    revertLlmToInherit(key);
    return;
  }
  const next = { ...props.raw };
  const cur = (next.llm && typeof next.llm === 'object' ? next.llm : {});
  next.llm = { ...cur, [key]: v };
  emit('update:raw', next);
}
/** 读取字段展示值：优先本 Agent 实时覆盖（raw），否则回退 effective（全局/池合并） */
function getLLM(key: string): any {
  if (key in llmRaw.value && llmRaw.value[key] !== undefined) return llmRaw.value[key];
  return llmEffective.value[key];
}

// ── 字段来源：true=本 Agent 覆盖，false=继承（全局/池）──
// 空串/null 视为未覆盖：model '' =「默认」（按全局默认模型处理）、
// reasoning_effort 空值 = 继承（'none' 才是显式「无」）
function isLlmOverridden(key: string): boolean {
  const v = llmRaw.value[key];
  return key in llmRaw.value && v !== undefined && v !== null && v !== '';
}
/** 恢复字段为"继承"：从 raw.llm 删除该字段（model 例外——显式置 ''：
 *  「默认」即重置，save 侧 '' → null 清存储——deepMerge 缺键删不掉） */
function revertLlmToInherit(key: string): void {
  const cur = { ...llmRaw.value };
  if (key === 'model') cur.model = '';
  else delete cur[key];
  const next = { ...props.raw };
  if (Object.keys(cur).length === 0) {
    delete next.llm;
  } else {
    next.llm = cur;
  }
  emit('update:raw', next);
}

// ── 推理力度（与会话输入框同词汇：默认/无/low/high/max）──
/** 选中值：'' = 默认（不覆盖——不发送推理参数，跟随服务商缺省）；
 *  'none' = 显式「无」（关闭思考输出）；继承态优先展示有效档位 */
const effortSelectValue = computed(() => {
  const v = getLLM('reasoning_effort');
  return typeof v === 'string' && v ? v : '';
});
/** 选项表：默认 + 固定档位 + 存量自定义档位保显（旧自由文本如 medium——不改不丢） */
const effortOptions = computed(() => {
  const opts = [
    { label: '默认（跟随服务商）', value: '' },
    { label: '无', value: 'none' },
    { label: 'low', value: 'low' },
    { label: 'high', value: 'high' },
    { label: 'max', value: 'max' },
  ];
  const cur = getLLM('reasoning_effort');
  if (typeof cur === 'string' && cur && cur !== 'none' && !opts.some((o) => o.value === cur)) {
    opts.push({ label: `${cur}（存量）`, value: cur });
  }
  return opts;
});

/** 全局默认模型（与后端 defaultPoolConnection 同口径：default:true 条目
 *  优先，缺省首条；「默认」选项的生效落点——摘要与提示共用） */
const globalDefaultModel = computed<{ provider: string; model: string } | null>(() => {
  const entries = Object.entries(props.pools.llmProviders)
    .filter(([n, v]) => !n.startsWith('$') && v && typeof v === 'object');
  const hit = entries.find(([, v]) => (v as Record<string, unknown>).default === true) ?? entries[0];
  if (!hit) return null;
  const e = hit[1] as Record<string, unknown>;
  const m = typeof e.defaultModel === 'string' && e.defaultModel ? e.defaultModel
    : typeof e.model === 'string' && e.model ? e.model : '';
  return m ? { provider: hit[0], model: m } : null;
});

/** 当前生效模型摘要（provider+model 双字段 + 来源标注；未声明模型 →
 *  全局默认模型） */
const llmEffectiveSummary = computed(() => {
  const eff = llmEffective.value;
  const provider = llmProvider.value;
  const model = llmRaw.value.model || eff.model || globalDefaultModel.value?.model || '';
  const hasOwn = Object.keys(llmRaw.value).some(
    (k) => k !== '$ref' && llmRaw.value[k] !== undefined && llmRaw.value[k] !== null && llmRaw.value[k] !== '',
  );
  const source = hasOwn ? '本 Agent 配置' : (props.pools.llmProviders[provider] ? `连接 · ${provider}` : `内置 · ${provider}`);
  return { provider, model, source };
});
// ── 搜索池（web_search 工具） ──
const selectedSearchPool = ref('');
function applySearchPool(poolName: string) {
  selectedSearchPool.value = poolName;
  const next = { ...props.raw };
  if (!poolName) {
    delete (next as any)['tool.web_search'];
    emit('update:raw', next);
    return;
  }
  (next as any)['tool.web_search'] = { $ref: poolName };
  emit('update:raw', next);
}
function resolveToolValue(nsKey: string, key: string): unknown {
  const nsCfg = (props.raw as any)[nsKey] ?? {};
  if (key in nsCfg && nsCfg[key] !== undefined) return nsCfg[key];
  if (nsCfg.$ref && props.pools.searchProviders[nsCfg.$ref]) {
    const pool = props.pools.searchProviders[nsCfg.$ref];
    if (key in pool) return pool[key];
  }
  return undefined;
}

// ── 能力标签 ──
/** 工具 requires 可能用到的标签 → 中文说明（base 为隐式基础能力层，始终启用） */
const TOOL_TAG_LABELS: Record<string, string> = {
  base: '基础能力',
  admin: '系统管理',
  dev: '开发工具',
  shell: '命令执行',
  delegation: '任务委派',
  web: 'Web 浏览',
  observe: '观察（只读）',
  manipulate: '交互（操控）',
  inject: '注入（任意执行）',
  fs_minimal: '极简文件面（DSH 编辑器）',
};
/** 第一行徽章：base/admin/dev/shell/delegation/web/observe/manipulate/inject 固定顺序 + 工具 requiredTags 用到的其他标签排后 */
const toolTagBadges = computed(() => {
  const order = ['base', 'admin', 'dev', 'shell', 'delegation', 'web', 'observe', 'manipulate', 'inject'];
  const found = new Set<string>(order);
  for (const t of props.assembly?.tools.catalog ?? []) for (const r of t.requiredTags ?? []) if (r) found.add(r);
  const rest = Array.from(found).filter(t => !order.includes(t)).sort();
  return [...order, ...rest]
    .map(tag => ({ tag, label: `${tag} · ${TOOL_TAG_LABELS[tag] ?? tag}`, fixed: tag === 'base' }));
});
const toolBadgeSet = computed(() => new Set(toolTagBadges.value.map(b => b.tag)));
const customTagInput = ref('');
/** 旧 agent 标签读取时视为 base 固定徽章，不落入自定义标签区 */
const customTags = computed(() => (props.raw.tags ?? []).filter((t: string) => t !== 'agent' && !toolBadgeSet.value.has(t)));

// M24 X4：tags 单源——共享标签只写 tags（后端有效能力集 = base ∪ tags ∪
// agent:<自己的id> ∪ settings.security.capabilities 覆盖层）。双写逻辑
// 退役：AgentPane 不再同步维护 settings.security.capabilities；存量
// 覆盖层值继续作追加层生效（用户可经装配参数弹窗手工清理）。
function emitTags(nextTags: string[]): void {
  emit('update:raw', { ...props.raw, tags: nextTags });
}
function toggleTag(tag: string, on: boolean): void {
  const tags: string[] = props.raw.tags ?? [];
  emitTags(on ? [...tags.filter(t => t !== tag), tag] : tags.filter(t => t !== tag));
}
/** 徽章点击：base 隐式固定不可移除 */
function toggleToolTag(tag: string, fixed: boolean): void {
  if (fixed) return;
  toggleTag(tag, !(props.raw.tags ?? []).includes(tag));
}
function addCustomTag(): void {
  const t = customTagInput.value.trim().toLowerCase();
  if (!t) return;
  const tags = props.raw.tags ?? [];
  if (!tags.includes(t)) emitTags([...tags, t]);
  customTagInput.value = '';
}
function removeTag(tag: string): void {
  emitTags((props.raw.tags ?? []).filter((t: string) => t !== tag));
}

// ── 头像 ──
const avatarPreview = ref('');
/** 当前预览 URL 是否加载失败（无头像 404 / 破图）——响应式卸载 <img> 回退首字。
 *  此前 @error 用内联 style.display='none' 隐藏破图：Vue 不接管命令式内联
 *  样式，无头像 Agent 开面板 404 一次后再上传新图也不复显——「点击更换
 *  头像无效」的根因（与 ui/Avatar.vue 的 failed 同款语义）。 */
const avatarFailed = ref(false);
const avatarUploading = ref(false);
const avatarError = ref('');
/** 当前预览若为 blob URL 则先 revoke（每次换图泄漏一个 blob 引用） */
function setAvatarPreview(url: string) {
  if (avatarPreview.value.startsWith('blob:')) URL.revokeObjectURL(avatarPreview.value);
  avatarPreview.value = url;
  avatarFailed.value = false;
}
function initAvatar() {
  setAvatarPreview(`/api/agents/${encodeURIComponent(props.agentId)}/avatar?t=${Date.now()}`);
}
initAvatar();
/** 切换 Agent 时重新加载头像 */
watch(() => props.agentId, () => { avatarError.value = ''; initAvatar(); });

async function onAvatarFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  // 复位文件输入：不重置时连续选择同一个文件第二次不触发 change
  input.value = '';
  if (file.size > 2 * 1024 * 1024) { avatarError.value = '文件大小不能超过 2MB'; return; }
  avatarError.value = '';
  setAvatarPreview(URL.createObjectURL(file));
  avatarUploading.value = true;
  const form = new FormData();
  form.append('file', file);
  try {
    await uploadAvatar(props.agentId, file);
    initAvatar();
    emit('avatar-changed', props.agentId, true);
  } catch (err: any) {
    avatarError.value = `头像上传失败: ${err.message}`;
  } finally {
    avatarUploading.value = false;
  }
}
async function removeAvatar() {
  try {
    await deleteAvatar(props.agentId);
    setAvatarPreview('');
    emit('avatar-changed', props.agentId, false);
  } catch (err: any) {
    avatarError.value = `删除头像失败: ${err.message}`;
  }
}
</script>

<template>
  <div class="agent-pane">
    <!-- 顶部导航：返回 + Agent 名 + 上/下切换 + 保存 -->
    <div class="agent-nav">
      <button class="agent-nav-back" @click="emit('back')" title="返回 Agent 列表"><Icon name="arrow-left" :size="13" /><span>返回 Agent 列表</span></button>
      <span class="agent-nav-name" :title="agentId">{{ agentName }}</span>
      <span class="agent-nav-id">{{ agentId }}</span>
      <div class="agent-nav-spacer"></div>
      <button class="agent-nav-btn" :disabled="!prevAgent" :title="prevAgent ? '上一个：' + (prevAgent.name || prevAgent.id) : ''" @click="prevAgent && emit('switch', prevAgent.id)"><Icon name="chevron-left" :size="13" /><span>上一个</span></button>
      <button class="agent-nav-btn" :disabled="!nextAgent" :title="nextAgent ? '下一个：' + (nextAgent.name || nextAgent.id) : ''" @click="nextAgent && emit('switch', nextAgent.id)"><span>下一个</span><Icon name="chevron-right" :size="13" /></button>
    </div>

    <!-- Tabs -->
    <div class="agent-tabs">
      <button class="agent-tab" :class="{ active: tab === 'info' }" @click="tab = 'info'">基本信息</button>
      <button class="agent-tab" :class="{ active: tab === 'llm' }" @click="tab = 'llm'">模型</button>
      <button class="agent-tab" :class="{ active: tab === 'timer' }" @click="tab = 'timer'">定时任务</button>
      <button class="agent-tab" :class="{ active: tab === 'ext' }" @click="tab = 'ext'">插件配置</button>
      <!-- 插件 Agent 页签（settings-tab:agent）：附加在内置 4 个页签之后 -->
      <button
        v-for="t in sortedAgentSettingsTabs" :key="t.id"
        class="agent-tab" :class="{ active: tab === t.id }" @click="tab = t.id"
      >{{ t.label }}</button>
    </div>

    <!-- ====== 页签内容（导航/页签固定，仅内容滚动） ====== -->
    <div class="agent-tab-body">
      <!-- ====== 基本信息 ====== -->
      <div v-if="tab === 'info'" class="agent-info">
      <div class="info-grid">
        <!-- 身份：头像 + 昵称/ID 合并 -->
        <div class="info-item info-identity">
          <div class="avatar-block">
            <label class="avatar-uploader" :title="avatarUploading ? '上传中...' : '点击更换头像'">
              <div class="avatar-preview">
                <img v-if="avatarPreview && !avatarFailed" :src="avatarPreview" :alt="raw.name || effective.name || agentId" @error="avatarFailed = true" />
                <span class="avatar-ph">{{ (raw.name || effective.name || agentId).charAt(0).toUpperCase() }}</span>
                <span v-if="avatarUploading" class="avatar-loading">上传中…</span>
              </div>
              <span class="avatar-hint">点击更换</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden @change="onAvatarFile" />
            </label>
            <button v-if="avatarPreview && !avatarFailed && !avatarUploading" class="avatar-remove-x" title="移除头像" @click="removeAvatar"><Icon name="x" :size="11" /></button>
          </div>
          <div class="identity-fields">
            <input type="text" class="info-input" :value="raw.name ?? effective.name ?? ''" @input="emit('update:raw', { ...raw, name: ($event.target as HTMLInputElement).value })" placeholder="输入 Agent 昵称" />
            <div class="identity-id">{{ effective.agent_id ?? agentId }}</div>
          </div>
          <div v-if="avatarError" class="info-error">{{ avatarError }}</div>
        </div>

        <!-- 能力标签 -->
        <div class="info-item">
          <div class="info-label">能力标签</div>
          <div class="info-desc">组合式能力声明（工具按 requires 匹配）：点击启用/关闭，可自定义领域标签</div>
          <div class="tag-badges">
            <button
              v-for="b in toolTagBadges" :key="b.tag" type="button"
              class="tag-badge" :class="[{ on: b.fixed || (raw.tags ?? []).includes(b.tag) }, 'tb-' + b.tag]"
              :title="b.fixed ? '基础标签，始终启用' : (raw.tags ?? []).includes(b.tag) ? '点击移除' : '点击启用'"
              @click="toggleToolTag(b.tag, b.fixed)"
            >{{ b.label }}</button>
          </div>
          <div class="tag-custom">
            <input v-model="customTagInput" type="text" class="info-input" placeholder="自定义领域标签（如 sap / math / qa），回车添加" @keyup.enter="addCustomTag" />
            <div v-if="customTags.length" class="tag-chips">
              <span v-for="t in customTags" :key="t" class="tag-chip">{{ t }}<button type="button" class="tag-chip-x" @click="removeTag(t)"><Icon name="x" :size="10" /></button></span>
            </div>
          </div>
        </div>

        <!-- SYSTEM.md -->
        <div class="info-item">
          <div class="info-label">SYSTEM.md</div>
          <div class="info-desc">覆盖 builtin.build-system-prompt 装配的系统提示词</div>
          <label class="info-toggle"><input type="checkbox" :checked="sysEnabled" @change="emit('update:sysEnabled', ($event.target as HTMLInputElement).checked)" /><span>启用自定义内容</span></label>
          <textarea v-if="sysEnabled" class="info-textarea code" rows="11" :value="sysContent" @input="emit('update:sysContent', ($event.target as HTMLTextAreaElement).value)" placeholder="输入 SYSTEM.md 内容..."></textarea>
        </div>

        <!-- AGENT.md -->
        <div class="info-item">
          <div class="info-label">AGENT.md</div>
          <div class="info-desc">定义 Agent 的角色、行为和能力边界</div>
          <label class="info-toggle"><input type="checkbox" :checked="agentEnabled" @change="emit('update:agentEnabled', ($event.target as HTMLInputElement).checked)" /><span>启用自定义内容</span></label>
          <textarea v-if="agentEnabled" class="info-textarea code" rows="11" :value="agentContent" @input="emit('update:agentContent', ($event.target as HTMLTextAreaElement).value)" placeholder="输入 AGENT.md 内容..."></textarea>
        </div>
      </div>
    </div>

    <!-- ====== 模型 ====== -->
    <div v-else-if="tab === 'llm'" class="llm-pane">
      <div v-if="llmFields.length > 0" class="llm-fields">
        <template v-for="s in llmSections" :key="s.type === 'title' ? 't-' + s.label : (s.type === 'provider' ? 'provider' : s.f.key)">
          <!-- Provider 连接选择（P5：连接定义归模型管理——此处只选用） -->
          <div v-if="s.type === 'provider'" class="llm-item">
            <div class="info-label">Provider</div>
            <div class="info-desc">选择模型连接（baseUrl / API Key 在「设置 → 模型管理」定义，Agent 面不可覆盖）</div>
            <div class="llm-control">
              <select class="info-input llm-pool-select" :value="llmProvider" @change="selectLlmProvider(($event.target as HTMLSelectElement).value)">
                <option v-if="!llmStats.length" value="">{{ llmProvider || '无可用连接' }}（未配置——设置 → 模型管理 添加连接）</option>
                <option v-for="stat in llmStats" :key="stat.name" :value="stat.name">{{ stat.name }}{{ stat.description ? ' · ' + stat.description : '' }}</option>
              </select>
            </div>
            <div v-if="llmEffectiveSummary" class="llm-effective">
              <span class="llm-effective-dot"></span>
              当前生效：<strong>{{ llmEffectiveSummary.model || llmEffectiveSummary.provider }}</strong>
              <span class="llm-effective-src">· {{ llmEffectiveSummary.provider }} · {{ llmEffectiveSummary.source }}</span>
            </div>
          </div>
          <div v-else-if="s.type === 'title'" class="llm-group-title">{{ s.label }}</div>
          <div v-else class="llm-item" :class="{ 'is-non-default': isLlmOverridden(s.f.key) }">
            <div class="info-label">
              {{ s.f.label }}
              <span class="llm-source" :class="isLlmOverridden(s.f.key) ? 'is-override' : 'is-inherit'">{{ isLlmOverridden(s.f.key) ? '本 Agent' : '继承' }}</span>
            </div>
            <div v-if="s.f.description" class="info-desc">{{ s.f.description }}</div>
            <div class="llm-control">
              <!-- 模型 ID：纯下拉（「默认」= 按全局设置的默认模型处理；清单 =
                   连接发现缓存 ∪ 自动读取，无手输无「读取」按钮） -->
              <select
                v-if="s.f.key === 'model'"
                class="info-input llm-models-select"
                :value="(typeof llmRaw.model === 'string' && llmRaw.model) || ''"
                @change="setLLM('model', ($event.target as HTMLSelectElement).value)"
              >
                <option value="">默认（按全局设置的默认模型处理）</option>
                <option v-for="m in llmModelOptionsMerged" :key="m" :value="m">{{ m }}</option>
              </select>
              <!-- 推理力度：与会话输入框同词汇（无/low/high/max；无 = 关闭思考输出） -->
              <select
                v-else-if="s.f.key === 'reasoning_effort'"
                class="info-input llm-models-select"
                :value="effortSelectValue"
                @change="setLLM('reasoning_effort', ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="o in effortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <SettingField v-else :field="s.f" :model-value="getLLM(s.f.key)" @update:model-value="setLLM(s.f.key, $event)" />
              <button v-if="isLlmOverridden(s.f.key)" class="llm-reset" title="恢复为继承（删除本 Agent 覆盖，回退连接默认）" @click="revertLlmToInherit(s.f.key)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
            </div>
            <div v-if="s.f.key === 'model' && !isLlmOverridden('model') && globalDefaultModel" class="info-hint">当前全局默认模型：{{ globalDefaultModel.model }} · {{ globalDefaultModel.provider }}</div>
            <div v-if="s.f.key === 'model' && !llmModelOptionsMerged.length && llmModelsError" class="info-error">{{ llmModelsError }}</div>
          </div>
        </template>
        <div v-if="llmFiltered.length === 0" class="llm-empty">未找到匹配的设置</div>
      </div>
      <div v-else class="llm-empty">当前模型无可用配置项</div>
    </div>

    <!-- ====== 定时任务 ====== -->
    <div v-else-if="tab === 'timer'">
      <TimerPane :entries="timers" :saving="saving" @update:entries="emit('update:timers', $event)" @save="emit('saveTimers')" />
    </div>

        <!-- ====== 插件配置（扩展行 + 工具意图；M22 P2；原「装配」页签改名） ====== -->
      <div v-else-if="tab === 'ext'" class="ext-pane">
        <div v-if="assemblyError && !assembly" class="ext-legacy-banner error">{{ assemblyError }}</div>
        <ExtToolsPane
          :extensions="extensions"
          :plugins="plugins"
          :permissions="permissions"
          :decl="decl"
          :on-decl="patchDecl"
          :tools="assembly ? { catalog: assembly.tools.catalog, enabled: assembly.tools.enabled, include: assembly.tools.include, exclude: assembly.tools.exclude } : { catalog: [], enabled: [], include: [], exclude: [] }"
          :tags="raw.tags"
          :agent-id="agentId"
          :event-chains="eventChains"
          :event-descriptions="eventDescriptions"
        />
      </div>

      <!-- ====== 插件 Agent 设置页签（settings-tab:agent slot） ====== -->
      <div v-else-if="pluginTab" class="agent-plugin-tab">
        <component :is="pluginTab.component" v-bind="pluginTabProps" />
      </div>

      <!-- 未知页签兜底（如插件页签刚被卸载） -->
      <div v-else class="agent-tab-empty">未知页签</div>
    </div>
  </div>
</template>

<style scoped>
.agent-pane { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; overflow: hidden; }
/* 页签内容统一滚动容器：顶部导航/页签固定，仅内容区滚动 */
.agent-tab-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

/* 顶部导航：返回 + 切换 Agent + 保存 */
.agent-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-nav-back { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; transition: all var(--dur-fast, .12s); flex-shrink: 0; }
.agent-nav-back:hover { background: var(--bg-hover); color: var(--text-1); }
.agent-nav-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
.agent-nav-id { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.agent-nav-spacer { flex: 1; }
.agent-nav-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; transition: all var(--dur-fast, .12s); }
.agent-nav-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.agent-nav-btn:disabled { opacity: .4; cursor: not-allowed; }

/* 模型高级参数折叠（已废弃：分组化替代） */

/* Tabs（下划线式） */
.agent-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); }
.agent-tab {
  padding: 8px 16px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.agent-tab:hover { color: var(--text-1); background: var(--bg-hover); border-radius: var(--r-sm) var(--r-sm) 0 0; }
.agent-tab.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 500; }

/* Info */
.info-grid { display: flex; flex-direction: column; gap: 2px; }
.info-item { padding: 9px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.info-item:last-child { border-bottom: none; }
.info-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.info-desc { font-size: 11px; color: var(--text-3); }
.info-hint { font-size: 12px; color: var(--text-3); }
.info-error { color: var(--err); font-size: 12px; }
.info-input, .info-select {
  padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.info-input:focus, .info-select:focus { outline: none; border-color: var(--input-focus); box-shadow: 0 0 0 3px var(--primary-light); }
.info-input:disabled { opacity: .55; cursor: not-allowed; }
.info-textarea {
  width: 100%; padding: 8px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
  resize: vertical; line-height: 1.5;
}
.info-textarea:focus { outline: none; border-color: var(--input-focus); }
.info-textarea.code { font-family: var(--font-mono); }
.info-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.info-toggle input { accent-color: var(--primary); }

/* Avatar（合并布局：点击头像更换 + hover 删除） */
.info-identity { flex-direction: row; align-items: flex-start; gap: 16px; }
.avatar-block { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.avatar-uploader { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; }
.avatar-preview {
  width: 56px; height: 56px; border-radius: var(--r-md); overflow: hidden;
  background: var(--primary-light); display: flex; align-items: center; justify-content: center;
  position: relative; flex-shrink: 0; transition: box-shadow var(--dur-fast);
}
.avatar-preview img { width: 100%; height: 100%; object-fit: cover; position: relative; z-index: 1; }
.avatar-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; color: var(--primary); }
.avatar-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; background: rgba(0,0,0,.5); border-radius: var(--r-md); z-index: 2; }
.avatar-hint { font-size: 10px; color: var(--text-3); transition: color var(--dur-fast); }
.avatar-uploader:hover .avatar-preview { box-shadow: 0 0 0 3px var(--primary-light, rgba(99,102,241,.15)); }
.avatar-uploader:hover .avatar-hint { color: var(--primary); }
.avatar-remove-x {
  position: absolute; top: -5px; right: -5px; width: 16px; height: 16px; border-radius: 50%;
  border: 1px solid var(--line-strong); background: var(--bg-raised); color: var(--text-3);
  font-size: 11px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  opacity: 0; z-index: 3;
  transition: opacity var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.avatar-block:hover .avatar-remove-x { opacity: 1; }
.avatar-remove-x:hover { color: var(--err); border-color: var(--err); }
.identity-fields { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; padding-top: 6px; }
.identity-id { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

/* Tags：能力标签徽章（现代柔和——off 幽灵态中性微底；on 按标签色系轻染：
   8% 底 + 20% 细描边 + 75% 柔字色，色相由 --tag-hue 驱动）+ 自定义 chips */
.tag-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-badge {
  padding: 3px 10px; border-radius: var(--r-full); font-size: 11px; cursor: pointer;
  background: color-mix(in srgb, var(--text-3) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--text-3) 14%, transparent);
  color: var(--text-3);
  transition: background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast);
}
.tag-badge:hover {
  background: color-mix(in srgb, var(--text-3) 11%, transparent);
  border-color: color-mix(in srgb, var(--text-3) 22%, transparent);
  color: var(--text-2);
}
.tag-badge.on {
  background: color-mix(in srgb, var(--tag-hue, var(--primary)) 8%, transparent);
  border-color: color-mix(in srgb, var(--tag-hue, var(--primary)) 20%, transparent);
  color: color-mix(in srgb, var(--tag-hue, var(--primary)) 75%, var(--text-1));
  font-weight: 500;
}
.tag-badge.on:hover {
  background: color-mix(in srgb, var(--tag-hue, var(--primary)) 14%, transparent);
  border-color: color-mix(in srgb, var(--tag-hue, var(--primary)) 28%, transparent);
}
/* 标签色相表（与 AgentListPane 徽章同源） */
.tb-base { --tag-hue: var(--primary); }
.tb-admin { --tag-hue: #dc2626; }
.tb-dev { --tag-hue: #059669; }
.tb-shell { --tag-hue: #b45309; }
.tb-delegation { --tag-hue: #7c3aed; }
.tb-web { --tag-hue: #2563eb; }
.tb-observe { --tag-hue: #0d9488; }
.tb-manipulate { --tag-hue: #ea580c; }
.tb-inject { --tag-hue: #be123c; }
.tag-custom { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.tag-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: var(--r-full);
  background: color-mix(in srgb, var(--text-2) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--text-2) 15%, transparent);
  font-size: 11px; color: var(--text-1);
}
.tag-chip-x { border: none; background: none; cursor: pointer; color: var(--text-2); padding: 0 2px; display: inline-flex; align-items: center; }
.tag-chip-x:hover { color: var(--err); }

/* LLM */
.llm-pane { display: flex; flex-direction: column; gap: 12px; }

/* 模型池字段项 */
.llm-pool-select { flex-shrink: 0; min-width: 180px; max-width: 280px; }
.llm-effective {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  font-size: 12px; color: var(--text-2);
  padding: 4px 10px; background: var(--primary-light, rgba(99,102,241,.08));
  border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
  border-radius: var(--r-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.llm-effective .llm-effective-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-effective-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 6px var(--primary); flex-shrink: 0; }
.llm-effective strong { color: var(--text-1); font-weight: 600; }
.llm-effective-src { color: var(--text-3); }

/* 分组标题（采样/边界/推理） */
.llm-group-title {
  margin-top: 8px; padding: 4px 0 4px 10px; border-left: 3px solid var(--primary);
  font-size: 12px; font-weight: 600; color: var(--text-2);
}
.llm-group-title:first-child { margin-top: 0; }

/* 模型/推理力度下拉（llm-control 行内） */
.llm-models-select { max-width: 320px; flex-shrink: 1; min-width: 140px; }
.llm-source {
  margin-left: 6px; padding: 0 7px; border-radius: var(--r-full);
  font-size: 10px; font-weight: 400; line-height: 1.6; vertical-align: 1px;
}
.llm-source.is-override { color: var(--primary); background: var(--primary-light); border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent); }
.llm-source.is-inherit { color: var(--text-3); background: var(--bg-hover); }
.llm-fields { display: flex; flex-direction: column; gap: 2px; }
.llm-item { padding: 8px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 5px; border-left: 3px solid transparent; }
.llm-item.is-non-default { border-left-color: var(--primary); }
.llm-control { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.llm-reset {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 1px solid var(--line-strong); border-radius: var(--r-md); color: var(--text-3); cursor: pointer;
}
.llm-reset:hover { background: var(--bg-hover); color: var(--primary); }
.llm-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }

/* 旧契约迁移横幅（P2） */
.ext-legacy-banner {
  padding: 8px 12px; border-radius: var(--r-md);
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn); font-size: 12px; line-height: 1.5;
}
.ext-legacy-banner.error {
  color: var(--err);
  border-color: color-mix(in srgb, var(--err) 45%, transparent);
  background: color-mix(in srgb, var(--err) 10%, transparent);
}

/* 插件 Agent 页签（settings-tab:agent） */
.agent-plugin-tab { display: flex; flex-direction: column; }
.agent-tab-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }

</style>
