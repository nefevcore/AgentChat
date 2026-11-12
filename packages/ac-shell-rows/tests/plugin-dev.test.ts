// ============================================================
// 壳内插件开发行单测（cr-553；cr-866 即时执行形态）：三工具注册 +
// register 会话级装载全链（ctx.plugin 真装载 + 装载即时生效）+
// unregister 两档。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, FiberStates, Service, type Fiber } from '@agentchat/cordis';
import { makePluginDevRow } from '../src/plugin-dev.ts';

const ROOT = path.resolve('sandbox', 'test-plugin-dev-' + process.pid);
const AGENT = 'creator-1';

/** tools 基座桩（本行 inject [tools]）——主线 ac-tools 最小面
 * （cr-1022 批2：listWithOwner 归属面——注册方 fiber 名即 owner） */
interface ToolDef { name: string; description?: string; parameters?: unknown; execute?: (args: unknown, call?: unknown) => Promise<unknown> }
class StubToolsService extends Service {
  readonly tools = new Map<string, ToolDef & { owner: string }>();
  constructor(ctx: Context) { super(ctx, 'tools'); }
  register(tool: ToolDef) {
    this.tools.set(tool.name, { ...tool, owner: this.ctx.fiber.name });
    // 注册即归属（主线 ac-tools 语义）：注册方 fiber dispose 自动回收
    this.ctx.fiber.effect(() => () => {
      this.tools.delete(tool.name);
    }, 'tools.register(' + tool.name + ')');
  }
  list() { return [...this.tools.values()]; }
  listWithOwner() { return this.list(); }
  execute(name: string, args: unknown) {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error('unknown tool: ' + name);
    return tool.execute!(args, { toolCallId: 'tc-' + name });
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
    fibers: [fiber, toolsFiber] as Fiber[],
    async dispose() {
      for (const f of [fiber, toolsFiber]) if (f.uid !== null) await f.dispose();
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

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('壳内插件开发行（cr-553 / cr-866 即时执行）', () => {
  it('三工具在册（register/install/unregister_plugin）', async () => {
    const h = await boot();
    expect([...h.tools.tools.keys()].sort()).toContain('install_plugin');
    expect([...h.tools.tools.keys()]).toContain('register_plugin');
    expect([...h.tools.tools.keys()]).toContain('unregister_plugin');
    await h.dispose();
  });

  it('register 即时装载：execute 返回时工具已在注册面、可直接调用', async () => {
    const h = await boot();
    makePluginDir('dev-hello');
    const out = await h.tools.execute('register_plugin', { dir: 'dev-hello' }) as {
      ok: boolean; output?: { loaded?: string; tools?: string[] };
    };
    expect(out.ok).toBe(true);
    expect(out.output?.loaded).toBe('dev-hello');
    expect(out.output?.tools).toContain('dev-hello_tool');
    // 装载即时性：同轮即可调用插件工具
    expect([...h.tools.tools.keys()]).toContain('dev-hello_tool');
    const r = await h.tools.execute('dev-hello_tool', {}) as { ok: boolean; output?: { from?: string } };
    expect(r.output?.from).toBe('plugin');
    await h.dispose();
  });

  it('register 幂等：同名已装载 → 幂等返回不重载', async () => {
    const h = await boot();
    makePluginDir('dev-hello');
    await h.tools.execute('register_plugin', { dir: 'dev-hello' });
    const again = await h.tools.execute('register_plugin', { dir: 'dev-hello' }) as { ok: boolean; output?: { loaded?: string } };
    expect(again.ok).toBe(true);
    expect(again.output?.loaded).toBe('dev-hello');
    await h.dispose();
  });

  it('register 失败线：目录缺席 → ok:false 带修复方向', async () => {
    const h = await boot();
    const out = await h.tools.execute('register_plugin', { dir: 'no-such' }) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('装载失败');
    expect(out.error).toContain('manifest');
    await h.dispose();
  });

  it('unregister 缺省档：立即卸会话级装载（插件工具即刻摘除）', async () => {
    const h = await boot();
    makePluginDir('dev-hello');
    await h.tools.execute('register_plugin', { dir: 'dev-hello' });
    expect([...h.tools.tools.keys()]).toContain('dev-hello_tool');
    const out = await h.tools.execute('unregister_plugin', { name: 'dev-hello' }) as { ok: boolean; output?: { unloaded?: boolean } };
    expect(out.output?.unloaded).toBe(true);
    expect([...h.tools.tools.keys()]).not.toContain('dev-hello_tool');
    await h.dispose();
  });

  it('unregister 缺省档未装载线：unloaded:false 提示', async () => {
    const h = await boot();
    const out = await h.tools.execute('unregister_plugin', { name: 'ghost' }) as { ok: boolean; output?: { unloaded?: boolean; note?: string } };
    expect(out.output?.unloaded).toBe(false);
    expect(out.output?.note).toContain('未在会话级装载中');
    await h.dispose();
  });

  it('install 无邮局形态：CLI 直连 fail-loud', async () => {
    const h = await boot();
    makePluginDir('dev-hello');
    const out = await h.tools.execute('install_plugin', { dir: 'dev-hello' }) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('无邮局连接');
    await h.dispose();
  });
});
