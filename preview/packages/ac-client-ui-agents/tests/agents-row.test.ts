// ============================================================
// ac-client-ui-agents/tests/agents-row.test.ts —— 前端行验收
//（M27.1：boot graph 声明 + 卸载级联回收 + 双向摘除）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

/** 装载后端行（AgentsService 注册中心形态，构造零副作用；跨包深路径仅供测试） */
async function loadBackendRow(ctx: Context): Promise<Fiber> {
  const backend = await import('ac-agents/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(backend, undefined);
}

describe('M27.1 · ac-client-ui-agents 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-agents；卸载 → 级联回缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (n) => changed.push(n));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-agents');
    expect(graph.find((g) => g.name === 'ui-agents')!.entry)
      .toMatch(/ac-client-ui-agents[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-agents');
    expect(changed.filter((n) => n === 'ui-agents').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → boot graph 收缩，后端行照常在场（ctx.agents 服务可调）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-agents');
    expect(ctx.get('agents')).toBeDefined(); // 后端能力不受牵连
    await backendFiber.dispose();
  });

  it('卸后端行 → UI 行照常在场（boot graph 不收缩——RPC 失败空态归前端降级语义）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('agents', false)).toBeUndefined(); // 后端能力同灭
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-agents'); // UI 行不动
    await uiFiber.dispose();
  });
});
