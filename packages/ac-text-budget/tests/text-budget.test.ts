// ============================================================
// ac-text-budget：token 估算 / lone surrogate 清洗 / 代理对安全截断（纯函数行为锁定）
// ============================================================
import { describe, it, expect } from 'vitest';
import { estimateTokens, sanitizeSurrogates, safeTruncate, safeClipByTokens, sanitizeJsonLine } from '../src/index.ts';

/** lone surrogate 检测（与生产正则同形——测试自带验证器，事故复现断言用） */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

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

describe('sanitizeJsonLine（JSON 转义面清洗——防线2/3 共用单源，cr-415）', () => {
  it('干净文本原样（幂等基础）', () => {
    expect(sanitizeJsonLine('')).toBe('');
    expect(sanitizeJsonLine('{"a":1}')).toBe('{"a":1}');
  });

  it('JSON.stringify 的 lone surrogate 转义被替换为 \\ufffd（2026-08-05 事故形态）', () => {
    // JSON.stringify（Node 20+ well-formed）对 lone surrogate 输出 \udXXX 转义文本
    const polluted = JSON.stringify({ content: '前\uD83D后' }); // lone high surrogate
    expect(polluted).toContain('\\ud83d');
    const clean = sanitizeJsonLine(polluted);
    expect(clean).not.toContain('\\ud83d');
    expect(clean).toContain('\\ufffd');
    expect(JSON.parse(clean).content).toBe('前\uFFFD后');
  });

  it('孤立 low surrogate 同款清洗', () => {
    const polluted = JSON.stringify({ content: 'x\uDC00y' });
    const clean = sanitizeJsonLine(polluted);
    expect(clean).not.toContain('\\udc00');
    expect(JSON.parse(clean).content).toBe('x\uFFFDy');
  });

  it('合法代理对的成对转义不动（emoji 完整保留）', () => {
    // JSON.stringify 对合法 emoji 输出字面字符（只转义不可表示字符）——字面路径
    const ok = JSON.stringify({ content: 'a😀b' });
    expect(sanitizeJsonLine(ok)).toBe(ok);
    expect(JSON.parse(sanitizeJsonLine(ok)).content).toBe('a😀b');
    // 手写成对转义文本（盘上/网关转发的序列化形态）：high 后紧跟 low 不动
    const pairText = '{"c":"\\ud83d\\ude00"}';
    expect(sanitizeJsonLine(pairText)).toBe(pairText);
  });

  it('清洗幂等：已 \\ufffd 文本二次清洗原样（写失败回队重写路径依赖）', () => {
    const once = sanitizeJsonLine(JSON.stringify({ content: '前\uD83D后' }));
    expect(sanitizeJsonLine(once)).toBe(once);
  });

  it('大小写转义形态同款（\\uD83D / \\ud83d）', () => {
    const lower = sanitizeJsonLine('{"c":"\\ud83d"}'); // 手写小写转义文本
    expect(lower).toBe('{"c":"\\ufffd"}');
    const upper = sanitizeJsonLine('{"c":"\\uD83D"}');
    expect(upper).toBe('{"c":"\\ufffd"}');
  });
});
