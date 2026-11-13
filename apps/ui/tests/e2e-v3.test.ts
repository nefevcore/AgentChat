// @vitest-environment jsdom
// ============================================================
// e2e-v3.test.ts —— webui-v3 切片①②验收（cr-929/930）
//
// ① todo 一件通：声明 → 装载（真包 link: → loader entry）→ wire（真
//   HTTP）→ 物化（真 factory bundle fetch+eval → 种子词解析宿主实例）→
//   席位渲染（ctx.plugin → slots 贡献）。真 ac-client-ui-todo 包 + 真
//   build-channel v3 产物——全链无 mock（rpc wire 拒绝桩除外）。
// ② 全量通（切片②）：真基座文档（apps/catalog/profile 30 行）→ 浏览器
//   侧两段装载（ensure 到达 → 按序物化）+ 深路径跨行解析（__deep 面）。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { makeWebuiRowV3, type WebuiRowV3Handle } from '../src/webui-row-v3.ts';
import { bootUiClientV3 } from '../client/boot-v3.ts';

function findRepoRoot(): string {
  // jsdom 下 import.meta.url 为 http: 形、cwd 被全局 setup 重定向数据根——
  // 从 cwd 上溯找 pnpm-workspace.yaml（数据根恒在仓库内）
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir + '/';
    const parent = dirname(dir);
    if (parent === dir) throw new Error('仓库根未定位');
    dir = parent;
  }
}
const repoRoot = findRepoRoot();

/** 起一个 webui v3 宿主（webServer + 行 v3），返回端口与句柄 */
async function bootHost(profileDir: string, baseUrl: string, shellSeeds?: Record<string, string>): Promise<{ svc: WebServerService; ctx: Context; port: number; handle: WebuiRowV3Handle }> {
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 } as never);
  const port = await svc.ready();
  const handle: WebuiRowV3Handle = {};
  ctx.plugin(makeWebuiRowV3({ baseUrl, profileDir, ...(shellSeeds !== undefined ? { shellSeeds } : {}), handle }));
  for (let i = 0; i < 200 && handle.loader === undefined; i++) {
    await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  }
  await handle.loader!.await();
  await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  return { svc, ctx, port, handle };
}

const hosts: WebServerService[] = [];
let root = '';
let port = 0;

beforeAll(async () => {
  // 产物就位（真构建器——本测自足，不依赖仓库预构建态）
  const build = spawnSync(process.execPath, [join(repoRoot, 'apps/ui/scripts/build-channel.mjs')],
    { cwd: repoRoot, encoding: 'utf8' });
  if (build.status !== 0) throw new Error('build-channel 失败：' + build.stderr);

  root = await mkdtemp(join(tmpdir(), 'ac-e2e-v3-'));
  await mkdir(join(root, 'profile'), { recursive: true });
  await writeFile(join(root, 'profile', 'webui.yml'),
    '- id: todo\n  name: link:packages/ac-client-ui-todo\n');

  const h = await bootHost(join(root, 'profile'), pathToFileURL(repoRoot).href + '/',
    { vue: '^3.5', 'ac-client-runtime': '^0.1', '@agentchat/webui-kit': '^0.1' });
  hosts.push(h.svc as WebServerService);
  port = h.port;
}, 300_000);

afterAll(async () => {
  for (const svc of hosts.splice(0)) await svc.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const http = (p: string) => `http://127.0.0.1:${port}${p}`;

describe('webui-v3 切片① · todo 一件通', () => {
  it('声明 → 装载 → wire → 物化 → 席位渲染', async () => {
    setActivePinia(createPinia());

    const wireRes = await fetch(http('/api/ui/wire'));
    expect(wireRes.status).toBe(200);
    const wire = await wireRes.json() as { rows: { id: string; entry: string }[] };
    const todoRow = wire.rows.find((r) => r.id === 'ac-client-ui-todo');
    expect(todoRow).toBeDefined();
    expect(todoRow!.entry).toMatch(/^\/ui-asset\/ac-client-ui-todo\/[0-9a-f]+\/index\.js$/);

    const result = await bootUiClientV3({
      fetchWire: async () => (await (await fetch(http('/api/ui/wire'))).json()) as never,
      loadScript: async (url) => {
        const res = await fetch(http(url));
        if (!res.ok) throw new Error('bundle ' + res.status + ' ' + url);
        (0, eval)(await res.text());
      },
    });
    expect(result.channel.get('ac-client-ui-todo')).toBe('ok');

    const mod = await result.modules.import('ac-client-ui-todo') as { default?: { name?: string } };
    expect(mod.default?.name).toBe('ac-client-ui-todo.client');

    // 席位两态其一：已声明席位落位贡献；未声明席位挂 pending inject
    const snap = result.ctx.slots.snapshot();
    const landed = Object.entries(snap.slots).some(([key, entries]) =>
      key === 'tool-card:result-view' && (entries as { id: string }[]).some((e) => e.id === 'todo'));
    const pendingKeys = [...(result.ctx.slots.pendingInjects() as Map<string, unknown>).keys()];
    expect(landed || pendingKeys.includes('conversation:dock-widget')).toBe(true);
  }, 60_000);
});

describe('webui-v3 切片② · 全量通（真基座文档 30 行）', () => {
  it('浏览器侧 30 行物化（两段装载 + 深路径跨行解析）', async () => {
    const h2 = await bootHost(repoRoot + 'apps/catalog/profile', pathToFileURL(repoRoot).href);
    hosts.push(h2.svc as WebServerService);
    const base = 'http://127.0.0.1:' + h2.port;
    setActivePinia(createPinia());

    const wire = await (await fetch(base + '/api/ui/wire')).json() as { rows: { id: string; isolated: boolean; entry?: string }[] };
    const loadable = wire.rows.filter((r) => !r.isolated && r.entry !== undefined).length;
    expect(loadable).toBe(30); // 全量通前置：宿主侧 30 行全进 wire

    const result = await bootUiClientV3({
      fetchWire: async () => (await (await fetch(base + '/api/ui/wire')).json()) as never,
      loadScript: async (url) => {
        const res = await fetch(base + url);
        if (!res.ok) throw new Error('bundle ' + res.status + ' ' + url);
        (0, eval)(await res.text());
      },
    });
    const ok = [...result.channel.values()].filter((v) => v === 'ok').length;
    const errs = [...result.channel.entries()].filter(([, v]) => v === 'err');
    if (errs.length > 0) console.error('[e2e-v3 全量] err 行：', errs.map(([id]) => id).join(','));
    expect(ok).toBe(loadable);

    // 等值验收（cr-930：SHA-256 清单对账——服务字节 = 构建期清单哈希）。
    // 采样面 = entry 行（cr-936 起 wire 含纯样式 theme 行——无 entry 不在物化面）
    for (const row of wire.rows.filter((row2) => row2.entry !== undefined).slice(0, 3)) {
      const entryUrl = new URL(row.entry!, base);
      const manifestUrl = entryUrl.pathname.replace(/index\.js$/, 'manifest.json');
      const manifestRes = await fetch(base + manifestUrl);
      expect(manifestRes.status).toBe(200);
      const manifest = await manifestRes.json() as { files: Record<string, { hash: string }> };
      const res = await fetch(base + row.entry!);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(createHash('sha256').update(buf).digest('hex').slice(0, 16)).toBe(manifest.files['index.js']!.hash);
    }
  }, 240_000);
});
