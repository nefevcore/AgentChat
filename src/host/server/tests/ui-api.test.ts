// ============================================================
// P5 测试：/api/ui/extensions + /api/ui/slots 形状 + /ui-plugin 静态路由守卫
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { WebUIService } from '@agentchat/plugins';
import { UI_SLOT_CATALOG, createUiPluginStaticHandler, createUiRouter } from '../src/api/ui';

let tmp: string;
let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-api-'));

  // 准备插件目录与 webui 服务
  const pluginDir = path.join(tmp, 'my-plugin');
  fs.mkdirSync(path.join(pluginDir, 'ui', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'ui', 'dist', 'index.js'), 'export function install() { /* ui-api fixture */ }\n', 'utf-8');
  fs.writeFileSync(path.join(pluginDir, 'style.css'), 'body { color: rgb(1, 2, 3); }\n', 'utf-8');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top secret\n', 'utf-8');

  const ctx = new Context();
  const webui = new WebUIService(ctx);
  webui.addEntry('my-plugin', '1.0.0', pluginDir, {
    entry: 'ui/dist/index.js',
    styles: ['style.css'],
    slots: ['tool-result', 'settings-tab:agent'],
    isolated: false,
  }, 'session', ['fs', 'network', 'ui']);

  app = express();
  app.use(express.json());
  app.use('/api/ui', createUiRouter(ctx));
  app.use('/ui-plugin', createUiPluginStaticHandler(ctx));

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
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('/api/ui', () => {
  it('GET /api/ui/extensions 返回 webui 清单', async () => {
    const resp = await fetch(`${baseUrl}/api/ui/extensions`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.extensions).toHaveLength(1);
    expect(body.extensions[0]).toMatchObject({
      name: 'my-plugin',
      version: '1.0.0',
      entry: '/ui-plugin/my-plugin/ui/dist/index.js',
      styles: ['/ui-plugin/my-plugin/style.css'],
      slots: ['tool-result', 'settings-tab:agent'],
      isolated: false,
      status: 'session',
    });
    expect(body.extensions[0].grantedPermissions).toContain('ui');
  });

  it('GET /api/ui/slots 返回 8 个 slot 目录（中文标签/描述）', async () => {
    const resp = await fetch(`${baseUrl}/api/ui/slots`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.slots).toHaveLength(8);
    expect(UI_SLOT_CATALOG.map((s) => s.id)).toEqual([
      'perspective', 'tool-result', 'message-view', 'ws-event',
      'settings-tab:global', 'settings-tab:agent', 'sidebar-action', 'global-style',
    ]);
    expect(body.slots.find((s: any) => s.id === 'tool-result').label).toBeTruthy();
    expect(body.slots.find((s: any) => s.id === 'settings-tab:agent').description).toBeTruthy();
  });

  it('GET /api/ui/extensions 在无 webui 服务时返回空数组', async () => {
    const app2 = express();
    app2.use('/api/ui', createUiRouter(undefined));
    await new Promise<void>((resolve) => {
      const srv = app2.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as AddressInfo).port;
        void fetch(`http://127.0.0.1:${port}/api/ui/extensions`)
          .then(async (r) => {
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ extensions: [] });
          })
          .finally(() => srv.close(() => resolve()));
      });
    });
  });
});

describe('/ui-plugin 静态托管守卫', () => {
  it('GET /ui-plugin/:name/* 返回产物与正确 Content-Type', async () => {
    const resp = await fetch(`${baseUrl}/ui-plugin/my-plugin/ui/dist/index.js`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/javascript');
    expect(await resp.text()).toContain('ui-api fixture');

    const css = await fetch(`${baseUrl}/ui-plugin/my-plugin/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('路径逃逸（..）返回 403/404；非法插件名返回 403；未注册插件 404', async () => {
    // 编码后发请求，避免 fetch 客户端预先归一化 URL
    const traversal = await fetch(`${baseUrl}/ui-plugin/my-plugin/%2e%2e/secret.txt`);
    expect([403, 404]).toContain(traversal.status);

    const badName = await fetch(`${baseUrl}/ui-plugin/BAD-Name/ui/dist/index.js`);
    expect(badName.status).toBe(403);

    const unregistered = await fetch(`${baseUrl}/ui-plugin/ghost/ui/dist/index.js`);
    expect(unregistered.status).toBe(404);
  });

  it('不允许的文件扩展名返回 403', async () => {
    const pluginDir = path.join(tmp, 'my-plugin');
    fs.writeFileSync(path.join(pluginDir, 'notes.txt'), 'not allowed\n', 'utf-8');
    const resp = await fetch(`${baseUrl}/ui-plugin/my-plugin/notes.txt`);
    expect(resp.status).toBe(403);
  });
});
