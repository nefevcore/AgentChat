// ============================================================
// manage 帧词汇（cr-675）：请求/回执形状、关联键判定、帧层往返。
// 控制面 socket 帧是「控制点不绑 spawn 所有权」的载体——形状走散会静默
// 变成永不回执（老壳丢帧同款现场），故形状由用例锁定。
// ============================================================
import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, isManageReply, isManageRequest, makeManageReply, makeManageRequest } from '../src/index.ts';

describe('控制面 manage 帧（cr-675）', () => {
  it('请求帧：只认 { manage: { id, frame } }——信封帧不误判', () => {
    expect(isManageRequest(makeManageRequest('m1', { ctrl: 'preview', what: 'system-prompt' }))).toBe(true);
    expect(isManageRequest({ manage: { id: '', frame: {} } })).toBe(false);
    expect(isManageRequest({ manage: { id: 'm1' } })).toBe(false);
    expect(isManageRequest({ requestId: 'r1', sender: 'a', to: 'b' })).toBe(false);
    expect(isManageRequest(null)).toBe(false);
  });

  it('回执帧：按关联键取自己的（同连接并发安全）', () => {
    const ok = makeManageReply('m1', { ok: true, value: { systemPrompt: 'x' } });
    expect(isManageReply(ok, 'm1')).toBe(true);
    expect(isManageReply(ok, 'm2')).toBe(false);
    const bad = makeManageReply('m1', { ok: false, error: 'bench 服务缺席' });
    expect(isManageReply(bad, 'm1')).toBe(true);
    expect(bad.manage.error).toBe('bench 服务缺席');
  });

  it('帧层往返：长度前缀编解码原样可读', () => {
    const frames = new FrameDecoder().push(encodeFrame(makeManageRequest('m7', { ctrl: 'admin', op: 'run-state' })));
    expect(frames).toHaveLength(1);
    expect(isManageRequest(frames[0])).toBe(true);
  });
});
