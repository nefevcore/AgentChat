// ============================================================
// webui/tests/feed-group-unread.test.ts —— 群聊未读状态机回归
//
// 需求锚：群聊数字未读徽章（名册群行 + 活动栏聚合同源消费）。
// 状态住 feed 分区 unread（group:gid），与 direct 同字段同语义：
//   · group/message-posted 增量：非 viewer 发言且该群非当前活跃群
//     → unread += 1（正在看的会话不计未读——与 direct 入站同口径）；
//   · viewer 自己的群发（from='user'）不计未读；
//   · setActiveGroup（ui-group selectGroup 同款调用）进入即清零。
//
// 手法：createSessionCores（sessionCores helper——独立 feed 实例 +
// offline rpc 拒绝面）+ ingestFrame 直喂事件帧（参数序同事件目录）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createSessionCores } from './helpers/sessionCores.ts';
import { directDialog, groupDialog } from '../src/utils/feed';

const G1 = 'room-a';
const G2 = 'room-b';

/** 群消息帧（group/message-posted：groupId, message{from, content}） */
function groupMsg(gid: string, from: string, content = 'hi') {
  return ['group/message-posted', [gid, { from, content }]] as const;
}

describe('群聊未读状态机（feed 分区 unread 增量/清除）', () => {
  it('非活跃群收到 agent 发言 → 未读逐条累加；viewer 自己的群发不计', () => {
    const { feed } = createSessionCores({ call: () => Promise.reject(new Error('offline')), onEvent: () => () => {} });
    feed.ingestFrame(...groupMsg(G1, 'alpha', '第一条'));
    feed.ingestFrame(...groupMsg(G1, 'beta', '第二条'));
    feed.ingestFrame(...groupMsg(G1, 'user', 'viewer 自己的群发'));
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(2);
  });

  it('正在查看的群（activeGroupId）不计未读', () => {
    const { feed } = createSessionCores({ call: () => Promise.reject(new Error('offline')), onEvent: () => () => {} });
    feed.setActiveGroup(G1); // ui-group selectGroup → feed.setActiveGroup 同款
    feed.ingestFrame(...groupMsg(G1, 'alpha', '当前正在看的群'));
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(0);
    // 但别的群仍正常计
    feed.ingestFrame(...groupMsg(G2, 'beta'));
    expect(feed.getDialog(groupDialog(G2))!.unread).toBe(1);
  });

  it('setActiveGroup 进入即清零（名册群行徽章/活动栏聚合同源回落）', () => {
    const { feed } = createSessionCores({ call: () => Promise.reject(new Error('offline')), onEvent: () => () => {} });
    feed.ingestFrame(...groupMsg(G1, 'alpha'));
    feed.ingestFrame(...groupMsg(G1, 'beta'));
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(2);
    feed.setActiveGroup(G1);
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(0);
    // 活跃期间增量不计、清零稳定（不会因后续帧回升历史计数）
    feed.ingestFrame(...groupMsg(G1, 'beta'));
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(0);
  });

  it('direct 与 group 未读互不干扰（各分区独立计数）', () => {
    const { feed } = createSessionCores({ call: () => Promise.reject(new Error('offline')), onEvent: () => () => {} });
    feed.ingestFrame(...groupMsg(G1, 'alpha'));
    // direct 私信入站（router/message-received：agentId, message, conversationId, sender, source）
    feed.ingestFrame('router/message-received', ['alpha', { role: 'user', content: '私信' }, 'alpha~user', 'alpha', 'agent']);
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(1);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
    feed.setActiveGroup(G1); // 只清群
    expect(feed.getDialog(groupDialog(G1))!.unread).toBe(0);
    expect(feed.getDialog(directDialog('alpha'))!.unread).toBe(1);
  });
});
