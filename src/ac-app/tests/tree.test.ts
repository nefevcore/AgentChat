import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { bootTree, TREE, type BootedTree } from '../src/index';
import { PREVIEW_DIR } from '../src/ecosystem';
import { LlmError } from 'ac-llm';

const booted: BootedTree[] = [];

async function boot() {
  const tree = await bootTree();
  booted.push(tree);
  return tree;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-app 组合树', () => {
  it('双表一致：TREE 行集 = cordis.yml 非 disabled 行集（防漂移守护）', async () => {
    const ymlRows = yaml.load(await readFile(join(PREVIEW_DIR, 'cordis.yml'), 'utf8')) as Array<{
      id: string;
      disabled?: boolean;
    }>;
    // disabled 行（hmr：构造需 --expose-internals）不进 TREE——由 demo 路径 patches 启用
    const active = ymlRows.filter((r) => !r.disabled).map((r) => r.id);
    expect(TREE.map((r) => r.id)).toEqual(active);
  });

  it('boot：服务/适配器/工具行全部激活', async () => {
    const { ctx } = await boot();
    expect(ctx.llm.providers().sort()).toEqual(['deepseek', 'glm', 'openai']);
    expect(ctx.tools.has('hello')).toBe(true);
  });

  it('model → provider 路由（三薄行互不依赖）', async () => {
    const { ctx } = await boot();
    expect(ctx.llm.resolveProvider({ model: 'gpt-4o-mini' })).toBe('openai');
    expect(ctx.llm.resolveProvider({ model: 'deepseek-v4-flash' })).toBe('deepseek');
    expect(ctx.llm.resolveProvider({ model: 'glm-5.3' })).toBe('glm');
    expect(ctx.llm.resolveProvider({ model: 'gpt-4o-2024-11-20' })).toBe('openai'); // 前缀路由
  });

  it('懒实例化：boot 后无任何 provider 被构造', async () => {
    const { ctx } = await boot();
    expect(ctx.llm.stats().every((s) => !s.instantiated)).toBe(true);
  });

  it('hello 工具经事件链路执行', async () => {
    const { ctx } = await boot();
    const events: string[] = [];
    ctx.on('tool/after-execute', (call) => events.push(call.name));
    const result = await ctx.tools.execute({ name: 'hello', args: { message: 'x' } });
    expect(result).toEqual({ ok: true, output: 'hello: x' });
    expect(events).toEqual(['hello']);
  });

  it('effect 归属：适配器行的注册进入诊断树', async () => {
    const { fibers } = await boot();
    expect(fibers.get('llm-deepseek')!.getEffects().map((e) => e.label)).toContain('llm.register(deepseek)');
    expect(fibers.get('hello')!.getEffects().map((e) => e.label)).toContain('tools.register(hello)');
  });
});

describe('ac-app 热插拔', () => {
  it('摘 llm-glm 行 → provider 消失、路由 NO_PROVIDER，其余行不受影响', async () => {
    const { ctx, fibers } = await boot();
    await fibers.get('llm-glm')!.dispose();
    expect(ctx.llm.providers().sort()).toEqual(['deepseek', 'openai']);
    expect(() => ctx.llm.resolveProvider({ model: 'glm-5.3' })).toThrow(LlmError);
    expect(ctx.tools.has('hello')).toBe(true);
  });

  it('摘 hello 行 → 工具与事件订阅同时消失', async () => {
    const { ctx, fibers } = await boot();
    await fibers.get('hello')!.dispose();
    expect(ctx.tools.has('hello')).toBe(false);
    const result = await ctx.tools.execute({ name: 'hello' });
    expect(result.ok).toBe(false);
    expect(ctx.llm.providers()).toHaveLength(3);
  });
});
