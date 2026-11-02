<!-- InjectCardHost.vue -->
<script setup lang="ts">
// ============================================================
// 注入卡宿主（cr-765 #4）：按 kind 查 inject-card:view 席位——域行专用卡
//（问答卡第一例）优先，未命中回落通用 ContextInjectCard。TurnDisplayItem
// 链内挂位与 TranscriptList 独立降级位共用本宿主（单源消费）。
// ============================================================
import { computed } from 'vue';
import ContextInjectCard from './ContextInjectCard.vue';
import { resolveInjectCardView } from '../injectCardViews.ts';
import type { InjectCard } from '../types.ts';

const props = defineProps<{
  card: InjectCard;
  /** 独立降级位（TranscriptList 挂位传 true） */
  degraded?: boolean;
}>();

const view = computed(() => resolveInjectCardView(props.card.kind));
</script>

<template>
  <component :is="view" v-if="view" :card="card" :degraded="degraded" />
  <ContextInjectCard v-else :card="card" :degraded="degraded" />
</template>