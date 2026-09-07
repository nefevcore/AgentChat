// ============================================================
// ac-client-ui-tool/tests/tool-row.test.ts —— 前端行宿主半边验收
//（M27.2-2 出包之三：boot graph 声明〔base 阶段〕+ 卸载级联）
//
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容）。client 半面
//（席位声明 + 内置 8 卡出厂注册）见 webui/tests/d9-registry。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M27.2 · ac-client-ui-tool 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-tool 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-tool');
    const def = graph.find((g) => g.name === 'ui-tool')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base');
    expect(def.entry).toMatch(/ac-client-ui-tool[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-tool');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-tool');
    expect(changed.filter((n) => n === 'ui-tool').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.2 · ac-client-ui-tool 数据管线（goalCard 纯函数）', () => {
  it('normalizeGoalCard：live 终值形（output.goal）→ 卡片数据', async () => {
    const { normalizeGoalCard } = await import('../client/goalCard.ts');
    const output = JSON.stringify({ goal: { id: 'g1', objective: '搭好监控', status: 'active' } });
    const card = normalizeGoalCard({ action: 'create', output });
    expect(card!.goal.objective).toBe('搭好监控');
    expect(card!.settled).toBe(true);
  });

  it('normalizeGoalCard：历史回放形（{ok,output} 信封）→ 解包取终值', async () => {
    const { normalizeGoalCard } = await import('../client/goalCard.ts');
    const output = JSON.stringify({ ok: true, output: { current: { id: 'g2', objective: '周报', status: 'paused' } } });
    const card = normalizeGoalCard({ action: 'get', output });
    expect(card!.goal.status).toBe('paused');
  });

  it('normalizeGoalCard：不可解析 → null（卡片隐藏）', async () => {
    const { normalizeGoalCard } = await import('../client/goalCard.ts');
    expect(normalizeGoalCard({ action: 'create' })).toBeNull();
  });
});
