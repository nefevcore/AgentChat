<!--
  webui-kit/src/base/Label.vue —— 表单字段标签标准件（cr-173）
  承 FieldRow 内嵌配方单源（.ui-field-label/.ui-field-desc 抽出）：字段名 +
  可选说明行。FieldRow 内嵌消费；散表单（非字段行布局）可独立使用。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  label: string;
  description?: string;
}>(), { description: '' });
</script>

<template>
  <div class="ui-label">
    <div class="ui-label-name">{{ label }}</div>
    <div v-if="description" class="ui-label-desc">{{ description }}</div>
  </div>
</template>

<style scoped>
.ui-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ui-label-name { font-size: var(--fs-md); font-weight: 500; color: var(--text-1); }
.ui-label-desc { font-size: var(--fs-xs); color: var(--text-3); }
</style>
