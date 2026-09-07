// ============================================================
// ac-todo/tests/todo-card.test.ts —— todo 卡片数据归一化（纯函数）
//
// 自 webui/tests/task-tracking.test.ts 迁入的 todo 半边（M27 S3 契约
// 随行走——owning = ac-todo/client）。live 帧（stringifyToolResult =
// output 的 JSON.stringify）与历史回放（JSON.stringify(ToolResult
// 全对象)）两形统一。
// ============================================================
import { describe, it, expect } from 'vitest';
import { normalizeTodoCard } from '../client/tasks.ts';
import type { RpcClientFace } from 'ac-client-runtime';
import { fetchTodos } from '../client/tasks.ts';

describe('normalizeTodoCard（todo 工具消息 → 卡片数据）', () => {
  it('live 终值形（output = JSON.stringify(output 对象)）：取 output.todos', () => {
    const output = JSON.stringify({ count: 2, todos: [{ content: '第一步', status: 'completed' }, { content: '第二步' }] });
    const card = normalizeTodoCard({ action: 'write', todos: [{ content: '旧条目' }], output });
    expect(card!.settled).toBe(true);
    expect(card!.todos).toEqual([
      { content: '第一步', status: 'completed' },
      { content: '第二步', status: 'pending' },
    ]);
  });

  it('历史回放形（output = JSON.stringify({ok, output})）：解包信封取终值', () => {
    const output = JSON.stringify({ ok: true, output: { count: 1, todos: [{ content: '收尾', status: 'completed' }] } });
    const card = normalizeTodoCard({ action: 'read', output });
    expect(card!.todos).toEqual([{ content: '收尾', status: 'completed' }]);
  });

  it('调用中（无 output）：回落 args.todos 预览，settled=false', () => {
    const card = normalizeTodoCard({
      action: 'write',
      todos: [{ content: '第一步', status: 'in_progress' }, { content: '第二步' }],
    });
    expect(card!.todos).toHaveLength(2);
    expect(card!.settled).toBe(false);
  });

  it('空清单 / 不可解析 → null（卡片隐藏，不占位）', () => {
    expect(normalizeTodoCard({ action: 'write', todos: [], output: JSON.stringify({ count: 0, todos: [], message: '清单已清空' }) })).toBeNull();
    expect(normalizeTodoCard({ action: 'read', output: '' })).toBeNull();
    expect(normalizeTodoCard(undefined)).toBeNull();
  });
});

describe('fetchTodos（可选能力面：经 ctx.rpc 契约）', () => {
  const okRpc: Pick<RpcClientFace, 'call'> = {
    async call<T>() {
      return { todos: [{ content: 'a', status: 'pending' }] } as T;
    },
  };

  it('服务装载 → 返回清单（缺省字段归一）', async () => {
    const t = await fetchTodos(okRpc, 'a1', 'a1~user');
    expect(t).toEqual([{ content: 'a', status: 'pending' }]);
  });

  it('服务未装载（RPC 报错）→ null（静默隐藏，不抛）', async () => {
    const badRpc: Pick<RpcClientFace, 'call'> = {
      async call() {
        throw new Error('method not found');
      },
    };
    await expect(fetchTodos(badRpc, 'a1', 'a1~user')).resolves.toBeNull();
  });
});
