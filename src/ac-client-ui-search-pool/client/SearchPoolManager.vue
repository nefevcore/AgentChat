<script setup lang="ts">
// ============================================================
// SearchPoolManager.vue —— 搜索引擎池管理（2026-09-11 自 ui-llm-pool
// PoolManager〔kind='search'〕拆分行迁：模型池与搜索池两对象各自
// 成件——本件只含 search 形态，llm 连接管理留 ui-llm-pool
// PoolManager。行为与拆分前 kind='search' 分支逐字节等价。）
// · 条目 = 搜索引擎连接（provider 类型 + api_key〔凭据侧信道〕+
//   调优字段 defaultResults/defaultDepth/…）；字段 = 真 schema 优先
//   （后端 searchSchemas），空则基线 SEARCH_FIELDS + 池内观测字段。
// ============================================================
import { ref, computed } from 'vue';
import type { PoolEntry, FieldMeta } from 'ac-client-ui-settings/client/types.ts';
import { toFields } from 'ac-client-ui-settings/client/schema.ts';
import { Input, Modal, Button, Icon, Select, toastOk } from '@agentchat/webui-kit';
import SettingField from 'ac-client-ui-settings/client/components/SettingField.vue';
import ConfirmDialog from 'ac-client-ui-settings/client/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 池数据（直接读写） */
  pools: Record<string, PoolEntry>;
  /** provider → 原始 schema（真 schema 优先；空则基线 + 观测字段） */
  schemas: Record<string, any[]>;
  /** 保存回调（成功刷新后调用） */
  onSaved?: () => void;
}>();

// ── 字段基线 ──
// api_key 为凭据侧信道字段（password）：显示掩码（后端 config/get 回填，
// '••••••••'=已设置）、保存提取进凭据库（config.json 不落 key）——
// 掩码原样传回=保持不变，清空=删除，新值=覆盖。
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

// ── 编辑弹窗状态 ──
const editingName = ref<string | null>(null); // null=列表视图, ''=新建, 'xxx'=编辑
const draft = ref<Record<string, any>>({});
const error = ref('');

const providerOptions = computed(() => Object.keys(effectiveSchemas.value));
/** kit Select 选项表（cr-169） */
const providerSelectOptions = computed(() => providerOptions.value.map((p) => ({ value: p, label: p })));
const currentProvider = computed(() => (draft.value.provider || 'tavily') as string);
const currentFields = computed<FieldMeta[]>(() => toFields(effectiveSchemas.value[currentProvider.value]));

const title = '搜索引擎';

function startAdd() {
  editingName.value = '';
  error.value = '';
  draft.value = applyDefaults({ provider: currentProvider.value });
}
function startEdit(name: string) {
  editingName.value = name;
  error.value = '';
  const entry = JSON.parse(JSON.stringify(props.pools[name] ?? {}));
  const provider = entry.provider || currentProvider.value;
  draft.value = { ...applyDefaults({ provider }), ...entry };
}
function cancelEdit() {
  editingName.value = null;
  draft.value = {};
}

function applyDefaults(entry: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...entry };
  const schema = effectiveSchemas.value[out.provider];
  {
    for (const f of toFields(schema)) {
      if (f.default !== undefined && out[f.key] === undefined) out[f.key] = f.default;
    }
  }
  return out;
}

/** 切换 provider：保留名称，应用新 provider 的默认值 */
function onProviderChange(newProvider: string) {
  const name = draft.value.poolName;
  draft.value = applyDefaults({ provider: newProvider });
  if (name !== undefined) draft.value.poolName = name;
}

/** 保存守门（cr-21）：编辑已存条目时 Key 掩码被清空（= 删凭据）先确认 */
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
  const name = (draft.value.poolName || editingName.value || '').trim();
  if (!name) { error.value = '请输入名称'; return; }
  const { poolName, ...entry } = draft.value;
  void poolName;
  // 清理空值（v-model.number 空值会返回 ""，导致 API 400）。
  // 例外：api_key 的空串有语义（= 删除凭据），必须传到后端。
  for (const [k, v] of Object.entries(entry)) {
    if ((v === '' || v === undefined) && k !== 'api_key') delete entry[k];
  }
  if (!(await guardKeyCleared(entry, editingName.value ? props.pools[editingName.value] : undefined))) return;
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
      if (k !== name && pool[k].default) delete pool[k].default;
    }
  }
  pool[name] = entry;
  emit('update:pools', pool);
  editingName.value = null;
  draft.value = {};
  toastOk('已保存');
  props.onSaved?.();
}

/** 删除条目（搜索池无凭据联动/确认弹窗——与拆分前 kind='search'
 *  行为一致；llm 连接的确认 + 凭据删除留 ui-llm-pool） */
function removeEntry(name: string) {
  const pool = { ...props.pools };
  delete pool[name];
  emit('update:pools', pool);
  props.onSaved?.();
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
  return `${entry.provider ?? ''}${entry.model && entry.model !== name ? ' / ' + entry.model : ''}`;
}

const emit = defineEmits<{ (e: 'update:pools', v: Record<string, PoolEntry>): void }>();
/** 清空凭据守门确认（cr-21——llm 池同款语义） */
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
</script>

<template>
  <div class="pool">
    <div class="pool-head">
      <span class="pool-title">{{ title }}</span>
      <Button variant="primary" size="sm" icon="plus" @click="startAdd">添加</Button>
    </div>

    <div v-if="Object.keys(pools).filter(k => !k.startsWith('$')).length === 0" class="pool-empty">
      暂无条目，点击「添加」创建
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
          <Button v-if="!entry.default" variant="ghost" size="sm" icon="star" title="设为默认搜索引擎（全局缺省使用它）" @click="setDefault(String(name))">设为默认</Button>
          <Button variant="ghost" size="sm" @click="startEdit(String(name))">编辑</Button>
          <Button variant="danger" size="sm" @click="removeEntry(String(name))">删除</Button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editingName !== null" :title="editingName ? '编辑 ' + editingName : '新建条目'" :width="440" :z-index="1200" @close="cancelEdit()">
      <div class="pool-modal-body">
        <div class="pool-row">
          <label>名称</label>
          <Input v-model="draft.poolName" :placeholder="editingName || '输入条目名称'" />
        </div>
        <div class="pool-row">
          <label>Provider 类型</label>
          <Select :options="providerSelectOptions" :model-value="currentProvider" @update:model-value="onProviderChange" />
        </div>
        <div v-for="f in currentFields" :key="f.key" class="pool-field">
          <div class="pool-field-label">{{ f.label }}</div>
          <div v-if="f.description" class="pool-field-desc">{{ f.description }}</div>
          <div class="pool-field-control">
            <SettingField :field="f" :model-value="draft[f.key]" @update:model-value="draft[f.key] = $event" />
          </div>
        </div>
        <div v-if="error" class="pool-error">{{ error }}</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="cancelEdit()">取消</Button>
        <Button variant="primary" @click="saveEntry">保存</Button>
      </template>
    </Modal>

    <!-- 清空凭据守门（cr-21） -->
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
/* cr-172 实心星标：与 PoolManager 同款 */
.pool-star { color: var(--star); margin-right: 4px; display: inline-flex; align-items: center; }
.pool-star :deep(svg path) { fill: currentColor; }
.pool-entry-detail { font-size: 11px; color: var(--text-3); }
.pool-entry-actions { display: flex; gap: 6px; }

/* cr-169：表单控件已归 kit（Input/Select） */
.pool-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.pool-row { display: flex; flex-direction: column; gap: 4px; }
.pool-row label { font-size: 12px; color: var(--text-2); }
.pool-field { padding: 7px 0; border-bottom:  1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.pool-field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-field-desc { font-size: 11px; color: var(--text-3); }
.pool-field-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.pool-error { color: var(--err); font-size: 12px; }
</style>
