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
import { IpcClient, PostOffice, ReachabilityTable, listenIpc } from 'ac-post-office';
import { isManageRequest, makeManageReply, isManageReply, makeManageRequest, socketPathFor } from 'ac-envelope-core';
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
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  exited = false;
  constructor(readonly bootLines: string[]) {}
  emitBoot(): void { for (const l of this.bootLines) this.lineCb?.(l); }
  exit(code: number | null, signal: string | null = null): void { this.exited = true; this.exitCb?.(code, signal); }
  async shutdown(): Promise<number | null> { return 0; }
  kill(): void {}
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
  controlFrames: Record<string, unknown>[] = [];
  control(frame: Record<string, unknown>): Promise<unknown> { this.controlFrames.push(frame); return Promise.resolve({ ok: true }); }
}

describe('撞活锁救援（cr-612 D5 边 2 配套；cr-647 前置化）', () => {
  it('活壳持锁 → ensureHook 前置探活回登记 + 转投发件箱（不 spawn 必被拒的子壳）', async () => {
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
    // cr-647：真链 adoptShell 撞活锁只产「壳进程早退（code=…）」——壳内
    // 「activation 锁被进程…」永不到宿主，救援不得依赖该错误文本。
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { spawned += 1; throw new Error('壳进程早退（code=1）——未达 boot.ready'); },
    });
    try {
      orch.ensureHook('beta'); // 消息路径入口（fire-and-forget）
      await new Promise((r) => setTimeout(r, 100));
      expect(spawned).toBe(0); // 前置探活命中——不 spawn
      expect(reach.hintFor('beta')).toBe('pipe\\\\.\\mock-beta-alive');
      expect(flushed).toBe(1); // 滞留信即刻转投
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

describe('换代活壳收复（cr-659）', () => {
  it('rescueLiveShells：活壳可达登记 + re-tap；死锁/无锁跳过', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    // 活壳 beta（本测试进程 pid）+ 陈锁 gamma + 无锁 delta
    const liveDir = path.join(ROOT, 'agents', 'beta');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-live', acquiredAt: new Date().toISOString(),
      transportHint: 'pipe\\\\.\\mock-beta-alive',
    }), 'utf-8');
    const staleDir = path.join(ROOT, 'agents', 'gamma');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'activation.lock'), JSON.stringify({
      pid: 99999999, bootId: 'b-stale', acquiredAt: new Date().toISOString(),
      transportHint: 'pipe\\\\.\\mock-gamma-dead',
    }), 'utf-8');
    fs.mkdirSync(path.join(ROOT, 'agents', 'delta'), { recursive: true });
    const taps: Array<{ agentId: string; hint: string }> = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      tap: async (agentId, hint) => { taps.push({ agentId, hint }); },
      adopt: async () => { throw new Error('收复面不得 spawn'); },
    });
    try {
      expect(orch.rescueLiveShells()).toBe(1);
      expect(reach.hintFor('beta')).toBe('pipe\\\\.\\mock-beta-alive');
      expect(reach.hintFor('gamma')).toBeUndefined();
      expect(reach.hintFor('delta')).toBeUndefined();
      // re-tap 只打给活壳
      await new Promise((r) => setTimeout(r, 50));
      expect(taps).toEqual([{ agentId: 'beta', hint: 'pipe\\\\.\\mock-beta-alive' }]);
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
describe('控制面通道选择（cr-675——控制点不绑 spawn 所有权）', () => {
  it('池内句柄优先：不打 socket 也不 spawn', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    let spawned = 0;
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { spawned += 1; const s = new FakeShell([]); shells.push(s); return s; },
    });
    try {
      const h = await orch.ensureAgent('alpha');
      expect(await orch.control('alpha', { ctrl: 'admin', op: 'goal-get' })).toEqual({ ok: true });
      expect(h).toBe(orch.handles().get('alpha'));
      expect(spawned).toBe(1); // 复用句柄，不二拉
      expect(shells[0]!.controlFrames).toEqual([{ ctrl: 'admin', op: 'goal-get' }]);
    } finally {
      orch.close();
      await po.close();
    }
  });

  it('池外活壳（宿主换代后的孤壳）：经其 transportHint 的 manage 通道受控——不 spawn 必被锁拒的子壳', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'beta');
    const server = await listenIpc(hint, (payload) => {
      if (!isManageRequest(payload)) return undefined;
      return makeManageReply(payload.manage.id, { ok: true, value: { echo: payload.manage.frame } });
    });
    const agentDir = path.join(ROOT, 'agents', 'beta');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, // 本测试进程恒活（锁内 holder 存活 = 活壳）
      bootId: 'b-live', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageProbeMs: 2_000,
      adopt: async () => { throw new Error('活壳在跑——不得 spawn'); },
    });
    try {
      expect(orch.liveShellIds()).toEqual(['beta']);
      const out = await orch.control('beta', { ctrl: 'admin', op: 'goal-get', conversationId: 'c1' }) as
        { echo: Record<string, unknown> };
      expect(out.echo.conversationId).toBe('c1');
      expect(orch.handles().has('beta')).toBe(false); // 控制面接通不等于接管监护
    } finally {
      orch.close();
      await server.close();
      await po.close();
    }
  });

  it('老壳不认 manage 帧（探针超时）：按 bootId 记一次后降级拉起链', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'gamma');
    // 老壳形态：连接照收，帧静默丢（无回执）
    const silent = await listenIpc(hint, () => undefined);
    const agentDir = path.join(ROOT, 'agents', 'gamma');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-old', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageProbeMs: 60,
      adopt: async () => { spawned += 1; return new FakeShell([]); },
    });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const notes: string[] = [];
    process.stderr.write = ((chunk: string) => { notes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(await orch.control('gamma', { ctrl: 'admin', op: 'run-state' })).toEqual({ ok: true });
      expect(spawned).toBe(1); // 探针超时 → 降级拉起
      expect(notes.join('')).toContain('活壳 manage 通道不可用');
      // 同一 bootId 记过一次：第二次直接走拉起链，不再吃探针超时
      const t0 = Date.now();
      await orch.control('gamma', { ctrl: 'admin', op: 'run-state' });
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      process.stderr.write = stderrWrite;
      orch.close();
      await silent.close();
      await po.close();
    }
  });
  it('boot 窗口竞态（cr-681）：锁已在而 ipc 后起——探针重试等到 listen，不黑名单不 spawn', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'epsilon');
    const agentDir = path.join(ROOT, 'agents', 'epsilon');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-booting', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    // 壳 boot 形态：锁先落盘，ipc 在 700ms 后才开始 listen（行集装载窗口）
    const lateListener = (async () => {
      await new Promise((r) => setTimeout(r, 700));
      return listenIpc(hint, (payload) => {
        if (!isManageRequest(payload)) return undefined;
        return makeManageReply(payload.manage.id, { ok: true, value: { echo: payload.manage.frame } });
      });
    })();
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageBootWaitMs: 5_000,
      adopt: async () => { spawned += 1; return new FakeShell([]); },
    });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const notes: string[] = [];
    process.stderr.write = ((chunk: string) => { notes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const out = await orch.control('epsilon', { ctrl: 'admin', op: 'run-state' }) as { echo: Record<string, unknown> };
      expect(out.echo.op).toBe('run-state'); // 等到 listen 后受控
      expect(spawned).toBe(0); // 不 spawn——单例锁在，spawn 必拒（cr-681 现场 spawn 风暴）
      expect(notes.join('')).not.toContain('活壳 manage 通道不可用'); // 不误记黑名单
    } finally {
      process.stderr.write = stderrWrite;
      orch.close();
      (await lateListener).close();
      await po.close();
    }
  });

  it('boot 窗口耗尽（holder 活着但 ipc 永不起）：明确报 ipc 不可达——不黑名单（之后 ipc 起来仍可受控）、不 spawn', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'zeta');
    const agentDir = path.join(ROOT, 'agents', 'zeta');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-stuck', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageBootWaitMs: 400,
      adopt: async () => { spawned += 1; return new FakeShell([]); },
    });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let server: Awaited<ReturnType<typeof listenIpc>> | undefined;
    try {
      await expect(orch.control('zeta', { ctrl: 'admin', op: 'run-state' })).rejects.toThrow(/manage 通道.*不可达/);
      expect(spawned).toBe(0); // 锁在——spawn 必拒，直接说清而不是刷早退日志
      // 未记黑名单：ipc 事后起来，同一 bootId 仍可受控（不走拉起链）
      server = await listenIpc(hint, (payload) => {
        if (!isManageRequest(payload)) return undefined;
        return makeManageReply(payload.manage.id, { ok: true, value: { recovered: true } });
      });
      expect(await orch.control('zeta', { ctrl: 'admin', op: 'run-state' })).toEqual({ recovered: true });
      expect(spawned).toBe(0);
    } finally {
      process.stderr.write = stderrWrite;
      orch.close();
      await server?.close();
      await po.close();
    }
  });

  it('老壳不应答且拉起被锁拒：诊断说清「不认控制帧」而不是「壳进程早退」', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'delta');
    const silent = await listenIpc(hint, () => undefined);
    const agentDir = path.join(ROOT, 'agents', 'delta');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-old2', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageProbeMs: 60,
      adopt: async () => { throw new Error('壳进程早退（code=1）——未达 boot.ready'); },
    });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(orch.control('delta', { ctrl: 'admin', op: 'run-state' }))
        .rejects.toThrow(/不认控制帧.*重启该壳后恢复/);
    } finally {
      process.stderr.write = stderrWrite;
      orch.close();
      await silent.close();
      await po.close();
    }
  });
});
