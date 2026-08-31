<!--
  ui/Tooltip.vue —— 轻量提示（CSS hover）
  用法：<Tooltip text="发送"> <Icon name="send" /> </Tooltip>
-->
<script setup lang="ts">
withDefaults(defineProps<{
  text?: string;
  placement?: 'top' | 'bottom';
}>(), { placement: 'top' });
</script>

<template>
  <span class="ui-tip" :data-tip="text" :class="`ui-tip--${placement}`">
    <slot />
  </span>
</template>

<style scoped>
.ui-tip { position: relative; display: inline-flex; }
.ui-tip::after {
  content: attr(data-tip); position: absolute; left: 50%;
  transform: translateX(-50%) translateY(4px);
  background: var(--bg-raised); color: var(--text-1); border: 1px solid var(--line);
  font-size: 11px; padding: 4px 8px; border-radius: var(--r-sm); white-space: nowrap;
  box-shadow: var(--shadow-pop); opacity: 0; pointer-events: none; visibility: hidden;
  transition: opacity 0.15s, transform 0.15s; z-index: 700;
}
.ui-tip--top::after { bottom: calc(100% + 6px); }
.ui-tip--bottom::after { top: calc(100% + 6px); }
.ui-tip:hover::after { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); }
</style>
