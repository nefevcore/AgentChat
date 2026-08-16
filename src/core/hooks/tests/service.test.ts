// ============================================================
// @agentchat/hooks/src/service.ts —— owner / 顺序表 / presets 过滤测试
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context } from '@agentchat/cordis';
import { HooksService } from '../src/service';
import type { AgentConfig } from '@agentchat/agent-config';

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  agent_id: 'a', name: 'A',
  ...over,
} as AgentConfig);

describe('HooksService owner / 顺序表', () => {
  it('collect：顺序表单向驱动；presets 过滤 owner；未注册名跳过', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    const calls: string[] = [];
    hooks.register('runStart', 'p1.a', () => { calls.push('p1.a'); return async () => {}; }, 'p1');
    hooks.register('runStart', 'p2.b', () => { calls.push('p2.b'); return async () => {}; }, 'p2');
    hooks.register('runStart', 'p3.c', () => { calls.push('p3.c'); return async () => {}; }, 'p3');

    // 启用清单：b 在 a 前 → 烘焙顺序 b,a；c 的 owner 未启用 → 跳过；missing 未注册 → 跳过
    const resolved = hooks.collect(config({
      presets: ['p1', 'p2'],
      hooks: { runStart: ['missing', 'p2.b', 'p3.c', 'p1.a'] },
    }), {});
    expect(calls).toEqual(['p2.b', 'p1.a']);
    expect(resolved.runStartHook).toHaveLength(2);
  });

  it('presets 未声明（旧契约）：不按 owner 过滤', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runEnd', 'x.save', () => async () => {}, 'x');
    const resolved = hooks.collect(config({ hooks: { runEnd: ['x.save'] } }), {});
    expect(resolved.runEndHook).toHaveLength(1);
  });

  it('清单即启用集：停用 = 移出 hooks 清单，重新加入后按新位置生效', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    const calls: string[] = [];
    hooks.register('runStart', 'p1.a', () => { calls.push('p1.a'); return async () => {}; }, 'p1');
    hooks.register('runStart', 'p1.b', () => { calls.push('p1.b'); return async () => {}; }, 'p1');
    hooks.register('runStart', 'p1.c', () => { calls.push('p1.c'); return async () => {}; }, 'p1');

    const disabled = hooks.collect(config({ presets: ['p1'], hooks: { runStart: ['p1.a', 'p1.c'] } }), {});
    expect(calls).toEqual(['p1.a', 'p1.c']);
    expect(disabled.runStartHook).toHaveLength(2);

    // 重新启用：重新加入清单（顺序由清单决定）
    calls.length = 0;
    const enabled = hooks.collect(config({ presets: ['p1'], hooks: { runStart: ['p1.b', 'p1.a', 'p1.c'] } }), {});
    expect(calls).toEqual(['p1.b', 'p1.a', 'p1.c']);
    expect(enabled.runStartHook).toHaveLength(3);
  });

  it('旧契约兼容：旧调用签名 + disabledHooks 自动从清单剔除', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    const calls: string[] = [];
    hooks.register('runStart', 'p1.a', () => { calls.push('p1.a'); return async () => {}; }, 'p1');
    hooks.register('runStart', 'p1.b', () => { calls.push('p1.b'); return async () => {}; }, 'p1');

    const resolved = hooks.collect(
      { runStart: ['p1.a', 'p1.b'] },
      config({ presets: ['p1'], disabledHooks: { runStart: ['p1.b'] } }),
      {},
    );
    expect(calls).toEqual(['p1.a']);
    expect(resolved.runStartHook).toHaveLength(1);
  });

  it('automatic：基础设施钩子不受 hooks 清单控制，追加在显式钩子后且同名去重', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    const calls: string[] = [];
    hooks.register('stepEnd', 'infra.persist', () => { calls.push('infra.persist'); return async () => {}; }, 'infra', true);
    hooks.register('stepEnd', 'p1.observe', () => { calls.push('p1.observe'); return async () => {}; }, 'p1');

    // 目录透出 automatic（前端徽章/禁 toggle 依据）
    expect(hooks.find('stepEnd', 'infra.persist')?.automatic).toBe(true);
    expect(hooks.listCatalog().find(e => e.name === 'infra.persist')?.entry.automatic).toBe(true);

    // 清单完全没写 infra.persist，也自动进入；顺序在显式钩子之后
    const resolved = hooks.collect(config({
      presets: ['infra', 'p1'],
      hooks: { stepEnd: ['p1.observe'] },
    }), {});
    expect(calls).toEqual(['p1.observe', 'infra.persist']);
    expect(resolved.stepEndHook).toHaveLength(2);

    // 清单显式包含同名时去重
    calls.length = 0;
    const deduped = hooks.collect(config({
      presets: ['infra', 'p1'],
      hooks: { stepEnd: ['infra.persist', 'p1.observe'] },
    }), {});
    expect(calls).toEqual(['infra.persist', 'p1.observe']);
    expect(deduped.stepEndHook).toHaveLength(2);
  });

  it('unregister(owner)：精确回收该插件全部钩子', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runStart', 'p.a', () => async () => {}, 'p');
    hooks.register('runEnd', 'p.b', () => async () => {}, 'p');
    hooks.register('runEnd', 'q.c', () => async () => {}, 'q');
    expect(hooks.unregister('p')).toBe(2);
    expect(hooks.listOwners()).toEqual(['q']);
    expect(hooks.collect(config({ presets: ['p', 'q'], hooks: { runStart: ['p.a'], runEnd: ['p.b', 'q.c'] } }), {}).runEndHook).toHaveLength(1);
  });

  it('find：返回归属（UI 展示 owner）', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runStart', 'p.a', () => async () => {}, 'p');
    expect(hooks.find('runStart', 'p.a')?.owner).toBe('p');
    expect(hooks.find('runStart', 'nope')).toBeUndefined();
  });

  it('listCatalog：按注册顺序携带推荐 order（UI 启用钩子时的插入锚点）', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runStart', 'p1.b', () => async () => {}, 'p1');
    hooks.register('runStart', 'p1.a', () => async () => {}, 'p1');
    hooks.register('runStart', 'p2.c', () => async () => {}, 'p2');

    const runStart = hooks.listCatalog().filter((e) => e.kind === 'runStart');
    expect(runStart.map((e) => e.name)).toEqual(['p1.b', 'p1.a', 'p2.c']);
    expect(runStart.map((e) => e.order)).toEqual([0, 1, 2]);
  });
});
