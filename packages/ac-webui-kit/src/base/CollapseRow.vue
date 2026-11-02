<!-- ============================================================
  webui-kit/src/base/CollapseRow.vue —— CardFrame 兼容别名（cr-765 批次A）
  原折叠内容行原语经 cr-121 → cr-765 升级为 CardFrame（icon/tone/canExpand/
  controls 契约扩展）；本文件保留旧名薄转发，既有消费点（ContextInjectCard、
  DockCard 注释引用）零改动。迁移完成后（ToolMessage/AssistantMessage 全员
  换 CardFrame、旧 props 面收回）可整体删除。
  ============================================================ -->
<script setup lang="ts">
import CardFrame from './CardFrame.vue';

withDefaults(defineProps<{
  title?: string;
  meta?: string;
  open?: boolean;
  running?: boolean;
  failed?: boolean;
  viewport?: string;
}>(), { title: '', meta: '', open: false, running: false, failed: false, viewport: 'var(--card-viewport-max)' });

const emit = defineEmits<{ (e: 'toggle', open: boolean): void }>();
</script>

<template>
  <CardFrame v-bind="$attrs" :title="title" :meta="meta" :open="open" :running="running" :failed="failed" :viewport="viewport" @toggle="emit('toggle', $event)">
    <template v-if="$slots.meta" #meta><slot name="meta" /></template>
    <slot />
  </CardFrame>
</template>