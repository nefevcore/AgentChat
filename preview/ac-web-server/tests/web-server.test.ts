// ============================================================
// ac-web-server：HTTP 路由注册中心 + WS rpc/ack/dedup/事件
// 真实起服（port 0 随机端口），fetch + ws 客户端双通道验证。
// + A1 信任边界回归：非回环 Origin / 非回环 Host 拒绝（浏览器跨站
//   探测与 DNS rebinding 面），白名单显式放行。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import WebSocket from 'ws';
import { Context } from '@agentchat/cordis';
import { WebServerService } from '../src/service.ts';
import {
  buildFrame,
  parseFrame,
  RPC_CALL,
  RPC_RESULT,
  WS_ACK,
  WS_READY,
} from 'ac-ws-protocol';

const servers: WebServerService[] = [];
const sockets: WebSocket[] = [];

type Ctx = import('@agentchat/cordis').Context;

async function boot(
  options: Record<string, unknown> = {},
): Promise<{ ctx: Ctx; svc: WebServerService; port: number; url: string }> {
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0, ...options } as never);
  servers.push(svc);
  const port = await svc.ready();
  return { ctx, svc, port, url: `http://127.0.0.1:${port}` };
}

function connect(port: number): Promise<{ ws: WebSocket; ready: { connId: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type === WS_READY) {
        resolve({ ws, ready: frame.data as { connId: string } });
      }
    });
  });
}

/** 发 rpc/call 并等下一个 rpc/result */
function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: isRaw) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data as { ok: boolean; result?: unknown; error?: string });
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

type isRaw = { toString(): string };

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const svc of servers.splice(0)) await svc.stop();
});

describe('ac-web-server HTTP 路由注册中心', () => {
  it('route 注册 + JSON 路由命中（注册即归属：fiber dispose 回收）', async () => {
    const { svc, url } = await boot();
    const dispose = svc.route('GET', '/api/hello', (call) => {
      svc.replyJson(call.res, 200, { hello: call.query.get('who') ?? 'world' });
    });
    const r1 = await fetch(`${url}/api/hello?who=preview`);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ hello: 'preview' });

    await dispose();
    const r2 = await fetch(`${url}/api/hello`);
    expect(r2.status).toBe(404);
  });

  it(':param 段捕获 + 尾 * 通配；精确匹配优先于通配', async () => {
    const { svc, url } = await boot();
    svc.route('GET', '/api/agents/:id', (call) => svc.replyJson(call.res, 200, { id: call.params.id }));
    svc.route('GET', '/static/*', (call) => svc.replyJson(call.res, 200, { rest: call.params['*'] }));
    svc.route('GET', '/static/exact', (call) => svc.replyJson(call.res, 200, { exact: true }));

    expect(await (await fetch(`${url}/api/agents/bob`)).json()).toEqual({ id: 'bob' });
    expect(await (await fetch(`${url}/static/a/b/c.js`)).json()).toEqual({ rest: 'a/b/c.js' });
    expect(await (await fetch(`${url}/static/exact`)).json()).toEqual({ exact: true });
  });

  it('同 method+pattern 重注册抛错；跨 method 不冲突', async () => {
    const { svc } = await boot();
    svc.route('GET', '/x', () => {});
    expect(() => svc.route('GET', '/x', () => {})).toThrow(/已注册/);
    expect(() => svc.route('POST', '/x', () => {})).not.toThrow();
  });

  it('POST JSON body 解析 + 超限 413 + 坏 JSON 400', async () => {
    const { svc, url } = await boot({ maxBodyBytes: 64 });
    svc.route('POST', '/echo', (call) => svc.replyJson(call.res, 200, { body: call.body }));
    const ok = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await ok.json()).toEqual({ body: { a: 1 } });

    const tooBig = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ big: 'x'.repeat(200) }),
    });
    expect(tooBig.status).toBe(413);

    const bad = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(bad.status).toBe(400);
  });

  it('静态托管：命中文件 / 目录穿越拒绝 / SPA fallback / 缓存策略 + HEAD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-web-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<html>app</html>');
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const { url } = await boot({ staticDir: dir });

    const html = await fetch(`${url}/`);
    expect(await html.text()).toContain('app');
    // 缓存策略（2026-08-30 事故回归）：index.html 无缓存头 → 浏览器启发式
    // 缓存旧 bundle；assets 内容哈希 → immutable
    expect(html.headers.get('cache-control')).toBe('no-cache');
    const js = await fetch(`${url}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const spa = await fetch(`${url}/some/client/route`);
    expect(await spa.text()).toContain('app');
    expect(spa.headers.get('cache-control')).toBe('no-cache');
    // API 路径不落 SPA fallback（JSON 404——降级期客户端可诊断）
    const apiMiss = await fetch(`${url}/api/no-such/route`);
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.headers.get('content-type')).toContain('application/json');
    await expect(apiMiss.json()).resolves.toMatchObject({ error: expect.stringContaining('api') });
    // HEAD：与 GET 同头无body（此前 404）
    const head = await fetch(`${url}/assets/app.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String('console.log(1)'.length));
    expect(await head.text()).toBe('');
    const evil = await fetch(`${url}/..%2f..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(evil.status);
  });
});

describe('ac-web-server WS：rpc 显式注册 + dedup + ack', () => {
  it('连接建立发 ws/ready + emit ws/connection-opened', async () => {
    const { ctx, svc, port } = await boot();
    const opened: string[] = [];
    ctx.on('ws/connection-opened', (connId) => opened.push(connId));
    const { ready } = await connect(port);
    expect(ready.connId).toMatch(/^c\d+$/);
    expect(opened).toEqual([ready.connId]);
    expect(svc.listConnections()).toHaveLength(1);
  });

  it('rpc/call → 显式注册的 handler → rpc/result 回源连接', async () => {
    const { svc, port } = await boot();
    svc.registerRpc('chat.send', (params) => ({ delivered: params }));
    const { ws } = await connect(port);
    const r = await rpc(ws, 'chat.send', 'r1', { to: 'a', text: 'hi' });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ delivered: { to: 'a', text: 'hi' } });
  });

  it('未注册方法 → ok:false unknown method；rpc 行摘除后同样', async () => {
    const { svc, port } = await boot();
    const dispose = svc.registerRpc('temp', () => 1);
    const { ws } = await connect(port);
    expect((await rpc(ws, 'temp', 'a')).ok).toBe(true);
    await dispose();
    const r = await rpc(ws, 'temp', 'b');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown method: temp/);
  });

  it('同 method+requestId 短窗重发 → deduped ack 且不重复执行', async () => {
    const { ctx, svc, port } = await boot();
    let calls = 0;
    svc.registerRpc('chat.send', () => {
      calls += 1;
      return { n: calls };
    });
    const acks: Array<{ requestId: string; kind: string }> = [];
    ctx.on('ws/ack', (p) => acks.push({ requestId: p.requestId, kind: p.kind }));

    const { ws } = await connect(port);
    const first = await rpc(ws, 'chat.send', 'dup-1');
    expect(first.ok).toBe(true);

    const deduped = await new Promise<{ kind: string }>((resolve) => {
      ws.on('message', (raw: isRaw) => {
        const frame = parseFrame(raw.toString());
        if (frame?.type === WS_ACK) resolve(frame.data as { kind: string });
      });
      ws.send(buildFrame(RPC_CALL, { method: 'chat.send', requestId: 'dup-1' }));
    });
    expect(deduped.kind).toBe('deduped');
    expect(calls).toBe(1);
    expect(acks).toEqual([{ requestId: 'dup-1', kind: 'deduped' }]);
  });

  it('caller.ack 上报 busy（定向回源连接 + emit ws/ack）', async () => {
    const { ctx, svc, port } = await boot();
    svc.registerRpc('chat.send', (_params, caller) => {
      caller.ack('busy', { queued: true, handle: 'bob' });
      return { accepted: true };
    });
    const seen: string[] = [];
    ctx.on('ws/ack', (p) => seen.push(p.kind));

    const { ws } = await connect(port);
    const ack = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw: isRaw) => {
        const frame = parseFrame(raw.toString());
        if (frame?.type === WS_ACK) resolve(frame.data as Record<string, unknown>);
      });
      void rpc(ws, 'chat.send', 'r-busy');
    });
    expect(ack).toMatchObject({ requestId: 'r-busy', kind: 'busy', info: { queued: true } });
    expect(seen).toContain('busy');
  });

  it('handler 抛错 → ok:false + error 文本', async () => {
    const { svc, port } = await boot();
    svc.registerRpc('boom', () => {
      throw new Error('kaboom');
    });
    const { ws } = await connect(port);
    const r = await rpc(ws, 'boom', 'r-err');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('kaboom');
  });

  it('broadcast / send 定向帧（type = 事件名直转）', async () => {
    const { svc, port } = await boot();
    const { ws, ready } = await connect(port);
    const got = new Promise<unknown>((resolve) => {
      ws.on('message', (raw: isRaw) => {
        const frame = parseFrame(raw.toString());
        if (frame?.type === 'group/message-posted') resolve(frame.data);
      });
    });
    svc.broadcast('group/message-posted', { gid: 'g1', from: 'alice' });
    expect(await got).toEqual({ gid: 'g1', from: 'alice' });
    expect(svc.send(ready.connId, 'config/changed', { path: '/x' })).toBe(true);
    expect(svc.send('nope', 'config/changed')).toBe(false);
  });

  it('stop：连接断开 + 端口释放', async () => {
    const { svc, port } = await boot();
    const { ws } = await connect(port);
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    await svc.stop();
    await closed;
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

describe('ac-web-server A1 信任边界：Origin / Host 校验', () => {
  /** 原生 http.request 可携带任意 Origin/Host（fetch 会剥离受限头） */
  function rawRequest(
    port: number,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/agents', method: 'GET', headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('非回环 Origin 的 HTTP 请求 → 403；回环 Origin 放行', async () => {
    const { svc, url, port } = await boot();
    svc.route('GET', '/api/agents', (call) => svc.replyJson(call.res, 200, { ok: true }));
    const evil = await rawRequest(port, { origin: 'http://evil.example.com' });
    expect(evil.status).toBe(403);
    const good = await rawRequest(port, { origin: 'http://localhost:3831' });
    expect(good.status).toBe(200);
    const direct = await fetch(`${url}/api/agents`);
    expect(direct.status).toBe(200); // 无 Origin（非浏览器客户端）放行
  });

  it('allowedOrigins 显式放行指定 Origin', async () => {
    const { svc, port } = await boot({ allowedOrigins: ['https://chat.example.com'] });
    svc.route('GET', '/api/agents', (call) => svc.replyJson(call.res, 200, { ok: true }));
    const ok = await rawRequest(port, { origin: 'https://chat.example.com' });
    expect(ok.status).toBe(200);
    const stillEvil = await rawRequest(port, { origin: 'http://evil.example.com' });
    expect(stillEvil.status).toBe(403);
  });

  it('非回环 Host（DNS rebinding）→ 403；回环 Host 放行', async () => {
    const { svc, port } = await boot();
    svc.route('GET', '/api/agents', (call) => svc.replyJson(call.res, 200, { ok: true }));
    const rebinding = await rawRequest(port, { host: 'evil.example.com:3830' });
    expect(rebinding.status).toBe(403);
    const lan = await rawRequest(port, { host: '192.168.1.9:3830' });
    expect(lan.status).toBe(403);
    const loopback = await rawRequest(port, { host: 'localhost:3830' });
    expect(loopback.status).toBe(200);
  });

  it('非回环 Origin 的 WS upgrade 在握手前被拒；allowedOrigins 放行', async () => {
    const { port } = await boot({ allowedOrigins: ['http://good.example.com'] });

    const tryConnect = (origin: string) =>
      new Promise<'open' | 'rejected'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
        sockets.push(ws);
        ws.on('open', () => resolve('open'));
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode === 403 ? 'rejected' : 'open'));
        ws.on('error', () => resolve('rejected')); // 403 后 socket 销毁
      });

    expect(await tryConnect('http://evil.example.com')).toBe('rejected');
    expect(await tryConnect('http://good.example.com')).toBe('open');
    // 无 Origin 头（非浏览器客户端）放行
    expect(
      await new Promise<'open' | 'rejected'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(ws);
        ws.on('open', () => resolve('open'));
        ws.on('error', () => resolve('rejected'));
      }),
    ).toBe('open');
  });
});
