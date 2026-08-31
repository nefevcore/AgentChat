<!-- WorkspaceTreeNode.vue —— 递归树节点（纯 script setup 自引用） -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { Icon } from '../ui';

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

/** 根据文件扩展名选择图标与配色（lucide 图标名，见 ui/icons.ts） */
function getFileIcon(name: string): { icon: string; color: string } {
  const idx = name.lastIndexOf('.');
  const ext = idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
  const codeExts = new Set(['ts','tsx','js','jsx','mjs','cjs','vue','svelte','py','go','rs','java','c','cpp','cc','h','hpp','cs','php','rb','swift','kt','scala','css','scss','sass','less','html','htm','sql','graphql','gql']);
  const termExts = new Set(['sh','bash','zsh','fish','ps1','bat','cmd']);
  const imgExts = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp']);
  const archiveExts = new Set(['zip','tar','gz','tgz','rar','7z','bz2','xz']);
  const mdExts = new Set(['md','markdown']);
  const textExts = new Set(['txt','log','csv','pdf','xml','yaml','yml','toml','ini','conf','env','lock','json5']);
  if (codeExts.has(ext)) return { icon: 'code', color: '#4a90d9' };
  if (termExts.has(ext)) return { icon: 'terminal', color: '#2ea44f' };
  if (imgExts.has(ext)) return { icon: 'image', color: '#a855f7' };
  if (archiveExts.has(ext)) return { icon: 'file-archive', color: '#d97706' };
  if (ext === 'json') return { icon: 'file-json', color: '#e6a817' };
  if (mdExts.has(ext)) return { icon: 'file-code', color: '#0ea5e9' };
  if (textExts.has(ext)) return { icon: 'file-text', color: '' };
  return { icon: 'file', color: '' };
}

const fileIcon = computed(() => getFileIcon(props.node.name));
</script>

<template>
  <div class="wtn-node">
    <div v-if="node.type === 'dir'" class="wtn-row wtn-dir" @click="onToggle">
      <span class="wtn-arrow" :class="{ open: isOpen }"><Icon name="chevron-right" :size="12" /></span>
      <span class="wtn-icon"><Icon name="folder" :size="14" /></span>
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
      <span class="wtn-icon" :style="fileIcon.color ? { color: fileIcon.color } : undefined"><Icon :name="fileIcon.icon" :size="14" /></span>
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
.wtn-arrow { width: 12px; display: flex; align-items: center; justify-content: center; color: var(--color-text-muted); transition: transform 0.15s; flex-shrink: 0; }
.wtn-arrow.open { transform: rotate(90deg); }
.wtn-icon { flex-shrink: 0; display: flex; align-items: center; }
.wtn-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.wtn-size { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
.wtn-children { margin-left: 14px; border-left: 1px solid var(--color-border-secondary, #e8e8e8); padding-left: 4px; }
.wtn-more { color: var(--color-text-muted); font-style: italic; cursor: default; }
.wtn-empty { padding: 4px 10px; color: var(--color-text-muted); font-size: 12px; }
</style>
