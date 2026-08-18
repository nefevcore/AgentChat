// ============================================================
// @agentchat/plugins 测试：market/market.ts —— 发现/缓存/stage/install 全链路
// 全程 mock 源（不触网）；tarball 为内存 fixture。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { HOST_CONTRACTS_VERSION } from '@agentchat/agent-config';
import { MarketService } from '../src/market/market';
import { listInstalled, listStaging, readRegistry } from '../src/registry';
import { PluginHost } from '../src/host';
import { buildPluginTarGz, MockSource } from './market-helpers';

let tmpRoot: string;
let workspaceDir: string;
let ctx: Context;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-market-test-'));
  workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  ctx = new Context();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeService(source: MockSource): MarketService {
  return new MarketService(ctx, { workspaceDir, sources: [source] });
}

const MANIFEST_OK = { name: 'agentchat-hello', version: '1.0.0', inject: [] };
const COMMIT = 'a'.repeat(40);

function arrangeHello(source: MockSource, manifestOverrides: Record<string, unknown> = {}) {
  const manifest = { ...MANIFEST_OK, ...manifestOverrides };
  source.resolved.push({
    entry: {
      name: manifest.name,
      repo: 'acme/hello',
      ref: 'v1.0.0',
      manifest: manifest as any,
      description: 'fixture',
      channel: 'github',
    },
    commit: COMMIT,
    tarball: 'https://api.github.com/repos/acme/hello/tarball/' + COMMIT,
  });
  source.tarballs.push(buildPluginTarGz(manifest));
}

describe('MarketService.search', () => {
  it('聚合源结果并写缓存', async () => {
    const source = new MockSource();
    source.searchResult = [{ name: 'acme/hello', repo: 'acme/hello', channel: 'github', stars: 5 }];
    const market = makeService(source);
    const result = await market.search();
    expect(result.stale).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(fs.existsSync(path.join(workspaceDir, 'plugins/.market/index.json'))).toBe(true);
  });

  it('全部源失败 → 降级本地缓存（stale）', async () => {
    const source = new MockSource();
    source.searchResult = [{ name: 'acme/hello', repo: 'acme/hello', channel: 'github' }];
    await makeService(source).search(); // 先落缓存

    const source2 = new MockSource();
    source2.searchError = new Error('rate limited');
    const market2 = new MarketService(new Context(), { workspaceDir, sources: [source2] });
    const result = await market2.search();
    expect(result.stale).toBe(true);
    expect(result.entries.map((e) => e.repo)).toContain('acme/hello');
    expect(result.error).toContain('rate limited');
  });
});

describe('MarketService.stage / install', () => {
  it('stage：走 staging 管，来源钉定 commit', async () => {
    const source = new MockSource();
    arrangeHello(source);
    const market = makeService(source);

    const record = await market.stage('acme/hello');
    expect(record.source).toMatchObject({
      kind: 'market', repo: 'acme/hello', ref: 'v1.0.0', commit: COMMIT, channel: 'github',
    });
    expect(record.manifest.name).toBe('agentchat-hello');
    expect(record.requiredGrants).toEqual([]); // 无高危权限
    // 已进入待审队列（人审/授权走既有流程）
    expect(listStaging(workspaceDir).map((s) => s.id)).toContain(record.id);
    // 下载的是钉定 commit 的 tarball
    expect(source.downloadedUrls[0]).toContain(COMMIT);
  });

  it('install：默认权限直接装上，registry 记录带 source', async () => {
    const source = new MockSource();
    arrangeHello(source);
    const market = makeService(source);

    const result = await market.install('acme/hello');
    expect(result.name).toBe('agentchat-hello');
    expect(fs.existsSync(path.join(workspaceDir, 'plugins/agentchat-hello/manifest.json'))).toBe(true);

    const installed = listInstalled(workspaceDir);
    expect(installed).toHaveLength(1);
    expect(installed[0].source).toMatchObject({ kind: 'market', commit: COMMIT });
    // staging 已清空
    expect(listStaging(workspaceDir)).toHaveLength(0);
  });

  it('高危权限未 grants → install 拒绝（CLI 不得成为权限后门）', async () => {
    const source = new MockSource();
    arrangeHello(source, { permissions: ['shell'] });
    const market = makeService(source);

    await expect(market.install('acme/hello')).rejects.toThrow(/未授予的权限.*shell/);
    // stage 成功留在待审（人审路径仍可用）
    expect(listStaging(workspaceDir)).toHaveLength(1);
  });

  it('高危权限显式 grants → 装上', async () => {
    const source = new MockSource();
    arrangeHello(source, { permissions: ['shell'] });
    const market = makeService(source);

    const result = await market.install('acme/hello', ['shell']);
    expect(result.permissions).toContain('shell');
  });

  it('契约不兼容 → stage 阶段拒绝（不进入人审队列）', async () => {
    const source = new MockSource();
    arrangeHello(source, { contracts: '^99' });
    const market = makeService(source);

    await expect(market.stage('acme/hello')).rejects.toThrow(RegExp(`contracts "\\^99".*${HOST_CONTRACTS_VERSION}`));
    expect(listStaging(workspaceDir)).toHaveLength(0);
  });

  it('tarball 内 manifest 与 commit 处不一致 → 拒绝', async () => {
    const source = new MockSource();
    arrangeHello(source); // resolve 报 v1.0.0
    source.tarballs.length = 0;
    source.tarballs.push(buildPluginTarGz({ name: 'agentchat-hello', version: '2.0.0' })); // 包内是 2.0.0
    const market = makeService(source);

    await expect(market.stage('acme/hello')).rejects.toThrow(/不一致/);
  });

  it('按名安装：stage 后缓存带真名，name 形式可用', async () => {
    const source = new MockSource();
    arrangeHello(source);
    const market = makeService(source);
    await market.stage('acme/hello');
    source.tarballs.push(buildPluginTarGz({ ...MANIFEST_OK })); // install 会再走一次下载

    const record = await market.install('agentchat-hello');
    expect(record.name).toBe('agentchat-hello');
  });

  it('未知名且无缓存 → 明确报错', async () => {
    const market = makeService(new MockSource());
    await expect(market.stage('agentchat-nobody')).rejects.toThrow(/找不到/);
  });
});

describe('PluginHost 契约门禁（装载期 fail closed）', () => {
  it('contracts 声明不兼容 → import 前拒绝', async () => {
    const pluginDir = path.join(tmpRoot, 'incompat');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      name: 'agentchat-old', version: '1.0.0', entry: 'index.mjs', contracts: '^0',
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.mjs'), 'export function apply() { throw new Error("不应被 import"); }');

    const host = new PluginHost(ctx);
    await expect(host.load({
      manifest: JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')),
      dir: pluginDir,
      sessionOnly: false,
    })).rejects.toThrow(/不兼容/);
  });

  it('contracts 兼容（^1）或缺省 → 正常装载', async () => {
    const pluginDir = path.join(tmpRoot, 'compat');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      name: 'agentchat-fine', version: '1.0.0', entry: 'index.mjs', contracts: `^${HOST_CONTRACTS_VERSION.split('.')[0]}`,
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.mjs'), 'export const name = "agentchat-fine"; export function apply() {}');

    const host = new PluginHost(ctx);
    const result = await host.load({
      manifest: JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')),
      dir: pluginDir,
      sessionOnly: false,
    });
    expect(result.name).toBe('agentchat-fine');
  });
});

describe('registry 兼容性', () => {
  it('本地 stage（无 source）→ 安装记录无 source 字段（旧路径不受影响）', async () => {
    const devDir = path.join(tmpRoot, 'dev-plugin');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'manifest.json'), JSON.stringify(MANIFEST_OK));
    fs.writeFileSync(path.join(devDir, 'index.mjs'), 'export function apply() {}');

    const { stagePlugin, approveStaging } = await import('../src/registry');
    const record = stagePlugin(workspaceDir, devDir, 'tester');
    expect(record.source).toBeUndefined();
    approveStaging(workspaceDir, record.id);
    const doc = readRegistry(workspaceDir);
    expect(doc.plugins['agentchat-hello'].source).toBeUndefined();
  });
});
