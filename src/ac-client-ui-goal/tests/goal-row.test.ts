// ============================================================
// ac-client-ui-goal/tests/goal-row.test.ts —— 前端行验收
//（M28 P1 §4.1 原案：boot graph 声明 + 卸载级联回收 + goalCard 纯函数）
//
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容）。client 半面
//（tool-card/dock 席位贡献）见 webui/tests/clients-goal。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M28 P1 · ac-client-ui-goal 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-goal（phase=domain，entry 绝对路径）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-goal');
    const def = graph.find((g) => g.name === 'ui-goal')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-goal[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-goal');
    expect(changed.filter((n) => n === 'ui-goal').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M28 P1 · goalCard 数据管线（纯函数，随域自 tool 迁入）', () => {
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

  it('fetchGoal：RPC 失败（后端行摘除）→ null（dock 静默隐藏，不抛）', async () => {
    const { fetchGoal } = await import('../client/goalApi.ts');
    const badRpc = {
      call() {
        return Promise.reject(new Error('method not found'));
      },
    };
    await expect(fetchGoal('a1', 'a1~user', badRpc)).resolves.toBeNull();
  });
});
