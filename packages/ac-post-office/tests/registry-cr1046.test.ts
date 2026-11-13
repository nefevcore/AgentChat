// ============================================================
// registry-cr1046.test.ts —— uuid 参与者校验防线回归（cr-1046）
// 现场锚：跨壳会话 done-reply 的终稿通知投 user 曾以原会话键撞 conflict
//（修法在壳侧 postReply 改对桶键，registry 防线语义不变——本文件锁定
// conflict 判定不被误放宽）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { ConversationRegistry } from '../src/registry.ts';

describe('cr-1046 registry 防线（不放宽）', () => {
  it('登记 [designer,news] 后 [news,user] 来信（换集）→ 仍 conflict（防完全替换）', () => {
    const reg = new ConversationRegistry();
    expect(reg.register('news~news', ['designer', 'news']).kind).toBe('registered');
    expect(reg.register('news~news', ['news', 'user']).kind).toBe('conflict');
  });

  it('真冒用（集合交叉不包含）仍 conflict', () => {
    const reg = new ConversationRegistry();
    reg.register('a~b', ['a', 'b']);
    expect(reg.register('a~b', ['a', 'evil']).kind).toBe('conflict');
  });

  it('子集（cr-576 群）与等集 consistent', () => {
    const reg = new ConversationRegistry();
    reg.register('g~x', ['g', 'm1', 'm2', 'm3']);
    expect(reg.register('g~x', ['m1', 'g']).kind).toBe('consistent');
    expect(reg.register('g~x', ['g', 'm1', 'm2', 'm3']).kind).toBe('consistent');
  });
});