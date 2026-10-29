// ============================================================
// shell-state-poller.test.ts —— 状态对账面测试（cr-748）
// peek 只读探测（绝不拉起）+ 收束对拍（recentSettled → 事件，不重投）
// + 快照缺席清已见集（壳换代后从头认）+ 订阅门控（首订阅起、末位退订停）。
// peek 真 socket 面（listenIpc + activation.lock——orchestrator.test 同款
// 手法）；poller 用 tickPump 同步泵驱动。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createOrchestrator, type RunStateSnapshot } from '../orchestrator.ts';
import { createShellStatePoller, type PollerEvent } from '../shell-state-poller.ts';
import { PostOffice, ReachabilityTable, listenIpc } from 'ac-post-office';
import { isManageRequest, makeManageReply, socketPathFor } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-poller-' + process.pid);
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 活壳 run-state 回执壳（listenIpc 面——按当前快照答帧） */
async function seedLiveShell(agentId: string, state: () => unknown): Promise<ReturnType<typeof listenIpc>> {
  const hint = socketPathFor(path.resolve(ROOT), agentId);
  const agentDir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
    pid: process.pid, bootId: 'b-' + agentId, acquiredAt: new Date().toISOString(), transportHint: hint,
  }), 'utf-8');
  const server = await listenIpc(hint, (payload) => {
    if (!isManageRequest(payload)) return undefined;
    return makeManageReply(payload.manage.id, { ok: true, value: state() });
  });
  return server;
}

describe('peek 只读探测（cr-748——绝不拉起）', () => {
  it('活壳 run-state 快照：runs 投影 + recentSettled 尾巴 + 可达回登记', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    let snapshot: Record<string, unknown> = { busy: true, runs: [{ conversationId: 'c1', runId: 'run-1', startedAt: 5 }] };
    const server = await seedLiveShell('alpha', () => snapshot);
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { throw new Error('peek 不得拉起'); },
    });
    try {
      const out = await orch.peek();
      expect(out.has('alpha')).toBe(true);
      const snap = out.get('alpha')!;
      expect(snap.busy).toBe(true);
      expect(snap.runs).toEqual([{ conversationId: 'c1', runId: 'run-1', startedAt: 5 }]);
      // 可达回登记：孤壳回表（消息路径不依赖下一封信）
      expect(reach.hintFor('alpha')).toBe(socketPathFor(path.resolve(ROOT), 'alpha'));
      // 尾巴随快照携带
      snapshot = { busy: false, runs: [], recentSettled: [{ runId: 'run-1', conversationId: 'c1', finishedAt: 9, finish: 'ok' }] };
      const out2 = await orch.peek();
      expect(out2.get('alpha')!.recentSettled).toEqual([{ runId: 'run-1', conversationId: 'c1', finishedAt: 9, finish: 'ok' }]);
    } finally {
      orch.close();
      await server.close();
      await po.close();
    }
  });

  it('探测失败（连不上/超时/锁缺席）= 本拍无数据——不拉起不报错', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    // 活锁但无人 listen（boot 窗口形态）
    const agentDir = path.join(ROOT, 'agents', 'ghost');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-ghost', acquiredAt: new Date().toISOString(),
      transportHint: socketPathFor(path.resolve(ROOT), 'ghost'),
    }), 'utf-8');
    let spawned = 0;
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      manageProbeMs: 80,
      adopt: async () => { spawned += 1; throw new Error('peek 不得拉起'); },
    });
    try {
      const out = await orch.peek();
      expect(out.has('ghost')).toBe(false); // 本拍无数据
      expect(spawned).toBe(0);
    } finally {
      orch.close();
      await po.close();
    }
  });
});

describe('收束对拍（poller 事件面）', () => {
  it('recentSettled 新 runId → run-settled 事件恰一次；快照缺席清已见集', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    // 快照状态机：拍 1 = 活跃 run；拍 2 = 已收束（尾巴出现 run-1）；拍 3 = 壳消失
    let phase = 0;
    const state = () => phase === 0
      ? { busy: true, runs: [{ conversationId: 'c1', runId: 'run-1', startedAt: 5 }] }
      : { busy: false, runs: [], recentSettled: [{ runId: 'run-1', conversationId: 'c1', finishedAt: 9, finish: 'ok' }] };
    const server = await seedLiveShell('alpha', state);
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { throw new Error('poller 不得拉起'); },
    });
    const events: PollerEvent[] = [];
    const pumps: Array<() => void> = [];
    const poller = createShellStatePoller(orch, {
      tickPump: (onTick) => { pumps.push(onTick); return () => { /* 停泵——用例收尾 */ }; },
    });
    const tick = () => { for (const p of [...pumps]) p(); };
    try {
      const off = poller.onEvent((e) => { events.push(e); });
      phase = 0;
      tick();
      await new Promise((r) => setTimeout(r, 30));
      expect(events.filter((e) => e.type === 'run-settled')).toHaveLength(0); // 活跃中无收束
      phase = 1; // run 收束——尾巴出现
      tick();
      await new Promise((r) => setTimeout(r, 30));
      const settled = events.filter((e) => e.type === 'run-settled');
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ agentId: 'alpha', runId: 'run-1', conversationId: 'c1', finish: 'ok' });
      phase = 1;
      tick(); // 同尾巴再拍——不重投
      await new Promise((r) => setTimeout(r, 30));
      expect(events.filter((e) => e.type === 'run-settled')).toHaveLength(1);
      // 壳消失（快照缺席）→ 已见集清空
      await server.close();
      fs.rmSync(path.join(ROOT, 'agents', 'alpha', 'activation.lock'), { force: true });
      tick();
      await new Promise((r) => setTimeout(r, 30));
      expect(poller.snapshot().has('alpha')).toBe(false);
      off();
    } finally {
      poller.dispose();
      orch.close();
      await po.close();
    }
  });

  it('订阅门控：首订阅起泵、末位退订停泵（同步驱动面）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const server = await seedLiveShell('beta', () => ({ busy: false, runs: [] }));
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { throw new Error('不得拉起'); },
    });
    const pumps: Array<() => void> = [];
    const stops: Array<() => void> = [];
    const poller = createShellStatePoller(orch, {
      tickPump: (onTick) => { pumps.push(onTick); return () => { stops.push(() => {}); }; },
    });
    const tick = () => { for (const p of [...pumps]) p(); };
    try {
      const a = poller.onEvent(() => {});
      expect(pumps.length).toBe(1); // 首订阅起泵
      const b = poller.onEvent(() => {});
      expect(pumps.length).toBe(1); // 双订阅不双泵
      a();
      expect(stops.length).toBe(0); // 仍有订阅——不停
      b();
      expect(stops.length).toBe(1); // 末位退订停泵
      const c = poller.onEvent(() => {});
      expect(pumps.length).toBe(2); // 再订阅再起
      c();
      tick(); // 手动驱动一拍（快照可用）
      await new Promise((r) => setTimeout(r, 30));
      expect(poller.snapshot().has('beta')).toBe(true);
    } finally {
      poller.dispose();
      orch.close();
      await server.close();
      await po.close();
    }
  });
});
