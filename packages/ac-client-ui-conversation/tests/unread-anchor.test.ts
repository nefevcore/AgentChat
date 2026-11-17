// ============================================================
// unread-anchor.test.ts —— cr-1139 锚定计数回归
//
// 增量幂等（run/settled runId 锚 / message_id 锚 / injectionId 锚 /
// 群组合锚）：at-least-once 帧面重投不超计；锚缺席退化计数（现状
// 语义）。cr-1146：快照/多 tab 合并 describe 随 localStorage 退役
// 删除（权威对账改服务端——见 unread-restore.test）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { directDialog, groupDialog } from '../client/feed.ts';

let feedCore: typeof import('../client/feed-core.ts');

// 静默成功（与 unread-settled.test 同款）：settled 帧触发 delay=0 收敛
// 重拉——拒绝形态会在 node 测试环境抛二次错（logger 裸 window）。
const offlineRpc = {
  call: () => Promise.resolve({ records: [], hasMore: false }),
  onEvent: () => () => undefined,
} as const;

async function makeFeed() {
  const { RosterCore } = await import('ac-client-ui-agents/client');
  if (!feedCore) feedCore = await import('../client/feed-core.ts');
  return feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
}

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
});

describe('cr-1139 · run/settled 收束增量 runId 锚幂等', () => {
  it('同一 run 重投（对账补投后真帧到达）不超计', async () => {
    const feed = await makeFeed();
    const frame = (run: string): [string, unknown[]] => ['run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', run, finish: 'stop', text: '回复' }]];
    feed.ingestFrame(...frame('run-1'));
    feed.ingestFrame(...frame('run-1')); // 重投
    feed.ingestFrame(...frame('run-1')); // 再重投
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
    feed.ingestFrame(...frame('run-2')); // 不同 run 正常计
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(2);
  });

  it('run 缺席（旧后端帧）退化计数——重投各计各的（现状语义）', async () => {
    const feed = await makeFeed();
    feed.ingestFrame('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', finish: 'stop' }]);
    feed.ingestFrame('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', finish: 'stop' }]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(2);
  });
});

describe('cr-1139 · message 私信增量 message_id 锚', () => {
  it('同 message_id 重投幂等；无 message_id 退化计数', async () => {
    const feed = await makeFeed();
    const msg = { role: 'user', content: '私信', message_id: 'm-1' };
    feed.ingestFrame('router/message-received', ['alpha', msg, 'alpha~user', 'alpha', 'agent']);
    feed.ingestFrame('router/message-received', ['alpha', msg, 'alpha~user', 'alpha', 'agent']);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
    const noId = { role: 'user', content: '旧帧' };
    feed.ingestFrame('router/message-received', ['alpha', noId, 'alpha~user', 'alpha', 'agent']);
    feed.ingestFrame('router/message-received', ['alpha', noId, 'alpha~user', 'alpha', 'agent']);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(3); // 1 + 2（退化）
  });
});

describe('cr-1144 · 机制注入行不计未读（未读单源 = run/settled + 私信）', () => {
  it('context-injected（任意 source）→ 不增未读（此前与 run/settled 叠加致每轮两倍）', async () => {
    const feed = await makeFeed();
    feed.ingestFrame('session/context-injected', ['alpha~user', 'alpha', { source: 'skill', label: '注入', injectionId: 'inj-1' }]);
    feed.ingestFrame('session/context-injected', ['alpha~user', 'alpha', { source: 'memory-delta', label: '长期记忆增量注入' }]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(0);
    // 同轮 run 收束计 1——「一轮回复 = 1 个未读」
    feed.ingestFrame('run/settled', [{ agent: 'alpha', conversationId: 'alpha~user', run: 'r1', finish: 'stop' }]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
  });
});

describe('cr-1139 · 群增量组合锚', () => {
  it('同文重投幂等（message_id 优先，缺席用 from+content）', async () => {
    const feed = await makeFeed();
    feed.ingestFrame('group/message-posted', ['room-a', { from: 'beta', content: '群消息', message_id: 'gm-1' }]);
    feed.ingestFrame('group/message-posted', ['room-a', { from: 'beta', content: '群消息', message_id: 'gm-1' }]);
    expect(feed.getDialog(groupDialog('room-a'))!.unread).toBe(1);
    feed.ingestFrame('group/message-posted', ['room-a', { from: 'beta', content: '同文' }]);
    feed.ingestFrame('group/message-posted', ['room-a', { from: 'beta', content: '同文' }]);
    expect(feed.getDialog(groupDialog('room-a'))!.unread).toBe(2);
  });
});
