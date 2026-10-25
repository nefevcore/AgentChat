// ============================================================
// web-api-workspace-files.test.ts —— 工作区文件面四路由接线（cr-676）
// 桩 web 面捕获路由处理器，逐 handler 验参数窄化 + 状态码 + 载荷形
//（主线 ac-workspace HTTP 同形——前端树面板/预览/上传零改动消费）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeWebApiRow } from '../src/web-api.ts';
import type { Plugin, Context } from '@agentchat/cordis';

const ROOT = path.join('preview', 'sandbox', 'test-ws-files-api-' + process.pid);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'agents', 'neko'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', 'neko', 'config.json'), JSON.stringify({ id: 'neko' }));
  fs.writeFileSync(path.join(ROOT, 'note.md'), '# hi\n');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Handler = (call: Record<string, unknown>) => void | Promise<void>;
interface Res { status: number; headers: Record<string, string>; body: string | Buffer }

function captureRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const plugin = makeWebApiRow({
    user: { send: async () => { throw new Error('不该触达'); } },
    dataRoot: ROOT,
  });
  const apply = (plugin as { apply(ctx: Context): void }).apply;
  apply({
    webServer: {
      registerRpc: () => {},
      route: (method: string, p: string, handler: Handler) => { routes.set(method + ' ' + p, handler); },
    },
  } as unknown as Context);
  return routes;
}

function call(
  handler: Handler,
  init: { query?: URLSearchParams; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const res: Res = { status: 0, headers: {}, body: '' };
  return Promise.resolve(handler({
    res: {
      writeHead(status: number, headers: Record<string, string>) { res.status = status; res.headers = headers; },
      end(body?: string | Buffer) { res.body = body ?? ''; },
    },
    query: init.query ?? new URLSearchParams(),
    req: { headers: init.headers ?? {} },
    ...(init.body !== undefined ? { body: init.body } : {}),
  })).then(() => res);
}

function json(res: Res): Record<string, unknown> {
  return JSON.parse(res.body.toString()) as Record<string, unknown>;
}

describe('/api/workspace/tree（cr-676）', () => {
  it('根层列出数据根内容；agentId 切换树基准；越界 = 400', async () => {
    const get = captureRoutes().get('GET /api/workspace/tree')!;
    const root = await call(get);
    expect(root.status).toBe(200);
    expect(json(root)).toMatchObject({ path: '', root: { label: '' } });
    expect((json(root).children as Array<{ name: string }>).some((n) => n.name === 'note.md')).toBe(true);
    const agent = await call(get, { query: new URLSearchParams({ agentId: 'neko' }) });
    expect(json(agent)).toMatchObject({ root: { label: 'Agent/neko' } });
    const escape = await call(get, { query: new URLSearchParams({ path: '../..' }) });
    expect(escape.status).toBe(400);
    expect(String(json(escape).error)).toContain('路径越界');
  });
});

describe('/api/workspace/file 与 raw（cr-676）', () => {
  it('file：缺 path = 400；命中 = 文本载荷；不存在 = 404', async () => {
    const routes = captureRoutes();
    const file = routes.get('GET /api/workspace/file')!;
    expect((await call(file)).status).toBe(400);
    const hit = await call(file, { query: new URLSearchParams({ path: 'note.md' }) });
    expect(hit.status).toBe(200);
    expect(json(hit)).toMatchObject({ path: 'note.md', content: '# hi\n', base64: false });
    expect((await call(file, { query: new URLSearchParams({ path: 'ghost.md' }) })).status).toBe(404);
  });

  it('raw：直回字节 + ETag 304 重协商', async () => {
    const raw = captureRoutes().get('GET /api/workspace/raw')!;
    const first = await call(raw, { query: new URLSearchParams({ path: 'note.md' }) });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(first.body.toString()).toBe('# hi\n');
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"wf-\d+-\d+"$/);
    const second = await call(raw, { query: new URLSearchParams({ path: 'note.md' }), headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect((await call(raw, { query: new URLSearchParams({ path: 'ghost.md' }) })).status).toBe(404);
  });
});

describe('/api/upload（cr-676）', () => {
  it('multipart file + agentId → files/<id>/_tmp；缺 file = 400', async () => {
    const post = captureRoutes().get('POST /api/upload')!;
    expect((await call(post, { body: { fields: {}, files: {} } })).status).toBe(400);
    const ok = await call(post, {
      body: {
        fields: { agentId: 'neko' },
        files: { file: { filename: 'x.txt', contentType: 'text/plain', data: Buffer.from('hi') } },
      },
    });
    expect(ok.status).toBe(200);
    const payload = json(ok);
    expect(String(payload.path)).toMatch(/^files\/neko\/_tmp\/[0-9a-f]{12}\.txt$/);
    expect(fs.readFileSync(String(payload.absPath), 'utf-8')).toBe('hi');
  });
});
