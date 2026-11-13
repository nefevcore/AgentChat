// ============================================================
// ac-client-ui-conversation/tests/unread-settled.test.ts ——
// 流式回复未读增量回归（cr-1057）
//
// 背景：未读增量此前只在私信（showInbound）/群（group/message-posted）
// 路径——用户发消息后切走、run 后台收束时徽章不亮。本回归锁定
// run/settled 正常收束（finish=stop）补未读：非当前会话 + viewer
// 参与会话 +1；正在看的会话/错误收束/agent⇄agent 对不增。
// 手法与 notify-trigger 同款（offline rpc 静默成功——settled 帧触发
// delay=0 收敛重拉，拒绝形态会在 node 测试环境抛二次错）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { directDialog } from '../client/feed.ts';

let feedCore: typeof import('../client/feed-core.ts');
let agents: typeof import('ac-client-ui-agents/client');

const offlineRpc = {
  call: () => Promise.resolve({ records: [], hasMore: false }),
  onEvent: () => () => undefined,
} as const;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  agents = await import('ac-client-ui-agents/client');
});

function makeFeed() {
  const roster = new agents.RosterCore();
  return { feed: feedCore.createFeedCore(offlineRpc as never, () => roster), roster };
}

const settledFrame = (over: Record<string, unknown> = {}) => ({ agent: 'alpha', conversationId: 'alpha~user', run: 'r1', finish: 'stop', text: 'done', ...over });

describe('run/settled 未读增量（cr-1057）', () => {
  it('正常收束 + 非当前会话 → 未读 +1（无激活上下文 = 用户在别处）', () => {
    const { feed } = makeFeed();
    feed.ingestFrame('run/settled', [settledFrame()]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
  });

  it('正在看的会话（激活该 Agent）→ 不增（直播已可见）', () => {
    const { feed, roster } = makeFeed();
    roster.selectAgent('alpha');
    feed.ingestFrame('run/settled', [settledFrame()]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(0);
  });

  it('finish=error → 不增（错误已有红条反馈）', () => {
    const { feed } = makeFeed();
    feed.ingestFrame('run/settled', [settledFrame({ finish: 'error', error: 'boom' })]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(0);
  });

  it('agent⇄agent 对（不含 viewer）→ 不增（矩阵只读分区无徽章消费）', () => {
    const { feed } = makeFeed();
    feed.ingestFrame('run/settled', [settledFrame({ conversationId: 'beta~gamma', agent: 'beta' })]);
    expect(feed.getDialog('pair:beta|gamma' as never)?.unread ?? 0).toBe(0);
  });

  it('text 缺席（对账补投形）仍 +1——不以终稿文本门控', () => {
    const { feed } = makeFeed();
    feed.ingestFrame('run/settled', [settledFrame({ text: undefined })]);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
  });
});
