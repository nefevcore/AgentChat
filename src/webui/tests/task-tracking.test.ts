// ============================================================
// webui/tests/task-tracking.test.ts —— 任务追踪前端面
//
// · normalizeTodoCard / normalizeGoalCard：live 帧（output 的
//   JSON.stringify）与历史回放（JSON.stringify({ok,output})）两形统一
// · fetchGoal / fetchTodos：Rpc 注入 stub——服务未装载（RPC 报错）→
//   null（dock 静默隐藏），不抛出
// ============================================================
import { describe, it, expect } from 'vitest';
import { normalizeTodoCard, normalizeGoalCard, fetchGoal, fetchTodos } from '../src/api/tasks.ts';

describe('normalizeTodoCard（todo 工具消息 → 卡片数据）', () => {
  it('live 终值形（output = JSON.stringify(output 对象)）：取 output.todos', () => {
    const output = JSON.stringify({
      count: 2,
      todos: [
        { content: '写实现', status: 'in_progress' },
        { content: '补测试' },
      ],
      message: '清单已全量重写（2 条；进行中 1）',
    }, null, 2);
    const card = normalizeTodoCard({ action: 'write', todos: [{ content: '旧条目' }], output });
    expect(card).not.toBeNull();
    expect(card!.settled).toBe(true);
    expect(card!.todos).toEqual([
      { content: '写实现', status: 'in_progress' },
      { content: '补测试', status: 'pending' }, // status 缺省 → pending
    ]);
  });

  it('历史回放形（content = JSON.stringify({ok,output})）：解包后同源', () => {
    const output = JSON.stringify({ ok: true, output: { count: 1, todos: [{ content: '收尾', status: 'completed' }] } });
    const card = normalizeTodoCard({ action: 'read', output });
    expect(card!.todos).toEqual([{ content: '收尾', status: 'completed' }]);
    expect(card!.settled).toBe(true);
  });

  it('调用中（无 output）：回落 args.todos 预览，settled=false', () => {
    const card = normalizeTodoCard({
      action: 'write',
      todos: [{ content: '第一步', status: 'in_progress' }, { content: '第二步' }],
    });
    expect(card!.settled).toBe(false);
    expect(card!.todos).toHaveLength(2);
  });

  it('空清单（write 清空）与不可解析 → null（卡片隐藏）', () => {
    expect(normalizeTodoCard({ action: 'write', todos: [], output: JSON.stringify({ count: 0, todos: [], message: '清单已清空' }) })).toBeNull();
    expect(normalizeTodoCard({ action: 'read', output: '' })).toBeNull();
    expect(normalizeTodoCard(undefined)).toBeNull();
  });
});

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

describe('fetchGoal / fetchTodos（可选能力面）', () => {
  it('RPC 正常 → 返回载荷', async () => {
    const rpc = {
      async call<T>(method: string): Promise<T> {
        if (method === 'goal/get') return { goal: { current: { id: 'g', objective: 'x', status: 'active', createdAt: '', updatedAt: '' }, history: [] } } as T;
        return { todos: [{ content: 'a', status: 'pending' }] } as T;
      },
    };
    const g = await fetchGoal('a1', 'a1~user', rpc);
    expect(g?.current?.id).toBe('g');
    const t = await fetchTodos('a1', 'a1~user', rpc);
    expect(t).toEqual([{ content: 'a', status: 'pending' }]);
  });

  it('服务未装载（RPC 报错）→ null（静默隐藏不抛出）', async () => {
    const rpc = {
      async call(): Promise<never> {
        throw new Error('goals 服务未装载');
      },
    };
    await expect(fetchGoal('a1', 'a1~user', rpc)).resolves.toBeNull();
    await expect(fetchTodos('a1', 'a1~user', rpc)).resolves.toBeNull();
  });
});
