// ============================================================
// ac-client-ui-group/tests/*-row.test.ts —— 前端行宿主半边验收
//（cr-1117 零功能化：declareClient 声明注册表随旧链退役，图成员 =
//  行存在性；本面锁「装载/卸载零副作用 + extension 自述形状」）
//
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M27.1 · ac-client-ui-group 宿主半边（零功能行——cr-1117）', () => {
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
