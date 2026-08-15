// ============================================================
// 块 B：HttpRouteRegistry —— 注册/摘除/稳定 middleware
// ============================================================
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { HttpRouteRegistry } from '../src/http-routes';

let ctx: Context;
let registry: HttpRouteRegistry;
let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

beforeEach(async () => {
  ctx = new Context();
  registry = new HttpRouteRegistry(ctx);
  app = express();
  app.use(registry.middleware); // 稳定引用：后续 rebuild 无需重新 mount
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('HttpRouteRegistry', () => {
  it('register 后立即可路由；list/has 反映注册状态', async () => {
    const router = express.Router();
    router.get('/ping', (_req, res) => res.json({ ok: true }));
    const dispose = registry.register('/api/ping', router);

    expect(registry.has('/api/ping')).toBe(true);
    expect(registry.list().map((r) => r.path)).toEqual(['/api/ping']);
    expect((await (await fetch(`${baseUrl}/api/ping/ping`)).json())).toEqual({ ok: true });
    dispose();
  });

  it('dispose 摘除路由（重建 current Router；同路径后注册者接管）', async () => {
    const v1 = express.Router();
    v1.get('/x', (_req, res) => res.json({ version: 1 }));
    const disposeV1 = registry.register('/api/v', v1);
    expect((await (await fetch(`${baseUrl}/api/v/x`)).json())).toEqual({ version: 1 });

    disposeV1();
    expect(registry.has('/api/v')).toBe(false);
    expect((await fetch(`${baseUrl}/api/v/x`)).status).toBe(404);

    const v2 = express.Router();
    v2.get('/x', (_req, res) => res.json({ version: 2 }));
    const disposeV2 = registry.register('/api/v', v2);
    expect((await (await fetch(`${baseUrl}/api/v/x`)).json())).toEqual({ version: 2 });
    disposeV2();
  });

  it('registerStatic 与 register 同语义；缺失路径归一化', () => {
    const handler = (_req: express.Request, res: express.Response) => res.end();
    const d1 = registry.register('api/x', handler);
    const d2 = registry.registerStatic('/static/y', handler);
    expect(registry.has('/api/x')).toBe(true);
    expect(registry.has('/static/y')).toBe(true);
    d1();
    d2();
    expect(registry.list()).toHaveLength(0);
  });
});
