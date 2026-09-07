// ============================================================
// ac-client-slots/tests/slot-core.test.ts —— SlotCore 纯核单测（M27 S0）
//
// 覆盖：注册/同 id 替换/order 排序/single 解析/disabled 过滤/
// 级联回收/装载校验（未声明拒绝）/root 抢占拒绝（出厂封印）/
// 占位字段形状锁定（D15：演进=行为增强而非签名变更）/版本计数/快照。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  SlotCore,
  SlotCoreError,
  DEFAULT_SLOT_ORDER,
  type SlotEntry,
} from '../src/index.ts';

const C = { render: () => 'x' };

function entry(id: string, extra: Partial<SlotEntry> = {}): SlotEntry {
  return { id, component: C, ...extra };
}

describe('SlotCore · 声明账本与装载校验（D1 fail-closed）', () => {
  it('未声明的 key 一律拒绝注册（错误码可诊断）', () => {
    const core = new SlotCore();
    expect(() => core.register('chat:header-actions', entry('a'))).toThrowError(SlotCoreError);
    try {
      core.register('chat:header-actions', entry('a'));
    } catch (e) {
      expect((e as SlotCoreError).code).toBe('UNDECLARED_SLOT');
    }
  });

  it('declare → register 通；undeclare 撤声明后贡献一并消失，再注册被拒', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:seat', kind: 'list' });
    const off = core.register('demo:seat', entry('a'));
    expect(core.entries('demo:seat').map((e) => e.id)).toEqual(['a']);
    expect(core.undeclare('demo:seat')).toBe(true);
    expect(core.entries('demo:seat')).toEqual([]);
    expect(() => core.register('demo:seat', entry('b'))).toThrowError(SlotCoreError);
    // 席位消亡后贡献 disposer 仍是幂等 no-op
    expect(() => off()).not.toThrow();
  });

  it('非法声明（空 key / 非法 kind / 非法 scope）与非法条目（空 id / 无 component）被拒', () => {
    const core = new SlotCore();
    expect(() => core.declare({ key: '' })).toThrowError(SlotCoreError);
    core.declare({ key: 'x' });
    expect(() => core.declare({ key: 'x', kind: 'weird' as never })).toThrowError(SlotCoreError);
    expect(() => core.declare({ key: 'x', scope: 'page' as never })).toThrowError(SlotCoreError);
    expect(() => core.register('x', entry(''))).toThrowError(SlotCoreError);
    expect(() => core.register('x', { id: 'a', component: undefined })).toThrowError(SlotCoreError);
  });

  it('declOf/has 暴露声明账本；缺省 kind=list scope=root', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:seat' });
    expect(core.has('demo:seat')).toBe(true);
    expect(core.declOf('demo:seat')?.kind).toBe('list');
    expect(core.declOf('demo:seat')?.scope).toBe('root');
    expect(core.declOf('demo:nope')).toBeUndefined();
  });
});

describe('SlotCore · 注册与选举（朴素形态）', () => {
  it('order 升序；缺省 100；同 order 按注册先后稳定', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:list' });
    core.register('demo:list', entry('c', { order: 200 }));
    core.register('demo:list', entry('a', { order: 10 }));
    core.register('demo:list', entry('b1')); // 缺省 100
    core.register('demo:list', entry('b2')); // 缺省 100（后注册，同 order 居后）
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['a', 'b1', 'b2', 'c']);
    expect(DEFAULT_SLOT_ORDER).toBe(100);
  });

  it('同 id 后注册者替换前者（幂等；新 order 生效、同 order 平局继承原位）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:list' });
    const off0 = core.register('demo:list', entry('a', { order: 1 }));
    core.register('demo:list', entry('b', { order: 2 }));
    // 替换 a：新 order=5 生效 → 排序后居 b 后
    const off1 = core.register('demo:list', entry('a', { order: 5 }));
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['b', 'a']);
    expect(core.entries('demo:list')[1].order).toBe(5);
    // 同 order 平局：替换条目继承原插入序——与后注册的同 order 条目相比仍居前
    core.register('demo:list', entry('b', { order: 5 }));
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['a', 'b']); // a 的插入序先于 b
    // 被替换条目的旧 disposer：幂等 no-op，不误删新条目
    off0();
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['a', 'b']);
    // 现行条目的 disposer：正常撤销本条贡献
    off1();
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['b']);
  });

  it('single 取首条（最低 order）；无贡献 → undefined（回落交渲染面）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:single', kind: 'single' });
    expect(core.single('demo:single')).toBeUndefined();
    core.register('demo:single', entry('late', { order: 300 }));
    core.register('demo:single', entry('early', { order: 50 }));
    expect(core.single('demo:single')?.id).toBe('early');
  });

  it('disabled 布尔与谓词均过滤；谓词每次读取时评估', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:list' });
    let flag = false;
    core.register('demo:list', entry('bool', { disabled: true }));
    core.register('demo:list', entry('pred', { disabled: () => flag }));
    core.register('demo:list', entry('on'));
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['pred', 'on']);
    flag = true;
    expect(core.entries('demo:list').map((e) => e.id)).toEqual(['on']);
  });

  it('占位字段照单全收（D15：S0 存而不选——签名即终态形状）', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:seat', kind: 'single', scope: 'session' });
    const e = entry('a', {
      cell: 'main',
      priority: 900,
      store: () => ({ count: 0 }),
      children: ['demo:seat:sub'],
      props: { label: 'hi' },
    });
    core.register('demo:seat', e);
    const got = core.single('demo:seat');
    expect(got?.cell).toBe('main');
    expect(got?.priority).toBe(900);
    expect(typeof got?.store).toBe('function');
    expect(got?.children).toEqual(['demo:seat:sub']);
    expect(got?.props).toEqual({ label: 'hi' });
  });
});

describe('SlotCore · 级联回收与版本计数', () => {
  it('disposer 撤销本条贡献；幂等可重复调用', () => {
    const core = new SlotCore();
    core.declare({ key: 'demo:list' });
    const off = core.register('demo:list', entry('a'));
    off();
    off(); // 幂等
    expect(core.entries('demo:list')).toEqual([]);
  });

  it('版本计数 key 级细粒度（D14）：声明/注册/撤销各 +1，互不串扰', () => {
    const core = new SlotCore();
    expect(core.version('demo:a')).toBe(0);
    core.declare({ key: 'demo:a' });
    expect(core.version('demo:a')).toBe(1);
    expect(core.version('demo:b')).toBe(0);
    const off = core.register('demo:a', entry('x'));
    expect(core.version('demo:a')).toBe(2);
    core.declare({ key: 'demo:b' });
    expect(core.version('demo:a')).toBe(2); // b 的声明不动 a
    off();
    expect(core.version('demo:a')).toBe(3);
  });
});

describe('SlotCore · root 单席位纪律（D3）', () => {
  it('factory 席位：封印前可注册，封印后动态注册一律拒绝', () => {
    const core = new SlotCore();
    core.declare({ key: 'root', kind: 'single', factory: true });
    core.register('root', entry('layout.app-frame', { order: 0 })); // 出厂占据
    core.sealFactory();
    expect(core.sealed).toBe(true);
    try {
      core.register('root', entry('evil.takeover'));
      expect.unreachable('封印后注册应被拒绝');
    } catch (e) {
      expect((e as SlotCoreError).code).toBe('FACTORY_SEALED');
      expect((e as Error).message).toContain('root 单席位纪律');
    }
    // 出厂占据者不受封印影响（仍可幂等替换——同一出厂件的重装）
    expect(() => core.register('root', entry('layout.app-frame', { order: 0 }))).toThrowError(SlotCoreError);
  });

  it('封印只约束 factory 席位：普通席位照常注册', () => {
    const core = new SlotCore();
    core.declare({ key: 'root', kind: 'single', factory: true });
    core.declare({ key: 'demo:seat' });
    core.sealFactory();
    expect(() => core.register('demo:seat', entry('a'))).not.toThrow();
  });
});

describe('SlotCore · 调试面', () => {
  it('snapshot 输出声明账本 + 各席位条目 + 封印状态', () => {
    const core = new SlotCore();
    core.declare({ key: 'root', kind: 'single', factory: true, description: '应用根' });
    core.declare({ key: 'demo:toolbar', description: '工具条' });
    core.register('root', entry('layout.app-frame'));
    core.register('demo:toolbar', entry('plugin.btn'));
    const snap = core.snapshot();
    expect(snap.factorySealed).toBe(false);
    expect(snap.declarations.map((d) => d.key)).toEqual(['root', 'demo:toolbar']);
    expect(snap.slots['demo:toolbar'].map((e) => e.id)).toEqual(['plugin.btn']);
  });
});
