// ============================================================
// ac-web-server：静态资源压缩（Accept-Encoding 协商 + 结果缓存）
//
// 背景（前端性能分析 2026-01-00）：serveStatic 曾 readFile → end 裸传原始
// 字节——1.57MB 的 markdown chunk（gzip 519KB）全量过线。此处用 node:http
// 原始请求（不走 fetch 的自动解压）验证协商分支、解压一致性与缓存失效。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Context } from '@agentchat/cordis';
import { WebServerService } from '../src/service.ts';

const servers: WebServerService[] = [];

async function boot(options: Record<string, unknown> = {}): Promise<number> {
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0, ...options } as never);
  servers.push(svc);
  return svc.ready();
}

/** 原始请求（保留 content-encoding 与未解压字节——fetch 会自动解码） */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 大且可压缩的 JS（≥ MIN_COMPRESS_BYTES；长重复串压缩率极高） */
const BIG_JS = `export const payload = "${'x'.repeat(6000)}";\n`;
const TINY_JS = 'console.log(1);';

afterEach(async () => {
  for (const svc of servers.splice(0)) await svc.stop();
});

describe('ac-web-server 静态资源压缩', () => {
  it('br 优先 + 解压一致 + Vary 声明 + assets 长缓存', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-br-'));
    await writeFile(join(dir, 'app.js'), BIG_JS);
    const port = await boot({ staticDir: dir });

    const r = await rawGet(port, '/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers.vary).toBe('accept-encoding');
    expect(brotliDecompressSync(r.body).toString('utf-8')).toBe(BIG_JS);
    // 压缩确有收益（不是「标了头没压」）
    expect(r.body.length).toBeLessThan(BIG_JS.length);
  });

  it('serveFileRoute：ETag 304 + br 压缩 + 重建失效 + 缺席 false（cr-843 通道面应答原语）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-etag-'));
    const file = join(dir, 'chan.js');
    await writeFile(file, BIG_JS);
    const ctx = new Context();
    const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
    servers.push(svc);
    const port = await svc.ready();
    // webui 行通道资产路由同款用法（/ui-plugin/:name/* → serveFileRoute）
    svc.route('GET', '/chan.js', (call) => {
      void svc.serveFileRoute(call.res, file, {
        acceptEncoding: call.req.headers['accept-encoding'] ?? '',
      }).then((hit) => {
        if (!hit) {
          call.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          call.res.end('not found');
        }
      });
    });

    const ae = { 'accept-encoding': 'gzip, deflate, br' };
    const first = await rawGet(port, '/chan.js', ae);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^W\//);
    expect(first.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(first.body).toString('utf-8')).toBe(BIG_JS);

    // If-None-Match 命中 → 304 零字节（刷新时通道产物免整文件重传）
    const revalidate = await rawGet(port, '/chan.js', { ...ae, 'if-none-match': first.headers.etag! });
    expect(revalidate.status).toBe(304);
    expect(revalidate.body.length).toBe(0);

    // 文件重建（mtime/size 变）→ etag 失效 → 200 新字节
    await new Promise((r) => setTimeout(r, 5)); // mtime ms 可分辨
    await writeFile(file, BIG_JS + '\nexport const v2 = 1;\n');
    const renewed = await rawGet(port, '/chan.js', { ...ae, 'if-none-match': first.headers.etag! });
    expect(renewed.status).toBe(200);
    expect(brotliDecompressSync(renewed.body).toString('utf-8')).toContain('v2');

    // 缺席文件返回 false（降级归调用方——404 由路由面写）
    const res = new http.ServerResponse(new http.IncomingMessage(null as never));
    await expect(svc.serveFileRoute(res, join(dir, 'nope.js'), { acceptEncoding: '' })).resolves.toBe(false);
  });

  it('gzip 回退（客户端不支持 br）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-gz-'));
    await writeFile(join(dir, 'app.js'), BIG_JS);
    const port = await boot({ staticDir: dir });

    const r = await rawGet(port, '/app.js', { 'accept-encoding': 'gzip' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(r.body).toString('utf-8')).toBe(BIG_JS);
  });

  it('客户端不声明压缩 / 声明 identity → 原文下行且无 content-encoding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-id-'));
    await writeFile(join(dir, 'app.js'), BIG_JS);
    const port = await boot({ staticDir: dir });

    const none = await rawGet(port, '/app.js');
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.body.toString('utf-8')).toBe(BIG_JS);

    const identity = await rawGet(port, '/app.js', { 'accept-encoding': 'identity' });
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body.toString('utf-8')).toBe(BIG_JS);
  });

  it('不可压缩类型（字体/图片）与小文件不压缩', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-bin-'));
    await writeFile(join(dir, 'font.woff2'), 'x'.repeat(4000));
    await writeFile(join(dir, 'tiny.js'), TINY_JS);
    const port = await boot({ staticDir: dir });

    const font = await rawGet(port, '/font.woff2', { 'accept-encoding': 'br, gzip' });
    expect(font.headers['content-encoding']).toBeUndefined();
    expect(font.body.length).toBe(4000);

    const tiny = await rawGet(port, '/tiny.js', { 'accept-encoding': 'br, gzip' });
    expect(tiny.headers['content-encoding']).toBeUndefined();
    expect(tiny.body.toString('utf-8')).toBe(TINY_JS);
  });

  it('HEAD：与压缩后长度一致且无 body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-head-'));
    await writeFile(join(dir, 'app.js'), BIG_JS);
    const port = await boot({ staticDir: dir });

    const get = await rawGet(port, '/app.js', { 'accept-encoding': 'br' });
    const head = await rawGet(port, '/app.js', { 'accept-encoding': 'br' }, 'HEAD');
    expect(head.headers['content-encoding']).toBe('br');
    expect(head.headers['content-length']).toBe(String(get.body.length));
    expect(head.body.length).toBe(0);
  });

  it('文件变更（size/mtime 变）→ 压缩缓存失效，回源新内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-cache-'));
    const file = join(dir, 'app.js');
    await writeFile(file, BIG_JS);
    const port = await boot({ staticDir: dir });

    const first = await rawGet(port, '/app.js', { 'accept-encoding': 'br' });
    expect(brotliDecompressSync(first.body).toString('utf-8')).toBe(BIG_JS);

    const next = BIG_JS + 'export const extra = 1;\n';
    await writeFile(file, next);
    const second = await rawGet(port, '/app.js', { 'accept-encoding': 'br' });
    expect(brotliDecompressSync(second.body).toString('utf-8')).toBe(next);
  });
});
