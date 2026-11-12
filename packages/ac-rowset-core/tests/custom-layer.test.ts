// ============================================================
// custom-layer.test.ts —— <proc>.patch.yml 用户差量层单测（cr-909 批6
// 切片三；cr-1003 词形扩展；cr-1004 改名 + 差量层词形 + 引擎分责：
// 层解析/replace 换向在此，disable/豁免/席位护栏在 evaluate——
// rowset.test.ts 已锁，此处锁换向解析面）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAssemblyPatch, resolveReplacements, type RowsetCatalog } from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-custom-layer-' + process.pid);
const PROFILE = path.join(ROOT, 'profile');
beforeEach(() => fs.mkdirSync(PROFILE, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeShellPatch(body: string, file = 'shell.patch.yml'): void {
  fs.writeFileSync(path.join(PROFILE, file), body, 'utf-8');
}
const NL = String.fromCharCode(10);

describe('readAssemblyPatch（cr-909 / cr-1003 / cr-1004 改名）', () => {
  it('缺席 = 空层零警告（常态）；disable 面解析；坏文件 = 空层 + 警告不炸', () => {
    expect(readAssemblyPatch(PROFILE, 'host')).toEqual({ entries: [], replace: new Map(), warnings: [] });
    writeShellPatch('- id: sap-adt' + String.fromCharCode(10) + '  disabled: true' + String.fromCharCode(10));
    const layer = readAssemblyPatch(PROFILE, 'shell');
    expect(layer.entries).toEqual([{ id: 'sap-adt', disabled: true }]);
    expect(layer.warnings).toEqual([]);
    fs.writeFileSync(path.join(PROFILE, 'webui.patch.yml'), '{nope');
    const bad = readAssemblyPatch(PROFILE, 'webui');
    expect(bad.entries.length).toBe(0);
    expect(bad.warnings.join()).toContain('不可读');
  });

  it('旧名 <proc>-custom.patch.yml 只读兼容（改名窗口）', () => {
    writeShellPatch('- id: browser' + String.fromCharCode(10) + '  disabled: true' + String.fromCharCode(10), 'shell-custom.patch.yml');
    const layer = readAssemblyPatch(PROFILE, 'shell');
    expect(layer.entries).toEqual([{ id: 'browser', disabled: true }]);
  });

  it('except 只随 disabled 生效；disabled × replace 互斥按停用生效；config 解析', () => {
    writeShellPatch([
      '- { id: browser, disabled: true, except: [dev-1, dev-2]}',
      "- { id: math, except: [x] }",
      '- { id: datetime, disabled: true, replace: link:/nowhere }',
      "- { id: skill, replace: 'link:/my-skill' }",
      '- { id: shell-tools, config: { profile: full } }',
      '',
    ].join(NL));
    const layer = readAssemblyPatch(PROFILE, 'shell');
    expect(layer.entries).toContainEqual({ id: 'browser', disabled: true, except: ['dev-1', 'dev-2'] });
    expect(layer.entries).toContainEqual({ id: 'shell-tools', config: { profile: 'full' } });
    expect(layer.replace.has('datetime')).toBe(false); // 互斥：replace 忽略
    expect(layer.replace.get('skill')).toBe('link:/my-skill');
    expect(layer.warnings.join(NL)).toMatch(/except 只随 disabled/);
    expect(layer.warnings.join(NL)).toMatch(/互斥/);
  });
});

describe('resolveReplacements（cr-1003：replace 先行换向）', () => {
  const CATALOG: RowsetCatalog = { rows: [
    { id: 'backup', tree: 'host' },
    { id: 'conversation', tree: 'shell' },
    { id: 'browser', tree: 'shell' },
    { id: 'math', tree: 'shell', requires: ['ledger'] },
  ] };
  const IMPL_DIR = path.join(ROOT, 'my-math');
  beforeEach(() => {
    fs.mkdirSync(IMPL_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMPL_DIR, 'manifest.json'), JSON.stringify({
      name: 'my-math', version: '1.0.0',
      rows: [{ id: 'math', requires: ['conversation'] }],
    }), 'utf-8');
  });

  it('replace：id 不变 path 换向 + 同 id 声明覆盖 requires（tools 派生词已随 cr-1022 批2 退役）', () => {
    const replace = new Map([['math', 'link:' + IMPL_DIR.replace(/\\/g, '/')]]);
    const out = resolveReplacements(CATALOG.rows, replace, ROOT);
    const math = out.rows.find((r) => r.id === 'math')!;
    expect(math.path).toBe(IMPL_DIR.replace(/\\/g, '/'));
    expect(math.requires).toEqual(['conversation']);
    expect(out.replacedIds).toEqual(new Set(['math']));
    expect(out.warnings).toEqual([]);
  });

  it('replace 物化缺席 = 警告 + 保留基座行（requires 不被改写）；点名不在菜单 = 警告跳过', () => {
    const replace = new Map([
      ['math', 'link:' + path.join(ROOT, 'no-such').replace(/\\/g, '/')],
      ['ghost', 'link:/x'],
    ]);
    const out = resolveReplacements(CATALOG.rows, replace, ROOT);
    expect(out.rows.find((r) => r.id === 'math')!.requires).toEqual(['ledger']); // 基座面保留
    expect(out.warnings.join(NL)).toMatch(/物化缺席/);
    expect(out.warnings.join(NL)).toMatch(/不在基座菜单/);
  });
});
