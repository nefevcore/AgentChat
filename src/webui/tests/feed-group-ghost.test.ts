// ============================================================
// feed-group-ghost.test.ts —— 群分区入站帧不渲染（hint 幽灵消息回归）
//
// 背景 bug（2026-09-04 反馈）：等待群聊回复时，群视图出现 N-1 条
// 「<msg from=…>…</msg>\n\n[当前时间] …」消息——逐成员 hint 投递帧
// （router/message-received 空闲路径 / conversation/steered 忙路径）
// 被 showInbound 按群分区上屏；刷新后消失（落盘历史只有 post 行，
// hint 是投递触发器不是会话事实）。
//
// 修复后不变量：
//   · 群分区唯一内容源 = group/message-posted 的 post 行；
//   · 入站帧（message-received / steered / event 通知）路由到群分区
//     一律不上屏（与服务端 ws-bridge 的 GROUP_HINT_META 过滤同口径，
//     此处为前端兜底）；
//   · pair 分区（agent→viewer 私信）live 上屏照常。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: { call: vi.fn().mockRejectedValue(new Error('no rpc in test')), onWireEvent: vi.fn(() => () => {}), onWireOpen: vi.fn(() => () => {}), onWireClose: vi.fn(() => () => {}), onWireAck: vi.fn(() => {}) },
}));

vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { groupDialog, pairDialog } from '../src/utils/feed';
import { chatPresence } from '../src/api/chat-ops';

const G = 'g-ghost';
const NANA = 'nana';
const HINT = '<msg from="nana" name="小七" group="愉快玩耍">ciallo~</msg>\n\n[当前时间] 2026-09-04 17:23 周五';

describe('群分区入站帧不渲染（hint 幽灵消息回归）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().setAgents([{ id: NANA, name: '小七', description: '' }]);
    chatPresence.knownGroups.add(G);
  });

  afterEach(() => {
    chatPresence.knownGroups.delete(G);
  });

  it('message-received / steered / event 通知路由到群分区一律不上屏；post 行照常', () => {
    const feed = useFeedStore();

    // 修复前：每帧各渲染一条幽灵消息（等待回复期间重复 Agent数-1 次）
    feed.ingestFrame('router/message-received', [NANA, { role: 'user', content: HINT }, G, NANA, 'agent']);
    feed.ingestFrame('conversation/steered', [NANA, { role: 'user', content: HINT }, G, `${G}~${NANA}`, NANA, 'agent']);
    feed.ingestFrame('router/message-received', [NANA, { role: 'user', content: '机制通知' }, G, NANA, 'event']);
    feed.ingestFrame('conversation/steered', [NANA, { role: 'user', content: '机制通知' }, G, `${G}~${NANA}`, NANA, 'event']);
    expect(feed.getRaw(groupDialog(G))).toHaveLength(0);

    // 群内容唯一源：group/message-posted 的 post 行照常上屏
    feed.ingestFrame('group/message-posted', [G, { id: 'm1', groupId: G, from: NANA, content: '真实发言', at: 1 }]);
    const raw = feed.getRaw(groupDialog(G));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'agent', content: '真实发言', agent_id: NANA });
  });

  it('对照组：agent→viewer 私信（pair 分区）live 上屏照常', () => {
    const feed = useFeedStore();
    feed.ingestFrame('router/message-received', [NANA, { role: 'user', content: '私信内容' }, `${NANA}~user`, NANA, 'agent']);
    expect(feed.getRaw(pairDialog(NANA, 'user')).some((m) => m.content === '私信内容')).toBe(true);
  });
});
