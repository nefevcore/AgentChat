<script setup lang="ts">
// ============================================================
// AgentPane.vue —— Agent 配置（tabs：基本信息 / 模型 / 定时任务 / 插件配置）
// 「插件配置」（原「装配」，2026-09-03 与插件库页签统一命名）：扩展行为/差异层
// + 工具意图——与插件库「插件配置」同词汇（软停用 per-Agent 覆盖）；
// 沙箱白名单（settings.security.allowedPaths）的配置入口也在此
// （security 扩展卡片——原「安全」页签已收口并入）。
// 展示读 effective（后端解析），编辑写 raw（差异）
// ============================================================
import { ref, computed, watch } from 'vue';
import type { FieldMeta, AssemblyData, AssemblyPatch } from 'ac-client-ui-settings/client/types.ts';
import type { TimerEntry } from 'ac-timer-core';
import { assemblyOf, type AgentBrief } from './useAgentSettings.ts';
import { toFields, filterFields } from 'ac-client-ui-settings/client/schema.ts';
import { Button, Checkbox, FieldRow, Icon, IconAction, Input, Select, StatusDot, Tabs, Textarea } from '@agentchat/webui-kit';
import SettingField from 'ac-client-ui-settings/client/components/SettingField.vue';
import TimerPane from 'ac-client-ui-timer/client/TimerPane.vue';
import ExtToolsPane from 'ac-client-ui-plugin-registry/client/ExtToolsPane.vue';
// 数据面直连（M29 P1-3b：dataFaces 再导出层随迁除役——本包函数 + rpc seam）；
// 模型发现/池模型归一化经 ui-llm-pool（2026-09-11 语义归位：池域词汇，
// Agent 面消费 = domain→domain 契约词汇边，白名单显式裁决）
import { fetchPoolModels, poolModelEntries, modelOnProviderSwitch, poolDefaultModel } from 'ac-client-ui-llm-pool/client/poolApi.ts';
import { uploadAvatar, deleteAvatar, fetchLlmProviders, avatarUrl, type LlmProviderStat } from './index.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { sortedAgentSettingsTabs, resolveTabProps } from 'ac-client-ui-settings/client/extensionTabs.ts';

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
  llmSchemas: Record<string, any[]>;
  pools: { llmProviders: Record<string, any>; searchProviders: Record<string, any> };
  saving?: boolean;
  /** 有未保存编辑（M29 P1-3b：保存钮随编辑器内迁——保存编排归域后
   *  不再依赖设置壳的「保存配置」） */
  dirty?: boolean;
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
  (e: 'save'): void;
  (e: 'saveTimers'): void;
  (e: 'avatar-changed', agentId: string, present: boolean, version?: string): void;
}>();

const tab = ref<string>('info');

/** Tabs 数据面：内置 4 页签 + 插件页签（settings-tab:agent 排序已由扩展侧管） */
const tabItems = computed(() => [
  { id: 'info', label: '基本信息' },
  { id: 'llm', label: '模型' },
  { id: 'timer', label: '定时任务' },
  { id: 'ext', label: '插件配置' },
  ...sortedAgentSettingsTabs.value.map((t) => ({ id: t.id, label: t.label })),
]);
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

// ── 装配声明（M22 P2 + M24 X1）：tools/settings（具名设置对象）两字段 patch
//（解析并源 assemblyOf——useAgentSettings 同款，与 dirty 基线/保存同形状。
// AssemblyPatch 协议键 ◐b cr-691 改 rows——本地 raw 仍主线 AgentConfig.tools） ──
const decl = computed(() => assemblyOf(props.raw));
/** settings per-name 浅合并 / null 删除（服务端语义——M22 D5） */
function patchDecl(patch: AssemblyPatch): void {
  emit('update:raw', {
    ...props.raw,
    tools: {
      include: patch.rows?.include ?? decl.value.tools.include,
      exclude: patch.rows?.exclude ?? decl.value.tools.exclude,
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
/** 当前 provider：raw 显式（'' = 「默认」跟随池默认连接）> effective >
 *  注册面首个（无连接 = 空）。raw.llm 含 provider 键（含 ''）即视为
 *  显式选择——不再静默回落注册面首个（否则「默认」选项永远选不上） */
const llmProvider = computed(() => {
  if ('provider' in llmRaw.value) return String(llmRaw.value.provider ?? '') || '';
  const p = llmEffective.value.provider;
  if (p) return p as string;
  return llmStats.value[0]?.name ?? '';
});
/** kit Select 选项表（cr-169）：无连接时首项（占位说明）禁选——语义同原生 option disabled */
const llmProviderOptions = computed(() => [
  {
    value: '',
    label: llmStats.value.length > 0 ? '默认（跟随模型池默认连接）' : '无可用连接（设置 → 模型管理 添加连接）',
    disabled: llmStats.value.length === 0,
  },
  ...llmStats.value.map((stat) => ({
    value: stat.name,
    label: stat.description ? `${stat.name} · ${stat.description}` : stat.name,
  })),
]);
/** 字段表：任意 provider 共用一份（连接字段已收敛；按名取不到时回落首表） */
const llmFields = computed<FieldMeta[]>(() => {
  const schemas = props.llmSchemas;
  const first = Object.keys(schemas).at(0);
  return toFields(schemas[llmProvider.value] ?? (first !== undefined ? schemas[first] : []));
});
const llmFiltered = computed(() => filterFields(llmFields.value, llmRaw.value, ''));

// 模型参数分组：采样 / 边界 / 推理
// 移除：logprobs / top_logprobs / tool_choice（工具默认 auto，无需配置）；
// thinking（「思考输出」勾选退役——由「推理力度=无」替代：'none' 在投递
// 边界翻译为 thinking disabled）
const HIDDEN_LLM_KEYS = new Set(['logprobs', 'top_logprobs', 'tool_choice']);
const llmVisible = computed(() => llmFiltered.value.filter(f => !HIDDEN_LLM_KEYS.has(f.key)));

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
    const r = await fetchLlmProviders(defaultRpc);
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
    const data = await fetchPoolModels(provider, true, defaultRpc);
    if (data.models.length) {
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
/** kit Select 选项表（cr-169）：默认项 + 合并清单（存量 llmModelOptions 为发现缓存 ref，避让改名）。默认项语义连接感知（cr-313）：provider 显式 → 跟随该连接默认模型；未选 → 全局默认连接 */
const llmModelSelectOptions = computed(() => [
  { value: '', label: llmProvider.value ? '默认（跟随该连接的默认模型）' : '默认（按全局设置的默认模型处理）' },
  ...llmModelOptionsMerged.value.map((m) => ({ value: m, label: m })),
]);

/** 选择 provider：写 raw.llm.provider；'' = 「默认」（跟随模型池默认连接
 *  ——删除 provider 覆盖、model 归''，投递侧回落 defaultPoolConnection）；
 *  模型落点 = modelOnProviderSwitch 单源（cr-312：此前 string-only 滤掉
 *  对象形态发现缓存致清单恒空——「自动换新连接模型」永不触发） */
function selectLlmProvider(name: string): void {
  if (!name) {
    // 「默认」：provider/model 双清除（继承全局，池默认热更即跟随）
    const next = { ...props.raw };
    next.llm = { ...llmRaw.value, provider: '', model: '' };
    emit('update:raw', next);
    return;
  }
  const nextModel = modelOnProviderSwitch(props.pools.llmProviders[name], getLLM('model'));
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
  const hit = entries.find(([, v]) => (v as Record<string, unknown>).default === true) ?? entries.at(0);
  if (!hit) return null;
  const e = hit[1] as Record<string, unknown>;
  const m = typeof e.defaultModel === 'string' && e.defaultModel ? e.defaultModel
    : typeof e.model === 'string' && e.model ? e.model : '';
  return m ? { provider: hit[0], model: m } : null;
});

/** 模型行脚注（连接感知——cr-313）：provider 显式 → 该连接默认模型；
 *  未选 → 全局默认连接。与摘要 source 同语义 */
const llmModelDefaultHint = computed(() => {
  if (llmProvider.value) {
    const m = poolDefaultModel(props.pools.llmProviders[llmProvider.value]);
    return m ? `当前连接默认模型：${m} · ${llmProvider.value}` : `该连接未设默认模型（${llmProvider.value}）`;
  }
  return globalDefaultModel.value ? `当前全局默认模型：${globalDefaultModel.value.model} · ${globalDefaultModel.value.provider}` : '';
});
/** 还原按钮 tooltip（连接感知）：model → 连接默认；其余字段 → 继承全局 */
function revertLabelOf(key: string): string {
  return key === 'model'
    ? (llmProvider.value ? '恢复为默认（跟随该连接的默认模型）' : '恢复为默认（跟随全局默认模型）')
    : '恢复为继承（删除本 Agent 覆盖，回退全局默认）';
}

/** 当前生效模型摘要（provider+model 双字段 + 来源标注），与投递侧
 *  poolFallbackRef 同口径：model 显式 → 本 Agent 配置（provider 空 =
 *  裸名路由）；model 空 + provider 显式 → 该连接默认模型（引用，热更
 *  跟随——cr-313 第四态）；双空 → 全局默认连接 */
const llmEffectiveSummary = computed(() => {
  if (llmRaw.value.model) {
    return { provider: llmProvider.value, model: llmRaw.value.model, source: '本 Agent 配置' };
  }
  const ownConn = llmProvider.value ? poolDefaultModel(props.pools.llmProviders[llmProvider.value]) : undefined;
  if (ownConn) return { provider: llmProvider.value, model: ownConn, source: '连接默认' };
  const fallback = globalDefaultModel.value;
  return { provider: fallback?.provider ?? '', model: fallback?.model ?? '', source: '默认（跟随模型池）' };
});

// ── 档位编辑（cr-953：AgentConfig.tags 退役——编辑面 = 结构化抉择；
//    cr-1082：访问档位 access 抉择随轴退役——权限语义迁 permission-gate
//    onAsk〔agents/<id>/permission-gate.json〕，非本面板域。剩余抉择：
//    工具调用模式 toolMode / 浏览器层级 levels.browser） ──
const MODE_LABELS: Record<string, string> = {
  'tc-base': '标准', 'tc-programmatic': '程序化', 'tc-none': '无工具',
};
const MODE_TITLES: Record<string, string> = {
  'tc-base': '标准档：常规工具面（逐工具 schema 直调）',
  'tc-programmatic': '程序化档：LLM 面收窄为 run_code 单入口（程序化编排子调用）',
  'tc-none': '无工具档：纯聊天（不出任何工具 schema）',
};
const BROWSER_LABELS: Record<string, string> = {
  observe: '只读浏览', manipulate: '交互操作', inject: 'JS 注入',
};
const BROWSER_TITLES: Record<string, string> = {
  observe: '观察层：打开/读取/等待页面（不能点击/输入/注入）',
  manipulate: '交互层：含观察层 + 点击/输入/按键等页面交互',
  inject: '注入层：含交互层 + 页面内执行 JS（eval）',
};

/** 当前工具模式（raw.toolMode；缺席 = tc-base） */
const modeValue = computed<string>(() => (props.raw.toolMode as string | undefined) ?? 'tc-base');
const browserValue = computed<string>(() => {
  const level = (props.raw.levels as Record<string, unknown> | undefined)?.browser;
  return typeof level === 'string' ? level : '';
});
function setToolMode(v: string): void {
  emit('update:raw', { ...props.raw, toolMode: v === 'tc-base' ? null : v });
}
function setBrowserLevel(v: string): void {
  const levels = { ...((props.raw.levels as Record<string, unknown> | undefined) ?? {}) };
  if (v === '') delete levels.browser;
  else levels.browser = v;
  emit('update:raw', { ...props.raw, levels: Object.keys(levels).length > 0 ? levels : null });
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
function initAvatar(version?: string) {
  setAvatarPreview(avatarUrl(props.agentId, version));
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
    const r = await uploadAvatar(props.agentId, file);
    initAvatar(r.version);
    emit('avatar-changed', props.agentId, true, r.version);
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
    emit('avatar-changed', props.agentId, false, undefined);
  } catch (err: any) {
    avatarError.value = `删除头像失败: ${err.message}`;
  }
}
</script>

<template>
  <div class="agent-pane">
    <!-- 顶部导航：返回 + Agent 名 + 上/下切换 + 保存 -->
    <div class="agent-nav">
      <Button variant="ghost" size="sm" icon="arrow-left" @click="emit('back')" title="返回 Agent 列表">返回 Agent 列表</Button>
      <span class="agent-nav-name" :title="agentId">{{ agentName }}</span>
      <span class="agent-nav-id">{{ agentId }}</span>
      <div class="agent-nav-spacer"></div>
      <Button variant="ghost" size="sm" :disabled="!prevAgent" :title="prevAgent ? '上一个：' + (prevAgent.name || prevAgent.id) : ''" @click="prevAgent && emit('switch', prevAgent.id)">上一个</Button>
      <Button variant="ghost" size="sm" :disabled="!nextAgent" :title="nextAgent ? '下一个：' + (nextAgent.name || nextAgent.id) : ''" @click="nextAgent && emit('switch', nextAgent.id)">下一个</Button>
      <!-- 保存（M29 P1-3b 随编辑器内迁——原设置壳「保存配置」的 agent 半边
           在 M28 P2.5 节迁移后断链，此处恢复并归域；cr-171 归 kit Button primary） -->
      <Button variant="primary" size="sm" icon="check" :disabled="saving || !dirty" :title="dirty ? '保存当前 Agent 的配置（含定时任务与装配）' : '无未保存更改'" @click="emit('save')">
        {{ saving ? '保存中…' : '保存配置' }}
      </Button>
    </div>

    <!-- Tabs（kit Tabs line——cr-157；插件页签 settings-tab:agent 经 items 合成） -->
    <Tabs class="agent-tabs" variant="line" :items="tabItems" :model-value="tab" @update:model-value="tab = $event" />

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
            <!-- cr-226：原生 title——Tooltip ::after 溢出会撑宽滚动容器（agent-tab-body）且被其裁剪 -->
            <button v-if="avatarPreview && !avatarFailed && !avatarUploading" class="avatar-remove-x" title="移除头像" aria-label="移除头像" @click="removeAvatar"><Icon name="x" :size="11" /></button>
          </div>
          <div class="identity-fields">
            <Input :model-value="raw.name ?? effective.name ?? ''" placeholder="输入 Agent 昵称" @update:model-value="emit('update:raw', { ...raw, name: $event })" />
            <div class="identity-id">{{ effective.agent_id ?? agentId }}</div>
          </div>
          <div v-if="avatarError" class="info-error">{{ avatarError }}</div>
        </div>


        <!-- 档位（cr-953 结构化；cr-1082 访问档位抉择随轴退役——toolMode / levels.browser） -->
        <div class="info-item">
          <div class="info-label">工具调用模式</div>
          <div class="info-desc">LLM 工具面形态：标准直调 / 程序化编排 / 纯聊天（会话可临时覆盖）</div>
          <div class="tier-choice">
            <button v-for="(label, key) in MODE_LABELS" :key="key" type="button" class="tier-opt" :class="[{ on: modeValue === key }, 'tb-' + key]" :title="MODE_TITLES[key]" @click="setToolMode(key)">{{ label }}</button>
          </div>
        </div>
        <div class="info-item">
          <div class="info-label">浏览器层级</div>
          <div class="info-desc">browser 工具的能力面：观察 ⊂ 交互 ⊂ 注入（关闭 = browser 工具不可用）</div>
          <div class="tier-choice">
            <button type="button" class="tier-opt" :class="{ on: browserValue === '' }" title="关闭：browser 工具不可用" @click="setBrowserLevel('')">关闭</button>
            <button v-for="(label, key) in BROWSER_LABELS" :key="key" type="button" class="tier-opt" :class="[{ on: browserValue === key }, 'tb-' + key]" :title="BROWSER_TITLES[key]" @click="setBrowserLevel(key)">{{ label }}</button>
          </div>
        </div>

        <!-- SYSTEM.md -->
        <div class="info-item">
          <div class="info-label">SYSTEM.md</div>
          <div class="info-desc">覆盖 builtin.build-system-prompt 装配的系统提示词</div>
          <Checkbox :model-value="sysEnabled" @update:model-value="emit('update:sysEnabled', $event)">启用自定义内容</Checkbox>
          <Textarea v-if="sysEnabled" code :rows="11" :model-value="sysContent" placeholder="输入 SYSTEM.md 内容..." @update:model-value="emit('update:sysContent', $event)" />
        </div>

        <!-- AGENTS.md（persona 文档；AGENT.md 存量旧名兼容读取） -->
        <div class="info-item">
          <div class="info-label">AGENTS.md</div>
          <div class="info-desc">定义 Agent 的角色、行为和能力边界</div>
          <Checkbox :model-value="agentEnabled" @update:model-value="emit('update:agentEnabled', $event)">启用自定义内容</Checkbox>
          <Textarea v-if="agentEnabled" code :rows="11" :model-value="agentContent" placeholder="输入 AGENTS.md 内容..." @update:model-value="emit('update:agentContent', $event)" />
        </div>
      </div>
    </div>

    <!-- ====== 模型 ====== -->
    <div v-else-if="tab === 'llm'" class="llm-pane">
      <div v-if="llmFields.length > 0" class="llm-fields">
        <!-- Provider 连接选择（P5：连接定义归模型管理——此处只选用；
             「默认」= 跟随模型池默认连接，不写 provider/model 覆盖） -->
        <FieldRow label="Provider" description="选择模型连接（baseUrl / API Key 在「设置 → 模型管理」定义，Agent 面不可覆盖）；「默认」= 跟随模型池的默认连接">
          <div class="llm-w-pool">
            <Select
              :options="llmProviderOptions"
              :model-value="llmProvider"
              @update:model-value="selectLlmProvider"
            />
          </div>
        </FieldRow>
        <div v-if="llmEffectiveSummary" class="llm-effective">
          <StatusDot :size="6" status="ok" />
          当前生效：<strong>{{ llmEffectiveSummary.model || llmEffectiveSummary.provider }}</strong>
          <span class="llm-effective-src">· {{ llmEffectiveSummary.provider || '自动路由' }} · {{ llmEffectiveSummary.source }}</span>
        </div>
        <!-- 字段平铺（cr-173 分组标题退役：推理/采样/边界分组意义不大，字段序即 schema 序） -->
        <template v-for="f in llmVisible" :key="f.key">
          <FieldRow :label="f.label" :description="f.description" :non-default="isLlmOverridden(f.key)">
            <div class="llm-badge-and-ctrl">
              <span class="llm-source" :class="isLlmOverridden(f.key) ? 'is-override' : 'is-inherit'">{{ isLlmOverridden(f.key) ? '本 Agent' : '继承' }}</span>
              <!-- 模型 ID：纯下拉（「默认」= 按全局设置的默认模型处理；清单 =
                   连接发现缓存 ∪ 自动读取，无手输无「读取」按钮） -->
              <div v-if="f.key === 'model'" class="llm-w-models">
                <Select :options="llmModelSelectOptions" :model-value="(typeof llmRaw.model === 'string' && llmRaw.model) || ''" @update:model-value="setLLM('model', $event)" />
              </div>
              <!-- 推理力度：与会话输入框同词汇（无/low/high/max；无 = 关闭思考输出） -->
              <div v-else-if="f.key === 'reasoning_effort'" class="llm-w-models">
                <Select :options="effortOptions" :model-value="effortSelectValue" @update:model-value="setLLM('reasoning_effort', $event)" />
              </div>
              <SettingField v-else :field="f" :model-value="getLLM(f.key)" @update:model-value="setLLM(f.key, $event)" />
              <!-- cr-226：原生 title——Tooltip ::after 溢出会撑宽滚动容器（agent-tab-body）且被其裁剪；
                   IconAction 去 suppress-title 让其自带 title 生效（Kit IconAction 本就是 title+aria 双通道） -->
              <IconAction v-if="isLlmOverridden(f.key)" icon="rotate-ccw" :label="revertLabelOf(f.key)" @click="revertLlmToInherit(f.key)" />
            </div>
          </FieldRow>
          <!-- 模型行脚注（kit FieldRow 无脚注位；长文本独立于字段行下方） -->
          <div v-if="f.key === 'model' && !isLlmOverridden('model') && llmModelDefaultHint" class="info-hint">{{ llmModelDefaultHint }}</div>
          <div v-if="f.key === 'model' && !llmModelOptionsMerged.length && llmModelsError" class="info-error">{{ llmModelsError }}</div>
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
          :decl="decl"
          :on-decl="patchDecl"
          :tools="assembly ? { catalog: assembly.tools.catalog, enabled: assembly.tools.enabled, include: assembly.tools.include, exclude: assembly.tools.exclude } : { catalog: [], enabled: [], include: [], exclude: [] }"
          :agent-id="agentId"
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

/* 顶部导航：返回 + 切换 Agent + 保存（按钮已归 kit Button——cr-171） */
.agent-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-nav-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
.agent-nav-id { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.agent-nav-spacer { flex: 1; }

/* 模型高级参数折叠（已废弃：分组化替代） */

/* Tabs 已迁 kit Tabs line（cr-157）；.agent-tabs 仅作布局定位类（无样式） */

/* Info */
.info-grid { display: flex; flex-direction: column; gap: 2px; }
.info-item { padding: 9px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.info-item:last-child { border-bottom: none; }
.info-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.info-desc { font-size: 11px; color: var(--text-3); }
.info-hint { font-size: 12px; color: var(--text-3); }
.info-error { color: var(--err); font-size: 12px; }
/* cr-169：输入框/下拉/文本域/开关控件本体已归 kit
   （Input/Select/Textarea/Checkbox——ui-input/ui-sel/ui-textarea/ui-check） */

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
/* 上传遮罩：黑底白字是不变量——无对应令牌（--on-primary 语义为主色实底前景，
   暗色值为深字，此处不可用）；rgba(0,0,0,.5) 同属遮罩常量（见 P2 报告） */
.avatar-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; background: rgba(0,0,0,.5); border-radius: var(--r-md); z-index: 2; }
.avatar-hint { font-size: 10px; color: var(--text-3); transition: color var(--dur-fast); }
.avatar-uploader:hover .avatar-preview { box-shadow: 0 0 0 3px var(--primary-light); }
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

/* 档位抉择组（cr-953：三组单选胶囊——off 幽灵态中性微底；on 按色系轻染） */
.tier-choice { display: flex; flex-wrap: wrap; gap: 6px; }
.tier-opt {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 12px; border-radius: var(--r-full); font-size: 11px; cursor: pointer;
  background: rgba(var(--text-3-rgb), 0.06);
  border: 1px solid rgba(var(--text-3-rgb), 0.14);
  color: var(--text-3);
  transition: background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast);
}
.tier-opt:hover {
  background: rgba(var(--text-3-rgb), 0.11);
  border-color: rgba(var(--text-3-rgb), 0.22);
  color: var(--text-2);
}
.tier-opt.on {
  background: rgba(var(--tag-hue-rgb, var(--primary-rgb)), 0.08);
  border-color: rgba(var(--tag-hue-rgb, var(--primary-rgb)), 0.2);
  color: var(--tag-hue, var(--primary));
  color: color-mix(in srgb, var(--tag-hue, var(--primary)) 75%, var(--text-1));
  font-weight: 500;
}
.tier-opt.on:hover {
  background: rgba(var(--tag-hue-rgb, var(--primary-rgb)), 0.14);
  border-color: rgba(var(--tag-hue-rgb, var(--primary-rgb)), 0.28);
}
/* 档位色相（沿用标签色相表语义：访问档 = 权限梯度色、模式 = 形态色、browser = 层级色） */
.tb-base-access { --tag-hue: #64748b; }
.tb-sandbox-access { --tag-hue: #0891b2; }
.tb-full-access { --tag-hue: #dc2626; }
.tb-tc-base { --tag-hue: #2563eb; }
.tb-tc-programmatic { --tag-hue: #7c3aed; }
.tb-tc-none { --tag-hue: #64748b; }
.tb-observe { --tag-hue: #0d9488; }
.tb-manipulate { --tag-hue: #ea580c; }
.tb-inject { --tag-hue: #be123c; }

/* LLM（cr-169：字段行已归 kit FieldRow，下拉/复位钮归 Select/IconAction） */
.llm-pane { display: flex; flex-direction: column; gap: 12px; }

/* provider/模型下拉容器（kit Select 宽度走内容流，此处定列宽） */
.llm-w-pool { min-width: 180px; max-width: 280px; }
.llm-w-models { max-width: 320px; flex-shrink: 1; min-width: 140px; }
/* 字段行控件列编排（徽章 + 控件 + 复位钮）。cr-176 位置统一：去 wrap——
 * 徽章恒定控件左侧（不随宽度折行到上方）；徽章/复位钮不收缩，控件自适应。 */
.llm-badge-and-ctrl { display: flex; align-items: center; gap: 6px; }
.llm-badge-and-ctrl > .llm-source, .llm-badge-and-ctrl > .ui-icon-action { flex-shrink: 0; }
.llm-badge-and-ctrl > * { min-width: 0; }
/* 当前生效读出（配置态在场信息，非动作结果反馈）——R7 判定不迁 FeedbackNotice
   （FeedbackNotice 只承载纯文本 text，本处 strong + src 两段结构不可压平） */
.llm-effective {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  font-size: 12px; color: var(--text-2);
  padding: 4px 10px; background: var(--primary-light);
  border: 1px solid var(--primary-border);
  border-radius: var(--r-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.llm-effective .llm-effective-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 生效状态点已归 kit StatusDot（status=ok；原 6px 靛蓝点 + 外晕随扁平化退役） */
.llm-effective strong { color: var(--text-1); font-weight: 600; }
.llm-effective-src { color: var(--text-3); }

/* 来源徽章（继承/本 Agent） */
.llm-source {
  margin-left: 6px; padding: 0 7px; border-radius: var(--r-full);
  font-size: 10px; font-weight: 400; line-height: 1.6; vertical-align: 1px;
}
.llm-source.is-override { color: var(--primary); background: var(--primary-light); border: 1px solid var(--primary-border); }
.llm-source.is-inherit { color: var(--text-3); background: var(--bg-inset); }
.llm-fields { display: flex; flex-direction: column; gap: 6px; }
.llm-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }

/* 旧契约迁移横幅（P2） */
.ext-legacy-banner {
  padding: 8px 12px; border-radius: var(--r-md);
  border: 1px solid rgba(var(--warn-rgb), 0.45);
  background: rgba(var(--warn-rgb), 0.1);
  color: var(--warn); font-size: 12px; line-height: 1.5;
}
.ext-legacy-banner.error {
  color: var(--err);
  border-color: rgba(var(--err-rgb), 0.45);
  background: rgba(var(--err-rgb), 0.1);
}

/* 插件 Agent 页签（settings-tab:agent） */
.agent-plugin-tab { display: flex; flex-direction: column; }
.agent-tab-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }

</style>