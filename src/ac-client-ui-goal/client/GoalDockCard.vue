<!-- GoalDockCard.vue —— goal 域 dock 卡（conversation:dock-widget 贡献）
  M28 P1：原 TaskDock 宿主内置 GoalBar（order 20）迁入本行贡献形态。
  数据自理（useGoalTracking 事件化刷新：会话切换 + tool/after-execute ·
  loop/after-run 帧）；无目标（null/undefined）不渲染（三态契约）。 -->
<script setup lang="ts">
import { toRef } from 'vue';
import GoalBar from './GoalBar.vue';
import { useGoalTracking } from './useGoalTracking.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ComposerDock 经 SlotOutlet data 传入） */
  data: { agentId?: string | null; conversationId?: string | null };
}>();

const { goal } = useGoalTracking(
  toRef(() => props.data.agentId),
  toRef(() => props.data.conversationId),
);
</script>

<template>
  <GoalBar v-if="goal" :goal="goal" />
</template>
