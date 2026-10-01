// ============================================================
// feed-converge-checkpoints.test.ts —— 收敛 checkpoint B+C 回归（cr-107）
//
// B·live 分区历史重入禁指纹短路：流式中/占位/未闭合工具行的首屏请求
//   不带 fingerprint——unchanged 会原样保留可能帧丢失的临时态；live 重入
//   一律全量，切回时点 = 确定性收敛点。
// C·悬挂流探针：streaming 分区静默超阈 → conversation/stats 权威判死活。
//   判死 → 关停临时态 + 强制收敛（force 禁指纹短路）；判活 → 基线顺延；
//   RPC 失败 → 不定罪。
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ method: string; params: any; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) => {
      if (method !== 'session/history' && method !== 'conversation/stats') {
        return Promise.reject(new Error(`unexpected rpc ${method}`));
      }
      return new Promise((resolve, reject) => { rpcCalls.push({ method, params, resolve, reject }); });
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

const SID = 'sess-conv';
const A = '__standard__';

function seedLivePartition(feed: SessionCores['feed']): void {
  const id = singleDialog(SID);
  // 悬挂 run 直播形态：本地用户行 + Agent 空占位 + 未闭合工具行 + streaming。
  // streaming 先置位再 append——探针挂在 bump() 里（append 触发），顺序反了
  // 探针不挂（直接赋值不走 bump），C 组用例会静默漏测。
  feed.ensureById(id).streaming = true;
  feed.append(id, { id: 'u1', role: 'agent', content: '你好', timestamp: Date.now(), agent_id: 'user' });
  feed.append(id, { id: 'asst1', role: 'agent', content: '', isStreaming: true, timestamp: Date.now(), agent_id: A });
  feed.append(id, { id: 't1', role: 'tool', content: '', tool_call_id: 'tc1', name: 'grep', timestamp: Date.now() });
  // 服务端已落盘的权威形态（假想 run 已死）：用户行 + 空占位关停后的收尾行
  const ts = new Date().toISOString();
  globalThis.__authority = [
    { message_id: 'mu', role: 'user', content: '你好', timestamp: ts },
    { message_id: 'ma', role: 'agent', agent_id: A, content: '(生成中断)', timestamp: ts },
  ];
}

declare global {
  // eslint-disable-next-line no-var
  var __authority: unknown[];
}

function resolveHistory(): void {
  const call = rpcCalls.find(c => c.method === 'session/history');
  call!.resolve({ records: globalThis.__authority });
}

describe('checkpoint-B：live 分区历史重入禁指纹短路', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    seedLivePartition(cores.feed);
  });

  it('live 分区切回 → 首屏请求不带 fingerprint（全量收敛）且权威行落地', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    // 预置指纹（模拟上次首屏成功）
    feed.ensureById(id).historyFingerprint = '100:200';
    feed.loadHistory(id, 'user', A, SID);
    await Promise.resolve();
    const histCall = rpcCalls.find(c => c.method === 'session/history');
    expect(histCall).toBeTruthy();
    expect(histCall!.params.fingerprint).toBeUndefined(); // B：live 禁短路
    resolveHistory();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const raw = feed.getRaw(id);
    expect(raw.some(m => m.persistedMsgId === 'ma')).toBe(true); // 权威收尾行在场
  });

  it('空闲分区切回 → 指纹短路照常（unchanged 轻载荷路径不回归）', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    // 清掉占位/工具行 → 空闲分区
    feed.setRaw(id, feed.getRaw(id).filter(m => m.id === 'u1'));
    feed.ensureById(id).streaming = false;
    feed.ensureById(id).historyFingerprint = '100:200';
    feed.loadHistory(id, 'user', A, SID);
    await Promise.resolve();
    const histCall = rpcCalls.find(c => c.method === 'session/history');
    expect(histCall!.params.fingerprint).toBe('100:200'); // 空闲：短路保留
    histCall!.resolve({ unchanged: true, fingerprint: '100:200' });
    await Promise.resolve();
    expect(feed.getRaw(id)).toHaveLength(1); // 本地保留
  });
});

describe('checkpoint-C：悬挂流探针（conversation/stats 权威判死活）', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    vi.useFakeTimers();
    cores = createSessionCores(wireFace);
    cores.feed.init();
    seedLivePartition(cores.feed);
    // single 分区的消息身份源 = 激活时登记的目标 Agent（_singleAgent）——
    // 不登记则 agentKeyOf 回落会话 id，stats 匹配永假（误判死）。
    cores.feed.setActiveSingle(SID, A);
  });

  it('静默超阈 + stats 判死 → 关停临时态 + 强制收敛（不带指纹）', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    feed.ensureById(id).historyFingerprint = '100:200';
    await vi.advanceTimersByTimeAsync(180_000);
    const stats = rpcCalls.find(c => c.method === 'conversation/stats');
    expect(stats).toBeTruthy();
    stats!.resolve({ running: [] }); // 登记表无此 run → 判死
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve(); await Promise.resolve();
    expect(feed.getDialog(id)?.streaming).toBe(false); // 临时态关停
    const histCall = rpcCalls.find(c => c.method === 'session/history');
    expect(histCall).toBeTruthy();
    expect(histCall!.params.fingerprint).toBeUndefined(); // 判死收敛 = force
    resolveHistory();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(feed.getRaw(id).some(m => m.persistedMsgId === 'ma')).toBe(true);
  });

  it('stats 判活（慢 run）→ 基线顺延，不关停不重拉', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    await vi.advanceTimersByTimeAsync(180_000);
    const stats = rpcCalls.find(c => c.method === 'conversation/stats');
    stats!.resolve({ running: [{ agentId: A, conversationId: SID }] }); // 仍活
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(feed.getDialog(id)?.streaming).toBe(true); // 未关停
    expect(rpcCalls.some(c => c.method === 'session/history')).toBe(false); // 无重拉
    // 顺延后继续静默 → 再探仍判死 → 收敛
    await vi.advanceTimersByTimeAsync(180_000);
    const stats2 = rpcCalls.filter(c => c.method === 'conversation/stats').at(-1);
    stats2!.resolve({ running: [] });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve(); await Promise.resolve();
    expect(rpcCalls.some(c => c.method === 'session/history')).toBe(true);
  });

  it('stats RPC 失败 → 不定罪（悬挂与断网不可区分）', async () => {
    const feed = cores.feed;
    const id = singleDialog(SID);
    await vi.advanceTimersByTimeAsync(180_000);
    const stats = rpcCalls.find(c => c.method === 'conversation/stats');
    stats!.reject(new Error('network'));
    await Promise.resolve(); await Promise.resolve();
    expect(feed.getDialog(id)?.streaming).toBe(true); // 不关停
    expect(rpcCalls.some(c => c.method === 'session/history')).toBe(false);
  });
});
