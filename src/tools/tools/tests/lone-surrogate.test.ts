// lone surrogate 修复验证：safeTruncate / safeClipByTokens / sanitizeSurrogates
import { describe, it, expect } from 'vitest';
import { safeTruncate, safeClipByTokens, sanitizeSurrogates, estimateTokens } from '@agentchat/toolkit';

// 检测 lone surrogate
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe('lone surrogate 修复', () => {
  it('safeTruncate 不切断 emoji surrogate pair', () => {
    // emoji 在 200 边界：构造 199 个 ascii + emoji（2 code unit）→ 截断点落在 emoji 中间
    const emoji = '😀'; // \uD83D\uDE00
    const text = 'a'.repeat(199) + emoji + '尾';
    const out = safeTruncate(text, 200);
    expect(hasLoneSurrogate(out)).toBe(false);
    // 回退一位（去掉孤立的 high surrogate），保留 199 个 ascii
    expect(out.length).toBe(199);
    expect(out).toBe('a'.repeat(199));
  });

  it('safeTruncate 截断点不在代理对中间时正常截断', () => {
    const text = 'abc😀def';
    expect(safeTruncate(text, 5)).toBe('abc😀'); // 5 code units: a,b,c,😀(2)
    expect(hasLoneSurrogate(safeTruncate(text, 5))).toBe(false);
  });

  it('safeTruncate 短文本原样返回', () => {
    const text = '你好世界';
    expect(safeTruncate(text, 200)).toBe(text);
  });

  it('safeClipByTokens 保留尾部不产生 lone surrogate', () => {
    // 大量文本 + emoji，预算小 → 截断
    const text = '内容'.repeat(200) + '😀结束';
    const out = safeClipByTokens(text, 20, true);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith('结束')).toBe(true);
  });

  it('safeClipByTokens 保留头部不产生 lone surrogate', () => {
    const text = '开始😀' + '内容'.repeat(200);
    const out = safeClipByTokens(text, 20, false);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('sanitizeSurrogates 替换 lone surrogate 为 U+FFFD', () => {
    const polluted = '前\uD83D后'; // lone high surrogate
    const out = sanitizeSurrogates(polluted);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe('前\uFFFD后');
  });

  it('sanitizeSurrogates 保留完整 emoji', () => {
    const text = '完整😀emoji';
    expect(sanitizeSurrogates(text)).toBe(text);
  });

  it('模拟 query_history 截断场景（原 bug 复现路径）', () => {
    // 原 formatMessage: content.slice(0, 200) —— 200 边界切开 emoji
    const emoji = '😀';
    // 构造：199 个 ascii + emoji → 200 边界恰在 emoji 中间
    const content = 'x'.repeat(199) + emoji + '后面还有';
    // 原实现（slice）会切开
    const oldOut = content.slice(0, 200);
    expect(hasLoneSurrogate(oldOut)).toBe(true); // 确认原 bug 可复现
    // 新实现安全
    const newOut = safeTruncate(content, 200);
    expect(hasLoneSurrogate(newOut)).toBe(false);
  });

  it('estimateTokens 对含 lone surrogate 的文本不抛错', () => {
    const text = '有\uD83D毒';
    expect(estimateTokens(text)).toBeGreaterThan(0);
  });
});
