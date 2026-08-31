// ============================================================
// ac-plugin-registry：M23 P5 熔断与安全模式 + G5 gates 屏障
//   · .load-health.json 失败计数持久化 / 熔断后 boot 不再重试 / skipped[] 透出
//   · bump version 重装解锁 / 成功清零 / uninstall 清除
//   · install 期失败立即计数 / 同 hash 幂等不重试（G8）
//   · hash 复验拒载（F3：篡改已装目录 → boot 拒载）
//   · 安全模式逃生（AGENTCHAT_SAFE_MODE / .safe-mode → 跳过 loadInstalled）
//   · boot 首扫在 gates 之后（G5 竞态回归）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import { PluginRegistryService } from '../src/service.ts';
import * as gatesRow from 'ac-plugin-gates';
import { readLoadHealth } from 'ac-plugin-core';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function newRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ac-health-'));
}

interface BootOpts {
  modules?: Map<string, unknown>;
  gates?: boolean;
  gatesTimeoutMs?: number;
}

/**
 * 直构服务（不经行 apply）——避免 boot 自动首扫与手动 loadInstalled 竞态；
 * 行级链路（自动首扫）已在 install-flow/plugin-registry 测试覆盖。
 */
async function boot(root: string, options: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const modules = options.modules ?? new Map<string, unknown>();
  const f1 = ctx.plugin(toolsRow as any);
  await f1;
  fibers.push(f1);
  const registry = new PluginRegistryService(ctx, {
    root,
    gatesTimeoutMs: options.gatesTimeoutMs ?? 200,
    importModule: async (url: string) => {
      const key = new URL(url).pathname.split('/').slice(-2)[0];
      return modules.get(key);
    },
  });
  // 等服务在 ctx 上可解析（Service 构造即注册；gates 行 inject 需要它）
  for (let i = 0; i < 100 && ctx.get('pluginRegistry') === undefined; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (options.gates !== false) {
    const f3 = ctx.plugin(gatesRow as any);
    await f3;
    fibers.push(f3);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers, registry };
}

async function installOne(root: string, name: string, version: string): Promise<string> {
  const dir = join(root, `${name}-src`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name, version, entry: 'index.ts', permissions: ['fs'] }));
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

describe('熔断生命周期（F4/G9）', () => {
  it('install 期装载失败立即计数；连续 3 次进 disabled；boot 跳过并透出 skipped[]', async () => {
    const root = await newRoot();
    // 第一次 install（失败计数 1）
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      const dir = await installOne(root, 'crasher', '1.0.0');
      modules.set('crasher', {}); // 缺 apply
      const r = await registry.installFromDir(dir, 'agent-x');
      expect(r.status).toBe('installed');
      expect(readLoadHealth(root).failures.crasher.count).toBe(1);
    }
    // 两次 bump version 重装（每次清零后又计 1——重装可重试）
    for (const version of ['1.0.1', '1.0.2']) {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      const dir = await installOne(root, 'crasher', version);
      modules.set('crasher', {});
      const r = await registry.installFromDir(dir, 'agent-x');
      expect(r.status).toBe('installed');
      expect(readLoadHealth(root).failures.crasher.count).toBe(1); // install 清零后重计
    }
    // 同版本（1.0.2）幂等重装不触发装载 → 计数不变（G8）
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      const dir = join(root, 'crasher-src');
      const again = await registry.installFromDir(dir, 'agent-x');
      expect(again.status).toBe('installed');
      if (again.status === 'installed') expect(again.idempotent).toBe(true);
      expect(readLoadHealth(root).failures.crasher.count).toBe(1);
    }
    // 手动堆满计数：两次 boot loadInstalled 失败（每次 +1）→ 达 3 熔断
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      modules.set('crasher', {}); // 首扫装载失败 → 计 2
      await registry.loadInstalled();
      expect(readLoadHealth(root).failures.crasher.count).toBe(2);
      expect(readLoadHealth(root).disabled.crasher).toBeUndefined();
    }
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      modules.set('crasher', {}); // 第 3 次失败 → disabled
      await registry.loadInstalled();
      expect(readLoadHealth(root).disabled.crasher).toBeDefined();
    }
    // 熔断后：boot 首扫跳过（不再装载、不再重算 failed[]），skipped[] 透出
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      modules.set('crasher', { apply() {} }); // 修好了——但已熔断，首扫仍跳过
      const outcomes = await registry.loadInstalled();
      expect(outcomes).toEqual([]);
      const skipped = registry.listSkipped();
      expect(skipped).toEqual([
        { name: 'crasher', reason: expect.any(String), count: 3 },
      ]);
      expect(registry.listFailed().find((f) => f.name === 'crasher')).toBeUndefined();
    }
    // 复位正路 1：bump version 重装（install 强制清记录）→ 装载成功
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      const dir = await installOne(root, 'crasher', '2.0.0');
      modules.set('crasher', { apply() {} });
      const r = await registry.installFromDir(dir, 'agent-x');
      expect(r.status === 'installed' && r.load.status).toBe('loaded');
      expect(readLoadHealth(root).disabled.crasher).toBeUndefined();
      expect(registry.listSkipped()).toEqual([]);
    }
  });

  it('成功装载清零；uninstall 清除记录', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    const { registry } = await boot(root, { modules });
    const dir = await installOne(root, 'flaky', '1.0.0');
    modules.set('flaky', {});
    await registry.installFromDir(dir, 'agent-x'); // 失败计 1
    expect(readLoadHealth(root).failures.flaky.count).toBe(1);

    // 同版本重装（hash 不一致拒绝）→ 换 1.1.0 且模块修好 → 成功清零
    const dir2 = await installOne(root, 'flaky', '1.1.0');
    modules.set('flaky', { apply() {} });
    const ok = await registry.installFromDir(dir2, 'agent-x');
    expect(ok.status === 'installed' && ok.load.status).toBe('loaded');
    expect(readLoadHealth(root).failures.flaky).toBeUndefined();

    // uninstall 清除（含 disabled）
    const un = await registry.uninstall('flaky');
    expect(un.backupDir).toBeDefined();
    expect(readLoadHealth(root).failures.flaky).toBeUndefined();
  });
});

describe('hash 复验（F3）', () => {
  it('boot 前篡改已装目录 → 拒载记 failed[]，文案引导重装或 uninstall；不计熔断', async () => {
    const root = await newRoot();
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      const dir = await installOne(root, 'tampered', '1.0.0');
      modules.set('tampered', { apply() {} });
      const r = await registry.installFromDir(dir, 'agent-x');
      expect(r.status === 'installed' && r.load.status).toBe('loaded');
    }
    // bash 篡改已装目录
    await writeFile(join(root, 'plugins', 'tampered', 'index.ts'), 'export function apply() { /* 调包 */ }\n');
    {
      const modules = new Map<string, unknown>();
      const { registry } = await boot(root, { modules });
      modules.set('tampered', { apply() {} });
      const outcomes = await registry.loadInstalled();
      expect(outcomes).toEqual([]); // 拒载不入 outcomes
      const failed = registry.listFailed();
      expect(failed).toEqual([
        { name: 'tampered', error: expect.stringMatching(/哈希与安装记录不一致/) },
      ]);
      expect(failed[0].error).toMatch(/install_plugin 重装|uninstall/); // 文案引导下一步
      // 不计熔断（内容审计与崩溃熔断是两件事）
      expect(readLoadHealth(root).failures.tampered).toBeUndefined();
    }
  });
});

describe('安全模式（§3.6 L8）', () => {
  it('.safe-mode 标记 → loadInstalled 全体跳过 + isSafeMode 透出；删除后恢复', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    {
      const { registry } = await boot(root, { modules });
      const dir = await installOne(root, 'sleeper', '1.0.0');
      modules.set('sleeper', { apply() {} });
      await registry.installFromDir(dir, 'agent-x');
    }
    await writeFile(join(root, '.safe-mode'), 'marked');
    {
      const modules2 = new Map<string, unknown>();
      modules2.set('sleeper', { apply() {} });
      const { registry } = await boot(root, { modules: modules2 });
      expect(registry.isSafeMode()).toBe(true);
      const outcomes = await registry.loadInstalled();
      expect(outcomes).toEqual([]);
      expect(registry.has('sleeper')).toBe(false); // 未装载
    }
    await rm(join(root, '.safe-mode'));
    {
      const modules3 = new Map<string, unknown>();
      modules3.set('sleeper', { apply() {} });
      const { registry } = await boot(root, { modules: modules3 });
      expect(registry.isSafeMode()).toBe(false);
      await registry.loadInstalled();
      for (let i = 0; i < 100 && !registry.has('sleeper'); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(registry.has('sleeper')).toBe(true); // 恢复装载
    }
  });

  it('AGENTCHAT_SAFE_MODE=1 env 同效', async () => {
    const root = await newRoot();
    process.env.AGENTCHAT_SAFE_MODE = '1';
    try {
      const { registry } = await boot(root, {});
      expect(registry.isSafeMode()).toBe(true);
      await registry.loadInstalled();
      expect(registry.listFailed()).toEqual([]);
    } finally {
      delete process.env.AGENTCHAT_SAFE_MODE;
    }
  });
});

describe('boot 首扫 gates 屏障（G5）', () => {
  it('registry 先激活：装载发生在 gates 挂上 before-load 监听之后（空 waterfall 竞态回归）', async () => {
    const root = await newRoot();
    const modules = new Map<string, unknown>();
    // 先安装一个契约不兼容插件（gates 应拒绝装载它——屏障保证 gate 不空转；
    // 安装阶段用 gates:false 通道只入安装态；免审快照 = manifest 全集，
    // 权限面恒满足——契约面才是 gates 否决的有效测试面）
    const dir = await installOne(root, 'shellful', '1.0.0');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'shellful', version: '1.0.0', entry: 'index.ts', contracts: '^99' }));
    modules.set('shellful', { apply() {} });
    {
      const { registry, fibers: f0 } = await boot(root, { modules, gates: false });
      const r = await registry.installFromDir(dir, 'test');
      expect(r.status === 'installed' && r.load.status).toBe('loaded');
      await registry.unload('shellful');
      for (const fiber of [...f0].reverse()) if (fiber.uid !== null) await fiber.dispose();
      booted.pop();
    }

    // gates 手动后挂（模拟 cordis.yml 行序：registry → gates）
    const { ctx, fibers, registry } = await boot(root, { modules, gates: false, gatesTimeoutMs: 5000 });

    // 首扫点火——此刻 gates 未挂（屏障应挂住装载，不放行过空 waterfall）
    const firstScan = registry.loadInstalled();
    // gates 现在激活（同 boot 时序）
    const f3 = ctx.plugin(gatesRow as any);
    await f3;
    fibers.push(f3);

    const outcomes = await firstScan;
    // gates 已就位：契约 ^99 与宿主不兼容 → rejected（若屏障失效则 loaded——gate 空转）
    const shellful = outcomes.find((o) => o.name === 'shellful');
    expect(shellful?.status).toBe('rejected');
    if (shellful?.status === 'rejected') expect(shellful.error).toMatch(/不兼容/);
  });
});
