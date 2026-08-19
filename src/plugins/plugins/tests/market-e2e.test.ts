// ============================================================
// @agentchat/plugins 测试：market 冒烟插件端到端（内联夹具）
// 链路：真 manifest+entry 打 tarball → MockSource → install（宿主内
// 热加载）→ apply 打印标记 → 热卸载 → effect 清理打印标记。
// 夹具（原 examples/agentchat-plugin-market-test）见 market-e2e-fixture.ts。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@agentchat/cordis';
import { MarketService } from '../src/market/market';
import { getOrCreatePluginHost } from '../src/host';
import { listInstalled } from '../src/registry';
import { buildTarGz, MockSource } from './market-helpers';
import { SMOKE_MANIFEST, smokeTarEntries } from './market-e2e-fixture';
const REPO = 'acme/agentchat-plugin-market-test';
const COMMIT = 'f'.repeat(40);

let tmpRoot: string;
let workspaceDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-market-e2e-'));
  workspaceDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** GitHub 形态 tarball（内联夹具：manifest + index.mjs + README） */
function buildRealTarball(): Buffer {
  return buildTarGz(smokeTarEntries());
}

describe('market 冒烟插件端到端（agentchat-plugin-market-test 内联夹具）', () => {
  it('install 热加载打印激活标记；卸载热卸载打印清理标记', async () => {
    const manifest = SMOKE_MANIFEST;
    const source = new MockSource();
    source.resolved.push({
      entry: { name: manifest.name, repo: REPO, ref: 'main', manifest, channel: 'github' },
      commit: COMMIT,
      tarball: `https://api.github.com/repos/${REPO}/tarball/${COMMIT}`,
    });
    source.tarballs.push(buildRealTarball());

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    // 宿主内安装：install 检测 ctx.pluginHost → 热加载（apply 立即运行）
    const ctx = new Context();
    const host = getOrCreatePluginHost(ctx);
    const market = new MarketService(ctx, { workspaceDir, sources: [source] });

    const approved = await market.install(REPO);
    expect(approved.name).toBe('agentchat-plugin-market-test');
    expect(listInstalled(workspaceDir)[0]?.source).toMatchObject({ kind: 'market', commit: COMMIT });

    // 激活标记（apply 已运行 = 装载链路 OK；无高危权限无需 grants）
    expect(logs.some((line) => line.includes('[market-test] ✓ 已激活'))).toBe(true);
    expect(host.has('agentchat-plugin-market-test')).toBe(true);

    // 热卸载：effect 清理函数运行（与 library uninstall 同路径）
    await host.unload('agentchat-plugin-market-test');
    expect(logs.some((line) => line.includes('[market-test] ✕ 已卸载'))).toBe(true);
    expect(host.has('agentchat-plugin-market-test')).toBe(false);
  });

  it('重启扫描装载同一路径（loadInstalledPlugins 也打印激活标记）', async () => {
    const manifest = SMOKE_MANIFEST;
    const source = new MockSource();
    source.resolved.push({
      entry: { name: manifest.name, repo: REPO, ref: 'main', manifest, channel: 'github' },
      commit: COMMIT,
      tarball: `https://api.github.com/repos/${REPO}/tarball/${COMMIT}`,
    });
    source.tarballs.push(buildRealTarball());

    // CLI 形态：无 pluginHost 的 ctx 安装（只落盘，不装载）
    const cliCtx = new Context();
    const market = new MarketService(cliCtx, { workspaceDir, sources: [source] });
    await market.install(REPO);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    // 宿主重启扫描：loadInstalledPlugins 装载 → 打印激活标记
    const hostCtx = new Context();
    const { loadInstalledPlugins } = await import('../src/registry');
    const results = await loadInstalledPlugins(hostCtx, workspaceDir);
    expect(results.map((r) => r.name)).toContain('agentchat-plugin-market-test');
    expect(logs.some((line) => line.includes('[market-test] ✓ 已激活'))).toBe(true);
  });
});
