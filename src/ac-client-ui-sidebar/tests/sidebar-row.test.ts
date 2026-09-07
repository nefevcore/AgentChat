// ============================================================
// ac-client-ui-sidebar/tests/sidebar-row.test.ts —— 前端行宿主半边验收
//（M27.2-2 出包之四：boot graph 声明〔base 阶段〕+ 卸载级联）
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

describe('M27.2 · ac-client-ui-sidebar 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-sidebar 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-sidebar');
    const def = graph.find((g) => g.name === 'ui-sidebar')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base');
    expect(def.entry).toMatch(/ac-client-ui-sidebar[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-sidebar');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-sidebar');
    expect(changed.filter((n) => n === 'ui-sidebar').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

// ------------------------------------------------------------
// client 半边（jsdom 需求面：SidebarHost 挂载链——uiStore pinia +
// sidebar 席位贡献）单测在 webui 侧（layout 卸载族）；此处锁数据面：
// sidebarActions 解析语义（ctx 参数化——注册表 order 轴）
// ------------------------------------------------------------

describe('M27.2 · ac-client-ui-sidebar 数据面（sidebarActions 解析）', () => {
  it('entries → def 视图（meta.def 原样携带；order 缺省 100 升序）', async () => {
    const { createClient } = await import('ac-client-runtime');
    const ctx = await createClient();
    ctx.slots.declare({ key: 'sidebar:plugin-actions', kind: 'list' });
    ctx.slots.register('sidebar:plugin-actions', {
      id: 'b', component: { render: () => null }, order: 200,
      meta: { def: { id: 'b', label: 'B', icon: 'i', onClick: () => {} } },
    });
    ctx.slots.register('sidebar:plugin-actions', {
      id: 'a', component: { render: () => null },
      meta: { def: { id: 'a', label: 'A', icon: 'i', order: 50, onClick: () => {} } },
    });
    const { useSidebarActions } = await import('../client/sidebarActions.ts');
    const sorted = useSidebarActions(ctx);
    expect(sorted.value.map((a) => a.id)).toEqual(['a', 'b']); // order 升序（50 < 200）
    // runtime 缺席 → 空清单
    expect(useSidebarActions(undefined).value).toEqual([]);
  });
});
