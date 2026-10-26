// ============================================================
// 壳内插件开发行单测（cr-553）：三工具注册 + register 会话级装载全链
//（ctx.plugin 真装载 + 收束检测回执）+ unregister 两档。数据根恒
// sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, FiberStates, Service, type Fiber } from '@agentchat/cordis';
import { makePluginDevRow } from '../src/plugin-dev.ts';

const ROOT = path.resolve('sandbox', 'test-plugin-dev-' + process.pid);
const AGENT = 'creator-1';

/** tools 基座桩（本行 inject [tools]）——主线 ac-tools 最小面 */
interface ToolDef { name: string; description?: string; parameters?: unknown; execute?: (args: unknown) => Promise<unknown> }
class StubToolsService extends Service {
  readonly tools = new Map<string, ToolDef>();
  constructor(ctx: Context) { super(ctx, 'tools'); }
  register(tool: ToolDef) {
    this.tools.set(tool.name, tool);
    // 注册即归属（主线 ac-tools 语义）：注册方 fiber dispose 自动回收
    this.ctx.fiber.effect(() => () => {
      this.tools.delete(tool.name);
    }, 'tools.register(' + tool.name + ')');
  }
  list() { return [...this.tools.values()]; }
  execute(name: string, args: unknown) {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error('unknown tool: ' + name);
    return tool.execute!(args);
  }
}

/** ledger 桩（回执落账面——deliverRow 捕获） */
class StubLedger extends Service {
  readonly rows: Array<{ uuid: string; content: string }> = [];
  constructor(ctx: Context) { super(ctx, 'ledger'); }
  async deliverRow(uuid: string, _participants: string[], _kind: string, row: { content: string }) {
    this.rows.push({ uuid, content: row.content });
  }
}

/** 入口替身注册表（目录名 → Plugin——importModule 注入面消费；主线 registry 测试同形） */
const modules = new Map<string, unknown>();

/** 测试替身插件（cordis Plugin 形态——apply 注册一个工具） */
function stubPlugin(name: string) {
  return {
    name: name + '-plugin',
    inject: ['tools'],
    apply(ctx: Context) {
      (ctx as unknown as { tools: StubToolsService }).tools.register({
        name: name + '_tool',
        description: 'dev tool',
        parameters: { type: 'object' as const, properties: {} },
        execute: async () => ({ ok: true, output: { from: 'plugin' } }),
      });
    },
  };
}

async function boot() {
  const ctx = new Context();
  const toolsFiber = ctx.plugin(class extends StubToolsService { constructor(c: Context) { super(c); } });
  await toolsFiber;
  const ledgerFiber = ctx.plugin(class extends StubLedger { constructor(c: Context) { super(c); } });
  await ledgerFiber;
  const fiber = ctx.plugin(makePluginDevRow({
    dataRoot: ROOT,
    agentId: AGENT,
    importModule: async (url) => {
      // key = 插件目录名（URL 路径倒数第二段——与主线 registry 测试同口径）
      const key = new URL(url).pathname.split('/').slice(-2)[0];
      const mod = modules.get(key);
      if (mod === undefined) throw new Error('替身缺席：' + key);
      return mod;
    },
  }));
  await fiber;
  expect(fiber.state).toBe(FiberStates.ACTIVE);
  return {
    ctx,
    tools: (ctx as unknown as { tools: StubToolsService }).tools,
    ledger: (ctx as unknown as { ledger: StubLedger }).ledger,
    fibers: [fiber, ledgerFiber, toolsFiber] as Fiber[],
    async dispose() {
      for (const f of [fiber, ledgerFiber, toolsFiber]) if (f.uid !== null) await f.dispose();
    },
  };
}

/** 造可装载插件目录（manifest）+ 替身注册 */
function makePluginDir(name: string): string {
  const dir = path.join(ROOT, 'files', AGENT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name,
    version: '1.0.0',
    entry: 'index.ts',
    permissions: ['fs'],
    rows: [{ id: name + '-row', tools: [name + '_tool'] }],
  }, null, 2) + '\n', 'utf-8');
  modules.set(name, stubPlugin(name));
  return dir;
}

/** 触发收束检测（模拟 loop/after-run 事件——finish=interrupted + toolInterrupt） */
function emitInterrupt(ctx: Context, ti: Record<string, unknown>): void {
  void ctx.emit('loop/after-run',
    { agent: AGENT, conversationId: 'user~' + AGENT } as never,
    { finish: 'interrupted', interruptReason: { type: 'tool-interrupt', toolInterrupt: ti } } as never);
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('壳内插件开发行（cr-553）', () => {
  it('三工具在册（register/install/unregister_plugin）', async () => {
    const h = await boot();
    expect([...h.tools.tools.keys()].sort()).toContain('install_plugin');
    expect([...h.tools.tools.keys()]).toContain('register_plugin');
    expect([...h.tools.tools.keys()]).toContain('unregister_plugin');
    await h.dispose();
  });

  it('工具上报意图不执行（interrupt 载荷——M11 语义化中断）', async () => {
    const h = await boot();
    const out = await h.tools.execute('register_plugin', { dir: 'dev-hello' }) as { ok: boolean; interrupt?: { type: string; dir?: string } };
    expect(out.ok).toBe(true);
    expect(out.interrupt?.type).toBe('register-plugin');
    expect(out.interrupt?.dir).toBe('dev-hello');
    await h.dispose();
  });

  it('register 消费：会话级装载全链——插件工具真注册 + 回执落账', async () => {
    const h = await boot();
    makePluginDir('dev-hello');
    emitInterrupt(h.ctx, { type: 'register-plugin', dir: 'dev-hello' });
    await new Promise((r) => setTimeout(r, 500)); // 收束检测异步链（含 dynamic import）
    expect([...h.tools.tools.keys()]).toContain('dev-hello_tool');
    const receipt = h.ledger.rows.at(-1);
    expect(receipt?.content).toContain('已装载 dev-hello');
    expect(receipt?.uuid).toBe('user~' + AGENT);
    await h.dispose();
  });

  it('register 失败线：manifest 缺席 → 修复方向回执', async () => {
    const h = await boot();
    emitInterrupt(h.ctx, { type: 'register-plugin', dir: 'no-such' });
    await new Promise((r) => setTimeout(r, 500));
    const receipt = h.ledger.rows.at(-1);
    expect(receipt?.content).toContain('装载失败');
    expect(receipt?.content).toContain('manifest');
    await h.dispose();
  });

  it('unregister 缺省档：仅卸会话级装载（插件工具摘除）', async () => {
    const h = await boot();
    makePluginDir('dev-hello');
    emitInterrupt(h.ctx, { type: 'register-plugin', dir: 'dev-hello' });
    await new Promise((r) => setTimeout(r, 500));
    expect([...h.tools.tools.keys()]).toContain('dev-hello_tool');
    emitInterrupt(h.ctx, { type: 'unregister-plugin', name: 'dev-hello' });
    await new Promise((r) => setTimeout(r, 500));
    expect([...h.tools.tools.keys()]).not.toContain('dev-hello_tool');
    const receipt = h.ledger.rows.at(-1);
    expect(receipt?.content).toContain('已卸载 dev-hello');
    await h.dispose();
  });

  it('unregister 缺省档未装载线：无需卸载回执', async () => {
    const h = await boot();
    emitInterrupt(h.ctx, { type: 'unregister-plugin', name: 'ghost' });
    await new Promise((r) => setTimeout(r, 500));
    const receipt = h.ledger.rows.at(-1);
    expect(receipt?.content).toContain('未在会话级装载中');
    await h.dispose();
  });

  it('install 消费（无邮局形态）：CLI 直连 fail-loud 回执', async () => {
    const h = await boot();
    emitInterrupt(h.ctx, { type: 'install-plugin', dir: 'dev-hello' });
    await new Promise((r) => setTimeout(r, 500));
    const receipt = h.ledger.rows.at(-1);
    expect(receipt?.content).toContain('无邮局连接');
    await h.dispose();
  });
});
