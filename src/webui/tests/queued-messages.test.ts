// ============================================================
// webui/tests/queued-messages.test.ts —— next-turn 排队前端面
//
// useQueuedMessages（DSH queue 姿势）：
//   · 会话上下文就位 → conversation/queue RPC 拉取（immediate watch）
//   · conversation/queue-changed 帧 = 权威全量快照：conversationId 命中
//     本桶才套用（他桶快照不串台）
//   · steer → conversation/queue-steer（outcome 三态透传）后对账刷新
//   · remove → conversation/queue-remove 后对账刷新
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn(async (method: string, params: unknown) => {
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
    }),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => {}),
  },
}));

import { ref, nextTick } from 'vue';
import { wireRpc } from '../src/api/wire';
import { useQueuedMessages } from '../src/composables/useQueuedMessages';

const flush = async () => { await nextTick(); await new Promise((r) => setTimeout(r, 0)); };

describe('useQueuedMessages（排队 dock 数据面）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('会话就位 → RPC 拉取；queue-changed 权威快照按桶套用', async () => {
    const agentId = ref<string | null>('a1');
    const conversationId = ref<string | null>('a1~user');
    const { items } = useQueuedMessages(agentId, conversationId);
    await flush();
    expect(items.value.map((q) => q.id)).toEqual(['q1']); // 拉取快照

    // 他桶快照不收（防串台）
    const hook = vi.mocked(wireRpc.onWireEvent).mock.calls[0][0];
    hook('conversation/queue-changed', ['other-agent', 'other~conv', 'h', [{ id: 'x', preview: '别桶', sender: 'user', source: 'user', queuedAt: 2 }]]);
    expect(items.value.map((q) => q.id)).toEqual(['q1']);

    // 本桶权威快照 → 全量替换
    hook('conversation/queue-changed', ['a1', 'a1~user', 'a1~user~a1', [
      { id: 'q1', preview: '排队A', sender: 'user', source: 'user', queuedAt: 1 },
      { id: 'q2', preview: '排队B', sender: 'user', source: 'user', queuedAt: 2 },
    ]]);
    expect(items.value.map((q) => q.preview)).toEqual(['排队A', '排队B']);

    // 非队列帧忽略
    hook('loop/after-run', ['a1', 'a1~user']);
    expect(items.value).toHaveLength(2);
  });

  it('steer/remove → 对应 RPC + 对账刷新', async () => {
    const agentId = ref<string | null>('a1');
    const conversationId = ref<string | null>('a1~user');
    const { steer, remove, items } = useQueuedMessages(agentId, conversationId);
    await flush();

    const outcome = await steer('q1');
    expect(outcome).toBe('steered');
    const steerCall = vi.mocked(wireRpc.call).mock.calls.find((c) => c[0] === 'conversation/queue-steer');
    expect(steerCall?.[1]).toEqual({ agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
    // steer 后对账刷新 → 回到 RPC 快照（q1 已出队的最新服务端态）
    expect(items.value.map((q) => q.id)).toEqual(['q1']);

    await remove('q1');
    const removeCall = vi.mocked(wireRpc.call).mock.calls.find((c) => c[0] === 'conversation/queue-remove');
    expect(removeCall?.[1]).toEqual({ agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
  });

  it('会话上下文缺失 → 空态（dock 隐藏）', async () => {
    const agentId = ref<string | null>(null);
    const conversationId = ref<string | null>(null);
    const { items } = useQueuedMessages(agentId, conversationId);
    await flush();
    expect(items.value).toEqual([]);
    expect(vi.mocked(wireRpc.call).mock.calls.filter((c) => c[0] === 'conversation/queue')).toHaveLength(0);
  });
});
