<!-- ToolResultTodo.vue —— todo 工具会话流卡片（DSH todo 行姿势）
  标题行「任务清单 X/Y 已完成」+ 紧凑清单（状态 glyph + 内容）。
  数据经 normalizeTodoCard：终值（output.todos）优先、调用中回落
  args.todos 预览；不可解析 → 空卡（外层 tool-body 已有边框容器）。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeTodoCard, type TaskTodo } from '../../../api/tasks.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

const card = computed(() => normalizeTodoCard(props.data));

const summary = computed(() => {
  const todos = card.value?.todos ?? [];
  const done = todos.filter((t: TaskTodo) => t.status === 'completed').length;
  return card.value ? `${done}/${todos.length} 已完成` : '';
});

const STATUS_LABELS: Record<string, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
};
</script>

<template>
  <div class="todo-card" :class="{ running: loading }">
    <template v-if="card">
      <div class="todo-card-title">
        任务清单
        <span class="todo-card-summary">{{ summary }}</span>
        <span v-if="loading" class="todo-card-pending">更新中…</span>
      </div>
      <ul class="todo-card-list">
        <li v-for="(item, i) in card.todos" :key="i" class="todo-card-item" :data-status="item.status">
          <span class="todo-card-glyph" aria-hidden="true">
            <svg v-if="item.status === 'completed'" class="g-done" width="13" height="13" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" />
              <path d="M10.96 5.71L7.7 8.98c-.22.22-.42.42-.61.57-.19.16-.43.3-.73.35-.16.03-.32.03-.48 0-.3-.05-.54-.19-.73-.35-.18-.15-.38-.35-.61-.57L3.04 7.46l.93-.93 1.51 1.52c.24.24.39.38.5.48.11.09.13.09.16.08.02.01.05.01.07 0 .03.01.05-.01.16-.1.12-.09.27-.24.5-.48L10.04 4.79l.92.92z" fill="currentColor" />
            </svg>
            <svg v-else-if="item.status === 'in_progress'" class="g-progress" width="13" height="13" viewBox="0 0 14 14" fill="none">
              <g class="g-spin">
                <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.2" />
                <path d="M7 0.6 A6.4 6.4 0 0 1 13.4 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </g>
            </svg>
            <svg v-else class="g-pending" width="13" height="13" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4" />
            </svg>
          </span>
          <span class="todo-card-content">{{ item.content }}</span>
          <span class="todo-card-status">{{ STATUS_LABELS[item.status] ?? item.status }}</span>
        </li>
      </ul>
    </template>
    <div v-else-if="loading" class="todo-card-pending">正在更新任务清单…</div>
    <div v-else class="todo-card-empty">（无可解析清单）</div>
  </div>
</template>

<style scoped>
.todo-card { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.todo-card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--color-text-primary); }
.todo-card-summary { font-weight: 400; color: var(--color-text-tertiary); }
.todo-card-pending { font-style: italic; color: var(--color-text-tertiary); font-weight: 400; }
.todo-card-list { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; max-height: 200px; overflow-y: auto; }
.todo-card-item { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--color-text-secondary); line-height: 18px; }
.todo-card-item[data-status='completed'] .todo-card-content { color: var(--color-text-tertiary); text-decoration: line-through; }
.todo-card-glyph { display: grid; place-items: center; flex: none; }
.g-done { color: #22c55e; }
.g-progress { color: var(--color-primary, #4a90d9); }
/* 旋转挂内层 g：transform-box 对齐 viewBox 绕圆心（仓库 SVG 旋转唯一验证姿势） */
.g-spin { transform-box: view-box; transform-origin: center; animation: todo-card-rot 1s linear infinite; }
.g-pending { color: var(--color-text-tertiary); }
@keyframes todo-card-rot { to { transform: rotate(360deg); } }
.todo-card-content { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.todo-card-status { flex: none; font-size: 11px; color: var(--color-text-tertiary); }
.todo-card-empty { font-style: italic; color: var(--color-text-tertiary); }
</style>
