<!-- TodoPanel.vue —— 待办清单 dock 卡（DSH TodoPanel 姿势）
  cr-129 R6：外壳 = kit DockCard（eyebrow「任务」+ title 进度摘要 + #actions 折叠开关），
  展开在正文槽列条目（状态 glyph + 内容）。进度摘要 = 各状态计数 · 连接、
  零计数段省略（DSH progressLabel 语义）。空清单不渲染。
  状态 glyph：completed 实心勾圈（--ok）/ in_progress kit BusyRing /
  pending 虚线圈（--text-3）——DSH 同款三形（忙环 cr-129 R2 归 kit）。 -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { DockCard, BusyRing, Icon } from '@agentchat/webui-kit';
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
  <!-- cr-129 R6：dock 外壳 = kit DockCard（原自建折叠头壳退役）；dense = 收起态单行。
       折叠开关移入 #actions（DockCard 无 collapsible header——同 InteractionBar 姿势）。 -->
  <DockCard
    v-if="todos.length > 0"
    class="todo-panel"
    aria-label="任务"
    :dense="collapsed"
    eyebrow="任务"
    :title="progressText"
  >
    <template #actions>
      <button
        type="button"
        class="todo-fold"
        :title="collapsed ? '展开清单' : '收起清单'"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <Icon :name="collapsed ? 'chevron-down' : 'chevron-up'" :size="14" />
      </button>
    </template>

    <div class="todo-body">
      <ul v-if="!collapsed" class="todo-list">
        <li v-for="(item, i) in todos" :key="i" class="todo-item" :data-status="item.status">
          <span class="todo-glyph" aria-hidden="true">
            <!-- completed：实心勾圈 -->
            <svg v-if="item.status === 'completed'" class="glyph-done" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" />
              <path d="M10.96 5.71L7.7 8.98c-.22.22-.42.42-.61.57-.19.16-.43.3-.73.35-.16.03-.32.03-.48 0-.3-.05-.54-.19-.73-.35-.18-.15-.38-.35-.61-.57L3.04 7.46l.93-.93 1.51 1.52c.24.24.39.38.5.48.11.09.13.09.16.08.02.01.05.01.07 0 .03.01.05-.01.16-.1.12-.09.27-.24.5-.48L10.04 4.79l.92.92z" fill="currentColor" />
            </svg>
            <!-- in_progress：kit BusyRing（cr-129 R2：忙指示唯一源） -->
            <BusyRing v-else-if="item.status === 'in_progress'" :size="13" />
            <!-- pending：虚线圈 -->
            <svg v-else class="glyph-pending" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4" />
            </svg>
          </span>
          <span class="todo-content">{{ item.content }}</span>
        </li>
      </ul>
    </div>
  </DockCard>
</template>

<style scoped>
/* cr-129 R6：本行只留编排（边框/圆角/底色/影/内距与底缘 safe-bottom 避让归 DockCard） */
.todo-panel { flex-shrink: 0; }
/* 折叠开关（DockCard 无 collapsible header——开关走 #actions 位，同 InteractionBar 姿势） */
.todo-fold {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border: none; border-radius: var(--r-sm); background: transparent;
  color: var(--text-3); cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.todo-fold:hover { background: var(--bg-hover); color: var(--text-1); }

.todo-body { display: flex; flex-direction: column; gap: 6px; }

.todo-list {
  display: flex; flex-direction: column; gap: 8px;
  max-height: 180px; margin: 0; padding: 0 0 4px; list-style: none;
  overflow-y: auto;
}
.todo-item { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 13px; line-height: 20px; color: var(--text-2); }
.todo-item[data-status='completed'] .todo-content { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--text-3); }
.todo-glyph { display: grid; place-items: center; width: 16px; height: 16px; flex: none; }
/* 三形（勾圈/忙环/虚圈）：完成取 --ok 墨色档；in_progress 改用 kit BusyRing
   （cr-129 R2——原自建 SVG 弧环 + 无限旋转退役，reduced-motion 归一由组件自带） */
.glyph-done { color: var(--ok); }
.glyph-pending { color: var(--text-3); }

.todo-content { min-width: 0; overflow-wrap: anywhere; }
</style>
