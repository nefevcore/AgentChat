<!--
  ui/ScrollView.vue —— 限高滚动容器（统一滚动条）
  用法：<ScrollView max-height="260px">...</ScrollView>
-->
<script setup lang="ts">
withDefaults(defineProps<{
  maxHeight?: string | number;
}>(), { maxHeight: '300px' });
</script>

<template>
  <div class="ui-scroll" :style="{ maxHeight: typeof maxHeight === 'number' ? maxHeight + 'px' : maxHeight }">
    <slot />
  </div>
</template>

<style scoped>
.ui-scroll { overflow-y: auto; overflow-x: hidden; }
</style>
