// ============================================================
// feed-context-dedup.test.ts —— 运行中切回：context 注入行不重复
//
// 背景 bug（2026-12 前端反馈）：agent 经 run_code 调 load_skill 后，
// session/context-injected 帧上屏一条直播 event 行（无锚）；切换会话
// 再返回时历史首屏带回 journal 活投影 context 行（message_id 空）——
// 两行都无有效去重键，live-wins 对齐只覆盖 tool/agent 行，双双存活
// = 同一技能注入显示两条「已加载技能 xxx」。
//
// 修复（injectionId 贯通）：事件帧 meta.injectionId → 直播行带
// persistedMsgId；活投影行/提升行 message_id 同锚。本文件钉住：
//   · 直播行带锚（persistedMsgId = injectionId）；
//   · 历史页同锚活投影行被 live-wins 前置去重（event 只剩一条）；
//   · 存量兜底：无锚直播行 + 无锚投影行按内容配额抵扣（一条留下）。
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

describe('运行中切回：context 注入行不重复（injectionId 同锚去重）', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });

  it('直播行带锚（persistedMsgId = injectionId）', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    // 后端事件帧（修复后）：meta 带 injectionId
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'skill', label: '已加载技能 demo', injectionId: 'ctx-1' }]);
    const evts = feed.getRaw(id).filter((m: any) => m.role === 'event');
    expect(evts).toHaveLength(1);
    expect(evts[0].persistedMsgId).toBe('ctx-1');
    expect(evts[0].id).toBe('ctx-1');
    expect(evts[0].content).toBe('已加载技能 demo');
  });

  it('旧后端帧（无 injectionId）：回落本地 id，行为同旧', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'skill', label: '已加载技能 demo' }]);
    const evts = feed.getRaw(id).filter((m: any) => m.role === 'event');
    expect(evts).toHaveLength(1);
    expect(evts[0].persistedMsgId).toBeUndefined();
  });

  it('run 进行中切回：历史页同锚活投影行被去重（event 只剩直播一条）', async () => {
    const feed = cores.feed;
    const id = directDialog(A);
    const now = Date.now();

    // 直播态：run-started 点亮 streaming + 直播思考步 + 带锚 event 行
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: `${A}~user`, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: A, conversationId: `${A}~user` } }, { reasoning: '思考中' }, { agent: A, conversationId: `${A}~user` }]);
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'skill', label: '已加载技能 demo', injectionId: 'ctx-9' }]);

    // 切回：历史首屏带回 records() 活投影（journal 行投影——修复后
    // message_id = injectionId 同锚；此前恒空串 = 双行并存根因）
    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm0', role: 'user', content: '开始', timestamp: new Date(now - 10000).toISOString() },
        { message_id: '', role: 'agent', content: 'step1', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 8000).toISOString(),
          steps: [{ content: 'step1', reasoning: '思考中', ts: now - 8000, toolCalls: [] }] },
        { message_id: 'ctx-9', role: 'context', content: '<skill_content>正文</skill_content>', source: 'skill', label: '已加载技能 demo', agent_id: A, injected: true, run: 'r1', timestamp: new Date(now - 5000).toISOString() },
      ],
    });
    await Promise.resolve();

    // 断言：event 行只剩一条（直播行保住，历史投影行被 live-wins 前置去重）
    const raw = feed.getRaw(id);
    const evt = raw.filter((m: any) => m.role === 'event' && m.content === '已加载技能 demo');
    expect(evt, '同一注入只显示一条（重复 = 切回 bug 回归）').toHaveLength(1);
    expect(evt[0].persistedMsgId).toBe('ctx-9');
  });

  it('存量兜底：无锚直播行 + 无锚投影行按内容抵扣（不误删带锚行）', async () => {
    const feed = cores.feed;
    const id = directDialog(A);
    const now = Date.now();

    // 旧后端帧（无 injectionId）+ 旧 journal 投影（message_id 空）
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: `${A}~user`, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: A, conversationId: `${A}~user` } }, { reasoning: '思考中' }, { agent: A, conversationId: `${A}~user` }]);
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'skill', label: '已加载技能 legacy' }]);

    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm0', role: 'user', content: '开始', timestamp: new Date(now - 10000).toISOString() },
        // 跨轮同文定稿行（带锚）——配额兜底不得误删
        { message_id: 'msg-old-1', role: 'context', content: 'x', source: 'skill', label: '已加载技能 legacy', agent_id: A, timestamp: new Date(now - 20000).toISOString() },
        // 本轮无锚投影行（旧 journal 行）——按内容抵扣
        { message_id: '', role: 'agent', content: 'step1', agent_id: A, partial: true, run: 'r1', timestamp: new Date(now - 8000).toISOString(),
          steps: [{ content: 'step1', reasoning: '思考中', ts: now - 8000, toolCalls: [] }] },
        { message_id: '', role: 'context', content: '<skill_content>正文</skill_content>', source: 'skill', label: '已加载技能 legacy', agent_id: A, injected: true, run: 'r1', timestamp: new Date(now - 5000).toISOString() },
      ],
    });
    await Promise.resolve();

    const raw = feed.getRaw(id);
    // 维度分离：无锚 event 行（直播行）恰 1 条——无锚投影行已被配额抵扣；
    // 带锚定稿行（同文跨轮）同场合法，不因内容相同被误删
    const evtLive = raw.filter((m: any) => m.role === 'event' && m.content === '已加载技能 legacy' && !m.persistedMsgId);
    expect(evtLive, '无锚直播行恰一条（无锚投影行被抵扣）').toHaveLength(1);
    const evtAnchored = raw.filter((m: any) => m.persistedMsgId === 'msg-old-1');
    expect(evtAnchored, '跨轮同文定稿行不被误删').toHaveLength(1);
  });
});
