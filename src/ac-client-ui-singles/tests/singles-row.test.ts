// ============================================================
// ac-client-ui-singles/tests/singles-row.test.ts —— 前端行验收
//（M27.1：boot graph 声明 + 卸载级联回收 + 双向摘除）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

/** 装载后端行（SinglesService 无硬 inject；跨包深路径仅供测试） */
async function loadBackendRow(ctx: Context): Promise<Fiber> {
  const backend = await import('ac-singles/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(backend, undefined);
}

describe('M27.1 · ac-client-ui-singles 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-singles；卸载 → 级联回缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (n) => changed.push(n));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-singles');
    expect(graph.find((g) => g.name === 'ui-singles')!.entry)
      .toMatch(/ac-client-ui-singles[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-singles');
    expect(changed.filter((n) => n === 'ui-singles').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → boot graph 收缩，后端行照常在场（ctx.singles 服务可调）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-singles');
    expect(ctx.get('singles')).toBeDefined(); // 后端能力不受牵连
    await backendFiber.dispose();
  });

  it('卸后端行 → UI 行照常在场（boot graph 不收缩——RPC 失败空态归前端降级语义）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('singles', false)).toBeUndefined(); // 后端能力同灭
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-singles'); // UI 行不动
    await uiFiber.dispose();
  });
});
