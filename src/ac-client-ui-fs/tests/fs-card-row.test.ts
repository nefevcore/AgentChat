// ============================================================
// ac-client-ui-fs/tests/fs-card-row.test.ts —— 工具卡行验收
//（M28 P2 §2.2：boot graph 声明 + 卸载级联回收；席位贡献见
// webui/tests/clients-tool-cards）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M28 P2 · ac-client-ui-fs 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-fs（phase=domain，entry 绝对路径）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-fs');
    const def = graph.find((g) => g.name === 'ui-fs')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-fs[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-fs');
    expect(changed.filter((n) => n === 'ui-fs').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
