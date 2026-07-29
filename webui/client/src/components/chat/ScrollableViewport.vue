<script setup lang="ts">
defineProps<{
  /** 最大高度，默认 60vh */
  maxHeight?: string;
}>();
</script>

<template>
  <div class="scrollable-viewport" :style="{ maxHeight: maxHeight || '60vh' }">
    <slot />
  </div>
</template>

<style scoped>
.scrollable-viewport {
  overflow-y: auto;
}
</style>
