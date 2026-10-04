<!--
  webui-kit/src/base/Breadcrumb.vue —— 面包屑（cr-157）
  归一：EntryPickerModal .entry-crumbs（路径导航）。末项恒 cur 态（当前层，非钮）。
-->
<script setup lang="ts">
defineProps<{
  items: Array<{ key: string; label: string }>
}>();

const emit = defineEmits<{ select: [key: string] }>();
</script>

<template>
  <nav class="ui-crumbs" aria-label="路径">
    <template v-for="(c, i) in items" :key="c.key">
      <span v-if="i > 0" class="ui-crumb-sep" aria-hidden="true">/</span>
      <button v-if="i < items.length - 1" type="button" class="ui-crumb" @click="emit('select', c.key)">{{ c.label }}</button>
      <span v-else class="ui-crumb cur" :title="c.label">{{ c.label }}</span>
    </template>
  </nav>
</template>

<style scoped>
.ui-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; min-width: 0; font-size: var(--fs-sm); }
.ui-crumb {
  position: relative; border: none; background: none; padding: 2px 5px;
  border-radius: var(--r-sm); color: var(--text-2); cursor: pointer;
  max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ui-crumb::after { content: ''; position: absolute; inset: 0; }
.ui-crumb:hover { color: var(--primary-strong); background: var(--bg-hover); }
.ui-crumb.cur { color: var(--text-1); font-weight: 500; cursor: default; }
.ui-crumb-sep { color: var(--text-3); padding: 0 1px; user-select: none; }
</style>