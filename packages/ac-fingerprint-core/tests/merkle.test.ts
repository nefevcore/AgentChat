// ============================================================
// ac-fingerprint-core 单测（M1.4 验收）：确定性 / EOL+路径归一 /
// 行排序无关 / 共享叶根各异 / 排除集 / 盘适配往返
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizeEol, normalizePath, fileDigest, entryDigest, subjectRoot,
  type NormalizedFile,
} from '../src/merkle.ts';
import { collectFiles, fingerprintEntryOnDisk } from '../src/disk.ts';

const f = (p: string, c: string): NormalizedFile => ({ path: normalizePath(p), content: c });

describe('规范化', () => {
  it('EOL 归一：CRLF / 裸 CR 与 LF 同指纹', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(fileDigest(f('x.ts', 'a\r\nb'))).toBe(fileDigest(f('x.ts', 'a\nb')));
  });
  it('路径归一：win 反斜杠与 posix 同指纹，恒 ./ 起头', () => {
    expect(normalizePath('src\\a.ts')).toBe('./src/a.ts');
    expect(normalizePath('./src/a.ts')).toBe('./src/a.ts');
    expect(fileDigest(f('src\\a.ts', 'x'))).toBe(fileDigest(f('src/a.ts', 'x')));
  });
  it('路径入哈希：同内容异路径不同指纹', () => {
    expect(fileDigest(f('a.ts', 'x'))).not.toBe(fileDigest(f('b.ts', 'x')));
  });
});

describe('行级子指纹与聚合根', () => {
  it('确定性：同输入同根（含跨实例）', () => {
    const files = [f('src/index.ts', 'export const a = 1;')];
    const e1 = entryDigest('row-a', files);
    const e2 = entryDigest('row-a', files);
    expect(e1.digest).toBe(e2.digest);
    expect(subjectRoot([e1]).root).toBe(subjectRoot([e2]).root);
  });

  it('文件序无关：排序后聚合（乱序文件集同指纹）', () => {
    const a = entryDigest('row-a', [f('a.ts', '1'), f('b.ts', '2'), f('c.ts', '3')]);
    const b = entryDigest('row-a', [f('c.ts', '3'), f('a.ts', '1'), f('b.ts', '2')]);
    expect(a.digest).toBe(b.digest);
  });

  it('行序无关：根聚合前行按 id 排序', () => {
    const e1 = entryDigest('row-a', [f('x.ts', '1')]);
    const e2 = entryDigest('row-b', [f('y.ts', '2')]);
    expect(subjectRoot([e1, e2]).root).toBe(subjectRoot([e2, e1]).root);
  });

  it('内容变更 → 行子指纹变 → 根变（换了哪行机器可读）', () => {
    const before = subjectRoot([entryDigest('row-a', [f('x.ts', '1')]), entryDigest('row-b', [f('y.ts', '2')])]);
    const after = subjectRoot([entryDigest('row-a', [f('x.ts', 'CHANGED')]), entryDigest('row-b', [f('y.ts', '2')])]);
    expect(after.root).not.toBe(before.root);
    expect(after.entries['row-a']).not.toBe(before.entries['row-a']);
    expect(after.entries['row-b']).toBe(before.entries['row-b']);
  });

  it('共享叶根各异：同 row-a 两主体（宿主 / CLI 形态）根不同，共享行指纹相同', () => {
    const shared = entryDigest('row-a', [f('x.ts', '1')]);
    const host = subjectRoot([shared, entryDigest('row-h', [f('h.ts', 'h')])]);
    const cli = subjectRoot([shared, entryDigest('row-c', [f('c.ts', 'c')])]);
    expect(host.root).not.toBe(cli.root);
    expect(host.entries['row-a']).toBe(cli.entries['row-a']);
  });

  it('git 注释性伴随不进根（缺席不失效）', () => {
    const e = entryDigest('row-a', [f('x.ts', '1')]);
    expect(subjectRoot([e], 'commit:abc+dirty').root).toBe(subjectRoot([e]).root);
    expect(subjectRoot([e], 'commit:abc').gitNote).toBe('commit:abc');
  });
});

describe('盘适配', () => {
  const ROOT = path.join('sandbox', 'test-fp-' + process.pid);
  const entry = path.join(ROOT, 'row-x');
  beforeEach(() => {
    fs.mkdirSync(path.join(entry, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'package.json'), '{}');
    fs.writeFileSync(path.join(entry, 'src', 'index.ts'), 'export const x = 1;\r\n');
    fs.writeFileSync(path.join(entry, 'src', 'deep', 'u.ts'), 'export {};');
    fs.mkdirSync(path.join(entry, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'node_modules', 'dep', 'junk.js'), 'garbage');
  });
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));
  
  it('包目录全量 - 排除集：node_modules 不入指纹', () => {
    const files = collectFiles(entry);
    const paths = files.map((x) => x.path).sort();
    expect(paths).toEqual(['./package.json', './src/deep/u.ts', './src/index.ts']);
  });
  it('盘往返与纯函数一致（EOL 归一生效）', () => {
    const onDisk = fingerprintEntryOnDisk('row-x', entry);
    const pure = entryDigest('row-x', [
      f('package.json', '{}'),
      f('src/index.ts', 'export const x = 1;\n'),
      f('src/deep/u.ts', 'export {};'),
    ]);
    expect(onDisk.digest).toBe(pure.digest);
  });
  it('快照稳定性：同树两次盘算同指纹（R-7 快照稳定性验收）', () => {
    expect(fingerprintEntryOnDisk('row-x', entry).digest).toBe(fingerprintEntryOnDisk('row-x', entry).digest);
  });
  it('缺席目录 = 空集（不掺假指纹）', () => {
    const r = fingerprintEntryOnDisk('row-ghost', path.join(ROOT, 'no-such'));
    expect(r.fileCount).toBe(0);
  });
});
