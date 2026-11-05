// ============================================================
// installed-rows.test.ts —— installed.patch.yml 菜单投影单测（cr-908 批6 切片一）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installedRowDescriptors } from '../src/installed-rows.ts';
import { mergeRowsetCatalog } from '../src/plugin-rows.ts';

const ROOT = path.join('sandbox', 'test-installed-rows-' + process.pid);
beforeEach(() => fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedInstalled(entries: unknown[]): void {
  fs.writeFileSync(path.join(ROOT, 'profile', 'installed.patch.yml'),
    entries.map((e) => '- ' + JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
}

describe('installedRowDescriptors 菜单投影（cr-908）', () => {
  it('link: 词形物化 + manifest.rows 投影；owner 锚过滤非 owner', () => {
    const dir = path.join(ROOT, 'plugins', 'ac-plugin-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'ac-plugin-x', version: '1.0.0', entry: 'index.ts',
      rows: [{ id: 'x-row', tools: ['x-tool'], requires: ['tools'] }],
    }));
    seedInstalled([{ id: 'ac-plugin-x', name: 'link:' + dir, owner: 'me', scope: 'shell' }]);
    const mine = installedRowDescriptors(ROOT, 'me');
    expect(mine.rows).toEqual([{ id: 'x-row', tree: 'shell', tools: ['x-tool'], requires: ['tools'], path: dir }]);
    const other = installedRowDescriptors(ROOT, 'someone-else');
    expect(other.rows).toEqual([]); // owner 锚
    // 无 owner = 全体候选（市场人签安装）
    seedInstalled([{ id: 'ac-plugin-x', name: 'link:' + dir }]);
    expect(installedRowDescriptors(ROOT, 'anyone').rows).toHaveLength(1);
  });

  it('package 形态经 provides.tools 投影；npm 裸名词形 → profile/node_modules', () => {
    const dir = path.join(ROOT, 'profile', 'node_modules', 'npm-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'npm-pkg', version: '1.0.0', ac: { faces: { node: { entry: './src/index.ts' } }, provides: { tools: ['npm-tool'] } },
    }));
    seedInstalled([{ id: 'npm-pkg', name: 'npm-pkg' }]);
    const r = installedRowDescriptors(ROOT, 'me');
    expect(r.rows).toEqual([{ id: 'npm-pkg', tree: 'shell', tools: ['npm-tool'], path: dir }]);
  });

  it('点名缺席 = 警告 + 跳过（降级语义，不炸）；disabled/scope 非 shell 过滤', () => {
    seedInstalled([
      { id: 'ghost', name: 'link:' + path.join(ROOT, 'nope') },
      { id: 'off', name: 'npm-off', disabled: true },
      { id: 'hostface', name: 'npm-h', scope: 'host' },
    ]);
    const r = installedRowDescriptors(ROOT, 'me');
    expect(r.rows).toEqual([]);
    expect(r.warnings.join()).toContain('ghost');
    expect(r.warnings.join()).not.toContain('off');
  });

  it('与出厂目录合并：installed 行可进派生（含 requires 闭包）', () => {
    const dir = path.join(ROOT, 'plugins', 'ac-plugin-y');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'ac-plugin-y', version: '1.0.0', entry: 'index.ts', rows: [{ id: 'y-row', tools: ['y-tool'], requires: ['tools'] }],
    }));
    seedInstalled([{ id: 'ac-plugin-y', name: 'link:' + dir }]);
    const { rows } = installedRowDescriptors(ROOT, 'me');
    const catalog = { rows: [{ id: 'tools', tree: 'shell' as const, path: 'packages/ac-tools' }] };
    const merged = mergeRowsetCatalog(catalog, rows);
    expect(merged.warnings).toEqual([]);
    expect(merged.catalog.rows.map((r2) => r2.id)).toContain('y-row');
  });
});
