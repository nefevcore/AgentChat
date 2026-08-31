// ============================================================
// ac-agent-admin：管理面首期
// 真实件（agentStore/credentials/agents/tools/webServer）+ ws RPC 客户端；
// system-prompt dry-run 用假组装器验证 waterfall 过链。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { AgentStoreService } from 'ac-agent-store';
import { CredentialsService } from 'ac-credentials';
import { AgentsService } from 'ac-agents';
import { ToolsService } from 'ac-tools';
import {
  buildFrame,
  parseFrame,
  RPC_CALL,
  RPC_RESULT,
  WS_READY,
} from 'ac-ws-protocol';
import * as adminRow from '../src/index.ts';

interface Harness {
  ctx: Context;
  web: WebServerService;
  store: AgentStoreService;
  creds: CredentialsService;
  agents: AgentsService;
  root: string;
  port: number;
}

const harnesses: Array<{ web: WebServerService; ctx: Context }> = [];
const sockets: WebSocket[] = [];

async function boot(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ac-agent-admin-'));
  const ctx = new Context();
  const web = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  const store = new AgentStoreService(ctx, { root });
  const creds = new CredentialsService(ctx, { root });
  const agents = new AgentsService(ctx);
  const tools = new ToolsService(ctx);
  void tools;
  // 假组装器：system-prompt dry-run 的 waterfall 过链验证。
  // 与真实组装器（ac-persona/ac-system-prompt）同款"替换 call.request"
  // 变异姿势——干跑回读必须取载体 call.request；本地 request 别名在
  // 替换后仍是旧对象（P5 回归锚：预览曾因此恒空）。
  ctx.on('loop/before-run', (call, next) => {
    call.request = {
      ...call.request,
      system: `${call.request.system ?? ''}\n<dry-run-block>`.trimStart(),
    };
    return next();
  });
  await ctx.plugin(adminRow);
  const port = await web.ready();
  harnesses.push({ web, ctx });
  return { ctx, web, store, creds, agents, root, port };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      if (parseFrame(raw.toString())?.type === WS_READY) resolve(ws);
    });
  });
}

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }) => {
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

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

describe('ac-agent-admin CRUD', () => {
  it('create：白名单内落盘 + 凭据剥离 + reassign + agents/updated', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const updated: Array<{ id: string; change: string }> = [];
    h.ctx.on('agents/updated', (config, change) => updated.push({ id: config.id, change }));

    const r = await rpc(ws, 'agents/create', 'r1', {
      config: { id: 'bot1', model: 'glm-5.3', provider: 'glm', system: '你是测试', apiKey: 'sk-secret' },
    });
    expect(r.ok).toBe(true);
    const config = (r.result as { config: { id: string; model: string } }).config;
    expect(config).toMatchObject({ id: 'bot1', model: 'glm-5.3', system: '你是测试' });

    // config.json 无 apiKey；凭据已入 Agent 级存储
    const onDisk = JSON.parse(fs.readFileSync(join(h.root, 'agents', 'bot1', 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect('apiKey' in onDisk).toBe(false);
    expect(h.creds.get('bot1', 'glm')).toBe('sk-secret');

    // 注册表热生效 + 事件
    expect(h.agents.get('bot1')?.model).toBe('glm-5.3');
    expect(updated).toEqual([{ id: 'bot1', change: 'updated' }]);
  });

  it('update-config：局部补丁 deepMerge + 变更键报告；未变更不重写', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'agents/create', 'r1', { config: { id: 'bot2', model: 'm1', description: '旧' } });

    const r = await rpc(ws, 'agents/update-config', 'r2', {
      agentId: 'bot2',
      patch: { description: '新描述', maxSteps: 5 },
    });
    expect(r.ok).toBe(true);
    const result = r.result as { config: { model: string; description: string; maxSteps: number }; changed: string[] };
    expect(result.config.model).toBe('m1'); // 未携带键保留
    expect(result.config.description).toBe('新描述');
    expect(result.changed.sort()).toEqual(['description', 'maxSteps']);

    // 无变更补丁：changed 空、不发事件
    const events: string[] = [];
    h.ctx.on('agents/updated', (_c, change) => events.push(change));
    const r2 = await rpc(ws, 'agents/update-config', 'r3', { agentId: 'bot2', patch: { description: '新描述' } });
    expect((r2.result as { changed: string[] }).changed).toEqual([]);
    expect(events).toEqual([]);
  });

  it('白名单外键拒绝（GLOBAL_ONLY preview 形态）；缺 id 拒绝', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const bad = await rpc(ws, 'agents/create', 'r1', { config: { id: 'x', model: 'm', llmProviders: ['a'] } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('llmProviders');

    const noId = await rpc(ws, 'agents/create', 'r2', { config: { model: 'm' } });
    expect(noId.ok).toBe(false);
    expect(noId.error).toContain('id');

    const noModel = await rpc(ws, 'agents/create', 'r3', { config: { id: 'y' } });
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toContain('model');
  });

  it('delete：数据目录 + 注册表 + removed 事件', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'agents/create', 'r1', { config: { id: 'bye', model: 'm' } });
    const changes: string[] = [];
    h.ctx.on('agents/updated', (_c, change) => changes.push(change));

    const r = await rpc(ws, 'agents/delete', 'r2', { agentId: 'bye' });
    expect(r.result).toEqual({ removed: true });
    expect(fs.existsSync(join(h.root, 'agents', 'bye'))).toBe(false);
    expect(h.agents.has('bye')).toBe(false);
    expect(changes).toContain('removed');
  });
});

describe('ac-agent-admin 凭据 / 文档 / 预览', () => {
  it('set-credential（空串=删）+ save-doc/read-doc（空内容=删）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'agents/create', 'r1', { config: { id: 'a', model: 'm', provider: 'openai' } });

    await rpc(ws, 'agents/set-credential', 'r2', { agentId: 'a', provider: 'openai', value: 'sk-1' });
    expect(h.creds.get('a', 'openai')).toBe('sk-1');
    await rpc(ws, 'agents/set-credential', 'r3', { agentId: 'a', provider: 'openai', value: '' });
    expect(h.creds.get('a', 'openai')).toBe('');

    await rpc(ws, 'agents/save-doc', 'r4', { agentId: 'a', name: 'AGENT.md', content: '# 人设\n冷静' });
    const read = await rpc(ws, 'agents/read-doc', 'r5', { agentId: 'a', name: 'AGENT.md' });
    expect((read.result as { content: string }).content).toContain('冷静');

    await rpc(ws, 'agents/save-doc', 'r6', { agentId: 'a', name: 'AGENT.md', content: '  ' });
    expect(fs.existsSync(join(h.root, 'agents', 'a', 'AGENT.md'))).toBe(false);
  });

  it('system-prompt dry-run：before-run 组装器过链（无 run 副作用）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'agents/create', 'r1', { config: { id: 'a', model: 'm', system: '基础' } });
    const started: string[] = [];
    h.ctx.on('loop/run-started', () => started.push('run'));

    const r = await rpc(ws, 'agents/system-prompt', 'r2', { agentId: 'a' });
    expect(r.ok).toBe(true);
    const prompt = (r.result as { systemPrompt: string }).systemPrompt;
    expect(prompt).toContain('基础');
    expect(prompt).toContain('<dry-run-block>');
    expect(started).toEqual([]); // 干跑不发 run 事件
  });

  it('get-config：store 优先、回退注册表（行注册预设）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'preset', model: 'pm' }); // 无盘上档案的注册表 Agent
    const r = await rpc(ws, 'agents/get-config', 'r1', { agentId: 'preset' });
    expect((r.result as { config: { id: string } }).config.id).toBe('preset');

    const miss = await rpc(ws, 'agents/get-config', 'r2', { agentId: 'ghost' });
    expect(miss.ok).toBe(false);
  });

  it('目录布局：config.json 与文档住 <root>/agents/<id>/', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'agents/create', 'r1', { config: { id: 'layout', model: 'm' } });
    const dir = path.join(h.root, 'agents', 'layout');
    expect(fs.existsSync(join(dir, 'config.json'))).toBe(true);
  });

  it('agents/assembly：读装配视图（tools 意图/生效集 + settings + 插件目录）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.ctx.tools.register({ name: 't1', description: '工具1', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true, output: { a: 1 } }) });
    h.ctx.tools.register({ name: 't2', description: '工具2', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true, output: { b: 1 } }) });
    await rpc(ws, 'agents/create', 'r1', { config: { id: 'asm', model: 'm', tools: { include: ['t1'] }, settings: { persona: { enabled: true } } } });

    const r = await rpc(ws, 'agents/assembly', 'r2', { agentId: 'asm' });
    expect(r.ok).toBe(true);
    const assembly = (r.result as { assembly: Record<string, unknown> }).assembly;
    expect(assembly.agentId).toBe('asm');
    expect(assembly.plugins).toEqual([]); // pluginRegistry 未装载 → 空目录
    expect((assembly.settings as { enabled: string[] }).enabled).toEqual(['persona']);
    const tools = assembly.tools as { include: string[]; exclude: string[]; enabled: string[]; catalog: Array<{ name: string }> };
    expect(tools.include).toEqual(['t1']);
    expect(tools.enabled).toEqual(['t1']);
    expect(tools.catalog.map((t) => t.name).sort()).toEqual(['t1', 't2']);
  });

  it('agents/assembly/update：tools 写口 + settings per-name 合并/null 删除（M22 D5）+ 白名单 fail-closed', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'agents/create', 'r1', {
      config: {
        id: 'asm', model: 'm',
        settings: { persona: { enabled: true, text: '冷静' }, memory: { maxTokens: 800 } },
      },
    });

    const up = await rpc(ws, 'agents/assembly/update', 'r2', {
      agentId: 'asm',
      patch: { tools: { include: ['a'], exclude: ['b'] }, settings: { persona: { enabled: false }, memory: null, security: { capabilities: ['base', 'dev'] } } },
    });
    expect(up.ok).toBe(true);
    const saved = (up.result as { config: { tools: { include: string[]; exclude: string[] }; settings: Record<string, unknown> } }).config;
    expect(saved.tools).toEqual({ include: ['a'], exclude: ['b'] });
    // persona 浅合并：enabled 翻转、既有 text 保留
    expect(saved.settings.persona).toEqual({ enabled: false, text: '冷静' });
    // null = 删除该 name 配置（memory 消失）
    expect(saved.settings.memory).toBeUndefined();
    // 新 name 落配置
    expect(saved.settings.security).toEqual({ capabilities: ['base', 'dev'] });

    // settings 清空（全部 null）→ 字段删除
    const wipe = await rpc(ws, 'agents/assembly/update', 'r3', {
      agentId: 'asm',
      patch: { settings: { persona: null, security: null } },
    });
    expect(wipe.ok).toBe(true);
    const wiped = (wipe.result as { config: Record<string, unknown> }).config;
    expect(wiped.settings).toBeUndefined();

    // 非 object 非 null 的 settings 值 = fail-closed
    const badShape = await rpc(ws, 'agents/assembly/update', 'r4', {
      agentId: 'asm',
      patch: { settings: { persona: '文本' } },
    });
    expect(badShape.ok).toBe(false);

    const bad = await rpc(ws, 'agents/assembly/update', 'r5', { agentId: 'asm', patch: { presets: ['x'] } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('白名单');
  });
});
