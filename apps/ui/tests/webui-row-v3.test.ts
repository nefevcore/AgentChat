// ============================================================
// webui-row-v3.test.ts —— webui v3 行端到端（cr-928 切片①；HTTP 面穿透）
//
// 声明 → 装载（分层文档 → loader entry）→ wire（GET /api/ui/wire）→
// 资产（/ui-asset/:id/:rev/*：revision 匹配 + 文件白名单 + MIME 门）。
// WS 帧推送面（webServer.broadcast）由 ac-web-server / ac-ws-bridge 测试
// 锁定，此处不重复；浏览器物化面归壳 v3 测试（切片①后续增量）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { makeWebuiRowV3 } from '../src/webui-row-v3.ts';

const roots: string[] = [];
const servers: WebServerService[] = [];

async function makeRoot(): Promise<{ root: string; url: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ac-webui-v3-'));
  roots.push(root);
  return { root, url: 'http://127.0.0.1:' + await bootPort(root) };
}

let lastPort = 0;
async function bootPort(root: string): Promise<number> {
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 } as never);
  servers.push(svc);
  const port = await svc.ready();
  ctx.plugin(makeWebuiRowV3({
    baseUrl: pathToFileURL(root).href + '/',
    profileDir: join(root, 'profile'),
    shellSeeds: { vue: '^3.5' },
  }));
  await settle(ctx);
  lastPort = port;
  return port;
}

/** fiber 排空 + 微任务泵（装载异步趟 + 打脏 flush） */
async function settle(handle: { loader?: unknown }): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  const loader = handle.loader as { await(): Promise<void> } | undefined;
  if (loader) await loader.await();
  await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
}

interface PkgSpec {
  name: string;
  web?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  distFiles?: Record<string, string>;
}

/** 夹具包：package.json(ac.faces.web) + node 半 src/index.ts + client/dist 产物 */
async function writePkg(root: string, spec: PkgSpec): Promise<void> {
  const pkgDir = join(root, 'packages', spec.name);
  await mkdir(join(pkgDir, 'src'), { recursive: true });
  await mkdir(join(pkgDir, 'client', 'dist'), { recursive: true });
  const pkg: Record<string, unknown> = {
    name: spec.name,
    version: '1.0.0',
    ...(spec.web !== null ? { ac: { faces: { web: spec.web ?? {} } } } : {}),
  };
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(pkgDir, 'src', 'index.ts'), `export default { name: '${spec.name}', apply() {} };\n`);
  const dist = join(pkgDir, 'client', 'dist');
  for (const [name, body] of Object.entries(spec.distFiles ?? { 'index.js': 'window.__ModuleLoader__ && window.__ModuleLoader__.load({ id: ' + JSON.stringify(spec.name) + ', factory() { return {}; } });\n' })) {
    await writeFile(join(dist, name), body);
  }
  if (spec.manifest !== null) {
    await writeFile(join(dist, 'manifest.json'), JSON.stringify(spec.manifest ?? {
      rev: 'r1',
      builtAt: 1,
      entry: 'index.js',
      files: { 'index.js': { hash: 'h', size: 1 } },
    }));
  }
}

async function writeProfile(root: string, rows: { id: string; name: string }[]): Promise<void> {
  await mkdir(join(root, 'profile'), { recursive: true });
  const doc = ['# 测试基座', ...rows.map((r) => `- id: ${r.id}\n  name: ${r.name}\n`)].join('\n');
  await writeFile(join(root, 'profile', 'webui.patch.yml'), doc);
}

afterEach(async () => {
  for (const svc of servers.splice(0)) await svc.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('webui v3 行（wire + 资产面）', () => {
  it('声明 → 装载 → wire → 资产：todo 一件通（HTTP 面）', async () => {
    const rootHolder = { root: '' };
    const root = await mkdtemp(join(tmpdir(), 'ac-webui-v3-'));
    roots.push(root);
    rootHolder.root = root;
    await writeProfile(root, [{ id: 'todo', name: 'link:packages/plug-todo' }]);
    await writePkg(root, {
      name: 'plug-todo',
      web: { entry: './client/dist/index.js', seats: ['conversation:dock-widget'], isolated: false },
    });
    const ctx = new Context();
    const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 } as never);
    servers.push(svc);
    const port = await svc.ready();
    const handle: import('../src/webui-row-v3.ts').WebuiRowV3Handle = {};
    ctx.plugin(makeWebuiRowV3({
      baseUrl: pathToFileURL(root).href + '/',
      profileDir: join(root, 'profile'),
      shellSeeds: { vue: '^3.5' },
      handle,
    }));
    await settle(handle);

    const wireRes = await fetch(`http://127.0.0.1:${port}/api/ui/wire`);
    expect(wireRes.status).toBe(200);
    const wire = await wireRes.json() as { rows: { id: string; entry: string; seats: string[] }[]; seeds: Record<string, string> };
    expect(wire.rows).toHaveLength(1);
    expect(wire.rows[0]).toMatchObject({ id: 'plug-todo', entry: '/ui-asset/plug-todo/r1/index.js', seats: ['conversation:dock-widget'] });
    expect(wire.seeds).toEqual({ vue: '^3.5' });

    const assetRes = await fetch(`http://127.0.0.1:${port}${wire.rows[0]!.entry}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get('cache-control')).toContain('immutable');
    expect(await assetRes.text()).toContain('window.__ModuleLoader__');

    // rev 失配（重建后旧 URL）→ 404；文件白名单外 → 404
    expect((await fetch(`http://127.0.0.1:${port}/ui-asset/plug-todo/r0/index.js`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/ui-asset/plug-todo/r1/secret.txt`)).status).toBe(404);
  });

  it('点名缺席（文档点名而包不可解析）→ wire 空 + 不拒启；停用行不装载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-webui-v3-'));
    roots.push(root);
    await writeProfile(root, [
      { id: 'ghost', name: 'link:packages/ghost-pkg' },
      { id: 'off', name: 'link:packages/plug-off' },
    ]);
    await writeFile(join(root, 'profile', 'webui-custom.patch.yml'), '- id: off\n  disabled: true\n');
    await writePkg(root, { name: 'plug-off', web: { entry: './client/dist/index.js', seats: [] } });
    const ctx = new Context();
    const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 } as never);
    servers.push(svc);
    const port = await svc.ready();
    const handle: import('../src/webui-row-v3.ts').WebuiRowV3Handle = {};
    ctx.plugin(makeWebuiRowV3({ baseUrl: pathToFileURL(root).href + '/', profileDir: join(root, 'profile'), handle }));
    await settle(handle);

    const wire = await (await fetch(`http://127.0.0.1:${port}/api/ui/wire`)).json() as { rows: unknown[] };
    expect(wire.rows).toEqual([]); // ghost 解析失败跳过；off 停用不装载
  });
});
