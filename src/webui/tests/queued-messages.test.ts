// ============================================================
// webui/tests/queued-messages.test.ts —— next-turn 排队前端面
//
// useQueuedMessages（DSH queue 姿势；M27.2-2 视图半边随
// ac-client-ui-conversation 出包——rpc 契约面参数化，缺省取
// clientRuntime 单例；本测试经 webui 门面导入并显式注入 rpc 桩）：
//   · 会话上下文就位 → conversation/queue RPC 拉取（immediate watch）
//   · conversation/queue-changed 帧 = 权威全量快照：conversationId 命中
//     本桶才套用（他桶快照不串台）
//   · steer → conversation/queue-steer（outcome 三态透传）后对账刷新
//   · remove → conversation/queue-remove 后对账刷新
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RpcClientFace } from 'ac-client-runtime';

import { ref, nextTick } from 'vue';
import { useQueuedMessages, createQueuedDockStore } from '../src/composables/useQueuedMessages';

const flush = async () => { await nextTick(); await new Promise((r) => setTimeout(r, 0)); };

/** rpc 桩：call 按 method 应答 + 记录；onEvent 捕获订阅者（帧注入口） */
function makeRpc() {
  const handlers: Array<(type: string, args: unknown[]) => void> = [];
  const rpc: RpcClientFace = {
    call: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'conversation/queue') {
        return {
          items: [
            { id: 'q1', preview: '排队A', sender: 'user', source: 'user', queuedAt: 1 },
          ],
        };
      }
      if (method === 'conversation/queue-steer') return { outcome: 'steered' };
      if (method === 'conversation/queue-remove') return { removed: true };
      return {};
    }) as RpcClientFace['call'],
    onEvent: vi.fn((h: (type: string, args: unknown[]) => void) => {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    }),
  };
  return { rpc, handlers };
}

describe('useQueuedMessages（排队 dock 数据面）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('会话就位 → RPC 拉取；queue-changed 权威快照按桶套用', async () => {
    const { rpc, handlers } = makeRpc();
    const agentId = ref<string | null>('a1');
    const conversationId = ref<string | null>('a1~user');
    const { items } = useQueuedMessages(agentId, conversationId, rpc);
    await flush();
    expect(items.value.map((q) => q.id)).toEqual(['q1']); // 拉取快照

    // 他桶快照不收（防串台）
    handlers[0]!('conversation/queue-changed', ['other-agent', 'other~conv', 'h', [{ id: 'x', preview: '别桶', sender: 'user', source: 'user', queuedAt: 2 }]]);
    expect(items.value.map((q) => q.id)).toEqual(['q1']);

    // 本桶权威快照 → 全量替换
    handlers[0]!('conversation/queue-changed', ['a1', 'a1~user', 'a1~user~a1', [
      { id: 'q1', preview: '排队A', sender: 'user', source: 'user', queuedAt: 1 },
      { id: 'q2', preview: '排队B', sender: 'user', source: 'user', queuedAt: 2 },
    ]]);
    expect(items.value.map((q) => q.preview)).toEqual(['排队A', '排队B']);

    // 非队列帧忽略
    handlers[0]!('loop/after-run', ['a1', 'a1~user']);
    expect(items.value).toHaveLength(2);
  });

  it('steer/remove → 对应 RPC + 对账刷新', async () => {
    const { rpc } = makeRpc();
    const agentId = ref<string | null>('a1');
    const conversationId = ref<string | null>('a1~user');
    const { steer, remove, items } = useQueuedMessages(agentId, conversationId, rpc);
    await flush();

    const outcome = await steer('q1');
    expect(outcome).toBe('steered');
    const steerCall = vi.mocked(rpc.call).mock.calls.find((c) => c[0] === 'conversation/queue-steer');
    expect(steerCall?.[1]).toEqual({ agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
    // steer 后对账刷新 → 回到 RPC 快照（q1 已出队的最新服务端态）
    expect(items.value.map((q) => q.id)).toEqual(['q1']);

    await remove('q1');
    const removeCall = vi.mocked(rpc.call).mock.calls.find((c) => c[0] === 'conversation/queue-remove');
    expect(removeCall?.[1]).toEqual({ agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
  });

  it('会话上下文缺失 → 空态（dock 隐藏）', async () => {
    const { rpc } = makeRpc();
    const agentId = ref<string | null>(null);
    const conversationId = ref<string | null>(null);
    const { items } = useQueuedMessages(agentId, conversationId, rpc);
    await flush();
    expect(items.value).toEqual([]);
    expect(vi.mocked(rpc.call).mock.calls.filter((c) => c[0] === 'conversation/queue')).toHaveLength(0);
  });
});

describe('createQueuedDockStore（M28 §4.2 store 座位实例轴工厂）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopeKey 固化会话键；agentId 取用方置位触发首拉；dispose 退订帧面（幂等）', async () => {
    const { rpc, handlers } = makeRpc();
    const store = createQueuedDockStore('a1~user', rpc);
    // 构造期 agentId 未置位 → 不拉取（空态）
    await flush();
    expect(store.items.value).toEqual([]);
    expect(vi.mocked(rpc.call).mock.calls.filter((c) => c[0] === 'conversation/queue')).toHaveLength(0);

    // 取用方置位（QueueDockHost/DialogView 同轴写同值）→ watch 触发拉取
    store.agentId.value = 'a1';
    await flush();
    expect(store.items.value.map((q) => q.id)).toEqual(['q1']);

    // dispose（引用归零/会话死即清）→ rpc 事件退订：rpc 分发面（handlers
    // = 桩的订阅者数组）不再持有本实例——后续帧不再到达
    const fire = handlers[0]!;
    store.dispose();
    expect(handlers).not.toContain(fire);
    store.dispose(); // 幂等
  });
});
