// ============================================================
// ac-text-budget：token 估算 / lone surrogate 清洗 / 代理对安全截断（纯函数行为锁定）
// ============================================================
import { describe, it, expect } from 'vitest';
import { estimateTokens, sanitizeSurrogates, safeTruncate, safeClipByTokens } from '../src/index.ts';

describe('estimateTokens', () => {
  it('空串 / null / undefined → 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('CJK 每字 0.6、其他每字 0.3，Math.ceil 取整', () => {
    expect(estimateTokens('中')).toBe(1); // ceil(0.6)
    expect(estimateTokens('ab')).toBe(1); // ceil(0.6)
    expect(estimateTokens('abcd')).toBe(2); // ceil(1.2)
    expect(estimateTokens('中a')).toBe(1); // ceil(0.9)
    expect(estimateTokens('中中')).toBe(2); // ceil(1.2)
    expect(estimateTokens('中文abc')).toBe(3); // ceil(2.1)
  });

  it('代理对按一个码点计费（for-of 按码点迭代）', () => {
    expect(estimateTokens('😀')).toBe(1); // 1 码点 × 0.3 → ceil = 1
    expect(estimateTokens('😀😀😀😀')).toBe(2); // 4 码点 × 0.3 = 1.2 → 2
  });
});

describe('sanitizeSurrogates', () => {
  it('空串原样返回', () => {
    expect(sanitizeSurrogates('')).toBe('');
  });

  it('孤立高/低代理替换为 U+FFFD', () => {
    expect(sanitizeSurrogates('\uD800')).toBe('\uFFFD');
    expect(sanitizeSurrogates('\uDC00')).toBe('\uFFFD');
    expect(sanitizeSurrogates('\uD800\uD800')).toBe('\uFFFD\uFFFD');
  });

  it('合法代理对原样保留', () => {
    expect(sanitizeSurrogates('😀')).toBe('😀');
    expect(sanitizeSurrogates('\uD83D\uDE00')).toBe('\uD83D\uDE00');
  });

  it('混合文本只替换孤立项，成对代理不动', () => {
    expect(sanitizeSurrogates('a\uD800😀\uDC00b')).toBe('a\uFFFD😀\uFFFDb');
    // 高代理后紧跟另一个代理对的 high：前者孤立被替换，后者成对保留
    expect(sanitizeSurrogates('\uD800\uD83D\uDE00')).toBe('\uFFFD😀');
  });
});

describe('safeTruncate', () => {
  it('长度不超原样返回（含空串）', () => {
    expect(safeTruncate('hello', 10)).toBe('hello');
    expect(safeTruncate('hello', 5)).toBe('hello');
    expect(safeTruncate('', 3)).toBe('');
  });

  it('正常 ASCII 截断精确', () => {
    expect(safeTruncate('hello world', 5)).toBe('hello');
    expect(safeTruncate('hello', 0)).toBe('');
  });

  it('截断点落在代理对中间时回退 1 不切半', () => {
    // 'a😀b' 的 code units：a / D83D / DE00 / b，总长 4
    expect(safeTruncate('a😀b', 4)).toBe('a😀b'); // 长度正好，原样
    expect(safeTruncate('a😀b', 3)).toBe('a😀'); // 末位是 low，不回退，代理对完整
    expect(safeTruncate('a😀b', 2)).toBe('a'); // 末位是 high → 回退 1
    expect(safeTruncate('😀😀', 1)).toBe(''); // 回退到 0
  });
});

describe('safeClipByTokens', () => {
  it('空串 → 空串', () => {
    expect(safeClipByTokens('', 10, true)).toBe('');
    expect(safeClipByTokens('', 10, false)).toBe('');
  });

  it('预算内原样返回（不加省略号）', () => {
    expect(safeClipByTokens('hello', 2, true)).toBe('hello'); // tokens = ceil(1.5) = 2
    expect(safeClipByTokens('hello', 2, false)).toBe('hello');
    expect(safeClipByTokens('一二三', 2, false)).toBe('一二三'); // tokens = ceil(1.8) = 2
  });

  it('keepTail=true：结果以 … 前缀开头且保留尾部', () => {
    // 'abcdefghij' tokens = ceil(3.0) = 3 > 2；尾部累积 j/i/h 共 0.9，+margin 1 ≤ 2
    expect(safeClipByTokens('abcdefghij', 2, true)).toBe('…hij');
  });

  it('keepHead（keepTail=false）：保留头部，以 … 结尾', () => {
    // 头部累积 a/b/c 共 0.9，+margin 1 ≤ 2；第 4 字符 1.2+1 > 2 截停
    expect(safeClipByTokens('abcdefghij', 2, false)).toBe('abc…');
  });

  it('CJK 计费 0.6/字：预算 3 保留 3 个汉字（ASCII 同预算保留 6 字符）', () => {
    // '一二三四五六七' tokens = ceil(4.2) = 5 > 3；尾部 3 字 1.8 + margin 1 = 2.8 ≤ 3
    expect(safeClipByTokens('一二三四五六七', 3, true)).toBe('…五六七');
    expect(safeClipByTokens('一二三四五六七', 3, false)).toBe('一二三…');
    // 'abcdefghijk' tokens = ceil(3.3) = 4 > 3；每字 0.3，尾部可保 6 字（1.8+1 ≤ 3）
    expect(safeClipByTokens('abcdefghijk', 3, true)).toBe('…fghijk');
  });

  it('代理对作为一个完整单位计费且不被切断', () => {
    // 'a😀bcdefg' 码点 8 个 × 0.3 = 2.4 → 3 > 2；头部 a/😀/b 共 0.9+1 ≤ 2
    expect(safeClipByTokens('a😀bcdefg', 2, false)).toBe('a😀b…');
    // 'abcdef😀g' 同为 8 码点；尾部跨代理对累积 g/😀/f
    expect(safeClipByTokens('abcdef😀g', 2, true)).toBe('…f😀g');
  });

  it('预算极小（1）退化为只输出省略号（markerMargin=1）', () => {
    // 首字符 0.3 + margin 1 = 1.3 > 1 → 立即截停，out 为空
    expect(safeClipByTokens('abcd', 1, true)).toBe('…');
    expect(safeClipByTokens('abcd', 1, false)).toBe('…');
  });
});
