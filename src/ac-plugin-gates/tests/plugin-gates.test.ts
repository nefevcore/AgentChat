// ============================================================
// ac-plugin-gates：装载 gate 行生命周期冒烟（权限/契约 gate→放行→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as registryRow from 'ac-plugin-registry';
import type { PluginLoadCall, PluginLoadOutcome } from 'ac-plugin-registry';
import * as gatesRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** boot：tools → registry（root = 空临时目录）→ gates（gate 在 registry 之后挂） */
async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'ac-gates-'));
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const f1 = ctx.plugin(toolsRow as any);
  await f1;
  fibers.push(f1);
  const f2 = ctx.plugin(registryRow as any, { root });
  await f2;
  fibers.push(f2);
  const f3 = ctx.plugin(gatesRow as any);
  await f3;
  fibers.push(f3);
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

/** 组最小装载载体（manifest + 授予快照——plugin/before-load 的事实对象） */
function callOf(manifest: PluginLoadCall['manifest'], grants: PluginLoadCall['grants']): PluginLoadCall {
  return { manifest, grants, sessionOnly: true, watch: false };
}

/** waterfall 兜底结果（gate 放行时的透传值——直调不经真实 import） */
const PASS: PluginLoadOutcome = { status: 'loaded', name: 'smoke-pass', entry: 'index.ts', fiberUid: null };

describe('ac-plugin-gates', () => {
  it('权限 gate：manifest 声明超出 grants 的权限 → rejected（代码不进进程）', async () => {
    const { ctx } = await boot();
    const call = callOf(
      { name: 'smoke-perm', version: '1.0.0', entry: 'index.ts', permissions: ['fs', 'shell'] },
      ['fs'],
    );
    const outcome = await ctx.waterfall('plugin/before-load', call, async () => PASS);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.name).toBe('smoke-perm');
      expect(outcome.error).toContain('未授予的权限');
      expect(outcome.error).toContain('shell');
    }
  });

  it('契约 gate：contracts 声明不含宿主版本 → rejected（不兼容）', async () => {
    const { ctx } = await boot();
    const call = callOf(
      { name: 'smoke-contract', version: '1.0.0', entry: 'index.ts', contracts: '^99' },
      ['fs', 'network'],
    );
    const outcome = await ctx.waterfall('plugin/before-load', call, async () => PASS);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toContain('不兼容');
    }
  });

  it('合法 manifest：权限在授予集内 → gate 放行（next() 透传兜底结果）', async () => {
    const { ctx } = await boot();
    const call = callOf(
      { name: 'smoke-ok', version: '1.0.0', entry: 'index.ts', permissions: ['fs', 'shell'] },
      ['fs', 'shell'],
    );
    const outcome = await ctx.waterfall('plugin/before-load', call, async () => PASS);
    expect(outcome).toEqual(PASS);
  });

  it('dispose：gate 行卸载后 before-load 不再拦截（监听随 fiber 回收）', async () => {
    const { ctx, fibers } = await boot();
    await fibers[2]!.dispose();
    expect(fibers[2]!.uid).toBe(null);
    // 同一"超权 manifest"再次过 waterfall：无 gate 监听 → 直达兜底（行组合决定安全策略）
    const call = callOf(
      { name: 'smoke-perm', version: '1.0.0', entry: 'index.ts', permissions: ['fs', 'shell'] },
      ['fs'],
    );
    const outcome = await ctx.waterfall('plugin/before-load', call, async () => PASS);
    expect(outcome).toEqual(PASS);
  });
});
