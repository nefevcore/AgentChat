<script setup lang="ts">
// ============================================================
// SettingField.vue —— 单字段渲染（Schema 驱动的表单原子）
// 7 种控件：checkbox / select / number / ratio / file / password / text
// cr-169：控件全部换 kit 标准件（Checkbox/Select/Input/Slider/
// PasswordInput），视觉单源 @agentchat/webui-kit（画廊对照 c-fx-* 格）
// ============================================================
import { computed, ref } from 'vue';
import type { FieldMeta } from '../types.ts';
import * as api from '../api.ts';
import { parseNum, formatRatio } from '../schema.ts';
import { Checkbox, Input, PasswordInput, Select, Slider } from '@agentchat/webui-kit';

const props = defineProps<{ field: FieldMeta; modelValue: unknown }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: unknown): void }>();

const browsing = ref(false);

function set(v: unknown) { emit('update:modelValue', v); }

/** 读取展示值：未设置时回退 schema 默认 */
function displayValue(): unknown {
  return props.modelValue ?? props.field.default;
}

const selectOptions = computed(() => (props.field.options ?? []).map(o => ({ value: String(o.value), label: o.label })));

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
  <Checkbox v-if="field.type === 'checkbox'" :model-value="(displayValue() as boolean) !== false" @update:model-value="set">{{ field.label }}</Checkbox>

  <!-- select -->
  <div v-else-if="field.type === 'select' && field.options" class="sf-w-select">
    <Select :options="selectOptions" :model-value="String(displayValue() ?? field.options[0]?.value ?? '')" @update:model-value="set" />
  </div>

  <!-- number -->
  <div v-else-if="field.type === 'number'" class="sf-w-short">
    <Input type="number" :model-value="parseNum(displayValue()) as string | number" @update:model-value="set(parseNum($event))" />
  </div>

  <!-- ratio slider -->
  <Slider v-else-if="field.type === 'ratio'" class="sf-slider" :model-value="(displayValue() as number) ?? field.min ?? 0" :min="field.min ?? 0" :max="field.max ?? 1" :step="field.step ?? 0.01" :format="(v: number) => formatRatio(v, field.display)" @update:model-value="set" />

  <!-- file -->
  <div v-else-if="field.type === 'file'" class="sf-file">
    <Input class="sf-input-flex" :model-value="String(displayValue() ?? '')" placeholder="输入路径或点击选择文件..." @update:model-value="set" />
    <button class="sf-browse" :disabled="browsing" @click="onBrowse" title="选择文件">…</button>
  </div>

  <!-- password -->
  <div v-else-if="field.type === 'password'" class="sf-w-secret">
    <PasswordInput :model-value="String(displayValue() ?? '')" @update:model-value="set" />
  </div>

  <!-- text -->
  <Input v-else :model-value="String(displayValue() ?? '')" @update:model-value="set" />
</template>

<style scoped>
/* cr-169：控件本体样式已归 kit（ui-input/ui-sel/ui-slider/ui-secret/ui-check）。
   尺寸约束用容器包裹（kit 件 width:100%——直传类与其同特异性，胜负随打包
   顺序漂移，不可赌）；flex/max-width 不冲突属性可直传 */
.sf-w-select { width: 180px; }
.sf-w-short { width: 130px; }
.sf-w-secret { width: 230px; }
.sf-input-flex { flex: 1; min-width: 0; }
.sf-slider { max-width: 230px; }

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
</style>
