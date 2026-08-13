<!--
  ui/StarAvatar.vue —— 扁平头像（中性化；保留身份色首字底色，无光晕/呼吸）
  用法：<StarAvatar :src="avatar" :name="name" :color="idColor" />
-->
<script setup lang="ts">
import Avatar from './Avatar.vue';

const props = withDefaults(defineProps<{
  src?: string | null;
  name?: string;
  /** 身份色（hex/CSS 色），用于无图时首字底色 */
  color?: string;
  size?: number;
}>(), { size: 32 });
</script>

<template>
  <span class="ui-star" :style="color ? { '--sc': color } : undefined">
    <Avatar :src="src" :name="name" :size="size" />
  </span>
</template>

<style scoped>
.ui-star { display: inline-flex; border-radius: var(--r-full); position: relative; flex-shrink: 0; vertical-align: middle; }
.ui-star :deep(.ui-avatar-fallback) {
  background: color-mix(in srgb, var(--sc, var(--primary)) 14%, transparent);
  color: var(--sc, var(--primary));
}
</style>
