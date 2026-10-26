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
