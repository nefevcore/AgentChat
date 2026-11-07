// @vitest-environment jsdom
// ============================================================
// e2e-v3.test.ts —— webui-v3 切片①验收：todo 一件通（cr-929）
//
// 声明 → 装载（真包 link: → loader entry）→ wire（GET /api/ui/wire）→
// 物化（ClientModuleSystem：真 factory bundle fetch+eval → require 链 →
// 种子词解析宿主实例）→ 席位渲染（ctx.plugin → slots 贡献）。
// 真 ac-client-ui-todo 包 + 真 build-channel v3 产物 + 真 HTTP 面——
// 全链无 mock（除 rpc wire 拒绝桩——数据面不在本测范围）。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

let root = '';
let ctx: Context;
let svc: WebServerService;
let port = 0;

beforeAll(async () => {
  // 产物就位（真构建器——本测自足，不依赖仓库预构建态）
  const build = spawnSync(process.execPath, [join(repoRoot, 'apps/ui/scripts/build-channel.mjs'), 'todo'],
    { cwd: repoRoot, encoding: 'utf8' });
  if (build.status !== 0) throw new Error('build-channel todo 失败：' + build.stderr);

  root = await mkdtemp(join(tmpdir(), 'ac-e2e-v3-'));
  await mkdir(join(root, 'profile'), { recursive: true });
  await writeFile(join(root, 'profile', 'webui.patch.yml'),
    '- id: todo\n  name: link:packages/ac-client-ui-todo\n');

  ctx = new Context();
  svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 } as never);
  port = await svc.ready();
  const handle: WebuiRowV3Handle = {};
  ctx.plugin(makeWebuiRowV3({
    baseUrl: pathToFileURL(repoRoot).href + '/',
    profileDir: join(root, 'profile'),
    shellSeeds: { vue: '^3.5', 'ac-client-runtime': '^0.1', '@agentchat/webui-kit': '^0.1' },
    handle,
  }));
  // 装载趟排空（setImmediate 让 apply 返回后再起装载）
  await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  await handle.loader!.await();
  await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
});

afterAll(async () => {
  await svc?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const http = (p: string) => `http://127.0.0.1:${port}${p}`;

describe('webui-v3 切片① · todo 一件通', () => {
  it('声明 → 装载 → wire → 物化 → 席位渲染', async () => {
    setActivePinia(createPinia());

    // wire：宿主活装配态投影（真 HTTP）
    const wireRes = await fetch(http('/api/ui/wire'));
    expect(wireRes.status).toBe(200);
    const wire = await wireRes.json() as { rev: string; rows: { id: string; entry: string }[] };
    const todoRow = wire.rows.find((r) => r.id === 'ac-client-ui-todo');
    expect(todoRow).toBeDefined();
    expect(todoRow!.entry).toMatch(/^\/ui-asset\/ac-client-ui-todo\/[0-9a-f]+\/index\.js$/);

    // 壳 v3：模块表装载（bundle 真字节 fetch + eval；种子词解析宿主实例）
    const result = await bootUiClientV3({
      fetchWire: async () => (await (await fetch(http('/api/ui/wire'))).json()) as never,
      loadScript: async (url) => {
        const res = await fetch(http(url));
        if (!res.ok) throw new Error('bundle ' + res.status + ' ' + url);
        (0, eval)(await res.text());
      },
    });
    expect(result.channel.get('ac-client-ui-todo')).toBe('ok');

    // 物化产物 = 真插件对象（default export → ctx.plugin → ACTIVE）
    const mod = await result.modules.import('ac-client-ui-todo') as { default?: { name?: string } };
    expect(mod.default?.name).toBe('ac-client-ui-todo.client');

    // 席位渲染面：slots 贡献在位（tool-card:result-view 由 renderer 骨架声明，
    // inject 即落位；conversation:dock-widget 未声明则挂 pending——两态其一）
    const snap = result.ctx.slots.snapshot();
    const landed = Object.entries(snap.slots).some(([key, entries]) =>
      key === 'tool-card:result-view' && (entries as { id: string }[]).some((e) => e.id === 'todo'));
    // 席位两态其一：tool-card:result-view 已声明（renderer 骨架）则落位；
    // conversation:dock-widget 未声明则挂 pending inject（声明方域行不在场）
    const pendingKeys = [...(result.ctx.slots.pendingInjects() as Map<string, unknown>).keys()];
    expect(landed || pendingKeys.includes('conversation:dock-widget')).toBe(true);
  }, 60_000);
});
