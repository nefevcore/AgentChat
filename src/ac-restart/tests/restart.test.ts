// ============================================================
// ac-restart：非 Supervisor 模式生命周期冒烟（system_restart 拒绝且进程不退）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as restartRow from '../src/index.ts';
import { requestSystemRestart } from '../src/index.ts';

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

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

// ⚠️ 全程不得设置 AGENTCHAT_SUPERVISED=1（会触发 exit(42) 杀掉测试进程）；
// 若外部环境误设则整体跳过（本冒烟只覆盖非 Supervisor 拒绝面）
describe.skipIf(process.env.AGENTCHAT_SUPERVISED === '1')('ac-restart', () => {
  it('注册面：行挂载后 system_restart 进入注册表', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.has('system_restart')).toBe(true);
    expect(ctx.tools.get('system_restart')?.requiredTags).toEqual(['admin']);
  });

  it('执行：非 Supervisor 模式工具返回拒绝（进程不退）', async () => {
    const { ctx } = await boot();
    const r = await ctx.tools.execute({ name: 'system_restart', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('拒绝');
    expect(r.error).toContain('非 Supervisor');
    // 走到这里即证明未触发 exit(42)——进程仍在执行断言
  });

  it('requestSystemRestart：非 Supervisor 直接拒绝（不广播不关闭）', async () => {
    const { ctx } = await boot();
    const r = requestSystemRestart(ctx, '冒烟测试');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('拒绝') });
  });

  it('dispose：restart fiber 卸载后工具回收', async () => {
    const { ctx, fibers } = await boot();
    await fibers[1]!.dispose();
    expect(ctx.tools.has('system_restart')).toBe(false);
    const r = await ctx.tools.execute({ name: 'system_restart', args: {} });
    expect(r).toEqual({ ok: false, error: 'unknown tool: system_restart' });
  });
});
