<!--
  ui/StarAvatar.vue —— 星体头像（光晕 + 活跃呼吸）
  星群语言：光晕大小 = 活跃度；思考中呼吸。
  用法：<StarAvatar :src="avatar" :name="name" :color="starColor" :active="thinking" />
-->
<script setup lang="ts">
import { computed } from 'vue';
import Avatar from './Avatar.vue';

const props = withDefaults(defineProps<{
  src?: string | null;
  name?: string;
  /** 星色（hex/CSS 色），默认靛蓝 */
  color?: string;
  size?: number;
  /** 思考/活跃中：光晕呼吸 */
  active?: boolean;
  /** 光晕强度 0-1 */
  glow?: number;
}>(), { size: 32, active: false, glow: 1 });

const glowStyle = computed(() => {
  const c = props.color || 'var(--primary)';
  return { boxShadow: `0 0 ${Math.round(12 * props.glow)}px ${c}` };
});
</script>

<template>
  <span class="ui-star" :class="{ active }" :style="glowStyle">
    <Avatar :src="src" :name="name" :size="size" />
  </span>
</template>

<style scoped>
.ui-star { display: inline-flex; border-radius: var(--r-full); position: relative; flex-shrink: 0; vertical-align: middle; }
.ui-star.active { animation: ui-star-breathe 1.6s ease-in-out infinite; }
@keyframes ui-star-breathe {
  0%, 100% { opacity: 0.55; transform: scale(0.96); }
  50% { opacity: 1; transform: scale(1.02); }
}
</style>
