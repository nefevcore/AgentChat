// ============================================================
// ac-client-ui-settings/tests/settings-row.test.ts —— 前端行宿主半边
// 验收（M27.2-2 出包之六：boot graph 声明〔base 阶段〕+ 卸载级联）
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

describe('M27.2 · ac-client-ui-settings 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-settings 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-settings');
    const def = graph.find((g) => g.name === 'ui-settings')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base');
    expect(def.entry).toMatch(/ac-client-ui-settings[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-settings');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-settings');
    expect(changed.filter((n) => n === 'ui-settings').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

// ------------------------------------------------------------
// client 半边数据面：settings 页签解析（extensionTabs——注册表
// order 轴 + slots/changed 响应式 + resolveTabProps 契约适配）
// ------------------------------------------------------------

describe('M27.2 · ac-client-ui-settings 数据面（页签解析）', () => {
  it('entries → def 视图（order 轴）+ resolveTabProps（函数 props 与 base 合并，tab 优先）', async () => {
    const { createClient, setClientRuntime, resetClientRuntime } = await import('ac-client-runtime');
    const ctx = await createClient();
    setClientRuntime(ctx);
    const { sortedSettingsTabs, resolveTabProps, initSettingsTabs } = await import('../client/extensionTabs.ts');
    initSettingsTabs(ctx);
    ctx.slots.declare({ key: 'settings:main-view', kind: 'list' });
    ctx.slots.register('settings:main-view', {
      id: 'b', component: { render: () => null }, order: 200,
      meta: { def: { id: 'b', label: 'B', component: { render: () => null } } },
    });
    ctx.slots.register('settings:main-view', {
      id: 'a', component: { render: () => null },
      meta: { def: { id: 'a', label: 'A', order: 50, component: { render: () => null } } },
    });
    expect(sortedSettingsTabs.value.map((t) => t.id)).toEqual(['a', 'b']); // order 缺省 100 升序
    const merged = resolveTabProps(
      { id: 'a', label: 'A', component: { render: () => null }, props: (base) => ({ ...base, extra: 1 }) },
      { agentId: 'x' },
    );
    expect(merged).toEqual({ agentId: 'x', extra: 1 });
    // slots/changed → 版本计数 → computed 重算（同 id 替换继承插入序，
    // 排序按 entry.order 轴——顶层 order 才进注册表选举）
    ctx.slots.register('settings:main-view', {
      id: 'a', component: { render: () => null }, order: 300,
      meta: { def: { id: 'a', label: 'A2', order: 300, component: { render: () => null } } },
    });
    expect(sortedSettingsTabs.value.map((t) => t.id)).toEqual(['b', 'a']); // order 200 < 300
    resetClientRuntime();
  });
});

// ------------------------------------------------------------
// client 半边数据面：设置左树节派生（sectionTree——2026-11 左树数据化：
// 席位条目 meta.section/meta.label → 平铺叶；壳零出厂叶硬编码）
// ------------------------------------------------------------

describe('2026-11 · ac-client-ui-settings 数据面（左树节派生）', () => {
  it('deriveSectionLeaves：meta.section/meta.label 映射 + 缺 label 回落节 id + 缺 section 弃置', async () => {
    const { deriveSectionLeaves } = await import('../client/sectionTree.ts');
    const c = { render: () => null };
    const leaves = deriveSectionLeaves([
      { id: 'a', component: c, order: 20, meta: { section: 'llmPools', label: '模型管理' } },
      { id: 'b', component: c, order: 10, meta: { section: 'agents' } }, // 缺 label → 回落节 id
      { id: 'c', component: c, meta: { label: '无选举键' } }, // 缺 section → 弃置（不可寻址）
      { id: 'd', component: c, meta: {} },
    ]);
    // 纯映射不排序（排序 = 注册表 order 轴职责）：保持传入序
    expect(leaves).toEqual([
      { id: 'llmPools', label: '模型管理' },
      { id: 'agents', label: 'agents' },
    ]);
  });
});
