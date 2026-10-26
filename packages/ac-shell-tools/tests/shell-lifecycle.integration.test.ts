// ============================================================
// 生命周期：超时/signal 中止/close 悬挂兜底（拆分自单文件版 ②/4）
// 全部含真实等待（sleep 命令 + 进程收束）——本文件墙钟 ~14s。
// ============================================================
import { describe, it, expect } from 'vitest';
import { CMD_TOOL, SLEEP_30, exec, tmpRoot, boot } from './helpers.ts';

describe(`ac-shell-tools ${CMD_TOOL} 生命周期`, () => {
  it('超时：kill 进程树 + timed_out 报告（timeoutAction=kill 旧行为回归）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { timeoutAction: 'kill' });
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: SLEEP_30, timeout: 2000 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时/);
  }, 20000);

  it('signal 中止：call.signal abort → 进程被杀', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const controller = new AbortController();
    const pending = exec(ctx, {
      name: CMD_TOOL,
      args: { command: SLEEP_30 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    const r = await pending;
    expect(r.ok).toBe(false);
  }, 20000);

  it('close 悬挂兜底（2026-09-12 卡死修复）：命令派生长活后代持有 stdout 管道 → exit 宽限后强制收束，工具不再永挂', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 孙进程继承本端 stdout 管道且比命令活得久——修复前 child 'close' 永不
    // 触发，工具 Promise 永挂 → run 卡死。孙进程 8s 自杀；Windows 分支
    // cwd 避开测试临时目录（宽限收束后还活着——占住 afterEach 要删的
    // 目录会 EPERM），Linux 分支 cwd 即 workdir。
    const cmd = process.platform === 'win32'
      ? `$p = Start-Process node -ArgumentList '-e','setTimeout(()=>{},8000)' -WorkingDirectory $env:TEMP -NoNewWindow -PassThru; Start-Sleep -Milliseconds 300; echo spawned-ok`
      : `(node -e 'setTimeout(()=>{},8000)' &) ; sleep 0.3; echo spawned-ok`;
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: cmd } });
    expect(r.ok).toBe(true);
    expect(String(r.output.output)).toContain('spawned-ok');
    expect(r.output.exit_code).toBe(0);
  }, 20000);
});
