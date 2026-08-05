<!-- WorkspaceTreeNode.vue —— 递归树节点（纯 script setup 自引用） -->
<script setup lang="ts">
import { ref, computed } from 'vue';

export interface TreeNode {
  name: string;
  type: 'dir' | 'file' | 'more';
  size?: number;
  children?: TreeNode[];
}

// 递归自引用：通过 import 自身模块
import WorkspaceTreeNode from './WorkspaceTreeNode.vue';

const props = defineProps<{
  node: TreeNode;
  parentPath: string;
  activePath: string;
}>();

const emit = defineEmits<{
  (e: 'toggle', node: TreeNode, parentPath: string): void;
  (e: 'file-click', node: TreeNode, parentPath: string): void;
}>();

const full = computed(() =>
  props.parentPath ? `${props.parentPath}/${props.node.name}` : props.node.name
);
const isOpen = ref(false);

function onToggle() {
  isOpen.value = !isOpen.value;
  if (isOpen.value) emit('toggle', props.node, props.parentPath);
}
</script>

<template>
  <div class="wtn-node">
    <div v-if="node.type === 'dir'" class="wtn-row wtn-dir" @click="onToggle">
      <span class="wtn-arrow" :class="{ open: isOpen }">▸</span>
      <span class="wtn-icon">📁</span>
      <span class="wtn-name">{{ node.name }}</span>
    </div>
    <div
      v-else-if="node.type === 'file'"
      class="wtn-row wtn-file"
      :class="{ active: activePath === full }"
      @click="emit('file-click', node, parentPath)"
      :title="full"
    >
      <span class="wtn-arrow" />
      <span class="wtn-icon">📄</span>
      <span class="wtn-name">{{ node.name }}</span>
      <span v-if="node.size" class="wtn-size">({{ (node.size / 1024).toFixed(1) }}KB)</span>
    </div>
    <div v-else class="wtn-row wtn-more"><span class="wtn-name">{{ node.name }}</span></div>

    <div v-if="node.type === 'dir' && isOpen" class="wtn-children">
      <WorkspaceTreeNode
        v-for="child in node.children"
        :key="child.name"
        :node="child"
        :parent-path="full"
        :active-path="activePath"
        @toggle="(...args: any[]) => emit('toggle', ...(args as [TreeNode, string]))"
        @file-click="(...args: any[]) => emit('file-click', ...(args as [TreeNode, string]))"
      />
      <div v-if="!node.children || node.children.length === 0" class="wtn-empty">（空目录）</div>
    </div>
  </div>
</template>

<style scoped>
.wtn-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px; border-radius: 4px; cursor: pointer;
  white-space: nowrap; overflow: hidden; min-width: 0;
}
.wtn-row:hover { background: var(--color-bg-surface, #f5f5f5); }
.wtn-row.active { background: var(--color-primary-light, rgba(79,70,229,0.1)); }
.wtn-dir { color: var(--color-text-primary); font-weight: 500; }
.wtn-file { color: var(--color-text-secondary); }
.wtn-arrow { width: 12px; font-size: 10px; color: var(--color-text-muted); transition: transform 0.15s; flex-shrink: 0; text-align: center; }
.wtn-arrow.open { transform: rotate(90deg); }
.wtn-icon { flex-shrink: 0; font-size: 13px; }
.wtn-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.wtn-size { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
.wtn-children { margin-left: 14px; border-left: 1px solid var(--color-border-secondary, #e8e8e8); padding-left: 4px; }
.wtn-more { color: var(--color-text-muted); font-style: italic; cursor: default; }
.wtn-empty { padding: 4px 10px; color: var(--color-text-muted); font-size: 12px; }
</style>
