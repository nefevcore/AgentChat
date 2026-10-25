<script setup lang="ts">
defineProps<{
  /** 最大高度；缺省用会话卡片统一限高令牌 --card-viewport-max */
  maxHeight?: string;
}>();
</script>

<template>
  <div class="scrollable-viewport" :style="{ maxHeight: maxHeight || 'var(--card-viewport-max)' }">
    <slot />
  </div>
</template>

<style scoped>
.scrollable-viewport {
  overflow-y: auto;
}
</style>
