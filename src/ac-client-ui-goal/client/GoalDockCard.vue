<!-- GoalDockCard.vue —— goal 域 dock 卡（conversation:dock-widget 贡献）
  M28 P1：原 TaskDock 宿主内置 GoalBar（order 20）迁入本行贡献形态。
  数据自理（useGoalTracking 事件化刷新：会话切换 + tool/after-execute ·
  loop/after-run 帧）；无目标（null/undefined）不渲染（三态契约）。
  2026-10 直编面：rpc 面经 useGoalTracking 同源透传 GoalBar（写走
  goal/update · goal/delete RPC）；编辑落定 changed → refresh 对账
  （直编不经 Agent 工具，tool/after-execute 帧不触发——写后主动拉）。 -->
<script setup lang="ts">
import { toRef } from 'vue';
import GoalBar from './GoalBar.vue';
import { useGoalTracking } from './useGoalTracking.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ComposerDock 经 SlotOutlet data 传入） */
  data: { agentId?: string | null; conversationId?: string | null };
}>();

const agentId = toRef(() => props.data.agentId);
const conversationId = toRef(() => props.data.conversationId);

const { goal, rpc, refresh } = useGoalTracking(agentId, conversationId);
</script>

<template>
  <GoalBar
    v-if="goal"
    :goal="goal"
    :agent-id="agentId"
    :conversation-id="conversationId"
    :rpc="rpc"
    @changed="refresh"
  />
</template>
