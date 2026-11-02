// ============================================================
// ac-client-ui-conversation/tests/draft-parking.test.ts ——
// 输入草稿暂存 + localStorage 留存（cr-847）单测
//
// 场景：park/take 会话级草稿位（切换恢复原语义不变）+ 留存层
// （刷新 = 模块重载后 restoreDrafts 恢复）+ 上限淘汰两层同步。
// node 环境无 localStorage——内存桩先于模块注入（动态 import）。
// ============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

let storage: MemoryStorage;
let mod: typeof import('../client/draftParking.ts');

beforeAll(async () => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  mod = await import('../client/draftParking.ts');
});

beforeEach(() => {
  storage.clear();
  mod.__clearParkedForTest(); // 内存层与留存层同步归零（用例间隔离）
});

describe('draftParking：暂存位 + 留存层（cr-847）', () => {
  it('park/take 基础语义不变：空 = 清位；不消费可重复取', () => {
    storage.clear();
    mod.parkDraft('single:s1', 'hello');
    expect(mod.takeDraft('single:s1')).toBe('hello');
    expect(mod.takeDraft('single:s1')).toBe('hello'); // 不消费
    expect(mod.takeDraft('single:s2')).toBe('');
    mod.parkDraft('single:s1', '');
    expect(mod.takeDraft('single:s1')).toBe('');
  });

  it('留存层：park 即写 localStorage；模块重载 + restoreDrafts 后草稿仍在（= 刷新）', async () => {
    storage.clear();
    mod.parkDraft('single:s1', '正在写的第一句');
    mod.parkDraft('pair:user~alpha', '1v1 的半截');
    expect(storage.getItem('agentchat.drafts')).toBeTruthy();
    // 模块重载模拟刷新（模块级 Map 归零，留存层还在）
    const vibi = await import('../client/draftParking.ts?fresh=' + Date.now());
    expect(vibi.takeDraft('single:s1')).toBe('');
    vibi.restoreDrafts();
    expect(vibi.takeDraft('single:s1')).toBe('正在写的第一句');
    expect(vibi.takeDraft('pair:user~alpha')).toBe('1v1 的半截');
  });

  it('清位同步清留存（发送后刷新不复活）；损坏留存整份丢弃', async () => {
    storage.clear();
    mod.parkDraft('single:s1', 'x');
    mod.parkDraft('single:s1', ''); // 清位
    expect(JSON.parse(storage.getItem('agentchat.drafts')!).length).toBe(0);
    // 损坏
    storage.setItem('agentchat.drafts', '{broken');
    const vibi = await import('../client/draftParking.ts?fresh2=' + Date.now());
    vibi.restoreDrafts();
    expect(vibi.takeDraft('single:s1')).toBe('');
  });

  it('上限淘汰：超 100 条删最旧，留存层同步收敛', () => {
    storage.clear();
    for (let i = 0; i < 102; i++) mod.parkDraft('k' + i, 'v' + i);
    const persisted = JSON.parse(storage.getItem('agentchat.drafts')!) as Array<[string, string]>;
    expect(persisted.length).toBe(100);
    expect(persisted.find(([k]) => k === 'k0')).toBeUndefined(); // 最旧被淘汰
    expect(persisted.find(([k]) => k === 'k101')).toBeTruthy(); // 最新在
  });
});
