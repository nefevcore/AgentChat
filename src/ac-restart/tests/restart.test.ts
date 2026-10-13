// ============================================================
// ac-restart：system_restart 工具体 + ctx.restart 服务生命周期
// （非 Supervisor 拒绝 / Supervisor 语义化中断 / 挂载回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as restartRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, restartRow]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };

/**
 * Supervisor 模式专属 boot：设置 AGENTCHAT_SUPERVISED=1 并保持到用例断言
 * 完毕（isSupervised 在工具执行时同步读取 env，窗口必须覆盖 execute 调
 * 用，不能只覆盖行加载）。宿主半边只在 loop/after-run 消费 interrupt 时
 * 才 exit(42)——本文件不触发该路径，只走工具体。用例内用毕即清 +
 * afterEach 兜底，防后续用例误判 Supervisor 形态。
 */
async function bootSupervised() {
  process.env.AGENTCHAT_SUPERVISED = '1';
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, restartRow]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  delete process.env.AGENTCHAT_SUPERVISED;
});

// ⚠️ 外部环境误设 AGENTCHAT_SUPERVISED=1 时整体跳过（Supervisor 用例
// 自带窗口化设置，不依赖外部值；非 Supervisor 断言在外部污染下不成立）
describe.skipIf(process.env.AGENTCHAT_SUPERVISED === '1')('ac-restart', () => {
  it('注册面：行挂载后 system_restart 进入注册表', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.has('system_restart')).toBe(true);
    expect(ctx.tools.get('system_restart')?.requiredTags).toEqual(['admin']);
    // 形态轴声明（2026-09-13）：独立会话不投放（router 形态面裁剪生效集）
    expect(ctx.tools.get('system_restart')?.requiresInteraction).toBeUndefined(); // 正常工具：无交互声明（2026-09-21 注入轴重构撤 excludeForms）
  });

  it('执行：非 Supervisor 模式工具返回拒绝（进程不退）', async () => {
    const { ctx } = await boot();
    const r = await ctx.tools.execute({ name: 'system_restart', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('拒绝');
    expect(r.error).toContain('非 Supervisor');
    // 走到这里即证明未触发 exit(42)——进程仍在执行断言
  });

  it('Supervisor 模式：system_restart 受理 → 语义化中断 system-restart', async () => {
    const { ctx } = await bootSupervised();
    try {
      const r = (await ctx.tools.execute({ name: 'system_restart', args: { reason: '升级依赖' } })) as ExecRes;
      expect(r.ok).toBe(true);
      expect(r.interrupt).toMatchObject({ type: 'system-restart', reason: '升级依赖' });
    } finally {
      delete process.env.AGENTCHAT_SUPERVISED;
    }
  });

  it('ctx.restart.request：非 Supervisor 直接拒绝（不广播不关闭）', async () => {
    const { ctx } = await boot();
    expect(ctx.restart).toBeTruthy(); // 服务键随行挂载
    const r = ctx.restart.request('冒烟测试');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('拒绝') });
  });

  it('dispose：restart fiber 卸载后工具与服务键回收', async () => {
    const { ctx, fibers } = await boot();
    await fibers[1]!.dispose();
    expect(ctx.tools.has('system_restart')).toBe(false);
    expect(ctx.get('restart')).toBeUndefined(); // 服务键随行卸载回收
    const r = await ctx.tools.execute({ name: 'system_restart', args: {} });
    expect(r).toEqual({ ok: false, error: 'unknown tool: system_restart' });
  });
});
