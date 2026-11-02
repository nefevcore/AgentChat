<!-- ToolResultGoal.vue —— goal 工具会话流卡片（cr-765 #13 GoalCard 形态）
  CardFrame(meta = 阶段徽章 + 轮次) + 体（目标文本首行强调 + 受阻原因/备注前缀行）。
  折叠态即可读阶段（阶段提前到 label）；体内无阶段标签行。
  数据经 normalizeGoalCard：扁平终值优先（cr-765 A-4——阶段/受阻原因/备注不再丢）。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { CardFrame } from '@agentchat/webui-kit';
import { normalizeGoalCard } from '../goalCard.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

const card = computed(() => normalizeGoalCard(props.data));

const PHASES: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'p-active' },
  paused: { label: '已暂停', cls: 'p-paused' },
  blocked: { label: '受阻', cls: 'p-blocked' },
  completed: { label: '已完成', cls: 'p-done' },
};
const phase = computed(() => PHASES[card.value?.goal.status ?? 'active'] ?? PHASES.active!);
/** 轮次 meta：N/M 轮（maxRounds 缺席只显示 N 轮） */
const roundsText = computed(() => {
  const g = card.value?.goal;
  if (!g) return '';
  return typeof g.maxRounds === 'number' ? `${g.roundsDone ?? 0}/${g.maxRounds} 轮` : g.roundsDone ? `${g.roundsDone} 轮` : '';
});
const metaText = computed(() => [phase.value.label, roundsText.value].filter(Boolean).join(' · '));
/** 动作词（反馈 #6：get = 查询时刻快照 / update = 当次写入 / create = 登记——
 *  多张卡各自展示调用时刻的状态，标题明示语义） */
const actionLabel = computed(() => {
  const a = String(props.data.action ?? '');
  return a === 'get' ? ' · 查询' : a === 'update' ? ' · 更新' : a === 'create' ? ' · 登记' : a === 'delete' ? ' · 删除' : '';
});
</script>

<template>
  <CardFrame
    class="goal-card"
    :title="'目标' + actionLabel"
    icon="target"
    :meta="metaText"
    :running="loading"
    :tone="card?.goal.status === 'blocked' ? 'warn' : ''"
  >
    <template v-if="card">
      <div class="goal-objective">{{ card.goal.objective }}</div>
      <div v-if="card.goal.status === 'blocked' && card.goal.blockedReason" class="goal-line goal-reason">
        受阻原因：{{ card.goal.blockedReason }}
      </div>
      <div v-if="card.goal.note" class="goal-line goal-note">备注：{{ card.goal.note }}</div>
      <div v-if="card.message" class="goal-line">{{ card.message }}</div>
    </template>
    <div v-else-if="loading" class="goal-empty">正在更新目标…</div>
    <div v-else class="goal-empty">（无可解析目标）</div>
  </CardFrame>
</template>

<style scoped>
.goal-card { width: 100%; }
/* 阶段色随 meta 文本（CardFrame meta 单色限制——阶段色染在目标行左侧强调条） */
.goal-objective {
  color: var(--text-1);
  font-weight: 500;
  overflow-wrap: anywhere;
  font-size: var(--fs-sm);
  padding-left: 8px;
  border-left: 2px solid var(--primary);
}
:deep(.goal-card.is-warn) .goal-objective { border-left-color: var(--warn); }
.goal-line { color: var(--text-3); overflow-wrap: anywhere; font-size: var(--fs-2xs); padding-left: 10px; }
.goal-reason { color: var(--warn); }
.goal-empty { font-style: italic; color: var(--text-3); font-size: var(--fs-sm); }
/* 阶段色类（供 meta 文本着色——CardFrame meta 走 --text-3，这里给阶段词独立着色） */
.goal-card :deep(.cf-meta) { }
</style>