// ============================================================
// registry-cr1046.test.ts —— uuid 参与者校验防线回归（cr-1046）
// 现场锚：跨壳会话 done-reply 的终稿通知投 user 曾以原会话键撞 conflict
//（修法在壳侧 postReply 改对桶键，registry 防线语义不变——本文件锁定
// conflict 判定不被误放宽）。cr-1213 键形权威制收编：名册 = 键反演，
// 校验面 = sender 集外判定——防线语义延续，毒化面根除。
// ============================================================
import { describe, it, expect } from 'vitest';
import { ConversationRegistry } from '../src/registry.ts';

describe('cr-1046 registry 防线（不放宽）', () => {
  it('1v1 键名册两源对话：两端发言放行，集外 sender（user 换侧冒用同理）→ conflict', () => {
    const reg = new ConversationRegistry();
    expect(reg.register('designer~news', 'news').kind).toBe('registered');
    expect(reg.register('designer~news', 'designer').kind).toBe('consistent');
    expect(reg.register('designer~news', 'user').kind).toBe('conflict');
  });

  it('真冒用（集外 sender）仍 conflict', () => {
    const reg = new ConversationRegistry();
    reg.register('a~b', 'a');
    expect(reg.register('a~b', 'evil').kind).toBe('conflict');
  });

  it('群流键名册（setRoster 注入）成员发言与 user 保留端点均放行', () => {
    const reg = new ConversationRegistry();
    reg.setRoster('g~x', ['g', 'm1', 'm2', 'm3']);
    expect(reg.register('g~x', 'm2').kind).toBe('consistent');
    expect(reg.register('g~x', 'g').kind).toBe('consistent');
  });
});
