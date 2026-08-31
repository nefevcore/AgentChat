// ============================================================
// ac-plugin-market/tests/market.test.ts —— M24 P5 市场首期
//   · 搜索结果形状（npm + github 两源；fetcher 注入零网络）
//   · 发现判据锁定：npm keywords:agentchat-plugin 限定 + github
//     topic:agentchat-plugin（src 轨同款 opt-in 门槛——全文检索/
//     topic:agentchat 均为干扰项来源，回归护栏）
//   · market/stage：npm tarball 下载解包 → manifest 校验 → 暂存
//     （来源锚定 PluginSource）
//   · 暂存人审全流：stage → approve → installed+loaded（M23 流复用）
//   · github 来源锚定 repo·ref·commit
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { mkdtemp } from 'node:fs/promises';
import WebSocket from 'ws';
import { Context, type Fiber } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { PluginRegistryService } from 'ac-plugin-registry';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import * as marketRow from '../src/index.ts';

// ---- 测试 tar 构建（tar 头 + gzip；与 tarball.ts 解包器对偶） ----

function tarHeader(name: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 99), 0, 'utf-8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(' '.repeat(8), 148); // checksum 占位（求和时视为空格）
  h.write(type, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function buildTar(files: Array<[string, string | null]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, data] of files) {
    if (data === null) {
      chunks.push(tarHeader(`${name}/`, 0, '5'));
      continue;
    }
    const content = Buffer.from(data, 'utf-8');
    chunks.push(tarHeader(name, content.length, '0'));
    chunks.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const NPM_TARBALL = zlib.gzipSync(
  buildTar([
    ['package', null],
    ['package/manifest.json', JSON.stringify({ name: 'market-tool', version: '1.0.2', entry: 'index.ts', description: '市场测试插件' })],
    ['package/index.ts', 'export function apply() {}\n'],
  ]),
);
const GH_TARBALL = zlib.gzipSync(
  buildTar([
    ['acme-pdf-reader-abc123', null],
    ['acme-pdf-reader-abc123/manifest.json', JSON.stringify({ name: 'pdf-reader', version: '2.0.1', entry: 'index.ts' })],
    ['acme-pdf-reader-abc123/index.ts', 'export function apply() {}\n'],
  ]),
);
const NO_MANIFEST_TARBALL = zlib.gzipSync(
  buildTar([
    ['package', null],
    ['package/index.js', 'module.exports = {}\n'],
  ]),
);

const NPM = 'https://registry.npmjs.test';
const GH = 'https://api.github.test';

/** 零网络 fetch 桩：按 URL 前缀路由；请求 URL 全量记录（判据断言用） */
const requestedUrls: string[] = [];
function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  requestedUrls.push(url);
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith(`${NPM}/-/v1/search`)) {
    return Promise.resolve(
      json({
        objects: [
          {
            package: {
              name: 'market-tool',
              version: '1.0.2',
              description: '市场测试插件',
              links: { npm: 'https://npmjs.test/package/market-tool' },
            },
          },
        ],
      }),
    );
  }
  if (url.startsWith(`${NPM}/market-tool`)) {
    return Promise.resolve(
      json({
        'dist-tags': { latest: '1.0.2' },
        versions: { '1.0.2': { dist: { tarball: 'https://tar.test/market-tool-1.0.2.tgz' } } },
      }),
    );
  }
  if (url.startsWith(`${NPM}/no-manifest-pkg`)) {
    return Promise.resolve(
      json({
        'dist-tags': { latest: '0.1.0' },
        versions: { '0.1.0': { dist: { tarball: 'https://tar.test/no-manifest.tgz' } } },
      }),
    );
  }
  if (url.startsWith('https://tar.test/market-tool')) {
    return Promise.resolve(new Response(NPM_TARBALL, { status: 200 }));
  }
  if (url.startsWith('https://tar.test/no-manifest')) {
    return Promise.resolve(new Response(NO_MANIFEST_TARBALL, { status: 200 }));
  }
  if (url.startsWith(`${GH}/search/repositories`)) {
    return Promise.resolve(
      json({
        total_count: 1,
        items: [
          {
            full_name: 'acme/pdf-reader',
            description: 'PDF 解析工具',
            stargazers_count: 342,
            html_url: 'https://github.test/acme/pdf-reader',
            default_branch: 'v2.0.1',
          },
        ],
      }),
    );
  }
  if (url === `${GH}/repos/acme/pdf-reader`) {
    return Promise.resolve(json({ default_branch: 'v2.0.1' }));
  }
  if (url.startsWith(`${GH}/repos/acme/pdf-reader/commits/`)) {
    return Promise.resolve(json({ sha: 'abc123deadbeef' }));
  }
  if (url.startsWith('https://codeload.github.com/acme/pdf-reader')) {
    return Promise.resolve(new Response(GH_TARBALL, { status: 200 }));
  }
  if (url.startsWith('https://api.npmjs.org/downloads')) {
    return Promise.reject(new Error('downloads 装饰面失败容忍'));
  }
  return Promise.reject(new Error(`fakeFetch: 未路由的 URL ${url}（${init?.method ?? 'GET'}）`));
}

// ---- harness ----

const harnesses: Array<{ web: WebServerService; ctx: Context }> = [];
const sockets: WebSocket[] = [];

async function boot(root: string) {
  const ctx = new Context();
  const web = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  const plugins = new PluginRegistryService(ctx, {
    root,
    gatesTimeoutMs: 100,
    importModule: async () => ({ apply() {} }), // 装载桩（零文件系统依赖）
  });
  await ctx.plugin(marketRow, { fetchImpl: fakeFetch, npmRegistry: NPM, githubApi: GH });
  const port = await web.ready();
  harnesses.push({ web, ctx });
  return { ctx, plugins, root, port };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      if (parseFrame(raw.toString())?.type === WS_READY) resolve(ws);
    });
  });
}

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data);
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

describe('ac-plugin-market（M24 P5）', () => {
  it('搜索结果形状：npm + github 两源；下载量失败容忍', async () => {
    const h = await boot(await mkdtemp(path.join(os.tmpdir(), 'ac-market-')));
    const ws = await connect(h.port);
    const r = await rpc(ws, 'market/search', 'r1', { query: 'weather' });
    expect(r.ok).toBe(true);
    const results = r.result.results as Array<Record<string, unknown>>;
    const npmHit = results.find((x) => x.source === 'npm');
    expect(npmHit).toMatchObject({
      name: 'market-tool',
      version: '1.0.2',
      spec: 'npm:market-tool@1.0.2',
    });
    // 下载量装饰面失败 → 字段缺省（不炸搜索）
    expect(npmHit?.downloads).toBeUndefined();
    const ghHit = results.find((x) => x.source === 'github');
    expect(ghHit).toMatchObject({
      name: 'acme/pdf-reader',
      stars: 342,
      spec: 'github:acme/pdf-reader#v2.0.1',
    });

    // 发现判据锁定（opt-in 门槛，干扰项回归护栏）：npm 走 keywords 限定、
    // github 走 topic:agentchat-plugin——查询词原样携带
    const npmSearchUrl = requestedUrls.find((u) => u.includes('/-/v1/search'));
    expect(decodeURIComponent(npmSearchUrl ?? '')).toContain('keywords:agentchat-plugin weather');
    const ghSearchUrl = requestedUrls.find((u) => u.includes('/search/repositories'));
    expect(decodeURIComponent(ghSearchUrl ?? '')).toContain('topic:agentchat-plugin weather');
  });

  it('npm 暂存人审全流：stage（tarball 来源锚定）→ approve → installed+loaded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ac-market-'));
    const h = await boot(root);
    const ws = await connect(h.port);

    const r = await rpc(ws, 'market/stage', 'r1', { spec: 'npm:market-tool@1.0.2', owner: 'user' });
    expect(r.ok).toBe(true);
    const staging = r.result.staging as {
      id: string;
      manifest: { name: string; version: string };
      requiredGrants: string[];
    };
    expect(staging.manifest).toEqual({ name: 'market-tool', version: '1.0.2', description: '市场测试插件', entry: 'index.ts' });
    expect(r.result.source).toEqual({ kind: 'tarball', spec: 'npm:market-tool@1.0.2' });
    // 待审在册（目录 · 本地组的 pending 徽章数据源）
    expect(h.plugins.listStaging().map((s) => s.manifest.name)).toEqual(['market-tool']);

    // 人审批准 → 安装 + 装载（M23 流原样）
    const approved = await h.plugins.approve(staging.id, []);
    expect(approved.name).toBe('market-tool');
    expect(approved.load).toMatchObject({ status: 'loaded', name: 'market-tool' });
    expect(h.plugins.has('market-tool')).toBe(true);
    // 安装态带来源锚定（供应链取证）
    const installed = h.plugins.listInstalled().find((i) => i.manifest.name === 'market-tool');
    expect(installed?.source).toEqual({ kind: 'tarball', spec: 'npm:market-tool@1.0.2' });
  });

  it('github 来源锚定 repo·ref·commit；缺 manifest 的包拒绝', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ac-market-'));
    const h = await boot(root);
    const ws = await connect(h.port);

    const r = await rpc(ws, 'market/stage', 'r1', { spec: 'github:acme/pdf-reader#v2.0.1' });
    expect(r.ok).toBe(true);
    expect(r.result.source).toEqual({
      kind: 'github',
      repo: 'acme/pdf-reader',
      ref: 'v2.0.1',
      commit: 'abc123deadbeef',
      spec: 'github:acme/pdf-reader#v2.0.1',
    });
    expect(r.result.staging.manifest.name).toBe('pdf-reader');

    const bad = await rpc(ws, 'market/stage', 'r2', { spec: 'npm:no-manifest-pkg' });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('manifest');
  });
});
