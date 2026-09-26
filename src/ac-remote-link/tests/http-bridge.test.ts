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
        // 回显方法 + 体（十六进制）——供字节级比对
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, hex: body.toString('hex') }));
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
      if (req.url?.startsWith('/api/big')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(MAX_PROXY_BODY_BYTES + 1, 7));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => { void new Promise<void>((r) => server.close(() => r())); });

describe('路径与方法闸', () => {
  it('非 /api/ 前缀拒绝', async () => {
    await expect(proxyToSelf(port, { path: '/etc/passwd' })).rejects.toThrow('only /api/');
    await expect(proxyToSelf(port, { path: '/ws' })).rejects.toThrow('only /api/');
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

