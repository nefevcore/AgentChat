<!-- TaskDock.vue —— 任务追踪 dock 列席位宿主（composer 上方；DSH input dock 姿势）
  M27 S3：dock 卡列 = tracking:dock-widget list seat（slot-tree
  chat:composer-docks/tracking:dock-widget 收编首例）——todo 卡经
  ac-todo 行 client 贡献（行卸载即面板消失，可摘除性 D19）；goal 条暂为
  宿主内置（ac-goal 迁移时随行走）。DSH dock 序：Todo（贡献 order 10）
  → Goal（内置 order 20）。
  数据：goal 归 useGoalTracking（会话切换拉取 + 帧刷新）；todo 归贡献
  组件自理（owner props 透传 agentId/conversationId，D16-③）。零包裹
  纪律（D23-A）：无容器 div，dock 卡纵向节奏（6px 底距）由各卡自带。 -->
<script setup lang="ts">
import { toRef } from 'vue';
import SlotOutlet from '../SlotOutlet.vue';
import { SlotOutletItem } from '../SlotOutletItem';
import GoalBar from './GoalBar.vue';
import { useGoalTracking } from '../../composables/useGoalTracking';

const props = defineProps<{
  /** 桶归属 Agent（直答 = 激活 Agent；独立会话 = 会话登记 Agent） */
  agentId: string | null | undefined;
  /** 会话桶键（直答 = pairKey(viewer, agent)；独立会话 = sid） */
  conversationId: string | null | undefined;
}>();

const { goal } = useGoalTracking(toRef(props, 'agentId'), toRef(props, 'conversationId'));
</script>

<template>
  <SlotOutlet name="tracking:dock-widget" :data="{ agentId: props.agentId, conversationId: props.conversationId }">
    <SlotOutletItem v-if="goal" :order="20">
      <GoalBar :goal="goal" />
    </SlotOutletItem>
  </SlotOutlet>
</template>
