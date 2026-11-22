// ============================================================
// installer.test.ts —— 统一安装器 + 两轴回执单测
//（cr-903 / cr-901 v2.1 批2 切片二）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installPackage, uninstallPackage, admissionOf } from '../src/installer.ts';
import { effectiveStateOf, needsReinstallOf } from '../src/receipt.ts';
import { readInstalledDoc } from '../src/installed.ts';
import { readRegistry, listInstalled } from '../src/store.ts';
import { resetQueuesForTest } from '../src/fsx.ts';

const ROOT = path.join('sandbox', 'test-installer-' + process.pid);
const SRC = path.join(ROOT, 'src-plugin');
beforeEach(() => {
  resetQueuesForTest();
  fs.mkdirSync(SRC, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetQueuesForTest();
});

function writePlugin(extra: Record<string, unknown> = {}, manifestExtra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    engines: { node: '>=20', agentchat: '^2' },
    ac: { permissions: ['fs', 'shell'], provides: { tools: ['demo-tool'] }, ...extra },
  }, null, 2));
  fs.writeFileSync(path.join(SRC, 'manifest.json'), JSON.stringify({
    name: 'demo-plugin', version: '1.0.0', entry: 'index.ts',
    permissions: ['fs', 'shell'], provides: { tools: ['demo-tool'] },
    rows: [{ id: 'demo-row', tools: ['demo-tool'], description: '演示行' }],
    ...manifestExtra,
  }, null, 2));
  fs.writeFileSync(path.join(SRC, 'index.ts'), 'export const apply = () => {};' + '\n');
}

describe('admissionOf 门禁', () => {
  it('合法包通过；engines 不满足 / 权限未授予 / 保留字撞名 → 明细拒绝', () => {
    writePlugin();
    expect(admissionOf(SRC, ['fs', 'shell']).ok).toBe(true);
    expect(admissionOf(SRC, ['fs']).ok).toBe(false); // shell 强制显式授予（fs 默认授予）
    writePlugin({}, { name: 'bad-engines-plugin' });
    fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({
      name: 'bad-engines-plugin', version: '1.0.0',
      engines: { agentchat: '^1' },
    }));
    const v = admissionOf(SRC, ['fs', 'shell']);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain('engines.agentchat');
    writePlugin({ provides: { tools: ['math'] } }); // 内置工具名
    const r = admissionOf(SRC, ['fs', 'shell']);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('保留');
    // cr-1207：package 形态保留名门禁（pkg.name 撞官方命名空间 → 门禁 reasons
    // 拒绝，不再静默哑弹到装载期 plugin-guard；admissionOf 捕获读取 throw 入 reasons）
    fs.rmSync(path.join(SRC, 'manifest.json'));
    fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({
      name: 'ac-evil', version: '1.0.0',
    }));
    const reserved = admissionOf(SRC, ['fs', 'shell']);
    expect(reserved.ok).toBe(false);
    expect(reserved.reasons.join()).toContain('官方命名空间');
  });
});

describe('installPackage 事务 + 登记 + 回执', () => {
  it('applied：物化 + installed.yml 登记 + registry 落账；无活进程 → live', async () => {
    writePlugin();
    const r = await installPackage({ root: ROOT, sourceDir: SRC, owner: 'agent-1', grants: ['fs', 'shell'] });
    expect(r.result).toBe('applied');
    expect(r.effective).toBe('live');
    expect(r.installedDir).toContain(path.join(ROOT, 'plugins', 'demo-plugin'));
    expect(readInstalledDoc(ROOT)).toEqual([
      { id: 'demo-plugin', name: 'link:' + path.join(ROOT, 'plugins', 'demo-plugin'), owner: 'agent-1' },
    ]);
    expect(listInstalled(ROOT).map((p) => p.manifest.name)).toContain('demo-plugin');
  });

  it('活壳在场 → restart-required；门禁失败 → failed 回执不 throw', async () => {
    writePlugin();
    const r = await installPackage({
      root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'],
      liveProcesses: [{ kind: 'shell', pid: 4242 }],
    });
    expect(r.effective).toBe('restart-required');
    const bad = await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs'] }); // shell 未授予
    expect(bad.result).toBe('failed');
    expect(bad.reasons?.join()).toContain('未授予的权限');
  });

  it('重复安装同版本 → failed（approveStaging 同版本拒绝）', async () => {
    writePlugin();
    await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    const again = await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    expect(again.result).toBe('failed');
  });

  it('uninstallPackage 对称摘除（物化 + 登记 + registry）', async () => {
    writePlugin();
    await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    const r = await uninstallPackage({ root: ROOT, name: 'demo-plugin' });
    expect(r.result).toBe('applied');
    expect(readInstalledDoc(ROOT)).toEqual([]);
    expect(listInstalled(ROOT)).toHaveLength(0);
    expect(fs.existsSync(path.join(ROOT, 'plugins', 'demo-plugin'))).toBe(false);
  });

  it('升级 = 换版本重装（replaced 带旧版本）', async () => {
    writePlugin();
    await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({
      name: 'demo-plugin', version: '1.1.0',
      engines: { node: '>=20', agentchat: '^2' },
      ac: { permissions: ['fs'], provides: { tools: ['demo-tool'] } },
    }, null, 2));
    fs.writeFileSync(path.join(SRC, 'manifest.json'), JSON.stringify({
      name: 'demo-plugin', version: '1.1.0', entry: 'index.ts',
      permissions: ['fs', 'shell'], provides: { tools: ['demo-tool'] },
    }, null, 2));
    const up = await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    expect(up.result).toBe('applied');
    expect(up.replaced?.oldVersion).toBe('1.0.0');
    expect(readInstalledDoc(ROOT)).toHaveLength(1);
  });
});

describe('两轴求值器（纯函数）', () => {
  it('优先级 blocked > overridden > restart-required > live；按 scope 匹配进程种类', () => {
    const live = [{ kind: 'shell' as const, pid: 1 }, { kind: 'host' as const, pid: 2 }];
    expect(effectiveStateOf({ scope: 'shell', liveProcesses: live })).toBe('restart-required');
    expect(effectiveStateOf({ scope: 'webui', liveProcesses: live })).toBe('live');
    expect(effectiveStateOf({ scope: 'shell', liveProcesses: live, overridden: true })).toBe('overridden');
    expect(effectiveStateOf({ scope: 'shell', liveProcesses: live, blocked: true })).toBe('blocked-by-live-process');
  });

  it('needs-reinstall：registry 记录在而物化目录缺席 → true', async () => {
    writePlugin();
    await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    expect(needsReinstallOf(ROOT, 'demo-plugin')).toBe(false);
    fs.rmSync(path.join(ROOT, 'plugins', 'demo-plugin'), { recursive: true, force: true });
    expect(needsReinstallOf(ROOT, 'demo-plugin')).toBe(true);
    expect(needsReinstallOf(ROOT, 'no-such')).toBe(false);
    expect(readRegistry(ROOT).version).toBe(1);
  });
});
