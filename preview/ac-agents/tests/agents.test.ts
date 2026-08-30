import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from '../src/index';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot() {
  const ctx = new Context();
  const fiber = ctx.plugin(agentsRow);
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  return { ctx, fiber };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-agents 注册中心', () => {
  it('register/get/list/require/remove', async () => {
    const { ctx } = await boot();
    ctx.agents.register({
      id: 'helper',
      model: 'mock-1',
      system: '你是助手',
      settings: { persona: '海盗', memory: { budgetTokens: 100 } },
    });
    expect(ctx.agents.has('helper')).toBe(true);
    expect(ctx.agents.get('helper')).toMatchObject({ id: 'helper', model: 'mock-1' });
    // settings[具名] 原样存取（扩展插件自定形状，核心不解释）
    expect(ctx.agents.get('helper')?.settings).toEqual({ persona: '海盗', memory: { budgetTokens: 100 } });
    expect(ctx.agents.ids()).toEqual(['helper']);
    expect(() => ctx.agents.require('ghost')).toThrow(/unknown agent: ghost/);
    expect(ctx.agents.remove('helper')).toBe(true);
    expect(ctx.agents.ids()).toEqual([]);
  });

  it('同 id 覆盖（upsert）', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'm1' });
    ctx.agents.register({ id: 'a', model: 'm2' });
    expect(ctx.agents.get('a')?.model).toBe('m2');
  });

  it('fiber 归属：插件行卸载 → 注册自动回收 + effect 标签', async () => {
    const { ctx } = await boot();
    const row = {
      name: 'mock-preset-row',
      inject: ['agents'],
      apply(c: Context) {
        c.agents.register({ id: 'preset-1', model: 'mock-1' });
      },
    };
    const fiber = ctx.plugin(row as any);
    await fiber;
    expect(fiber.getEffects().map((e) => e.label)).toContain('agents.register(preset-1)');
    expect(ctx.agents.has('preset-1')).toBe(true);
    await fiber.dispose();
    expect(ctx.agents.has('preset-1')).toBe(false);
  });
});

describe('ac-agents 档案变更通知（agents/updated，M7）', () => {
  it('reassign → updated；remove → removed；register 不发', async () => {
    const { ctx } = await boot();
    const seen: Array<{ id: string; change: string; model?: string }> = [];
    ctx.on('agents/updated', (config, change) => seen.push({ id: config.id, change, model: config.model }));
    ctx.agents.register({ id: 'a', model: 'm1' });
    expect(seen).toEqual([]); // 首注册不是档案变更
    ctx.agents.reassign({ id: 'a', model: 'm2' });
    expect(seen).toEqual([{ id: 'a', change: 'updated', model: 'm2' }]);
    ctx.agents.remove('a');
    expect(seen[1]).toEqual({ id: 'a', change: 'removed', model: 'm2' });
    expect(ctx.agents.remove('ghost')).toBe(false); // 撤不存在：无事件
    expect(seen).toHaveLength(2);
  });
});
