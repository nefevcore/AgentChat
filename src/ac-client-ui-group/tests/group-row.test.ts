// ============================================================
// ac-client-ui-group/tests/group-row.test.ts —— 前端行验收
//（M27.1：boot graph 声明 + 卸载级联回收 + 双向摘除）
// ============================================================
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

/** 后端行 inject（agents/conversation）最小桩——本测试只验双行装载面 */
class Stub extends Service {
  constructor(ctx: Context, name: string) { super(ctx, name); }
}

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

/** 装载后端行（inject 桩 + 临时根；跨包深路径仅供测试） */
async function bootWithBackend() {
  const root = await mkdtemp(join(tmpdir(), 'ac-ui-group-'));
  const ctx = new Context();
  new Stub(ctx, 'agents');
  new Stub(ctx, 'conversation');
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  const backend = await import('ac-group/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  const backendFiber = await plug(backend, { root });
  return { ctx, root, backendFiber };
}

describe('M27.1 · ac-client-ui-group 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-group；卸载 → 级联回缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (n) => changed.push(n));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-group');
    expect(graph.find((g) => g.name === 'ui-group')!.entry)
      .toMatch(/ac-client-ui-group[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-group');
    expect(changed.filter((n) => n === 'ui-group').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → boot graph 收缩，后端行照常在场（ctx.group 服务可调）', async () => {
    const { ctx, root, backendFiber } = await bootWithBackend();
    const uiFiber = await loadRow(ctx);
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-group');
    expect(ctx.get('group')).toBeDefined(); // 后端能力不受牵连
    await backendFiber.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('卸后端行 → UI 行照常在场（boot graph 不收缩——RPC 失败空态归前端降级语义）', async () => {
    const { ctx, root, backendFiber } = await bootWithBackend();
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('group', false)).toBeUndefined(); // 后端能力同灭
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-group'); // UI 行不动
    await uiFiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
