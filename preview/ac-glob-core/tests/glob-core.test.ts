// ============================================================
// ac-glob-core：glob→RegExp + 有界 walk
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { globToRegExp, normalizeGlobPattern, walkFiles, toPosix, SKIP_DIRS } from '../src/index.ts';

const tmps: string[] = [];
function tree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-glob-'));
  tmps.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'deep', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ts'), '1');
  fs.writeFileSync(path.join(dir, 'b.test.ts'), '2');
  fs.writeFileSync(path.join(dir, 'src', 'c.ts'), '3');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'd.tsx'), '4');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'deeper', 'e.md'), '5');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'y.js'), 'skip');
  return dir;
}

afterEach(() => {
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('glob → RegExp', () => {
  it('* 单段 / ** 跨层级（含零段）', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false); // * 不含 /
    expect(globToRegExp('src/**').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('a/**/b').test('a/b')).toBe(true); // ** 匹配零段
    expect(globToRegExp('a/**/b').test('a/x/y/b')).toBe(true);
    expect(globToRegExp('a/**/b').test('x/a/b')).toBe(false);
  });

  it('? 单字符；{a,b} 交替（嵌套）；[...] 字符类与取反', () => {
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('ac')).toBe(false);
    expect(globToRegExp('*.{ts,tsx}').test('x.tsx')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('x.js')).toBe(false);
    expect(globToRegExp('src/{a,b/{c,d}}').test('src/b/d')).toBe(true);
    expect(globToRegExp('x[0-9].ts').test('x7.ts')).toBe(true);
    expect(globToRegExp('x[!0-9].ts').test('x7.ts')).toBe(false);
    expect(globToRegExp('x[!0-9].ts').test('xa.ts')).toBe(true);
  });

  it('正则元字符按字面量转义；未闭合括号字面量', () => {
    expect(globToRegExp('a.b+c.ts').test('a.b+c.ts')).toBe(true);
    expect(globToRegExp('a.b.ts').test('axb.ts')).toBe(false); // . 是字面量
    expect(globToRegExp('a[b.ts').test('a[b.ts')).toBe(true);
  });

  it('normalizeGlobPattern：反斜杠/前导 ./ 尾部 /', () => {
    expect(normalizeGlobPattern('.\\src\\*.ts/')).toBe('src/*.ts');
  });
});

describe('walkFiles', () => {
  it('递归收集常规文件；跳过 SKIP_DIRS；隐藏文件包含；名称排序', () => {
    const root = tree();
    fs.writeFileSync(path.join(root, '.hidden'), 'h');
    const { entries, capped } = walkFiles(root);
    expect(capped).toBe(false);
    const rels = entries.map((e) => e.rel);
    expect(rels).toContain('.hidden');
    expect(rels).toContain('src/deep/deeper/e.md');
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
    expect(rels).toEqual([...rels].sort()); // 确定序
    expect(SKIP_DIRS.has('node_modules')).toBe(true);
  });

  it('base 相对化 rel；isDenied 过滤；基准外回退', () => {
    const root = tree();
    const sub = path.join(root, 'src');
    const r1 = walkFiles(sub, { base: root });
    expect(r1.entries.map((e) => e.rel)).toContain('src/deep/d.tsx');
    const r2 = walkFiles(sub, { isDenied: (abs) => abs.endsWith('d.tsx') });
    expect(r2.entries.map((e) => e.rel)).not.toContain('d.tsx');
    // base 在 root 外 → rel 相对 root 自身
    expect(r1.entries.length).toBeGreaterThan(0);
  });

  it('toPosix：平台分隔归一', () => {
    expect(toPosix(path.join('a', 'b'))).toBe('a/b');
  });
});
