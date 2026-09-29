<!--
  webui-kit/src/star/StarCard.vue —— 星卡（会话列表项容器）
  选中态：星色描边 + 微光；用法包任意内容。
  <StarCard :selected="active" :color="starColor"> ... </StarCard>
-->
<script setup lang="ts">
import { computed } from 'vue';
import { hexTriplet } from '../starColor.ts';

const props = withDefaults(defineProps<{
  selected?: boolean;
  /** 星色（hex/CSS 色） */
  color?: string;
}>(), { selected: false });

/** 身份色 + 其 RGB 伴随（cr-32：tint 走 rgba(var(--sc-rgb), α) 回退形态） */
const starVars = computed(() => ({
  '--sc': props.color || 'var(--primary)',
  '--sc-rgb': props.color ? hexTriplet(props.color) : 'var(--primary-rgb)',
}));
</script>

<template>
  <div
    class="ui-star-card"
    :class="{ selected }"
    :style="starVars"
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
  border-color: rgba(var(--sc-rgb), 0.4);
}
</style>
