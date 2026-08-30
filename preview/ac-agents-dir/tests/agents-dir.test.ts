// ============================================================
// ac-agents-dir：目录扫描物化 → ctx.agents；摘行回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as agentsDirRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-agents-dir-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Map<string, Fiber> }[] = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers = new Map<string, Fiber>();
  for (const [id, row] of [
    ['agents', agentsRow],
    ['agent-store', agentStoreRow],
    ['agents-dir', agentsDirRow],
  ] as const) {
    const fiber = ctx.plugin(row as any, { root });
    await fiber;
    fibers.set(id, fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-agents-dir', () => {
  it('目录物化：store 里的 config → ctx.agents 注册表', async () => {
    const root = tmpRoot();
    // 先物化两个 Agent（经 store 唯一写口）
    const ctx0 = new Context();
    const storeFiber = ctx0.plugin(agentStoreRow as any, { root });
    await storeFiber;
    ctx0.agentStore.saveAgent({ id: 'a', model: 'glm-5.3', system: 'SA' });
    ctx0.agentStore.saveAgent({ id: 'b', model: 'deepseek-v4-flash' });
    await storeFiber.dispose();

    const { ctx } = await boot(root);
    expect(ctx.agents.ids().sort()).toEqual(['a', 'b']);
    expect(ctx.agents.get('a')).toEqual({ id: 'a', model: 'glm-5.3', system: 'SA' });
    expect(ctx.agents.require('b').model).toBe('deepseek-v4-flash');
  });

  it('空目录/无目录：物化为空（不抛错）', async () => {
    const { ctx } = await boot(tmpRoot());
    expect(ctx.agents.ids()).toEqual([]);
  });

  it('摘行回收：dispose agents-dir → 注册表清空，agents/agentStore 服务存活', async () => {
    const root = tmpRoot();
    const ctx0 = new Context();
    const storeFiber = ctx0.plugin(agentStoreRow as any, { root });
    await storeFiber;
    ctx0.agentStore.saveAgent({ id: 'a', model: 'm' });
    await storeFiber.dispose();

    const { ctx, fibers } = await boot(root);
    expect(ctx.agents.ids()).toEqual(['a']);
    await fibers.get('agents-dir')!.dispose();
    expect(ctx.agents.ids()).toEqual([]);
    expect(ctx.agentStore.agentIds()).toEqual(['a']); // 数据目录不受影响
    expect((ctx as any).agents).toBeDefined();
  });

  it('目录数据不完整（无 config 的空目录/损坏 config）→ 跳过物化', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'agents', 'empty-dir'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'broken', 'config.json'), '{oops', 'utf-8');

    const { ctx } = await boot(root);
    expect(ctx.agents.ids()).toEqual([]);
  });
});
