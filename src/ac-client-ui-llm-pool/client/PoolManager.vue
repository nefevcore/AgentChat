<script setup lang="ts">
// ============================================================
// PoolManager.vue —— Provider 连接池管理（llm 连接专属）
//（M28 P2 自 settings 随域迁入 ui-llm-pool；2026-09-11 行拆分——
//  原 kind='llm'/'search' 双形态组件收窄为 llm 单形态，搜索引擎池
//  拆往 ac-client-ui-search-pool/SearchPoolManager——两对象两件，
//  行为与拆分前 kind='llm' 分支逐字节等价。）
// · 条目名 = provider 名；字段 = api_key（凭据侧信道）/ base_url /
//   defaultModel；模型清单由 /models 发现（「读取模型」经后端代理，
//   回写 config 发现缓存 → 热更重挂）。采样参数归 Agent 面，不在此。
// ============================================================
import { ref, computed, watch } from 'vue';
import type { PoolEntry, FieldMeta } from 'ac-client-ui-settings/client/types.ts';
import { Input, Modal, Button, Icon, Select, toastOk } from '@agentchat/webui-kit';
import SettingField from 'ac-client-ui-settings/client/components/SettingField.vue';
import ConfirmDialog from 'ac-client-ui-settings/client/components/ConfirmDialog.vue';
// agents 数据面直连已退役（2026-09-11 语义归位：模型发现/池模型归一化
// 迁入本包 poolApi——原 M29 P1-3b 经 .vue 媒介跨行借住 ui-agents
// rosterApi 的错位边消化；rpc seam 仍经 settings rpcDefault 缺省锚）
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
// 池写/探测/发现面（M29 P1-3d 归域 + 2026-09-11 语义归位——本包 poolApi）；
// 连接模板留守 settings（getLlmSchemas 的 schema 引擎消费
// LLM_PROVIDER_DEFAULTS——base 不可反向依赖 domain，domain→base 取用合法）
import { deleteLlmPoolCredential, fetchPoolModels, probeLlmModels, probeLlmVision, poolModelEntries, providerIconOf, providerIconColor, type PoolModelMeta } from './poolApi.ts';
import { LLM_PROVIDER_TEMPLATES } from 'ac-client-ui-settings/client/api.ts';
import { fetchPoolReferences } from './poolApi.ts';

const props = defineProps<{
  /** 池数据（直接读写） */
  pools: Record<string, PoolEntry>;
  /** 保存回调（成功刷新后调用） */
  onSaved?: () => void;
}>();

// ── 字段基线 ──
// api_key 为凭据侧信道字段（password）：显示掩码（后端 config/get 回填，
// '••••••••'=已设置）、保存提取进凭据库（config.json 不落 key）——
// 掩码原样传回=保持不变，清空=删除，新值=覆盖。
// 弹窗渲染序（llm）：名称 → 提供方 → API Key → [API 地址(仅自定义)] →
// 接口格式 → 默认模型 → 模型清单（列表控件：视觉/隐藏按模型勾选——读取
// 时自动探测视觉能力，无需手填清单）——内置提供方的地址由模板隐含，不
// 展示。
const LLM_CONN_FIELDS: FieldMeta[] = [
  { key: 'api_key', label: 'API Key', description: '加密存于凭据库（不入 config.json）；显示 •• 为已设置，留空保存即删除', type: 'password', sensitive: true },
  { key: 'defaultModel', label: '默认模型', description: '该连接的默认模型（填入 API Key 自动读取清单后选择；缺省取第一个）', type: 'text' },
];

// 接口格式（2026-09-10 Responses 扩展，对齐 DSH/pi-ai 的 api 键）：
// '' = chat/completions（缺省；保存时空串清理即回落）；'responses' =
// POST /responses。仅 openai-compat 协议有意义（其余协议线格式由
// protocol 决定）。模型不支持该格式时端点如实报错（404/400）
const API_FORMAT_FIELD: FieldMeta = {
  key: 'api', label: '接口格式', description: 'Responses API = POST /responses（OpenAI 新模型 / xAI 等支持的格式）；模型不支持会如实报错', type: 'select', options: [
    { label: 'Chat Completions（默认）', value: '' },
    { label: 'Responses API', value: 'responses' },
  ],
};

// ── 编辑弹窗状态 ──
const editingName = ref<string | null>(null); // null=列表视图, ''=新建, 'xxx'=编辑
const draft = ref<Record<string, any>>({});
const error = ref('');
/** 模型发现（编辑弹窗内「读取模型」） */
const modelsLoading = ref(false);
const modelsError = ref('');

/** 协议选项（cr-39 多态；与后端 PROTOCOLS 键集对齐——前端清单副本，
 *  值域变化随协议库扩展同步） */
const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 兼容（chat/completions）', value: '' },
  { label: 'Anthropic 原生（/v1/messages）', value: 'anthropic' },
  { label: 'Google Gemini 原生（generateContent）', value: 'gemini' },
  { label: 'Ollama 原生（/api/chat）', value: 'ollama' },
];

/** 当前草稿的协议（缺省 openai-compat；模板自带协议优先） */
const draftProtocol = computed<string>(() => {
  const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.id === draft.value.template);
  if (tpl?.protocol) return tpl.protocol;
  const p = String(draft.value.protocol ?? '');
  return PROTOCOL_OPTIONS.some((o) => o.value === p) ? p : '';
});

/** llm 弹窗字段：内置提供方隐藏 API 地址（模板隐含）；自定义追加
 *  协议选择 + 可编辑地址 */
const currentFields = computed<FieldMeta[]>(() => {
  const base = [...LLM_CONN_FIELDS];
  if ((draft.value.template ?? '') === 'custom') {
    base.splice(1, 0, { key: 'protocol', label: '协议', description: '端点线格式：OpenAI 兼容缺省；其余为厂商原生协议（cr-39 协议多态）', type: 'select', options: PROTOCOL_OPTIONS });
    base.splice(2, 0, { key: 'base_url', label: 'API 地址', description: '协议根地址（openai-compat = /v1 根；anthropic/gemini = 域名根；ollama = 服务根，如 http://localhost:11434）', type: 'text' });
  }
  return base;
});

const title = '模型管理（Provider 连接）';

/** Provider 模板清单（新建预设——见 settings/api.ts 同源注释） */
const llmTemplates = LLM_PROVIDER_TEMPLATES;
/** kit Select 选项表（cr-169）：占位项禁选（语义同原生 option disabled）；
 *  icon = 厂商品牌 logo（cr-205，域名映射自模板 baseUrl——azure 占位符
 *  URL 亦命中；custom 无）；iconColor = 品牌官方色（cr-206，黑白系缺省随墨色） */
const templateOptions = computed(() => [
  { value: '', label: '选择提供方…', disabled: true },
  ...llmTemplates.map((t) => {
    const icon = providerIconOf(t.baseUrl);
    return { value: t.id, label: t.id, ...(icon ? { icon, iconColor: providerIconColor(icon) ?? '' } : {}) };
  }),
  { value: 'custom', label: '自定义（手填 API 地址）' },
]);

/** 编辑中连接的模型发现缓存（列表 detail 同款来源）——能力元数据对象
 *  形态（{model, vision?, hidden?, manual?}）：vision = 探测确认收图
 *  （勾选位），hidden = 前端下拉隐藏（勾选位），manual = 手工新增
 *  （可删位）。draft 优先于池条目（读取后未保存的探测/隐藏位不丢失）。
 *  【倒序显示】模型命名版本随时间走高（glm-4.6v > glm-4.5v），按名
 *  降序 ≈ 新模型靠前；「缺省取第一个」同款口径（readModelList）。 */
const draftModels = computed<PoolModelMeta[]>(() => {
  const name = (draft.value.poolName || editingName.value || '').trim();
  const fromEntry = poolModelEntries(entryOf(name)?.models);
  const own = poolModelEntries(draft.value.models);
  // draft 中同名条目胜（探测刷新/隐藏切换后的最新态）
  const byModel = new Map(fromEntry.map((e) => [e.model, e]));
  for (const e of own) byModel.set(e.model, e);
  return [...byModel.values()].sort((a, b) => b.model.localeCompare(a.model));
});
/** kit Select 选项表（cr-169） */
const draftModelOptions = computed(() => draftModels.value.map((m) => ({ value: m.model, label: m.model })));

/** 视觉探测进行中（读取模型后自动跑；chips 徽章就位前显示探测态） */
const visionProbing = ref(false);

function startAdd() {
  editingName.value = '';
  error.value = '';
  modelsError.value = '';
  draft.value = { template: '' };
}
function startEdit(name: string) {
  editingName.value = name;
  error.value = '';
  modelsError.value = '';
  const entry = JSON.parse(JSON.stringify(props.pools[name] ?? {}));
  // 模板反查（按 base_url 匹配；不匹配 = 自定义）
  const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.baseUrl === entry.base_url);
  draft.value = { poolName: name, template: tpl?.id ?? 'custom', ...entry };
  // 旧 visionModels 手写清单退役：视觉判定 = 逐模型探测（models[].vision，
  // 列表内可手动改勾）——编辑保存即从条目移除旧键（后端门控仍兼容该键）
  delete draft.value.visionModels;
}
function cancelEdit() {
  editingName.value = null;
  draft.value = {};
}

/** 选 Provider 模板：预填 base_url/defaultModel；名称为空时
 *  预填模板 id（同名即该 provider 引用名；多账号可另起名）。'custom'
 *  = 自定义端点（清空 base_url 手填）。 */
function onTemplateChange(templateId: string) {
  draft.value.template = templateId;
  const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.id === templateId);
  draft.value.base_url = tpl?.baseUrl ?? '';
  draft.value.defaultModel = tpl?.defaultModel ?? '';
  draft.value.api = ''; // 切换提供方重置接口格式（模板均为缺省 completions）
  draft.value.protocol = tpl?.protocol ?? ''; // 协议随模板（原生协议模板预填）
  draft.value.authHeader = tpl?.authHeader ?? ''; // 鉴权头名随模板（Azure api-key；缺省 Bearer）
  const name = (draft.value.poolName || '').trim();
  if (!name && tpl) draft.value.poolName = tpl.id;
}

/** 读取模型清单：优先免注册探测（base_url + Key 直调 /models——
 *  保存前可用）；编辑已保存条目且 Key 未改动（掩码/空）→ 注册路径
 *  （服务端凭据）。成功后默认模型缺省/不在清单 → 取第一个。 */
async function readModelList() {
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
      list = (await probeLlmModels(baseUrl, apiKey, defaultRpc)).models;
    } else {
      list = (await fetchPoolModels(name, true, defaultRpc)).models;
      // 注册路径服务端回写缓存（后端已按新清单合并保留 flags）——池状态
      // 并入 models 再落盘（防旧状态覆盖；此处同样按归一合并保 flags）
      const merged = [...new Set([
        ...poolModelEntries(entryOf(name)?.models).map((e) => e.model),
        ...list,
      ])].map((model) => {
        const prev = poolModelEntries(entryOf(name)?.models).find((e) => e.model === model);
        return prev && (prev.vision === true || prev.hidden === true || prev.manual === true) ? prev : model;
      });
      const pool = { ...props.pools };
      pool[name] = { ...((entryOf(name) ?? {}) as Record<string, unknown>), models: merged };
      emit('update:pools', pool);
      props.onSaved?.();
    }
    if (!list.length) throw new Error('未获取到模型列表');
    // 清单入 draft：继承池条目已有 flags（探测/隐藏/手工位跨读取不丢）；
    // 手工条目不在发现清单内 → 追加保留（重读不冲掉手工新增）
    const prevEntries = poolModelEntries(entryOf(name)?.models);
    const discovered = list.map((model) => {
      const prev = prevEntries.find((e) => e.model === model);
      return prev && (prev.vision === true || prev.hidden === true || prev.manual === true) ? prev : { model };
    });
    const manualDraft = poolModelEntries(draft.value.models).filter((e) => e.manual === true);
    const seen = new Set(discovered.map((e) => e.model));
    draft.value.models = [...discovered, ...manualDraft.filter((e) => !seen.has(e.model))];
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

/** 手工新增模型（端点不暴露 /models 清单时手工补模型 id）：归一去重后
 *  追加 manual 条目（发现刷新不冲掉）；首个手工条目可兼作默认模型。 */
const manualModelInput = ref('');
function addManualModel(): void {
  const id = manualModelInput.value.trim();
  if (!id) return;
  manualModelInput.value = '';
  const current = poolModelEntries(draft.value.models);
  if (current.some((e) => e.model === id)) return; // 已在清单（发现/手工）——不重复
  draft.value.models = [...current, { model: id, manual: true }];
  if (!draft.value.defaultModel) draft.value.defaultModel = id;
}

/** 删除模型条目（当前仅手工条目提供删除位——发现条目重读即回） */
function removeModelEntry(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.filter((e) => e.model !== model);
  if (draft.value.defaultModel === model) {
    const next = current.find((e) => e.model !== model && e.hidden !== true);
    draft.value.defaultModel = next ? next.model : '';
  }
}

/** chip 开关：前端下拉隐藏（hidden = 纯 UI 呈现语义——路由与已选该模型
 *  的会话不受影响；保存时随对象形态落盘） */
function toggleModelHidden(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.map((e) =>
    e.model === model
      ? (e.hidden === true ? { model: e.model, ...(e.vision === true ? { vision: true } : {}), ...(e.manual === true ? { manual: true } : {}) } : { ...e, hidden: true })
      : e,
  );
}

/** 视觉探测（readModelList 收尾异步跑）：结果并入 draft.models 对象形态 */
async function probeVisionFor(
  models: string[],
  route: { baseUrl?: string; apiKey?: string; provider?: string },
): Promise<void> {
  if (models.length === 0) return;
  visionProbing.value = true;
  try {
    const { results } = await probeLlmVision({
      models,
      ...(route.baseUrl ? { baseUrl: route.baseUrl, ...(route.apiKey ? { apiKey: route.apiKey } : {}) } : {}),
      ...(route.provider ? { provider: route.provider } : {}),
    }, defaultRpc);
    const current = poolModelEntries(draft.value.models);
    draft.value.models = current.map((e) => {
      const verdict = results[e.model];
      if (verdict === true) return { ...e, vision: true };
      // 探测明确否定 → 摘除旧 vision 位（模型换代/清单刷新后纠偏）
      if (verdict === false && e.vision === true) return { model: e.model, ...(e.hidden === true ? { hidden: true } : {}), ...(e.manual === true ? { manual: true } : {}) };
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
      ? (e.vision === true ? { model: e.model, ...(e.hidden === true ? { hidden: true } : {}), ...(e.manual === true ? { manual: true } : {}) } : { ...e, vision: true })
      : e,
  );
}

/** 自动探测：llm 弹窗内（提供方/地址 + 真实 Key 就绪）防抖 600ms 自动读取
 *  一次；已有清单不重复读（按钮可强制重读） */
let probeTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [draft.value.api_key, draft.value.template, draft.value.base_url],
  () => {
    if (editingName.value === null) return;
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

/** 保存守门（cr-21）：编辑已存条目时，Key 掩码被清成空串（= 删凭据）
 *  或 base_url 将被清空（含误触提供方下拉换模板——连接将整体失效）
 *  都是高破坏动作——先弹确认，用户取消则不保存。 */
async function guardDestructiveSave(entry: Record<string, any>, oldEntry: PoolEntry | undefined): Promise<boolean> {
  if (!oldEntry) return true; // 新建无凭据可删
  const maskedBefore = oldEntry.api_key === '••••••••';
  const keyCleared = maskedBefore && (entry.api_key === '' || entry.api_key === undefined);
  const urlCleared = !!oldEntry.base_url && !entry.base_url;
  if (!keyCleared && !urlCleared) return true;
  const reasons: string[] = [];
  if (keyCleared) reasons.push('API Key 字段已清空——保存后将删除已存凭据，需重新填入');
  if (urlCleared) reasons.push('API 地址将被清空——连接将整体失效（无法调用，直到重新填写地址）');
  return (await confirmRef.value?.ask({
    title: '确认清空？',
    message: reasons.join('\n'),
    confirmLabel: '仍要保存',
    danger: true,
  })) === true;
}

async function saveEntry() {
  const name = (draft.value.poolName || editingName.value || '').trim();
  if (!name) { error.value = '请输入名称'; return; }
  const { poolName, models, template, ...entry } = draft.value;
  void poolName;
  void template;
  // 模型清单随条目落盘（保存即完整可用；改名同样跟随）——宽容双
  // 形态归一后写最小形态：无 flags = 裸 string（兼容旧格式/省空间），
  // 有 vision/hidden/manual = 对象（能力元数据 + 手工条目标记）
  const normalized = poolModelEntries(models);
  if (normalized.length > 0) {
    entry.models = normalized.map((e) => (e.vision === true || e.hidden === true || e.manual === true ? e : e.model));
  }
  // 清理空值（v-model.number 空值会返回 ""，导致 API 400）。
  // 例外：api_key 的空串有语义（= 删除凭据），必须传到后端。
  for (const [k, v] of Object.entries(entry)) {
    if ((v === '' || v === undefined) && k !== 'api_key') delete entry[k];
  }
  // 守门：掩码清空/地址清空须确认（取消 = 中止保存，弹窗留在编辑态）
  if (!(await guardDestructiveSave(entry, editingName.value ? props.pools[editingName.value] : undefined))) return;
  // 改名守门（cr-99 引用完整性）：旧名被 Agent 引用时提示——引用不会自动
  // 迁移（name@model 字面量），改名后这些 Agent 将断路
  if (editingName.value && editingName.value !== name) {
    try {
      const { agents: refs } = await fetchPoolReferences(editingName.value, defaultRpc);
      if (refs.length > 0) {
        const names = refs.slice(0, 8).map((a) => a.name || a.id).join('、');
        const ok = await confirmRef.value?.ask({
          title: `重命名 "${editingName.value}" → "${name}"？`,
          message: `以下 ${refs.length} 个 Agent 以旧名引用此连接（name@model），改名后需逐个更新：\n${names}${refs.length > 8 ? ' …' : ''}`,
          confirmLabel: '仍要改名',
          danger: true,
        });
        if (!ok) return;
      }
    } catch { /* 扫描失败不阻塞改名（仅少一层提示） */ }
  }
  const pool = { ...props.pools };
  if (editingName.value && editingName.value !== name) {
    // 改名：条目内容（models 等）随 draft 落到新名；旧名凭据由服务端
    // 迁移（pool:<旧> → pool:<新>，见 ac-web-api extractPoolCredentials）
    delete pool[editingName.value];
  }
  // 池中无条目时，首个自动设为默认
  const existingKeys = Object.keys(pool).filter(k => !k.startsWith('$'));
  if (existingKeys.length === 0 || (existingKeys.length === 1 && existingKeys[0] === name)) {
    entry.default = true;
    for (const k of existingKeys) {
      if (k !== name && pool[k].default) delete pool[k].default;
    }
  }
  pool[name] = entry;
  emit('update:pools', pool);
  editingName.value = null;
  draft.value = {};
  toastOk('已保存');
  // 落盘完成后，新建连接若无发现缓存 → 自动「读取模型」一次（静默失败：
  // key 无效时用户可经「读取模型」看重试报错）——选模板 + 填 Key 即完成
  if (!(Array.isArray(models) && models.length > 0)) {
    void (async () => {
      try { await props.onSaved?.(); } catch { /* onSaved 自行提示 */ }
      try { await fetchPoolModels(name, true, defaultRpc); } catch { /* 静默 */ }
    })();
  } else {
    props.onSaved?.();
  }
}

/** 删除连接：确认弹窗（ConfirmDialog，勿用原生 confirm）后同步
 *  删除凭据 pool:<名>——否则内置种子的 /models 发现回写会凭残留凭据
 *  把条目"复活"（刷新后又出现）。 */
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
async function removeEntry(name: string) {
  // 引用扫描（cr-99）：把「引用方将断路」从泛泛提示变成具体清单
  let refNote = '引用此 provider 的 Agent 将无法调用，需重新配置。';
  try {
    const { agents: refs } = await fetchPoolReferences(name, defaultRpc);
    if (refs.length > 0) {
      const names = refs.slice(0, 8).map((a) => a.name || a.id).join('、');
      refNote = `以下 ${refs.length} 个 Agent 正在引用此连接，删除后将无法调用：\n${names}${refs.length > 8 ? ' …' : ''}\n需重新配置后可用。`;
    }
  } catch { /* 引用扫描失败不阻塞删除（回落泛泛提示） */ }
  const ok = await confirmRef.value?.ask({
    title: `删除连接 "${name}"？`,
    message: `将同时删除其 API Key（凭据库）。\n${refNote}`,
    confirmLabel: '删除连接',
    danger: true,
  });
  if (!ok) return;
  const pool = { ...props.pools };
  delete pool[name];
  emit('update:pools', pool);
  props.onSaved?.();
  void deleteLlmPoolCredential(name, defaultRpc).catch((err: any) => {
    error.value = `凭据删除失败（条目已删，但 /models 发现可能复活它）: ${err?.message ?? err}`;
  });
}

function setDefault(name: string) {
  const pool: Record<string, PoolEntry> = {};
  for (const [k, v] of Object.entries(props.pools)) {
    if (!k.startsWith('$') && typeof v === 'object') pool[k] = { ...v, default: k === name };
    else pool[k] = v;
  }
  emit('update:pools', pool);
  props.onSaved?.();
}

/** 条目 detail（列表第二行） */
function detailOf(name: string, entry: PoolEntry): string {
  void name;
  const proto = typeof entry.protocol === 'string' && entry.protocol ? entry.protocol : 'openai-compat';
  const parts = [proto !== 'openai-compat' ? entry.base_url + ' · ' + proto : entry.base_url || '内置地址'];
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

const emit = defineEmits<{ (e: 'update:pools', v: Record<string, PoolEntry>): void }>();
/** 池条目取用（键缺席 = undefined：新建中未保存条目等场景） */
const entryOf = (n: string): PoolEntry | undefined => props.pools[n];
</script>

<template>
  <div class="pool">
    <div class="pool-head">
      <span class="pool-title">{{ title }}</span>
      <Button variant="primary" size="sm" icon="plus" @click="startAdd">添加</Button>
    </div>

    <div v-if="Object.keys(pools).filter(k => !k.startsWith('$')).length === 0" class="pool-empty">
      暂无连接——未配置任何模型（会话将无法发送）；点击「添加」接入 OpenAI 兼容端点
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
          <Button v-if="!entry.default" variant="ghost" size="sm" icon="star" title="设为默认连接（未显式选连接的会话与 Agent 使用它）" @click="setDefault(String(name))">设为默认</Button>
          <Button variant="ghost" size="sm" @click="startEdit(String(name))">编辑</Button>
          <Button variant="danger" size="sm" @click="removeEntry(String(name))">删除</Button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editingName !== null" :title="editingName ? '编辑 ' + editingName : '新建条目'" :width="440" :z-index="1200" @close="cancelEdit()">
      <div class="pool-modal-body">
        <!-- 提供方：预设 base_url/defaultModel——内置提供方不展示
             API 地址（模板隐含）；选自定义才出现可编辑地址字段。
             选项显示模板 id（= 引用名锚点，如 deepseek / zai），描述走 title -->
        <div class="pool-row">
          <label>提供方</label>
          <Select :options="templateOptions" :model-value="draft.template || ''" @update:model-value="onTemplateChange" />
        </div>
        <div class="pool-row">
          <label>名称（= 引用名 name@model 的左段；多账号可另起名）</label>
          <Input v-model="draft.poolName" :placeholder="editingName || '缺省同模板名，如 myds'" />
        </div>
        <div v-for="f in currentFields" :key="f.key" class="pool-field">
          <div class="pool-field-label">{{ f.label }}</div>
          <div v-if="f.description" class="pool-field-desc">{{ f.description }}</div>
          <div class="pool-field-control">
            <SettingField v-if="!(f.key === 'defaultModel' && draftModels.length)" :field="f" :model-value="draft[f.key]" @update:model-value="draft[f.key] = $event" />
            <div v-else class="pool-w-models">
              <Select :options="draftModelOptions" :model-value="draft.defaultModel" @update:model-value="draft.defaultModel = $event" />
            </div>
          </div>
        </div>
        <!-- 模型清单（llm 连接专属）：填 Key 自动读取（免注册 base_url+Key
             直调）；读取后自动逐模型探测视觉能力；列表控件 = 每行模型名 +
             行内徽章（视觉/隐藏/手工）+ 删除位（手工条目）；点击模型名设为
             默认模型。下方输入行支持手工新增（端点不暴露 /models 时补 id） -->
        <div class="pool-field">
          <div class="pool-field-label">模型清单</div>
          <div class="pool-field-desc">填入 API Key 后自动读取{{ visionProbing ? '（正在逐模型探测视觉能力…）' : '（读取时逐模型探测视觉能力）' }}；「视觉」= 支持图片输入（探测自动标，可手动改）；「隐藏」= 从前端下拉隐藏；点击模型名设为默认；API 不暴露模型清单时可在下方手工新增</div>
          <div class="pool-field-control">
            <Button variant="ghost" size="sm" :disabled="modelsLoading" :loading="modelsLoading" @click="readModelList">{{ modelsLoading ? '读取中…' : draftModels.length ? '重新读取' : '读取模型' }}</Button>
            <span v-if="modelsError" class="pool-error">{{ modelsError }}</span>
          </div>
          <div v-if="draftModels.length" class="pool-model-list">
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
                <span v-if="m.manual === true" class="pool-model-badge is-manual" title="手工新增的模型（发现刷新不会冲掉）">手工</span>
                <button
                  type="button"
                  class="pool-model-badge"
                  :class="{ on: m.vision === true }"
                  :title="m.vision === true ? '支持图片输入（附件图片会真正发给模型）——点击取消' : '未标记视觉——附件图片仅作文件路径文本附带；点击标记为支持图片'"
                  @click="toggleModelVision(m.model)"
                >视觉</button>
                <button
                  type="button"
                  class="pool-model-badge"
                  :class="{ on: m.hidden === true }"
                  :title="m.hidden === true ? '已隐藏：前端模型下拉不显示（路由与已选会话不受影响）——点击恢复显示' : '从前端模型下拉隐藏（路由不受影响）'"
                  @click="toggleModelHidden(m.model)"
                >隐藏</button>
                <button
                  v-if="m.manual === true"
                  type="button"
                  class="pool-model-del"
                  title="删除手工条目"
                  @click="removeModelEntry(m.model)"
                ><Icon name="x" :size="10" /></button>
              </span>
            </div>
          </div>
          <div class="pool-model-add">
            <Input
              v-model="manualModelInput"
              placeholder="手工新增模型 id（回车添加——端点不暴露清单时用）"
              @keyup.enter="addManualModel"
            />
            <Button variant="ghost" size="sm" @click="addManualModel">添加</Button>
          </div>
        </div>
        <div v-if="error" class="pool-error">{{ error }}</div>
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
/* 动作钮已归 kit Button（cr-171）；.pool-empty 空态保留 */
.pool-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }
.pool-list { display: flex; flex-direction: column; gap: 6px; }
.pool-entry {
  /* C8 收敛 A 语言：底座 = ui/row.css .ui-row（默认条目标记 = .is-selected
     角色底——cr-171 起行语言无边框，星标走 --star 语义色） */
  justify-content: space-between; padding: 8px 12px;
}
.pool-entry-info { display: flex; flex-direction: column; gap: 2px; }
.pool-entry-name { font-size: 13px; font-weight: 500; color: var(--text-1); }
/* cr-172 实心星标：lucide star 线框 fill 后成实心（默认标记的语义重量） */
.pool-star { color: var(--star); margin-right: 4px; display: inline-flex; align-items: center; }
.pool-star :deep(svg path) { fill: currentColor; }
.pool-entry-detail { font-size: 11px; color: var(--text-3); }
.pool-entry-actions { display: flex; gap: 6px; }

/* cr-169：表单控件已归 kit（Input/Select）；.pool-w-models 定下拉列宽 */
.pool-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.pool-row { display: flex; flex-direction: column; gap: 4px; }
.pool-row label { font-size: 12px; color: var(--text-2); }
.pool-w-models { max-width: 320px; }
.pool-field { padding: 7px 0; border-bottom:  1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.pool-field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-field-desc { font-size: 11px; color: var(--text-3); }
.pool-field-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }

/* 模型清单列表控件：每行 = 模型名（点击设默认）+ 行内徽章（视觉/隐藏/
   手工/删除位）——列表化呈现（原表格列头 + 裸勾选框退役） */
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
.pool-model-row:hover { background: var(--bg-hover); }
.pool-model-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono, monospace); color: var(--text-2);
}
.pool-model-name-btn {
  border: none; background: none; padding: 0; cursor: pointer; text-align: left;
  font: inherit; font-family: var(--font-mono, monospace);
}
.pool-model-name-btn:hover { color: var(--primary); }
.pool-model-row.is-default .pool-model-name {
  color: var(--primary); font-weight: 600;
}
.pool-model-row.is-default .pool-model-name-btn::after {
  content: ' ·默认'; font-weight: 400; font-size: 10px;
}
.pool-model-row.is-hidden .pool-model-name {
  text-decoration: line-through; opacity: 0.55;
}
.pool-model-flags { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; }
.pool-model-badge {
  padding: 1px 8px; border-radius: var(--r-full);
  border: 1px solid rgba(var(--text-3-rgb), 0.25);
  background: transparent; color: var(--text-3);
  font-size: 10px; line-height: 1.5; cursor: pointer;
  transition: all var(--dur-fast);
}
.pool-model-badge:hover {
  border-color: rgba(var(--text-3-rgb), 0.45);
  color: var(--text-2);
}
.pool-model-badge.on {
  background: rgba(var(--primary-rgb, 79, 70, 229), 0.1);
  border-color: rgba(var(--primary-rgb, 79, 70, 229), 0.35);
  color: var(--primary); /* 回退（cr-32） */
  color: color-mix(in srgb, var(--primary) 80%, var(--text-1));
}
.pool-model-badge.is-manual {
  background: rgba(var(--warn-rgb), 0.12);
  border-color: rgba(var(--warn-rgb), 0.4);
  color: var(--warn); cursor: default;
}
.pool-model-del {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border: none; border-radius: var(--r-sm);
  background: transparent; color: var(--text-3); cursor: pointer;
}
.pool-model-del:hover { background: rgba(var(--err-rgb), 0.12); color: var(--err); }
/* 手工新增行（输入框已归 kit Input；.ui-input 单根即行内主体） */
.pool-model-add { display: flex; gap: 6px; margin-top: 6px; }
.pool-model-add :deep(.ui-input) { flex: 1; width: auto; }
.pool-error { color: var(--err); font-size: 12px; }
</style>
