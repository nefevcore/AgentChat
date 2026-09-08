// ============================================================
// ac-client-ui-layout/tests/layout-row.test.ts —— 前端行宿主半边
// 验收（M27.2-2 出包之七：boot graph 声明〔base 阶段〕+ 卸载级联）
//
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M27.2 · ac-client-ui-layout 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-layout 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-layout');
    const def = graph.find((g) => g.name === 'ui-layout')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base');
    expect(def.entry).toMatch(/ac-client-ui-layout[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-layout');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-layout');
    expect(changed.filter((n) => n === 'ui-layout').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

// ------------------------------------------------------------
// 数据面：视角注册表解析（perspectives——active 谓词选举 + 卸载
// redirectTo 回退 + 无 runtime 回落）
// ------------------------------------------------------------

describe('M27.2 · ac-client-ui-layout 数据面（视角解析）', () => {
  it('activePerspective 选举：active 谓词 + 注册撤销回退（D18-3 redirectTo）', async () => {
    const { activePerspective, registerPerspective, bindPerspectives } = await import('../client/perspectives.ts');
    const { createClient, setClientRuntime } = await import('ac-client-runtime');
    const ctx = await createClient();
    setClientRuntime(ctx);
    bindPerspectives();
    ctx.slots.declare({ key: 'main:perspective', kind: 'list' });
    let fellBack = false;
    const p1 = { id: 'p1', label: 'P1', active: () => false, component: { render: () => null } };
    const p2 = {
      id: 'p2', label: 'P2', active: () => true, component: { render: () => null },
      redirectTo: () => { fellBack = true; },
    };
    const off1 = registerPerspective(p1);
    const off2 = registerPerspective(p2);
    expect(activePerspective()?.id).toBe('p2'); // active 谓词选举
    off2();
    expect(activePerspective()).toBe(null); // 唯一 active 撤销 → 无激活视角
    expect(fellBack).toBe(true); // 正激活视角撤销 → redirectTo 回退（D18-3）
    off1();
  });
});
