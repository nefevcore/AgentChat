// ============================================================
// ac-client-ui-workspace/tests/workspace-tree-icons.test.ts —— 树图标纯函数（cr-833）
// ============================================================
import { describe, it, expect } from 'vitest';
import { extOf, collectFileExts } from '../client/workspaceTreeIcons.ts';
import type { TreeNode } from '../client/workspaceTreeStore.ts';

describe('extOf（文件名 → 扩展名）', () => {
  it('常规文件取点后小写', () => {
    expect(extOf('readme.md')).toBe('md');
    expect(extOf('App.TS')).toBe('ts');
    expect(extOf('a.b.c.png')).toBe('png');
  });
  it('无扩展名/点文件/尾点 = null', () => {
    expect(extOf('Makefile')).toBeNull();
    expect(extOf('.gitignore')).toBeNull();
    expect(extOf('file.')).toBeNull();
  });
});

describe('collectFileExts（树快照 → 扩展名集合）', () => {
  it('递归收集已加载层的 file 节点 ext；dir 无 children 不下钻', () => {
    const tree: TreeNode[] = [
      { name: 'src', type: 'dir', children: [
        { name: 'a.ts', type: 'file' },
        { name: 'B.MD', type: 'file' },
        { name: 'nested', type: 'dir', children: [{ name: 'c.vue', type: 'file' }] },
      ] },
      { name: 'pkg.json', type: 'file' },
      { name: 'empty-dir', type: 'dir' },
      { name: '加载失败：x', type: 'more' },
    ];
    expect(collectFileExts(tree)).toEqual(new Set(['ts', 'md', 'vue', 'json']));
  });
});