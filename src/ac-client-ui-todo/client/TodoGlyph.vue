<!-- TodoGlyph.vue —— 待办状态 glyph 单源（三形之二：勾圈/虚线圈）
  in_progress 用 kit BusyRing（cr-129 R2 忙指示唯一源），不在此组件内。
  两消费面（TodoPanel dock 卡 14px / ToolResultTodo 工具卡 13px）原本各存
  一份同 path SVG，且色档走散（dock 取 --ok-status 状态档、工具卡取 --ok
  墨色档）——cr-454 并源：图形件统一状态档（cr-140/145 语义分层后图标性
  元素一律 *-status，3.0 线）。 -->
<script setup lang="ts">
defineProps<{
  status: 'completed' | 'pending';
  /** 视觉外径 px（dock 行 14 / 工具卡行 13） */
  size?: number;
}>();
</script>

<template>
  <svg
    v-if="status === 'completed'"
    class="glyph-done"
    :width="size"
    :height="size"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" />
    <path d="M10.96 5.71L7.7 8.98c-.22.22-.42.42-.61.57-.19.16-.43.3-.73.35-.16.03-.32.03-.48 0-.3-.05-.54-.19-.73-.35-.18-.15-.38-.35-.61-.57L3.04 7.46l.93-.93 1.51 1.52c.24.24.39.38.5.48.11.09.13.09.16.08.02.01.05.01.07 0 .03.01.05-.01.16-.1.12-.09.27-.24.5-.48L10.04 4.79l.92.92z" fill="currentColor" />
  </svg>
  <svg
    v-else
    class="glyph-pending"
    :width="size"
    :height="size"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4" />
  </svg>
</template>

<style scoped>
.glyph-done { color: var(--ok-status); }
.glyph-pending { color: var(--text-3); }
</style>
