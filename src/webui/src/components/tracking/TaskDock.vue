<!-- TaskDock.vue —— 任务追踪 dock 装配（composer 上方；DSH input dock 姿势）
  数据归 useTaskTracking（会话切换拉取 + tool/after-execute·after-run 帧刷新）；
  TodoPanel 在前、GoalBar 在后（DSH dock 序：Todo → Goal）。两卡各自
  「无内容不渲染」——无目标且无清单时本 dock 整体不可见。 -->
<script setup lang="ts">
import { computed, toRef } from 'vue';
import { useTaskTracking } from '../../composables/useTaskTracking';
import TodoPanel from './TodoPanel.vue';
import GoalBar from './GoalBar.vue';

const props = defineProps<{
  /** 桶归属 Agent（直答 = 激活 Agent；独立会话 = 会话登记 Agent） */
  agentId: string | null | undefined;
  /** 会话桶键（直答 = pairKey(viewer, agent)；独立会话 = sid） */
  conversationId: string | null | undefined;
}>();

const { goal, todos } = useTaskTracking(toRef(props, 'agentId'), toRef(props, 'conversationId'));

const visibleTodos = computed(() => todos.value ?? []);
const hasSurface = computed(() =>
  (todos.value !== undefined && visibleTodos.value.length > 0)
  || goal.value !== undefined,
);
</script>

<template>
  <div v-if="hasSurface" class="task-dock">
    <TodoPanel v-if="visibleTodos.length > 0" :todos="visibleTodos" />
    <GoalBar v-if="goal" :goal="goal" />
  </div>
</template>

<style scoped>
.task-dock { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
</style>
