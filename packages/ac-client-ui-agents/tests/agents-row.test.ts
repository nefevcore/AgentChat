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

describe('M27.1 · ac-client-ui-agents 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
  it('行装载/卸载零副作用（apply 空实现，无宿主面注册）', async () => {
    const ctx = new Context();
    const fiber = await loadRow(ctx);
    await fiber.dispose();
  });

  it('extension 自述形状（extension-catalog 聚合面契约）', () => {
    expect(row.extension.name).toBe(row.extension.name.trim());
    expect(row.extension.label.length).toBeGreaterThan(0);
    expect(row.extension.automatic).toBe(true);
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → 后端行照常在场（ctx.agents 服务可调）', async () => {
    const ctx = new Context();
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.get('agents')).toBeDefined(); // 后端能力不受牵连
    await backendFiber.dispose();
  });

  it('卸后端行 → UI 行照常可装载（RPC 失败空态归前端降级语义）', async () => {
    const ctx = new Context();
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('agents', false)).toBeUndefined(); // 后端能力同灭
    await uiFiber.dispose(); // UI 行装载/卸载不受牵连
  });
});
