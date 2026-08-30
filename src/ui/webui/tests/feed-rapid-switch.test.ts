// ============================================================
// feed-rapid-switch.test.ts —— 快速切换 Agent 回归（0.5s 连点场景）
//
// 背景 bug：快速切换 Agent 会话时偶发「新 Agent 会话未加载、旧 Agent 的
// 会话驻留主窗口」（无法稳定复现）。store 层两条不变量在此钉住：
//   ① 分区完整性：切换只改 activeDialogId 指向，事件按 dialogId 路由，
//      A 的流式事件绝不落进 B 的分区（驻留 = 选中未变/分区被污染，二者
//      都能被本测试证伪）；
//   ② 历史响应按 requestId 丢弃过期在途响应：快速连点同一 Agent 会产生
//      多个在途 history.request，大历史量时响应到达序 ≠ 发送序——旧响应
//      若被当作首屏合并，会把过期分页写进刚重置的分区（错误内容闪现）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('../src/stores/websocket', () => ({
  useWebSocketStore: () => ({
    init: vi.fn(),
    send: sendMock,
    onMessage: vi.fn(() => () => {}),
    onConnect: vi.fn(() => () => {}),
  }),
}));

vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog } from '../src/utils/feed';
import type { DialogId } from '../src/utils/feed';

/** 取第 n 个 history.request 的载荷（按发送序） */
function histReq(n: number): any {
  const calls = sendMock.mock.calls.filter(([t]: any[]) => t === 'history.request');
  return calls[n]?.[1];
}

const A = 'alpha';
const B = 'beta';

function histMsg(id: string, role: string, content: string) {
  return { message_id: id, role, content, agent_id: role === 'user' ? 'user' : A, timestamp: new Date().toISOString() };
}

describe('快速切换 Agent：分区完整性 + 过期历史响应丢弃', () => {
  beforeEach(() => {
    sendMock.mockClear();
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  it('A→B→A 连切：每个分区只含自己的消息，activeDialog 跟随选中', () => {
    const feed = useFeedStore();
    const agents = useAgentStore();
    const idA = directDialog(A);
    const idB = directDialog(B);

    // 进入 A（列表点击时序：loadHistory 建分区 → 响应）
    feed.loadHistory(idA, 'user', A);
    feed.ingest('history.response', {
      agentId: A, requestId: histReq(0).requestId,
      messages: [histMsg('a1', 'user', '问A'), histMsg('a2', 'assistant', '答A')],
    });
    // A 开始流式
    feed.ingest('chat.step.start', { agentId: A });
    feed.ingest('chat.message.update', { agentId: A, delta: 'A在流式' });

    // 0.5s 后切到 B
    agents.activeAgentId = B;
    feed.loadHistory(idB, 'user', B);
    expect(feed.activeDialogId).toBe(idB);

    // B 加载期间 A 的流式事件继续到达 → 只进 A 分区
    feed.ingest('chat.message.update', { agentId: A, delta: '（继续）' });
    feed.ingest('chat.step.end', { agentId: A, content: 'A在流式（继续）' });

    const rawA = feed.getRaw(idA).filter(m => m.agent_id === A && m.role !== 'user');
    expect(rawA.length).toBe(2); // 历史答A + 流式占位
    expect(rawA[1].content).toBe('A在流式（继续）');
    expect(feed.getRaw(idB).length).toBe(0); // B 分区干净：未被 A 的任何内容污染

    // B 历史到达
    feed.ingest('history.response', {
      agentId: B, requestId: histReq(1).requestId,
      messages: [
        { message_id: 'b1', role: 'user', content: '问B', agent_id: 'user', timestamp: new Date().toISOString() },
        { message_id: 'b2', role: 'assistant', content: '答B', agent_id: B, timestamp: new Date().toISOString() },
      ],
    });
    expect(feed.getRaw(idB).some(m => m.agent_id === A)).toBe(false);
    expect(feed.getRaw(idB).some(m => m.persistedMsgId === 'b2')).toBe(true);

    // 再切回 A：立即显示 A 分区（「旧会话驻留」= 选中未变；此处证伪）
    agents.activeAgentId = A;
    expect(feed.activeDialogId).toBe(idA);
    expect(feed.getRaw(idA).some(m => m.persistedMsgId === 'a2')).toBe(true);
    expect(feed.getRaw(idA).some(m => m.agent_id === B)).toBe(false);
  });

  it('快速连点同一 Agent：旧请求的迟到响应被丢弃，新响应作为首屏合并', () => {
    const feed = useFeedStore();
    const id: DialogId = directDialog(A);

    // 第一次点击（发出请求 R1）
    feed.loadHistory(id, 'user', A);
    const r1 = histReq(0).requestId;
    // 0.5s 内再点（发出请求 R2，重置 offset）——R1 仍在途
    feed.loadHistory(id, 'user', A);
    const r2 = histReq(1).requestId;
    expect(r1).not.toBe(r2);

    const d = feed.getDialog(id)!;

    // R1 的迟到响应先到（大历史量查询慢）→ 丢弃，分区不动
    feed.ingest('history.response', {
      agentId: A, requestId: r1,
      messages: [histMsg('stale', 'assistant', '过期分页')],
    });
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'stale')).toBe(false);
    expect(d.status).toBe('loading'); // 旧响应不负责回落状态

    // R2 的新响应后到 → 首屏合并
    feed.ingest('history.response', {
      agentId: A, requestId: r2,
      messages: [histMsg('fresh', 'assistant', '最新首屏')],
    });
    expect(d.status).toBe('ready');
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'fresh')).toBe(true);
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'stale')).toBe(false);
  });

  it('旧后端响应（无 requestId 回显）→ 放行（兼容降级）', () => {
    const feed = useFeedStore();
    const id: DialogId = directDialog(A);
    feed.loadHistory(id, 'user', A);
    feed.ingest('history.response', {
      agentId: A,
      messages: [histMsg('legacy', 'assistant', '旧后端响应')],
    });
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'legacy')).toBe(true);
  });
});
