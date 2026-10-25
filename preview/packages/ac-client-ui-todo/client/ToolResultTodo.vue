<!-- ToolResultTodo.vue —— todo 工具会话流卡片（DSH todo 行姿势）
  标题行「任务清单 X/Y 已完成」+ 紧凑清单（状态 glyph + 内容）。
  数据经 normalizeTodoCard：终值（output.todos）优先、调用中回落
  args.todos 预览；不可解析 → 空卡（外层 tool-body 已有边框容器）。
  M27 S3：自 webui components/chat/ToolResult/ 原样迁入 UI 行 client/
  （零像素迁移）；注册面 = 行 client 插件出厂贡献 tool-card:result-view
  keyed seat（id 'todo'）——行卸载即卡片回落默认文本渲染。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { BusyRing } from '@agentchat/webui-kit';
import TodoGlyph from './TodoGlyph.vue';
import { normalizeTodoCard, type TaskTodo } from './tasks.ts';

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
          <span class="todo-card-glyph">
            <BusyRing v-if="item.status === 'in_progress'" :size="13" />
            <TodoGlyph v-else :status="item.status === 'completed' ? 'completed' : 'pending'" :size="13" />
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
.todo-card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text-1); }
.todo-card-summary { font-weight: 400; color: var(--text-3); }
.todo-card-pending { font-style: italic; color: var(--text-3); font-weight: 400; }
.todo-card-list { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; max-height: var(--card-viewport-max); overflow-y: auto; }
.todo-card-item { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-2); line-height: 18px; }
.todo-card-item[data-status='completed'] .todo-card-content { color: var(--text-3); text-decoration: line-through; }
.todo-card-glyph { display: grid; place-items: center; flex: none; }
/* 勾圈/虚线圈色档归 TodoGlyph 单源（cr-454 并源——原工具卡 --ok 墨色档
   与 dock 卡 --ok-status 状态档走散，图形件统一状态档）；in_progress 用
   kit BusyRing（cr-129 R2） */
.todo-card-content { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.todo-card-status { flex: none; font-size: 11px; color: var(--text-3); }
.todo-card-empty { font-style: italic; color: var(--text-3); }
</style>
