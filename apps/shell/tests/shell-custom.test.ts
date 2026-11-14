// ============================================================
// shell.patch.yml 用户差量层集成测试（cr-1003 / cr-1004 改名）：经
// deriveAndAssertRowset 的词形三件——except 豁免 / 恒并席位护栏 /
// replace 换向。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveAndAssertRowset } from '../boot.ts';
import { writeAgentConfig } from 'ac-agents-core';
import { readCatalog } from 'ac-rowset-core';

const ROOT = path.join('sandbox', 'test-shell-custom-' + process.pid);
const CATALOG = path.join('sandbox', 'test-shell-custom-cat-' + process.pid + '.json');

function writeCustom(body: string): void {
  fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'profile', 'shell.patch.yml'), body, 'utf-8');
}

function writeFixture(): void {
  // cr-1022 批3 菜单语义：conversation = 骨架区（恒装席位——停用拒绝
  // 生效的判据来自 zone，不再来自旧「基础集恒并」词表）
  fs.writeFileSync(CATALOG, JSON.stringify({
    version: 1,
    rows: [
      { id: 'conversation', tree: 'shell', zone: 'skeleton' },
      { id: 'browser', tree: 'shell' },
      { id: 'math', tree: 'shell' },
      { id: 'fs-x', tree: 'shell' },
    ],
  }, null, 2) + '\n', 'utf-8');
}

// v3 播种（cr-1022 批3）：正清单定义拷贝经 opts.shellRows 注入 fixture 目录
//（cr-1067 基线戳退役——播种与用户层落盘顺序不再有戳约束）
function seedAgent(agentId: string, rows: string[]): void {
  const shellRows = readCatalog(CATALOG).rows.filter((r) => r.tree === 'shell');
  writeAgentConfig(ROOT, { id: agentId, model: 'mock', rows }, { shellRows });
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
  it('disable + except：豁免 Agent 保留；非豁免 Agent 点名被停用行 = 良定义降级（cr-1022 批2 菜单语义：用户层停用 = 全局显式意志，行出局不 throw）', () => {
    writeCustom('- { id: browser, disabled: true, except: [a1]}' + String.fromCharCode(10));
    seedAgent('a1', ['browser', 'math']);
    seedAgent('a2', ['browser', 'math']);
    const a1 = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    expect(a1.rowIds).toContain('browser');
    const a2 = deriveAndAssertRowset(ROOT, 'a2', CATALOG);
    expect(a2.rowIds).not.toContain('browser');
    // 点名行被用户层停用 → 良定义降级（行出局、不 throw；豁免 Agent 保留）
    writeCustom('- { id: fs-x, disabled: true, except: [a1]}' + String.fromCharCode(10));
    seedAgent('a1', ['fs-x']);
    seedAgent('a2', ['fs-x']);
    expect(deriveAndAssertRowset(ROOT, 'a1', CATALOG).rowIds).toContain('fs-x'); // 豁免
    expect(deriveAndAssertRowset(ROOT, 'a2', CATALOG).rowIds).not.toContain('fs-x'); // 降级出局
  });

  it('恒并席位停用拒绝生效：行保留 + 派生不含席位缺席', () => {
    writeCustom('- { id: conversation, disabled: true}\n');
    seedAgent('a1', ['math']);
    const rowset = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    expect(rowset.rowIds).toContain('conversation'); // 恒并席位照常在场（骨架区恒装）
    expect(rowset.rowIds).toContain('math'); // 点名能力行照常
  });

  it('replace：基座行 path 换向 + replacedIds 标记（装配面绕出厂实现的锚）', () => {
    const dir = path.join(ROOT, 'my-math').replace(/\\/g, '/');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'my-math', version: '1.0.0', entry: 'index.ts',
      rows: [{ id: 'math', tools: ['math', 'math_pro'] }],
    }), 'utf-8');
    writeCustom('- { id: math, replace: \'link:' + dir + '\'}\n');
    seedAgent('a1', ['math']);
    const rowset = deriveAndAssertRowset(ROOT, 'a1', CATALOG);
    // 换向锚 = path + replacedIds（tools 声明词汇退役——工具面经注册面观测）
    const math = rowset.rows.find((r) => r.id === 'math')!;
    expect(math.path).toBe(dir);
    expect(rowset.replacedIds.has('math')).toBe(true);
  });
});
