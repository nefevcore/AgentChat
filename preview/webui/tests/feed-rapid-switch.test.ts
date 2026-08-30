// ============================================================
// feed-rapid-switch.test.ts —— 快速切换 Agent：分区完整性 + 过期响应丢弃
//（Port B：loadHistory 走 session/history RPC——mock 为可手动 resolve 的
// deferred，stale 判定语义不变：旧请求的迟到响应被丢弃）
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 手动 resolve 的 RPC deferred（按调用序排队） */
const rpcCalls: Array<{ params: any; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) => {
      if (method !== 'session/history') return Promise.reject(new Error(`unexpected rpc ${method}`));
      return new Promise((resolve, reject) => { rpcCalls.push({ params, resolve, reject }); });
    }),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => () => {}),
  },
}));

vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog, type DialogId } from '../src/utils/feed';

const A = 'alpha';
const B = 'beta';

function histRecords(list: Array<[id: string, role: string, content: string]>) {
  return list.map(([id, role, content]) => ({
    message_id: id, role: role === 'user' ? 'user' : 'assistant', content,
    ...(role !== 'user' ? { name: role === 'assistant' ? A : undefined } : {}),
    timestamp: new Date().toISOString(),
  }));
}
function histMsg(id: string, role: string, content: string, agent = A) {
  return { message_id: id, role: role === 'user' ? 'user' : 'assistant', content, ...(role !== 'user' ? { name: agent } : {}), timestamp: new Date().toISOString() };
}

describe('快速切换 Agent：分区完整性 + 过期历史响应丢弃（Port B）', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  it('A→B→A 连切：每个分区只含自己的消息，activeDialog 跟随选中', async () => {
    const feed = useFeedStore();
    const agents = useAgentStore();
    const idA = directDialog(A);
    const idB = directDialog(B);

    // 进入 A（loadHistory 发 RPC[0] → 手动响应）
    feed.loadHistory(idA, 'user', A);
    rpcCalls[0].resolve({ records: histRecords([['a1', 'user', '问A'], ['a2', 'assistant', '答A']]) });
    await Promise.resolve();
    // A 开始流式
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: A, sender: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: 'A在流式' }, { agent: A, conversationId: A, sender: 'user' }]);

    // 0.5s 后切到 B
    agents.activeAgentId = B;
    feed.loadHistory(idB, 'user', B);
    expect(feed.activeDialogId).toBe(idB);

    // B 加载期间 A 的流式事件继续到达 → 只进 A 分区
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '（继续）' }, { agent: A, conversationId: A, sender: 'user' }]);
    feed.ingestFrame('loop/after-step', [A, { text: 'A在流式（继续）', reasoning: '' }, { conversationId: A, sender: 'user' }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: A, sender: 'user' }, { text: 'A在流式（继续）', finish: 'stop' }]);

    const rawA = feed.getRaw(idA).filter(m => m.agent_id === A && m.role !== 'user');
    expect(rawA.length).toBe(2); // 历史答A + 流式产物
    expect(rawA[1].content).toBe('A在流式（继续）');
    expect(feed.getRaw(idB).length).toBe(0); // B 分区干净：未被 A 的任何内容污染

    // B 历史到达（RPC[1]）
    rpcCalls[1].resolve({
      records: [
        { message_id: 'b1', role: 'user', content: '问B', timestamp: new Date().toISOString() },
        { message_id: 'b2', role: 'assistant', content: '答B', name: B, timestamp: new Date().toISOString() },
      ],
    });
    await Promise.resolve();
    expect(feed.getRaw(idB).some(m => m.agent_id === A)).toBe(false);
    expect(feed.getRaw(idB).some(m => m.persistedMsgId === 'b2')).toBe(true);

    // 再切回 A：立即显示 A 分区
    agents.activeAgentId = A;
    expect(feed.activeDialogId).toBe(idA);
    expect(feed.getRaw(idA).some(m => m.persistedMsgId === 'a2')).toBe(true);
    expect(feed.getRaw(idA).some(m => m.agent_id === B)).toBe(false);
  });

  it('快速连点同一 Agent：旧请求的迟到响应被丢弃，新响应作为首屏合并', async () => {
    const feed = useFeedStore();
    const id: DialogId = directDialog(A);

    // 第一次点击（RPC[0] = R1 在途）
    feed.loadHistory(id, 'user', A);
    // 0.5s 内再点（RPC[1] = R2，重置 offset）——R1 仍在途
    feed.loadHistory(id, 'user', A);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[1].params.offset).toBe(0); // R2 重置游标

    const d = feed.getDialog(id)!;

    // R1 的迟到响应先到（大历史量查询慢）→ 丢弃，分区不动
    rpcCalls[0].resolve({ records: [histMsg('stale', 'assistant', '过期分页')] });
    await Promise.resolve();
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'stale')).toBe(false);
    expect(d.status).toBe('loading'); // 旧响应不负责回落状态

    // R2 的新响应后到 → 首屏合并
    rpcCalls[1].resolve({ records: [histMsg('fresh', 'assistant', '最新首屏')] });
    await Promise.resolve();
    expect(d.status).toBe('ready');
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'fresh')).toBe(true);
  });
});
