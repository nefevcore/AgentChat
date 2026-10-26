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
