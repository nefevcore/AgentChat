<!-- ToolResultTodo.vue —— todo 工具会话流卡片（cr-765 #12 TodoCard 形态）
  CardFrame(meta = X/Y 已完成 + 细进度条) + 语义图标清单行（§1.7：
  check-circle 完成 / loader-circle 进行中 / circle 待办；行尾状态词）。
  折叠态即可读出进度（进度提前到 label）；展开体只有清单行。
  数据经 normalizeTodoCard：扁平终值优先（cr-765 A-3）、调用中回落
  args.todos 预览。注册面 = 行 client 插件出厂贡献 tool-card:result-view。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { CardFrame, Icon, Progress } from '@agentchat/webui-kit';
import { normalizeTodoCard, type TaskTodo } from './tasks.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

const card = computed(() => normalizeTodoCard(props.data));
const todos = computed(() => card.value?.todos ?? []);
const done = computed(() => todos.value.filter((t: TaskTodo) => t.status === 'completed').length);
const summary = computed(() => (card.value ? `${done.value}/${todos.value.length} 已完成` : ''));
const percent = computed(() => (todos.value.length > 0 ? Math.round((done.value / todos.value.length) * 100) : 0));

/** 动作词（反馈 #6：标题携带当次动作语义——read 是查看快照、write 是当次写入，
 *  卡与卡之间按调用序展示各自时刻的状态，不被误读为「最终进度」） */
const actionLabel = computed(() => {
  const a = String(props.data.action ?? '');
  return a === 'read' ? ' · 读取' : a === 'write' ? ' · 更新' : '';
});

const STATUS_LABELS: Record<string, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};
/** §1.7 行首图标：完成 check-circle / 进行中 loader-circle / 待办 circle / 取消 x-circle */
const statusIcon = (s: string) => (s === 'completed' ? 'check-circle' : s === 'in_progress' ? 'loader-circle' : s === 'cancelled' ? 'x-circle' : 'circle');
const statusTone = (s: string) => (s === 'completed' ? 'ok' : s === 'in_progress' ? 'run' : '');
</script>

<template>
  <CardFrame
    class="todo-card"
    :title="'任务清单' + actionLabel"
    icon="clipboard-list"
    :meta="summary"
    :running="loading"
  >
    <template #meta>
      <span v-if="loading" class="todo-updating">更新中…</span>
      <Progress :value="percent" class="todo-progress" />
    </template>
    <div v-if="card" class="todo-list">
      <div v-for="(item, i) in todos" :key="i" class="todo-item" :data-status="item.status">
        <Icon :name="statusIcon(item.status)" :size="14" class="todo-icon" :class="'is-' + statusTone(item.status)" />
        <span class="todo-content">{{ item.content }}</span>
        <span class="todo-status">{{ STATUS_LABELS[item.status] ?? item.status }}</span>
      </div>
    </div>
    <div v-else-if="loading" class="todo-empty">正在更新任务清单…</div>
    <div v-else class="todo-empty">（无可解析清单）</div>
  </CardFrame>
</template>

<style scoped>
.todo-card { width: 100%; }
.todo-updating { font-size: var(--fs-2xs); color: var(--text-3); font-style: italic; font-family: var(--font-ui); }
.todo-progress { width: 56px; }
.todo-list { display: flex; flex-direction: column; gap: 4px; }
.todo-item { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-2); line-height: 20px; }
.todo-item[data-status='completed'] .todo-content,
.todo-item[data-status='cancelled'] .todo-content { color: var(--text-3); text-decoration: line-through; }
.todo-icon { flex: none; }
/* §1.7 着色：成功 --ok-status / 运行 --primary / 默认随行 --text-3 */
.todo-icon.is-ok { color: var(--ok-status); }
.todo-icon.is-run { color: var(--primary); }
.todo-content { min-width: 0; flex: 1; overflow-wrap: anywhere; font-size: var(--fs-sm); }
.todo-status { flex: none; font-size: var(--fs-2xs); color: var(--text-3); }
.todo-empty { font-style: italic; color: var(--text-3); font-size: var(--fs-sm); }
</style>