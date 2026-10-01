// ============================================================
// feed-prefix-absorb-gates.test.ts —— mergeHistory 前缀对齐
// 身份门/空载门回归（2026-10-02 吸收事故）
//
// 背景 bug：悬挂 run（进程卡死、无收尾帧）+ 空流式占位窗口内切走再
// 切回——历史首屏的用户落盘行（中性格式 role:'agent' + agent_id='user'）
// 被内容前缀互验误吸收进 Agent 空占位：空占位 body 恒为 '\u0000'，是
// 任何历史 agent 行的前缀，互验退化为全域命中。表现为 Agent 气泡显示
// 与用户气泡完全相同的内容。
//
// 修复不变量（前缀路径两道门；stepId 键控路径不受影响）：
//   · 身份门：live.agent_id ≠ 历史行 agent_id → 永不吸收；
//   · 空载门：占位或历史行无内容 → 无对齐证据，不吸收（宁重不丢）；
//   · 同身份非空且互为前缀 → 吸收照旧（2026-09-21 反馈 #4 断线重连
//     双卡修复不回归）。
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
    onWireAck: vi.fn(() => {}),
  },
}));
vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { singleDialog } from '../src/utils/feed';

const SID = 'sess-hung';
const A = '__standard__';
const USER_TEXT = '手机端使用反馈';

/** 分区预置：本地用户气泡 + Agent 流式占位（悬挂 run 直播形态） */
function seed(feed: SessionCores['feed'], placeholderContent: string): void {
  const id = singleDialog(SID);
  feed.append(id, { id: 'u-local', role: 'agent', content: USER_TEXT, timestamp: Date.now(), agent_id: 'user' });
  feed.append(id, { id: 'asst-live', role: 'agent', content: placeholderContent, isStreaming: true, timestamp: Date.now(), agent_id: A });
}

/** 首屏响应（journal 活投影行集）落定 */
async function flushFirstPage(records: unknown[]): Promise<void> {
  rpcCalls[0].resolve({ records });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('mergeHistory 前缀对齐：身份门 + 空载门', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
  });

  it('空占位 + 用户落盘行 → 不吸收（事故形态）：用户行存活、占位仍空', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    seed(feed, '');
    feed.loadHistory(id, 'user', A, SID);
    await flushFirstPage([
      { message_id: 'mu', role: 'user', content: USER_TEXT, timestamp: new Date().toISOString() },
    ]);
    const raw = feed.getRaw(id);
    const users = raw.filter(m => m.agent_id === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe(USER_TEXT);
    expect(raw.find(m => m.id === 'asst-live')?.content).toBe('');
  });

  it('空占位 + 同 Agent 历史步行 → 步行保留（宁重不丢，收束重拉拉直）', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    seed(feed, '');
    feed.loadHistory(id, 'user', A, SID);
    await flushFirstPage([
      { message_id: 'mu', role: 'user', content: USER_TEXT, timestamp: new Date().toISOString() },
      { message_id: 'ms', role: 'agent', agent_id: A, content: '已完成的部分回复', timestamp: new Date().toISOString() },
    ]);
    const raw = feed.getRaw(id);
    expect(raw.some(m => m.persistedMsgId === 'ms' && m.content === '已完成的部分回复')).toBe(true);
    expect(raw.find(m => m.id === 'asst-live')?.content).toBe('');
  });

  it('身份门：占位非空、用户行为其前缀 → 不跨身份吸收（用户行不丢）', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    seed(feed, USER_TEXT + '（已收到，正在处理）');
    feed.loadHistory(id, 'user', A, SID);
    await flushFirstPage([
      { message_id: 'mu', role: 'user', content: USER_TEXT, timestamp: new Date().toISOString() },
    ]);
    expect(feed.getRaw(id).filter(m => m.agent_id === 'user')).toHaveLength(1);
  });

  it('同身份非空互为前缀 → 吸收照旧（2026-09-21 #4 双卡修复不回归）', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    seed(feed, '回复中');
    feed.loadHistory(id, 'user', A, SID);
    await flushFirstPage([
      { message_id: 'mu', role: 'user', content: USER_TEXT, timestamp: new Date().toISOString() },
      { message_id: 'ms', role: 'agent', agent_id: A, content: '回复中完成', timestamp: new Date().toISOString() },
    ]);
    const raw = feed.getRaw(id);
    expect(raw.some(m => m.persistedMsgId === 'ms')).toBe(false); // 历史行被吸收不双卡
    expect(raw.find(m => m.id === 'asst-live')?.content).toBe('回复中完成'); // 占位拿到全量
  });
});
