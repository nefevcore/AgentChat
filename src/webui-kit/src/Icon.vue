<!--
  ui/Icon.vue —— 统一图标组件
  用法：<Icon name="send" :size="16" />
  图标名见 ui/icons.ts；未注册自动兜底为 info。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { resolveIcon } from './icons';

const props = withDefaults(defineProps<{
  name: string;
  size?: number;
  /** 继承 currentColor */
}>(), { size: 16 });

const comp = computed(() => resolveIcon(props.name));
</script>

<template>
  <component :is="comp" :width="size" :height="size" :aria-hidden="true" />
</template>
