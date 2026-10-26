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

// ◐c 退役批（cr-696）：ac-singles 后端行已删——「双向摘除」测试块随旧树语义退役（boot graph 声明半边保留）

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
