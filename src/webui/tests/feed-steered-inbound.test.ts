// ============================================================
// feed-steered-inbound.test.ts —— conversation/steered 帧上屏回归
//
// 背景 bug（2026-09-02 反馈）：后台任务完成通知在会话忙时走 steer 通道
// 注入活跃 run（无 router/message-received 帧），前端 feed 不处理
// conversation/steered——通知在直播界面静默丢失；落盘行（steer 入账
// 忽略 source）又是不带 event 语义的普通 agent 行，刷新后也不显。
//
// 修复后不变量：
//   · source='event' 的机制通知上屏已退役（2026-12 通知面统一）：上屏帧
//     由 ac-session 在事件行落账/stash 时发 session/context-injected（带
//     注入身份锚 injectionId——直播行与刷新行同锚去重）；steered/message-
//     received 帧再渲染会双份——两帧的 event 分支删除，本文件钉住不回归；
//   · viewer 自己的 busy 发送（steer 注入回显）→ 跳过（本地已上屏）；
//   · 其他 agent 的注入 → 与 message-received 同款 agent 行。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: { call: vi.fn().mockRejectedValue(new Error('no rpc in test')), onWireEvent: vi.fn(() => () => {}), onWireOpen: vi.fn(() => () => {}), onWireClose: vi.fn(() => () => {}), onWireAck: vi.fn(() => {}) },
}));

vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { directDialog, pairDialog } from '../src/utils/feed';

const A = 'admin';
const NOTICE = '[系统通知] 后台任务 bash-1（bash）完成：exit code: 0。';

describe('conversation/steered 帧上屏（busy 通道消息不再静默丢失）', () => {
  let cores: SessionCores;
  beforeEach(() => {
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.setAgents([{ id: A, name: 'Admin', description: '' }]);
    cores.roster.activeAgentId.value = A;
  });

  it('source=event 的 steer 帧 → 不再上屏（通知面统一：context-injected 帧承担，此处渲染会双份）', () => {
    const feed = cores.feed;
    // args = (agentId, message, conversationId, handle, sender, source, meta)
    feed.ingestFrame('conversation/steered', [
      A, { role: 'user', content: NOTICE }, `${A}~user`, `${A}~user~${A}`, A, 'event',
    ]);
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
  });

  it('source=event 的 message-received 帧 → 不再上屏（同款退役）；上屏行由 context-injected 帧落地且带锚', () => {
    const feed = cores.feed;
    // args = (agentId, message, conversationId, sender, source)
    feed.ingestFrame('router/message-received', [
      A, { role: 'user', content: NOTICE }, `${A}~user`, A, 'event',
    ]);
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
    // 新通知面：session/context-injected（后端 session 在事件行落账时发）——
    // 直播行带注入身份锚（与刷新后的活投影/提升行同 message_id 去重）
    feed.ingestFrame('session/context-injected', [`${A}~user`, A, { source: 'event', injectionId: 'ctx-t1', label: NOTICE }]);
    const raw = feed.getRaw(directDialog(A));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'event', content: NOTICE, agent_id: 'system' });
    expect(raw[0].persistedMsgId).toBe('ctx-t1');
  });

  it('source=user/agent 的普通入站不受影响（仍渲染 sender 消息行）', () => {
    const feed = cores.feed;
    feed.ingestFrame('router/message-received', [
      'beta', { role: 'user', content: 'beta 的私信' }, `beta~user`, 'beta', 'agent',
    ]);
    const raw = feed.getRaw(directDialog('beta'));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ role: 'agent', content: 'beta 的私信', agent_id: 'beta' });
  });

  it('viewer 自己的 busy 发送经 steer 注入回显 → 跳过（本地发送时已上屏）', () => {
    const feed = cores.feed;
    feed.ingestFrame('conversation/steered', [
      A, { role: 'user', content: '用户在忙时的追加指令' }, `${A}~user`, `${A}~user~${A}`, 'user', 'user',
    ]);
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
  });

  it('其他 Agent 的注入（agent⇄agent steer）→ agent 行进对应对分区', () => {
    const feed = cores.feed;
    cores.roster.setAgents([
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
