// ============================================================
// feed-agent-pair-isolation.test.ts —— agent⇄agent / 自会话消息
// 不进 agent⇋viewer 会话表面（名册条目 + 全局信号）回归
//
// 背景 bug（2026-08-28 反馈）：math_pro 的自会话 run（conv=math_pro~
// math_pro，19 步）收束后，前端 agent⇋viewer 会话界面"收到"了这些消息——
// 两条泄漏路径：
//   ① onMessageEnd / onChatEnd 的 bumpAgentById 不看分区归属：a~a /
//      a~b 桶的回复写进了该 Agent 的名册条目 lastMessage（AgentList 条目
//      即 agent⇋viewer 会话入口，预览/排序被自会话消息顶起）；
//   ② isForActiveAgent 只比 Agent id：查看 math_pro 会话时其自会话 run
//      点亮 turnInProgress（输入框"生成中"假象）。
//
// 修复后不变量：
//   · viewer 参与会话（pair 含 viewer / group / single）照常 bump + 点灯；
//   · agent 对 / 自会话帧只进自己的矩阵格分区（pair:a|a / pair:a|b，
//     只读视角实时性保留），名册与全局信号不动。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: { call: vi.fn().mockRejectedValue(new Error('no rpc in test')), onWireEvent: vi.fn(() => () => {}), onWireOpen: vi.fn(() => () => {}), onWireClose: vi.fn(() => () => {}), onWireAck: vi.fn(() => {}) },
}));

vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog, pairDialog } from '../src/utils/feed';

const A = 'alpha';
const B = 'beta';
const SELF_TEXT = '自会话的回复内容';
const DELEGATE_TEXT = '委托 run 的回复内容';

function seedRoster(): void {
  useAgentStore().setAgents([
    { id: A, name: 'Alpha', description: '' },
    { id: B, name: 'Beta', description: '' },
  ]);
}

function rosterOf(id: string): { lastMessage?: { content: string } } {
  return useAgentStore().agents.find((a) => a.id === id) ?? {};
}

describe('agent⇄agent / 自会话隔离：viewer 会话表面不受污染', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    seedRoster();
    // 用户正在查看 alpha 的直答会话（agent⇋viewer 界面）
    useAgentStore().activeAgentId = A;
  });

  it('自会话（a~a）流式 run：矩阵对角线分区直播，名册与 viewer 分区不动', () => {
    const feed = useFeedStore();
    const selfDialog = pairDialog(A, A);

    // 完整流式序列（source='agent' 的 send_agent 自发委托，delta 全量广播）
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: `${A}~${A}`, sender: A }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '自会话的' }, { agent: A, conversationId: `${A}~${A}`, sender: A }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '回复内容' }, { agent: A, conversationId: `${A}~${A}`, sender: A }]);
    feed.ingestFrame('loop/after-step', [A, { text: SELF_TEXT }, { conversationId: `${A}~${A}`, sender: A }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: `${A}~${A}`, sender: A }, { finish: 'stop', text: SELF_TEXT }]);

    // 对角线分区保留直播内容（矩阵只读视角的实时性）
    const selfRaw = feed.getRaw(selfDialog);
    expect(selfRaw.some((m) => m.role === 'agent' && m.content === SELF_TEXT)).toBe(true);
    // viewer 直答分区零消息
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
    // 名册条目（agent⇋viewer 会话入口）不被自会话消息顶起
    expect(rosterOf(A).lastMessage).toBeUndefined();
    // 全局信号不点亮（当前查看的是 alpha 的 viewer 会话，不是它的自会话）
    expect(feed.turnInProgress).toBe(false);
  });

  it('后台自会话（source=event，仅边界帧广播）：after-run 兜底消息不 bump 名册', () => {
    const feed = useFeedStore();
    // 定时/机制触发的自会话：流式帧被后台过滤，只剩 loop/after-run 边界帧
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: `${A}~${A}`, sender: A, source: 'event' }, { finish: 'stop', text: SELF_TEXT }]);

    // 对角线分区仍有兜底终值（矩阵格可见）
    expect(feed.getRaw(pairDialog(A, A)).some((m) => m.content === SELF_TEXT)).toBe(true);
    // 修复前：onChatEnd 兜底路径 bumpAgentById(A)——名册被自会话回复顶起
    expect(rosterOf(A).lastMessage).toBeUndefined();
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
  });

  it('agent⇄agent 委托（a~b）：双方名册都不被对方 run 顶起', () => {
    const feed = useFeedStore();
    const conv = [A, B].sort().join('~');
    feed.ingestFrame('loop/step-started', [B, 0, [], { conversationId: conv, sender: A }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: DELEGATE_TEXT }, { agent: B, conversationId: conv, sender: A }]);
    feed.ingestFrame('loop/after-step', [B, { text: DELEGATE_TEXT }, { conversationId: conv, sender: A }]);
    feed.ingestFrame('loop/after-run', [{ agent: B, conversationId: conv, sender: A }, { finish: 'stop', text: DELEGATE_TEXT }]);

    // 矩阵格（pair 分区）直播保留
    expect(feed.getRaw(pairDialog(A, B)).some((m) => m.content === DELEGATE_TEXT)).toBe(true);
    // 名册不受污染（bumpAgentById 修复前会写 B 的 lastMessage）
    expect(rosterOf(A).lastMessage).toBeUndefined();
    expect(rosterOf(B).lastMessage).toBeUndefined();
    // 查看的是 alpha 的 viewer 会话：beta 的委托 run 不点灯
    expect(feed.turnInProgress).toBe(false);
  });

  it('对照组：viewer 直答会话照常 bump 名册 + 点亮全局信号', () => {
    const feed = useFeedStore();
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: A, sender: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '正常回复' }, { agent: A, conversationId: A, sender: 'user' }]);
    feed.ingestFrame('loop/after-step', [A, { text: '正常回复' }, { conversationId: A, sender: 'user' }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: A, sender: 'user' }, { finish: 'stop', text: '正常回复' }]);

    expect(feed.getRaw(directDialog(A)).some((m) => m.content === '正常回复')).toBe(true);
    expect(rosterOf(A).lastMessage?.content).toBe('正常回复');
    expect(feed.turnInProgress).toBe(true);
  });
});
