<!--
  webui-kit/src/base/SearchInput.vue —— 搜索输入标准件（cr-168）
  Input 的左内嵌图标形态（列表/选单过滤位）。
-->
<script setup lang="ts">
import Input from './Input.vue';
import Icon from './Icon.vue';

withDefaults(defineProps<{
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
}>(), { modelValue: '', placeholder: '', disabled: false });
const emit = defineEmits<{ 'update:modelValue': [v: string] }>();
</script>

<template>
  <span class="ui-search">
    <Icon name="search" :size="14" class="ui-search-ic" />
    <Input
      :model-value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="ui-search-in"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </span>
</template>

<style scoped>
.ui-search { position: relative; display: flex; align-items: center; flex: 1; }
.ui-search-ic { position: absolute; left: 9px; color: var(--text-3); pointer-events: none; z-index: 1; }
/* 深层覆写 Input 的 padding（scoped 组合：:deep 走全局 .ui-input） */
.ui-search :deep(.ui-input) { padding-left: 28px; }
</style>
