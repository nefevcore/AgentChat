// ============================================================
// token-vocab.test.ts —— 令牌词汇契约对账（B2 cr-693）
//
// 锁两件事：
// ① TOKEN_VOCAB 常量 == tokens.css 双极性块提取（词汇定义源在 kit，
//   常量漂移即红——contrast-tokens.test 的 themeBlock 同手法）；
// ② auditThemeTokens 完备性语义：全覆盖过 / 缺词 warning 不拒载 /
//   未知词诊断 / 缺极性块空集。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_VOCAB, extractThemeTokens, auditThemeTokens } from '../src/token-vocab.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tokensCss = readFileSync(join(repo, 'src/webui-kit/src/base/tokens.css'), 'utf8');

/** tokens.css 主题块内 --x 词集（contrast-tokens.test 同手法，锚点区分极性） */
function blockTokens(anchor: string): Set<string> {
  const start = tokensCss.indexOf(anchor);
  expect(start, 'tokens.css 缺锚点：' + anchor).toBeGreaterThan(-1);
  const end = tokensCss.indexOf('}', start);
  const out = new Set<string>();
  for (const m of tokensCss.slice(start, end).matchAll(/--([\w-]+):/g)) out.add(m[1]!);
  return out;
}

// :root,html[data-theme='nebula'],html.dark { — 一块三选择器，
// 第一个 } 即块尾；nebula 词集 = 该块词集
const nebula = blockTokens(`html[data-theme='nebula']`);
const aurora = blockTokens(`html[data-theme='aurora']`);

describe('B2 · TOKEN_VOCAB 对账（常量 == tokens.css 双极性块并集）', () => {
  it('常量词集 == 两极块提取的并集（shadow-primary-hover 只在 aurora 块——既有不对称，并集口径）', () => {
    const union = new Set([...nebula, ...aurora]);
    expect([...TOKEN_VOCAB].sort()).toEqual([...union].sort());
  });
});

describe('B2 · auditThemeTokens 完备性审计', () => {
  const full = [
    ":root { --x: 1; }",
    `html[data-theme='t'] { ${[...TOKEN_VOCAB].map((t) => '--' + t + ': #123456;').join(' ')} }`,
    `html.light[data-theme='t'] { ${[...TOKEN_VOCAB].map((t) => '--' + t + ': #654321;').join(' ')} }`,
  ].join('\n');

  it('全覆盖：missing/unknown 全空', () => {
    const a = auditThemeTokens(full, 't');
    expect(a.missing).toEqual({ dark: [], light: [] });
    expect(a.unknown).toEqual({ dark: [], light: [] });
    expect(a.coverage).toEqual({ dark: TOKEN_VOCAB.size, light: TOKEN_VOCAB.size, total: TOKEN_VOCAB.size });
  });

  it('缺词：missing 报告（回落缺省——warning 不拒载语义）', () => {
    const partial = "html[data-theme='t'] { --bg-base: #000; --primary: #fff; } html.light[data-theme='t'] { --bg-base: #111; }";
    const a = auditThemeTokens(partial, 't');
    expect(a.missing.dark).not.toContain('bg-base');
    expect(a.missing.dark).toContain('primary-strong');
    expect(a.missing.light).toContain('primary');
    expect(a.coverage.dark).toBe(2);
  });

  it('未知词：unknown 报告（第三方自用变量诊断）', () => {
    const withUnknown = "html[data-theme='t'] { --acme-accent: #f00; " + [...TOKEN_VOCAB].map((t) => '--' + t + ': #123456;').join(' ') + " }";
    const a = auditThemeTokens(withUnknown, 't');
    expect(a.unknown.dark).toEqual(['acme-accent']);
  });

  it('缺极性块：空集 → missing 全量（缺省回落语义）', () => {
    const a = auditThemeTokens(':root {}', 't');
    expect(a.coverage.dark).toBe(0);
    expect(a.missing.dark).toHaveLength(TOKEN_VOCAB.size);
  });

  it('extractThemeTokens 支持嵌套 @media 块（亮极在媒体查询内的合法形态）', () => {
    const nested = "html[data-theme='t'] { --bg-base: #000; @media (min-width: 0) { --primary: #fff; } }";
    const { dark } = extractThemeTokens(nested, 't');
    expect([...dark].sort()).toEqual(['bg-base', 'primary']);
  });
});
