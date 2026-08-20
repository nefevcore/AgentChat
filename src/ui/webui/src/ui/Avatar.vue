<!--
  ui/Avatar.vue —— 基础头像（图片 / 图标回退 / 首字回退）
  shape: circle（星群风格，默认）/ square
  fallbackIcon: 无图（或图挂）时渲染的图标名（见 ui/icons.ts）——小尺寸下
  首字不可读，用图标做默认头像（如 bot）；未提供则回退首字。
  图片加载失败（404/网络错误）时自动回退，不会出现破图。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  src?: string | null;
  name?: string;
  size?: number;
  shape?: 'circle' | 'square';
  /** 无图回退图标（ui/icons.ts 注册名）；缺省 = 首字回退 */
  fallbackIcon?: string;
}>(), { shape: 'circle', size: 32 });

const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });

const initial = computed(() => (props.name || '?').charAt(0).toUpperCase());
const showImage = computed(() => !!props.src && !failed.value);
</script>

<template>
  <span
    class="ui-avatar"
    :class="`ui-avatar--${shape}`"
    :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' }"
  >
    <img v-if="showImage" :src="src!" :alt="name" class="ui-avatar-img" @error="failed = true" />
    <span v-else-if="fallbackIcon" class="ui-avatar-fallback ui-avatar-icon">
      <Icon :name="fallbackIcon" :size="Math.max(9, Math.round(size * 0.6))" />
    </span>
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
.ui-avatar-icon { font-size: 0; /* 图标不参与字号缩放，尺寸由 Icon size 控制 */ }
</style>
