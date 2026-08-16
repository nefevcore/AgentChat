// ============================================================
// @agentchat/plugins 测试：PluginHost（动态加载/替换/卸载）+ 插件库（stage/approve/扫描）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ToolsService } from '@agentchat/tools';
import { HooksService } from '@agentchat/hooks';
import type { AgentConfig } from '@agentchat/agent-config';
import {
  PluginHost,
  approveStaging,
  listInstalled,
  listStaging,
  loadInstalledPlugins,
  stagePlugin,
} from '../src/index';

const FIXTURE_MJS = `
export const name = '__NAME__';
export const inject = ['tools', 'hooks'];
export function apply(ctx) {
  ctx.tools.register('__NAME__', [{
    name: 'plugged_tool',
    label: '插件工具',
    description: 'fixture tool',
    requires: ['base'],
    definition: { type: 'function', function: { name: 'plugged_tool', description: 'fixture tool', parameters: { type: 'object', properties: {} } } },
    execute: async () => '__RESULT__',
  }]);
  ctx.hooks.register('runStart', '__NAME__.hook', () => async () => {}, '__NAME__');
}
`;

function writeFixture(root: string, name: string, version: string, extraManifest: Record<string, unknown> = {}, entrySource?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name, version, entry: 'index.mjs', inject: ['tools', 'hooks'], description: `${name} fixture`,
    ...extraManifest,
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    (entrySource ?? FIXTURE_MJS).replaceAll('__NAME__', name).replaceAll('__RESULT__', 'plugged'), 'utf-8');
  return dir;
}

function makeCtx(): Context {
  const ctx = new Context();
  new ToolsService(ctx);
  new HooksService(ctx);
  return ctx;
}

const enabledConfig = (name: string): AgentConfig => ({
  agent_id: 'a', name: 'A', tags: ['base'], presets: [name],
} as AgentConfig);

/** 轮询等待条件成立（watcher 轮询周期 750ms，超时上限 5s） */
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor 超时');
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PluginHost 动态加载', () => {
  it('load → 工具/钩子注册进 ctx；unload → owner 精确回收', async () => {
    const dir = writeFixture(tmp, 'test-plugin', '1.0.0');
    const ctx = makeCtx();
    const host = new PluginHost(ctx);

    const result = await host.load({
      manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')),
      dir, agentId: 'a', sessionOnly: true,
    });
    expect(result.status).toBe('loaded');
    expect(host.has('test-plugin')).toBe(true);

    expect(ctx.tools.resolveTools(undefined, enabledConfig('test-plugin'), {}).has('plugged_tool')).toBe(true);
    expect(ctx.hooks.collect({ runStart: ['test-plugin.hook'] }, enabledConfig('test-plugin'), {}).runStartHook).toHaveLength(1);

    await host.unload('test-plugin');
    expect(host.has('test-plugin')).toBe(false);
    expect(ctx.tools.resolveTools(undefined, enabledConfig('test-plugin'), {}).has('plugged_tool')).toBe(false);
    const hooksAfter = ctx.hooks.collect({ runStart: ['test-plugin.hook'] }, enabledConfig('test-plugin'), {});
    expect(hooksAfter.runStartHook ?? []).toHaveLength(0);
  });

  it('同名重载：旧 fiber 先 dispose，注册不叠加', async () => {
    const dir = writeFixture(tmp, 'test-plugin', '1.0.0');
    const ctx = makeCtx();
    const host = new PluginHost(ctx);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

    await host.load({ manifest, dir, sessionOnly: true });
    const second = await host.load({ manifest, dir, sessionOnly: true });
    expect(second.status).toBe('replaced');
    // 只有一份注册（resolveTools 同名去重 + unregister 先行）
    const all = ctx.tools.listAll(enabledConfig('test-plugin'), {});
    expect(all.filter((t) => t.name === 'plugged_tool')).toHaveLength(1);
  });

  it('会话级加载不得覆盖已安装插件', async () => {
    const dir = writeFixture(tmp, 'test-plugin', '1.0.0');
    const ctx = makeCtx();
    const host = new PluginHost(ctx);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

    await host.load({ manifest, dir, sessionOnly: false });
    await expect(host.load({ manifest, dir, sessionOnly: true })).rejects.toThrow('会话级加载被拒绝');
  });

  it('inject 依赖缺失：立即报错而不是 PENDING 挂死', async () => {
    const dir = writeFixture(tmp, 'test-plugin', '1.0.0');
    const ctx = makeCtx();
    const host = new PluginHost(ctx);
    const manifest = { ...JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')), inject: ['nope'] };
    await expect(host.load({ manifest, dir, sessionOnly: true })).rejects.toThrow('ctx 服务 "nope" 未提供');
  });

  it('权限边界：未授予的 process/shell 在 import 前拒绝；显式授予后放行', async () => {
    const dir = writeFixture(tmp, 'test-plugin', '1.0.0', { permissions: ['process'] });
    const ctx = makeCtx();
    const host = new PluginHost(ctx);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

    // 默认只授 fs/network → process 未授予，拒绝且不装载
    await expect(host.load({ manifest, dir, sessionOnly: true })).rejects.toThrow('未授予的权限');
    expect(host.has('test-plugin')).toBe(false);

    // 显式授予 process → 放行
    await host.load({ manifest, dir, sessionOnly: true, allowedPermissions: ['fs', 'network', 'process'] });
    expect(host.has('test-plugin')).toBe(true);
    await host.unload('test-plugin');
  });

  it('P5 gate：manifest.ui 未授予 ui 在 import 前拒绝；授予后放行并挂载 ctx.webui', async () => {
    const dir = writeFixture(tmp, 'ui-gate', '1.0.0', {
      permissions: ['ui'],
      ui: { entry: 'ui/dist/index.js' },
    });
    fs.mkdirSync(path.join(dir, 'ui', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'dist', 'index.js'), 'export function install() {}\n', 'utf-8');
    const ctx = makeCtx();
    const host = new PluginHost(ctx);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

    // 默认只授 fs/network → ui 未授予，拒绝且不装载
    await expect(host.load({ manifest, dir, sessionOnly: true })).rejects.toThrow('未授予的权限');
    expect(host.has('ui-gate')).toBe(false);

    // 显式授予 ui → 放行，并创建 ctx.webui 挂载扩展
    await host.load({ manifest, dir, sessionOnly: true, allowedPermissions: ['fs', 'network', 'ui'] });
    expect(host.has('ui-gate')).toBe(true);
    const webui = ctx.get('webui') as { listExtensions(): Array<{ name: string }> } | undefined;
    expect(webui?.listExtensions()).toHaveLength(1);
    await host.unload('ui-gate');
  });

  it('P5 UI 生命周期：unload 先移除 UI 扩展；新版本激活失败回滚后重新挂载旧 UI', async () => {
    const dir = writeFixture(tmp, 'ui-life', '1.0.0', {
      permissions: ['ui'],
      ui: { entry: 'ui/dist/index.js' },
    });
    fs.mkdirSync(path.join(dir, 'ui', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'dist', 'index.js'), 'export function install() {}\n', 'utf-8');
    const ctx = makeCtx();

    const oldModule = {
      name: 'ui-life',
      inject: ['tools', 'hooks'],
      apply(ctx2: any) {
        ctx2.tools.register('ui-life', [{
          name: 'plugged_tool', label: '插件工具', requires: ['base'],
          definition: { type: 'function', function: { name: 'plugged_tool', description: 'fixture', parameters: { type: 'object', properties: {} } } },
          execute: async () => 'plugged',
        }]);
        ctx2.hooks.register('runStart', 'ui-life.hook', () => async () => {}, 'ui-life');
      },
    };
    const badModule = {
      name: 'ui-life',
      inject: ['tools', 'hooks'],
      apply() { throw new Error('新版本激活失败'); },
    };
    let nextModule: unknown = oldModule;
    const host = new PluginHost(ctx, { importModule: async () => nextModule });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

    await host.load({ manifest, dir, sessionOnly: true, allowedPermissions: ['fs', 'network', 'ui'] });
    const webui = ctx.get('webui') as { listExtensions(): Array<{ name: string }> };
    expect(webui.listExtensions()).toHaveLength(1);

    // 新版本激活失败 → 回滚旧版本，并重新挂载旧 UI 扩展
    nextModule = badModule;
    await expect(host.load({ manifest, dir, sessionOnly: true, allowedPermissions: ['fs', 'network', 'ui'] })).rejects.toThrow('已回滚旧版本');
    expect(host.has('ui-life')).toBe(true);
    expect(webui.listExtensions()).toHaveLength(1);

    // 卸载：UI 扩展随之移除
    await host.unload('ui-life');
    expect(webui.listExtensions()).toHaveLength(0);
  });

  it('watch：源码变化后自动重载（hash 轮询）；失败保留旧实例', async () => {
    const dir = writeFixture(tmp, 'test-plugin', '1.0.0');
    const ctx = makeCtx();
    // Vitest 会把“纯时间戳 query”归一到文件路径缓存；注入测试模块上下文的
    // importModule，并把 query 重写为唯一非时间戳值，模拟真实 Node/tsx 的
    // cache-busting（真实运行态 `?t=<timestamp>` 已验证有效）。
    const freshUrl = (url: string) => url.replace(/\?.*$/, '') + `?t=hmr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let importNow: (url: string) => Promise<unknown> = (url) => import(freshUrl(url));
    const host = new PluginHost(ctx, { importModule: (url) => importNow(url) });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

    await host.load({ manifest, dir, sessionOnly: true, watch: true });
    const tool = () => ctx.tools.resolveTools(undefined, enabledConfig('test-plugin'), {}).get('plugged_tool');
    expect(await tool()?.execute?.({}, undefined, undefined)).toBe('plugged');

    // 修改源码 → 轮询检测 → 自动重载
    const source = FIXTURE_MJS.replaceAll('__NAME__', 'test-plugin').replaceAll('__RESULT__', 'plugged-v2');
    fs.writeFileSync(path.join(dir, 'index.mjs'), source, 'utf-8');
    vi.resetModules();
    importNow = (url) => import(freshUrl(url));
    await waitFor(async () => await tool()?.execute?.({}, undefined, undefined) === 'plugged-v2');

    // 改成坏代码 → 自动重载失败，保留旧实例
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const broken = ', 'utf-8');
    vi.resetModules();
    importNow = (url) => import(freshUrl(url));
    await new Promise((r) => setTimeout(r, 1200));
    expect(await tool()?.execute?.({}, undefined, undefined)).toBe('plugged-v2');

    await host.unload('test-plugin');
  });
});

describe('插件库 stage / approve / 扫描', () => {
  it('stage → list → approve → registry 落盘 → 启动扫描可恢复', async () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0');

    const staged = stagePlugin(ws, src, 'admin');
    expect(staged.manifest.name).toBe('my-plugin');
    expect(listStaging(ws)).toHaveLength(1);
    expect(fs.existsSync(path.join(ws, 'plugins', '.staging', staged.id, 'manifest.json'))).toBe(true);

    const approved = approveStaging(ws, staged.id);
    expect(approved.name).toBe('my-plugin');
    expect(listStaging(ws)).toHaveLength(0);
    expect(listInstalled(ws)).toHaveLength(1);
    expect(fs.existsSync(path.join(ws, 'plugins', 'my-plugin', 'index.mjs'))).toBe(true);

    // 启动扫描：新进程语义（全新 ctx）从 registry 恢复插件
    const ctx = makeCtx();
    const results = await loadInstalledPlugins(ctx, ws);
    expect(results).toHaveLength(1);
    expect(ctx.tools.resolveTools(undefined, enabledConfig('my-plugin'), {}).has('plugged_tool')).toBe(true);
    expect(ctx.hooks.collect({ runStart: ['my-plugin.hook'] }, enabledConfig('my-plugin'), {}).runStartHook).toHaveLength(1);
  });

  it('同版本拒绝重复发布；新版本替换并备份旧版', () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0');
    const id1 = stagePlugin(ws, src, 'admin').id;
    approveStaging(ws, id1);

    const id2 = stagePlugin(ws, src, 'admin').id;
    expect(() => approveStaging(ws, id2)).toThrow('同版本拒绝');

    const srcV2 = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '2.0.0');
    const id3 = stagePlugin(ws, srcV2, 'admin').id;
    const approved = approveStaging(ws, id3);
    expect(approved.replaced?.oldVersion).toBe('1.0.0');
    expect(listInstalled(ws)[0].manifest.version).toBe('2.0.0');
    const backups = fs.readdirSync(path.join(ws, 'plugins', '.backup'));
    expect(backups.some((b) => b.startsWith('my-plugin-1.0.0-'))).toBe(true);
  });

  it('权限边界：process 权限未授予拒绝安装；授予后写入快照并可按快照恢复', async () => {
    const ws = path.join(tmp, 'ws');
    const src = writeFixture(path.join(tmp, 'dev'), 'my-plugin', '1.0.0', { permissions: ['process'] });
    const id = stagePlugin(ws, src, 'admin').id;

    // 未显式授予 process → 拒绝安装
    expect(() => approveStaging(ws, id)).toThrow('未授予的权限');
    expect(listInstalled(ws)).toHaveLength(0);

    // 显式授予 → 安装成功，registry 记录授予快照
    const approved = approveStaging(ws, id, ['process']);
    expect(approved.permissions).toContain('process');
    expect(listInstalled(ws)[0].permissions).toContain('process');

    // 启动扫描按授予快照恢复（不再需要人工 grants）
    const ctx = makeCtx();
    const results = await loadInstalledPlugins(ctx, ws);
    expect(results).toHaveLength(1);
    expect(ctx.tools.resolveTools(undefined, enabledConfig('my-plugin'), {}).has('plugged_tool')).toBe(true);
  });
});
