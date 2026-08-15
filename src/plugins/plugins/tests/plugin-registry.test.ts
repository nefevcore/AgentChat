// ============================================================
// @agentchat/plugins P1 测试：插件库 reject/uninstall/staging 人审 +
// ctx.pluginHost 服务复用 + manifest.provides / ui 权限词汇
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ToolsService } from '@agentchat/tools';
import { HooksService } from '@agentchat/hooks';
import { validatePluginManifest } from '@agentchat/agent-config';
import {
  approveStaging,
  getOrCreatePluginHost,
  hashPluginDir,
  listInstalled,
  listStaging,
  listStagingFiles,
  loadInstalledPlugins,
  missingPermissions,
  readStagingFile,
  rejectStaging,
  requiredGrants,
  stagePlugin,
  uninstallPlugin,
} from '../src/index';

function writeFixture(root: string, name: string, version: string, extraManifest: Record<string, unknown> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name, version, entry: 'index.mjs',
    ...extraManifest,
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    `export const name = '${name}';\nexport function apply() {}\n`, 'utf-8');
  return dir;
}

function makeCtx(): Context {
  const ctx = new Context();
  new ToolsService(ctx);
  new HooksService(ctx);
  return ctx;
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-p1-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('manifest 契约扩展（P1）', () => {
  it('provides 校验与规范化；非法声明报错', () => {
    const ok = validatePluginManifest({
      name: 'demo', version: '1.0.0',
      provides: { tools: ['a', 'a'], hooks: ['b'] },
      permissions: ['ui'],
    });
    expect(ok.ok).toBe(true);
    expect(ok.manifest?.provides).toEqual({ tools: ['a'], hooks: ['b'] });

    const bad = validatePluginManifest({
      name: 'demo', version: '1.0.0',
      provides: { tools: 'a' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('；')).toContain('provides.tools');
  });

  it('ui 进入词汇表；无 manifest.ui 时执行期仍只强制 process/shell', () => {
    const manifest = validatePluginManifest({
      name: 'demo', version: '1.0.0',
      permissions: ['process', 'ui'],
    }).manifest!;
    expect(requiredGrants(manifest)).toEqual(['process', 'ui']);
    // 无 manifest.ui：ui 未授予不会在 import 前拒绝；process 会
    expect(missingPermissions(manifest, ['fs', 'network', 'ui'])).toEqual(['process']);
  });

  it('P5 gate：manifest.ui 存在时，ui 未授予与 process/shell 同级强制', () => {
    const manifest = validatePluginManifest({
      name: 'demo', version: '1.0.0',
      permissions: ['process', 'ui'],
      ui: { entry: 'ui/dist/index.js' },
    }).manifest!;
    expect(missingPermissions(manifest, ['fs', 'network'])).toEqual(['process', 'ui']);
    expect(missingPermissions(manifest, ['fs', 'network', 'process'])).toEqual(['ui']);
    expect(missingPermissions(manifest, ['fs', 'network', 'process', 'ui'])).toEqual([]);
  });
});

describe('插件库 reject / uninstall / staging 人审', () => {
  it('reject：删除暂存目录与记录', () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0');
    const staged = stagePlugin(ws, src, 'admin');
    expect(listStaging(ws)).toHaveLength(1);

    const result = rejectStaging(ws, staged.id);
    expect(result.id).toBe(staged.id);
    expect(listStaging(ws)).toHaveLength(0);
    expect(fs.existsSync(path.join(ws, 'plugins', '.staging', staged.id))).toBe(false);
  });

  it('uninstall：registry 移除 + 目录移 .backup；未安装报错', () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0');
    const id = stagePlugin(ws, src, 'admin').id;
    approveStaging(ws, id);

    const result = uninstallPlugin(ws, 'my-plugin');
    expect(result.backupDir).toBeTruthy();
    expect(fs.existsSync(result.backupDir!)).toBe(true);
    expect(fs.existsSync(path.join(ws, 'plugins', 'my-plugin'))).toBe(false);
    expect(listInstalled(ws)).toHaveLength(0);
    expect(() => uninstallPlugin(ws, 'my-plugin')).toThrow('未安装');
    expect(() => uninstallPlugin(ws, '../escape')).toThrow('插件名非法');
  });

  it('staging tree/file：只读列表 + 路径守卫（../ 与绝对路径拒绝）', () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0');
    fs.writeFileSync(path.join(src, 'notes.txt'), 'hello review', 'utf-8');
    const staged = stagePlugin(ws, src, 'admin');

    const files = listStagingFiles(ws, staged.id);
    expect(files.map((f) => f.path).sort()).toEqual(['index.mjs', 'manifest.json', 'notes.txt']);
    expect(files.find((f) => f.path === 'notes.txt')?.size).toBeGreaterThan(0);

    const content = readStagingFile(ws, staged.id, 'notes.txt');
    expect(content.content).toBe('hello review');
    expect(() => readStagingFile(ws, staged.id, '../registry.json')).toThrow(/非法|逃逸/);
    expect(() => readStagingFile(ws, staged.id, path.join(os.tmpdir(), 'x'))).toThrow(/非法|逃逸/);
  });

  it('stage 记录 requiredGrants（process/shell/ui）供 approve 弹窗强制勾选', () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0', { permissions: ['process', 'shell', 'ui'] });
    const staged = stagePlugin(ws, src, 'admin');
    expect(staged.requiredGrants).toEqual(['process', 'shell', 'ui']);
  });
});

describe('stage 的 UI 构建（P5）', () => {
  function writeUiPlugin(root: string, name: string, version: string, uiManifest: Record<string, unknown>, files: Record<string, string>): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name, version, entry: 'index.mjs', permissions: ['ui'], ui: uiManifest,
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'index.mjs'), `export const name = '${name}';\nexport function apply() {}\n`, 'utf-8');
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf-8');
    }
    return dir;
  }

  it('stage 时用 esbuild 把 ui/index.ts 构建为 ui/dist/index.js；hash 覆盖构建产物', () => {
    const ws = path.join(tmp, 'ws-ui-build');
    const src = writeUiPlugin(path.join(tmp, 'dev'), 'ui-built', '1.0.0', { entry: 'ui/dist/index.js' }, {
      'ui/index.ts': 'export function install() { return () => {}; }\n',
    });

    const staged = stagePlugin(ws, src, 'admin');
    const built = path.join(staged.stagedDir, 'ui', 'dist', 'index.js');
    expect(fs.existsSync(built)).toBe(true);
    expect(fs.readFileSync(built, 'utf-8')).toContain('install');
    // 记录哈希 = 构建后目录哈希（源码 + ui/dist 都参与）
    expect(staged.hash).toBe(hashPluginDir(staged.stagedDir));
    expect(listStagingFiles(ws, staged.id).map((f) => f.path)).toContain('ui/dist/index.js');
    // 构建产物进入人审只读文件读取
    expect(readStagingFile(ws, staged.id, 'ui/dist/index.js').content).toContain('install');
  });

  it('已有预构建 ui.entry 时跳过构建，直接采用', () => {
    const ws = path.join(tmp, 'ws-ui-prebuilt');
    const src = writeUiPlugin(path.join(tmp, 'dev'), 'ui-prebuilt', '1.0.0', { entry: 'ui/dist/custom.js' }, {
      'ui/dist/custom.js': 'export function install() { /* prebuilt */ }\n',
    });

    const staged = stagePlugin(ws, src, 'admin');
    const built = path.join(staged.stagedDir, 'ui', 'dist', 'custom.js');
    expect(fs.readFileSync(built, 'utf-8')).toContain('prebuilt');
    expect(staged.manifest.ui?.entry).toBe('ui/dist/custom.js');
  });

  it('既无预构建 entry 也无 ui/index.ts → stage 失败', () => {
    const ws = path.join(tmp, 'ws-ui-missing');
    const src = writeUiPlugin(path.join(tmp, 'dev'), 'ui-missing', '1.0.0', { entry: 'ui/dist/index.js' }, {});
    expect(() => stagePlugin(ws, src, 'admin')).toThrow(/既无预构建入口.*也无源码/);
  });

  it('ui/index.ts 语法错误 → 构建失败拒绝 stage', () => {
    const ws = path.join(tmp, 'ws-ui-bad-build');
    const src = writeUiPlugin(path.join(tmp, 'dev'), 'ui-bad-build', '1.0.0', { entry: 'ui/dist/index.js' }, {
      'ui/index.ts': 'export function broken( {',
    });
    expect(() => stagePlugin(ws, src, 'admin')).toThrow(/UI 构建失败/);
  });
});

describe('ctx.pluginHost 服务化', () => {
  it('getOrCreate 幂等；启动扫描复用已注册实例', async () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0');
    const id = stagePlugin(ws, src, 'admin').id;
    approveStaging(ws, id);

    const ctx = makeCtx();
    const host = getOrCreatePluginHost(ctx);
    expect(getOrCreatePluginHost(ctx)).toBe(host);

    const results = await loadInstalledPlugins(ctx, ws);
    expect(results).toHaveLength(1);
    expect(host.list().some((r) => r.name === 'my-plugin')).toBe(true);
    // 扫描必须复用同一实例（不新建第二个 PluginHost 去注册服务）
    expect(getOrCreatePluginHost(ctx)).toBe(host);
  });
});
