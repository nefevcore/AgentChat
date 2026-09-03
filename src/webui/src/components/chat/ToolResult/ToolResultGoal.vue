<!-- ToolResultGoal.vue —— goal 工具会话流卡片（DSH goal 行姿势）
  阶段标签（进行中/已暂停/受阻/已完成）+ 目标文本 + 备注/受阻原因 +
  结果消息行。数据经 normalizeGoalCard：终值（output.goal /
  output.current）优先、调用中回落 args（objective/status）预览。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeGoalCard } from '../../../api/tasks.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

const card = computed(() => normalizeGoalCard(props.data));

const PHASES: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'p-active' },
  paused: { label: '已暂停', cls: 'p-paused' },
  blocked: { label: '受阻', cls: 'p-blocked' },
  completed: { label: '已完成', cls: 'p-done' },
};
const phase = computed(() => PHASES[card.value?.goal.status ?? 'active'] ?? PHASES.active!);
</script>

<template>
  <div class="goal-card">
    <template v-if="card">
      <div class="goal-card-row">
        <span class="goal-card-phase" :class="phase.cls">{{ phase.label }}</span>
        <span class="goal-card-objective">{{ card.goal.objective }}</span>
        <span v-if="loading" class="goal-card-pending">更新中…</span>
      </div>
      <div v-if="card.goal.status === 'blocked' && card.goal.blockedReason" class="goal-card-reason">
        受阻：{{ card.goal.blockedReason }}
      </div>
      <div v-if="card.goal.note" class="goal-card-note">备注：{{ card.goal.note }}</div>
      <div v-if="card.message" class="goal-card-message">{{ card.message }}</div>
    </template>
    <div v-else-if="loading" class="goal-card-pending">正在更新目标…</div>
    <div v-else class="goal-card-empty">（无可解析目标）</div>
  </div>
</template>

<style scoped>
.goal-card { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.goal-card-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.goal-card-phase { flex: none; font-weight: 600; font-size: 11px; }
.p-active { color: var(--color-primary, #4a90d9); }
.p-paused { color: var(--color-text-tertiary); }
.p-blocked { color: #f59e0b; }
.p-done { color: #22c55e; }
.goal-card-objective { min-width: 0; flex: 1; color: var(--color-text-primary); overflow-wrap: anywhere; font-weight: 500; }
.goal-card-pending { font-style: italic; color: var(--color-text-tertiary); font-weight: 400; }
.goal-card-reason { color: #f59e0b; overflow-wrap: anywhere; }
.goal-card-note { color: var(--color-text-tertiary); overflow-wrap: anywhere; }
.goal-card-message { color: var(--color-text-tertiary); }
.goal-card-empty { font-style: italic; color: var(--color-text-tertiary); }
</style>
