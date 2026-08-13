<script setup lang="ts">
// ============================================================
// components/layout/PerspectiveHost.vue —— 视角容器
//
// 渲染当前激活视角（core/registry/perspectives 注册表驱动）。
// 主区域只此一个容器；新增视角 = 注册项，不改主框架。
// ============================================================

import { computed } from 'vue';
import { activePerspective } from '../../core/registry/perspectives';

const emit = defineEmits<{
  (e: 'groupDeleted', groupId: string): void;
}>();

const active = computed(() => activePerspective());

function buildProps(): Record<string, unknown> {
  return active.value?.props?.() ?? {};
}
</script>

<template>
  <component
    :is="active?.component"
    v-bind="buildProps()"
    @group-deleted="(gid: string) => emit('groupDeleted', gid)"
  />
</template>
