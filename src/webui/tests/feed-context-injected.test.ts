// ============================================================
// feed-context-injected.test.ts —— 流式运行期 context 注入可见性
//（2026-09-21 前端反馈 #3；2026-12 反馈：流式与刷新显示同形）
//
// 后端 recordContext（技能注入等）此前只在 journal/partials——前端零感知，
// 刷新后才以 context 行出现。修复 = session/context-injected 事件 →
// showEventNotice 渲染事件分隔行。
// 文案契约（2026-12）：流式 = label 直出，与刷新后 toHistoryMessages 的
// r.label ?? content 同源同形——不再拼「已注入技能上下文：」前缀（落账
// label 本身已是完整文案，如「已加载技能 x」，拼前缀造成流式与刷新不一致）。
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
import { directDialog } from '../src/utils/feed';

const A = 'alpha';

describe('session/context-injected → 事件分隔行', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });

  it('skill 来源：label 直出（与刷新后历史同形，不再拼前缀）', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    // 后端落账 label 已是完整文案（ac-skill：`已加载技能 <name>`）
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'skill', label: '已加载技能 agentchat-plugin-dev' }]);
    const raw = feed.getRaw(id);
    const evts = raw.filter((m: any) => m.role === 'event');
    expect(evts).toHaveLength(1);
    expect(evts[0].content).toBe('已加载技能 agentchat-plugin-dev');
  });

  it('durable-interaction 来源（ask-questions）：label 直出摘要，不显示整段正文', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'durable-interaction', label: '已发起提问，等待用户回答' }]);
    const evts = feed.getRaw(id).filter((m: any) => m.role === 'event');
    expect(evts).toHaveLength(1);
    expect(evts[0].content).toBe('已发起提问，等待用户回答');
  });

  it('无 label 的非 skill 来源：回落通用文案；群分区不进（event 行唯一内容源= post）', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'other' }]);
    const evts = feed.getRaw(id).filter((m: any) => m.role === 'event');
    expect(evts).toHaveLength(1);
    expect(evts[0].content).toBe('已注入上下文');
  });
});
