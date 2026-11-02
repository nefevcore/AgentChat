// ============================================================
// reap.test.ts —— 宿主 close 收割语义回归（cr-813）
//
// 根因：cr-705 给 close() 加的无差别壳收割误伤 restart_host 换代路径
//（restartHost → host.close() 收割活壳 → 在途 run 被杀：provider dispose
// 裸 abort → mid-run AbortError 误标 error 收束 + 壳退 0 warden 判 done
// 不重拉——「保壳保 run」双重破坏，2026-10-30 两次活体实锤）。修 = close 增
// reapShells 选项，换代路径跳过收割。本文件锁两分支：
//   · reapShells:false（restart_host 换代路径）——壳不动（shutdown 不被调）
//   · 缺省（测试 teardown 语义，cr-705）——逐句柄收割不变
// 数据根恒 sandbox 独立目录（红线）；adopt 注入假壳（无真子进程）。
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { bootHost } from '../boot.ts';
import type { AdoptedShellFace } from '../supervise.ts';
import type { GuardianEvent } from 'ac-guardian';
import { listenIpc } from 'ac-envelope-core';

const HERE = path.resolve(__dirname, '../../..');
const CATALOG = path.join(HERE, 'apps/catalog/row-catalog.json');
const ROOT = path.join(HERE, 'sandbox', 'host-reap-test-' + process.pid);

/** 假壳（adopt 注入）——真 ipc 监听（tapAgent 要连），shutdown 记账 */
class FakeShell implements AdoptedShellFace {
  readonly bootId = 'boot-' + Math.random().toString(36).slice(2, 8);
  readonly transportHint: string;
  readonly pid = process.pid;
  shutdownCalls = 0;
  killed = false;
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  constructor(hint: string) {
    this.transportHint = hint;
    this.events = [
      { type: 'adopted', agentId: 'alpha', bootId: this.bootId, transportHint: hint },
    ];
  }
  events: GuardianEvent[] = [];
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
  emitLine(line: string): void { this.lineCb?.(line); }
  exit(code: number | null, signal: string | null = null): void { this.exitCb?.(code, signal); }
  async shutdown(): Promise<number | null> { this.shutdownCalls += 1; return 0; }
  kill(): void { this.killed = true; }
  async control(): Promise<unknown> { return { ok: true }; }
}

const shells: FakeShell[] = [];
const listeners: Array<{ close(): Promise<unknown> }> = [];
afterAll(async () => {
  for (const l of listeners) await l.close().catch(() => {});
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 起宿主 + 假壳入池（boot → listenIpc → adopt → ensureAgent 完成 tap 链） */
async function bootWithFakeShell(): Promise<{ host: Awaited<ReturnType<typeof bootHost>>; shell: FakeShell }> {
  fs.mkdirSync(ROOT, { recursive: true });
  const hint = path.join('\\\\.\\pipe\\agentchat-reap-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  const listener = await listenIpc(hint, () => ({ ok: true }));
  listeners.push(listener);
  const shell = new FakeShell(hint);
  shells.push(shell);
  const host = await bootHost({
    dataRoot: ROOT,
    catalogFile: CATALOG,
    adopt: async () => shell,
  });
  await host.supervisors!.ensureAgent('alpha');
  return { host, shell };
}

describe('宿主 close 壳收割语义（cr-813 restart_host 保壳回归）', () => {
  it('reapShells:false（换代路径）——壳不被收割（shutdown 零调用，句柄池已收）', async () => {
    const { host, shell } = await bootWithFakeShell();
    await host.close({ reapShells: false });
    expect(shell.shutdownCalls).toBe(0);
    expect(shell.killed).toBe(false);
    expect(host.supervisors!.handles().size).toBe(0); // 监护循环已停、池已清
  }, 30_000);

  it('缺省（teardown 语义，cr-705）——逐句柄收割（shutdown 被调）', async () => {
    const { host, shell } = await bootWithFakeShell();
    await host.close();
    expect(shell.shutdownCalls).toBe(1);
  }, 30_000);
});
