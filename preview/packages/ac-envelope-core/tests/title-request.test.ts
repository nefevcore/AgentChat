// ============================================================
// title-request.test.ts —— 标题请求信封协议（cr-672）：host 域独立键 /
// payload fail-closed / 收信面分流判别。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  isTitleRequest, makeEnvelope, makeTitleRequestEnvelope, validateEnvelope, validateTitleRequestPayload,
} from '../src/index.ts';

describe('标题请求信封（cr-672）', () => {
  it('信封形态：uuid = title-<会话键>（host 请求域独立键）/ kind=message / budget=0 / to=host', () => {
    const env = makeTitleRequestEnvelope({
      conversationId: 's1',
      requestId: 'r1',
      sender: 'alpha',
      payload: { conversationId: 's1', title: '会话标题', agent: 'alpha' },
    });
    expect(env).toMatchObject({ uuid: 'title-s1', requestId: 'r1', sender: 'alpha', to: 'host', kind: 'message', budget: 0 });
    expect(validateEnvelope(env)).toEqual([]);
    expect(isTitleRequest(env)).toBe(true);
  });

  it('payload 校验 fail-closed（只收集不修复）', () => {
    expect(validateTitleRequestPayload(null)).toEqual(['payload 非对象']);
    expect(validateTitleRequestPayload({})).toEqual(['conversationId 缺席', 'title 缺席或空白', 'agent 缺席']);
    expect(validateTitleRequestPayload({ conversationId: 's', title: '   ', agent: 'a' })).toEqual(['title 缺席或空白']);
    expect(validateTitleRequestPayload({ conversationId: 's', title: 't', agent: 'a' })).toEqual([]);
  });

  it('分流判别：端点 / kind / payload 词形三闸', () => {
    const msg = (to: string, kind: 'message' | 'receipt', payload: unknown) =>
      makeEnvelope({ uuid: 'u', requestId: 'r', sender: 'a', to, kind, payload });
    expect(isTitleRequest(msg('host', 'message', { conversationId: 's', title: 't' }))).toBe(true);
    expect(isTitleRequest(msg('alpha', 'message', { conversationId: 's', title: 't' }))).toBe(false);
    expect(isTitleRequest(msg('host', 'receipt', { conversationId: 's', title: 't' }))).toBe(false);
    expect(isTitleRequest(msg('host', 'message', { action: 'install', conversationId: 's' }))).toBe(false);
  });
});
