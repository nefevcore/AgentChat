<!--
  webui-kit/src/base/Slider.vue —— 滑杆标准件（cr-168）
  原生 range + accent 主色 + mono 数值回显（配比/阈值类设置位）。
-->
<script setup lang="ts">
import { computed } from 'vue';
const props = withDefaults(defineProps<{
  modelValue?: number;
  min?: number;
  max?: number;
  step?: number;
  /** 数值回显格式化（缺省原值） */
  format?: (v: number) => string;
  disabled?: boolean;
}>(), { modelValue: 0, min: 0, max: 1, step: 0.01, disabled: false });
const emit = defineEmits<{ 'update:modelValue': [v: number] }>();
const fmt = computed(() => props.format ?? ((v: number) => String(v)));
</script>

<template>
  <div class="ui-slider">
    <input
      type="range"
      :value="modelValue"
      :min="min" :max="max" :step="step"
      :disabled="disabled"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    >
    <span class="ui-slider-val">{{ fmt(modelValue) }}</span>
  </div>
</template>

<style scoped>
.ui-slider { display: flex; align-items: center; gap: 10px; width: 100%; }
.ui-slider input { flex: 1; accent-color: var(--primary); height: 4px; }
.ui-slider input:disabled { opacity: 0.55; cursor: not-allowed; }
.ui-slider-val { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-2); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
