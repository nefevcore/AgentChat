// ============================================================
// client/workspaceTreeIcons.ts —— 工作区树原生图标前端半边（cr-833）
//
// 纯函数模块（零组件依赖）：ext 提取 / 树快照扩展名收集（增量差分用）；
// 数据面（extIcons 状态 + RPC 往返）住 workspaceTreeStore——组件经 store 消费。
// 行为面由单测锁定。
// ============================================================

import type { TreeNode } from './workspaceTreeStore.ts';

/** 文件名 → 扩展名（小写；无扩展名 = null——dotfile 归 null：.gitignore 的
 *  lastIndexOf('.') 取到 'gitignore' 但语义是整名点文件，树节点归静态表） */
export function extOf(name: string): string | null {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

/**
 * 树快照 → 扩展名集合（当前已加载层——根层 + 已展开层；file 节点全收）。
 * store 增量拉取的差分源：与已请求集合做差得新增 ext。
 */
export function collectFileExts(root: readonly TreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'file') {
        const ext = extOf(n.name);
        if (ext !== null) out.add(ext);
      } else if (n.type === 'dir' && n.children) walk(n.children);
    }
  };
  walk(root);
  return out;
}