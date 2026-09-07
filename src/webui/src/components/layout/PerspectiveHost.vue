<script setup lang="ts">
// ============================================================
// components/layout/PerspectiveHost.vue —— 视角容器
//
// 渲染当前激活视角（core/registry/perspectives 注册表驱动）。
// 主区域只此一个容器；新增视角 = 注册项，不改主框架。
//
// M27 S1：D18-1 bail 权限门控——宿主/权限面可经客户端
// 'activity/perspective' bail 事件拒绝视角（无监听 = 放行；默认拒绝
// 形态随权限面启用）。视角专座渲染 = main 席位内的 PerspectiveHost
//（AppFrame 挂载；D9 于 S2 升 keyed 选举）。
// ============================================================

import { computed } from 'vue';
import { activePerspective, perspectiveVersion, type Perspective } from '../../core/registry/perspectives';
import { useClientContext } from 'ac-client-runtime';

const emit = defineEmits<{
  (e: 'groupDeleted', groupId: string): void;
}>();

const ctx = useClientContext();

/** D18-1 bail 权限：'activity/perspective' 返回非空 = 拒绝（无监听放行） */
function bailAllowed(p: Perspective): boolean {
  if (!ctx || !p.bail) return true;
  return ctx.bail('activity/perspective', p) == null;
}

// 读取版本号建立响应式依赖：插件注册/注销视角时本容器自动重解析
const active = computed(() => {
  void perspectiveVersion.value;
  const p = activePerspective();
  return p && bailAllowed(p) ? p : null;
});

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
