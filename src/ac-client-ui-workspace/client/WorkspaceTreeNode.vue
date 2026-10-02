<!-- WorkspaceTreeNode.vue —— 递归树节点（纯 script setup 自引用）
  M33：展开态上提到 workspaceTreeStore（expanded 集合）——props 传入，
  点击 emit 目标态；不再持本地 isOpen（卸载重挂可恢复展开位）。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import type { TreeNode } from './workspaceTreeStore.ts';

// 递归自引用：通过 import 自身模块
import WorkspaceTreeNode from './WorkspaceTreeNode.vue';

const props = defineProps<{
  node: TreeNode;
  parentPath: string;
  activePath: string;
  /** 展开目录集合（store expanded——相对树基准路径；全层级共享单集合） */
  expandedPaths: Set<string>;
}>();

const emit = defineEmits<{
  (e: 'toggle', node: TreeNode, parentPath: string, isOpen: boolean): void;
  (e: 'file-click', node: TreeNode, parentPath: string): void;
}>();

const full = computed(() =>
  props.parentPath ? `${props.parentPath}/${props.node.name}` : props.node.name
);

const isOpen = computed(() => props.expandedPaths.has(full.value));

function onToggle() {
  emit('toggle', props.node, props.parentPath, !isOpen.value);
}

/** 根据文件扩展名选择图标与配色（lucide 图标名，见 ui/icons.ts）。
 *  展开态不走箭头：folder / folder-open 图标本身即展开语义（释放箭头列宽）。 */
function getFileIcon(name: string): { icon: string; color: string } {
  const idx = name.lastIndexOf('.');
  const ext = idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
  const codeExts = new Set(['ts','tsx','js','jsx','mjs','cjs','vue','svelte','py','go','rs','java','c','cpp','cc','h','hpp','cs','php','rb','swift','kt','scala','css','scss','sass','less','html','htm','sql','graphql','gql']);
  const termExts = new Set(['sh','bash','zsh','fish','ps1','bat','cmd']);
  const imgExts = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp']);
  const archiveExts = new Set(['zip','tar','gz','tgz','rar','7z','bz2','xz']);
  const mdExts = new Set(['md','markdown']);
  const sheetExts = new Set(['xls','xlsx','ods','csv','tsv']);
  const slideExts = new Set(['ppt','pptx','odp','key']);
  const docExts = new Set(['doc','docx','odt','rtf']);
  const audioExts = new Set(['mp3','wav','flac','ogg','m4a','aac','wma']);
  const videoExts = new Set(['mp4','mkv','mov','avi','webm','flv','wmv','m4v']);
  const fontExts = new Set(['ttf','otf','woff','woff2','eot']);
  const dbExts = new Set(['db','sqlite','sqlite3','mdb','accdb']);
  const configExts = new Set(['yaml','yml','toml','ini','conf','config','properties','env','lock','editorconfig']);
  const keyExts = new Set(['pem','key','crt','cer','p12','pfx','pub']);
  const binExts = new Set(['exe','dll','so','dylib','bin','wasm','o','a','class','iso','img','dmg']);
  // git 点文件（.gitignore 等）：lastIndexOf('.') 取到点后缀 → gitignore
  const gitExts = new Set(['gitignore','gitattributes','gitmodules','gitkeep']);
  // 文件类型图标色 = 分类色板（指南 R1 例外：每类一色，语义 ≠ 分类）。
  // 这些色值是图标身份色（不随主题切换、不进语义令牌族），随图标族整体
  // 保留；新增/调整色相属图标族设计变更，不属 hex 清零范围。
  if (codeExts.has(ext)) return { icon: 'code', color: '#4a90d9' };
  if (termExts.has(ext)) return { icon: 'terminal', color: '#2ea44f' };
  if (imgExts.has(ext)) return { icon: 'image', color: '#a855f7' };
  if (archiveExts.has(ext)) return { icon: 'file-archive', color: '#d97706' };
  if (ext === 'json' || ext === 'json5') return { icon: 'file-json', color: '#e6a817' };
  if (mdExts.has(ext)) return { icon: 'book-open', color: '#0ea5e9' };
  if (ext === 'pdf') return { icon: 'file-text', color: '#dc2626' };
  if (sheetExts.has(ext)) return { icon: 'file-spreadsheet', color: '#16a34a' };
  if (slideExts.has(ext)) return { icon: 'presentation', color: '#ea580c' };
  if (docExts.has(ext)) return { icon: 'file-text', color: '#2563eb' };
  if (audioExts.has(ext)) return { icon: 'file-audio', color: '#d946ef' };
  if (videoExts.has(ext)) return { icon: 'film', color: '#f43f5e' };
  if (fontExts.has(ext)) return { icon: 'type', color: '#14b8a6' };
  if (dbExts.has(ext)) return { icon: 'database', color: '#ca8a04' };
  if (configExts.has(ext)) return { icon: 'file-cog', color: '#64748b' };
  if (keyExts.has(ext)) return { icon: 'file-lock', color: '#ef4444' };
  if (binExts.has(ext)) return { icon: 'binary', color: '#6b7280' };
  if (gitExts.has(ext)) return { icon: 'git-branch', color: '#f05033' };
  const textExts = new Set(['txt','log','xml']);
  if (textExts.has(ext)) return { icon: 'file-text', color: '' };
  return { icon: 'file', color: '' };
}

const fileIcon = computed(() => getFileIcon(props.node.name));
</script>

<template>
  <div class="wtn-node">
    <div v-if="node.type === 'dir'" class="wtn-row wtn-dir" @click="onToggle">
      <span class="wtn-icon"><Icon :name="isOpen ? 'folder-open' : 'folder'" :size="14" /></span>
      <span class="wtn-name">{{ node.name }}</span>
    </div>
    <div
      v-else-if="node.type === 'file'"
      class="wtn-row wtn-file"
      :class="{ active: activePath === full }"
      @click="emit('file-click', node, parentPath)"
      :title="full"
    >
      <span class="wtn-icon" :style="fileIcon.color ? { color: fileIcon.color } : undefined"><Icon :name="fileIcon.icon" :size="14" /></span>
      <span class="wtn-name">{{ node.name }}</span>
    </div>
    <div v-else class="wtn-row wtn-more"><span class="wtn-name">{{ node.name }}</span></div>

    <div v-if="node.type === 'dir' && isOpen" class="wtn-children">
      <WorkspaceTreeNode
        v-for="child in node.children"
        :key="child.name"
        :node="child"
        :parent-path="full"
        :active-path="activePath"
        :expanded-paths="expandedPaths"
        @toggle="(...args: any[]) => emit('toggle', ...(args as [TreeNode, string, boolean]))"
        @file-click="(...args: any[]) => emit('file-click', ...(args as [TreeNode, string]))"
      />
      <div v-if="!node.children || node.children.length === 0" class="wtn-empty">（空目录）</div>
    </div>
  </div>
</template>

<style scoped>
.wtn-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px; border-radius: var(--radius-sm); cursor: pointer;
  white-space: nowrap; overflow: hidden; min-width: 0;
}
.wtn-row:hover { background: var(--bg-surface); }
.wtn-row.active { background: var(--primary-light); }
.wtn-dir { color: var(--text-1); font-weight: 500; }
.wtn-file { color: var(--text-2); }
.wtn-icon { flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 16px; }
.wtn-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.wtn-children { margin-left: 12px; border-left: 1px solid var(--line); padding-left: 4px; }
.wtn-more { color: var(--text-3); font-style: italic; cursor: default; }
.wtn-empty { padding: 4px 10px; color: var(--text-3); font-size: 12px; }
</style>
