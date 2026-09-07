// ============================================================
// webui/tests/goal-tracking.test.ts —— goal 任务追踪前端面
//
// · normalizeGoalCard：live 帧（output 的 JSON.stringify）与历史回放
//   （JSON.stringify({ok,output})）两形统一
// · fetchGoal：Rpc 注入 stub——服务未装载（RPC 报错）→ null
//   （dock 静默隐藏），不抛出
// todo 半边已随行走迁 ac-todo/tests/todo-card.test.ts（M27 S3）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { fetchGoal } from '../src/api/tasks.ts';
import { normalizeGoalCard } from 'ac-client-ui-tool/client/goalCard.ts';

describe('normalizeGoalCard（goal 工具消息 → 卡片数据）', () => {
  it('create/update 终值形：取 output.goal + message', () => {
    const output = JSON.stringify({
      goal: { id: 'goal-1', objective: '搭好监控面板', status: 'active', note: '先选型', createdAt: '', updatedAt: '' },
      message: '目标已登记（id=goal-1）',
    });
    const card = normalizeGoalCard({ action: 'create', objective: '搭好监控面板', output });
    expect(card!.settled).toBe(true);
    expect(card!.goal.objective).toBe('搭好监控面板');
    expect(card!.goal.status).toBe('active');
    expect(card!.goal.note).toBe('先选型');
    expect(card!.message).toContain('goal-1');
  });

  it('get 终值形：取 output.current', () => {
    const output = JSON.stringify({ current: { id: 'g2', objective: '迁移旧数据', status: 'blocked', blockedReason: '等审批' }, history: [] });
    const card = normalizeGoalCard({ action: 'get', output });
    expect(card!.goal.status).toBe('blocked');
    expect(card!.goal.blockedReason).toBe('等审批');
  });

  it('调用中（无 output）：回落 args 预览（objective/status）', () => {
    const card = normalizeGoalCard({ action: 'update', objective: '改成周报', status: 'paused' });
    expect(card!.settled).toBe(false);
    expect(card!.goal).toMatchObject({ objective: '改成周报', status: 'paused' });
  });

  it('不可解析（get 空桶 / 无 objective）→ null', () => {
    expect(normalizeGoalCard({ action: 'get', output: JSON.stringify({ current: undefined, history: [] }) })).toBeNull();
    expect(normalizeGoalCard({ action: 'create' })).toBeNull();
  });
});

describe('fetchGoal（可选能力面）', () => {
  it('RPC 正常 → 返回载荷', async () => {
    const rpc = {
      async call<T>(method: string): Promise<T> {
        if (method === 'goal/get') return { goal: { current: { id: 'g', objective: 'x', status: 'active', createdAt: '', updatedAt: '' }, history: [] } } as T;
        return {} as T;
      },
    };
    const g = await fetchGoal('a1', 'a1~user', rpc);
    expect(g?.current?.id).toBe('g');
  });

  it('服务未装载（RPC 报错）→ null（静默隐藏不抛出）', async () => {
    const rpc = {
      async call(): Promise<never> {
        throw new Error('goals 服务未装载');
      },
    };
    await expect(fetchGoal('a1', 'a1~user', rpc)).resolves.toBeNull();
  });
});
