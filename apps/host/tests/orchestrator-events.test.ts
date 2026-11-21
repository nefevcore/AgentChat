// ============================================================
// orchestrator-events.test.ts —— 壳拉起系统事件（cr-1182）
//
// 锁定形态：shell-start 挂在 onAdopted（不是 ensureAgent 的 spawn 点）——
// restart_shell（exit 42）/ 崩溃重拉走 warden 内部 respawn 链，只有 adopted
// 回调能覆盖；事件 agentId 走归属位（per-agent 作用域）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createOrchestrator } from '../orchestrator.ts';
import type { AdoptedShellFace } from '../supervise.ts';
import { PostOffice, ReachabilityTable } from 'ac-post-office';
import { readSystemEventsSince } from 'ac-system-events';

const ROOT = path.join('sandbox', 'test-orch-events-' + process.pid);

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

class FakeShell implements AdoptedShellFace {
  bootId = 'boot-' + Math.random().toString(36).slice(2, 8);
  transportHint = 'pipe\\.\\mock-' + Math.random().toString(36).slice(2, 6);
  pid = 1000 + Math.floor(Math.random() * 9000);
  events: import('ac-guardian').GuardianEvent[] = [
    { type: 'adopted', agentId: 'x', bootId: this.bootId, transportHint: this.transportHint },
  ];
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  exited = false;
  constructor(readonly bootLines: string[]) {}
  emitBoot(): void { for (const l of this.bootLines) this.lineCb?.(l); }
  emitLine(line: string): void { this.lineCb?.(line); }
  exit(code: number | null, signal: string | null = null): void { this.exited = true; this.exitCb?.(code, signal); }
  async shutdown(): Promise<number | null> { return 0; }
  kill(): void {}
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
  controlFrames: Record<string, unknown>[] = [];
  control(frame: Record<string, unknown>): Promise<unknown> { this.controlFrames.push(frame); return Promise.resolve({ ok: true }); }
}

function shellOf(shells: FakeShell[]): FakeShell {
  const s = new FakeShell([
    'boot.lock.acquired\tb1\tT',
    'boot.rows.ready\tb1\t12',
    'boot.ready\tb1\tpipe\\.\\mock-ev',
  ]);
  shells.push(s);
  return s;
}

describe('壳拉起系统事件（cr-1182 批1）', () => {
  it('首拉落一条 shell-start（归属位 = agentId；他人不可见）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach: new ReachabilityTable(),
      adopt: async () => shellOf(shells),
    });
    try {
      await orch.ensureAgent('alpha');
      const events = readSystemEventsSince(ROOT, 0).filter((e) => e.kind === 'shell-start');
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('alpha');
    } finally {
      orch.close();
    }
  });

  it('restart_shell 形态（warden respawn，非 ensureAgent spawn 路径）也落事件', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach: new ReachabilityTable(),
      adopt: async () => shellOf(shells),
    });
    try {
      const handle = await orch.ensureAgent('beta');
      expect(readSystemEventsSince(ROOT, 0).filter((e) => e.kind === 'shell-start')).toHaveLength(1);
      // 壳退出 code 42（restart_shell 语义）→ warden 内部 respawn → 新壳 adopted
      shells[0].exit(42);
      await new Promise((r) => setTimeout(r, 3000));
      handlers: void handle;
      const events = readSystemEventsSince(ROOT, 0).filter((e) => e.kind === 'shell-start');
      // 覆盖率断言：respawn 形态至少再落一条（不是只认 ensureAgent 的 spawn 点）
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((e) => e.agentId === 'beta')).toBe(true);
    } finally {
      orch.close();
    }
  }, 20_000);
});
