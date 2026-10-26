<!-- TodoPanel.vue —— 待办清单 dock 卡（DSH TodoPanel 姿势）
  cr-186：外壳 = kit DockCard collapsible——header 整体可点展开/收起（原
  #actions 行尾小折叠钮退役），eyebrow「任务」+ title 进度摘要，正文显隐
  归壳（v-show）。进度摘要 = 各状态计数 · 连接、零计数段省略（DSH
  progressLabel 语义）。空清单不渲染。
  状态 glyph：completed 实心勾圈（--ok）/ in_progress kit BusyRing /
  pending 虚线圈（--text-3）——DSH 同款三形（忙环 cr-129 R2 归 kit）。 -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { DockCard, BusyRing } from '@agentchat/webui-kit';
import TodoGlyph from './TodoGlyph.vue';
import type { TaskTodo } from './tasks.ts';

const props = defineProps<{ todos: TaskTodo[] }>();

const collapsed = ref(true);

const counts = computed(() => {
  const done = props.todos.filter((t) => t.status === 'completed').length;
  const active = props.todos.filter((t) => t.status === 'in_progress').length;
  return { done, active, pending: props.todos.length - done - active };
});

/** 进度摘要：非零段 · 连接（空表由外层隐藏，至少一段在场） */
const progressText = computed(() => {
  const seg: string[] = [];
  if (counts.value.done > 0) seg.push(`${counts.value.done} 已完成`);
  if (counts.value.active > 0) seg.push(`${counts.value.active} 进行中`);
  if (counts.value.pending > 0) seg.push(`${counts.value.pending} 待办`);
  return seg.join(' · ');
});
</script>

<template>
  <!-- cr-186：折叠开关 = DockCard header 整体（collapsible 受控 + toggle
       回写 collapsed）；收起态自动取紧凑档（不再手传 dense）。 -->
  <DockCard
    v-if="todos.length > 0"
    class="todo-panel"
    aria-label="任务"
    eyebrow="任务"
    icon="clipboard-list"
    :title="progressText"
    collapsible
    :open="!collapsed"
    @toggle="(o) => (collapsed = !o)"
  >
    <ul class="todo-list">
      <li v-for="(item, i) in todos" :key="i" class="todo-item" :data-status="item.status">
        <span class="todo-glyph">
          <!-- 三形（cr-454 并源 TodoGlyph）：completed 勾圈 / pending 虚线圈；
               in_progress = kit BusyRing（cr-129 R2：忙指示唯一源） -->
          <BusyRing v-if="item.status === 'in_progress'" :size="13" />
          <TodoGlyph v-else :status="item.status === 'completed' ? 'completed' : 'pending'" :size="14" />
        </span>
        <span class="todo-content">{{ item.content }}</span>
      </li>
    </ul>
  </DockCard>
</template>

<style scoped>
/* cr-186：本行只留编排（壳/折叠头/内距与底缘避让全归 kit DockCard） */
.todo-panel { flex-shrink: 0; }

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  margin: 0;
  padding: 0 0 4px;
  list-style: none;
  overflow-y: auto;
}
.todo-item { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 13px; line-height: 20px; color: var(--text-2); }
.todo-item[data-status='completed'] .todo-content { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--text-3); }
.todo-glyph { display: grid; place-items: center; width: 16px; height: 16px; flex: none; }
/* 勾圈/虚线圈色档归 TodoGlyph 单源（cr-454）；in_progress 用 kit BusyRing
   （cr-129 R2——原自建 SVG 弧环 + 无限旋转退役，reduced-motion 归一由组件自带） */

.todo-content { min-width: 0; overflow-wrap: anywhere; }
</style>
