// ============================================================
// ac-group/tests/group-row.test.ts —— 行包双半边宿主面验收
//（M27 S3-1b/D19：boot graph 声明 + 卸载级联回收）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

/** 行 inject（agents/conversation）最小桩——本测试只验 boot graph 面 */
class Stub extends Service {
  constructor(ctx: Context, name: string) { super(ctx, name); }
}

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('S3-1b · ac-group 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 group；卸载 → 级联回缩 + 变更帧', async () => {
    const ctx = new Context();
    new Stub(ctx, 'agents');
    new Stub(ctx, 'conversation');
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (n) => changed.push(n));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('group');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('group');
    expect(changed.filter((n) => n === 'group').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
