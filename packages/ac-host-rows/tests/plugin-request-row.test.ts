// ============================================================
// 装卸请求信受理面单测（cr-553）：HostInbox 收信 → installFromDir
// 免审三态 / uninstall 永久卸载 → 回执信 + 续跑信投递。数据根恒
// sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, FiberStates, Service, type Fiber } from '@agentchat/cordis';
import { makePluginRegistryRow, PluginRegistryHostService, HostInbox } from '../src/index.ts';
import { readPluginRows } from 'ac-rowset-core';
import type { Envelope } from 'ac-envelope-core';
import { isPluginRequest, makePluginRequestEnvelope, makePluginReceiptEnvelope } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-plugin-req-' + process.pid);
const SRC = path.join('sandbox', 'test-plugin-req-src-' + process.pid);

function writeCatalog(root: string): string {
  const file = path.join(root, 'row-catalog.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    rows: [
      { id: 'backup', tree: 'host', role: '数据轴备份' },
    ],
  }, null, 2) + '\n', 'utf-8');
  return file;
}

function makePluginDir(name: string, rows: unknown[] = []): string {
  const dir = path.resolve(SRC, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name,
    version: '1.0.0',
    entry: 'index.ts',
    permissions: ['fs'],
    rows,
  }, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export function apply(): void { /* demo */ }\n', 'utf-8');
  return dir;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(SRC, { recursive: true });
  writeCatalog(ROOT);
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
});

interface RpcHandler { (params?: unknown, caller?: unknown): unknown; }

class StubWebServer extends Service {
  readonly handlers = new Map<string, RpcHandler>();
  constructor(ctx: Context) { super(ctx, 'webServer'); }
  registerRpc(method: string, handler: RpcHandler) {
    this.handlers.set(method, handler);
  }
  broadcast(): void { /* 本面不断言帧 */ }
}

/** 邮局桩：只捕获 dispatch（受理面回执/续跑投递面） */
class StubPostOffice {
  readonly dispatched: Envelope[] = [];
  async dispatch(env: Envelope): Promise<{ to: string }> {
    this.dispatched.push(env);
    return { to: env.to };
  }
}

async function boot(po: StubPostOffice) {
  const ctx = new Context();
  const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
  await webFiber;
  let receiver: ((e: Envelope) => Promise<{ ack: string; fresh: boolean }>) | null = null;
  const inbox = new HostInbox({
    registerLocal(_id, r) { receiver = r; },
  });
  const fiber = ctx.plugin(makePluginRegistryRow({
    dataRoot: ROOT,
    catalogFile: path.join(ROOT, 'row-catalog.json'),
    inbox,
    postOffice: po,
  }));
  await fiber;
  expect(fiber.state).toBe(FiberStates.ACTIVE);
  inbox.start();
  const deliver = (e: Envelope) => (receiver as (e: Envelope) => Promise<{ ack: string; fresh: boolean }>)(e);
  return {
    deliver,
    po,
    registry: (ctx as unknown as { pluginRegistry: PluginRegistryHostService }).pluginRegistry,
    fibers: [fiber, webFiber] as Fiber[],
    async dispose() {
      for (const f of [fiber, webFiber]) if (f.uid !== null) await f.dispose();
    },
  };
}

describe('装卸请求信受理面（cr-553）', () => {
  it('install：免审安装全链——安装态写入 + plugin-rows.json 物化 + 回执 + 续跑信', async () => {
    const dir = makePluginDir('dev-hello', [{ id: 'dev-hello-row', tools: ['dev_hello'] }]);
    const po = new StubPostOffice();
    const h = await boot(po);
    // 发起方沙箱形态：files/<agentId>/ 下相对目录（宿主受理面按此基准解析）
    const sandboxDir = path.join(ROOT, 'files', 'creator-1', 'dev-hello');
    fs.mkdirSync(path.dirname(sandboxDir), { recursive: true });
    fs.cpSync(dir, sandboxDir, { recursive: true });
    const env = makePluginRequestEnvelope({
      uuid: 'user~creator-1',
      requestId: 'plugin-r1',
      sender: 'creator-1',
      payload: { action: 'install', dir: 'dev-hello', conversationId: 'user~creator-1' },
    });
    expect(isPluginRequest(env)).toBe(true);
    // 经 inbox 收信面投递（handler 串行面真实跑）
    await h.deliver(env);
    // 安装态 + 行集物化
    expect(h.registry.listInstalled().map((r) => r.manifest.name)).toContain('dev-hello');
    expect(readPluginRows(ROOT).map((r) => r.id)).toContain('dev-hello-row');
    // 两信：回执（receipt）+ 续跑（message）
    expect(po.dispatched).toHaveLength(2);
    const [receipt, retrigger] = po.dispatched;
    expect(receipt.kind).toBe('receipt');
    expect(receipt.requestId).toBe('plugin-r1');
    expect((receipt.payload as { subject: string }).subject).toBe('plugin-installed');
    expect(retrigger.kind).toBe('message');
    expect(retrigger.requestId).toBe('retrigger-plugin-r1');
    expect(retrigger.to).toBe('creator-1');
    expect((retrigger.payload as { text: string }).text).toContain('dev-hello');
    await h.dispose();
  });

  it('install 幂等：同 name+version 同内容 → idempotent 回执不重装', async () => {
    const dir = makePluginDir('dev-hello', [{ id: 'dev-hello-row', tools: ['dev_hello'] }]);
    const po = new StubPostOffice();
    const h = await boot(po);
    const env1 = makePluginRequestEnvelope({
      uuid: 'user~creator-1', requestId: 'plugin-r1', sender: 'creator-1',
      payload: { action: 'install', dir, conversationId: 'user~creator-1' },
    });
    await h.deliver(env1);
    po.dispatched.length = 0;
    const env2 = makePluginRequestEnvelope({
      uuid: 'user~creator-1', requestId: 'plugin-r2', sender: 'creator-1',
      payload: { action: 'install', dir, conversationId: 'user~creator-1' },
    });
    await h.deliver(env2);
    const receipt = po.dispatched.find((e) => e.kind === 'receipt')!;
    expect((receipt.payload as { idempotent?: boolean }).idempotent).toBe(true);
    expect((receipt.payload as { subject: string }).subject).toBe('plugin-installed');
    await h.dispose();
  });

  it('install 拒收线：manifest 缺席 → rejected 回执 + 续跑含修复方向', async () => {
    const po = new StubPostOffice();
    const h = await boot(po);
    const env = makePluginRequestEnvelope({
      uuid: 'user~creator-1', requestId: 'plugin-r1', sender: 'creator-1',
      payload: { action: 'install', dir: path.join(SRC, 'no-such'), conversationId: 'user~creator-1' },
    });
    await h.deliver(env);
    const receipt = po.dispatched.find((e) => e.kind === 'receipt')!;
    expect((receipt.payload as { subject: string }).subject).toBe('plugin-rejected');
    expect((receipt.payload as { ok: boolean }).ok).toBe(false);
    const retrigger = po.dispatched.find((e) => e.kind === 'message')!;
    expect((retrigger.payload as { text: string }).text).toContain('未完成');
    await h.dispose();
  });

  it('uninstall：永久卸载——行集条目剔除 + backupDir 回执', async () => {
    const dir = makePluginDir('dev-hello', [{ id: 'dev-hello-row', tools: ['dev_hello'] }]);
    const po = new StubPostOffice();
    const h = await boot(po);
    await h.registry.installFromDir(dir, 'creator-1');
    expect(readPluginRows(ROOT).map((r) => r.id)).toContain('dev-hello-row');
    po.dispatched.length = 0;
    const env = makePluginRequestEnvelope({
      uuid: 'user~creator-1', requestId: 'plugin-r3', sender: 'creator-1',
      payload: { action: 'uninstall', name: 'dev-hello', conversationId: 'user~creator-1' },
    });
    await h.deliver(env);
    expect(h.registry.listInstalled().map((r) => r.manifest.name)).not.toContain('dev-hello');
    expect(readPluginRows(ROOT).map((r) => r.id)).not.toContain('dev-hello-row');
    const receipt = po.dispatched.find((e) => e.kind === 'receipt')!;
    expect((receipt.payload as { subject: string }).subject).toBe('plugin-uninstalled');
    expect((receipt.payload as { backupDir?: string }).backupDir).toBeDefined();
    await h.dispose();
  });

  it('非本域信直过（grant/usage 信不触发装卸面）', async () => {
    const po = new StubPostOffice();
    const h = await boot(po);
    await h.deliver({
      uuid: 'u~a', requestId: 'x', sender: 'a', to: 'host', kind: 'receipt', budget: 0,
      payload: { subject: 'grant-applied', agent: 'a', ok: true, newFingerprint: 'f' },
    } satisfies Envelope);
    expect(po.dispatched).toHaveLength(0);
    await h.dispose();
  });
});

// 收信驱动面：boot 桩捕获 receiver（registerLocal），用例经 h.deliver(env) 直投。
