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

    // 顺序表：b 在 a 前 → 烘焙顺序 b,a；c 的 owner 未启用 → 跳过；missing 未注册 → 跳过
    const resolved = hooks.collect({
      runStart: ['missing', 'p2.b', 'p3.c', 'p1.a'],
    }, config({ presets: ['p1', 'p2'] }), {});
    expect(calls).toEqual(['p2.b', 'p1.a']);
    expect(resolved.runStartHook).toHaveLength(2);
  });

  it('presets 未声明（旧契约）：不按 owner 过滤', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runEnd', 'x.save', () => async () => {}, 'x');
    const resolved = hooks.collect({ runEnd: ['x.save'] }, config(), {});
    expect(resolved.runEndHook).toHaveLength(1);
  });

  it('unregister(owner)：精确回收该插件全部钩子', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runStart', 'p.a', () => async () => {}, 'p');
    hooks.register('runEnd', 'p.b', () => async () => {}, 'p');
    hooks.register('runEnd', 'q.c', () => async () => {}, 'q');
    expect(hooks.unregister('p')).toBe(2);
    expect(hooks.listOwners()).toEqual(['q']);
    expect(hooks.collect({ runStart: ['p.a'], runEnd: ['p.b', 'q.c'] }, config({ presets: ['p', 'q'] }), {}).runEndHook).toHaveLength(1);
  });

  it('find：返回归属（UI 展示 owner）', () => {
    const ctx = new Context();
    const hooks = new HooksService(ctx);
    hooks.register('runStart', 'p.a', () => async () => {}, 'p');
    expect(hooks.find('runStart', 'p.a')?.owner).toBe('p');
    expect(hooks.find('runStart', 'nope')).toBeUndefined();
  });
});
