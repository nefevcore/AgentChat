<script setup lang="ts">
// ============================================================
// PoolManager.vue —— Provider 池管理（模型池 / 搜索池）
// provider 下拉从 schema 动态生成（不再硬编码）
// ============================================================
import { ref, computed } from 'vue';
import type { PoolEntry } from '../types';
import { toFields } from '../schema';
import type { FieldMeta } from '../types';
import { Modal, Button } from '@/ui';
import SettingField from './SettingField.vue';

const props = defineProps<{
  kind: 'llm' | 'search';
  /** 池数据（直接读写） */
  pools: Record<string, PoolEntry>;
  /** provider → 原始 schema */
  schemas: Record<string, any[]>;
  /** 保存回调（成功刷新后调用） */
  onSaved?: () => void;
}>();

// ── 编辑弹窗状态 ──
const editingName = ref<string | null>(null); // null=列表视图, ''=新建, 'xxx'=编辑
const draft = ref<Record<string, any>>({});
const error = ref('');
const saved = ref('');

const providerOptions = computed(() => Object.keys(props.schemas));
const currentProvider = computed(() => (draft.value.provider || (props.kind === 'llm' ? 'deepseek' : 'tavily')) as string);
const currentFields = computed<FieldMeta[]>(() => toFields(props.schemas[currentProvider.value]));

const title = computed(() => (props.kind === 'llm' ? '模型管理' : '搜索引擎'));

function startAdd() {
  editingName.value = '';
  error.value = '';
  saved.value = '';
  draft.value = applyDefaults({ provider: currentProvider.value });
}
function startEdit(name: string) {
  editingName.value = name;
  error.value = '';
  saved.value = '';
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
  const schema = props.schemas[out.provider];
  if (schema) {
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

function saveEntry() {
  const name = (draft.value.poolName || editingName.value || '').trim();
  if (!name) { error.value = '请输入名称'; return; }
  const { poolName, ...entry } = draft.value;
  // 清理空值（v-model.number 空值会返回 ""，导致 API 400）
  for (const [k, v] of Object.entries(entry)) {
    if (v === '' || v === undefined) delete entry[k];
  }
  // ratio 字段：default=undefined 且值==min 时视为"使用 API 默认"，不保存
  for (const f of currentFields.value) {
    if (f.type === 'ratio' && f.default === undefined && entry[f.key] === f.min) delete entry[f.key];
  }
  const pool = { ...props.pools };
  if (editingName.value && editingName.value !== name) delete pool[editingName.value];
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
  props.onSaved?.();
}

function removeEntry(name: string) {
  const pool = { ...props.pools };
  delete pool[name];
  if (Object.keys(pool).length === 0) { /* 保留空对象 */ }
  emit('update:pools', pool);
  props.onSaved?.();
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

const emit = defineEmits<{ (e: 'update:pools', v: Record<string, PoolEntry>): void }>();
</script>

<template>
  <div class="pool">
    <div class="pool-head">
      <span class="pool-title">{{ title }}</span>
      <button class="pool-add" @click="startAdd">+ 添加</button>
    </div>

    <div v-if="Object.keys(pools).filter(k => !k.startsWith('$')).length === 0" class="pool-empty">暂无条目，点击"+ 添加"创建</div>
    <div v-else class="pool-list">
      <div
        v-for="(entry, name) in pools" :key="name"
        v-show="!String(name).startsWith('$')"
        class="pool-entry" :class="{ 'is-default': entry.default }"
      >
        <div class="pool-entry-info">
          <span class="pool-entry-name">
            <span v-if="entry.default" class="pool-star" title="当前默认">★</span>
            {{ name }}
          </span>
          <span class="pool-entry-detail">{{ entry.provider }}{{ entry.model && entry.model !== name ? ' / ' + entry.model : '' }}</span>
        </div>
        <div class="pool-entry-actions">
          <button v-if="!entry.default" class="pool-set-default" @click="setDefault(name)" title="设为默认">设为默认</button>
          <button class="pool-btn" @click="startEdit(name)">编辑</button>
          <button class="pool-btn danger" @click="removeEntry(name)">删除</button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editingName !== null" :title="editingName ? '编辑 ' + editingName : '新建条目'" :width="440" :z-index="1200" @close="cancelEdit()">
      <div class="pool-modal-body">
        <div class="pool-row">
          <label>名称</label>
          <input v-model="draft.poolName" type="text" class="pool-input" :placeholder="editingName || '输入条目名称'" />
        </div>
        <div class="pool-row">
          <label>Provider 类型</label>
          <select class="pool-input" :value="currentProvider" @change="onProviderChange(($event.target as HTMLSelectElement).value)">
            <option v-for="p in providerOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div v-for="f in currentFields" :key="f.key" class="pool-field">
          <div class="pool-field-label">{{ f.label }}</div>
          <div v-if="f.description" class="pool-field-desc">{{ f.description }}</div>
          <div class="pool-field-control">
            <SettingField :field="f" :model-value="draft[f.key]" @update:model-value="draft[f.key] = $event" />
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
.pool-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }
.pool-list { display: flex; flex-direction: column; gap: 6px; }
.pool-entry {
  display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.pool-entry.is-default { border-color: var(--primary); }
.pool-entry-info { display: flex; flex-direction: column; gap: 2px; }
.pool-entry-name { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-star { color: var(--warn); margin-right: 4px; }
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
.pool-field { padding: 7px 0; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.pool-field-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.pool-field-desc { font-size: 11px; color: var(--text-3); }
.pool-field-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.pool-error { color: var(--err); font-size: 12px; }
.pool-saved { color: var(--ok); font-size: 12px; }
</style>
