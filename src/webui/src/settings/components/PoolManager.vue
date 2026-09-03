<script setup lang="ts">
// ============================================================
// PoolManager.vue —— Provider 池管理
// · kind='llm'：Provider 连接管理（llm-provider-model-plan P5 v2）——
//   条目名 = provider 名；字段 = api_key（凭据侧信道）/ base_url /
//   defaultModel；模型清单由 /models 发现（「读取模型」经后端代理，
//   回写 config 发现缓存 → 热更重挂）。采样参数归 Agent 面，不在此。
// · kind='search'：搜索引擎池（原形态不变——provider 类型 + 调优字段）。
// ============================================================
import { ref, computed, watch } from 'vue';
import type { PoolEntry } from '../types';
import { toFields } from '../schema';
import type { FieldMeta } from '../types';
import { Modal, Button, Icon } from '@/ui';
import SettingField from './SettingField.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { fetchAgentModels, poolModelEntries, type PoolModelMeta } from '../../api/roster';
import { deleteLlmPoolCredential, probeLlmModels, probeLlmVision, LLM_PROVIDER_TEMPLATES } from '../api';

const props = defineProps<{
  kind: 'llm' | 'search';
  /** 池数据（直接读写） */
  pools: Record<string, PoolEntry>;
  /** provider → 原始 schema（search 用；llm 连接字段自持） */
  schemas: Record<string, any[]>;
  /** 保存回调（成功刷新后调用） */
  onSaved?: () => void;
}>();

// ── 字段基线 ──
// api_key 为凭据侧信道字段（password）：显示掩码（后端 config/get 回填，
// '••••••••'=已设置）、保存提取进凭据库（config.json 不落 key）——
// 掩码原样传回=保持不变，清空=删除，新值=覆盖。
// 弹窗渲染序（llm）：名称 → 提供方 → API Key → [API 地址(仅自定义)] →
// 默认模型 → 模型清单（列表控件：视觉/隐藏按模型勾选——读取时自动探测
// 视觉能力，无需手填清单）——内置提供方的地址由模板隐含，不展示。
const LLM_CONN_FIELDS: FieldMeta[] = [
  { key: 'api_key', label: 'API Key', description: '加密存于凭据库（不入 config.json）；显示 •• 为已设置，留空保存即删除', type: 'password', sensitive: true },
  { key: 'defaultModel', label: '默认模型', description: '该连接的默认模型（填入 API Key 自动读取清单后选择；缺省取第一个）', type: 'text' },
];

const SEARCH_FIELDS: FieldMeta[] = [
  { key: 'api_key', label: 'API Key', description: '加密存于凭据库（不入 config.json）；显示 •• 为已设置，留空保存即删除', type: 'password', sensitive: true },
  { key: 'baseURL', label: 'API 地址', type: 'text' },
  { key: 'model', label: '模型 ID', type: 'text' },
  { key: 'defaultResults', label: '默认结果数', type: 'number' },
  { key: 'defaultDepth', label: '默认深度', description: '如 basic / advanced', type: 'text' },
  { key: 'defaultTopic', label: '默认主题', description: '如 general / news', type: 'text' },
  { key: 'rawContentMaxLen', label: '原文截断长度', type: 'number' },
  { key: 'maxUses', label: '每日限额', type: 'number' },
];

/** 搜索池内各 provider 观测到的额外字段（基线之外，类型按值推断） */
function inferExtraFields(pools: Record<string, PoolEntry>): Map<string, FieldMeta[]> {
  const byProvider = new Map<string, Map<string, FieldMeta>>();
  const baseKeys = new Set(SEARCH_FIELDS.map((f) => f.key));
  for (const entry of Object.values(pools)) {
    const provider = typeof entry.provider === 'string' && entry.provider ? entry.provider : '';
    if (!provider) continue;
    const fields = byProvider.get(provider) ?? new Map<string, FieldMeta>();
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'default' || k === 'provider' || baseKeys.has(k) || fields.has(k)) continue;
      if (v === null || v === undefined) continue;
      fields.set(k, {
        key: k,
        label: k,
        type: typeof v === 'boolean' ? 'checkbox' : typeof v === 'number' ? 'number' : 'text',
      });
    }
    byProvider.set(provider, fields);
  }
  return new Map([...byProvider].map(([p, m]) => [p, [...m.values()]]));
}

/** 合成 schema（search：真 schema 优先；空则基线 + 观测字段） */
const effectiveSchemas = computed<Record<string, any[]>>(() => {
  if (props.kind === 'llm') return {};
  const out: Record<string, any[]> = { ...props.schemas };
  const extra = inferExtraFields(props.pools);
  const providers = new Set([...Object.keys(props.schemas), ...extra.keys()]);
  for (const p of providers) {
    if (out[p] && out[p].length > 0) continue;
    out[p] = [...SEARCH_FIELDS, ...(extra.get(p) ?? [])];
  }
  return out;
});

// ── 编辑弹窗状态 ──
const editingName = ref<string | null>(null); // null=列表视图, ''=新建, 'xxx'=编辑
const draft = ref<Record<string, any>>({});
const error = ref('');
const saved = ref('');
/** 模型发现（编辑弹窗内「读取模型」） */
const modelsLoading = ref(false);
const modelsError = ref('');

const providerOptions = computed(() => Object.keys(effectiveSchemas.value));
const currentProvider = computed(() => (draft.value.provider || 'tavily') as string);
/** llm 弹窗字段：内置提供方隐藏 API 地址（模板隐含）；自定义追加可编辑地址 */
const currentFields = computed<FieldMeta[]>(() => {
  if (props.kind === 'llm') {
    const base = [...LLM_CONN_FIELDS];
    if ((draft.value.template ?? '') === 'custom') {
      base.splice(1, 0, { key: 'base_url', label: 'API 地址', description: 'OpenAI 兼容 base URL', type: 'text' });
    }
    return base;
  }
  return toFields(effectiveSchemas.value[currentProvider.value]);
});

const title = computed(() => (props.kind === 'llm' ? '模型管理（Provider 连接）' : '搜索引擎'));

/** Provider 模板清单（仅 llm：新建预设——见 settings/api.ts 同源注释） */
const llmTemplates = LLM_PROVIDER_TEMPLATES;

/** 编辑中连接的模型发现缓存（列表 detail 同款来源）——能力元数据对象
 *  形态（{model, vision?, hidden?}）：vision = 探测确认收图（勾选位），
 *  hidden = 前端下拉隐藏（勾选位）。draft 优先于池条目（读取后
 *  未保存的探测/隐藏位不丢失）。
 *  【倒序显示】模型命名版本随时间走高（glm-4.6v > glm-4.5v），按名
 *  降序 ≈ 新模型靠前；「缺省取第一个」同款口径（readModelList）。 */
const draftModels = computed<PoolModelMeta[]>(() => {
  if (props.kind !== 'llm') return [];
  const name = (draft.value.poolName || editingName.value || '').trim();
  const fromEntry = poolModelEntries(props.pools[name]?.models);
  const own = poolModelEntries(draft.value.models);
  // draft 中同名条目胜（探测刷新/隐藏切换后的最新态）
  const byModel = new Map(fromEntry.map((e) => [e.model, e]));
  for (const e of own) byModel.set(e.model, e);
  return [...byModel.values()].sort((a, b) => b.model.localeCompare(a.model));
});

/** 视觉探测进行中（读取模型后自动跑；chips 徽章就位前显示探测态） */
const visionProbing = ref(false);

function startAdd() {
  editingName.value = '';
  error.value = '';
  saved.value = '';
  modelsError.value = '';
  draft.value = props.kind === 'llm'
    ? { template: '' }
    : applyDefaults({ provider: currentProvider.value });
}
function startEdit(name: string) {
  editingName.value = name;
  error.value = '';
  saved.value = '';
  modelsError.value = '';
  const entry = JSON.parse(JSON.stringify(props.pools[name] ?? {}));
  if (props.kind === 'llm') {
    // 模板反查（按 base_url 匹配；不匹配 = 自定义）
    const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.baseUrl === entry.base_url);
    draft.value = { poolName: name, template: tpl?.id ?? 'custom', ...entry };
    // 旧 visionModels 手写清单退役：视觉判定 = 逐模型探测（models[].vision，
    // 列表内可手动改勾）——编辑保存即从条目移除旧键（后端门控仍兼容该键）
    delete draft.value.visionModels;
  } else {
    const provider = entry.provider || currentProvider.value;
    draft.value = { ...applyDefaults({ provider }), ...entry };
  }
}
function cancelEdit() {
  editingName.value = null;
  draft.value = {};
}

function applyDefaults(entry: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...entry };
  const schema = effectiveSchemas.value[out.provider];
  if (schema) {
    for (const f of toFields(schema)) {
      if (f.default !== undefined && out[f.key] === undefined) out[f.key] = f.default;
    }
  }
  return out;
}

/** 切换 provider（仅 search）：保留名称，应用新 provider 的默认值 */
function onProviderChange(newProvider: string) {
  const name = draft.value.poolName;
  draft.value = applyDefaults({ provider: newProvider });
  if (name !== undefined) draft.value.poolName = name;
}

/** 选 Provider 模板（仅 llm）：预填 base_url/defaultModel；名称为空时
 *  预填模板 id（同名即该 provider 引用名；多账号可另起名）。'custom'
 *  = 自定义端点（清空 base_url 手填）。 */
function onTemplateChange(templateId: string) {
  draft.value.template = templateId;
  const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.id === templateId);
  draft.value.base_url = tpl?.baseUrl ?? '';
  draft.value.defaultModel = tpl?.defaultModel ?? '';
  const name = (draft.value.poolName || '').trim();
  if (!name && tpl) draft.value.poolName = tpl.id;
}

/** 读取模型清单（llm）：优先免注册探测（base_url + Key 直调 /models——
 *  保存前可用）；编辑已保存条目且 Key 未改动（掩码/空）→ 注册路径
 *  （服务端凭据）。成功后默认模型缺省/不在清单 → 取第一个。 */
async function readModelList() {
  if (props.kind !== 'llm') return;
  const apiKey = String(draft.value.api_key ?? '');
  const baseUrl = String(draft.value.base_url ?? '').trim();
  const name = (draft.value.poolName || editingName.value || '').trim();
  const masked = apiKey === '••••••••';
  const canProbe = !!baseUrl && !!apiKey && !masked;
  const canRegistered = !!editingName.value && (masked || !apiKey) && !!name;
  if (!canProbe && !canRegistered) {
    modelsError.value = baseUrl ? '请先填写 API Key' : '请先选择提供方（自定义需填 API 地址）';
    return;
  }
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    let list: string[] = [];
    if (canProbe) {
      list = (await probeLlmModels(baseUrl, apiKey)).models;
    } else {
      list = (await fetchAgentModels(name, true)).models;
      // 注册路径服务端回写缓存（后端已按新清单合并保留 flags）——池状态
      // 并入 models 再落盘（防旧状态覆盖；此处同样按归一合并保 flags）
      const merged = [...new Set([
        ...poolModelEntries(props.pools[name]?.models).map((e) => e.model),
        ...list,
      ])].map((model) => {
        const prev = poolModelEntries(props.pools[name]?.models).find((e) => e.model === model);
        return prev && (prev.vision === true || prev.hidden === true) ? prev : model;
      });
      const pool = { ...props.pools };
      pool[name] = { ...((pool[name] as Record<string, unknown>) ?? {}), models: merged };
      emit('update:pools', pool);
      props.onSaved?.();
    }
    if (!list.length) throw new Error('未获取到模型列表');
    // 清单入 draft：继承池条目已有 flags（探测/隐藏位跨读取不丢）
    const prevEntries = poolModelEntries(props.pools[name]?.models);
    draft.value.models = list.map((model) => {
      const prev = prevEntries.find((e) => e.model === model);
      return prev && (prev.vision === true || prev.hidden === true) ? prev : { model };
    });
    if (!draft.value.defaultModel || !list.includes(String(draft.value.defaultModel))) {
      // 缺省取列表显示序第一个 = 倒序口径的最新模型（与 draftModels 一致）
      draft.value.defaultModel = [...list].sort((a, b) => b.localeCompare(a))[0];
    }
    // 视觉能力探测（模型能力元数据）：读取即自动跑——逐模型 1×1 图
    // 三态判定，true/false 写入 draft.models[].vision（null 未知不写）；
    // 静默失败（探测失败不阻塞清单编辑，chips 无徽章即未探测）
    void probeVisionFor(list, { baseUrl: canProbe ? baseUrl : undefined, apiKey: canProbe ? apiKey : undefined, provider: canRegistered ? name : undefined });
  } catch (err: any) {
    modelsError.value = `读取失败：${err.message}`;
  } finally {
    modelsLoading.value = false;
  }
}

/** chip 开关：前端下拉隐藏（hidden = 纯 UI 呈现语义——路由与已选该模型
 *  的会话不受影响；保存时随对象形态落盘） */
function toggleModelHidden(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.map((e) =>
    e.model === model
      ? (e.hidden === true ? { model: e.model, ...(e.vision === true ? { vision: true } : {}) } : { ...e, hidden: true })
      : e,
  );
}

/** 视觉探测（readModelList 收尾异步跑）：结果并入 draft.models 对象形态 */
async function probeVisionFor(
  models: string[],
  route: { baseUrl?: string; apiKey?: string; provider?: string },
): Promise<void> {
  if (props.kind !== 'llm' || models.length === 0) return;
  visionProbing.value = true;
  try {
    const { results } = await probeLlmVision({
      models,
      ...(route.baseUrl ? { baseUrl: route.baseUrl, ...(route.apiKey ? { apiKey: route.apiKey } : {}) } : {}),
      ...(route.provider ? { provider: route.provider } : {}),
    });
    const current = poolModelEntries(draft.value.models);
    draft.value.models = current.map((e) => {
      const verdict = results[e.model];
      if (verdict === true) return { ...e, vision: true };
      // 探测明确否定 → 摘除旧 vision 位（模型换代/清单刷新后纠偏）
      if (verdict === false && e.vision === true) return { model: e.model, ...(e.hidden === true ? { hidden: true } : {}) };
      return e;
    });
  } catch {
    /* 探测失败静默：列表未勾 = 未探测，用户可重读重试或手动勾选 */
  } finally {
    visionProbing.value = false;
  }
}

/** 列表勾选：视觉能力（探测自动勾 + 手动改勾——探测未知/纠偏均可手调；
 *  保存时随对象形态落盘，池侧与显式 visionModels 并集入门控） */
function toggleModelVision(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.map((e) =>
    e.model === model
      ? (e.vision === true ? { model: e.model, ...(e.hidden === true ? { hidden: true } : {}) } : { ...e, vision: true })
      : e,
  );
}

/** 自动探测：llm 弹窗内（提供方/地址 + 真实 Key 就绪）防抖 600ms 自动读取
 *  一次；已有清单不重复读（按钮可强制重读） */
let probeTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [draft.value.api_key, draft.value.template, draft.value.base_url],
  () => {
    if (props.kind !== 'llm' || editingName.value === null) return;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      const apiKey = String(draft.value.api_key ?? '');
      const baseUrl = String(draft.value.base_url ?? '').trim();
      if (!baseUrl || !apiKey || apiKey === '••••••••') return;
      if (Array.isArray(draft.value.models) && (draft.value.models as unknown[]).length > 0) return;
      void readModelList();
    }, 600);
  },
);

function saveEntry() {
  const name = (draft.value.poolName || editingName.value || '').trim();
  if (!name) { error.value = '请输入名称'; return; }
  const { poolName, models, template, ...entry } = draft.value;
  void template;
  // llm：模型清单随条目落盘（保存即完整可用；改名同样跟随）——宽容双
  // 形态归一后写最小形态：无 flags = 裸 string（兼容旧格式/省空间），
  // 有 vision/hidden = 对象（能力元数据：探测结果 + 列表内手动勾选）
  if (props.kind === 'llm') {
    const normalized = poolModelEntries(models);
    if (normalized.length > 0) {
      entry.models = normalized.map((e) => (e.vision === true || e.hidden === true ? e : e.model));
    }
  }
  // 清理空值（v-model.number 空值会返回 ""，导致 API 400）。
  // 例外：api_key 的空串有语义（= 删除凭据），必须传到后端。
  for (const [k, v] of Object.entries(entry)) {
    if ((v === '' || v === undefined) && k !== 'api_key') delete entry[k];
  }
  // ratio 字段：default=undefined 且值==min 时视为"使用 API 默认"，不保存
  for (const f of currentFields.value) {
    if (f.type === 'ratio' && f.default === undefined && entry[f.key] === f.min) delete entry[f.key];
  }
  const pool = { ...props.pools };
  if (editingName.value && editingName.value !== name) {
    delete pool[editingName.value];
  }
  // 池中无条目时，首个自动设为默认
  const existingKeys = Object.keys(pool).filter(k => !k.startsWith('$'));
  if (existingKeys.length === 0 || (existingKeys.length === 1 && existingKeys[0] === name)) {
    entry.default = true;
    for (const k of existingKeys) {
      if (k !== name && pool[k]?.default) delete pool[k].default;
    }
  }
  pool[name] = entry;
  emit('update:pools', pool);
  editingName.value = null;
  draft.value = {};
  saved.value = '已保存';
  setTimeout(() => { saved.value = ''; }, 2000);
  // 落盘完成后，新建连接若无发现缓存 → 自动「读取模型」一次（静默失败：
  // key 无效时用户可经「读取模型」看重试报错）——选模板 + 填 Key 即完成
  if (props.kind === 'llm' && !(Array.isArray(models) && models.length > 0)) {
    void (async () => {
      try { await props.onSaved?.(); } catch { /* onSaved 自行提示 */ }
      try { await fetchAgentModels(name, true); } catch { /* 静默 */ }
    })();
  } else {
    props.onSaved?.();
  }
}

/** 删除连接（llm）：确认弹窗（ConfirmDialog，勿用原生 confirm）后同步
 *  删除凭据 pool:<名>——否则内置种子的 /models 发现回写会凭残留凭据
 *  把条目"复活"（刷新后又出现）。 */
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
async function removeEntry(name: string) {
  if (props.kind === 'llm') {
    const ok = await confirmRef.value?.ask({
      title: `删除连接 "${name}"？`,
      message: '将同时删除其 API Key（凭据库）。\n引用此 provider 的 Agent 将无法调用，需重新配置。',
      confirmLabel: '删除连接',
      danger: true,
    });
    if (!ok) return;
  }
  const pool = { ...props.pools };
  delete pool[name];
  emit('update:pools', pool);
  props.onSaved?.();
  if (props.kind === 'llm') {
    void deleteLlmPoolCredential(name).catch((err: any) => {
      error.value = `凭据删除失败（条目已删，但 /models 发现可能复活它）: ${err?.message ?? err}`;
    });
  }
}

function setDefault(name: string) {
  const pool: Record<string, PoolEntry> = {};
  for (const [k, v] of Object.entries(props.pools)) {
    if (!k.startsWith('$') && v && typeof v === 'object') pool[k] = { ...v, default: k === name };
    else pool[k] = v;
  }
  emit('update:pools', pool);
  props.onSaved?.();
}

/** 条目 detail（列表第二行） */
function detailOf(name: string, entry: PoolEntry): string {
  if (props.kind === 'llm') {
    const parts = [entry.base_url || '内置地址'];
    if (entry.defaultModel) parts.push(String(entry.defaultModel));
    const entries = poolModelEntries(entry.models);
    const n = entries.length;
    if (n > 0) parts.push(`${n} 个模型`);
    // 视觉能力 = 显式 visionModels ∪ 探测标志（models[].vision）
    const visionCount =
      entries.filter((e) => e.vision === true).length + (Array.isArray(entry.visionModels) ? (entry.visionModels as unknown[]).filter((m) => typeof m === 'string' && m && !entries.some((e) => e.model === m)).length : 0);
    if (visionCount > 0) parts.push(`视觉 ×${visionCount}`);
    return parts.join(' · ');
  }
  return `${entry.provider ?? ''}${entry.model && entry.model !== name ? ' / ' + entry.model : ''}`;
}

const emit = defineEmits<{ (e: 'update:pools', v: Record<string, PoolEntry>): void }>();
</script>

<template>
  <div class="pool">
    <div class="pool-head">
      <span class="pool-title">{{ title }}</span>
      <button class="pool-add" @click="startAdd">+ 添加</button>
    </div>

    <div v-if="Object.keys(pools).filter(k => !k.startsWith('$')).length === 0" class="pool-empty">
      <template v-if="kind === 'llm'">暂无连接——未配置任何模型（会话将无法发送）；点击"+ 添加"接入 OpenAI 兼容端点</template>
      <template v-else>暂无条目，点击"+ 添加"创建</template>
    </div>
    <div v-else class="pool-list">
      <div
        v-for="(entry, name) in pools" :key="name"
        v-show="!String(name).startsWith('$')"
        class="pool-entry ui-row" :class="{ 'is-selected': entry.default }"
      >
        <div class="pool-entry-info">
          <span class="pool-entry-name">
            <span v-if="entry.default" class="pool-star" title="当前默认"><Icon name="star" :size="10" /></span>
            {{ name }}
          </span>
          <span class="pool-entry-detail">{{ detailOf(String(name), entry) }}</span>
        </div>
        <div class="pool-entry-actions">
          <button v-if="!entry.default" class="pool-set-default" @click="setDefault(String(name))" title="设为默认">设为默认</button>
          <button class="pool-btn" @click="startEdit(String(name))">编辑</button>
          <button class="pool-btn danger" @click="removeEntry(String(name))">删除</button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editingName !== null" :title="editingName ? '编辑 ' + editingName : '新建条目'" :width="440" :z-index="1200" @close="cancelEdit()">
      <div class="pool-modal-body">
        <!-- 提供方（仅 llm）：预设 base_url/defaultModel——内置提供方不展示
             API 地址（模板隐含）；选自定义才出现可编辑地址字段。
             选项显示模板 id（= 引用名锚点，如 deepseek / glm），描述走 title -->
        <div v-if="kind === 'llm'" class="pool-row">
          <label>提供方</label>
          <select class="pool-input" :value="draft.template || ''" @change="onTemplateChange(($event.target as HTMLSelectElement).value)">
            <option value="" disabled>选择提供方…</option>
            <option v-for="t in llmTemplates" :key="t.id" :value="t.id" :title="t.label">{{ t.id }}</option>
            <option value="custom">自定义（手填 API 地址）</option>
          </select>
        </div>
        <div class="pool-row">
          <label>{{ kind === 'llm' ? '名称（= 引用名 name@model 的左段；多账号可另起名）' : '名称' }}</label>
          <input v-model="draft.poolName" type="text" class="pool-input" :placeholder="editingName || (kind === 'llm' ? '缺省同模板名，如 myds' : '输入条目名称')" />
        </div>
        <div v-if="kind === 'search'" class="pool-row">
          <label>Provider 类型</label>
          <select class="pool-input" :value="currentProvider" @change="onProviderChange(($event.target as HTMLSelectElement).value)">
            <option v-for="p in providerOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div v-for="f in currentFields" :key="f.key" class="pool-field">
          <div class="pool-field-label">{{ f.label }}</div>
          <div v-if="f.description" class="pool-field-desc">{{ f.description }}</div>
          <div class="pool-field-control">
            <SettingField v-if="!(kind === 'llm' && f.key === 'defaultModel' && draftModels.length)" :field="f" :model-value="draft[f.key]" @update:model-value="draft[f.key] = $event" />
            <select v-else class="pool-input" :value="draft.defaultModel" @change="draft.defaultModel = ($event.target as HTMLSelectElement).value">
              <option v-for="m in draftModels" :key="m.model" :value="m.model">{{ m.model }}</option>
            </select>
          </div>
        </div>
        <!-- 模型清单（llm 连接专属）：填 Key 自动读取（免注册 base_url+Key
             直调）；读取后自动逐模型探测视觉能力；列表控件 = 每行模型 +
             视觉/隐藏两个勾选位；点击模型名设为默认模型 -->
        <div v-if="kind === 'llm'" class="pool-field">
          <div class="pool-field-label">模型清单</div>
          <div class="pool-field-desc">填入 API Key 后自动读取{{ visionProbing ? '（正在逐模型探测视觉能力…）' : '（读取时逐模型探测视觉能力）' }}；「视觉」勾选 = 支持图片输入（探测自动勾，可手动改）；「隐藏」勾选 = 从前端下拉隐藏；点击模型名设为默认</div>
          <div class="pool-field-control">
            <button class="pool-add" :disabled="modelsLoading" @click="readModelList">{{ modelsLoading ? '读取中…' : draftModels.length ? '重新读取' : '读取模型' }}</button>
            <span v-if="modelsError" class="pool-error">{{ modelsError }}</span>
          </div>
          <div v-if="draftModels.length" class="pool-model-list">
            <div class="pool-model-row pool-model-head">
              <span class="pool-model-name">模型</span>
              <span class="pool-model-flags">
                <span class="pool-model-flag-label">视觉</span>
                <span class="pool-model-flag-label">隐藏</span>
              </span>
            </div>
            <div
              v-for="m in draftModels"
              :key="m.model"
              class="pool-model-row"
              :class="{ 'is-default': m.model === draft.defaultModel, 'is-hidden': m.hidden === true }"
            >
              <button
                type="button"
                class="pool-model-name pool-model-name-btn"
                :title="m.model === draft.defaultModel ? '默认模型' : '点击设为默认模型'"
                @click="draft.defaultModel = m.model"
              >{{ m.model }}</button>
              <span class="pool-model-flags">
                <label class="pool-model-flag" :title="m.vision === true ? '支持图片输入（附件图片会真正发给模型）' : '未标记视觉——附件图片仅作文件路径文本附带'">
                  <input
                    type="checkbox"
                    :checked="m.vision === true"
                    @change="toggleModelVision(m.model)"
                  />
                </label>
                <label class="pool-model-flag" :title="m.hidden === true ? '已隐藏：前端模型下拉不显示（路由与已选会话不受影响）' : '勾选后从前端模型下拉隐藏'">
                  <input
                    type="checkbox"
                    :checked="m.hidden === true"
                    @change="toggleModelHidden(m.model)"
                  />
                </label>
              </span>
            </div>
          </div>
        </div>
        <div v-if="error" class="pool-error">{{ error }}</div>
        <div v-if="saved" class="pool-saved">{{ saved }}</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="cancelEdit()">取消</Button>
        <Button variant="primary" @click="saveEntry">保存</Button>
      </template>
    </Modal>

    <!-- 删除确认（通用 ConfirmDialog，替代原生 confirm） -->
    <ConfirmDialog ref="confirmRef" />
  </div>
</template>

<style scoped>
.pool { display: flex; flex-direction: column; gap: 12px; }
.pool-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.pool-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.pool-add {
  padding: 5px 14px; border: 1px solid var(--primary); border-radius: var(--r-md);
  background: transparent; color: var(--primary); font-size: 12px; cursor: pointer; transition: all var(--dur-fast);
}
.pool-add:hover { background: var(--primary-light); }
.pool-add:disabled { opacity: .5; cursor: not-allowed; }
.pool-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }
.pool-list { display: flex; flex-direction: column; gap: 6px; }
.pool-entry {
  /* C8 收敛 A 语言：底座 = ui/row.css .ui-row（默认条目标记 = .is-selected
     星色描边——StarCard.selected 同 recipe） */
  justify-content: space-between; padding: 8px 12px;
}
.pool-entry-info { display: flex; flex-direction: column; gap: 2px; }
.pool-entry-name { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-star { color: var(--warn); margin-right: 4px; display: inline-flex; align-items: center; }
.pool-entry-detail { font-size: 11px; color: var(--text-3); }
.pool-entry-actions { display: flex; gap: 6px; }
.pool-btn {
  padding: 4px 11px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; transition: all var(--dur-fast);
}
.pool-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.pool-btn.danger { color: var(--err); }
.pool-btn.danger:hover { background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); }
.pool-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.pool-set-default {
  padding: 4px 11px; border: 1px solid var(--warn); border-radius: var(--r-md);
  background: transparent; color: var(--warn); font-size: 11px; cursor: pointer;
}
.pool-set-default:hover { background: rgba(243,156,18,.1); }

.pool-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.pool-row { display: flex; flex-direction: column; gap: 4px; }
.pool-row label { font-size: 12px; color: var(--text-2); }
.pool-input {
  padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
}
.pool-input:focus { outline: none; border-color: var(--input-focus); }
.pool-field { padding: 7px 0; border-bottom:  1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.pool-field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-field-desc { font-size: 11px; color: var(--text-3); }
.pool-field-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }

/* 模型清单列表控件：每行 = 模型名（点击设默认）+ 视觉/隐藏勾选位 */
.pool-model-list {
  display: flex; flex-direction: column;
  margin-top: 4px; max-height: 260px; overflow-y: auto;
  border: 1px solid var(--line); border-radius: var(--r-sm);
}
.pool-model-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 10px; font-size: 12px;
  border-bottom: 1px solid var(--line);
}
.pool-model-row:last-child { border-bottom: none; }
.pool-model-head {
  position: sticky; top: 0; background: var(--bg-hover, rgba(0,0,0,0.03));
  color: var(--text-3); font-size: 11px; padding: 3px 10px;
}
.pool-model-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono, monospace); color: var(--text-2);
}
.pool-model-name-btn {
  border: none; background: none; padding: 0; cursor: pointer; text-align: left;
  font: inherit; font-family: var(--font-mono, monospace);
}
.pool-model-name-btn:hover { color: var(--primary, #4f46e5); }
.pool-model-row.is-default .pool-model-name {
  color: var(--primary, #4f46e5); font-weight: 600;
}
.pool-model-row.is-default .pool-model-name-btn::after {
  content: ' ·默认'; font-weight: 400; font-size: 10px;
}
.pool-model-row.is-hidden .pool-model-name {
  text-decoration: line-through; opacity: 0.55;
}
.pool-model-flags { display: inline-flex; align-items: center; gap: 14px; flex-shrink: 0; }
.pool-model-flag-label { width: 14px; text-align: center; }
.pool-model-flag { display: inline-flex; align-items: center; cursor: pointer; }
.pool-model-flag input { margin: 0; cursor: pointer; accent-color: var(--primary, #4f46e5); }
.pool-error { color: var(--err); font-size: 12px; }
.pool-saved { color: var(--ok); font-size: 12px; }
</style>
