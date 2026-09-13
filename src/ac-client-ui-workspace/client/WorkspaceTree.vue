<!-- WorkspaceTree.vue —— 工作区目录树面板（懒加载 + 点击预览；M28 P1 自 layout 随域迁入 workspace）
  M33 前端反馈：树数据/展开态/滚动位置住 workspaceTreeStore（pinia）——
  aux 选区 volatile（区域收起/切换即卸载组件），store 保活重开恢复原位；
  树基准随活跃会话上下文定位（single 会话 > agent pair > group > 数据根）。 -->
<script setup lang="ts">
import { computed, ref, watch, onMounted, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useClientContext } from 'ac-client-runtime';
import WorkspaceTreeNode from './WorkspaceTreeNode.vue';
import { useWorkspaceTreeStore, type TreeNode } from './workspaceTreeStore.ts';

const emit = defineEmits<{
  (e: 'previewFile', filePath: string, agentId: string, conversationId: string): void;
  (e: 'close'): void;
}>();

const ctx = useClientContext();
const store = useWorkspaceTreeStore();

// ── 树基准定位：活跃会话上下文（single > agent pair > group > 全局）──
// 与 runview 主区让位 watch 同款探测姿势（root runtime 可选探测——本件
// fiber 未 inject roster/singleBoard，自身 ctx 属性访问会抛）。
const contextAgentId = computed(() => ctx?.roster?.core.activeAgentId.value ?? '');
const contextConversationId = computed(() => ctx?.get('singleBoard')?.activeSingleId.value ?? '');

// 首次挂载即定位当前基准（无活跃上下文 = 全局数据根树）
onMounted(() => {
  void store.setContext(contextAgentId.value, contextConversationId.value);
});

// 上下文切换 → 重定位树基准（per-context 记忆：切回即恢复展开/滚动）
watch([contextAgentId, contextConversationId], ([agentId, conversationId]) => {
  void store.setContext(agentId, conversationId);
});

const treeKey = computed(() => store.currentKey);
const { current: st } = storeToRefs(store);
const rootNodes = computed<TreeNode[]>(() => st.value.root);
const rootLabel = computed(() => st.value.label || '工作区');

// ── 滚动位置保持（反馈 #2）：树体滚动容器 ──
const bodyRef = ref<HTMLElement | null>(null);
let restoring = false;

// 挂载后恢复上次滚动位置（面板重开时——nextTick 等树体渲染完）
onMounted(async () => {
  await nextTick();
  if (bodyRef.value && st.value.scrollTop > 0) {
    restoring = true;
    bodyRef.value.scrollTop = st.value.scrollTop;
    // 恢复完成的标记延一帧清除（避免 scroll 事件回写同值）
    requestAnimationFrame(() => { restoring = false; });
  }
});

function onScroll() {
  if (restoring || !bodyRef.value) return;
  store.saveScroll(treeKey.value, bodyRef.value.scrollTop);
}

/** 展开/收起切换（isOpen = 目标态；懒加载/守卫在 store 内） */
function onToggle(node: TreeNode, parentPath: string, isOpen: boolean) {
  if (node.type !== 'dir') return;
  void store.toggleDir(treeKey.value, parentPath ? `${parentPath}/${node.name}` : node.name, isOpen);
}

function onFileClick(node: TreeNode, parentPath: string) {
  const full = parentPath ? `${parentPath}/${node.name}` : node.name;
  store.setActive(treeKey.value, full);
  // 树基准上下文随行（树随会话定位后，点击路径相对基准——预览读面
  // 同基准推导：数据根树仍可 files/<id>/ 前缀直通）
  const agentId = treeKey.value.startsWith('a:') ? treeKey.value.slice(2) : '';
  const conversationId = treeKey.value.startsWith('c:') ? treeKey.value.slice(2) : '';
  emit('previewFile', full, agentId, conversationId);
}
</script>

<template>
  <div class="workspace-tree">
    <div class="wt-header">
      <span class="wt-title" :title="rootLabel">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>
        </svg>
        {{ rootLabel }}
      </span>
      <button class="wt-close" @click="emit('close')" title="关闭">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div v-if="st.loading" class="wt-loading">加载中…</div>
    <div v-else-if="st.error" class="wt-error">{{ st.error }}</div>
    <div v-else class="wt-body" ref="bodyRef" @scroll.passive="onScroll">
      <WorkspaceTreeNode
        v-for="node in rootNodes"
        :key="node.name"
        :node="node"
        :parent-path="''"
        :active-path="st.activePath"
        :expanded-paths="st.expanded"
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
  /* 左缘分界线退役：分界统一由布局骨架 ResizeHandle 细线担当（重叠曾呈双线） */
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
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wt-title svg { color: var(--color-text-secondary, #7f8c8d); flex-shrink: 0; }
.wt-close {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border: none; background: none; cursor: pointer;
  color: var(--color-text-secondary); border-radius: 6px;
  flex-shrink: 0;
}
.wt-close:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.wt-body { flex: 1; overflow-y: auto; padding: 8px 6px; }

/* 小屏：工作区从右侧覆盖（v-if 控制渲染，无需位移动画） */
@media(max-width:768px){
  .workspace-tree{
    position:fixed; top:0; right:0; bottom:0; z-index:130;
    box-shadow:-2px 0 16px rgba(0,0,0,.15);
    /* 覆盖态保留左缘线（无 ResizeHandle 在场——独立覆盖层需要自描边） */
    border-left:1px solid var(--color-border-secondary,#e0e0e0);
  }
}
.wt-loading, .wt-error { padding: 16px; color: var(--color-text-secondary); font-size: 13px; }
.wt-error { color: var(--color-error); }
</style>
