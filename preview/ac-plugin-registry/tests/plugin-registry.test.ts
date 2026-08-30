// ============================================================
// ac-plugin-registry：装载管道（before-load waterfall/gates/回滚）
// + plugin/* 事件 + register_plugin/unregister_plugin 工具（中断通道）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as registryRow from '../src/index.ts';
import * as gatesRow from 'ac-plugin-gates';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** 测试插件模块（假 import：注入 importModule） */
function makeTestPlugin(store: Map<string, number>, name: string) {
  return {
    name,
    apply(ctx: Context) {
      store.set(name, (store.get(name) ?? 0) + 1);
      ctx.tools.register({
        name: `${name}-tool`,
        execute: () => ({ ok: true, output: `from ${name}` }),
      });
    },
  };
}

async function boot(root: string, options: { gates?: boolean; importModule?: (url: string) => Promise<unknown> } = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const f1 = ctx.plugin(toolsRow as any);
  await f1;
  fibers.push(f1);
  const f2 = ctx.plugin(registryRow as any, {
    root,
    ...(options.importModule ? { importModule: options.importModule } : {}),
  });
  await f2;
  fibers.push(f2);
  if (options.gates !== false) {
    const f3 = ctx.plugin(gatesRow as any);
    await f3;
    fibers.push(f3);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function makePluginDir(base: string, name: string, version = '1.0.0', extra: Record<string, unknown> = {}) {
  const dir = join(base, `${name}-src`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name, version, entry: 'index.ts', ...extra }));
  await writeFile(join(dir, 'index.ts'), 'export function apply() {}\n');
  return dir;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-plugin-registry staging → approve → 装载', () => {
  it('stage → 人审 → approve：安装 + 装载 + plugin/installed 事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const calls: Array<Record<string, unknown>> = [];
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, {
      importModule: async (url) => {
        const key = new URL(url).pathname.split('/').slice(-2)[0];
        return modules.get(key);
      },
    });
    ctx.on('plugin/installed', (s) => calls.push({ kind: 'installed', name: s.name }));
    ctx.on('plugin/catalog-changed', (p) => calls.push({ kind: 'catalog', detail: p.kind }));

    const dir = await makePluginDir(root, 'alpha');
    modules.set('alpha', makeTestPlugin(new Map(), 'alpha')); // key = 安装后目录名（plugins/alpha）
    // 注意：importModule 的 key 按目录名取——真实场景按 entry 路径
    const record = await ctx.pluginRegistry.stage(dir, 'tester');
    expect(ctx.pluginRegistry.listStaging()).toHaveLength(1);

    const result = await ctx.pluginRegistry.approve(record.id);
    expect(result.name).toBe('alpha');
    expect(result.load.status).toBe('loaded');
    expect(ctx.pluginRegistry.has('alpha')).toBe(true);
    expect(calls.some((c) => c.kind === 'installed' && c.name === 'alpha')).toBe(true);
    expect(calls.some((c) => c.kind === 'catalog')).toBe(true);

    // 装载即归属：工具随插件 fiber 注册
    const r = await ctx.tools.execute({ name: 'alpha-tool', args: {} });
    expect(r).toEqual({ ok: true, output: 'from alpha' });
  });

  it('卸载：uninstall 回收装载 + 文件域移 .backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, {
      importModule: async (url) => modules.get(new URL(url).pathname.split('/').slice(-2)[0]),
    });
    const dir = await makePluginDir(root, 'beta');
    modules.set('beta', makeTestPlugin(new Map(), 'beta'));
    const record = await ctx.pluginRegistry.stage(dir);
    await ctx.pluginRegistry.approve(record.id);
    expect(ctx.tools.has('beta-tool')).toBe(true);

    const out = await ctx.pluginRegistry.uninstall('beta');
    expect(out.backupDir).toBeDefined();
    expect(ctx.pluginRegistry.has('beta')).toBe(false);
    expect(ctx.tools.has('beta-tool')).toBe(false); // 注册即归属：fiber dispose 回收
  });
});

describe('ac-plugin-registry gates（plugin/before-load）', () => {
  it('权限 gate：shell 未授予 → rejected（代码不进进程）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    let imported = false;
    const { ctx } = await boot(root, {
      importModule: async () => {
        imported = true;
        return { apply() {} };
      },
    });
    const dir = await makePluginDir(root, 'gamma', '1.0.0', { permissions: ['fs', 'shell'] });
    const outcome = await ctx.pluginRegistry.load({ dir, sessionOnly: true });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toMatch(/shell/);
    expect(imported).toBe(false); // fail-closed：import 之前拒绝
  });

  it('契约 gate：contracts ^99 → rejected；缺省兼容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });
    const bad = await makePluginDir(root, 'delta', '1.0.0', { contracts: '^99' });
    const outcome = await ctx.pluginRegistry.load({ dir: bad, sessionOnly: true });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toMatch(/不兼容/);

    const okDir = await makePluginDir(root, 'epsilon');
    const ok = await ctx.pluginRegistry.load({ dir: okDir, sessionOnly: true });
    expect(ok.status).toBe('loaded');
  });

  it('不装 gates 行 → gate 缺位（行组合决定安全策略）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { gates: false, importModule: async () => ({ apply() {} }) });
    const dir = await makePluginDir(root, 'zeta', '1.0.0', { permissions: ['shell'] });
    const outcome = await ctx.pluginRegistry.load({ dir, sessionOnly: true });
    expect(outcome.status).toBe('loaded'); // 无 gate 行：装载放行（yml 缺省装 gates）
  });
});

describe('ac-plugin-registry 会话级与重载', () => {
  it('会话级装载：重启即失语义（sessionOnly 标记 + catalog 事件 kind=session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const events: string[] = [];
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });
    ctx.on('plugin/catalog-changed', (p) => events.push(p.kind));
    const dir = await makePluginDir(root, 'sessional');
    const outcome = await ctx.pluginRegistry.load({ dir, sessionOnly: true });
    expect(outcome.status).toBe('loaded');
    expect(events).toContain('session');
    expect(ctx.pluginRegistry.listLoaded()[0].sessionOnly).toBe(true);
  });

  it('会话级不得覆盖已安装插件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });
    const dir = await makePluginDir(root, 'installed-one');
    const record = await ctx.pluginRegistry.stage(dir);
    await ctx.pluginRegistry.approve(record.id);
    const outcome = await ctx.pluginRegistry.load({ dir, sessionOnly: true });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toMatch(/全局插件安装/);
  });

  it('inject 不可满足 → 可诊断错误（不挂死）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });
    const dir = await makePluginDir(root, 'needy', '1.0.0', { inject: ['nonexistent-service'] });
    const outcome = await ctx.pluginRegistry.load({ dir, sessionOnly: true });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toMatch(/nonexistent-service/);
  });

  it('模块形状校验：缺 apply / name 不一致拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({}) });
    const dir = await makePluginDir(root, 'shapeless');
    const noApply = await ctx.pluginRegistry.load({ dir, sessionOnly: true });
    expect(noApply.status).toBe('rejected');

    const { ctx: ctx2 } = await boot(await mkdtemp(join(tmpdir(), 'ac-reg-')), {
      importModule: async () => ({ name: 'other', apply() {} }),
    });
    const dir2 = await makePluginDir(root, 'mismatch');
    const mismatch = await ctx2.pluginRegistry.load({ dir: dir2, sessionOnly: true });
    expect(mismatch.status).toBe('rejected');
  });
});

describe('register_plugin / unregister_plugin 工具（中断通道）', () => {
  it('工具体只上报意图（interrupt 载荷），不直接装载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });
    const result = await ctx.tools.execute({
      name: 'register_plugin',
      args: { dir: 'C:/tmp/whatever' },
    });
    expect(result.ok).toBe(true);
    expect(result.interrupt).toMatchObject({ type: 'register-plugin', dir: 'C:/tmp/whatever' });
  });

  it('after-run 消费 toolInterrupt 执行装载（宿主半边接线）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, {
      importModule: async (url) => modules.get(new URL(url).pathname.split('/').slice(-2)[0]),
    });
    const dir = await makePluginDir(root, 'tool-loaded');
    modules.set('tool-loaded-src', makeTestPlugin(new Map(), 'tool-loaded')); // session 装载直用源目录（key = 目录名）

    // 模拟 loop 收束：finish='interrupted' + toolInterrupt
    ctx.emit('loop/after-run', {} as never, {
      steps: [],
      text: '',
      finish: 'interrupted',
      usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'register-plugin', dir } },
    } as never);

    // 装载是异步触发的——轮询等待
    for (let i = 0; i < 200 && !ctx.pluginRegistry.has('tool-loaded'); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(ctx.pluginRegistry.has('tool-loaded')).toBe(true);
    expect(ctx.tools.has('tool-loaded-tool')).toBe(true);
  });
});

describe('ac-plugin-registry devScan / listFailed（M22 D6/D7）', () => {
  it('devScan：<root>/plugins/<owner>/<name>/ 布局；平铺已安装目录与保留目录跳过；损坏 manifest 不阻断', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });

    // owner 布局：plugins/helper/my-tool/manifest.json
    await mkdir(join(root, 'plugins', 'helper', 'my-tool'), { recursive: true });
    await writeFile(
      join(root, 'plugins', 'helper', 'my-tool', 'manifest.json'),
      JSON.stringify({ name: 'my-tool', version: '0.2.0', description: '测试行', entry: 'index.ts', permissions: ['fs'] }),
    );
    // 损坏 manifest 的兄弟目录（跳过不阻断）
    await mkdir(join(root, 'plugins', 'helper', 'broken'), { recursive: true });
    await writeFile(join(root, 'plugins', 'helper', 'broken', 'manifest.json'), '{oops');
    // 平铺已安装目录（直接含 manifest.json → 不属开发面）
    await mkdir(join(root, 'plugins', 'flat-installed'), { recursive: true });
    await writeFile(
      join(root, 'plugins', 'flat-installed', 'manifest.json'),
      JSON.stringify({ name: 'flat-installed', version: '1.0.0', entry: 'index.ts' }),
    );
    // 保留目录
    await mkdir(join(root, 'plugins', '.staging'), { recursive: true });

    const scan = ctx.pluginRegistry.devScan();
    expect(scan.root).toBe(root);
    expect(scan.dev).toEqual([
      {
        name: 'my-tool',
        version: '0.2.0',
        description: '测试行',
        owner: 'helper',
        dir: join(root, 'plugins', 'helper', 'my-tool'),
        permissions: ['fs'],
      },
    ]);
  });

  it('devScan：plugins/ 不存在 → 空扫描（不抛错）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const { ctx } = await boot(root, { importModule: async () => ({ apply() {} }) });
    expect(ctx.pluginRegistry.devScan()).toEqual({ root, dev: [] });
  });

  it('listFailed：装载 rejected 记因；成功装载清除；目录缺失的 boot 扫描记因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reg-'));
    const modules = new Map<string, unknown>();
    const { ctx } = await boot(root, {
      importModule: async (url) => modules.get(new URL(url).pathname.split('/').slice(-2)[0]),
    });

    // rejected：模块缺 apply
    const badDir = await makePluginDir(root, 'no-apply');
    modules.set('no-apply-src', {});
    const rejected = await ctx.pluginRegistry.load({ dir: badDir, sessionOnly: true });
    expect(rejected.status).toBe('rejected');
    expect(ctx.pluginRegistry.listFailed()).toEqual([
      { name: 'no-apply', error: expect.stringContaining('apply') },
    ]);

    // 成功装载同名 → 失败记录清除
    modules.set('no-apply-src', makeTestPlugin(new Map(), 'no-apply'));
    const ok = await ctx.pluginRegistry.load({ dir: badDir, sessionOnly: true });
    expect(ok.status).toBe('loaded');
    expect(ctx.pluginRegistry.listFailed()).toEqual([]);

    // boot 扫描：registry.json 有记录但目录缺失 → 记因（不写盘、不抛错）
    const record = await ctx.pluginRegistry.stage(await makePluginDir(root, 'ghost'), 'host');
    modules.set('ghost', makeTestPlugin(new Map(), 'ghost')); // key = 安装后目录名（plugins/ghost）
    const approved = await ctx.pluginRegistry.approve(record.id);
    expect(approved.load.status).toBe('loaded');
    await ctx.pluginRegistry.unload('ghost');
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'plugins', 'ghost'), { recursive: true });
    const outcomes = await ctx.pluginRegistry.loadInstalled();
    expect(outcomes).toEqual([]); // 目录缺失 → 跳过（warn + 记因，不入 outcomes）
    expect(ctx.pluginRegistry.listFailed()).toEqual([
      { name: 'ghost', error: expect.stringContaining('缺失') },
    ]);
  });
});
