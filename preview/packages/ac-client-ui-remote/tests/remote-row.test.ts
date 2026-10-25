// ============================================================
// ac-client-ui-remote/tests/remote-row.test.ts —— 前端行宿主半边验收
//（照 settings-row.test 形态：boot graph 声明〔domain 阶段〕+ 卸载级联）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('P1 · ac-client-ui-remote 宿主半边（boot graph 声明〔domain〕）', () => {
  it('行装载 → boot graph 含 ui-remote 条目（phase=domain，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-remote');
    const def = graph.find((g) => g.name === 'ui-remote')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-remote[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性：行卸载 → 声明级联回收 → boot graph 收缩', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-remote');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-remote');
  });
});