<script setup lang="ts">
// ============================================================
// NsFieldList.vue —— 通用命名空间 schema 表单
// 用途：扩展/工具/系统等基于 schema 的字段列表
// - 有 schema → 渲染 SettingField 列表（showWhen/搜索/isNonDefault/reset）
// - 无 schema → JSON 兜底编辑
// ============================================================
import { ref, computed } from 'vue';
import type { FieldMeta } from '../types.ts';
import { toFields, filterFields, isNonDefault } from '../schema.ts';
import SettingField from './SettingField.vue';
import { FieldRow, IconAction, SearchInput, Textarea } from '@agentchat/webui-kit';

const props = defineProps<{
  /** 配置命名空间键（空 = 顶层全局配置） */
  nsKey: string;
  /** 读写目标配置对象 */
  config: Record<string, any>;
  /** 原始 schema（数组或对象格式） */
  schema?: unknown;
  /** 外部搜索关键字（空则内部搜索） */
  search?: string;
  /** 命名空间显示名 */
  title?: string;
}>();

const localQuery = ref('');
const query = computed(() => props.search ?? localQuery.value);

const fields = computed<FieldMeta[]>(() => toFields(props.schema));
const filtered = computed(() => filterFields(fields.value, getNs(), query.value));

function getNs(): Record<string, any> {
  return props.nsKey ? (props.config[props.nsKey] ?? {}) : props.config;
}
function getVal(key: string): unknown {
  return getNs()[key];
}
function setVal(key: string, v: unknown): void {
  if (!props.nsKey) { props.config[key] = v; return; }
  if (!props.config[props.nsKey]) props.config[props.nsKey] = {};
  props.config[props.nsKey][key] = v;
}
function resetVal(f: FieldMeta): void {
  setVal(f.key, f.default);
}

// JSON 兜底
const rawJson = ref('');
function openJson(): void {
  rawJson.value = JSON.stringify(getNs(), null, 2);
}
function saveJson(): void {
  try {
    const parsed = JSON.parse(rawJson.value);
    if (!props.nsKey) { Object.keys(props.config).forEach(k => delete props.config[k]); Object.assign(props.config, parsed); }
    else props.config[props.nsKey] = parsed;
  } catch { /* 非法 JSON 保持编辑，提示由外层处理 */ }
}
</script>

<template>
  <div class="ns-list">
    <!-- 搜索（无外部搜索时显示；kit SearchInput——cr-169） -->
    <div v-if="search === undefined" class="ns-search">
      <SearchInput v-model="localQuery" placeholder="搜索设置" />
    </div>

    <!-- Schema 字段 -->
    <template v-if="fields.length > 0">
      <div class="ns-fields">
        <FieldRow
          v-for="f in filtered" :key="f.key"
          :label="f.label" :description="f.description" :non-default="isNonDefault(getVal(f.key), f.default)"
        >
          <SettingField :field="f" :model-value="getVal(f.key)" @update:model-value="setVal(f.key, $event)" />
          <IconAction v-if="isNonDefault(getVal(f.key), f.default)" icon="rotate-ccw" label="恢复默认值" @click="resetVal(f)" />
        </FieldRow>
        <div v-if="filtered.length === 0" class="ns-empty">未找到匹配的设置</div>
      </div>
    </template>

    <!-- JSON 兜底 -->
    <div v-else class="ns-json">
      <div class="ns-json-head">
        <span class="ns-json-title">{{ title || '配置' }} (JSON)</span>
        <button class="ns-json-btn" @click="openJson()">编辑</button>
      </div>
      <template v-if="rawJson !== ''">
        <Textarea v-model="rawJson" code :rows="6" />
        <div class="ns-json-actions">
          <button class="ns-json-btn" @click="rawJson = ''">取消</button>
          <button class="ns-json-btn primary" @click="saveJson(); rawJson = ''">应用</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* cr-169：搜索框/字段行/复位钮/JSON 域控件本体已归 kit
   （SearchInput/FieldRow/IconAction/Textarea），此处仅留布局编排 */
.ns-list { display: flex; flex-direction: column; gap: 10px; }

.ns-search { padding-bottom: 8px; border-bottom: 1px solid var(--line); }

.ns-fields { display: flex; flex-direction: column; gap: 6px; }
.ns-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }

.ns-json { display: flex; flex-direction: column; gap: 8px; }
.ns-json-head { display: flex; align-items: center; justify-content: space-between; }
.ns-json-title { font-size: 13px; font-weight: 500; color: var(--text-1); }
.ns-json-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ns-json-btn {
  padding: 4px 12px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer; transition: all var(--dur-fast);
}
.ns-json-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.ns-json-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.ns-json-btn.primary:hover { opacity: .9; color: var(--on-primary); }
</style>
