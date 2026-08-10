<!--
  ui/Avatar.vue —— 基础头像（图片 / 首字回退）
  shape: circle（星群风格，默认）/ square
-->
<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  src?: string | null;
  name?: string;
  size?: number;
  shape?: 'circle' | 'square';
}>(), { shape: 'circle', size: 32 });

const initial = computed(() => (props.name || '?').charAt(0).toUpperCase());
</script>

<template>
  <span
    class="ui-avatar"
    :class="`ui-avatar--${shape}`"
    :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' }"
  >
    <img v-if="src" :src="src" :alt="name" class="ui-avatar-img" />
    <span v-else class="ui-avatar-fallback">{{ initial }}</span>
  </span>
</template>

<style scoped>
.ui-avatar { display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.ui-avatar--circle { border-radius: var(--r-full); }
.ui-avatar--square { border-radius: var(--r-sm); }
.ui-avatar-img { width: 100%; height: 100%; object-fit: cover; }
.ui-avatar-fallback {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  background: var(--primary-light); color: var(--primary); font-weight: 600;
}
</style>
