// ============================================================
// feed-resume-user-anchor.test.ts —— resume 快照补合 user 掉底回归（cr-60）
//
// 背景 bug：run 进行中切回/刷新，历史首屏只带回 journal 活投影步（user 行
// flush 延迟未落盘）时，resume 快照的 userMessages 被 push 到分区尾部——
// 首条 user 消息渲染到已完成步之后（[steps, user, 续流步] 错序形态）。
// 修复：user 消息按 timestamp 定位插入（与 mergeHistory 首屏 anchor 保护
// 同语义），不再盲 push 尾部。
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ method: string; params: any; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) =>
      new Promise((resolve, reject) => { rpcCalls.push({ method, params, resolve, reject }); })),
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
import { singleDialog } from '../src/utils/feed';

const SID = 'sess-1';
const A = 'alpha';

describe('resume 快照补合：user 消息按 ts 定位插入（cr-60）', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
  });

  it('历史页只有 journal 步行（user 行未落盘）→ 快照 user 插在步前', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    // 快照先到（分区空 → 挂起等历史）；带 userMessages 的旧载荷形态
    feed.handleResume({
      active: true, session: SID, agentId: A,
      userMessages: [{ content: '首条用户消息', ts: Date.now() - 60_000 }],
      steps: [], content: '', thinking: '',
    });
    // 历史首屏：只有 journal 活投影步行（user 行 flush 延迟）
    feed.loadHistory(id, 'user', A, SID);
    expect(rpcCalls[0].method).toBe('session/history');
    rpcCalls[0].resolve({
      records: [
        { message_id: '', role: 'agent', agent_id: A, content: '',
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          partial: true, run: 'run-x',
          steps: [{ content: '', reasoning: 'step0 思考', stepId: 'run-x:0',
            ts: Date.now() - 30_000, toolCalls: [] }] },
      ],
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const turns = feed.getTurns(id).value;
    const iUser = turns.findIndex(t => t.agent_id === 'user');
    const iAgent = turns.findIndex(t => t.agent_id === A);
    expect(iUser).toBeGreaterThanOrEqual(0);
    expect(iAgent).toBeGreaterThanOrEqual(0);
    expect(iUser).toBeLessThan(iAgent);
  });
});