// ============================================================
// estimateTokens 单元测试 —— token 估算算法（与前端 ChatView 同源）
//
// 中文 0.6 token/字，其他字符 0.3 token/字符，向上取整。
// 回归背景：前端 token 估算从后端 API 改为本地 computed 后，
// 算法必须与后端 estimateMessagesTokens 保持一致。
// ============================================================

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '@agentchat/toolkit';

describe('estimateTokens', () => {
  it('空/null/undefined → 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null as any)).toBe(0);
    expect(estimateTokens(undefined as any)).toBe(0);
  });

  it('纯英文：0.3 token/字符，向上取整', () => {
    // 'hello' = 5 * 0.3 = 1.5 → ceil = 2
    expect(estimateTokens('hello')).toBe(2);
    // 'a' = 0.3 → ceil = 1
    expect(estimateTokens('a')).toBe(1);
    // 10 字符 = 3.0 → 3
    expect(estimateTokens('abcdefghij')).toBe(3);
  });

  it('纯中文：0.6 token/字，向上取整', () => {
    // '你好' = 1.2 → ceil = 2
    expect(estimateTokens('你好')).toBe(2);
    // '一' = 0.6 → ceil = 1
    expect(estimateTokens('一')).toBe(1);
  });

  it('混合中英文累加', () => {
    // '你好world' = 1.2 + 1.5 = 2.7 → ceil = 3
    expect(estimateTokens('你好world')).toBe(3);
  });
});
