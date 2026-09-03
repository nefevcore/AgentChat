<!-- GoalBar.vue —— 长期目标 dock 条（DSH GoalBar 姿势）
  单行条带：目标图标 + 阶段标签（进行中/已暂停/受阻——受阻与自动暂停
  带原因 tooltip）+ 目标文本（ellipsis 截断）+ goal-round 轮次进度
  （第 N/M 轮）。无目标（null/undefined）不渲染。
  只读呈现：变更走会话（用户对 Agent 说，Agent 经 goal 工具流转）——
  与 DSH 的 edit/pause/clear 动词面的差异是刻意的（写路径归工具）。 -->
<script setup lang="ts">
import { computed } from 'vue';
import type { TaskGoal } from '../../api/tasks.ts';
import { Icon } from '../../ui';

const props = defineProps<{ goal: TaskGoal }>();

const PHASES: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中的目标', cls: 'phase-active' },
  paused: { label: '已暂停的目标', cls: 'phase-paused' },
  blocked: { label: '受阻的目标', cls: 'phase-blocked' },
};

const phase = computed(() => PHASES[props.goal.status] ?? PHASES.active!);
const roundsText = computed(() => {
  if (props.goal.status !== 'active') return '';
  const done = props.goal.roundsDone ?? 0;
  if (done <= 0) return '';
  return `第 ${done}/${props.goal.maxRounds ?? 20} 轮`;
});
const tooltip = computed(() => {
  if (props.goal.status === 'blocked' && props.goal.blockedReason) return `受阻原因：${props.goal.blockedReason}`;
  if (props.goal.autoPausedReason) return `自动暂停：${props.goal.autoPausedReason}`;
  return props.goal.note || undefined;
});
</script>

<template>
  <div class="goal-bar" :title="tooltip">
    <span class="goal-glyph" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
      </svg>
    </span>
    <span class="goal-phase" :class="phase.cls">{{ phase.label }}</span>
    <span class="goal-objective">{{ goal.objective }}</span>
    <span v-if="roundsText" class="goal-rounds">{{ roundsText }}</span>
    <!-- 受阻/自动暂停标记：语义图标（替代 emoji 文字符号的旧形态） -->
    <Icon v-if="goal.status === 'blocked'" name="alert-circle" :size="12" class="goal-blocked-mark" aria-hidden="true" />
    <Icon v-else-if="goal.autoPausedReason" name="pause" :size="12" class="goal-blocked-mark goal-paused-mark" aria-hidden="true" />
  </div>
</template>

<style scoped>
.goal-bar {
  display: flex; align-items: center; gap: 10px;
  height: 32px; padding: 4px 12px;
  margin: 0 10px;
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary, var(--color-bg-page));
  flex-shrink: 0;
  min-width: 0;
}
.goal-glyph { display: inline-flex; color: var(--color-text-tertiary); flex: none; }
.goal-phase { flex: none; font-size: 12px; font-weight: 500; line-height: 20px; }
.phase-active { color: var(--color-primary, #4a90d9); }
.phase-paused { color: var(--color-text-tertiary); }
.phase-blocked { color: #f59e0b; }
.goal-objective {
  min-width: 0; flex: 1; font-size: 13px; line-height: 20px;
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.goal-rounds { flex: none; font-size: 11px; color: var(--color-text-tertiary); }
.goal-blocked-mark { flex: none; color: #f59e0b; }
.goal-paused-mark { color: var(--color-text-tertiary); }
</style>
