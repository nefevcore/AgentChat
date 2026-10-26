// ============================================================
// ac-client-slots/tests/slot-core-s15.test.ts —— S1.5 增强级单测
//
// 验收门五项中的纯核面（复核 §3.2）：
//   2. cell + priority 选举（single shadow + D16 fallback 衔接）
//   3. store 座位实例轴（SlotStoreAxis）
//   5. abdicate 退位（onEntryError 监督在运行时层测试）
// + 「朴素贡献在 cell 选举下语义锁定」（两代语义断层风险锁定，m27 §5）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  SlotCore,
  SlotStoreAxis,
  DEFAULT_CELL,
  type SlotEntry,
} from '../src/index.ts';

const C = { render: () => 'x' };

function entry(id: string, extra: Partial<SlotEntry> = {}): SlotEntry {
  return { id, component: C, ...extra };
}

describe('S1.5 · cell + priority 选举（single shadow）', () => {
  it('无 cell/priority（朴素贡献）：选举 = 最低 order（两代语义锁定——S0 行为不变）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:single', kind: 'single' });
    core.register('demo:single', entry('late', { order: 300 }));
    core.register('demo:single', entry('early', { order: 50 }));
    core.register('demo:single', entry('mid', { order: 100 }));
    expect(core.single('demo:single')?.id).toBe('early');
  });

  it('同 cell：高 priority shadow 低者（order 不再决定 single 赢家）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:single', kind: 'single' });
    core.register('demo:single', entry('base', { order: 0 }));
    core.register('demo:single', entry('override', { order: 999, priority: 10 }));
    expect(core.single('demo:single')?.id).toBe('override');
  });

  it('多 cell：各 cell 优胜者同轴竞标（priority → order → 注册序）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:single', kind: 'single' });
    // cell A：内部有高低
    core.register('demo:single', entry('a-low', { cell: 'themeA', priority: 1 }));
    core.register('demo:single', entry('a-high', { cell: 'themeA', priority: 5 }));
    // cell B：整体更高
    const offB = core.register('demo:single', entry('b-best', { cell: 'themeB', priority: 7 }));
    expect(core.single('demo:single')?.id).toBe('b-best');
    // B 更高者加入 → 接任；撤销 → B 优胜者回归；B 清空 → A 的优胜者接任
    const offB2 = core.register('demo:single', entry('b-best2', { cell: 'themeB', priority: 9 }));
    expect(core.single('demo:single')?.id).toBe('b-best2');
    offB2();
    expect(core.single('demo:single')?.id).toBe('b-best');
    offB();
    expect(core.single('demo:single')?.id).toBe('a-high');
  });

  it('factory 席位：出厂层恒高于动态层（D3「动态注册者恒低优」——S1.5 起替代封印拒绝）', () => {
    const core = new SlotCore();
    core.declare({ key: 'root', kind: 'single', factory: true });
    core.register('root', entry('layout', { order: 0 })); // 出厂（tier 0）
    core.sealFactory();
    core.register('root', entry('dynamic-high', { order: 0, priority: 999 })); // 动态（tier 1）
    // 出厂占据者恒胜——即便动态条目 priority/order 更优
    expect(core.single('root')?.id).toBe('layout');
  });

  it('chain：priority 降序逐条消费序（高优先 = 外层先消费）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:chain', kind: 'chain' });
    core.register('demo:chain', entry('inner', { order: 0 }));
    core.register('demo:chain', entry('outer', { order: 999, priority: 10 }));
    expect(core.entries('demo:chain').map((e) => e.id)).toEqual(['outer', 'inner']);
  });

  it('list：order 轴不变（priority 不影响 list 排序）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:list' });
    core.register('demo:list', entry('high-prio-late-order', { order: 500, priority: 99 }));
    core.register('demo:list', entry('low-order', { order: 1 }));
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['low-order', 'high-prio-late-order']);
  });
});

describe('S1.5 · abdicate 退位', () => {
  it('退位条目从选举/列表消失；同 id 重注册复位', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:single', kind: 'single' });
    core.register('demo:single', entry('winner', { order: 0 }));
    core.register('demo:single', entry('runner', { order: 10 }));
    expect(core.single('demo:single')?.id).toBe('winner');

    expect(core.abdicate('demo:single', 'winner')).toBe(true);
    expect(core.single('demo:single')?.id).toBe('runner'); // 退位 → 下一候选接任
    expect(core.version('demo:single')).toBeGreaterThan(0); // 事件桥失效轴

    // 重复退位 = no-op；未知 id = false
    expect(core.abdicate('demo:single', 'winner')).toBe(false);
    expect(core.abdicate('demo:single', 'ghost')).toBe(false);

    // 同 id 重注册 → 复位接任
    core.register('demo:single', entry('winner', { order: 0 }));
    expect(core.single('demo:single')?.id).toBe('winner');

    // list：退位条目从 entries() 消失
    core.declare({ key: 'demo:list' });
    core.register('demo:list', entry('a'));
    core.abdicate('demo:list', 'a');
    expect(core.entries('demo:list')).toEqual([]);
  });
});

describe('S1.5 · SlotStoreAxis（store 座位实例轴）', () => {
  const handle = (entryId: string, scopeKey = 'root') => ({ slotKey: 'demo:seat', entryId, scopeKey });

  it('同 handle 引用计数共享实例；归零 dispose + 摘除（持久化态随清）', () => {
    const axis = new SlotStoreAxis();
    const dispositions: string[] = [];
    const factory = (h: { entryId: string }) => ({
      id: h.entryId,
      dispose: () => dispositions.push(h.entryId),
    });

    const s1 = axis.acquire(handle('a'), factory);
    const s2 = axis.acquire(handle('a'), factory);
    expect(s1.value).toBe(s2.value); // 同实例
    expect(axis.snapshot()['demo:seat\u0000a\u0000root']).toBe(2);

    s1.release();
    expect(dispositions).toEqual([]); // 还有一份引用
    s2.release();
    expect(dispositions).toEqual(['a']); // 归零 → dispose
    expect(axis.snapshot()['demo:seat\u0000a\u0000root']).toBeUndefined();
    // release 句柄幂等
    s2.release();
    expect(dispositions).toEqual(['a']);
  });

  it('scope key 分桶：会话死即清（dropScope）只清匹配会话', () => {
    const axis = new SlotStoreAxis();
    const dispositions: string[] = [];
    const factory = (h: { scopeKey: string }) => ({ scope: h.scopeKey, dispose: () => dispositions.push(h.scopeKey) });
    axis.acquire(handle('a', 'conv-1'), factory);
    axis.acquire(handle('b', 'conv-1'), factory);
    axis.acquire(handle('a', 'conv-2'), factory);
    axis.acquire(handle('c', 'root'), factory);

    expect(axis.dropScope('conv-1')).toBe(2);
    expect(dispositions.sort()).toEqual(['conv-1', 'conv-1']);
    expect(axis.peek(handle('a', 'conv-2'))).toBeDefined();
    expect(axis.peek(handle('c', 'root'))).toBeDefined();
    // 谓词形态：清全部非 root（此刻仅剩 conv-2 一例——conv-1 已清）
    expect(axis.dropScope((k) => k !== 'root')).toBe(1);
    expect(axis.peek(handle('c', 'root'))).toBeDefined();
  });

  it('无 dispose 的工厂：归零直接摘除不报错；DEFAULT_CELL 常量在位', () => {
    const axis = new SlotStoreAxis();
    const seat = axis.acquire(handle('plain'), () => ({ v: 1 }));
    seat.release();
    expect(axis.peek(handle('plain'))).toBeUndefined();
    expect(DEFAULT_CELL).toBe('base');
  });
});
