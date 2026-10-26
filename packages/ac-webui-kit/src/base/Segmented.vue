<!--
  webui-kit/src/base/Segmented.vue —— 分段器（cr-157）
  归一：RunTracking .range-toggle（时间范围）、TokenUsage .seg-control（按消耗/按模型）、
  FileEditsPanel 视图切换。凹槽（bg-inset）+ 浮起激活块（bg-raised + 主色文字）。
-->
<script setup lang="ts">
defineProps<{
  items: Array<{ id: string; label: string; disabled?: boolean }>
  modelValue: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [id: string] }>();
</script>

<template>
  <div class="ui-seg" role="tablist">
    <button
      v-for="it in items" :key="it.id"
      type="button"
      class="ui-seg-btn"
      :class="{ on: modelValue === it.id }"
      role="tab"
      :aria-selected="modelValue === it.id"
      :disabled="it.disabled"
      @click="emit('update:modelValue', it.id)"
    >{{ it.label }}</button>
  </div>
</template>

<style scoped>
.ui-seg {
  display: inline-flex; gap: 2px; padding: 3px;
  border-radius: calc(var(--r-md) - 2px);
  background: var(--bg-inset);
}
.ui-seg-btn {
  padding: 4px 11px; border: none; border-radius: calc(var(--r-md) - 4px);
  background: none; color: var(--text-2);
  font-size: var(--fs-sm); font-weight: 500; font-family: var(--font-ui);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast), box-shadow var(--dur-fast);
}
.ui-seg-btn:hover:not(:disabled) { color: var(--text-1); }
.ui-seg-btn:disabled { opacity: 0.35; cursor: not-allowed; }
/* 选中段底取 --bg-raised（抬一档，与页底可辨） */
.ui-seg-btn.on { background: var(--bg-raised); color: var(--primary); box-shadow: var(--shadow-hover); }
.ui-seg-btn:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-width); }
</style>