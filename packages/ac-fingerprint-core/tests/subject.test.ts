// ============================================================
// 6.2 主体指纹组合单测：同输入同根 / 异输入异根 / 行内容变更漂移 /
// EOL 归一跨平台稳定（两侧同算法断言的物理载体）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { subjectFingerprint } from '../src/subject.ts';

const ROOT = path.join('sandbox', 'test-subject-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedRow(name: string, files: Record<string, string>): string {
  const dir = path.join(ROOT, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf-8');
  }
  return dir;
}

const base = {
  configJson: JSON.stringify({ id: 'alpha', model: 'mock' }),
  catalogJson: JSON.stringify({ rows: [{ id: 'row-a', tree: 'shell' }] }),
};

describe('M6.2 主体指纹组合', () => {
  it('同输入同根（盘目录不变——两次计算一致）', () => {
    const rowA = seedRow('row-a', { 'src/index.ts': 'export const x = 1;\n' });
    const a = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA }] });
    const b = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA }] });
    expect(a.root).toBe(b.root);
    expect(Object.keys(a.entries).sort()).toEqual(['agent-config', 'row-a', 'row-catalog']);
  });

  it('行内容变更 → 根漂移 + 子指纹定位（机器可读归因）', () => {
    const rowA1 = seedRow('row-a1', { 'src/index.ts': 'export const x = 1;\n' });
    const rowA2 = seedRow('row-a2', { 'src/index.ts': 'export const x = 2;\n' });
    const f1 = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA1 }] });
    const f2 = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA2 }] });
    expect(f1.root).not.toBe(f2.root);
    expect(f1.entries['row-a']).not.toBe(f2.entries['row-a']);
    expect(f1.entries['agent-config']).toBe(f2.entries['agent-config']); // 未变行子指纹不动
  });

  it('config / catalog 任一变更 → 根漂移（行集推导输入全覆盖）', () => {
    const rowA = seedRow('row-a', { 'src/index.ts': 'x\n' });
    const f1 = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA }] });
    const f2 = subjectFingerprint({ ...base, configJson: JSON.stringify({ id: 'beta' }), rows: [{ id: 'row-a', root: rowA }] });
    const f3 = subjectFingerprint({ ...base, catalogJson: JSON.stringify({ rows: [] }), rows: [{ id: 'row-a', root: rowA }] });
    expect(new Set([f1.root, f2.root, f3.root]).size).toBe(3);
  });

  it('EOL 差异不漂移（CRLF 与 LF 同内容同根——两侧跨平台对拍前提）', () => {
    const rowA1 = seedRow('row-a1', { 'src/x.ts': 'a\nb\n' });
    const rowA2 = seedRow('row-a2', { 'src/x.ts': 'a\r\nb\r\n' });
    const f1 = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA1 }] });
    const f2 = subjectFingerprint({ ...base, rows: [{ id: 'row-a', root: rowA2 }] });
    expect(f1.root).toBe(f2.root);
  });
});
