// ============================================================
// agent-admin 行测试（cr-542）：写侧 RPC 编排面——六方法在册 + 写口单源
//（落盘经 agents 编辑面；本行零落盘）。webServer 用捕获桩（不占端口）。
// 数据根恒 preview/sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Context, FiberStates, Service, type Fiber } from '@agentchat/cordis';
import { makeAgentAdminRow } from '../src/agent-admin-row.ts';
import { makeAgentsHostRow } from '../src/agents-row.ts';

const ROOT = path.resolve(__dirname, '../../../sandbox/agent-admin-row-test');

interface RpcHandler {
  (params?: unknown, caller?: unknown): unknown;
}

/** 路由处理器收到的最小 call 面（ac-web-server RouteCall 结构子集） */
export interface StubRouteCall {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body?: unknown;
  req: { headers: Record<string, string | undefined> };
  res: CapturedRes;
}

/** 路由捕获桩的应答收集：handler 直写 call.res（writeHead/end 捕获） */
interface CapturedRes {
  statusCode: number;
  headers: Record<string, string | undefined>;
  chunks: Buffer[];
  writeHead(status: number, headers?: Record<string, string | undefined>): CapturedRes;
  end(chunk?: Buffer | string): CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      res.statusCode = status;
      if (headers !== undefined) Object.assign(res.headers, headers);
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return res;
    },
  };
  return res;
}

/** webServer 捕获桩：registerRpc + route 契约面 */
type RouteHandler = (call: StubRouteCall) => void;

class StubWebServer extends Service {
  readonly handlers = new Map<string, RpcHandler>();
  readonly routes = new Map<string, RouteHandler>();
  constructor(ctx: Context) {
    super(ctx, 'webServer');
  }
  registerRpc(method: string, handler: RpcHandler) {
    if (this.handlers.has(method)) throw new Error('rpc 已注册: ' + method);
    this.handlers.set(method, handler);
    return this.ctx.fiber.effect(() => {
      this.handlers.set(method, handler);
      return () => { this.handlers.delete(method); };
    }, 'webServer.rpc(' + method + ')');
  }
  route(method: string, pattern: string, handler: RouteHandler) {
    this.routes.set(method + ' ' + pattern, handler);
    return this.ctx.fiber.effect(() => {
      this.routes.set(method + ' ' + pattern, handler);
      return () => { this.routes.delete(method + ' ' + pattern); };
    }, 'webServer.route(' + method + ' ' + pattern + ')');
  }
  replyJson(res: CapturedRes, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  /** 路由调用捷径：真 handler + 捕获应答 */
  callRoute(method: string, pattern: string, init: Partial<StubRouteCall> = {}): { res: CapturedRes; json: () => unknown; body: () => Buffer } {
    const handler = this.routes.get(method + ' ' + pattern);
    if (handler === undefined) throw new Error('route 未注册: ' + method + ' ' + pattern);
    const call: StubRouteCall = {
      method, path: pattern, query: new URLSearchParams(), params: {}, req: { headers: {} }, res: makeRes(), ...init,
    };
    handler(call);
    return { res: call.res, json: () => JSON.parse(call.res.chunks[0]?.toString('utf-8') ?? 'null'), body: () => call.res.chunks[0] ?? Buffer.alloc(0) };
  }
  async call(method: string, params?: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error('unknown method: ' + method);
    return handler(params, {});
  }
}

let fibers: Fiber[] = [];
let web: StubWebServer | null = null;
afterAll(async () => {
  for (const fiber of [...fibers].reverse()) if (fiber.uid !== null) await fiber.dispose();
  fibers = [];
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 预览面捕获桩（cr-552）：记录控制帧往返请求 */
const previewCalls: Array<{ agentId: string; conversationId?: string; what: string }> = [];
function stubPreview(systemPrompt = '预览结果') {
  return {
    systemPrompt: (agentId: string, conversationId?: string) => {
      previewCalls.push({ agentId, conversationId, what: 'system-prompt' });
      return Promise.resolve(systemPrompt);
    },
    assemblyTools: (agentId: string) => {
      previewCalls.push({ agentId, what: 'assembly-tools' });
      return Promise.resolve({ tools: [{ name: 'math', description: '算', parameters: {}, owner: 'math-row' }], enabled: ['math'] });
    },
  };
}

async function boot(options?: { adminPreview?: boolean }): Promise<{ web: StubWebServer; ctx: Context }> {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const ctx = new Context();
  // 桩先装（agent-admin inject ['webServer','agents']——两服务就位后本行才激活）
  const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
  await webFiber;
  fibers.push(webFiber);
  const agentsFiber = ctx.plugin(makeAgentsHostRow({ dataRoot: ROOT }));
  await agentsFiber;
  fibers.push(agentsFiber);
  const adminFiber = ctx.plugin(makeAgentAdminRow(
    options?.adminPreview === true ? { adminPreview: stubPreview() } : {},
  ));
  await adminFiber;
  fibers.push(adminFiber);
  expect(adminFiber.state).toBe(FiberStates.ACTIVE);
  web = (ctx as unknown as { webServer: StubWebServer }).webServer;
  return { web, ctx };
}

describe('agent-admin 行（写侧 RPC 编排）', () => {
  it('九方法在册（CRUD 六 + 装配面三——cr-552 收口）', async () => {
    const { web } = await boot();
    expect([...web.handlers.keys()].sort()).toEqual([
      'agents/assembly', 'agents/assembly/update', 'agents/create', 'agents/delete',
      'agents/get-config', 'agents/read-doc', 'agents/save-doc',
      'agents/system-prompt', 'agents/update-config',
    ]);
  });

  it('create → get-config → update → delete 全链（落盘经编辑面单源）', async () => {
    const { web } = await boot();
    const created = await web.call('agents/create', {
      config: { name: 'Admin Row', model: 'mock@deepseek-chat', tags: ['full-access'] },
    }) as { config: { id: string; model: string; provider: string } };
    expect(created.config).toMatchObject({ id: 'admin-row', model: 'deepseek-chat', provider: 'mock' });
    const file = path.join(ROOT, 'agents', 'admin-row', 'config.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).id).toBe('admin-row');

    const read = await web.call('agents/get-config', { agentId: 'admin-row' }) as { config: { id: string } };
    expect(read.config.id).toBe('admin-row');

    const updated = await web.call('agents/update-config', {
      agentId: 'admin-row',
      patch: { description: '改过', model: '' },
    }) as { config: Record<string, unknown>; changed: string[] };
    expect(updated.changed.sort()).toEqual(['description', 'model']);
    expect('model' in updated.config).toBe(false); // 清除词形 = 删键
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).model).toBeUndefined();

    const removed = await web.call('agents/delete', { agentId: 'admin-row' }) as { removed: boolean };
    expect(removed.removed).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'agents', 'admin-row'))).toBe(false);
  });

  it('零变更不落盘（文件 mtime 不动）', async () => {
    const { web } = await boot();
    await web.call('agents/create', { config: { id: 'same', name: '同名' } });
    const file = path.join(ROOT, 'agents', 'same', 'config.json');
    const before = fs.statSync(file).mtimeMs;
    const result = await web.call('agents/update-config', { agentId: 'same', patch: { name: '同名' } }) as { changed: string[] };
    expect(result.changed).toEqual([]);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('文档写口：空内容 = 删；未知身份 fail-loud', async () => {
    const { web } = await boot();
    await web.call('agents/create', { config: { id: 'doc' } });
    await web.call('agents/save-doc', { agentId: 'doc', name: 'AGENT.md', content: '# 身份' });
    const file = path.join(ROOT, 'agents', 'doc', 'AGENT.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe('# 身份\n'); // 尾换行归一
    await web.call('agents/save-doc', { agentId: 'doc', name: 'AGENT.md', content: '  ' });
    expect(fs.existsSync(file)).toBe(false);
    await expect(web.call('agents/get-config', { agentId: 'ghost' })).rejects.toThrow(/unknown agent/);
    await expect(web.call('agents/save-doc', { agentId: 'doc' })).rejects.toThrow(/name/);
  });
});

describe('agent-admin 装配面（cr-552 跨进程 dry-run 编排）', () => {
  it('system-prompt：预览面经控制帧往返（桩捕获）+ conversationId 透传', async () => {
    const { web } = await boot({ adminPreview: true });
    await web.call('agents/create', { config: { id: 'prev' } });
    const r = await web.call('agents/system-prompt', { agentId: 'prev', conversationId: 'sid-1' }) as { systemPrompt: string };
    expect(r.systemPrompt).toBe('预览结果');
    expect(previewCalls.at(-1)).toMatchObject({ agentId: 'prev', conversationId: 'sid-1', what: 'system-prompt' });
    // 未知身份先验（不触预览面）
    await expect(web.call('agents/system-prompt', { agentId: 'ghost' })).rejects.toThrow(/unknown agent/);
  });

  it('预览面缺席 = fail-loud（编排面未接线——良定义降级）', async () => {
    const { web } = await boot();
    await web.call('agents/create', { config: { id: 'p2' } });
    await expect(web.call('agents/system-prompt', { agentId: 'p2' })).rejects.toThrow(/预览面缺席/);
    await expect(web.call('agents/assembly', { agentId: 'p2' })).rejects.toThrow(/预览面缺席/);
  });

  it('assembly：视图合成（壳目录 + settings 直读 + plugins 空目录）', async () => {
    const { web } = await boot({ adminPreview: true });
    await web.call('agents/create', { config: { id: 'asm', rows: { include: ['math'] }, settings: { persona: { enabled: true } } } });
    const r = await web.call('agents/assembly', { agentId: 'asm' }) as { assembly: Record<string, unknown> };
    expect(r.assembly.settings).toEqual({ enabled: ['persona'], configs: { persona: { enabled: true } } });
    expect(r.assembly.plugins).toEqual([]); // pluginRegistry 行不在集 = 空目录
    const tools = r.assembly.tools as { enabled: string[]; catalog: Array<{ name: string }> };
    expect(tools.enabled).toEqual(['math']);
    expect(tools.catalog.map((t) => t.name)).toEqual(['math']);
  });

  it('assembly/update：tools 意图 + settings per-name 合并 + 零变更不落盘', async () => {
    const { web } = await boot({ adminPreview: true });
    await web.call('agents/create', { config: { id: 'w', settings: { persona: { enabled: true, maxTokens: 9 } } } });
    const up = await web.call('agents/assembly/update', {
      agentId: 'w',
      patch: { rows: { include: ['math', 'fs'] }, settings: { persona: { enabled: false } } },
    }) as { changed: string[] };
    expect(up.changed.sort()).toEqual(['rows', 'settings']);
    const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'w', 'config.json'), 'utf-8'));
    expect(after.rows).toEqual({ include: ['math', 'fs'] });
    expect(after.settings.persona).toEqual({ enabled: false, maxTokens: 9 }); // 浅合并保字段
    // 零变更不落盘
    const file = path.join(ROOT, 'agents', 'w', 'config.json');
    const before = fs.statSync(file).mtimeMs;
    const zero = await web.call('agents/assembly/update', { agentId: 'w', patch: { settings: { persona: { enabled: false } } } }) as { changed: string[] };
    expect(zero.changed).toEqual([]);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    // 白名单 fail-closed
    await expect(web.call('agents/assembly/update', { agentId: 'w', patch: { presets: ['x'] } })).rejects.toThrow(/白名单/);
  });
});

describe('Agent 头像 HTTP 面（cr-588：上传/删除/静态读——主线三路由同形）', () => {
  it('POST 上传（multipart file → avatar.png + version 回显）→ GET ?v immutable / 无 v ETag 304 → DELETE', async () => {
    const { web } = await boot();
    await web.call('agents/create', { config: { id: 'face' } });

    // 无头像 → 404；POST 缺 multipart file → 400
    expect(web.callRoute('GET', '/api/agents/:agentId/avatar', { params: { agentId: 'face' } }).res.statusCode).toBe(404);
    expect(web.callRoute('POST', '/api/agents/:agentId/avatar', { params: { agentId: 'face' }, body: {} }).res.statusCode).toBe(400);

    // 上传：data 落盘 avatar.png + version（size:mtimeMs）回显
    const png = Buffer.from('<png-bytes>');
    const up = web.callRoute('POST', '/api/agents/:agentId/avatar', {
      params: { agentId: 'face' },
      body: { files: { file: { filename: '头像.PNG', contentType: 'image/png', data: png } } },
    });
    expect(up.res.statusCode).toBe(200);
    const version = (up.json() as { success: boolean; version: string }).version;
    expect(version).toMatch(/^\d+:\d+$/);
    expect(fs.readFileSync(path.join(ROOT, 'agents', 'face', 'avatar.png'))).toEqual(png); // 扩展名归一小写

    // GET ?v=version：immutable 长缓存 + 原字节
    const imm = web.callRoute('GET', '/api/agents/:agentId/avatar', {
      params: { agentId: 'face' }, query: new URLSearchParams({ v: version }),
    });
    expect(imm.res.statusCode).toBe(200);
    expect(imm.res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(imm.res.headers['content-type']).toBe('image/png');
    expect(imm.body()).toEqual(png);

    // GET 无 v：ETag 验证命中 → 304 零字节（etag 取自首次无 v 应答）
    const first = web.callRoute('GET', '/api/agents/:agentId/avatar', { params: { agentId: 'face' } });
    expect(first.res.statusCode).toBe(200);
    expect(first.res.headers['cache-control']).toBe('no-cache');
    const revalid = web.callRoute('GET', '/api/agents/:agentId/avatar', {
      params: { agentId: 'face' }, req: { headers: { 'if-none-match': String(first.res.headers.etag) } },
    });
    expect(revalid.res.statusCode).toBe(304);

    // DELETE → deleted；再 GET → 404
    expect((web.callRoute('DELETE', '/api/agents/:agentId/avatar', { params: { agentId: 'face' } }).json() as { deleted: boolean }).deleted).toBe(true);
    expect(web.callRoute('GET', '/api/agents/:agentId/avatar', { params: { agentId: 'face' } }).res.statusCode).toBe(404);
  });
});
