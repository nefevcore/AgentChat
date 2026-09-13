// ============================================================
// client/workspaceTreeStore.ts —— 工作区树域状态（M33 前端反馈）
//
// pinia store（id 'workspaceTree'——workspace 域自有）：
//   · 树数据 + 展开态 + 滚动位置：住 store 而非组件本地——aux 选区
//     volatile（区域收起/切换选区即卸载组件），树体在 store 里保活，
//     重开面板恢复原位（反馈 #2：预览跳转后回工作区保持位置）。
//   · 会话上下文定位（反馈 #1）：树基准 = 当前活跃会话上下文
//     （single > agent pair > group > 全局数据根），随上下文切换重定位；
//     per-context 记忆（树数据/展开态各自独立，切回即恢复）。
//
// 树节点 shape（TreeNode）单源住本 store（组件树消费）。
// 本 store 是数据的唯一事实源，组件只渲染 + 写回交互态。
// ============================================================
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { fetchWorkspaceTree } from './index.ts';

/** 树节点（含懒加载运行时态；WorkspaceTreeNode/WorkspaceTree 消费——
 *  本 store 是 shape 单源，避免 .ts 链反向引 .vue）。文件大小不入树
 *  （前端反馈：意义不大）；预览头部尺寸由读面自带。 */
export interface TreeNode {
  name: string;
  type: 'dir' | 'file' | 'more';
  children?: TreeNode[];
}

/** 单个树基准的完整状态（数据 + 展开态 + 滚动位置） */
interface TreeContextState {
  /** 根子节点（懒加载首层） */
  root: TreeNode[];
  /** 展开的目录路径集合（相对树基准） */
  expanded: Set<string>;
  /** 树体滚动位置（px；面板卸载前快照） */
  scrollTop: number;
  /** 基准标签（服务端 root.label；空 = 前端回落「工作区」） */
  label: string;
  /** 数据加载态 */
  loading: boolean;
  error: string;
  /** 已激活文件（相对树基准路径） */
  activePath: string;
}

function freshState(): TreeContextState {
  return { root: [], expanded: new Set(), scrollTop: 0, label: '', loading: false, error: '', activePath: '' };
}

/** per-path in-flight 守卫（双击同一目录不重复请求） */
const pendingDirs = new Set<string>();

export const useWorkspaceTreeStore = defineStore('workspaceTree', () => {
  /** 各树基准状态（key = `${agentId}/${conversationId}` 归一形；'' = 全局） */
  const trees = ref<Record<string, TreeContextState>>({});
  /** 当前树基准 key（由 WorkspaceTree 宿主组件按活跃会话写入） */
  const currentKey = ref('');

  const current = computed<TreeContextState>(() => trees.value[currentKey.value] ?? freshState());

  /** 基准 key 归一（会话优先，agent 兜底；两者皆空 = '' 全局） */
  function contextKey(agentId: string, conversationId: string): string {
    return conversationId ? `c:${conversationId}` : agentId ? `a:${agentId}` : '';
  }

  /** 切换/设定当前树基准（同 key 且已有状态 = 幂等；key 不在册则建空态并加载根层） */
  async function setContext(agentId: string, conversationId: string): Promise<void> {
    const key = contextKey(agentId, conversationId);
    // 幂等判据 = key 相同且状态已在册（初态 currentKey='' 与目标 '' 相同
    // 但无状态——不能早退，否则根层永不加载）
    if (currentKey.value === key && trees.value[key]) return;
    currentKey.value = key;
    if (!trees.value[key]) {
      trees.value[key] = freshState();
      await loadDir(key, '', true);
    }
  }

  /** 加载目录子项（isRoot=true 写回根层 + 驱动全局 loading/error——
   *  子目录懒加载行内占位不动整树；返回值供 expandDir 挂树） */
  async function loadDir(key: string, dirPath: string, isRoot = false): Promise<TreeNode[]> {
    const st = trees.value[key] ?? (trees.value[key] = freshState());
    if (isRoot) {
      st.loading = true;
      st.error = '';
    }
    try {
      const q = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
      const ctx = key.startsWith('c:')
        ? { conversationId: key.slice(2) }
        : key.startsWith('a:')
          ? { agentId: key.slice(2) }
          : undefined;
      const d = await fetchWorkspaceTree(q, ctx);
      const children = d.children ?? [];
      if (isRoot) {
        st.root = children; // 根层写回（setContext 不接返回值——数据落 store）
        st.label = d.root?.label ?? '';
      }
      return children;
    } catch (err: any) {
      if (isRoot) {
        st.error = err.message || String(err);
        st.root = [];
      }
      // 子目录失败：以行内占位呈现（不动整树）
      return [{ name: `加载失败：${err.message || String(err)}`, type: 'more' }];
    } finally {
      if (isRoot) st.loading = false;
    }
  }

  /** 懒加载子目录并挂到父节点（findNode 自根下钻） */
  async function expandDir(key: string, dirPath: string): Promise<void> {
    const st = trees.value[key];
    if (!st) return;
    st.expanded.add(dirPath);
    const node = dirPath ? findNode(st.root, dirPath) : null;
    // 子层请求：节点未带 children 才发（per-path in-flight 守卫）
    if (node && node.type === 'dir' && !node.children) {
      if (pendingDirs.has(dirPath)) return;
      pendingDirs.add(dirPath);
      try {
        node.children = await loadDir(key, dirPath);
      } finally {
        pendingDirs.delete(dirPath);
      }
    }
  }

  function collapseDir(key: string, dirPath: string): void {
    trees.value[key]?.expanded.delete(dirPath);
  }

  /** 树内按路径找节点（'a/b/c' 下钻；'' = 不找——根层无节点壳） */
  function findNode(root: TreeNode[], dirPath: string): TreeNode | null {
    if (!dirPath) return null;
    let nodes = root;
    let found: TreeNode | null = null;
    for (const seg of dirPath.split('/')) {
      found = nodes.find((n) => n.name === seg && n.type === 'dir') ?? null;
      if (!found) return null;
      nodes = found.children ?? [];
    }
    return found;
  }

  /** 节点点击展开/收起（组件回调统一入口） */
  async function toggleDir(key: string, dirPath: string, isOpen: boolean): Promise<void> {
    if (isOpen) await expandDir(key, dirPath);
    else collapseDir(key, dirPath);
  }

  /** 记录滚动位置（面板卸载/滚动停点快照） */
  function saveScroll(key: string, scrollTop: number): void {
    const st = trees.value[key];
    if (st) st.scrollTop = scrollTop;
  }

  /** 记录激活文件 */
  function setActive(key: string, path: string): void {
    const st = trees.value[key];
    if (st) st.activePath = path;
  }

  return {
    trees, currentKey, current,
    contextKey, setContext, loadDir, expandDir, collapseDir, toggleDir, saveScroll, setActive, findNode,
  };
});
