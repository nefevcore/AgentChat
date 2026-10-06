// ============================================================
// ac-client-ui-conversation/tests/notify-trigger.test.ts ——
// 通知触发链路回归（cr-291）
//
// 锁定 feed-core 两触发点 → notifyBridge 队列：
//   · Agent 私信（router/message-received，页面后台 + 非当前会话）入队；
//   · run 收束（loop/after-run finish=stop，非活跃会话）入队；
//   · 正在看的会话/页面可见 → 不打扰（队列空）。
// 手法：全局 window 桩（hidden 态）先于 feed-core import 注入；
// roster 注入空名册（标题回落 agent id）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { directDialog } from '../client/feed.ts';

type Win = {
  __agentchatNotifyQueue?: Array<{ title: string; body: string; tag: string }>;
  __agentchatNotifyDirty?: boolean;
  document?: { visibilityState: string; addEventListener: (t: string, h: () => void) => void };
};

let win: Win;
let feedCore: typeof import('../client/feed-core.ts');
let agents: typeof import('ac-client-ui-agents/client');

const offlineRpc = {
  call: () => Promise.reject(new Error('offline')),
  onEvent: () => () => undefined,
} as const;

beforeAll(async () => {
  win = { document: { visibilityState: 'hidden', addEventListener: () => undefined } };
  (globalThis as unknown as { window: unknown }).window = win;
  feedCore = await import('../client/feed-core.ts');
  agents = await import('ac-client-ui-agents/client');
});

function makeFeed() {
  return feedCore.createFeedCore(offlineRpc as never, () => new agents.RosterCore());
}

describe('私信通知（showInbound 触发点）', () => {
  it('页面后台 + 非当前会话 → 入队（tag = 会话键）', () => {
    const feed = makeFeed();
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '在吗' }, 'alpha~user', 'alpha', 'agent']);
    expect(win.__agentchatNotifyQueue).toHaveLength(1);
    expect(win.__agentchatNotifyQueue![0]).toMatchObject({ title: 'alpha', body: '在吗', tag: directDialog('alpha') });
  });

  it('页面可见 → 不入队（前台看得见不打扰）', () => {
    win.__agentchatNotifyQueue = [];
    win.document!.visibilityState = 'visible';
    const feed = makeFeed();
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '在吗' }, 'alpha~user', 'alpha', 'agent']);
    expect(win.__agentchatNotifyQueue).toHaveLength(0);
    win.document!.visibilityState = 'hidden';
  });
});

describe('run 收束通知（loop/after-run 触发点）', () => {
  it('finish=stop + 非活跃会话 + 页面后台 → 入队（标题带「已完成」）', () => {
    win.__agentchatNotifyQueue = [];
    const feed = makeFeed();
    feed.ingestFrame('loop/after-run', [
      { agent: 'alpha', conversationId: 'alpha~user', sender: 'user', source: 'user' },
      { finish: 'stop', text: '任务完成，产物在 x.ts' },
    ]);
    expect(win.__agentchatNotifyQueue).toHaveLength(1);
    expect(win.__agentchatNotifyQueue![0]).toMatchObject({
      title: 'alpha · 已完成',
      body: '任务完成，产物在 x.ts',
      tag: directDialog('alpha'),
    });
  });

  it('finish=error 不通知（错误已有红条反馈）', () => {
    win.__agentchatNotifyQueue = [];
    const feed = makeFeed();
    feed.ingestFrame('loop/after-run', [
      { agent: 'alpha', conversationId: 'alpha~user', sender: 'user', source: 'user' },
      { finish: 'error', error: 'boom' },
    ]);
    expect(win.__agentchatNotifyQueue).toHaveLength(0);
  });
});