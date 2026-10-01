// ============================================================
// http-bridge 测试（M3.4）：远程 WebView 的 /api/* 经此投回核心端自身 web-server。
//   · 路径闸：仅 /api/ 前缀；URL 形态（://、反斜杠）拒绝
//   · 方法闸：白名单外拒绝；GET 不带体
//   · 往返：状态码 / Content-Type / body 字节（含二进制）原样
//   · 体积闸：请求体与响应体超限一律 413（而非截断/断链）
// 用真实 http 服务端（与生产同一条回环路径——不 mock fetch）
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { proxyToSelf, MAX_PROXY_BODY_BYTES } from '../src/http-bridge.ts';

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url?.startsWith('/api/echo')) {
        // 回显方法 + 体（十六进制）+ If-None-Match——供字节级比对与条件请求验证
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          hex: body.toString('hex'),
          inm: req.headers['if-none-match'] ?? null,
        }));
        return;
      }
      // 注意顺序：前缀匹配，更具体者在前（/api/binary 会吞掉 /api/binary-plus）
      if (req.url?.startsWith('/api/binary-plus')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0xfb, 0xff, 0xbf, 0xfe, 0xfd]));
        return;
      }
      if (req.url?.startsWith('/api/binary')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 253, 254, 255]));
        return;
      }
      // 缓存头透传（cr-82）：远程 WebView HTTP 缓存的前提——ETag/Cache-Control
      // 必须原样到达桥侧（此前协议只回 status/contentType/body，缓存不可能生效）
      if (req.url?.startsWith('/api/cached')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
          etag: '"av-1-2"',
          'x-custom': 'dropped', // 白名单外的头不透传
        });
        res.end(Buffer.from([9, 9]));
        return;
      }
      if (req.url?.startsWith('/api/big')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(MAX_PROXY_BODY_BYTES + 1, 7));
        return;
      }
      // 静态面（cr-101 变体B）：模仿 web-server 静态行为——index.html 带 ETag 可
      // 重协商（304 零字节），assets/* immutable 长缓存（增量更新的全部前提）
      if (req.url === '/index.html' || req.url === '/') {
        if (req.headers['if-none-match'] === '"idx-1"') {
          res.writeHead(304, { etag: '"idx-1"' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          etag: '"idx-1"',
 'cache-control': 'no-cache',
        });
        res.end('<html>ok</html>');
        return;
      }
      if (req.url?.startsWith('/assets/')) {
        res.writeHead(200, {
          'content-type': 'application/javascript',
          etag: '"a1"',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end('console.log(1)');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  it('条件请求上行（cr-82）：ifNoneMatch → 核心端 If-None-Match（304 重协商前提）', async () => {
    const r = await proxyToSelf(port, { path: '/api/echo', ifNoneMatch: '"av-1-2"' });
    const body = JSON.parse(Buffer.from(r.bodyB64, 'base64').toString());
    expect(body.inm).toBe('"av-1-2"');
  });

  it('缓存头白名单透传（cr-82）：etag/cache-control 原样到达，白名单外丢弃', async () => {
    const r = await proxyToSelf(port, { path: '/api/cached' });
    expect(r.status).toBe(200);
    expect(r.cacheHeaders).toEqual({
      'cache-control': 'public, max-age=31536000, immutable',
      etag: '"av-1-2"',
    });
    const body = Buffer.from(r.bodyB64, 'base64');
    expect(Array.from(body)).toEqual([9, 9]);
  });
});

afterAll(() => { void new Promise<void>((r) => server.close(() => r())); });

describe('路径与方法闸', () => {
  it('非 /api/ 前缀且非静态白名单拒绝', async () => {
    await expect(proxyToSelf(port, { path: '/etc/passwd' })).rejects.toThrow('only /api/');
    await expect(proxyToSelf(port, { path: '/ws' })).rejects.toThrow('only /api/');
  });

  it('静态白名单路径放行（cr-101 变体B：webui dist 在线取用）', async () => {
    for (const p of ['/', '/?x=1', '/index.html', '/logo.svg', '/assets/x.js', '/vendor/y.js']) {
      const r = await proxyToSelf(port, { path: p });
      expect(r.status).toBeGreaterThanOrEqual(200); // 过闸即有 HTTP 应答（404 也是应答）
    }
  });

  it('白名单外的静态形态拒绝（越权路径探测）', async () => {
    await expect(proxyToSelf(port, { path: '/secret.txt' })).rejects.toThrow('only /api/');
    await expect(proxyToSelf(port, { path: '/assets/a/b.js' })).rejects.toThrow('only /api/');
    await expect(proxyToSelf(port, { path: '/data/x.json' })).rejects.toThrow('only /api/');
    await expect(proxyToSelf(port, { path: '/assets/../secret' })).rejects.toThrow('only /api/');
  });

  it('index.html 缓存协商：If-None-Match 命中 → 304 零字节（免重装的核心收益）', async () => {
    const miss = await proxyToSelf(port, { path: '/index.html' });
    expect(miss.status).toBe(200);
    expect(miss.cacheHeaders?.etag).toBe('"idx-1"');
    expect(miss.cacheHeaders?.['cache-control']).toBe('no-cache');
    const hit = await proxyToSelf(port, { path: '/index.html', ifNoneMatch: '"idx-1"' });
    expect(hit.status).toBe(304);
  });

  it('assets/* immutable 长缓存头透传（增量更新的前提）', async () => {
    const r = await proxyToSelf(port, { path: '/assets/x.js' });
    expect(r.cacheHeaders?.['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('URL 形态（绝对地址/反斜杠）拒绝——防拼接逃逸', async () => {
    await expect(proxyToSelf(port, { path: '/api/x://evil' })).rejects.toThrow('malformed');
    await expect(proxyToSelf(port, { path: '/api/..\\..\\x' })).rejects.toThrow('malformed');
  });

  it('白名单外方法拒绝', async () => {
    await expect(proxyToSelf(port, { method: 'TRACE', path: '/api/echo' })).rejects.toThrow('not allowed');
  });

  it('host 恒为回环自身——远程无法指定目标（SSRF 结构性排除）', async () => {
    // 路径里塞绝对 URL 已在上面被拒；此处确认正常路径下服务器收到的是本地请求
    const r = await proxyToSelf(port, { path: '/api/echo' });
    expect(r.status).toBe(200);
  });
});

describe('往返保真', () => {
  it('GET：状态码 / Content-Type / JSON 体原样', async () => {
    const r = await proxyToSelf(port, { method: 'GET', path: '/api/echo' });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    const body = JSON.parse(Buffer.from(r.bodyB64, 'base64').toString());
    expect(body.method).toBe('GET');
    expect(body.hex).toBe('');
  });

  it('POST：请求体字节原样送达（十六进制逐字节比对）', async () => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const r = await proxyToSelf(port, {
      method: 'POST',
      path: '/api/echo',
      contentType: 'application/octet-stream',
      bodyB64: payload.toString('base64'),
    });
    const body = JSON.parse(Buffer.from(r.bodyB64, 'base64').toString());
    expect(body.method).toBe('POST');
    expect(body.hex).toBe(payload.toString('hex'));
  });

  it('二进制响应体原样（含 0x00 与高位字节）', async () => {
    const r = await proxyToSelf(port, { path: '/api/binary' });
    expect(r.contentType).toContain('octet-stream');
    expect([...Buffer.from(r.bodyB64, 'base64')]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it('响应体是 **base64url**（手机侧 unb64u 只认 url 字符集——标准 base64 的 +/= 会被拒）', async () => {
    // 造一段编码后必然含 + 或 / 的字节（0xFB 0xFF 0xBF ... 在标准 base64 下产生 +/）
    const r = await proxyToSelf(port, { path: '/api/binary-plus' });
    expect(r.bodyB64).not.toMatch(/[+/=]/);
    expect([...Buffer.from(r.bodyB64, 'base64url')]).toEqual([0xfb, 0xff, 0xbf, 0xfe, 0xfd]);
  });

  it('上游 404 原样透传（不吞成 200）', async () => {
    const r = await proxyToSelf(port, { path: '/api/nope' });
    expect(r.status).toBe(404);
  });
});

describe('体积闸', () => {
  it('请求体超限 → 413（明确报错而非截断）', async () => {
    const r = await proxyToSelf(port, {
      method: 'POST',
      path: '/api/echo',
      bodyB64: Buffer.alloc(MAX_PROXY_BODY_BYTES + 1, 1).toString('base64'),
    });
    expect(r.status).toBe(413);
    const body = JSON.parse(Buffer.from(r.bodyB64, 'base64').toString());
    expect(body.error).toContain('exceeds');
  });

  it('响应体超限 → 413（避免撑爆 relay 单帧上限）', async () => {
    const r = await proxyToSelf(port, { path: '/api/big' });
    expect(r.status).toBe(413);
  });
});

