// ============================================================
// webui/tests/goal-tracking.test.ts —— goal 任务追踪前端面
//
// · normalizeGoalCard：live 帧（output 的 JSON.stringify）与历史回放
//   （JSON.stringify({ok,output})）两形统一
// · fetchGoal：Rpc 注入 stub——服务未装载（RPC 报错）→ null
//   （dock 静默隐藏），不抛出
// · updateGoal/deleteGoal：dock 直编写面——rpc error 抛出（调用方呈现）
// todo 半边已随行走迁 ac-todo/tests/todo-card.test.ts（M27 S3）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { fetchGoal, updateGoal, deleteGoal } from 'ac-client-ui-goal/client/goalApi.ts';
import { normalizeGoalCard } from 'ac-client-ui-goal/client/goalCard.ts';

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

describe('updateGoal/deleteGoal（dock 直编写面）', () => {
  it('updateGoal：patch 字段映射（max_rounds/blocked_reason 蛇转驼）→ 返回更新后的 goal', async () => {
    const seen: Array<[string, unknown?]> = [];
    const rpc = {
      async call<T>(method: string, params?: unknown): Promise<T> {
        seen.push([method, params]);
        if (method === 'goal/update') {
          return { goal: { id: 'g1', objective: '新目标', status: 'paused', createdAt: '', updatedAt: '' } } as T;
        }
        return {} as T;
      },
    };
    const goal = await updateGoal('a1', 'a1~user', { objective: '新目标', maxRounds: 12, blockedReason: '等环境' }, rpc);
    expect(goal.objective).toBe('新目标');
    expect(seen[0]![0]).toBe('goal/update');
    expect(seen[0]![1]).toMatchObject({
      agentId: 'a1',
      conversationId: 'a1~user',
      patch: { objective: '新目标', max_rounds: 12, blocked_reason: '等环境' },
    });
  });

  it('updateGoal：返回缺 goal → 抛（防上层渲染 undefined）', async () => {
    const rpc = { async call<T>(): Promise<T> { return {} as T; } };
    await expect(updateGoal('a1', 'a1~user', { note: 'x' }, rpc)).rejects.toThrow(/缺 goal/);
  });

  it('updateGoal/deleteGoal：rpc error 语义透传（服务未装载 → 抛给调用方呈现）', async () => {
    const rpc = {
      async call(): Promise<never> {
        throw new Error('goals 服务未装载');
      },
    };
    await expect(updateGoal('a1', 'a1~user', { status: 'paused' }, rpc)).rejects.toThrow('goals 服务未装载');
    await expect(deleteGoal('a1', 'a1~user', rpc)).rejects.toThrow('goals 服务未装载');
  });

  it('deleteGoal：正常路径 resolve（载荷 {goal, deleted}）', async () => {
    const seen: Array<[string, unknown?]> = [];
    const rpc = {
      async call<T>(method: string, params?: unknown): Promise<T> {
        seen.push([method, params]);
        return { goal: {}, deleted: true } as T;
      },
    };
    await expect(deleteGoal('a1', 'a1~user', rpc)).resolves.toBeUndefined();
    expect(seen[0]![0]).toBe('goal/delete');
    expect(seen[0]![1]).toEqual({ agentId: 'a1', conversationId: 'a1~user' });
  });
});
