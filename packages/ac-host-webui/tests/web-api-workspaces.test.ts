// ============================================================
// web-api-workspaces.test.ts —— /api/workspaces 四路由接线（cr-583）
// 桩 web 面捕获路由处理器，逐 handler 验参数窄化 + 状态码 + 载荷形
//（主线 ac-web-api REST 同形——前端 workspaceBoard 零改动消费）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeWebApiRow } from '../src/web-api.ts';
import type { Plugin, Context } from '@agentchat/cordis';

const ROOT = path.join('sandbox', 'test-ws-api-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Handler = (call: Record<string, unknown>) => void | Promise<void>;
interface Res { status: number; body: string }

function captureRoutes(): { routes: Map<string, Handler>; plugin: Plugin } {
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
  return { routes, plugin };
}

function call(handler: Handler, init: Record<string, unknown> = {}): Promise<Res> {
  const res: Res = { status: 0, body: '' };
  return Promise.resolve(handler({
    res: {
      writeHead(status: number, headers: Record<string, string>) { res.status = status; void headers; },
      end(body: string) { res.body = body; },
    },
    ...init,
  })).then(() => res);
}

describe('/api/workspaces（cr-583：登记面 REST——前端 workspaceBoard 数据源）', () => {
  it('GET 空登记 = 空数组；POST 登记 → GET 回读；POST 缺 path = 400', async () => {
    const { routes } = captureRoutes();
    const get = routes.get('GET /api/workspaces')!;
    const post = routes.get('POST /api/workspaces')!;
    expect((await call(get)).body).toBe(JSON.stringify({ workspaces: [] }));
    const bad = await call(post, { body: {} });
    expect(bad.status).toBe(400);
    const ok = await call(post, { body: { path: 'C:\\proj\\demo', name: '演示' } });
    expect(ok.status).toBe(200);
    const ws = JSON.parse(ok.body).workspace;
    expect(ws).toMatchObject({ name: '演示', path: 'C:\\proj\\demo' });
    const list = JSON.parse((await call(get)).body);
    expect(list.workspaces).toEqual([ws]);
  });

  it('PATCH 改名 / 未命中 404；DELETE 删除', async () => {
    const { routes } = captureRoutes();
    const ws = JSON.parse((await call(routes.get('POST /api/workspaces')!, { body: { path: 'C:\\a' } })).body).workspace;
    const patch = routes.get('PATCH /api/workspaces/:id')!;
    const miss = await call(patch, { params: { id: 'ws-ghost' }, body: { name: 'x' } });
    expect(miss.status).toBe(404);
    const hit = await call(patch, { params: { id: ws.id }, body: { name: '改名' } });
    expect(JSON.parse(hit.body).workspace.name).toBe('改名');
    const del = await call(routes.get('DELETE /api/workspaces/:id')!, { params: { id: ws.id } });
    expect(JSON.parse(del.body)).toEqual({ deleted: true });
    expect(JSON.parse((await call(routes.get('GET /api/workspaces')!)).body).workspaces).toEqual([]);
  });
});
