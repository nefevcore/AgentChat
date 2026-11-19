// cr1157-unread-axis.test.ts —— 未读轴键归一判据（cr-1157 单源）
import { describe, it, expect } from 'vitest';
import { unreadAxisKeyOf, userPairAxisKey } from '../src/unread-axis.ts';

const UUID = '01a1ef2a-3ea9-7a7a-a064-03add8837a75';

describe('unreadAxisKeyOf（run 收束轴键判据）', () => {
  it('自会话 a~a 不计（双倍根因：news~news 与 news~user 在徽章聚合合流到同一 Agent 行）', () => {
    expect(unreadAxisKeyOf('news', 'news~news')).toBeUndefined();
    expect(unreadAxisKeyOf('alpha', 'alpha~alpha')).toBeUndefined();
  });

  it('agent⇄agent 对不计（无 viewer 参与——动静走 roster 活动面）', () => {
    expect(unreadAxisKeyOf('alpha', 'alpha~beta')).toBeUndefined();
    expect(unreadAxisKeyOf('beta', 'alpha~beta')).toBeUndefined();
  });

  it('g- 群轴不计（串台根因：群由 group/message-posted 单源计）', () => {
    expect(unreadAxisKeyOf('alpha', 'g-mthfaf3e-tmx1')).toBeUndefined();
  });

  it('viewer 参与对桶计（直答/私信正路径）', () => {
    expect(unreadAxisKeyOf('news', 'news~user')).toBe('news~user');
    expect(unreadAxisKeyOf('alpha', 'user~alpha')).toBe('user~alpha');
  });

  it('未知形态不计（不猜——防历史脏键/探测残留串台到 agent⇄user 轴）', () => {
    // 真实数据实证：probe-conflict-* 这类残留曾被回落猜成 news~user
    expect(unreadAxisKeyOf('news', 'probe-conflict-1794528561148')).toBeUndefined();
    expect(unreadAxisKeyOf('news', 'sub_abc')).toBeUndefined();
    expect(unreadAxisKeyOf('news', 'admin~news')).toBeUndefined();
  });

  it('uuid single 直用；agent 名直答旧形态归 userPairAxisKey；缺参不计', () => {
    expect(unreadAxisKeyOf('__creator__', UUID)).toBe(UUID);
    expect(unreadAxisKeyOf('alpha', 'alpha')).toBe('alpha~user');
    expect(unreadAxisKeyOf(undefined, 'x')).toBeUndefined();
    expect(unreadAxisKeyOf('alpha', undefined)).toBeUndefined();
    expect(unreadAxisKeyOf('', 'alpha~user')).toBeUndefined();
  });

  it('userPairAxisKey：两端排序归一（与 pairKey 同式）', () => {
    expect(userPairAxisKey('alpha')).toBe('alpha~user');
    expect(userPairAxisKey('user')).toBe('user~user');
    expect(userPairAxisKey('news', 'user')).toBe('news~user');
  });
});
