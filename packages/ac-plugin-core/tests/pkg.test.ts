// ============================================================
// pkg.test.ts + installed.test.ts 合档 —— 包描述符层单测
//（cr-903 / cr-901 v2.1 批2 切片一）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readPluginPackage, evaluateEngines, projectLegacyManifest,
  AGENTCHAT_ABI_VERSION,
} from '../src/pkg.ts';
import { readInstalledDoc, writeInstalledDoc, installedDocFile } from '../src/installed.ts';
import type { PluginManifest } from '../src/manifest.ts';

const ROOT = path.join('sandbox', 'test-pkg-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writePkg(dir: string, pkg: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return dir;
}

describe('readPluginPackage（ac 字段）', () => {
  it('三面 + 权限 + provides 原样入档', () => {
    const dir = writePkg(path.join(ROOT, 'full'), {
      name: 'ac-plugin-todo',
      version: '1.0.0',
      engines: { node: '>=23', agentchat: '^2' },
      ac: {
        faces: {
          node: { entry: './src/index.ts' },
          web: { entry: './client/index.js', seats: ['tool-card'] },
          data: { skills: './skills' },
        },
        permissions: ['fs'],
        provides: { tools: ['todo-add'] },
      },
    });
    const p = readPluginPackage(dir);
    expect(p.form).toBe('package');
    expect(p.name).toBe('ac-plugin-todo');
    expect(p.engines).toEqual({ node: '>=23', agentchat: '^2' });
    expect(p.ac?.faces?.node).toEqual({ entry: './src/index.ts' });
    expect(p.ac?.faces?.web).toEqual({ entry: './client/index.js', seats: ['tool-card'] });
    expect(p.ac?.faces?.data).toEqual({ skills: './skills' });
    expect(p.ac?.permissions).toEqual(['fs']);
    expect(p.ac?.provides).toEqual({ tools: ['todo-add'] });
  });

  it('非法面/未知权限词被忽略（fail-soft 收编）；缺 name → throw', () => {
    const dir = writePkg(path.join(ROOT, 'loose'), {
      name: 'p',
      version: '0.0.1',
      ac: { faces: { node: { entry: '' } }, permissions: ['fs', 'no-such'] },
    });
    const p = readPluginPackage(dir);
    expect(p.ac?.faces).toBeUndefined();
    expect(p.ac?.permissions).toEqual(['fs']);
    const bad = writePkg(path.join(ROOT, 'bad'), { version: '1.0.0' });
    expect(() => readPluginPackage(bad)).toThrow('缺 name/version');
  });

  it('旧 manifest.json 投影：entry→faces.node、ui→faces.web、contracts→legacyContracts', () => {
    const manifest: PluginManifest = {
      name: 'old-one',
      version: '0.2.0',
      entry: 'index.ts',
      contracts: '^1',
      permissions: ['network'],
      provides: { tools: ['hello'] },
      ui: { entry: 'client.js', slots: ['perspective'] },
    };
    const p = projectLegacyManifest(manifest, path.join(ROOT, 'x'));
    expect(p.form).toBe('legacy-manifest');
    expect(p.ac?.faces?.node).toEqual({ entry: 'index.ts' });
    expect(p.ac?.faces?.web).toEqual({ entry: 'client.js', seats: ['perspective'] });
    expect(p.legacyContracts).toBe('^1');
    expect(p.ac?.permissions).toEqual(['network']);
  });

  it('目录内旧 manifest 无 package.json → 投影读取', () => {
    const dir = path.join(ROOT, 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'legacy-pkg', version: '1.0.0', entry: 'index.ts',
    }));
    const p = readPluginPackage(dir);
    expect(p.form).toBe('legacy-manifest');
    expect(p.name).toBe('legacy-pkg');
  });
});

describe('evaluateEngines（自求值，fail-closed）', () => {
  const base = { name: 'p', version: '1.0.0', form: 'package' } as const;

  it('双轴满足；未声明轴放行', () => {
    expect(evaluateEngines({ ...base, engines: { node: '>=20', agentchat: '^2' } }).ok).toBe(true);
    expect(evaluateEngines(base, { node: 'v24.1.0' }).ok).toBe(true);
  });

  it('node 轴不满足（v 前缀容差）/ agentchat 轴不满足 → 失败明细', () => {
    const a = evaluateEngines({ ...base, engines: { node: '>=99' } }, { node: 'v24.1.0' });
    expect(a.ok).toBe(false);
    expect(a.failures[0]).toContain('engines.node');
    const b = evaluateEngines({ ...base, engines: { agentchat: '^1' } }, { agentchat: AGENTCHAT_ABI_VERSION });
    expect(b.ok).toBe(false);
    expect(b.failures[0]).toContain('engines.agentchat');
  });

  it('旧 contracts 沿 1.x 轴求值；engines.agentchat 在场时 contracts 退位', () => {
    expect(evaluateEngines({ ...base, legacyContracts: '^1' }).ok).toBe(true);
    expect(evaluateEngines({ ...base, legacyContracts: '^2' }).ok).toBe(false);
    expect(evaluateEngines({ ...base, engines: { agentchat: '^2' }, legacyContracts: '^9' }).ok).toBe(true);
  });
});

describe('installed.patch.yml 读写', () => {
  it('缺席 = 空集；写读往返保形；损坏 → throw', () => {
    expect(readInstalledDoc(ROOT)).toEqual([]);
    writeInstalledDoc(ROOT, [
      { id: 'my-todo', name: 'ac-plugin-todo', owner: 'agent-1', scope: 'shell' },
      { id: 'my-local', name: 'link:C:/dev/my-plugin', disabled: true },
    ]);
    expect(readInstalledDoc(ROOT)).toEqual([
      { id: 'my-todo', name: 'ac-plugin-todo', owner: 'agent-1', scope: 'shell' },
      { id: 'my-local', name: 'link:C:/dev/my-plugin', disabled: true },
    ]);
    fs.writeFileSync(installedDocFile(ROOT), 'version: 2\n');
    expect(() => readInstalledDoc(ROOT)).toThrow('顶层必须是条目数组');
    fs.writeFileSync(installedDocFile(ROOT), '- id: x\n');
    expect(() => readInstalledDoc(ROOT)).toThrow('缺 id/name');
  });
});
