<!-- TodoPanel.vue —— 待办清单 dock 卡（DSH TodoPanel 姿势）
  折叠卡片：头部（清单图标 + 标题「任务」+ 进度摘要 + chevron），
  展开列条目（状态 glyph + 内容）。进度摘要 = 各状态计数 · 连接、
  零计数段省略（DSH progressLabel 语义）。空清单不渲染。
  状态 glyph：completed 实心勾圈（绿）/ in_progress 旋转渐变环（主题色）/
  pending 虚线圈（弱化色）——DSH 同款三形。 -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TaskTodo } from '../../api/tasks.ts';

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
  <section v-if="todos.length > 0" class="todo-panel" aria-label="任务">
    <div class="todo-body">
      <button type="button" class="todo-header" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
        <span class="todo-lead" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 5h4v4H3zM3 13h4v4H3z" /><path d="M10 7h11M10 15h7" />
          </svg>
        </span>
        <span class="todo-title">任务</span>
        <span class="todo-progress">{{ progressText }}</span>
        <span class="todo-chevron" :class="{ open: !collapsed }" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      <ul v-if="!collapsed" class="todo-list">
        <li v-for="(item, i) in todos" :key="i" class="todo-item" :data-status="item.status">
          <span class="todo-glyph" aria-hidden="true">
            <!-- completed：实心勾圈 -->
            <svg v-if="item.status === 'completed'" class="glyph-done" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" />
              <path d="M10.96 5.71L7.7 8.98c-.22.22-.42.42-.61.57-.19.16-.43.3-.73.35-.16.03-.32.03-.48 0-.3-.05-.54-.19-.73-.35-.18-.15-.38-.35-.61-.57L3.04 7.46l.93-.93 1.51 1.52c.24.24.39.38.5.48.11.09.13.09.16.08.02.01.05.01.07 0 .03.01.05-.01.16-.1.12-.09.27-.24.5-.48L10.04 4.79l.92.92z" fill="currentColor" />
            </svg>
            <!-- in_progress：旋转弧环（RunTracking/StarAvatar 同款姿势——旋转挂内层 <g> +
                 transform-box:view-box 对齐 viewBox 绕圆心；轨道圈+弧形主环无 defs/id，
                 转动可视性不依赖渐变） -->
            <svg v-else-if="item.status === 'in_progress'" class="glyph-progress" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <g class="glyph-spin">
                <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.2" />
                <path d="M7 0.6 A6.4 6.4 0 0 1 13.4 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </g>
            </svg>
            <!-- pending：虚线圈 -->
            <svg v-else class="glyph-pending" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4" />
            </svg>
          </span>
          <span class="todo-content">{{ item.content }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.todo-panel {
  flex-shrink: 0;
  margin: 0 10px;
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary, var(--color-bg-page));
  overflow: hidden;
}

.todo-body { display: flex; flex-direction: column; gap: 6px; padding: 6px 12px; }

.todo-header {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: none; border: none; padding: 0; text-align: left; cursor: pointer;
}
.todo-lead { display: grid; place-items: center; color: var(--color-text-tertiary); flex: none; }
.todo-title { color: var(--color-text-primary); font-size: 13px; font-weight: 500; line-height: 24px; flex: none; }
.todo-progress {
  min-width: 0; flex: auto; color: var(--color-text-tertiary);
  font-size: 12px; line-height: 20px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.todo-chevron { display: grid; place-items: center; color: var(--color-text-tertiary); flex: none; transition: transform 0.2s ease; }
.todo-chevron.open { transform: rotate(180deg); }

.todo-list {
  display: flex; flex-direction: column; gap: 8px;
  max-height: 180px; margin: 0; padding: 0 0 4px; list-style: none;
  overflow-y: auto;
}
.todo-item { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 13px; line-height: 20px; color: var(--color-text-secondary); }
.todo-item[data-status='completed'] .todo-content { color: var(--color-text-tertiary); text-decoration: line-through; text-decoration-color: var(--color-text-tertiary); }
.todo-glyph { display: grid; place-items: center; width: 16px; height: 16px; flex: none; }
.glyph-done { color: #22c55e; }
.glyph-progress { color: var(--color-primary, #4a90d9); }
/* 旋转挂内层 g：transform-box 对齐 viewBox 绕圆心（仓库 SVG 旋转唯一验证姿势） */
.glyph-spin { transform-box: view-box; transform-origin: center; animation: todo-spin 1s linear infinite; }
.glyph-pending { color: var(--color-text-tertiary); }
@keyframes todo-spin { to { transform: rotate(360deg); } }

.todo-content { min-width: 0; overflow-wrap: anywhere; }
</style>
