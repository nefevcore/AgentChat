// ============================================================
// feed-refresh-replay-steps.test.ts —— 运行中刷新：journal 步行回放
//
// 场景（2026-12 反馈 #3 后续）：run 进行中刷新页面——历史首屏带回
// journal-inject 行与 journal 步行（partial），resume 快照合入后续续流。
// 症状：回放只到 journal-inject，后续 step 不出现。
// 本文件钉住：步行（partial 行，带 steps[]）在历史首屏合并后必须渲染，
// 且与 resume 占位正确衔接（不吞步、不双卡）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';

describe('运行中刷新回放：journal 步行（partial）渲染与续流衔接', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });

  it('历史首屏含步行（partial）+ 注入行 → 步行全部渲染，不丢步', async () => {
    const feed = cores.feed;
    const id = directDialog(A);
    const now = Date.now();

    // 服务端 records() 活投影形态：用户消息 + inject 行 + 两步行（partial）
    // （步行 ts = 落盘时刻的步级 ts；injected 行 ts = 注入时刻）
    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm0', role: 'user', content: '开始', timestamp: new Date(now - 9000).toISOString() },
        { message_id: '', role: 'agent', content: '技能已注入', agent_id: 'user', injected: true, run: 'r1', timestamp: new Date(now - 8000).toISOString() },
        { message_id: '', role: 'agent', content: '第一步正文', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 5000).toISOString(),
          steps: [{ content: '第一步正文', reasoning: '第一步思考', ts: now - 5000, toolCalls: [] }] },
        { message_id: '', role: 'agent', content: '第二步正文', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 2000).toISOString(),
          steps: [{ content: '第二步正文', reasoning: '第二步思考', ts: now - 2000, toolCalls: [] }] },
      ],
    });
    await Promise.resolve();

    const raw = feed.getRaw(id);
    const stepBodies = raw.filter((m: any) => m.role === 'agent' && m.agent_id === A).map((m: any) => m.content);
    expect(stepBodies).toContain('第一步正文');
    expect(stepBodies).toContain('第二步正文');
  });

  it('resume 快照（运行中，steps 空）合入后：步行在场时占位复用尾步，不新建第二载体', async () => {
    const feed = cores.feed;
    const id = directDialog(A);
    const now = Date.now();

    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm0', role: 'user', content: '开始', timestamp: new Date(now - 9000).toISOString() },
        { message_id: '', role: 'agent', content: '第一步正文', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 5000).toISOString(),
          steps: [{ content: '第一步正文', reasoning: '第一步思考', ts: now - 5000, toolCalls: [] }] },
      ],
    });
    await Promise.resolve();

    // 运行中 resume（conversation/stats 命中——subscribeResume 最小快照形态）
    feed.handleResume({
      active: true, agentId: A, phase: 'message',
      content: '', thinking: '', label: '', toolCallId: '', toolName: '',
      steps: [], userMessages: [],
    });

    // 后续直播 delta 续流
    feed.ingestFrame('loop/step-started', [A, 1, [], { conversationId: A, sender: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '续' }, { agent: A, conversationId: A, sender: 'user' }]);

    const raw = feed.getRaw(id);
    const agentMsgs = raw.filter((m: any) => m.role === 'agent' && m.agent_id === A);
    // 第一步行 + 新流式占位（新步）——不吞步、不多卡
    expect(agentMsgs.length).toBe(2);
    expect(agentMsgs[0].content).toBe('第一步正文');
    expect(agentMsgs[1].isStreaming).toBe(true);
    expect(agentMsgs[1].content).toBe('续');
  });
});
