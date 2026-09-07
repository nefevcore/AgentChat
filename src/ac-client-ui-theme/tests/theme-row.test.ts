// ============================================================
// ac-client-ui-theme/tests/theme-row.test.ts —— 前端行验收
//（M27.2-2 出包首件：boot graph 声明〔base 阶段〕+ 卸载级联）
// client 半面（ctx.theme 服务 + 双模门面）见 webui/tests/clients-theme。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M27.2 · ac-client-ui-theme 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-theme 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-theme');
    const def = graph.find((g) => g.name === 'ui-theme')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base'); // 基础件——封印前批次
    expect(def.entry).toMatch(/ac-client-ui-theme[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-theme');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-theme');
    expect(changed.filter((n) => n === 'ui-theme').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
