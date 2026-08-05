<!-- WorkspaceTree.vue —— 工作区目录树面板（懒加载 + 点击预览） -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import WorkspaceTreeNode, { type TreeNode } from './WorkspaceTreeNode.vue';

const emit = defineEmits<{
  (e: 'previewFile', filePath: string): void;
  (e: 'close'): void;
}>();

const root = ref<TreeNode[]>([]);
const loading = ref(false);
const error = ref('');
const activePath = ref('');

async function loadDir(dirPath: string): Promise<TreeNode[]> {
  loading.value = true;
  error.value = '';
  try {
    const q = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    const r = await fetch(`/api/workspace/tree${q}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '加载失败');
    return d.children || [];
  } catch (err: any) {
    error.value = err.message || String(err);
    return [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  root.value = await loadDir('');
});

/** 懒加载子目录 */
async function onToggle(node: TreeNode, parentPath: string) {
  if (node.type !== 'dir') return;
  if (!node.children) {
    const full = parentPath ? `${parentPath}/${node.name}` : node.name;
    node.children = await loadDir(full);
  }
}

function onFileClick(node: TreeNode, parentPath: string) {
  const full = parentPath ? `${parentPath}/${node.name}` : node.name;
  activePath.value = full;
  emit('previewFile', full);
}
</script>

<template>
  <div class="workspace-tree">
    <div class="wt-header">
      <span class="wt-title">📂 工作区</span>
      <button class="wt-close" @click="emit('close')" title="关闭">✕</button>
    </div>
    <div v-if="loading" class="wt-loading">加载中…</div>
    <div v-else-if="error" class="wt-error">{{ error }}</div>
    <div v-else class="wt-body">
      <WorkspaceTreeNode
        v-for="node in root"
        :key="node.name"
        :node="node"
        :parent-path="''"
        :active-path="activePath"
        @toggle="onToggle"
        @file-click="onFileClick"
      />
    </div>
  </div>
</template>

<style scoped>
.workspace-tree {
  display: flex; flex-direction: column;
  width: 280px; min-width: 280px; height: 100%;
  background: var(--color-bg-page, #fff);
  border-left: 1px solid var(--color-border-secondary, #e0e0e0);
  font-size: 13px;
}
.wt-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
}
.wt-title { font-weight: 600; color: var(--color-text-primary); }
.wt-close { border: none; background: none; cursor: pointer; font-size: 14px; color: var(--color-text-secondary); padding: 2px 6px; border-radius: 4px; }
.wt-close:hover { background: var(--color-bg-surface); }
.wt-body { flex: 1; overflow-y: auto; padding: 8px 6px; }
.wt-loading, .wt-error { padding: 16px; color: var(--color-text-secondary); font-size: 13px; }
.wt-error { color: var(--color-error); }
</style>
