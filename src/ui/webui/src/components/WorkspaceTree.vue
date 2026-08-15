<!-- WorkspaceTree.vue —— 工作区目录树面板（懒加载 + 点击预览） -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import WorkspaceTreeNode, { type TreeNode } from './WorkspaceTreeNode.vue';
import { fetchWorkspaceTree } from '../core/api/endpoints/workspace';

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
    const d = await fetchWorkspaceTree(q);
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
      <span class="wt-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>
        </svg>
        工作区
      </span>
      <button class="wt-close" @click="emit('close')" title="关闭">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
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
  width: 280px; flex-shrink: 0; min-width: 0; height: 100%;
  /* 与会话列表（AgentList）同一底色，左右对称 */
  background: var(--color-bg-surface);
  font-size: 13px;
  overflow: hidden;
  border-left: 1px solid var(--color-border-secondary, #e0e0e0);
}
.wt-header {
  display: flex; align-items: center; justify-content: space-between;
  height: var(--layout-header-height, 48px);
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.wt-title {
  display: flex; align-items: center; gap: 6px;
  font-weight: 600; color: var(--color-text-primary);
}
.wt-title svg { color: var(--color-text-secondary, #7f8c8d); }
.wt-close {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border: none; background: none; cursor: pointer;
  color: var(--color-text-secondary); border-radius: 6px;
}
.wt-close:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.wt-body { flex: 1; overflow-y: auto; padding: 8px 6px; }

/* 小屏：工作区从右侧覆盖（v-if 控制渲染，无需位移动画） */
@media(max-width:768px){
  .workspace-tree{
    position:fixed; top:0; right:0; bottom:0; z-index:130;
    box-shadow:-2px 0 16px rgba(0,0,0,.15);
    border-left:1px solid var(--color-border-secondary,#e0e0e0);
  }
}
.wt-loading, .wt-error { padding: 16px; color: var(--color-text-secondary); font-size: 13px; }
.wt-error { color: var(--color-error); }
</style>
