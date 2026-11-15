// ============================================================
// orchestrator.test.ts —— 编排面纯域测试（cr-551）
// 按需拉起触发链：邮局 ensure 钩子 → 句柄池幂等 → adopted re-tap →
// 死态重拉。拉起链全注入（无真子进程）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createOrchestrator } from '../orchestrator.ts';
import type { AdoptedShellFace } from '../supervise.ts';
import { PostOffice, ReachabilityTable } from 'ac-post-office';
import { IpcClient, listenIpc } from 'ac-envelope-core';
import { isManageRequest, makeManageReply, isManageReply, makeManageRequest, socketPathFor } from 'ac-envelope-core';
import type { RouteTarget } from 'ac-post-office';

const ROOT = path.join('sandbox', 'test-orchestrator-' + process.pid);

// 用例内建目录无 afterEach 清理（cr-549 同族漏网——cr-554）：历届运行在 sandbox 积压 test-orchestrator-<pid>
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
  /** 模拟壳 stdout 持续行（boot.ready 后——runbeat/心跳面） */
  emitLine(line: string): void { this.lineCb?.(line); }
  exit(code: number | null, signal: string | null = null): void { this.exited = true; this.exitCb?.(code, signal); }
  async shutdown(): Promise<number | null> { return 0; }
  kill(): void {}
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
  controlFrames: Record<string, unknown>[] = [];
  control(frame: Record<string, unknown>): Promise<unknown> { this.controlFrames.push(frame); return Promise.resolve({ ok: true }); }
}

describe('run 节拍落盘（cr-740 运维日志）', () => {
  it('壳 run.started/run.settled TSV 行 → 缺省滚动落 runbeat-<agent>.log（带宿主时标）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => {
        const s = new FakeShell([
          'boot.lock.acquired	b1	T',
          'boot.rows.ready	b1	12',
          'boot.ready	b1	pipe\\\\.\\mock-rb',
        ]);
        shells.push(s);
        return s;
      },
    });
    try {
      await orch.ensureAgent('rb-agent');
      shells[0].emitLine('run.started	r-1	conv-1	user	mock');
      shells[0].emitLine('run.settled	r-1	conv-1	stop	2	340	1200');
      shells[0].emitLine('guardian.ping	T'); // 非 run 行不落
      const log = fs.readFileSync(path.join(ROOT, '.runtime', 'logs', 'runbeat-rb-agent.log'), 'utf-8');
      const lines = log.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z run\.started\tr-1\tconv-1\tuser\tmock$/);
      expect(lines[1]).toContain('run.settled	r-1	conv-1	stop	2	340	1200');
    } finally {
      orch.close();
    }
  });
});

describe('开发者模式 env 注入（cr-1097）', () => {
  it('adopter 层现取开关态：首拉后开关翻转，restart 重拉反映当前态（不停留首拉快照）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const inputs: Array<{ devEnv?: Record<string, string> }> = [];
    const shells: FakeShell[] = [];
    let devMode = false;
    const shellOf = (): FakeShell => {
      const s = new FakeShell([
        'boot.lock.acquired\tb1\tT',
        'boot.rows.ready\tb1\t12',
        'boot.ready\tb1\tpipe\\\\.\\mock-dm',
      ]);
      shells.push(s);
      return s;
    };
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      devModeOf: () => devMode,
      adopt: async (input) => { inputs.push(input); return shellOf(); },
    });
    try {
      await orch.ensureAgent('dm-agent'); // 首拉：devMode=false → 无 devEnv
      expect(inputs[0].devEnv).toBeUndefined();
      devMode = true;
      shells[0].exit(0, null); // 正常退出 → done 态（等来件按需拉起）
      await new Promise((r) => setTimeout(r, 100));
      await orch.ensureAgent('dm-agent'); // 死态重拉：现取 → devEnv 注入
      expect(inputs.length).toBe(2);
      expect(inputs[1].devEnv).toEqual({ AGENTCHAT_DEV_MODE: '1' });
    } finally {
      orch.close();
    }
  });
});

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

describe('换代壳完整接管（cr-967——socket-only 句柄入池）', () => {
  it('adoptLiveShells：活壳句柄入池 + 可达登记 + re-tap；死锁/无锁跳过；不 spawn', async () => {
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
      expect(await orch.adoptLiveShells()).toBe(1);
      // 完整接管：句柄在池（非仅可达登记）+ adopted 事件（re-tap 同链）
      const h = orch.handles().get('beta');
      expect(h).toBeDefined();
      expect(h!.superviseEvents.some((ev) => ev.type === 'adopted')).toBe(true);
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
  it('接管壳控制帧经 socket；探测断供判死 → shutdown 帧不应答 → 点名 pid 强杀 → 常规链重拉', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    // 活壳替身：真 IPC server（答 run-state；system 关停帧不应答 = 挂死壳）+ 真子进程持锁
    const hint = socketPathFor(path.resolve(ROOT), 'adopt-hung');
    const frames: Array<Record<string, unknown>> = [];
    let hung = false; // 翻真 = 挂死壳：连接照收、全部帧不应答（探测超时 = 心跳断供）
    const server = await listenIpc(hint, (payload) => {
      if (!isManageRequest(payload)) return undefined;
      const frame = payload.manage.frame as Record<string, unknown>;
      frames.push(frame);
      if (hung) return undefined;
      return makeManageReply(payload.manage.id, { ok: true, value: { busy: false, runs: [], recentSettled: [] } });
    });
    const holder = spawn('node', ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const agentDir = path.join(ROOT, 'agents', 'adopt-hung');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: holder.pid, bootId: 'b-hung', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    let t = 1_000_000;
    let pump: (() => void) | null = null;
    const spawned: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageProbeMs: 300,
      superviseOptions: {
        now: () => t,
        config: { heartbeatIntervalMs: 1_000 },
        tickIntervalMs: 1_000,
        respawnDelayMs: 5,
        tickPump: (onTick) => { pump = onTick; return () => { pump = null; }; },
      },
      adopt: async () => { // 判死后的重拉（常规 spawn 链——接管首拉已被 socket-only 面消费）
        const s = new FakeShell(['boot.ready	b2	mock-respawned']);
        spawned.push(s);
        return s;
      },
    });
    try {
      expect(await orch.adoptLiveShells()).toBe(1);
      // 控制帧经 socket（接管壳无 stdin 管道）
      expect(await orch.control('adopt-hung', { ctrl: 'admin', op: 'run-state' })).toEqual({ busy: false, runs: [], recentSettled: [] });
      // 探测断供（挂死：连接在但不应答）→ 双源齐断（接管壳无 stdout）→ 3 拍判死 → kill
      hung = true;
      t += 1_001; pump!(); t += 1_001; pump!(); t += 1_001; pump!();
      const h = orch.handles().get('adopt-hung')!;
      expect(h.superviseEvents.some((ev) => ev.type === 'declared-dead' && ev.reason === 'heartbeat-lost')).toBe(true);
      // kill 链：shutdown 帧已发（不应答）→ 点名锁内 pid 强杀（探活收敛断言）
      await new Promise((r) => setTimeout(r, 600));
      expect(frames.some((f) => f.ctrl === 'system' && f.op === 'shutdown')).toBe(true);
      let holderDead = false;
      for (let i = 0; i < 30 && !holderDead; i++) {
        try { process.kill(holder.pid!, 0); await new Promise((r) => setTimeout(r, 100)); }
        catch { holderDead = true; }
      }
      expect(holderDead).toBe(true);
      // 判死 kill = crash 现场 → respawn 常规链（真 spawn adopter）
      await new Promise((r) => setTimeout(r, 150));
      expect(spawned.length).toBe(1);
    } finally {
      orch.close();
      holder.kill();
      await server.close();
      await po.close();
    }
  }, 20_000);

  it('接管壳 idle 自杀（锁消失）：句柄 exit 0 终结——不重拉（idle 语义不因接管改变）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'adopt-idle');
    const server = await listenIpc(hint, (payload) => {
      if (!isManageRequest(payload)) return undefined;
      return makeManageReply(payload.manage.id, { ok: true, value: { busy: false, runs: [], recentSettled: [] } });
    });
    const holder = spawn('node', ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const agentDir = path.join(ROOT, 'agents', 'adopt-idle');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: holder.pid, bootId: 'b-idle', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      superviseOptions: { respawnDelayMs: 5 },
      adopt: async () => { spawned += 1; return new FakeShell([]); },
    });
    try {
      expect(await orch.adoptLiveShells()).toBe(1);
      // 壳 idle 自杀：停进程 + 放锁（锁文件 = 生命周期投影）
      holder.kill(); // 先停进程再删锁（避免观察器撞崩溃分支）
      fs.rmSync(path.join(agentDir, 'activation.lock'), { force: true });
      await new Promise((r) => setTimeout(r, 3_000)); // 锁观察器缺省 2s 拍
      const h = orch.handles().get('adopt-idle')!;
      expect(h.superviseEvents.some((ev) => ev.type === 'shell-exit' && ev.code === 0)).toBe(true);
      expect(h.superviseEvents.some((ev) => ev.type === 'respawned')).toBe(false); // done——不重拉
      await new Promise((r) => setTimeout(r, 150));
      expect(spawned).toBe(0);
    } finally {
      orch.close();
      holder.kill();
      await server.close();
      await po.close();
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

  it('【cr-840】spawningIds：拉壳在飞窗可见，adopt 完成即退场', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    let resolveAdopt: ((s: FakeShell) => void) | null = null;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      tap: async () => {},
      adopt: () => new Promise((res) => { resolveAdopt = res; }),
    });
    try {
      expect(orch.spawningIds()).toEqual([]); // 初始无在飞
      const p = orch.ensureAgent('alpha');
      expect(orch.spawningIds()).toEqual(['alpha']); // spawn → boot.ready 窗口在飞
      await new Promise((r) => setTimeout(r, 0)); // cr-962 并发门：adopt 在并发位取得后构造
      resolveAdopt!(new FakeShell(['boot.ready\tb1\tpipe\\\\.\\mock-3\troot3']));
      await p;
      expect(orch.spawningIds()).toEqual([]); // adopt 完成、句柄池登记——退场
    } finally {
      orch.close();
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
describe('拉起链冷启韧性（cr-962：并发门 / 超时补拉 / 冷却窗）', () => {
  it('并发门：maxConcurrentSpawns=1 → 第二个 agent 排队等先行者 adopt 完成', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    let inFlight = 0;
    let peak = 0;
    const gates: Array<(s: FakeShell) => void> = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      maxConcurrentSpawns: 1,
      adopt: () => new Promise((resolve) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        gates.push((s) => { inFlight -= 1; resolve(s); });
      }),
    });
    try {
      const p1 = orch.ensureAgent('alpha');
      const p2 = orch.ensureAgent('beta');
      await new Promise((r) => setTimeout(r, 30));
      gates[0]!(new FakeShell(['boot.ready\tb1\tpipe\\.\mock-c1'])); // 放行第一个
      await p1;
      await new Promise((r) => setTimeout(r, 10));
      gates[1]!(new FakeShell(['boot.ready\tb2\tpipe\\.\mock-c2'])); // 第二个才获并发位
      await p2;
      expect(peak).toBe(1); // 全程至多 1 只在飞
    } finally {
      orch.close();
      await po.close();
    }
  });

  it('adopt 超时补拉：首次超时 → 退避后重拉成功（慢启动 ≠ 死）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    let attempts = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      spawnRetries: 2, spawnRetryBaseMs: 10,
      adopt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('adopt 超时（第 1 拍预算 15000ms 用尽，无下一节拍）——已终止拉起中的壳进程');
        return new FakeShell(['boot.ready\tb1\tpipe\\.\mock-r1']);
      },
    });
    try {
      const h = await orch.ensureAgent('alpha');
      expect(h.agentId).toBe('alpha');
      expect(attempts).toBe(2);
      expect(orch.handles().has('alpha')).toBe(true);
    } finally {
      orch.close();
      await po.close();
    }
  });

  it('非超时失败不补拉；终败后冷却窗内快速失败（零重复 spawn）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    let attempts = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      spawnRetries: 2, spawnRetryBaseMs: 5, spawnFailCooldownMs: 60_000,
      adopt: async () => {
        attempts += 1;
        throw new Error('壳进程早退（code=1）——未达 boot.ready');
      },
    });
    try {
      await expect(orch.ensureAgent('alpha')).rejects.toThrow(/壳进程早退/);
      expect(attempts).toBe(1); // 锁拒族不补拉
      await expect(orch.ensureAgent('alpha')).rejects.toThrow(/拉起退避中/);
      expect(attempts).toBe(1); // 冷却窗内零重复 spawn
    } finally {
      orch.close();
      await po.close();
    }
  });
});

describe('双源喂活接线（换代接管 D1——peek 探测喂池内句柄）', () => {
  it('stdout 静默 + peek 成功在喂 → 不判死；探测断供 → 双源齐断判死', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'probe-alpha');
    const server = await listenIpc(hint, (payload) => {
      if (!isManageRequest(payload)) return undefined;
      return makeManageReply(payload.manage.id, { ok: true, value: { busy: false, runs: [], recentSettled: [] } });
    });
    const agentDir = path.join(ROOT, 'agents', 'probe-alpha');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-probe', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    // 手动时钟 + 同步泵（supervise 惯例）
    let t = 1_000_000;
    let pump: (() => void) | null = null;
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      superviseOptions: {
        now: () => t,
        tickIntervalMs: 30_000,
        tickPump: (onTick) => { pump = onTick; return () => { pump = null; }; },
      },
      adopt: async () => {
        const s = new FakeShell(['boot.ready	b1	' + hint]);
        shells.push(s);
        return s;
      },
    });
    let killed = 0;
    try {
      await orch.ensureAgent('probe-alpha');
      shells[0]!.kill = () => { killed += 1; };
      shells[0]!.emitBoot(); // adopt 三节拍（无后续 stdout——心跳全静默）
      // 探测在喂：每周期 peek 成功 → noteProbe 喂活，多拍不判死
      for (let i = 0; i < 4; i++) {
        t += 30_001;
        await orch.peek();
        pump!();
        expect(orch.handles().get('probe-alpha')!.superviseEvents.some((ev) => ev.type === 'declared-dead')).toBe(false);
      }
      // 探测断供（server 关停 + peek 无数据）：双源齐断 → 3 拍判死 + kill
      await server.close();
      t += 30_001; pump!();
      t += 30_001; pump!();
      t += 30_001; pump!();
      const h = orch.handles().get('probe-alpha')!;
      expect(h.superviseEvents.some((ev) => ev.type === 'declared-dead' && ev.reason === 'heartbeat-lost')).toBe(true);
      expect(killed).toBe(1);
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

  it('不应答壳（连接照收、帧静默丢）：探针超时 → 控制帧原样上抛，不降级拉起（cr-968 退役黑名单/降级路径）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const hint = socketPathFor(path.resolve(ROOT), 'gamma');
    // 不应答形态：连接照收，帧静默丢（无回执）
    const silent = await listenIpc(hint, () => undefined);
    const agentDir = path.join(ROOT, 'agents', 'gamma');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-silent', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageProbeMs: 60,
      adopt: async () => { spawned += 1; return new FakeShell([]); },
    });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(orch.control('gamma', { ctrl: 'admin', op: 'run-state' })).rejects.toThrow(/探活超时|超时/);
      expect(spawned).toBe(0); // 不降级拉起——锁在必拒，spawn 只会刷早退
      // 第二次同链：仍走探针（无黑名单记忆——不应答是壳内现场，非通道形态）
      await expect(orch.control('gamma', { ctrl: 'admin', op: 'run-state' })).rejects.toThrow(/超时/);
      expect(spawned).toBe(0);
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

  it('cr-805：池内句柄 start 失败（幽灵持锁）→ 窗内退避快速失败，不再逐拍 spawn；盘上活锁壳 ipc 可达则借道完成帧', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    // 盘上活锁壳 = 本测试进程持有（pid 恒活），ipc server 应答 manage 帧
    const hint = socketPathFor(path.resolve(ROOT), 'theta');
    const server = await listenIpc(hint, (payload) => {
      if (!isManageRequest(payload)) return undefined;
      return makeManageReply(payload.manage.id, { ok: true, value: { echo: payload.manage.frame } });
    });
    const agentDir = path.join(ROOT, 'agents', 'theta');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-ghost', acquiredAt: new Date().toISOString(), transportHint: hint,
    }), 'utf-8');
    // 池内句柄存在但壳已 idle 退出（current=null）；重拉全部被锁拒（幽灵）。
    // respawnDelayMs 拉小让退避窗 ~100ms，验证窗内快速失败不 spawn。
    let spawns = 0;
    const shells: FakeShell[] = [];
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      superviseOptions: { respawnDelayMs: 100 },
      adopt: async () => {
        spawns += 1;
        const s = new FakeShell([]);
        shells.push(s);
        if (spawns === 1) return s; // 首拉成功进池
        throw new Error('壳进程早退（code=1）——未达 boot.ready；尾部 stderr 见 x'); // 重拉全被幽灵锁拒
      },
    });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const h = await orch.ensureAgent('theta');
      expect(h).toBe(orch.handles().get('theta')); // 池内
      shells[0]!.exit(0); // 壳 idle 退出——句柄死态
      await new Promise((r) => setTimeout(r, 30));
      // 第二帧：start 重拉 → 被锁拒 → 借道盘上活锁壳 ipc 完成帧
      const out = await orch.control('theta', { ctrl: 'admin', op: 'run-state' }) as { echo: Record<string, unknown> };
      expect(out.echo.op).toBe('run-state');
      expect(spawns).toBe(2); // 只 spawn 过一次（被拒）
      // 退避窗内第三帧：不再 spawn（快速失败 → 借道）
      const out2 = await orch.control('theta', { ctrl: 'admin', op: 'run-state' }) as { echo: Record<string, unknown> };
      expect(out2.echo.op).toBe('run-state');
      expect(spawns).toBe(2); // 风暴根修：窗内零重复 spawn
    } finally {
      process.stderr.write = stderrWrite;
      orch.close();
      await server.close();
      await po.close();
    }
  });
});
