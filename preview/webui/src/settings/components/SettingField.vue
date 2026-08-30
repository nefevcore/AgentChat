<script setup lang="ts">
// ============================================================
// SettingField.vue —— 单字段渲染（Schema 驱动的表单原子）
// 7 种控件：checkbox / select / number / ratio / file / password / text
// ============================================================
import { ref } from 'vue';
import type { FieldMeta } from '../types';
import * as api from '../api';
import { parseNum, formatRatio } from '../schema';

const props = defineProps<{ field: FieldMeta; modelValue: unknown }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: unknown): void }>();

const showSecret = ref(false);
const browsing = ref(false);

function set(v: unknown) { emit('update:modelValue', v); }

/** 读取展示值：未设置时回退 schema 默认 */
function displayValue(): unknown {
  return props.modelValue ?? props.field.default;
}

async function onBrowse() {
  if (browsing.value) return;
  browsing.value = true;
  try {
    const data = await api.browseFile(props.field.accept, `选择 ${props.field.key === 'mcpFile' ? 'MCP 配置文件' : '文件'}`);
    if (data.success && data.path) set(data.path);
  } catch (e: any) {
    console.warn('[SettingField] 文件选择失败:', e.message);
  } finally {
    browsing.value = false;
  }
}
</script>

<template>
  <!-- checkbox -->
  <template v-if="field.type === 'checkbox'">
    <label class="sf-checkbox">
      <input
        type="checkbox"
        :checked="(displayValue() as boolean) !== false"
        @change="set(($event.target as HTMLInputElement).checked)"
      />
      <span class="sf-text">{{ field.label }}</span>
    </label>
  </template>

  <!-- select -->
  <template v-else-if="field.type === 'select' && field.options">
    <select class="sf-select" :value="String(displayValue() ?? field.options[0]?.value)" @change="set(($event.target as HTMLSelectElement).value)">
      <option v-for="o in field.options" :key="String(o.value)" :value="String(o.value)">{{ o.label }}</option>
    </select>
  </template>

  <!-- number -->
  <template v-else-if="field.type === 'number'">
    <input
      type="number" class="sf-input sf-input-short"
      :value="parseNum(displayValue())"
      @input="set(parseNum(($event.target as HTMLInputElement).value))"
    />
  </template>

  <!-- ratio slider -->
  <template v-else-if="field.type === 'ratio'">
    <div class="sf-ratio">
      <input
        type="range" class="sf-slider"
        :min="field.min ?? 0" :max="field.max ?? 1" :step="field.step ?? 0.01"
        :value="(displayValue() as number) ?? field.min ?? 0"
        @input="set(parseFloat(($event.target as HTMLInputElement).value))"
      />
      <span class="sf-ratio-val">{{ formatRatio(displayValue() as number, field.display) }}</span>
    </div>
  </template>

  <!-- file -->
  <template v-else-if="field.type === 'file'">
    <div class="sf-file">
      <input type="text" class="sf-input sf-input-flex" :value="String(displayValue() ?? '')" @input="set(($event.target as HTMLInputElement).value)" placeholder="输入路径或点击选择文件..." />
      <button class="sf-browse" :disabled="browsing" @click="onBrowse" title="选择文件">…</button>
    </div>
  </template>

  <!-- password -->
  <template v-else-if="field.type === 'password'">
    <div class="sf-secret">
      <input
        :type="showSecret ? 'text' : 'password'" class="sf-input sf-input-secret"
        :value="String(displayValue() ?? '')"
        @input="set(($event.target as HTMLInputElement).value)"
        autocomplete="new-password"
      />
      <button
        class="sf-eye"
        @mousedown.prevent="showSecret = true"
        @mouseup.prevent="showSecret = false"
        @mouseleave="showSecret = false"
        :title="showSecret ? '隐藏' : '按住显示'"
      >
        <svg v-if="!showSecret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button>
    </div>
  </template>

  <!-- text -->
  <template v-else>
    <input type="text" class="sf-input" :value="String(displayValue() ?? '')" @input="set(($event.target as HTMLInputElement).value)" />
  </template>
</template>

<style scoped>
.sf-checkbox { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.sf-checkbox input { width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary); }
.sf-text { font-size: 13px; color: var(--text-1); }

.sf-input, .sf-select {
  padding: 6px 9px;
  border: 1px solid var(--input-border, rgba(255,255,255,.12));
  border-radius: var(--r-sm);
  background: var(--input-bg);
  color: var(--text-1);
  font-size: 13px;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.sf-input:focus, .sf-select:focus { outline: none; border-color: var(--input-focus); box-shadow: 0 0 0 3px var(--primary-light); }
.sf-input-short { width: 130px; }
.sf-input-flex { flex: 1; min-width: 0; }
.sf-input-secret { padding-right: 34px; width: 230px; }

.sf-ratio { display: flex; align-items: center; gap: 8px; }
.sf-slider { flex: 1; max-width: 200px; height: 4px; accent-color: var(--primary); cursor: pointer; }
.sf-ratio-val { font-size: 12px; color: var(--text-2); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; }

.sf-file { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
.sf-browse {
  flex-shrink: 0; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-2); font-size: 16px; font-weight: 700; line-height: 1;
  cursor: pointer; transition: all var(--dur-fast);
}
.sf-browse:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.sf-browse:disabled { opacity: .5; cursor: not-allowed; }

.sf-secret { position: relative; display: inline-flex; align-items: center; }
.sf-eye {
  position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: var(--text-3);
  cursor: pointer; padding: 4px; display: flex; line-height: 0; border-radius: var(--r-sm);
}
.sf-eye:hover { color: var(--text-1); background: var(--bg-hover); }
</style>
