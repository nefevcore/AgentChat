// ============================================================
// ac-client-ui-web/tests/web-card-row.test.ts —— 工具卡行验收
//（M28 P2 §2.2：boot graph 声明 + 卸载级联回收）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M28 P2 · ac-client-ui-web 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-web（phase=domain）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-web');
    const def = graph.find((g) => g.name === 'ui-web')!;
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-web[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-web');
    expect(changed.filter((n) => n === 'ui-web').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
