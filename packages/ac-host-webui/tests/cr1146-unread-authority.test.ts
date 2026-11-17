// cr-1146 回归锁：未读服务端权威源 RPC 面——mark-read 水位单调/幂等、
// session/history 首屏旁带 unreadCount/readMark、session/unread 批量对账、
// group/history 首屏旁带。真 WS 链路（bootHostWeb → rpc 往返）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { RPC_CALL, RPC_RESULT } from 'ac-ws-protocol';
import { bootHostWeb, type HostWebResult } from '../src/host-web.ts';
import { LedgerWriter, sessionDir } from 'ac-ledger';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-unread-auth-' + process.pid);
let host: HostWebResult | null = null;
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(async () => {
  if (host !== null) { await host.close(); host = null; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function rpc<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
  const requestId = 't-' + Math.random().toString(36).slice(2);
  return new Promise<T>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const m = JSON.parse(String(data)) as { type?: string; data?: { requestId?: string; ok?: boolean; result?: unknown; error?: string } };
        if (m.type === RPC_RESULT && m.data?.requestId === requestId) {
          ws.off('message', onMessage);
          if (m.data.ok) resolve(m.data.result as T);
          else reject(new Error(m.data.error ?? 'rpc 失败'));
        }
      } catch { /* 非 JSON 帧忽略 */ }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: RPC_CALL, data: { method, requestId, params } }));
  });
}

async function openWs(): Promise<WebSocket> {
  const ws = new WebSocket('ws://127.0.0.1:' + host!.port + '/ws');
  await new Promise<void>((res) => ws.once('open', () => res()));
  return ws;
}

function seedAgent(id: string): void {
  // cr-1036 批3：身份 fixture 走 v3 写口（直写 config.json 读窗退役）
  writeAgentConfig(ROOT, { id, model: 'mock' });
}

describe('未读服务端权威源（cr-1146）', () => {
  it('首屏旁带 unreadCount：无读位 = 全量；mark-read 后归零；新行补计', async () => {
    seedAgent('alpha');
    host = await bootHostWeb({ dataRoot: ROOT });
    const ws = await openWs();
    const conv = 'unread-e2e';
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '第一稿', agent_id: 'alpha', uuid: conv, run: 'r1', requestId: 'rq1' });
    await w.deliver({ role: 'agent', content: '第二稿', agent_id: 'alpha', uuid: conv, run: 'r2', requestId: 'rq2' });
    // 入站 user 行不投事实——unreadCount 只数 agent 发言
    await w.deliver({ role: 'agent', content: '用户说', agent_id: 'user', uuid: conv, requestId: 'rq-u' });

    const first = await rpc<{ records: unknown[]; unreadCount?: number; readMark?: { seq?: number } }>(ws, 'session/history', { conversationId: conv });
    expect(first.unreadCount).toBe(2); // 两轮回复
    expect(first.readMark).toBeUndefined(); // 无读位

    // mark-read（seq 锚）：水位落定 → 未读归零
    const marked = await rpc<{ mark: { seq?: number; messageId?: string } }>(ws, 'session/mark-read', { conversationId: conv, seq: 2, messageId: 'm-2' });
    expect(marked.mark.seq).toBe(2);
    const after = await rpc<{ unreadCount?: number; readMark?: { seq?: number } }>(ws, 'session/history', { conversationId: conv });
    expect(after.unreadCount).toBe(0);
    expect(after.readMark?.seq).toBe(2);

    // 页面关闭期间新回复：重开首屏正确补计（本计划的验证目标）
    await w.deliver({ role: 'agent', content: '第三稿', agent_id: 'alpha', uuid: conv, run: 'r3', requestId: 'rq3' });
    const resumed = await rpc<{ unreadCount?: number }>(ws, 'session/history', { conversationId: conv });
    expect(resumed.unreadCount).toBe(1);

    // mark-read 幂等：重复低水位调用不回退（seq 2 < 已存 2 同值幂等；seq 1 拒收）
    const idem = await rpc<{ mark: { seq?: number } }>(ws, 'session/mark-read', { conversationId: conv, seq: 2, messageId: 'm-2' });
    expect(idem.mark.seq).toBe(2);
    const lower = await rpc<{ mark: { seq?: number } }>(ws, 'session/mark-read', { conversationId: conv, seq: 1, messageId: 'm-1' });
    expect(lower.mark.seq).toBe(2); // 单调取大——低水位被拒

    // 上翻不带未读旁带（分页语义）
    const paged = await rpc<{ unreadCount?: number }>(ws, 'session/history', { conversationId: conv, offset: 1, limit: 1 });
    expect(paged.unreadCount).toBeUndefined();
    ws.close();
  }, 30_000);

  it('session/unread 批量对账：含无读位会话；群成员流不入会话轴', async () => {
    seedAgent('alpha');
    seedAgent('beta');
    host = await bootHostWeb({ dataRoot: ROOT });
    const ws = await openWs();
    const conv = 'batch-conv';
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '稿', agent_id: 'alpha', uuid: conv, run: 'r1', requestId: 'rq1' });
    // 群配置在场（群轴过滤判据 = meta/groups 有该 gid）+ 群成员流（首段 = gid）
    await rpc<unknown>(ws, 'group/create', { name: '测试群', members: ['beta'], id: 'g-1' });
    const gw = new LedgerWriter(sessionDir(ROOT, 'beta', 'g-1~beta'), { participants: ['beta', 'user'], kind: 'group' });
    await gw.deliver({ role: 'agent', content: '群消息', agent_id: 'beta', uuid: 'g-1~beta', requestId: 'g-rq1' });

    const batch = await rpc<{ conversations: Array<{ conversationId: string; unreadCount: number }> }>(ws, 'session/unread', {});
    const ids = batch.conversations.map((c) => c.conversationId);
    expect(ids).toContain(conv);
    expect(ids).not.toContain('g-1~beta'); // 群流键不进会话轴
    expect(ids).not.toContain('g-1'); // 群未读在 group 轴
    const target = batch.conversations.find((c) => c.conversationId === conv)!;
    expect(target.unreadCount).toBe(1);
    ws.close();
  }, 30_000);

  it('group/history 首屏旁带：user 发言不计、member 回复计数、mark-read 归零', async () => {
    seedAgent('alpha');
    host = await bootHostWeb({ dataRoot: ROOT });
    const ws = await openWs();
    const gid = 'room-a';
    const member = 'alpha';
    const key = gid + '~' + member;
    const w = new LedgerWriter(sessionDir(ROOT, member, key), { participants: [member, 'user'], kind: 'group' });
    // user 群发：扇出保 sender 身份——成员流行 agent_id=user（不计）
    await w.deliver({ role: 'agent', content: '大家好', agent_id: 'user', uuid: key, requestId: 'g-rq-u' });
    // member 回复（send_group 落流：agent_id=member）
    await w.deliver({ role: 'agent', content: '收到', agent_id: member, uuid: key, requestId: 'g-rq-m' });

    await rpc<unknown>(ws, 'group/create', { name: '测试群', members: [member], id: gid }).catch(() => undefined);
    const first = await rpc<{ messages: unknown[]; unreadCount?: number }>(ws, 'group/history', { groupId: gid });
    expect(first.messages.length).toBe(2);
    expect(first.unreadCount).toBe(1); // user 行不计，member 行计

    await rpc<unknown>(ws, 'session/mark-read', { conversationId: gid, messageId: 'g-rq-m' });
    const after = await rpc<{ unreadCount?: number; readMark?: { messageId?: string } }>(ws, 'group/history', { groupId: gid });
    expect(after.unreadCount).toBe(0);
    expect(after.readMark?.messageId).toBe('g-rq-m');

    // 上翻不带旁带
    const paged = await rpc<{ unreadCount?: number }>(ws, 'group/history', { groupId: gid, offset: 1 });
    expect(paged.unreadCount).toBeUndefined();
    ws.close();
  }, 30_000);

  it('多端读位收敛（批 4）：A 端 mark-read → B 端（新连接）批量对账未读为 0；后读不回退先读', async () => {
    seedAgent('alpha');
    host = await bootHostWeb({ dataRoot: ROOT });
    const conv = 'multi-end';
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '稿一', agent_id: 'alpha', uuid: conv, run: 'r1', requestId: 'rq1' });
    await w.deliver({ role: 'agent', content: '稿二', agent_id: 'alpha', uuid: conv, run: 'r2', requestId: 'rq2' });

    // A 端：读到 seq 2 → 水位落定
    const wsA = await openWs();
    await rpc<unknown>(wsA, 'session/mark-read', { conversationId: conv, seq: 2, messageId: 'm-2' });
    wsA.close();

    // B 端（新连接 = 另一端）：批量对账 → 未读 0（读位互通——本计划验证目标）
    const wsB = await openWs();
    const batch = await rpc<{ conversations: Array<{ conversationId: string; unreadCount: number }> }>(wsB, 'session/unread', {});
    const row = batch.conversations.find((c) => c.conversationId === conv)!;
    expect(row.unreadCount).toBe(0);

    // B 端后读带旧水位（seq 1）→ 不回退 A 端水位；再补一行 → 未读 = 1
    await rpc<unknown>(wsB, 'session/mark-read', { conversationId: conv, seq: 1, messageId: 'm-1' });
    await w.deliver({ role: 'agent', content: '稿三', agent_id: 'alpha', uuid: conv, run: 'r3', requestId: 'rq3' });
    const batch2 = await rpc<{ conversations: Array<{ conversationId: string; unreadCount: number }> }>(wsB, 'session/unread', {});
    const row2 = batch2.conversations.find((c) => c.conversationId === conv)!;
    expect(row2.unreadCount).toBe(1); // 水位仍在 seq 2——只第三稿未读
    wsB.close();
  }, 30_000);
});
