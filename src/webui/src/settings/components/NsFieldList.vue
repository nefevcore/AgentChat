<script setup lang="ts">
// ============================================================
// NsFieldList.vue —— 通用命名空间 schema 表单
// 用途：扩展/工具/系统等基于 schema 的字段列表
// - 有 schema → 渲染 SettingField 列表（showWhen/搜索/isNonDefault/reset）
// - 无 schema → JSON 兜底编辑
// ============================================================
import { ref, computed } from 'vue';
import type { FieldMeta } from '../types';
import { toFields, filterFields, isNonDefault } from '../schema';
import SettingField from './SettingField.vue';

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
    <!-- 搜索（无外部搜索时显示） -->
    <div v-if="search === undefined" class="ns-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input v-model="localQuery" class="ns-search-input" placeholder="搜索设置" />
    </div>

    <!-- Schema 字段 -->
    <template v-if="fields.length > 0">
      <div class="ns-fields">
        <div
          v-for="f in filtered" :key="f.key"
          class="ns-item" :class="{ 'is-non-default': isNonDefault(getVal(f.key), f.default) }"
        >
          <div class="ns-label">{{ f.label }}</div>
          <div v-if="f.description" class="ns-desc">{{ f.description }}</div>
          <div class="ns-control">
            <SettingField :field="f" :model-value="getVal(f.key)" @update:model-value="setVal(f.key, $event)" />
            <button v-if="isNonDefault(getVal(f.key), f.default)" class="ns-reset" title="恢复默认值" @click="resetVal(f)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
          </div>
        </div>
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
        <textarea v-model="rawJson" class="ns-json-textarea" rows="6" spellcheck="false"></textarea>
        <div class="ns-json-actions">
          <button class="ns-json-btn" @click="rawJson = ''">取消</button>
          <button class="ns-json-btn primary" @click="saveJson(); rawJson = ''">应用</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ns-list { display: flex; flex-direction: column; gap: 10px; }

.ns-search { position: relative; display: flex; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.ns-search svg { position: absolute; left: 8px; color: var(--text-3); pointer-events: none; }
.ns-search-input {
  width: 100%; padding: 6px 10px 6px 28px;
  border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px; outline: none;
}
.ns-search-input:focus { border-color: var(--input-focus); }
.ns-search-input::placeholder { color: var(--text-3); }

.ns-fields { display: flex; flex-direction: column; gap: 2px; }
.ns-item {
  padding: 8px 12px; border-bottom: 1px solid var(--line);
  display: flex; flex-direction: column; gap: 5px; border-left: 3px solid transparent;
}
.ns-item:last-child { border-bottom: none; }
.ns-item.is-non-default { border-left-color: var(--primary); }
.ns-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.ns-desc { font-size: 11px; color: var(--text-3); }
.ns-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.ns-reset {
  flex-shrink: 0; width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  color: var(--text-3); cursor: pointer; padding: 0; transition: all var(--dur-fast);
}
.ns-reset:hover { background: var(--bg-hover); color: var(--primary); }
.ns-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }

.ns-json { display: flex; flex-direction: column; gap: 8px; }
.ns-json-head { display: flex; align-items: center; justify-content: space-between; }
.ns-json-title { font-size: 13px; font-weight: 500; color: var(--text-1); }
.ns-json-textarea {
  width: 100%; padding: 8px;
  border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--code-bg); color: var(--code-text);
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5; resize: vertical;
}
.ns-json-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ns-json-btn {
  padding: 4px 12px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer; transition: all var(--dur-fast);
}
.ns-json-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.ns-json-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.ns-json-btn.primary:hover { opacity: .9; color: #fff; }
</style>
