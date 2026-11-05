// ============================================================
// npm-form.test.ts —— npm 形态落位单测（cr-904 / cr-901 v2.1 批2 余项）
// 真 pnpm（file: 本地目录 spec——零网络）；慢测标注。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  installNpmPackage, pnpmAdd, lockTreeFingerprint, lockDiffOf, npmProfileRoot,
} from '../src/npm-form.ts';
import { readInstalledDoc } from '../src/installed.ts';
import { resetQueuesForTest } from '../src/fsx.ts';

const ROOT = path.join('sandbox', 'test-npm-form-' + process.pid);
const PKG = path.join(ROOT, 'pkg-src');
beforeEach(() => {
  resetQueuesForTest();
  fs.mkdirSync(PKG, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetQueuesForTest();
});

function writeLocalPlugin(version = '1.0.0'): void {
  fs.writeFileSync(path.join(PKG, 'package.json'), JSON.stringify({
    name: 'ac-plugin-npmtest', version,
    engines: { node: '>=20', agentchat: '^2' },
    ac: { permissions: ['fs'], provides: { tools: ['npm-tool'] } },
  }, null, 2));
  fs.writeFileSync(path.join(PKG, 'index.ts'), 'export const apply = () => {};' + String.fromCharCode(10));
}

describe('npm 形态落位（真 pnpm，file: spec）', () => {
  it('applied：profile 根落位 + 锁文件指纹 + lock diff + npm 词形登记', { timeout: 120_000 }, async () => {
    writeLocalPlugin();
    const r = await installNpmPackage({
      dataRoot: ROOT,
      spec: 'file:' + path.resolve(PKG),
      owner: 'agent-1',
      grants: ['fs'],
    });
    expect(r.result).toBe('applied');
    expect(r.name).toBe('ac-plugin-npmtest');
    expect(r.fingerprint?.kind).toBe('lock-tree');
    expect(r.fingerprint?.hash).toHaveLength(64);
    expect(r.lockDiff?.changed).toBe(true);
    // 物化在场 + ignore-scripts 门（node_modules 在 profile 根下）
    expect(fs.existsSync(path.join(npmProfileRoot(ROOT), 'node_modules', 'ac-plugin-npmtest'))).toBe(true);
    // npm 词形 = 裸包名（与目录形态 link: 分轨）
    expect(readInstalledDoc(ROOT)).toEqual([
      { id: 'ac-plugin-npmtest', name: 'ac-plugin-npmtest', owner: 'agent-1', scope: 'shell' },
    ]);
  });

  it('门禁失败回滚（engines 不满足 → 不留落位半态）', { timeout: 120_000 }, async () => {
    fs.writeFileSync(path.join(PKG, 'package.json'), JSON.stringify({
      name: 'ac-plugin-badabi', version: '1.0.0',
      engines: { agentchat: '^1' },
      ac: { permissions: ['fs'] },
    }, null, 2));
    fs.writeFileSync(path.join(PKG, 'index.ts'), 'export const apply = () => {};');
    const r = await installNpmPackage({
      dataRoot: ROOT,
      spec: 'file:' + path.resolve(PKG),
      owner: 'a',
      grants: ['fs'],
    });
    expect(r.result).toBe('failed');
    expect(r.reasons?.join()).toContain('engines.agentchat');
    expect(fs.existsSync(path.join(npmProfileRoot(ROOT), 'node_modules', 'ac-plugin-badabi'))).toBe(false);
    expect(readInstalledDoc(ROOT)).toEqual([]);
  });
});

describe('纯函数面', () => {
  it('lockDiffOf：同锁零变更 / 新锁 changed + 包级清单', () => {
    const a = ['lockfileVersion: 9.0', 'packages:', '  pkg-a@1.0.0:', '    resolution: x'].join(String.fromCharCode(10));
    const b = ['lockfileVersion: 9.0', 'packages:', '  pkg-a@1.0.0:', '    resolution: x', '  pkg-b@2.0.0:', '    resolution: y'].join(String.fromCharCode(10));
    expect(lockDiffOf(a, a)).toEqual({ added: [], removed: [], changed: false });
    const d = lockDiffOf(a, b);
    expect(d.changed).toBe(true);
    expect(d.added).toEqual(['pkg-b@2.0.0']);
    expect(lockDiffOf(null, null)).toEqual({ added: [], removed: [], changed: false });
  });

  it('lockTreeFingerprint：缺席 = null；pnpmAdd 幂等建 profile package.json', () => {
    expect(lockTreeFingerprint(ROOT)).toBeNull();
  });
});
