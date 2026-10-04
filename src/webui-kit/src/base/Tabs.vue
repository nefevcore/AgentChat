<!--
  webui-kit/src/base/Tabs.vue —— 页签（cr-157）
  归一：AgentPane .agent-tab（下划线式）、TokenUsage .tab-bar（竖栏 pill 式）、
  ToolResultBrowser .brw-log-tab（小下划线式）。
  variant: line（横向下划线）/ pill（竖向栏块，primary-light 底）。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  items: Array<{ id: string; label: string }>
  modelValue: string;
  variant?: 'line' | 'pill';
}>(), { variant: 'line' });

const emit = defineEmits<{ 'update:modelValue': [id: string] }>();
</script>

<template>
  <div class="ui-tabs" :class="variant" role="tablist">
    <button
      v-for="it in items" :key="it.id"
      type="button"
      class="ui-tab"
      :class="{ on: modelValue === it.id }"
      role="tab"
      :aria-selected="modelValue === it.id"
      @click="emit('update:modelValue', it.id)"
    >{{ it.label }}</button>
  </div>
</template>

<style scoped>
.ui-tabs.line { display: flex; gap: 2px; border-bottom: 1px solid var(--line); }
.ui-tabs.pill { display: flex; flex-direction: column; gap: 2px; }
.ui-tab {
  border: none; background: transparent; color: var(--text-2);
  font-size: var(--fs-md); font-family: var(--font-ui);
  cursor: pointer;
  transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
}
.ui-tab:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: calc(-1 * var(--focus-ring-width)); }
/* line 式：下缘 2px 指示线（透明 → 主色） */
.ui-tabs.line .ui-tab {
  padding: 8px 12px;
  box-shadow: inset 0 -2px 0 transparent;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
}
.ui-tabs.line .ui-tab:hover { color: var(--text-1); background: var(--bg-hover); }
.ui-tabs.line .ui-tab.on { color: var(--primary); box-shadow: inset 0 -2px 0 var(--primary); font-weight: 500; }
/* pill 式（竖栏）：左对齐块钮 */
.ui-tabs.pill .ui-tab { padding: 8px 12px; border-radius: var(--r-sm); text-align: left; }
.ui-tabs.pill .ui-tab:hover { color: var(--text-1); background: var(--bg-hover); }
.ui-tabs.pill .ui-tab.on { color: var(--primary); background: var(--primary-light); font-weight: 500; }
</style>