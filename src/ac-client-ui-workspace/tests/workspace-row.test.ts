// ============================================================
// ac-client-ui-workspace/tests/workspace-row.test.ts —— 前端行验收
//（M27.1：boot graph 声明 + 卸载级联回收 + 双向摘除）
// ============================================================
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

/**
 * 装载后端行（ac-workspace inject agents/agentStore/session——真行 +
 * 临时根装配，与 ac-workspace/tests/workspace.test.ts 同款最小组合；
 * 跨包深路径仅供测试——运行时两行经 REST 契约面解耦）。
 */
async function bootWithBackend() {
  const root = await mkdtemp(join(tmpdir(), 'ac-ui-workspace-'));
  const ctx = new Context();
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  const agentStoreRow = await import('ac-agent-store');
  const agentsRow = await import('ac-agents');
  const sessionRow = await import('ac-session');
  const backend = await import('ac-workspace/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  const fibers: Fiber[] = [];
  for (const [mod, config] of [
    [agentStoreRow, { root }],
    [agentsRow, undefined],
    [sessionRow, { root }],
    [backend, { root }],
  ] as Array<[unknown, unknown]>) {
    fibers.push(config === undefined ? await plug(mod) : await plug(mod, config));
  }
  return { ctx, root, fibers };
}

describe('M27.1 · ac-client-ui-workspace 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-workspace；卸载 → 级联回缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (n) => changed.push(n));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-workspace');
    expect(graph.find((g) => g.name === 'ui-workspace')!.entry)
      .toMatch(/ac-client-ui-workspace[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-workspace');
    expect(changed.filter((n) => n === 'ui-workspace').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → boot graph 收缩，后端行照常在场（ctx.workspace 服务可调）', async () => {
    const { ctx, root, fibers } = await bootWithBackend();
    const uiFiber = await loadRow(ctx);
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-workspace');
    expect(ctx.get('workspace')).toBeDefined(); // 后端能力不受牵连
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });

  it('卸后端行 → UI 行照常在场（boot graph 不收缩——REST 失败空态归前端降级语义）', async () => {
    const { ctx, root, fibers } = await bootWithBackend();
    const uiFiber = await loadRow(ctx);
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose(); // 摘后端行（含依赖行）
    }
    expect(ctx.get('workspace', false)).toBeUndefined(); // 后端能力同灭
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-workspace'); // UI 行不动
    await uiFiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
