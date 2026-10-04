<!--
  webui-kit/src/base/Checkbox.vue —— 复选框标准件（cr-168）
  原生 input + accent-color 主色（不重绘控件——保持平台无障碍行为）。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  modelValue?: boolean;
  disabled?: boolean;
}>(), { modelValue: false, disabled: false });
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();
</script>

<template>
  <label class="ui-check">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    ><slot />
  </label>
</template>

<style scoped>
.ui-check { display: flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text-1); cursor: pointer; }
.ui-check input { accent-color: var(--primary); width: 15px; height: 15px; }
.ui-check:has(input:disabled) { opacity: 0.55; cursor: not-allowed; }
</style>
