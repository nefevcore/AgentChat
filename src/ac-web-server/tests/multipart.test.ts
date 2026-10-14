// ============================================================
// ac-web-server：multipart/form-data 解析（M17-E 上传面）契约锁定。
// 上传/头像两消费方（ac-web-api /api/upload、/api/agents/avatar）经
// 真实 HTTP multipart 请求直达本包解析器——此前全仓零覆盖（web-api
// 集成测试自包办请求构造），解析器行为漂移无人拦截。此处经原始
// multipart body 端到端锁定：字段/文件分流、二进制安全、boundary
// 哨兵剥离、坏请求拒绝。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context } from '@agentchat/cordis';
import { WebServerService } from '../src/service.ts';

const servers: WebServerService[] = [];

async function boot(options: Record<string, unknown> = {}): Promise<{ svc: WebServerService; url: string }> {
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0, ...options } as never);
  servers.push(svc);
  const port = await svc.ready();
  return { svc, url: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const svc of servers.splice(0)) await svc.stop();
});

/** 构造原始 multipart body（boundary 哨兵/尾部 CRLF 与 RFC 7578 同形） */
function multipartBody(boundary: string, parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>): ArrayBuffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const headers = ['Content-Disposition: form-data; name="' + p.name + '"' + (p.filename !== undefined ? '; filename="' + p.filename + '"' : '')];
    if (p.contentType) headers.push('Content-Type: ' + p.contentType);
    chunks.push(Buffer.from('--' + boundary + '\r\n' + headers.join('\r\n') + '\r\n\r\n', 'utf-8'));
    chunks.push(p.data);
    chunks.push(Buffer.from('\r\n', 'utf-8'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n', 'utf-8'));
  const raw = Buffer.concat(chunks);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

describe('ac-web-server multipart/form-data 解析', () => {
  it('POST multipart → fields/files 分流（文件二进制安全）', async () => {
    const { svc, url } = await boot();
    let parsed: unknown;
    svc.route('POST', '/upload', (call) => {
      parsed = call.body;
      svc.replyJson(call.res, 200, { ok: true });
    });
    // 含 NUL/FF 与 CRLF--CRLF 序列：验证解析器不破坏二进制、不误伤哨兵
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x0d, 0x0a, 0x2d]);
    const r = await fetch(`${url}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=BOUND' },
      body: multipartBody('BOUND', [
        { name: 'agentId', data: Buffer.from('a1', 'utf-8') },
        { name: 'file', filename: 'blob.bin', contentType: 'application/octet-stream', data: binary },
      ]),
    });
    expect(r.status).toBe(200);
    expect(parsed).toMatchObject({
      fields: { agentId: 'a1' },
      files: { file: { filename: 'blob.bin', contentType: 'application/octet-stream', data: binary } },
    });
  });

  it('缺 boundary → 400；非 multipart 非 JSON body → undefined', async () => {
    const { svc, url } = await boot();
    let seen: unknown = 'unset';
    svc.route('POST', '/echo', (call) => {
      seen = call.body;
      svc.replyJson(call.res, 200, {});
    });
    const noBoundary = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'x',
    });
    expect(noBoundary.status).toBe(400);
    expect(await noBoundary.json()).toMatchObject({ error: expect.stringContaining('boundary') });

    const plain = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'plain text',
    });
    expect(plain.status).toBe(200);
    expect(seen).toBeUndefined();
  });

  it('超限 413（与 JSON body 同口径）', async () => {
    const { svc, url } = await boot({ maxBodyBytes: 64 });
    svc.route('POST', '/upload', (call) => svc.replyJson(call.res, 200, {}));
    const r = await fetch(`${url}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=BOUND' },
      body: multipartBody('BOUND', [
        { name: 'file', filename: 'big.bin', data: Buffer.alloc(200, 0x41) },
      ]),
    });
    expect(r.status).toBe(413);
  });
});
