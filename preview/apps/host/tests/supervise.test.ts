// ============================================================
// supervise.test.ts —— 常驻监护面纯域测试（cr-550）
// 拉起函数/时钟/回报面全注入（无真子进程——进程级 e2e 归既有 e2e 面）。
// 数据根恒 preview/sandbox（红线）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { superviseShell } from '../supervise.ts';
import type { SuperviseAdopter, AdoptedShellFace } from '../supervise.ts';
import { ReachabilityTable } from 'ac-post-office';

const ROOT = path.join('preview', 'sandbox', 'test-supervise-' + process.pid);

/** 手动时钟 */
class ManualClock {
  private t = 1_000_000;
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
}

/** 可控假壳：行/退出由测试驱动 */
class FakeShell implements AdoptedShellFace {
  bootId = 'boot-1';
  transportHint = 'pipe\\\\.\\mock-1';
  pid = 4321;
  events: import('ac-guardian').GuardianEvent[] = [
    // 真实 adoptShell 返回面：adopted 事件已在 events（三节拍消费完毕）
    { type: 'adopted', agentId: 'a1', bootId: 'boot-1', transportHint: 'pipe\\\\.\\mock-1', fingerprintRoot: 'abc' },
  ];
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  exited = false;
  constructor(private readonly bootLines: string[]) {}
  emitBoot(): void {
    for (const line of this.bootLines) this.lineCb?.(line);
  }
  pumpHeartbeat(): void { this.lineCb?.('guardian.ping\t' + new Date().toISOString()); }
  emitLoadFailed(plugin: string, error: string): void {
    this.lineCb?.('plugin.load-failed\t' + plugin + '\t' + error);
  }
  control(frame: Record<string, unknown>): Promise<unknown> { void frame; return Promise.resolve(null); }
  exit(code: number | null): void {
    this.exited = true;
    this.exitCb?.(code);
  }
  async shutdown(): Promise<number | null> { return 0; }
  kill(): void {}
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null) => void): void { this.exitCb = cb; }
}

/** 假 adopter：记录拉起次数与当前壳 */
class FakeAdopter {
  readonly shells: FakeShell[] = [];
  failuresAfterAdopt = 0;
  readonly fn: SuperviseAdopter = async () => {
    const shell = new FakeShell([
      'boot.lock.acquired\tb1\t' + new Date().toISOString(),
      'boot.rows.ready\tb1\t12',
      'boot.ready\tb1\tpipe\\\\.\\mock\tabcdef',
    ]);
    this.shells.push(shell);
    if (this.failuresAfterAdopt > 0) {
      this.failuresAfterAdopt--;
      // adopt 即崩（拉起失败——保持死态）
      throw new Error('拉起失败');
    }
    return shell;
  };
}

describe('superviseShell 常驻监护', () => {
  it('拉起→adopted 事件 + 心跳喂养（tick 无判死）', async () => {
    const clock = new ManualClock();
    const adopter = new FakeAdopter();
    const reach = new ReachabilityTable();
    let pump: (() => void) | null = null;
    const h = await superviseShell(
      { agentId: 'a1', dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', reach },
      {
        adopt: adopter.fn,
        now: () => clock.now(),
        tickIntervalMs: 30_000,
        tickPump: (onTick) => { pump = onTick; return () => { pump = null; }; },
      },
    );
    try {
      adopter.shells[0].emitBoot();
      expect(h.superviseEvents.some((e) => e.type === 'adopted')).toBe(true);
      // 三拍内心跳都在——tick 全 ok，无判死事件
      for (let i = 0; i < 5; i++) {
        adopter.shells[0].pumpHeartbeat();
        clock.advance(30_000);
        pump!();
      }
      expect(h.superviseEvents.some((e) => e.type === 'declared-dead')).toBe(false);
    } finally { h.stop(); }
  });

  it('心跳 3 拍丢失 → declare-dead + kill（假死壳强杀）', async () => {
    const clock = new ManualClock();
    const adopter = new FakeAdopter();
    const reach = new ReachabilityTable();
    let killed = false;
    let pump: (() => void) | null = null;
    const h = await superviseShell(
      { agentId: 'a1', dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', reach },
      {
        adopt: adopter.fn,
        now: () => clock.now(),
        tickIntervalMs: 30_000,
        // 同步泵：advance 即 tick（时间与触发同源——纯域可测）
        tickPump: (onTick) => { pump = onTick; return () => { pump = null; }; },
      },
    );
    const shell0 = adopter.shells[0];
    shell0.kill = () => { killed = true; };
    try {
      shell0.emitBoot();
      // 3 个周期无心跳：每周期推进 + 泵 tick（missed 累计至 3 拍 → declare-dead）
      clock.advance(30_001); pump!();
      expect(h.superviseEvents.some((e) => e.type === 'declared-dead')).toBe(false); // 1 拍未到
      clock.advance(30_001); pump!();
      clock.advance(30_001); pump!();
      expect(h.superviseEvents.some((e) => e.type === 'declared-dead' && e.reason === 'heartbeat-lost')).toBe(true);
      expect(killed).toBe(true);
    } finally { h.stop(); }
  });

  it('壳崩溃 → respawn 重拉同链（crash 分支）', async () => {
    const clock = new ManualClock();
    const adopter = new FakeAdopter();
    const reach = new ReachabilityTable();
    const h = await superviseShell(
      { agentId: 'a1', dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', reach },
      { adopt: adopter.fn, now: () => clock.now(), tickIntervalMs: 30_000, respawnDelayMs: 10 },
    );
    try {
      adopter.shells[0].emitBoot();
      adopter.shells[0].exit(1); // 崩溃
      await new Promise((r) => setTimeout(r, 60));
      expect(adopter.shells.length).toBe(2);
      expect(h.superviseEvents.some((e) => e.type === 'respawned')).toBe(true);
      expect(reach.hintFor('a1')).toBeUndefined(); // 清可达表
    } finally { h.stop(); }
  });

  it('60s 窗内 3 崩 → 熔断（不再重拉）', async () => {
    const clock = new ManualClock();
    const adopter = new FakeAdopter();
    const reach = new ReachabilityTable();
    const h = await superviseShell(
      { agentId: 'a1', dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', reach },
      { adopt: adopter.fn, now: () => clock.now(), tickIntervalMs: 30_000, respawnDelayMs: 5 },
    );
    try {
      // 3 轮：boot → 崩（墙钟推进由真实 Date——warden 计数用注入 now；测试内 3 崩全在窗内
      // （间隔 < 60s）
      adopter.shells[0].emitBoot();
      adopter.shells[0].exit(1);
      await new Promise((r) => setTimeout(r, 30));
      adopter.shells[1].emitBoot();
      adopter.shells[1].exit(1);
      await new Promise((r) => setTimeout(r, 30));
      adopter.shells[2].emitBoot();
      adopter.shells[2].exit(1);
      await new Promise((r) => setTimeout(r, 30));
      expect(h.isBroken()).toBe(true);
      expect(h.superviseEvents.some((e) => e.type === 'circuit-broken')).toBe(true);
      const countAfter = adopter.shells.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(adopter.shells.length).toBe(countAfter); // 熔断后零重拉
    } finally { h.stop(); }
  });

  it('respawn 指数退避档（cr-551）：存活驱动 streak 抬档', async () => {
    const clock = new ManualClock();
    const adopter = new FakeAdopter();
    const reach = new ReachabilityTable();
    const h = await superviseShell(
      { agentId: 'a1', dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', reach },
      // respawnDelayMs 语义 = 退避基数；bootOkMs 1ms（启动即崩族）+ 缩档注入
      { adopt: adopter.fn, now: () => clock.now(), tickIntervalMs: 30_000, respawnDelayMs: 100, backoffFactor: 2, backoffCapMs: 500, bootOkMs: 1 },
    );
    try {
      // 窗内即崩（bootOkMs 1ms、时钟不推进）= 启动失败族：streak 累计
      adopter.shells[0].emitBoot();
      adopter.shells[0].exit(1); // 首崩：delay = base×2^0（累计前 streak 0）
      await new Promise((r) => setTimeout(r, 150)); // 等 respawn timer（~100ms）跑完
      adopter.shells[1].emitBoot();
      adopter.shells[1].exit(1); // 二崩：delay = base×2^1
      await new Promise((r) => setTimeout(r, 20)); // 事件已发（timer 未到无关）
      const events = h.superviseEvents.filter((e) => e.type === 'respawned') as Array<{ delayMs: number }>;
      expect(events.length).toBe(2);
      expect(events[0]!.delayMs).toBeGreaterThanOrEqual(80);
      expect(events[0]!.delayMs).toBeLessThanOrEqual(120);
      expect(events[1]!.delayMs).toBeGreaterThanOrEqual(160);
      expect(events[1]!.delayMs).toBeLessThanOrEqual(240);
    } finally { h.stop(); }
  });

  it('插件装载失败回报：plugin.load-failed 行 → sink 转发', async () => {
    const clock = new ManualClock();
    const adopter = new FakeAdopter();
    const reach = new ReachabilityTable();
    const reports: Array<{ name: string; error: string }> = [];
    const h = await superviseShell(
      { agentId: 'a1', dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', reach },
      {
        adopt: adopter.fn,
        now: () => clock.now(),
        tickIntervalMs: 30_000,
        onPluginLoadFailure: async (name, error) => { reports.push({ name, error }); },
      },
    );
    try {
      adopter.shells[0].emitBoot();
      adopter.shells[0].emitLoadFailed('demo', 'entry syntax error');
      await new Promise((r) => setTimeout(r, 20));
      expect(reports).toEqual([{ name: 'demo', error: 'entry syntax error' }]);
    } finally { h.stop(); }
  });
});
