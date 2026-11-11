// ============================================================
// shell.patch.yml 用户差量层集成测试（cr-1003 / cr-1004 改名）：经
// deriveAndAssertRowset 的词形三件——except 豁免 / 恒并席位护栏 /
// replace 换向。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveAndAssertRowset } from '../boot.ts';

const ROOT = path.join('sandbox', 'test-shell-custom-' + process.pid);
const CATALOG = path.join('sandbox', 'test-shell-custom-cat-' + process.pid + '.json');

function writeCustom(body: string): void {
  fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'profile', 'shell.patch.yml'), body, 'utf-8');
}

function writeFixture(): void {
  fs.writeFileSync(CATALOG, JSON.stringify({
    version: 1,
    rows: [
      { id: 'conversation', tree: 'shell' },
      { id: 'browser', tree: 'shell', tools: ['browser'] },
      { id: 'math', tree: 'shell', tools: ['math'] },
      { id: 'fs-x', tree: 'shell', tools: ['fsx'], bundle: 'fs' },
    ],
  }, null, 2) + '\n', 'utf-8');
  fs.mkdirSync(path.join(ROOT, 'agents', 'a1'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'agents', 'a2'), { recursive: true });
  for (const id of ['a1', 'a2']) {
    fs.writeFileSync(path.join(ROOT, 'agents', id, 'config.json'), JSON.stringify({
      id, model: 'mock', rows: { include: ['conversation', 'browser', 'math'] },
    }, null, 2) + '\n', 'utf-8');
  }
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  writeFixture();
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(CATALOG, { force: true });
});

describe('deriveAndAssertRowset × shell-custom（cr-1003）', () => {
  it('disable + except：豁免 Agent 保留；非豁免 Agent 显式点名被停用行 = fail-loud（cr-1007 精简后：基础集行的 no-op 点名不落条目——用户层停用为静默良定义降级；捆绑行点名是真差量，仍 fail-loud）', () => {
    writeCustom('- { id: browser, disabled: true, except: [a1]}' + String.fromCharCode(10));
    const a1 = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    expect(a1.rowIds).toContain('browser');
    // 基础集行（browser）：include 点名被精简（no-op 不落条目）→ 非豁免 Agent
    // 静默降级（行出局、不 throw——用户层停用 = 全局显式意志）
    const a2 = deriveAndAssertRowset(ROOT, 'a2', CATALOG);
    expect(a2.rowIds).not.toContain('browser');
    // 捆绑行点名（真差量条目）被用户层停用 → 求值 fail-loud（点名不可见非静默丢面）
    for (const id of ['a1', 'a2']) {
      fs.writeFileSync(path.join(ROOT, 'agents', id, 'config.json'), JSON.stringify({
        id, model: 'mock', rows: { include: ['fs-x'] },
      }, null, 2) + String.fromCharCode(10), 'utf-8');
    }
    writeCustom('- { id: fs-x, disabled: true, except: [a1]}' + String.fromCharCode(10));
    expect(deriveAndAssertRowset(ROOT, 'a1', CATALOG).rowIds).toContain('fs-x'); // 豁免
    expect(() => deriveAndAssertRowset(ROOT, 'a2', CATALOG)).toThrow(/fs-x/);
  });

  it('恒并席位停用拒绝生效：行保留 + 派生不含席位缺席', () => {
    writeCustom('- { id: conversation, disabled: true}\n');
    const rowset = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    expect(rowset.rowIds).toContain('conversation'); // 恒并席位照常在场
  });

  it('replace：基座行 path 换向 + replacedIds 标记（装配面绕出厂实现的锚）', () => {
    const dir = path.join(ROOT, 'my-math').replace(/\\/g, '/');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'my-math', version: '1.0.0', entry: 'index.ts',
      rows: [{ id: 'math', tools: ['math', 'math_pro'] }],
    }), 'utf-8');
    writeCustom('- { id: math, replace: \'link:' + dir + '\'}\n');
    const rowset = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    const math = rowset.catalogRows.find((r) => r.id === 'math')!;
    expect(math.path).toBe(dir);
    expect(math.tools).toEqual(['math', 'math_pro']);
    expect(rowset.replacedIds.has('math')).toBe(true);
    expect(rowset.toolNames).toContain('math_pro');
  });
});
