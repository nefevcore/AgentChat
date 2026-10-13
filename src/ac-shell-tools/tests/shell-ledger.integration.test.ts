// ============================================================
// 台账与退出补刀（cr-382 孤儿进程复盘建议二/四）
//
// 台账生命周期（登记/销账）随前台命令冒烟；泄漏留痕（§7.4 场景的
// 可自动化等价物——真实 taskkill 失败注入不可移植）直接驱动
// noteUnconfirmedKill：断言不再静默（warn 带 pid 与命令摘要）。
// 宿主 exit 钩子的真实树杀由 desktop-kill-tree.test.ts 与 orphans
// 对账（ac-supervisor-core）分层覆盖。
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { CMD_TOOL, exec, tmpRoot, boot } from './helpers.ts';
import { noteUnconfirmedKill } from '../src/executor.ts';

describe(`ac-shell-tools ${CMD_TOOL} 台账与退出补刀（cr-382）`, () => {
  it('前台命令退出 → 台账登记/销账不干扰正常执行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: 'echo ledger-ok' } });
    expect(r.ok).toBe(true);
    expect(String(r.output.output)).toContain('ledger-ok');
  }, 15000);

  it('kill 未确认 → warn 留痕 + 泄漏清单登记（不再静默收束）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      noteUnconfirmedKill(999999, 'Get-ChildItem -Recurse src');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('999999');
      expect(String(warnSpy.mock.calls[0][0])).toContain('kill 未确认死亡');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
