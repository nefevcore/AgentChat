// ============================================================
// feed-load-more.test.ts —— direct/single 上翻续拉分页回归
//
// 背景（2026-10 反馈：上翻无法加载历史，一直显示"加载历史消息中…"）：
// M19 对桶键统一后 direct 分区键 = pair:alpha|user（对桶键），而
// loadMoreHistory 曾把 parsed.key 当裸 agentId 直传——conversationId 被
// 叠成 bucketKey(viewer, alpha|user) = alpha|user~user，响应路由
// directDialog(对桶键) 落进不存在的分区 → mergeHistory 早退 → 原分区
// status 永久 'loading'（spinner 永挂 + 后续上翻全被守卫挡掉）。
// 本测试锁定续拉寻址与 loadHistory 同词表（session ?? 裸 agentId）。
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
    onWireAck: vi.fn(() => {}),
  },
}));

vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { directDialog, singleDialog } from '../src/utils/feed';

const A = 'alpha';

/** 一页记录：turns 轮（user+agent 成对），轮号 n（越大越新）——id/时间戳均由 n 派生 */
function page(turns: number, from: number, agent = A) {
  const out: Array<Record<string, unknown>> = [];
  for (let n = from; n < from + turns; n++) {
    const ts = new Date(1_700_000_000_000 + n * 60_000).toISOString();
    out.push({ message_id: `u${n}`, role: 'user', content: `问${n}`, agent_id: 'user', timestamp: ts });
    out.push({ message_id: `a${n}`, role: 'agent', content: `答${n}`, agent_id: agent, timestamp: ts });
  }
  return out;
}

async function flush(ticks = 4) { for (let i = 0; i < ticks; i++) await Promise.resolve(); }

describe('上翻续拉分页（direct 对桶 / single）', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
  });

  it('direct：续拉寻址与首屏同词表（conversationId=对桶键、offset=已服务条数），older 页前插且 status 回落', async () => {
    const feed = cores.feed;
    cores.roster.activeAgentId.value = A;
    const dialog = directDialog(A); // pair:alpha|user

    // 首屏：6 轮（12 条，≥5 条 viewer 消息 → hasMore）
    feed.loadHistory(dialog, 'user', A);
    expect(rpcCalls[0].params).toMatchObject({ conversationId: 'alpha~user', offset: 0, limit: 50 });
    rpcCalls[0].resolve({ records: page(6, 100) });
    await flush();
    const d = feed.getDialog(dialog)!;
    expect(d.status).toBe('ready');
    expect(feed.hasMoreHistory).toBe(true);
    expect(feed.loadingHistory).toBe(false);

    // 上翻续拉：conversationId 不得叠对桶键（alpha|user~user）、offset = 首屏已服务 12 条
    feed.loadMoreHistory(dialog);
    expect(rpcCalls[1].params).toMatchObject({ conversationId: 'alpha~user', offset: 12, limit: 50 });
    rpcCalls[1].resolve({ records: page(6, 50) });
    await flush();
    // 修复前：响应路由进不存在的 pair:alpha|user|user 分区 → mergeHistory
    // 早退 → 本分区 status 永久 'loading'（spinner 永挂）
    expect(d.status).toBe('ready');
    expect(feed.loadingHistory).toBe(false);
    const raw = feed.getRaw(dialog);
    // older 页前插（轮 50 在轮 100 之前），且两页都在
    expect(raw.findIndex(m => m.persistedMsgId === 'u50')).toBeGreaterThanOrEqual(0);
    expect(raw.findIndex(m => m.persistedMsgId === 'u50'))
      .toBeLessThan(raw.findIndex(m => m.persistedMsgId === 'u100'));
    // 不产生幻影分区（对桶键再叠加的 3 段键）
    expect(Object.keys(feed.dialogs).some(k => k.split('|').length > 2)).toBe(false);

    // 再翻一页（offset 推进到 24）；短页（<5 条 viewer）→ hasMore 收口
    feed.loadMoreHistory(dialog);
    expect(rpcCalls[2].params).toMatchObject({ conversationId: 'alpha~user', offset: 24, limit: 50 });
    rpcCalls[2].resolve({ records: page(2, 10) });
    await flush();
    expect(d.status).toBe('ready');
    expect(feed.hasMoreHistory).toBe(false);
    expect(feed.getRaw(dialog).some(m => m.persistedMsgId === 'u10')).toBe(true);
  });

  it('single：续拉按 session 寻址（conversationId=sid、offset=已服务条数）', async () => {
    const feed = cores.feed;
    const sid = 'sess-1';
    feed.setActiveSingle(sid, A);
    const dialog = singleDialog(sid);

    feed.loadHistory(dialog, 'user', A, sid);
    expect(rpcCalls[0].params).toMatchObject({ conversationId: sid, offset: 0, limit: 50 });
    rpcCalls[0].resolve({ records: page(5, 100) });
    await flush();
    const d = feed.getDialog(dialog)!;
    expect(d.status).toBe('ready');
    expect(feed.hasMoreHistory).toBe(true);

    feed.loadMoreHistory(dialog);
    expect(rpcCalls[1].params).toMatchObject({ conversationId: sid, offset: 10, limit: 50 });
    rpcCalls[1].resolve({ records: page(1, 50) });
    await flush();
    expect(d.status).toBe('ready');
    expect(feed.loadingHistory).toBe(false);
    expect(feed.hasMoreHistory).toBe(false);
    expect(feed.getRaw(dialog).some(m => m.persistedMsgId === 'u50')).toBe(true);
  });

  it('single：机制驱动会话（页内 0 条 viewer 消息）服务端 hasMore 回显优先——上翻不被误判挡死', async () => {
    // 2026-09 反馈：性能优化后 single 只加载尾部消息，上翻无法加载更多。
    // 根因：hasMore 用「页内 viewer 消息数 ≥5」启发式判定——机制驱动会话
    //（timer/goal/子 Agent 接力）尾部整页可无 viewer 消息 → 误判 false →
    // 上翻 triggerLoadMore 被 !hasMore 守卫挡死。服务端 M16 分页早已回显
    // hasMore（原始记录口径 offset+limit < total）——本用例锁定其优先级。
    const feed = cores.feed;
    const sid = 'sess-mech';
    feed.setActiveSingle(sid, A);
    const dialog = singleDialog(sid);

    // 首屏：一页机制消息（全部 agent 行，0 条 viewer）
    const mechPage = Array.from({ length: 40 }, (_, i) => ({
      message_id: `m${i}`,
      role: 'agent',
      content: `机制推进 ${i}`,
      agent_id: A,
      timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    }));
    feed.loadHistory(dialog, 'user', A, sid);
    rpcCalls[0].resolve({ records: mechPage, total: 130, hasMore: true });
    await flush();
    // 旧启发式：40 条里 0 条 viewer → hasMore=false（错）；服务端回显 true 胜出
    expect(feed.hasMoreHistory).toBe(true);

    // 上翻续拉正常放行（寻址与 offset 推进同既有词表）
    feed.loadMoreHistory(dialog);
    expect(rpcCalls[1].params).toMatchObject({ conversationId: sid, offset: 40, limit: 50 });
    rpcCalls[1].resolve({ records: mechPage.slice(0, 10), total: 130, hasMore: false });
    await flush();
    expect(feed.hasMoreHistory).toBe(false); // 拉尽：服务端口径收口
  });
});
