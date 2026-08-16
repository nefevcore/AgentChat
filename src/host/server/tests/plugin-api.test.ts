// ============================================================
// P1 测试：/api/plugins 新契约路由形状 + PluginEventBus 订阅
// ============================================================
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_EVENT } from '@agentchat/protocol';
import { createPluginsRouter } from '../src/api/plugins';
import type { PluginManager } from '../src/api/plugins';
import { PluginApiError } from '../src/api/plugins-shared';
import { PluginEventBus } from '../src/plugin-events';

const SAMPLE: PluginManager = {
  getAllPlugins: () => [],
  getConfigSchemas: () => ({}),
  getLLMSchemas: () => ({}),
  getSearchSchemas: () => ({}),
  getAgentPlugins: () => [],
  getAgentTools: () => ({ catalog: [], enabled: [], explicit: [] }),
  getGlobalPlugins: () => [],
  getGlobalTools: () => ({ catalog: [], explicit: [] }),
  getAssembly: (agentId) => agentId === 'a'
    ? {
        agentId: 'a', presets: [], available: [],
        hooks: { order: {}, catalog: [] },
        tools: { include: [], exclude: [], enabled: [], catalog: [] },
      }
    : null,
  saveAssembly: (agentId, patch) => {
    if (patch.hooks && Object.keys(patch.hooks).includes('nope')) {
      throw new PluginApiError(400, 'hooks 含未知阶段 "nope"');
    }
    return {
      success: true,
      assembly: {
        agentId, presets: [], available: [],
        hooks: { order: patch.hooks ?? {}, catalog: [] },
        tools: {
          include: patch.tools?.include ?? [],
          exclude: patch.tools?.exclude ?? [],
          enabled: [],
          catalog: [],
        },
      },
    };
  },
  getCatalog: () => ({ plugins: [], hooks: [], tools: [] }),
  getLibrary: () => ({ installed: [], staging: [] }),
  stagePlugin: (dir) => ({
    id: 'x', manifest: { name: 'x', version: '1.0.0' }, sourceDir: dir,
    hash: 'abc', owner: 'admin', createdAt: new Date().toISOString(), requiredGrants: [],
  }),
  approvePlugin: async () => ({ name: 'x', version: '1.0.0', source: 'installed' }),
  rejectPlugin: () => ({ success: true }),
  uninstallPlugin: async () => ({ success: true }),
  getSessionPlugins: () => [],
  reloadSessionPlugin: async (name) => ({ status: 'replaced', name } as any),
  unloadSessionPlugin: async () => ({ success: true }),
  registerSessionPlugin: async (dir) => ({
    status: 'loaded' as const,
    plugin: { name: 'x', version: '1.0.0', source: 'session' as const, dir },
  }),
  getPermissions: () => ({
    vocabulary: ['fs', 'network', 'process', 'shell', 'ui'],
    defaultGranted: ['fs', 'network'],
    explicitRequired: ['process', 'shell', 'ui'],
  }),
  getStagingTree: () => ({ files: [{ path: 'index.mjs', size: 10 }] }),
  getStagingFile: (_id, rel) => ({ path: rel, content: 'export {}' }),
};

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

beforeEach(async () => {
  app = express();
  app.use(express.json());
  app.use('/api/plugins', createPluginsRouter(SAMPLE));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/plugins`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('/api/plugins 新契约路由', () => {
  it('GET /catalog、/permissions、/library、/staging/:id/tree 形状', async () => {
    expect((await (await fetch(`${baseUrl}/catalog`)).json())).toEqual({ plugins: [], hooks: [], tools: [] });
    const perms = await (await fetch(`${baseUrl}/permissions`)).json() as any;
    expect(perms.vocabulary).toContain('ui');
    expect(perms.explicitRequired).toContain('ui');
    expect((await (await fetch(`${baseUrl}/library`)).json())).toEqual({ installed: [], staging: [] });
    expect((await (await fetch(`${baseUrl}/staging/x/tree`)).json())).toEqual({ files: [{ path: 'index.mjs', size: 10 }] });
  });

  it('POST /session/register：dev 目录 → 会话级加载（P3）', async () => {
    const resp = await fetch(`${baseUrl}/session/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: 'C:/tmp/dev-demo', owner: 'admin' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.status).toBe('loaded');
    expect(body.plugin.source).toBe('session');
  });

  it('GET /assembly/:agentId 404 + PUT 保存成功/非法 hooks 400', async () => {
    expect((await fetch(`${baseUrl}/assembly/ghost`)).status).toBe(404);
    const put = await fetch(`${baseUrl}/assembly/a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: { include: ['t1'], exclude: ['t2'] },
        hooks: { runStart: ['h1'] },
      }),
    });
    expect(put.status).toBe(200);
    const saved = await put.json() as any;
    expect(saved.success).toBe(true);
    expect(saved.assembly.tools.include).toEqual(['t1']);
    expect(saved.assembly.tools.exclude).toEqual(['t2']);
    expect(saved.assembly.hooks.order.runStart).toEqual(['h1']);

    const bad = await fetch(`${baseUrl}/assembly/a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hooks: { nope: ['x'] } }),
    });
    expect(bad.status).toBe(400);
  });

  it('旧端点保留：GET /:agentId 扁平数组 + GET / 目录', async () => {
    expect((await (await fetch(`${baseUrl}/a`)).json() as any).plugins).toEqual([]);
    expect((await (await fetch(`${baseUrl}/`)).json() as any).plugins).toEqual([]);
  });
});

describe('PluginEventBus', () => {
  it('订阅/发射/dispose', () => {
    const bus = new PluginEventBus();
    const seen: string[] = [];
    const dispose = bus.on(PLUGIN_EVENT.CATALOG_CHANGED, (data) => seen.push(data.kind));
    bus.emitEvent(PLUGIN_EVENT.CATALOG_CHANGED, { kind: 'installed' });
    expect(seen).toEqual(['installed']);
    dispose();
    bus.emitEvent(PLUGIN_EVENT.CATALOG_CHANGED, { kind: 'staging' });
    expect(seen).toEqual(['installed']);
  });
});
