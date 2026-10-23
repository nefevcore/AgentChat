// ============================================================
// orchestrator.test.ts —— 编排面纯域测试（cr-551）
// 按需拉起触发链：邮局 ensure 钩子 → 句柄池幂等 → adopted re-tap →
// 死态重拉。拉起链全注入（无真子进程）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createOrchestrator } from '../orchestrator.ts';
import type { AdoptedShellFace } from '../supervise.ts';
import { PostOffice, ReachabilityTable } from 'ac-post-office';
import type { RouteTarget } from 'ac-post-office';

const ROOT = path.join('preview', 'sandbox', 'test-orchestrator-' + process.pid);

// 用例内建目录无 afterEach 清理（cr-549 同族漏网——cr-554）：历届运行在 preview/sandbox 积压 test-orchestrator-<pid>
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 可控假壳（AdoptedShellFace 最小面） */
class FakeShell implements AdoptedShellFace {
  bootId = 'boot-' + Math.random().toString(36).slice(2, 8);
  transportHint = 'pipe\\\\.\\mock-' + Math.random().toString(36).slice(2, 6);
  pid = 1000 + Math.floor(Math.random() * 9000);
  events: import('ac-guardian').GuardianEvent[] = [
    { type: 'adopted', agentId: 'x', bootId: this.bootId, transportHint: this.transportHint },
  ];
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  exited = false;
  constructor(readonly bootLines: string[]) {}
  emitBoot(): void { for (const l of this.bootLines) this.lineCb?.(l); }
  exit(code: number | null): void { this.exited = true; this.exitCb?.(code); }
  async shutdown(): Promise<number | null> { return 0; }
  kill(): void {}
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null) => void): void { this.exitCb = cb; }
  controlFrames: Record<string, unknown>[] = [];
  control(frame: Record<string, unknown>): Promise<unknown> { this.controlFrames.push(frame); return Promise.resolve({ ok: true }); }
}

describe('撞活锁救援（cr-612 D5 边 2 配套）', () => {
  it('adopt 撞活锁拒 → 读锁探活回登记可达 + 转投发件箱', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const agentDir = path.join(ROOT, 'agents', 'beta');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, // 本测试进程恒活
      bootId: 'b-old', acquiredAt: new Date().toISOString(),
      transportHint: 'pipe\\\\.\\mock-beta-alive',
    }), 'utf-8');
    let flushed = 0;
    const poFlush = po.flushOutbox.bind(po);
    po.flushOutbox = async () => { flushed += 1; return poFlush(); };
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { throw new Error('activation 锁被进程 ' + process.pid + ' 持有（bootId=b-old）——单例语义拒绝'); },
    });
    try {
      orch.ensureHook('beta'); // 消息路径入口（fire-and-forget——救援在其 catch 面）
      await new Promise((r) => setTimeout(r, 100));
      expect(reach.hintFor('beta')).toBe('pipe\\\\.\\mock-beta-alive');
      expect(flushed).toBe(1);
    } finally {
      orch.close();
    }
  });

  it('holder 已死（陈锁）→ 不登记（救援静默失败）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const agentDir = path.join(ROOT, 'agents', 'gamma');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: 99999999, // 不存在的 pid
      bootId: 'b-stale', acquiredAt: new Date().toISOString(),
      transportHint: 'pipe\\\\.\\mock-gamma-dead',
    }), 'utf-8');
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { throw new Error('activation 锁被进程 99999999 持有——单例语义拒绝'); },
    });
    try {
      orch.ensureHook('gamma');
      await new Promise((r) => setTimeout(r, 100));
      expect(reach.hintFor('gamma')).toBeUndefined();
    } finally {
      orch.close();
    }
  });
});

describe('编排面（orchestrator——按需拉起触发链）', () => {
  it('ensureAgent：拉起 + re-tap（adopted 事件触发 tap 回调）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const taps: Array<{ agentId: string; hint: string }> = [];
    let shell: FakeShell | null = null;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      tap: async (agentId, hint) => { taps.push({ agentId, hint }); },
      adopt: async () => {
        shell = new FakeShell(['boot.lock.acquired\tb1', 'boot.rows.ready\tb1\t10', 'boot.ready\tb1\tpipe\\\\.\\mock-1\troot1']);
        return shell;
      },
    });
    try {
      const h = await orch.ensureAgent('alpha');
      shell!.emitBoot();
      expect(h.agentId).toBe('alpha');
      expect(taps.length).toBe(1); // 初始拉起即 tap
      expect(taps[0]!.agentId).toBe('alpha');
      // 句柄池登记
      expect(orch.handles().has('alpha')).toBe(true);
    } finally {
      orch.close();
      await po.close();
    }
  });

  it('邮局 ensure 钩子：不可达投递 → 落箱 + 拉起（fire-and-forget）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    try {
      const reach = new ReachabilityTable();
      const taps: string[] = [];
      let started = 0;
      const orch = createOrchestrator({
        dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
        tap: async (_id, hint) => { taps.push(hint); },
        adopt: async () => {
          started++;
          return new FakeShell([]);
        },
      });
      po.setEnsureHook(orch.ensureHook);
      // 投一封不可达信（alpha 无 hint）→ 落箱 + ensure 触发
      const res = await po.dispatch({
        uuid: 'x~y', requestId: 'r1', sender: 'beta', to: 'alpha',
        kind: 'message', budget: 3, payload: { text: 'hi' },
      });
      expect(res[0]!.channel).toBe('outbox');
      await new Promise((r) => setTimeout(r, 50));
      expect(started).toBe(1); // 拉起已触发
      orch.close();
    } finally {
      await po.close();
    }
  });

  it('死态重拉（restart 幂等）：done 退出后来件再拉起', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const taps: string[] = [];
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      tap: async (_id, hint) => { taps.push(hint); },
      adopt: async () => {
        const s = new FakeShell(['boot.ready\tb1\tpipe\\\\.\\mock-2\troot2']);
        shells.push(s);
        return s;
      },
    });
    try {
      await orch.ensureAgent('alpha');
      shells[0]!.emitBoot();
      shells[0]!.exit(0); // done（正常退出——idle/手动）
      await new Promise((r) => setTimeout(r, 30));
      expect(orch.handles().get('alpha')!.isBroken()).toBe(false);
      // 来件再拉起（restart 幂等——死态重拉）
      await orch.ensureAgent('alpha');
      expect(shells.length).toBe(2);
      shells[1]!.emitBoot();
      expect(taps.length).toBe(2); // re-tap 已触发
    } finally {
      orch.close();
      await po.close();
    }
  });
});
