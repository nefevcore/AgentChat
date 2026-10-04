<!--
  webui-kit/src/base/PickTag.vue —— 隐式多选标签钮（cr-157）
  归一：CreateGroupDialog .label-badge（参与者筛选）与 PluginLibraryPane 筛选钮。
  on = 主色描边 + tint 底；off = 中性描边。
-->
<script setup lang="ts">
defineProps<{ on?: boolean }>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button type="button" class="ui-pick" :class="{ on }" :aria-pressed="on" @click="emit('toggle')">
    <slot />
  </button>
</template>

<style scoped>
.ui-pick {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border: 1px solid var(--line);
  border-radius: var(--r-md); background: none;
  font-size: var(--fs-sm); font-family: var(--font-ui);
  color: var(--text-2); cursor: pointer; position: relative;
}
.ui-pick:hover { background: var(--bg-hover); }
.ui-pick.on { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
.ui-pick:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-width); }
</style>