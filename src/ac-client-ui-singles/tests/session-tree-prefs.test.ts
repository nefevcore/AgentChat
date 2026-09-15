// ============================================================
// ac-client-ui-singles/tests/session-tree-prefs.test.ts ——
// 主侧边栏会话列表工作区分组折叠态持久化单测
//
// 场景：用户在 single 页会话列表折叠的工作区分组（「默认展开、
// 记住折叠」语义）记入 localStorage 单键 agentchat.sessionTreePrefs；
// 刷新/重挂载后回放。此前 collapsed 只是组件内 ref（注释写着
// 「记住用户折叠状态」但从未兑现——切视图/刷新即丢）。
//
// 手法（compose-prefs / workspace-tree-prefs 同款）：node 环境无
// localStorage → 内存桩先于被测模块注入（模块 import 时捕获
// globalThis.localStorage）。
// ============================================================
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// ---- 内存桩（先于被测模块 import——模块顶捕获 globalThis.localStorage） ----
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
};

const { loadCollapsed, saveCollapsed } = await import('../client/sessionTreePrefs.ts');

beforeEach(() => {
  mem.clear();
});

describe('sessionTreePrefs：折叠态读写与降级', () => {
  it('空态：无记录 → 空 Set', () => {
    expect(loadCollapsed().size).toBe(0);
  });

  it('写读往返：save 后 load 回放同集合', () => {
    saveCollapsed(['ws-a', '__ungrouped__', 'ws-b']);
    const loaded = loadCollapsed();
    expect([...loaded].sort()).toEqual(['__ungrouped__', 'ws-a', 'ws-b']);
  });

  it('全量替换：第二次 save 覆盖第一次（收起再展开 = 移出集合）', () => {
    saveCollapsed(['ws-a', 'ws-b']);
    saveCollapsed(['ws-b']); // ws-a 被重新展开
    expect([...loadCollapsed()]).toEqual(['ws-b']);
  });

  it('损坏降级：非数组 JSON → 空态（行为同无记录）', () => {
    mem.set('agentchat.sessionTreePrefs', '{"oops":true}');
    expect(loadCollapsed().size).toBe(0);
  });

  it('损坏降级：数组内非 string 项剔除', () => {
    mem.set('agentchat.sessionTreePrefs', '["ok", 123, null, {"x":1}]');
    expect([...loadCollapsed()]).toEqual(['ok']);
  });

  it('护栏：超 200 条截断（防异常膨胀写爆 quota）', () => {
    const many = Array.from({ length: 300 }, (_, i) => `ws-${i}`);
    saveCollapsed(many);
    expect(loadCollapsed().size).toBe(200);
  });

  it('幽灵 key 无害：已删工作区 key 读取不报错（渲染层不再命中）', () => {
    saveCollapsed(['ghost-ws']);
    expect(loadCollapsed().has('ghost-ws')).toBe(true); // 在集合但不渲染——无害
  });
});
