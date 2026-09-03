// ============================================================
// feed-steered-inbound.test.ts —— conversation/steered 帧上屏回归
//
// 背景 bug（2026-09-02 反馈）：后台任务完成通知在会话忙时走 steer 通道
// 注入活跃 run（无 router/message-received 帧），前端 feed 不处理
// conversation/steered——通知在直播界面静默丢失；落盘行（steer 入账
// 忽略 source）又是不带 event 语义的普通 agent 行，刷新后也不显。
//
// 修复后不变量：
//   · source='event' 的 steer 注入 → 系统事件行（分隔符渲染）上屏；
//   · viewer 自己的 busy 发送（steer 注入回显）→ 跳过（本地已上屏）；
//   · 其他 agent 的注入 → 与 message-received 同款 agent 行。
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

const A = 'admin';
const NOTICE = '[系统通知] 后台任务 bash-1（bash）完成：exit code: 0。';

describe('conversation/steered 帧上屏（busy 通道消息不再静默丢失）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().setAgents([{ id: A, name: 'Admin', description: '' }]);
    useAgentStore().activeAgentId = A;
  });

  it('source=event 的机制通知（会话忙 → steer 注入）→ 系统事件行上屏当前会话', () => {
    const feed = useFeedStore();
    // args = (agentId, message, conversationId, handle, sender, source, meta)
    feed.ingestFrame('conversation/steered', [
      A, { role: 'user', content: NOTICE }, `${A}~user`, `${A}~user~${A}`, A, 'event',
    ]);
    const raw = feed.getRaw(directDialog(A));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'event', content: NOTICE, agent_id: 'system' });
    // 当前会话正在查看 → 不计未读
    expect(feed.getDialog(directDialog(A))!.unread).toBe(0);
  });

  it('source=event 的机制通知（会话空闲 → message-received）→ 同款系统事件行（忙/闲直播同形）', () => {
    const feed = useFeedStore();
    // args = (agentId, message, conversationId, sender, source)
    feed.ingestFrame('router/message-received', [
      A, { role: 'user', content: NOTICE }, `${A}~user`, A, 'event',
    ]);
    const raw = feed.getRaw(directDialog(A));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'event', content: NOTICE, agent_id: 'system' });
  });

  it('source=user/agent 的普通入站不受影响（仍渲染 sender 消息行）', () => {
    const feed = useFeedStore();
    feed.ingestFrame('router/message-received', [
      'beta', { role: 'user', content: 'beta 的私信' }, `beta~user`, 'beta', 'agent',
    ]);
    const raw = feed.getRaw(directDialog('beta'));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'agent', content: 'beta 的私信', agent_id: 'beta' });
  });

  it('viewer 自己的 busy 发送经 steer 注入回显 → 跳过（本地发送时已上屏）', () => {
    const feed = useFeedStore();
    feed.ingestFrame('conversation/steered', [
      A, { role: 'user', content: '用户在忙时的追加指令' }, `${A}~user`, `${A}~user~${A}`, 'user', 'user',
    ]);
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
  });

  it('其他 Agent 的注入（agent⇄agent steer）→ agent 行进对应对分区', () => {
    const feed = useFeedStore();
    useAgentStore().setAgents([
      { id: A, name: 'Admin', description: '' },
      { id: 'beta', name: 'Beta', description: '' },
    ]);
    feed.ingestFrame('conversation/steered', [
      A, { role: 'user', content: 'beta 的注入消息' }, `${A}~beta`, `${A}~beta~${A}`, 'beta', 'agent',
    ]);
    const raw = feed.getRaw(pairDialog('beta', A));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'agent', content: 'beta 的注入消息', agent_id: 'beta' });
  });
});
