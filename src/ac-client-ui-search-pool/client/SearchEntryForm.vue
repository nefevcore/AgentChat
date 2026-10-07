<script setup lang="ts">
// ============================================================
// client/SearchEntryForm.vue —— 搜索引擎连接编辑表单体（cr-299 抽取）
//
// 自 SearchPoolManager.vue 编辑弹窗体原样抽取（行为分毫不变）：名称/
// Provider 类型/schema 字段 + 保存守门（cr-21 Key 清空确认）。设置面板
// 弹窗（SearchPoolManager 套 Modal）与首启向导第 3 步共用本件。
//
// props：pools（全池快照）；schemas（provider → schema）；editingName
//（null=新建）。emits：save(name, entry) / cancel。
// ============================================================
import { computed, ref, watch } from 'vue';
import type { PoolEntry, FieldMeta } from 'ac-client-ui-settings/client/types.ts';
import { toFields } from 'ac-client-ui-settings/client/schema.ts';
import { Input, Button, Select } from '@agentchat/webui-kit';
import SettingField from 'ac-client-ui-settings/client/components/SettingField.vue';
import ConfirmDialog from 'ac-client-ui-settings/client/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 池数据快照 */
  pools: Record<string, PoolEntry>;
  /** provider → 原始 schema（真 schema 优先；空则基线 + 观测字段） */
  schemas: Record<string, any[]>;
  /** 编辑目标名（null = 新建） */
  editingName: string | null;
}>();

const emit = defineEmits<{
  (e: 'save', name: string, entry: Record<string, any>): void;
  (e: 'cancel'): void;
}>();

// ── 字段基线（原 SearchPoolManager 同款随迁）──
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
function inferExtraFields(pools: Partial<Record<string, PoolEntry>>): Map<string, FieldMeta[]> {
  const byProvider = new Map<string, Map<string, FieldMeta>>();
  const baseKeys = new Set(SEARCH_FIELDS.map((f) => f.key));
  for (const entry of Object.values(pools)) {
    if (entry === undefined) continue;
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

/** 合成 schema（真 schema 优先；空则基线 + 观测字段） */
const effectiveSchemas = computed<Record<string, any[]>>(() => {
  const out: Record<string, any[]> = { ...props.schemas };
  const extra = inferExtraFields(props.pools);
  const providers = new Set([...Object.keys(props.schemas), ...extra.keys()]);
  for (const p of providers) {
    if (out[p].length) continue;
    out[p] = [...SEARCH_FIELDS, ...(extra.get(p) ?? [])];
  }
  return out;
});

const draft = ref<Record<string, any>>({});
const error = ref('');

const currentProvider = computed(() => (draft.value.provider || 'tavily') as string);
const currentFields = computed<FieldMeta[]>(() => toFields(effectiveSchemas.value[currentProvider.value]));

/** 初始化草稿（editingName 变化时重建） */
function applyDefaults(entry: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...entry };
  const schema = effectiveSchemas.value[out.provider];
  for (const f of toFields(schema)) {
    if (f.default !== undefined && out[f.key] === undefined) out[f.key] = f.default;
  }
  return out;
}

function initDraft(): void {
  error.value = '';
  if (props.editingName) {
    const entry = JSON.parse(JSON.stringify(props.pools[props.editingName] ?? {}));
    const provider = entry.provider || 'tavily';
    draft.value = { ...applyDefaults({ provider }), ...entry };
  } else {
    draft.value = applyDefaults({ provider: currentProvider.value });
  }
}
initDraft();
watch(() => props.editingName, initDraft);

/** 切换 provider：保留名称，应用新 provider 的默认值 */
function onProviderChange(newProvider: string) {
  const name = draft.value.poolName;
  draft.value = applyDefaults({ provider: newProvider });
  if (name !== undefined) draft.value.poolName = name;
}

/** 保存守门（cr-21）：Key 掩码清空（= 删凭据）先确认 */
async function guardKeyCleared(entry: Record<string, any>, oldEntry: PoolEntry | undefined): Promise<boolean> {
  if (!oldEntry) return true;
  const keyCleared = oldEntry.api_key === '••••••••' && (entry.api_key === '' || entry.api_key === undefined);
  if (!keyCleared) return true;
  return (await confirmRef.value?.ask({
    title: '确认清空 API Key？',
    message: 'API Key 字段已清空——保存后将删除已存凭据，需重新填入。',
    confirmLabel: '仍要保存',
    danger: true,
  })) === true;
}

async function saveEntry() {
  const name = (draft.value.poolName || props.editingName || '').trim();
  if (!name) { error.value = '请输入名称'; return; }
  const { poolName, ...entry } = draft.value;
  void poolName;
  // 清理空值（v-model.number 空值会返回 ""，导致 API 400）。
  // 例外：api_key 的空串有语义（= 删除凭据），必须传到后端。
  for (const [k, v] of Object.entries(entry)) {
    if ((v === '' || v === undefined) && k !== 'api_key') delete entry[k];
  }
  if (!(await guardKeyCleared(entry, props.editingName ? props.pools[props.editingName] : undefined))) return;
  // ratio 字段：default=undefined 且值==min 时视为"使用 API 默认"，不保存
  for (const f of currentFields.value) {
    if (f.type === 'ratio' && f.default === undefined && entry[f.key] === f.min) delete entry[f.key];
  }
  emit('save', name, entry);
}

const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
</script>

<template>
  <div class="search-form">
    <div class="pool-row">
      <label>名称</label>
      <Input v-model="draft.poolName" :placeholder="editingName || '输入条目名称'" />
    </div>
    <div class="pool-row">
      <label>Provider 类型</label>
      <Select :options="Object.keys(effectiveSchemas).map((p) => ({ value: p, label: p }))" :model-value="currentProvider" @update:model-value="onProviderChange" />
    </div>
    <div v-for="f in currentFields" :key="f.key" class="pool-field">
      <div class="pool-field-label">{{ f.label }}</div>
      <div v-if="f.description" class="pool-field-desc">{{ f.description }}</div>
      <div class="pool-field-control">
        <SettingField :field="f" :model-value="draft[f.key]" @update:model-value="draft[f.key] = $event" />
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
.search-form { display: flex; flex-direction: column; gap: 10px; }
.pool-row { display: flex; flex-direction: column; gap: 4px; }
.pool-row label { font-size: 12px; color: var(--text-2); }
.pool-field { padding: 7px 0; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.pool-field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-field-desc { font-size: 11px; color: var(--text-3); }
.pool-field-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.pool-error { color: var(--err); font-size: 12px; }
.pool-form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
</style>
