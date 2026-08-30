// ============================================================
// ac-edit-core：模糊匹配 / 行尾保留 / 唯一性校验 / 突变队列 / 统一管线
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fuzzyFindText,
  normalizeForFuzzyMatch,
  applyEditsToNormalizedContent,
  generateIncrementalDiff,
  generateDiffString,
  withFileMutationQueue,
  applyEditBatch,
  detectLineEnding,
  restoreLineEndingsPreserving,
  stripBom,
} from '../src/index.ts';

const tmps: string[] = [];
function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-edit-'));
  tmps.push(dir);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

afterEach(() => {
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('三级模糊匹配', () => {
  it('Level 0：精确命中', () => {
    const r = fuzzyFindText('hello world', 'world');
    expect(r).toMatchObject({ found: true, index: 6, usedFuzzyMatch: false, fuzzyLevel: 0 });
  });

  it('Level 1：smart quotes/行尾空白归一化后命中，索引映射回原文', () => {
    const content = 'say “hi” now\nnext line   \nend';
    const old = 'say "hi" now';
    const r = fuzzyFindText(content, old);
    expect(r.found).toBe(true);
    expect(r.usedFuzzyMatch).toBe(true);
    expect(r.fuzzyLevel).toBe(1);
    expect(r.index).toBe(0);
  });

  it('Level 2：old 带行首空格而原文没有 → trim 归一化命中，索引指回原文行首', () => {
    const content = 'line1\nindented code\nline3';
    // L1（trimEnd，保留行首）不命中：'   indented code' 不是子串；
    // L2（trim 行首行尾）命中
    const old = '   indented code';
    const r = fuzzyFindText(content, old);
    expect(r).toMatchObject({ found: true, usedFuzzyMatch: true, fuzzyLevel: 2 });
    expect(r.index).toBe(6);
    expect(content.slice(r.index, r.index + 'indented code'.length)).toBe('indented code');
  });

  it('未命中返回 found:false', () => {
    expect(fuzzyFindText('abc', 'xyz').found).toBe(false);
  });

  it('normalizeForFuzzyMatch：各类 Unicode 差异归一化', () => {
    expect(normalizeForFuzzyMatch('“a” – b\u00A0c  ', false)).toBe('"a" - b c');
  });
});

describe('applyEditsToNormalizedContent 校验', () => {
  it('未找到 old_string → 可读错误含恢复建议', () => {
    expect(() =>
      applyEditsToNormalizedContent('aaa', [{ oldText: 'zzz', newText: 'b' }], 'f.txt'),
    ).toThrow(/未找到 old_string/);
  });

  it('多次出现 → 唯一性错误', () => {
    expect(() =>
      applyEditsToNormalizedContent('x x x', [{ oldText: 'x', newText: 'y' }], 'f.txt'),
    ).toThrow(/出现了 3 次/);
  });

  it('空 old_string → 错误', () => {
    expect(() =>
      applyEditsToNormalizedContent('aaa', [{ oldText: '', newText: 'b' }], 'f.txt'),
    ).toThrow(/不能为空/);
  });

  it('重叠编辑 → 错误', () => {
    expect(() =>
      applyEditsToNormalizedContent(
        'abcdef',
        [
          { oldText: 'abcd', newText: 'x' },
          { oldText: 'cdef', newText: 'y' },
        ],
        'f.txt',
      ),
    ).toThrow(/重叠/);
  });

  it('两个不重叠编辑：从后往前替换，位置供增量 diff', () => {
    const r = applyEditsToNormalizedContent(
      'one two three',
      [
        { oldText: 'one', newText: '1' },
        { oldText: 'three', newText: '3' },
      ],
      'f.txt',
    );
    expect(r.newContent).toBe('1 two 3');
    expect(r.editPositions).toHaveLength(2);
  });
});

describe('diff 生成', () => {
  it('增量 diff：-/+ 行 + 行号 + 首变更行', () => {
    const r = applyEditsToNormalizedContent(
      'a\nb\nc\nd',
      [{ oldText: 'b', newText: 'B' }],
      'f.txt',
    );
    const d = generateIncrementalDiff(r.baseContent, r.newContent, r.editPositions, 1);
    expect(d.firstChangedLine).toBe(2);
    expect(d.diff).toContain('- 2 b');
    expect(d.diff).toContain('+ 2 B');
    expect(d.diff).toContain('  1 a');
  });

  it('全量 LCS diff（无编辑位置路径）', () => {
    const d = generateDiffString('a\nb\nc', 'a\nX\nc', 0);
    expect(d.firstChangedLine).toBe(2);
    expect(d.diff).toContain('- 2 b');
    expect(d.diff).toContain('+ 2 X');
  });
});

describe('行尾与 BOM', () => {
  it('mixed 检测 + 按行保留行尾（未编辑行字节不变；变更行用主导行尾）', () => {
    const raw = 'keep1\r\nedit\nkeep2\r\n';
    expect(detectLineEnding(raw)).toBe('mixed');
    const out = restoreLineEndingsPreserving(raw, 'keep1\nEDITED\nkeep2\n');
    // keep1/keep2 文本未变 → 各自保留原行尾；EDITED 是新行 → 主导行尾（CRLF 多数）
    expect(out).toBe('keep1\r\nEDITED\r\nkeep2\r\n');
  });

  it('新插入行用主导行尾', () => {
    const raw = 'a\r\nb\r\n';
    const out = restoreLineEndingsPreserving(raw, 'a\nNEW\nb\n');
    expect(out).toBe('a\r\nNEW\r\nb\r\n');
  });

  it('BOM 剥离', () => {
    expect(stripBom('\uFEFFabc')).toBe('abc');
    expect(stripBom('abc')).toBe('abc');
  });
});

describe('文件突变队列', () => {
  it('同一文件串行（realpath 同 key）；不同文件并行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-edit-'));
    tmps.push(dir);
    const a = path.join(dir, 'same.txt');
    fs.writeFileSync(a, '0\n', 'utf-8');
    // 并发 5 次自增读改写：串行化保证不丢更新（并行即竞态）
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileMutationQueue(a, async () => {
          const n = Number(fs.readFileSync(a, 'utf-8').trim());
          await new Promise((r) => setTimeout(r, 2));
          fs.writeFileSync(a, `${n + 1}\n`, 'utf-8');
        }),
      ),
    );
    expect(fs.readFileSync(a, 'utf-8').trim()).toBe('5');
  });
});

describe('applyEditBatch 统一管线', () => {
  it('端到端：编辑 + diff + 写回 + 模糊计数', async () => {
    const file = tmpFile('alpha\nbeta\ngamma\n');
    const r = await applyEditBatch(file, {
      textEdits: [{ oldText: 'beta', newText: 'BETA' }],
    });
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nBETA\ngamma\n');
    expect(r.diff).toContain('- 2 beta');
    expect(r.diff).toContain('+ 2 BETA');
    expect(r.fuzzyMatches).toBe(0);
  });

  it('模糊命中计数 + CRLF 写回保持', async () => {
    const file = tmpFile('“quoted”\r\nplain\r\n');
    const r = await applyEditBatch(file, {
      // smart quotes 归一化后命中（Level 1 模糊）
      textEdits: [{ oldText: '"quoted"', newText: 'replaced' }],
    });
    expect(fs.readFileSync(file, 'utf-8')).toBe('replaced\r\nplain\r\n');
    expect(r.fuzzyMatches).toBe(1);
  });

  it('文件不存在 → 提示用 write 工具', async () => {
    const file = path.join(os.tmpdir(), `nope-${Date.now()}.txt`);
    await expect(applyEditBatch(file, { textEdits: [{ oldText: 'a', newText: 'b' }] })).rejects.toThrow(
      /文件不存在/,
    );
  });
});
