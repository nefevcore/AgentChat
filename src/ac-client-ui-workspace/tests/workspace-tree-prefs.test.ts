// ============================================================
// ac-client-ui-workspace/tests/workspace-tree-prefs.test.ts ——
// 工作区树展开态跨刷新持久化单测
//
// 场景：用户在工作区树手动展开的目录层级（per 树基准）记入
// localStorage 单键 agentchat.workspaceTreePrefs；刷新后基准首触
// 读回并按深度序逐层懒加载重铺——不再全部回到收起态。
//
// 手法（compose-prefs 同款）：node 环境无 localStorage → 内存桩先于
// 被测模块注入（模块 import 时捕获 globalThis.localStorage）；
// fetchWorkspaceTree 经 vi.mock 换内存 fixture（store 数据面解耦，
// 不触 REST/插件链）。
// ============================================================
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// ---- 数据面 mock（vi.mock 提升到模块顶——工厂惰性求值，fixture 常量
//      在测试体内消费时已初始化） ----
const treeCalls: Array<{ path: string }> = [];
const FIXTURE: Record<string, Array<{ name: string; type: string }>> = {
  '': [{ name: 'a', type: 'dir' }, { name: 'd2', type: 'dir' }],
  a: [{ name: 'b', type: 'dir' }, { name: 'f.txt', type: 'file' }],
  'a/b': [{ name: 'c', type: 'dir' }],
  'a/b/c': [],
  d2: [{ name: 'x.md', type: 'file' }],
};
vi.mock('../client/index.ts', () => ({
  fetchWorkspaceTree: async (query: string) => {
    const path = query ? decodeURIComponent(query.replace('?path=', '')) : '';
    treeCalls.push({ path });
    const children = FIXTURE[path];
    if (!children) throw new Error(`no fixture for ${path}`);
    // 克隆返回：store 会把返回的节点对象挂树（node.children = ...），
    // 共享引用会把 children 写回 fixture——跨测试污染根层
    return { children: structuredClone(children), root: { label: '测试基准' } };
  },
}));

/** 内存 localStorage 桩（Map 语义） */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

let storage: MemoryStorage;
let prefs: typeof import('../client/workspaceTreePrefs.ts');
let storeMod: typeof import('../client/workspaceTreeStore.ts');

beforeAll(async () => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  prefs = await import('../client/workspaceTreePrefs.ts');
  storeMod = await import('../client/workspaceTreeStore.ts');
});

beforeEach(() => {
  storage.clear();
  treeCalls.length = 0;
  setActivePinia(createPinia());
});

describe('workspaceTreePrefs：持久化读写面', () => {
  it('无记录 → loadExpanded 空 Set', () => {
    expect(prefs.loadExpanded('c:s1').size).toBe(0);
  });

  it('save + flush → 同键带回；空集合键剔除', () => {
    prefs.saveExpanded('c:s1', ['a', 'a/b']);
    prefs.flushExpanded();
    expect(prefs.loadExpanded('c:s1')).toEqual(new Set(['a', 'a/b']));
    // 收起到空 → 键整体退册（不残留空条目）
    prefs.saveExpanded('c:s1', []);
    prefs.flushExpanded();
    expect(prefs.loadExpanded('c:s1').size).toBe(0);
    // 相邻键不受影响
    prefs.saveExpanded('a:ag1', ['x']);
    prefs.flushExpanded();
    expect(prefs.loadExpanded('c:s1').size).toBe(0);
    expect(prefs.loadExpanded('a:ag1')).toEqual(new Set(['x']));
  });

  it('损坏 JSON / 非 string 项 → 静默降级（空/剔除）', () => {
    storage.setItem('agentchat.workspaceTreePrefs', '{broken');
    expect(prefs.loadExpanded('c:s1').size).toBe(0);
    storage.setItem('agentchat.workspaceTreePrefs', JSON.stringify({
      contexts: { 'c:s1': ['ok', 42, null, { deep: true }, 'ok2'] },
    }));
    expect(prefs.loadExpanded('c:s1')).toEqual(new Set(['ok', 'ok2']));
  });

  it('基准条目护栏（50）：超限裁最旧、留最新', () => {
    for (let i = 0; i < 55; i++) {
      prefs.saveExpanded(`c:s${i}`, [`d${i}`]);
      prefs.flushExpanded(); // 逐条落盘（写序即旧序）
    }
    expect(prefs.loadExpanded('c:s0').size).toBe(0); // 最旧被裁
    expect(prefs.loadExpanded('c:s54')).toEqual(new Set(['d54'])); // 最新保留
  });
});

describe('workspaceTreeStore：展开态持久化与刷新恢复', () => {
  it('展开/收起 → 写回 prefs；收起后新 store 实例（刷新模拟）不回放已收起目录', async () => {
    const store = storeMod.useWorkspaceTreeStore();
    await store.setContext('', 's1'); // 根层加载
    treeCalls.length = 0;
    await store.expandDir('c:s1', 'a');
    await store.expandDir('c:s1', 'a/b');
    prefs.flushExpanded();
    expect(prefs.loadExpanded('c:s1')).toEqual(new Set(['a', 'a/b']));

    // 收起 a（连带子层退出展开集合由用户自理——只收本层）
    store.collapseDir('c:s1', 'a');
    prefs.flushExpanded();
    expect(prefs.loadExpanded('c:s1')).toEqual(new Set(['a/b'])); // b 残留（收父不自动收子——既有语义）

    // 模拟刷新：新 pinia 实例 + 重挂载（localStorage 是唯一幸存面）
    setActivePinia(createPinia());
    treeCalls.length = 0;
    const store2 = storeMod.useWorkspaceTreeStore();
    await store2.setContext('', 's1');
    // a/b 是孤儿（父 a 已收起出册）——不可寻即跳过（不请求）；记录里
    // 只剩根层请求。UI 层面：a 已收起，b 本就不可见——语义自洽
    expect(treeCalls.map((c) => c.path)).toEqual(['']);
    expect(store2.trees['c:s1']!.expanded).toEqual(new Set(['a/b']));
  });

  it('刷新恢复：多层展开按深度序逐层懒加载重铺（父先子后）', async () => {
    // 预置持久层（模拟上一会话展开到三层）
    prefs.saveExpanded('c:s1', ['a/b/c', 'a', 'a/b']); // 乱序入册
    prefs.flushExpanded();

    const store = storeMod.useWorkspaceTreeStore();
    await store.setContext('', 's1');
    // 深度序：根 → a → a/b → a/b/c（父先子后，findNode 才逐级可寻）
    expect(treeCalls.map((c) => c.path)).toEqual(['', 'a', 'a/b', 'a/b/c']);
    const st = store.trees['c:s1']!;
    expect(st.expanded).toEqual(new Set(['a', 'a/b', 'a/b/c']));
    // 子层真实挂树（非仅标记）
    expect(store.findNode(st.root, 'a/b/c')?.children).toEqual([]);
    expect(st.label).toBe('测试基准');
  });

  it('幽灵路径（目录已更名/删除）：静默忽略——不请求、不影响其余恢复', async () => {
    prefs.saveExpanded('c:s1', ['ghost', 'd2']);
    prefs.flushExpanded();

    const store = storeMod.useWorkspaceTreeStore();
    await store.setContext('', 's1');
    // ghost 不命中根层 → 不请求；d2 照常恢复
    expect(treeCalls.map((c) => c.path)).toEqual(['', 'd2']);
    // 展开集合保留幽灵路径（渲染层无害——不再出现即不可见）
    expect(store.trees['c:s1']!.expanded.has('ghost')).toBe(true);
  });

  it('per-context 隔离：收起 a:ag1 不影响 c:s1 的展开记录', async () => {
    prefs.saveExpanded('c:s1', ['a']);
    prefs.saveExpanded('a:ag1', ['d2']);
    prefs.flushExpanded();

    const store = storeMod.useWorkspaceTreeStore();
    await store.setContext('ag1', ''); // agent 基准（无会话）
    store.collapseDir('a:ag1', 'd2');
    prefs.flushExpanded();
    expect(prefs.loadExpanded('a:ag1').size).toBe(0);
    expect(prefs.loadExpanded('c:s1')).toEqual(new Set(['a']));
  });
});
