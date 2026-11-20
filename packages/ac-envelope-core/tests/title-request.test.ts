// ============================================================
// title-request.test.ts —— 标题落盘请求 payload 校验（cr-672；
// cr-1175 批 3b 起去信封面——服务帧 title.set 直达 singles 行）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { validateTitleRequestPayload } from '../src/index.ts';

describe('标题请求 payload 校验（fail-closed——只收集不修复）', () => {
  it('缺失面各报一条', () => {
    expect(validateTitleRequestPayload(null)).toEqual(['payload 非对象']);
    expect(validateTitleRequestPayload({})).toEqual(['conversationId 缺席', 'title 缺席或空白', 'agent 缺席']);
    expect(validateTitleRequestPayload({ conversationId: 's', title: '   ', agent: 'a' })).toEqual(['title 缺席或空白']);
  });

  it('合法零 issues', () => {
    expect(validateTitleRequestPayload({ conversationId: 's', title: 't', agent: 'a' })).toEqual([]);
  });
});
