<script setup lang="ts">
// ============================================================
// client/PoolEntryForm.vue —— Provider 连接编辑表单体（cr-299 抽取）
//
// 自 PoolManager.vue 编辑弹窗体原样抽取（行为分毫不变）：模板选择/
// 名称/凭据字段/模型清单 + 读取模型/视觉探测/手工新增 + 保存守门
//（cr-21 清空确认 + cr-99 改名引用扫描）。设置面板弹窗（PoolManager
// 套 Modal）与首启向导第 2 步（LlmStep 内嵌）共用本件。
//
// props：pools（全池快照——守门/条目引用判读）；editingName（null=
// 新建；string=编辑名）。emits：save(name, entry)（调用方落盘）/
// cancel / models-cache(name, models)（注册路径读取的服务端缓存
// 回写——调用方并入池落盘）。
// ============================================================
import { computed, ref, watch } from 'vue';
import type { PoolEntry, FieldMeta } from 'ac-client-ui-settings/client/types.ts';
import { Button, Input, Icon, Select } from '@agentchat/webui-kit';
import SettingField from 'ac-client-ui-settings/client/components/SettingField.vue';
import ConfirmDialog from 'ac-client-ui-settings/client/components/ConfirmDialog.vue';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { fetchPoolModels, probeLlmModels, probeLlmVision, poolModelEntries, providerIconOf, providerIconColor, fetchPoolReferences, type PoolModelMeta } from './poolApi.ts';
import { LLM_PROVIDER_TEMPLATES } from 'ac-client-ui-settings/client/api.ts';

const props = defineProps<{
  /** 池数据快照（守门/条目引用判读） */
  pools: Record<string, PoolEntry>;
  /** 编辑目标名（null = 新建） */
  editingName: string | null;
}>();

const emit = defineEmits<{
  (e: 'save', name: string, entry: Record<string, any>): void;
  (e: 'cancel'): void;
  (e: 'models-cache', name: string, models: unknown[]): void;
}>();

// ── 字段基线（原 PoolManager 同款语义随迁）──
const LLM_CONN_FIELDS: FieldMeta[] = [
  { key: 'api_key', label: 'API Key', description: '加密存于凭据库（不入 config.json）；显示 •• 为已设置，留空保存即删除', type: 'password', sensitive: true },
  { key: 'defaultModel', label: '默认模型', description: '该连接的默认模型（填入 API Key 自动读取清单后选择；缺省取第一个）', type: 'text' },
];

const API_FORMAT_FIELD: FieldMeta = {
  key: 'api', label: '接口格式', description: 'Responses API = POST /responses（OpenAI 新模型 / xAI 等支持的格式）；模型不支持会如实报错', type: 'select', options: [
    { label: 'Chat Completions（默认）', value: '' },
    { label: 'Responses API', value: 'responses' },
  ],
};

const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 兼容（chat/completions）', value: '' },
  { label: 'Anthropic 原生（/v1/messages）', value: 'anthropic' },
  { label: 'Google Gemini 原生（generateContent）', value: 'gemini' },
  { label: 'Ollama 原生（/api/chat）', value: 'ollama' },
];

const draft = ref<Record<string, any>>({});
const error = ref('');
const modelsLoading = ref(false);
const modelsError = ref('');

/** 初始化草稿（editingName 变化时重建——弹窗/向导步复用同一实例） */
function initDraft(): void {
  error.value = '';
  modelsError.value = '';
  if (props.editingName) {
    const entry = JSON.parse(JSON.stringify(props.pools[props.editingName] ?? {}));
    const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.baseUrl === entry.base_url);
    draft.value = { poolName: props.editingName, template: tpl?.id ?? 'custom', ...entry };
    // 旧 visionModels 手写清单退役（读取侧统一 models[].vision）
    delete draft.value.visionModels;
  } else {
    draft.value = { template: '' };
  }
}
initDraft();
watch(() => props.editingName, initDraft);

/** 当前草稿的协议（缺省 openai-compat；模板自带协议优先） */
const draftProtocol = computed<string>(() => {
  const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.id === draft.value.template);
  if (tpl?.protocol) return tpl.protocol;
  const p = String(draft.value.protocol ?? '');
  return PROTOCOL_OPTIONS.some((o) => o.value === p) ? p : '';
});
void draftProtocol; // custom 分支字段序引用（模板隐含协议时不追加协议选择）

/** llm 表单字段：内置提供方隐藏 API 地址（模板隐含）；自定义追加协议/接口格式/可编辑地址 */
const currentFields = computed<FieldMeta[]>(() => {
  const base = [...LLM_CONN_FIELDS];
  if ((draft.value.template ?? '') === 'custom') {
    base.splice(1, 0, { key: 'protocol', label: '协议', description: '端点线格式：OpenAI 兼容缺省；其余为厂商原生协议（cr-39 协议多态）', type: 'select', options: PROTOCOL_OPTIONS });
    base.splice(2, 0, API_FORMAT_FIELD);
    base.splice(3, 0, { key: 'base_url', label: 'API 地址', description: '协议根地址（openai-compat = /v1 根；anthropic/gemini = 域名根；ollama = 服务根，如 http://localhost:11434）', type: 'text' });
  }
  return base;
});

const llmTemplates = LLM_PROVIDER_TEMPLATES;
const templateOptions = computed(() => [
  { value: '', label: '选择提供方…', disabled: true },
  ...llmTemplates.map((t) => {
    const icon = providerIconOf(t.baseUrl);
    return { value: t.id, label: t.id, ...(icon ? { icon, iconColor: providerIconColor(icon) ?? '' } : {}) };
  }),
  { value: 'custom', label: '自定义（手填 API 地址）' },
]);

const entryOf = (n: string): PoolEntry | undefined => props.pools[n];

const draftModels = computed<PoolModelMeta[]>(() => {
  const name = (draft.value.poolName || props.editingName || '').trim();
  const fromEntry = poolModelEntries(entryOf(name)?.models);
  const own = poolModelEntries(draft.value.models);
  const byModel = new Map(fromEntry.map((e) => [e.model, e]));
  for (const e of own) byModel.set(e.model, e);
  return [...byModel.values()].sort((a, b) => b.model.localeCompare(a.model));
});
const draftModelOptions = computed(() => draftModels.value.map((m) => ({ value: m.model, label: m.model })));

const visionProbing = ref(false);

function onTemplateChange(templateId: string) {
  draft.value.template = templateId;
  const tpl = LLM_PROVIDER_TEMPLATES.find((t) => t.id === templateId);
  draft.value.base_url = tpl?.baseUrl ?? '';
  draft.value.defaultModel = tpl?.defaultModel ?? '';
  draft.value.api = ''; // 切换提供方重置接口格式
  draft.value.protocol = tpl?.protocol ?? '';
  draft.value.authHeader = tpl?.authHeader ?? '';
  const name = (draft.value.poolName || '').trim();
  if (!name && tpl) draft.value.poolName = tpl.id;
}

/** 读取模型清单：免注册探测优先；编辑已存条目且 Key 未改动 → 注册路径 */
async function readModelList() {
  const apiKey = String(draft.value.api_key ?? '');
  const baseUrl = String(draft.value.base_url ?? '').trim();
  const name = (draft.value.poolName || props.editingName || '').trim();
  const masked = apiKey === '••••••••';
  const canProbe = !!baseUrl && !!apiKey && !masked;
  const canRegistered = !!props.editingName && (masked || !apiKey) && !!name;
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
      // 注册路径服务端回写缓存——池状态并入 models 交调用方落盘
      const merged = [...new Set([
        ...poolModelEntries(entryOf(name)?.models).map((e) => e.model),
        ...list,
      ])].map((model) => {
        const prev = poolModelEntries(entryOf(name)?.models).find((e) => e.model === model);
        return prev && (prev.vision === true || prev.hidden === true || prev.manual === true) ? prev : model;
      });
      emit('models-cache', name, merged);
    }
    if (!list.length) throw new Error('未获取到模型列表');
    const prevEntries = poolModelEntries(entryOf(name)?.models);
    const discovered = list.map((model) => {
      const prev = prevEntries.find((e) => e.model === model);
      return prev && (prev.vision === true || prev.hidden === true || prev.manual === true) ? prev : { model };
    });
    const manualDraft = poolModelEntries(draft.value.models).filter((e) => e.manual === true);
    const seen = new Set(discovered.map((e) => e.model));
    draft.value.models = [...discovered, ...manualDraft.filter((e) => !seen.has(e.model))];
    if (!draft.value.defaultModel || !list.includes(String(draft.value.defaultModel))) {
      draft.value.defaultModel = [...list].sort((a, b) => b.localeCompare(a))[0];
    }
    void probeVisionFor(list, { baseUrl: canProbe ? baseUrl : undefined, apiKey: canProbe ? apiKey : undefined, provider: canRegistered ? name : undefined });
  } catch (err: any) {
    modelsError.value = `读取失败：${err.message}`;
  } finally {
    modelsLoading.value = false;
  }
}

const manualModelInput = ref('');
function addManualModel(): void {
  const id = manualModelInput.value.trim();
  if (!id) return;
  manualModelInput.value = '';
  const current = poolModelEntries(draft.value.models);
  if (current.some((e) => e.model === id)) return;
  draft.value.models = [...current, { model: id, manual: true }];
  if (!draft.value.defaultModel) draft.value.defaultModel = id;
}

function removeModelEntry(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.filter((e) => e.model !== model);
  if (draft.value.defaultModel === model) {
    const next = current.find((e) => e.model !== model && e.hidden !== true);
    draft.value.defaultModel = next ? next.model : '';
  }
}

function toggleModelHidden(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.map((e) =>
    e.model === model
      ? (e.hidden === true ? { model: e.model, ...(e.vision === true ? { vision: true } : {}), ...(e.manual === true ? { manual: true } : {}) } : { ...e, hidden: true })
      : e,
  );
}

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
      if (verdict === false && e.vision === true) return { model: e.model, ...(e.hidden === true ? { hidden: true } : {}), ...(e.manual === true ? { manual: true } : {}) };
      return e;
    });
  } catch {
    /* 探测失败静默 */
  } finally {
    visionProbing.value = false;
  }
}

function toggleModelVision(model: string): void {
  const current = poolModelEntries(draft.value.models);
  draft.value.models = current.map((e) =>
    e.model === model
      ? (e.vision === true ? { model: e.model, ...(e.hidden === true ? { hidden: true } : {}), ...(e.manual === true ? { manual: true } : {}) } : { ...e, vision: true })
      : e,
  );
}

// 自动探测：Key + 地址就绪防抖 600ms 自动读取一次；已有清单不重复读
let probeTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [draft.value.api_key, draft.value.template, draft.value.base_url],
  () => {
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

/** 保存守门（cr-21）：Key 掩码清空 / base_url 清空须确认 */
async function guardDestructiveSave(entry: Record<string, any>, oldEntry: PoolEntry | undefined): Promise<boolean> {
  if (!oldEntry) return true;
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

/** 保存（守门全过后 emit save——落盘归调用方） */
async function saveEntry() {
  const name = (draft.value.poolName || props.editingName || '').trim();
  if (!name) { error.value = '请输入名称'; return; }
  const { poolName, models, template, ...entry } = draft.value;
  void poolName;
  void template;
  const normalized = poolModelEntries(models);
  if (normalized.length > 0) {
    entry.models = normalized.map((e) => (e.vision === true || e.hidden === true || e.manual === true ? e : e.model));
  }
  for (const [k, v] of Object.entries(entry)) {
    if ((v === '' || v === undefined) && k !== 'api_key') delete entry[k];
  }
  if (!(await guardDestructiveSave(entry, props.editingName ? props.pools[props.editingName] : undefined))) return;
  if (props.editingName && props.editingName !== name) {
    try {
      const { agents: refs } = await fetchPoolReferences(props.editingName, defaultRpc);
      if (refs.length > 0) {
        const names = refs.slice(0, 8).map((a) => a.name || a.id).join('、');
        const ok = await confirmRef.value?.ask({
          title: `重命名 "${props.editingName}" → "${name}"？`,
          message: `以下 ${refs.length} 个 Agent 以旧名引用此连接（name@model），改名后需逐个更新：\n${names}${refs.length > 8 ? ' …' : ''}`,
          confirmLabel: '仍要改名',
        danger: true,
        });
        if (!ok) return;
      }
    } catch { /* 扫描失败不阻塞改名 */ }
  }
  emit('save', name, entry);
}

const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
</script>

<template>
  <div class="pool-form">
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
    <div class="pool-form-actions">
      <Button variant="ghost" @click="emit('cancel')">取消</Button>
      <Button variant="primary" @click="saveEntry">保存</Button>
    </div>
    <ConfirmDialog ref="confirmRef" />
  </div>
</template>

<style scoped>
.pool-form { display: flex; flex-direction: column; gap: 10px; }
.pool-row { display: flex; flex-direction: column; gap: 4px; }
.pool-row label { font-size: 12px; color: var(--text-2); }
.pool-w-models { max-width: 320px; }
.pool-field { padding: 7px 0; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.pool-field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-field-desc { font-size: 11px; color: var(--text-3); }
.pool-field-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
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
  /* cr-303：primary 混 text-1 属静态混静态，非 color-mix 保留场景——
     取 --primary-strong（既定档位：tint 底上 primary 对比不足 4.5 的文字） */
  color: var(--primary-strong);
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
.pool-model-add { display: flex; gap: 6px; margin-top: 6px; }
.pool-model-add :deep(.ui-input) { flex: 1; width: auto; }
.pool-error { color: var(--err); font-size: 12px; }
.pool-form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
</style>
