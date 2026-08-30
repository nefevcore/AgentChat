<!--
  ui/StarCard.vue —— 星卡（会话列表项容器）
  选中态：星色描边 + 微光；用法包任意内容。
  <StarCard :selected="active" :color="starColor"> ... </StarCard>
-->
<script setup lang="ts">
withDefaults(defineProps<{
  selected?: boolean;
  /** 星色（hex/CSS 色） */
  color?: string;
}>(), { selected: false });
</script>

<template>
  <div
    class="ui-star-card"
    :class="{ selected }"
    :style="{ '--sc': color || 'var(--primary)' }"
  >
    <slot />
  </div>
</template>

<style scoped>
.ui-star-card {
  display: flex; gap: 10px; align-items: flex-start; padding: 9px 10px;
  border-radius: var(--r-md); cursor: pointer; border: 1px solid transparent;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast);
}
.ui-star-card:hover { background: var(--bg-hover); }
.ui-star-card.selected {
  background: var(--bg-surface);
  border-color: color-mix(in srgb, var(--sc) 40%, transparent);
}
</style>
