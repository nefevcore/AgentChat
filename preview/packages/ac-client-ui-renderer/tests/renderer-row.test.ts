// ============================================================
// ac-client-ui-renderer/tests/renderer-row.test.ts —— 前端行宿主半边验收
//（M27.2-2 出包之二：boot graph 声明〔base 阶段〕+ 卸载级联）
//
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容——declareClient
// entry 解析依赖 fileURLToPath，见 webui boot-graph.test 同款注意）。
// client 半面（含 markdown 管线）见 renderer-client.test.ts（jsdom）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M27.2 · ac-client-ui-renderer 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-renderer 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-renderer');
    const def = graph.find((g) => g.name === 'ui-renderer')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base'); // 渲染地基——封印前批次
    expect(def.entry).toMatch(/ac-client-ui-renderer[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-renderer');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-renderer');
    expect(changed.filter((n) => n === 'ui-renderer').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
