// ============================================================
// feed-replay-order.test.ts —— 运行中刷新回放顺序：注入行不坠尾
//
// 背景 bug（2026-12 顺序反馈）：journal-inject 投影行 timestamp 恒为
// "读取时刻"（records() 每次读都是 now）——刷新时注入行恒最新，前端
// toHistoryMessages 末尾按 ts 稳定排序后 [step1, step2, inject, step3]
// 显示成 [step1, step2, step3, inject]（注入被挤到最后）。
//
// 修复：注入行 timestamp 用落 journal 时的注入时刻 ts（与步行同款）。
// 本文件钉住：records() 活投影里注入行 timestamp = journal 行的 ts，
// 前端排序后注入行回到步间真实位置。
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

describe('运行中刷新回放顺序：注入行回到步间真实位置', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });

  it('注入行 ts 在 step2 与 step3 之间 → 排序后顺序为 [user, step1, step2, inject, step3]', async () => {
    const feed = cores.feed;
    const id = directDialog(A);
    const now = Date.now();

    // 服务端 records() 活投影形态（修复后）：journal 行按落盘真实序，
    // 注入行 timestamp = 注入时刻（步间），步行 timestamp = 步收口时刻
    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm0', role: 'user', content: '开始', timestamp: new Date(now - 10000).toISOString() },
        { message_id: '', role: 'agent', content: 'step1', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 8000).toISOString(),
          steps: [{ content: 'step1', reasoning: '思1', ts: now - 8000, toolCalls: [] }] },
        { message_id: '', role: 'agent', content: 'step2', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 6000).toISOString(),
          steps: [{ content: 'step2', reasoning: '思2', ts: now - 6000, toolCalls: [] }] },
        { message_id: '', role: 'agent', content: '中途插入的问题', agent_id: 'user', injected: true, run: 'r1', timestamp: new Date(now - 5000).toISOString() },
        { message_id: '', role: 'agent', content: 'step3', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 3000).toISOString(),
          steps: [{ content: 'step3', reasoning: '思3', ts: now - 3000, toolCalls: [] }] },
      ],
    });
    await Promise.resolve();

    const raw = feed.getRaw(id);
    // 渲染序（rawMessages 顺序）：注入行必须落在 step2 与 step3 之间
    const bodies = raw.map((m: any) => m.content);
    const iS2 = bodies.indexOf('step2');
    const iInj = bodies.indexOf('中途插入的问题');
    const iS3 = bodies.indexOf('step3');
    expect(iS2).toBeGreaterThan(-1);
    expect(iInj).toBeGreaterThan(-1);
    expect(iS3).toBeGreaterThan(-1);
    expect(iS2).toBeLessThan(iInj);
    expect(iInj).toBeLessThan(iS3);
  });
});
