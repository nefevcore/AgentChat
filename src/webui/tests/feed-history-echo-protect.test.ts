// ============================================================
// feed-history-echo-protect.test.ts —— 首屏整体替换不吞未落盘 viewer 消息
//
// 背景 bug（2026-12 反馈 #1）：新会话发送消息 → Agent 开始回复 → 切到
// 其他会话再切回：用户消息丢失。
//
// 根因：sendMessage 本地 append 的 viewer 气泡，在切回触发的
// loadHistory 首屏【整体替换】中被吃掉——后端入站落盘是异步的
// （record 入队 + flushBestEffort fire-and-forget），首次 flush 前
// records() 读不到该行；streamingTail 保护范围是「最后一条 viewer 消息
// 之后」，viewer 消息本身永不在保护范围。
//
// 不变量：incoming 无同内容行时，本地 viewer 气泡必须在替换后存活
//（内容比对规格与 showOwnEcho 一致：splitAttachmentLines 剥附件行）；
// incoming 有同内容行时不双卡（persistedMsgId 去重照常生效）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 手动 resolve 的 RPC deferred（历史首屏场景用） */
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

describe('mergeHistory 首屏：未落盘 viewer 消息保护', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });

  it('run 进行中切回：incoming 不含用户消息（未落盘窗口）→ 本地气泡存活', async () => {
    const feed = cores.feed;
    const id = directDialog(A);

    // ① 发送（本地 append）+ Agent 开始回复（分区收到流式事件）
    feed.append(id, { id: 'u1', role: 'agent', content: '你好', timestamp: Date.now(), agent_id: 'user' });
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: A, sender: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '回复中' }, { agent: A, conversationId: A, sender: 'user' }]);

    // ② 切走再切回 → loadHistory 首屏；后端用户行尚未落盘（异步 flush
    //    窗口）——incoming 只带回 journal 步行
    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm1', role: 'agent', content: '回复中', timestamp: new Date().toISOString(),
          steps: [{ content: '回复中', toolCalls: [], ts: Date.now() }], partial: true, run: 'r1' },
      ],
    });
    await Promise.resolve();

    // ③ 本地 viewer 消息存活（修复前：整体替换吃掉 → 只剩 agent 流式行）
    const raw = feed.getRaw(id);
    const userMsgs = raw.filter(m => m.agent_id === 'user');
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].content).toBe('你好');
  });

  it('run 空闲切回：incoming 已含同内容用户行（落盘完成）→ 不双卡', async () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.append(id, { id: 'u1', role: 'agent', content: '你好', timestamp: Date.now(), agent_id: 'user' });

    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm1', role: 'user', content: '你好', timestamp: new Date().toISOString() },
        { message_id: 'm2', role: 'agent', content: '回复完成', timestamp: new Date().toISOString(),
          steps: [{ content: '回复完成', toolCalls: [], ts: Date.now() }] },
      ],
    });
    await Promise.resolve();

    const raw = feed.getRaw(id);
    const userMsgs = raw.filter(m => m.agent_id === 'user');
    expect(userMsgs.length).toBe(1); // incoming 行在场：本地行不再拼回
    expect(userMsgs[0].persistedMsgId).toBe('m1');
  });

  it('附件行规格对齐：本地合成形（含 [附件] 行）与历史剥离形判同一条消息', async () => {
    const feed = cores.feed;
    const id = directDialog(A);

    // 本地上屏是发送时合成形（正文 + [附件] 路径行）；历史行已剥离为
    // content + attachments——比对须两侧同走 splitAttachmentLines
    // （合法 ref = files/ 前缀上传路径，见 isAttachmentRef 安全门）
    feed.append(id, { id: 'u1', role: 'agent', content: '看看这个\n[附件] files/abc123.md', timestamp: Date.now(), agent_id: 'user' });

    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm1', role: 'user', content: '看看这个', timestamp: new Date().toISOString(),
          attachments: [{ kind: 'file', ref: 'files/abc123.md' }] },
      ],
    });
    await Promise.resolve();

    const raw = feed.getRaw(id);
    const userMsgs = raw.filter(m => m.agent_id === 'user');
    expect(userMsgs.length).toBe(1); // 剥离后同文 → 历史行胜出（带 attachments chips）
  });
});
