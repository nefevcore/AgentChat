// ============================================================
// ac-client-ui-search-pool/tests/search-pool-row.test.ts —— 前端行
// 宿主半边验收（2026-11 自 ui-llm-pool 拆分成行：boot graph 声明 +
// 卸载级联回收；settings:section 贡献见 webui/tests/clients-search-pool）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('2026-11 · ac-client-ui-search-pool 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-search-pool（phase=domain，entry 绝对路径）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-search-pool');
    const def = graph.find((g) => g.name === 'ui-search-pool')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-search-pool[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-search-pool');
    expect(changed.filter((n) => n === 'ui-search-pool').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
