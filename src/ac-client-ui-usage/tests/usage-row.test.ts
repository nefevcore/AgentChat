// ============================================================
// ac-client-ui-usage/tests/usage-row.test.ts —— 前端行验收
//（M28 P1 §4.1 原案：boot graph 声明 + 卸载级联回收 + usageApi 纯函数）
//
// node 环境。client 半面（overlay 席位贡献）见 webui/tests/clients-usage。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M28 P1 · ac-client-ui-usage 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-usage（phase=domain，entry 绝对路径）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-usage');
    const def = graph.find((g) => g.name === 'ui-usage')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-usage[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-usage');
    expect(changed.filter((n) => n === 'ui-usage').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
