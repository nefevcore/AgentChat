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
  countLineChanges,
  generateIncrementalDiff,
  generateDiffString,
  withFileMutationQueue,
  applyEditBatch,
  detectLineEnding,
  restoreLineEndingsPreserving,
  stripBom,
} from '../src/index.ts';

const tmps: string[] = [];
function tmpFile(content: string, name = 'a.txt'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-edit-'));
  tmps.push(dir);
  const file = path.join(dir, name);
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

  it('多次出现 → 唯一性错误（含三级计数）', () => {
    expect(() =>
      applyEditsToNormalizedContent('x x x', [{ oldText: 'x', newText: 'y' }], 'f.txt'),
    ).toThrow(/有歧义.*出现 3 次/);
  });

  it('空 old_string → 错误', () => {
    expect(() =>
      applyEditsToNormalizedContent('aaa', [{ oldText: '', newText: 'b' }], 'f.txt'),
    ).toThrow(/不能为空/);
  });

  it('old_string === new_string（无变化）→ 拒绝编辑', () => {
    expect(() =>
      applyEditsToNormalizedContent('aaa', [{ oldText: 'a', newText: 'a' }], 'f.txt'),
    ).toThrow(/完全相同/);
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

  // ── 行级增删统计（工具卡 Label +N -M 数据源）──
  it('diff 统计：增量路径单行改写 → +1 -1', () => {
    const r = applyEditsToNormalizedContent('a\nb\nc', [{ oldText: 'b', newText: 'X' }], 'f.txt');
    const d = generateIncrementalDiff(r.baseContent, r.newContent, r.editPositions, 1);
    expect(d.diffAdded).toBe(1);
    expect(d.diffRemoved).toBe(1);
  });

  it('diff 统计：多行替换多行 → 按行数计（+3 -2）', () => {
    const r = applyEditsToNormalizedContent(
      'a\nold1\nold2\nz',
      [{ oldText: 'old1\nold2', newText: 'n1\nn2\nn3' }],
      'f.txt',
    );
    const d = generateIncrementalDiff(r.baseContent, r.newContent, r.editPositions, 1);
    expect(d.diffAdded).toBe(3);
    expect(d.diffRemoved).toBe(2);
  });

  it('countLineChanges：同内容 → 0/0；纯新增；改前缀共享尾', () => {
    expect(countLineChanges('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
    // ''→'x\ny'：split 后 old=['']（1 幻影行）、new=['x','y'] → +2 -1
    expect(countLineChanges('', 'x\ny')).toEqual({ added: 2, removed: 1 });
    // 写回共享尾行：仅首行变更（write 覆盖的最常见形态）
    expect(countLineChanges('old\nshared1\nshared2', 'new\nshared1\nshared2'))
      .toEqual({ added: 1, removed: 1 });
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

  it('old_string === new_string → 拒绝且文件保持原状（不写盘）', async () => {
    const file = tmpFile('alpha\nbeta\ngamma\n');
    const before = fs.readFileSync(file, 'utf-8');
    await expect(
      applyEditBatch(file, { textEdits: [{ oldText: 'beta', newText: 'beta' }] }),
    ).rejects.toThrow(/完全相同/);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before); // 未写回
  });
});

// ============================================================
// P0 匹配语义收口（事故回归：docs/edit-tool-incident-report.md）
// ============================================================

describe('P0：模糊匹配护栏', () => {
  it('Level 2（trim 行首空白）命中 → 拒绝编辑、文件不变', async () => {
    const file = tmpFile('line1\nindented code\nline3\n');
    await expect(
      applyEditBatch(file, { textEdits: [{ oldText: '   indented code', newText: 'X' }] }),
    ).rejects.toThrow(/fuzzy level 2/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('line1\nindented code\nline3\n'); // 文件未被破坏
  });

  it('交叉校验：精确唯一但全归一化（trim）下趋同 → 拒绝（事故主形态）', () => {
    // 两个仅缩进不同的块；old_string 精确匹配第二块，但在 trim 空间与第一块趋同
    const content = [
      'if (a) {',
      '  doWork();',
      '}',
      'if (b) {',
      'doWork();',
      '}',
    ].join('\n');
    expect(() =>
      applyEditsToNormalizedContent(content, [{ oldText: 'doWork();\n}', newText: 'X' }], 'f.ts'),
    ).toThrow(/全归一化（trim）.*2 次|有歧义/);
  });

  it('归一化后趋同的重复块：报错指引不再建议盲目扩大上下文', () => {
    const content = '/** 注释 v1 */\nconst a = 1;\n/** 注释 v1 */\nconst b = 2;\n';
    expect(() =>
      applyEditsToNormalizedContent(content, [{ oldText: '/** 注释 v1 */', newText: 'X' }], 'f.ts'),
    ).toThrow(/整段重写|行级操作/);
  });

  it('清晰唯一的精确编辑不受影响（护栏零误伤回归）', async () => {
    const file = tmpFile('const RESERVED = [\n  "a",\n];\ninterface T {\n  x?: number;\n}\n');
    const r = await applyEditBatch(file, {
      textEdits: [{ oldText: 'x?: number;', newText: 'x?: string;' }],
    });
    expect(r.fuzzyMatches).toBe(0);
    expect(fs.readFileSync(file, 'utf-8')).toContain('x?: string;');
  });
});

// ============================================================
// P1 写回前语法预检
// ============================================================

describe('P1：写回前语法预检', () => {
  it('.json 破坏（括号丢失）→ 拒绝写回、文件保持原状', async () => {
    const file = tmpFile('{"a": 1, "b": [2, 3]}\n', 'a.json');
    await expect(
      applyEditBatch(file, {
        // 匹配吞掉闭括号 → JSON 解析失败
        textEdits: [{ oldText: '"b": [2, 3]}\n', newText: '"b": [2' }],
      }),
    ).rejects.toThrow(/语法预检/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a": 1, "b": [2, 3]}\n'); // 原状
  });

  it('.ts 括号不配平 → 拒绝写回', async () => {
    const file = tmpFile('interface T {\n  /** doc */\n  x?: number;\n}\n', 'a.ts');
    await expect(
      applyEditBatch(file, {
        // JSDoc + 字段行 + 闭括号整体替换为新文本但丢失闭括号 → 配平失败
        textEdits: [{ oldText: '/** doc */\n  x?: number;\n}\n', newText: '/** doc */\n  x?: number;\n' }],
      }),
    ).rejects.toThrow(/配平预检失败/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('interface T {\n  /** doc */\n  x?: number;\n}\n');
  });

  it('.ts 正常编辑（括号完好的代码含字符串/注释/模板/正则）→ 预检放行', async () => {
    const file = tmpFile(
      [
        'const s = "(((";',
        'const t = `a ${x} b`;',
        'const re = /[/](+)/g;',
        '/* ) { ( 注释 */',
        'function f() { return (1); }',
      ].join('\n') + '\n',
      'a.ts',
    );
    const r = await applyEditBatch(file, {
      textEdits: [{ oldText: 'return (1);', newText: 'return (2);' }],
    });
    expect(fs.readFileSync(file, 'utf-8')).toContain('return (2);');
    expect(r.fuzzyMatches).toBe(0);
  });

  it('.txt 不做语法预检（配平破坏也放行——非代码文件）', async () => {
    const file = tmpFile('记录：((( 备忘\n');
    const r = await applyEditBatch(file, { textEdits: [{ oldText: '备忘', newText: 'X))' }] });
    // 整行 diff 渲染：文本里的括号不参与任何配平校验
    expect(r.diff).toContain('X))');
  });

  it('编辑前已损坏的 .ts → 修复编辑放行（基线比对防死锁）', async () => {
    const before = 'interface T {\n  x?: number;\n'; // 本身缺闭括号
    const file = tmpFile(before, 'a.ts');
    const r = await applyEditBatch(file, {
      textEdits: [{ oldText: '  x?: number;\n', newText: '  x?: number;\n}\n' }], // 补上闭括号
    });
    expect(fs.readFileSync(file, 'utf-8')).toBe('interface T {\n  x?: number;\n}\n');
    expect(r.fuzzyMatches).toBe(0);
  });
});

// ============================================================
// P2 readback 回显
// ============================================================

describe('P2：readback 回显', () => {
  it('编辑落点上下文带行号回显（read 同款格式），远距编辑用 ... 分隔', async () => {
    const file = tmpFile('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n');
    const r = await applyEditBatch(file, {
      textEdits: [
        { oldText: 'l2', newText: 'L2' },
        { oldText: 'l11', newText: 'L11' },
      ],
    });
    expect(r.readback).toBeDefined();
    expect(r.readback).toContain('2 L2');
    expect(r.readback).toContain('11 L11');
    expect(r.readback).toContain('1 l1');   // 上下文行
    expect(r.readback).toContain('...');    // 两编辑区之间有间隔
  });

  it('单处编辑的 readback 覆盖落点前后各 ~3 行', async () => {
    const file = tmpFile('a\nb\nc\nd\ne\nf\ng\nh\n');
    const r = await applyEditBatch(file, { textEdits: [{ oldText: 'e', newText: 'E' }] });
    // 第 5 行编辑 → readback 含 2..8 行（前后各 3），不含第 1 行
    expect(r.readback).toContain('5 E');
    expect(r.readback).toContain('2 b');
    expect(r.readback).toContain('8 h');
    expect(r.readback).not.toContain('1 a');
  });
});
