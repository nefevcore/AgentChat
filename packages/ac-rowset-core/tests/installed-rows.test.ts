// ============================================================
// installed-rows.test.ts —— installed.yml 反向适配分析单测（cr-908 批6
// 切片一 / cr-1004 §三：scope 投影退役——基座分析包 face 声明）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fitInstalledRows, packageDeclaresFace } from '../src/installed-rows.ts';
import { mergeRowsetCatalog } from '../src/plugin-rows.ts';

const ROOT = path.join('sandbox', 'test-installed-rows-' + process.pid);
beforeEach(() => fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedInstalled(entries: unknown[], file = 'installed.yml'): void {
  fs.writeFileSync(path.join(ROOT, 'profile', file),
    entries.map((e) => '- ' + JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
}

describe('fitInstalledRows 反向适配（cr-1004）', () => {
  it('link: 词形物化 + manifest.rows 投影；owner 锚过滤非 owner', () => {
    const dir = path.join(ROOT, 'plugins', 'ac-plugin-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'ac-plugin-x', version: '1.0.0', entry: 'index.ts',
      rows: [{ id: 'x-row', tools: ['x-tool'], requires: ['tools'] }],
    }));
    seedInstalled([{ id: 'ac-plugin-x', name: 'link:' + dir, owner: 'me' }]);
    const mine = fitInstalledRows(ROOT, 'shell', 'me');
    expect(mine.rows).toEqual([{ id: 'x-row', tree: 'shell', requires: ['tools'], path: dir }]);
    const other = fitInstalledRows(ROOT, 'shell', 'someone-else');
    expect(other.rows).toEqual([]); // owner 锚
    // 无 owner = 全体候选（市场人签安装）
    seedInstalled([{ id: 'ac-plugin-x', name: 'link:' + dir }]);
    expect(fitInstalledRows(ROOT, 'shell', 'anyone').rows).toHaveLength(1);
  });

  it('package 形态经 provides.tools 投影；npm 裸名词形 → profile/node_modules', () => {
    const dir = path.join(ROOT, 'profile', 'node_modules', 'npm-pkg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'npm-pkg', version: '1.0.0', ac: { faces: { node: { entry: './src/index.ts' } }, provides: { tools: ['npm-tool'] } },
    }));
    seedInstalled([{ id: 'npm-pkg', name: 'npm-pkg' }]);
    const r = fitInstalledRows(ROOT, 'shell', 'me');
    expect(r.rows).toEqual([{ id: 'npm-pkg', tree: 'shell', path: dir }]);
  });

  it('face 反向适配：web-only 包不进 shell 基座；host 面 fail-closed；旧文件名兼容读', () => {
    const webDir = path.join(ROOT, 'profile', 'node_modules', 'web-only');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'package.json'), JSON.stringify({
      name: 'web-only', ac: { faces: { web: { entry: './src/ui.ts' } } },
    }));
    // 旧文件名 installed.patch.yml 读侧兼容（cr-1004 改名窗口）
    seedInstalled([{ id: 'web-only', name: 'web-only' }], 'installed.patch.yml');
    expect(fitInstalledRows(ROOT, 'shell', 'me').rows).toEqual([]); // 不适配 shell = 自然跳过
    expect(fitInstalledRows(ROOT, 'webui', 'me').rows.length).toBeGreaterThan(0); // face:web 命中
    expect(fitInstalledRows(ROOT, 'host', 'me').rows).toEqual([]); // 宿主信任域 fail-closed
  });

  it('点名缺席 = 警告 + 跳过（降级语义，不炸）；disabled 过滤', () => {
    seedInstalled([
      { id: 'ghost', name: 'link:' + path.join(ROOT, 'nope') },
      { id: 'off', name: 'npm-off', disabled: true },
    ]);
    const r = fitInstalledRows(ROOT, 'shell', 'me');
    expect(r.rows).toEqual([]);
    expect(r.warnings.join()).toContain('ghost');
    expect(r.warnings.join()).not.toContain('off');
  });

  it('与出厂目录合并：installed 行可进派生（含 requires 闭包经引擎）', () => {
    const dir = path.join(ROOT, 'plugins', 'ac-plugin-y');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'ac-plugin-y', version: '1.0.0', entry: 'index.ts', rows: [{ id: 'y-row', tools: ['y-tool'], requires: ['tools'] }],
    }));
    seedInstalled([{ id: 'ac-plugin-y', name: 'link:' + dir }]);
    const { rows } = fitInstalledRows(ROOT, 'shell', 'me');
    const catalog = { rows: [{ id: 'tools', tree: 'shell' as const, path: 'packages/ac-tools' }] };
    const merged = mergeRowsetCatalog(catalog, rows);
    expect(merged.warnings).toEqual([]);
    expect(merged.catalog.rows.map((r2) => r2.id)).toContain('y-row');
  });

  it('packageDeclaresFace：faces 声明 / manifest.rows / provides.tools 历史容忍', () => {
    const mk = (pkg: unknown): string => {
      const dir = path.join(ROOT, 'p-' + Math.random().toString(36).slice(2));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      return dir;
    };
    expect(packageDeclaresFace(mk({ ac: { faces: { web: {} } } }), 'web')).toBe(true);
    expect(packageDeclaresFace(mk({ ac: { provides: { tools: ['t'] } } }), 'node')).toBe(true);
    expect(packageDeclaresFace(mk({ ac: { provides: { tools: ['t'] } } }), 'web')).toBe(false);
  });
});
