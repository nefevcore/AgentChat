// ============================================================
// 宿主 timers 行单测（cr-1147 v2 探测循环）：check/dispatch e2e（worker
// 真跑双参脚本）+ boot 迁移 + persistNextAt 重启断点（防触发风暴）+
// 完成归档 + 乐观并发 + agentsEdit 单写者。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { TimerService } from '@agentchat/cordis-timer';
import { ConfigService } from 'ac-config';
import { PostOffice } from 'ac-post-office';
import { makeTimersHostRow, GLOBAL_TIMER_OWNER, HostTimersService, gateStderrTail } from '../src/timers-row.ts';
import { writeAgentConfig } from 'ac-agents-core';
import type { TimerScriptEntry } from 'ac-timer-core';

const ROOT = path.join('sandbox', 'test-host-timers-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 最小宿主环境（timer 基座 + config + timers + 邮局捕获） */
async function boot(endpoints: string[] = ['alpha']) {
  const po = new PostOffice({ dataRoot: ROOT });
  const received: Array<{ to: string; env: unknown }> = [];
  for (const ep of endpoints) {
    po.registerLocal(ep, async (env) => {
      received.push({ to: ep, env });
      return { ack: env.requestId, fresh: true };
    });
  }
  const ctx = new Context();
  const f1 = ctx.plugin(TimerService);
  const f2 = ctx.plugin(class extends ConfigService {
    constructor(c: Context) { super(c, { root: ROOT }); }
  });
  const f3 = ctx.plugin(makeTimersHostRow({ dataRoot: ROOT, postOffice: po, heartbeatMs: 50 }));
  await Promise.all([f1, f2, f3]);
  return {
    po, received, ctx,
    timers: (ctx as unknown as { timers: HostTimersService }).timers,
    async dispose() {
      for (const f of [f3, f2, f1].reverse()) await f.dispose();
      await po.close();
    },
  };
}

function seedAgent(id: string, entries: TimerScriptEntry[], config: Record<string, unknown> = { id, model: 'mock' }) {
  const dir = path.join(ROOT, 'agents', id, 'entries');
  fs.mkdirSync(dir, { recursive: true });
  writeAgentConfig(ROOT, config as unknown as import('ac-agents-core').AgentConfig);
  if (entries.length > 0) {
    fs.writeFileSync(path.join(dir, 'timer.json'), JSON.stringify({ entries }, null, 2), 'utf-8');
  }
}

/** 快触发脚本（探测间隔即地板 10s——最快仍受地板限） */
const quickScript = '(a, u) => ({ action: \'hi\', next: u.after(\'10s\') })';

/** 长间隔脚本（验断点：next 在远未来） */
const farScript = '(a, u) => ({ next: u.after(\'2h\') })';

describe('宿主 timers 行（探测循环 v2）', () => {
  it('双参脚本首检触发 → 唤醒信投递（对角线缺省）', async () => {
    seedAgent('alpha', [{ id: 'e1', enabled: true, kind: 'script', code: quickScript }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 4_000));
      expect(h.received.length).toBeGreaterThanOrEqual(1);
      const env = h.received[0]!.env as Record<string, unknown>;
      expect(env.uuid).toBe('alpha~alpha');
      expect((env.payload as { text: string }).text).toBe('hi');
      const st = h.timers.scheduleState('alpha', 'e1');
      expect(st.lastAt).toBeTruthy();
      expect(st.triggeredCount).toBeGreaterThanOrEqual(1);
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('persistNextAt 断点：重启直排未来值（不触发风暴）', async () => {
    seedAgent('alpha', [{ id: 'far', enabled: true, kind: 'script', code: farScript }]);
    const h1 = await boot();
    try {
      await new Promise((r) => setTimeout(r, 2_500)); // 首检跑完 → persistNextAt = +2h
      const stateFile = path.join(ROOT, 'meta', 'timer', 'state.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Record<string, { persistNextAt?: string }>;
      expect(state['alpha/far']?.persistNextAt).toBeTruthy();
    } finally {
      await h1.dispose();
    }
    // 重启：断点在未来 → 不跑脚本不触发（2.5s 窗口内零投递）
    const h2 = await boot();
    try {
      await new Promise((r) => setTimeout(r, 2_500));
      expect(h2.received.length).toBe(0);
      const st = h2.timers.scheduleState('alpha', 'far');
      expect(st.nextAt).toBeTruthy(); // 已排
    } finally {
      await h2.dispose();
    }
  }, 20_000);

  it('active:false 终结 → 完成归档', async () => {
    seedAgent('alpha', [{ id: 'e3', enabled: true, kind: 'script', code: '(a, u) => ({ active: false, action: \'once\' })' }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 3_500));
      expect(h.received.length).toBe(1);
      const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer-archive.json'), 'utf-8'));
      expect(archive[0]).toMatchObject({ id: 'e3', status: 'completed' });
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('旧条目 boot 迁移：(a,u) 产物 + .bak 备份 + 旧 scriptState 清空', async () => {
    const dir = path.join(ROOT, 'agents', 'alpha', 'entries');
    fs.mkdirSync(dir, { recursive: true });
    writeAgentConfig(ROOT, { id: 'alpha', model: 'mock' } as unknown as import('ac-agents-core').AgentConfig);
    fs.writeFileSync(path.join(dir, 'timer.json'), JSON.stringify({
      entries: [
        { id: 'old1', enabled: true, mode: 'time', hint: '早报', time: '09:00' },
        { id: 'old2', enabled: true, mode: 'delay', hint: '巡检', delay: '30m' },
      ],
    }, null, 2), 'utf-8');
    // 预置 v1 残留 scriptState（started 旗标——迁移须清）
    fs.mkdirSync(path.join(ROOT, 'meta', 'timer'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), JSON.stringify({
      'alpha/old1': { executedCount: 5, lastTriggeredAt: '2026-11-16T09:00:00+08:00' },
      'alpha/old2': { executedCount: 3, scriptState: { started: true } },
    }), 'utf-8');
    const h = await boot();
    try {
      const entries = h.timers.entries('alpha');
      expect(entries).toHaveLength(2);
      expect(entries.every((x) => x.kind === 'script' && x.code.includes('(a, u)'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'timer.json.bak'))).toBe(true);
      const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), 'utf-8')) as Record<string, { scriptState?: unknown; executedCount?: number }>;
      expect(state['alpha/old2']?.scriptState).toBeUndefined(); // 旗标已清
      expect(state['alpha/old1']?.executedCount).toBe(5); // 记账保留
    } finally {
      await h.dispose();
    }
  });

  it('脚本错误 → lastError 记账（退避不炸宿主）', async () => {
    seedAgent('alpha', [{ id: 'bad', enabled: true, kind: 'script', code: '(a, u) => { throw new Error(\"boom\") }' }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 2_500));
      const st = h.timers.scheduleState('alpha', 'bad');
      expect(st.lastError).toContain('boom');
      expect((st.errorStreak ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('next 非 Date（旧词形）→ 错误记账 + 退避', async () => {
    seedAgent('alpha', [{ id: 'strnext', enabled: true, kind: 'script', code: '(a, u) => ({ next: \'30m\' })' }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 2_500));
      const st = h.timers.scheduleState('alpha', 'strnext');
      expect(st.lastError).toContain('Date');
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('ISSUE-24：外部改盘 → save 拒写', async () => {
    seedAgent('zeta', [{ id: 'z1', enabled: true, kind: 'script', code: farScript }]);
    const h = await boot([]);
    try {
      const file = path.join(ROOT, 'agents', 'zeta', 'entries', 'timer.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      disk.entries[0].label = '外部改';
      fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf-8');
      const res = h.timers.save('zeta', [...h.timers.entries('zeta'), { id: 'z2', enabled: true, kind: 'script', code: farScript }]);
      expect(res.ok).toBe(false);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after.entries[0].label).toBe('外部改');
    } finally {
      await h.dispose();
    }
  });

  it('dryRun：双参干跑返回 verdict；坏脚本报错', async () => {
    seedAgent('alpha', []);
    const h = await boot();
    try {
      const r = await h.timers.dryRun('alpha', '(a, u) => ({ action: \'test\', next: u.after(\'30m\') })');
      expect(r.ok).toBe(true);
      const bad = await h.timers.dryRun('alpha', '(a, u) => { syntax error }');
      expect(bad.ok).toBe(false);
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('gate 预检：silent 跳过（lastSkipReason=gate + state 已持久化）', async () => {
    seedAgent('alpha', [{ id: 'g1', enabled: true, kind: 'script', code: '(a, u) => ({ action: \'hi\', state: { n: 7 }, next: u.after(\'2h\') })', gate: 'exit 20' }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 3_500));
      expect(h.received.length).toBe(0);
      const st = h.timers.scheduleState('alpha', 'g1');
      expect(st.lastSkipReason).toBe('gate');
      expect(st.lastGateCode).toBe(20);
      // gate 跳过轮 state 已持久化（前置持久化修复的验收点）
      const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), 'utf-8')) as Record<string, { scriptState?: unknown }>;
      expect(state['alpha/g1']?.scriptState).toEqual({ n: 7 });
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('全局条目简化形状归一化（{time,hint,targets} → 编译）', async () => {
    seedAgent('alpha', [], { id: 'alpha', model: 'mock' });
    seedAgent('beta', [], { id: 'beta', model: 'mock' });
    const h = await boot(['alpha', 'beta']);
    try {
      const cfg = h.ctx.get('config') as unknown as { set(k: string, v: unknown): void };
      cfg.set('timer.tasks', [{ time: '23:59', hint: '广播', targets: ['alpha', 'beta'] }]);
      h.timers.reload();
      const entries = h.timers.entries(GLOBAL_TIMER_OWNER);
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('script');
      h.timers.triggerNow(GLOBAL_TIMER_OWNER, entries[0].id);
      await new Promise((r) => setTimeout(r, 300));
      const tos = h.received.map((r) => (r.env as Record<string, unknown>).to).sort();
      expect(tos).toEqual(['alpha', 'beta']);
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('gateStderrTail 截断', () => {
    expect(gateStderrTail('a\nb\nc')).toBe('c');
    expect(gateStderrTail('')).toBe('');
    expect(gateStderrTail(null)).toBe('');
  });
});

describe('timers 行 entries 单写者收口（cr-551）', () => {
  it('agentsEdit 注入：save 落盘经编辑面 saveEntry', async () => {
    seedAgent('alpha', []);
    const po = new PostOffice({ dataRoot: ROOT });
    const edits: Array<{ id: string; key: string }> = [];
    const agentsEdit = {
      saveEntry: (id: string, key: string) => { edits.push({ id, key }); },
      readEntry: <T,>() => undefined as T | undefined,
    };
    const ctx = new Context();
    const f1 = ctx.plugin(TimerService);
    const f2 = ctx.plugin(class extends ConfigService {
      constructor(c: Context) { super(c, { root: ROOT }); }
    });
    const f3 = ctx.plugin(makeTimersHostRow({ dataRoot: ROOT, postOffice: po, agentsEdit }));
    await Promise.all([f1, f2, f3]);
    try {
      const timers = (ctx as unknown as { timers: HostTimersService }).timers;
      timers.save('alpha', [{ id: 'e9', enabled: true, kind: 'script', code: farScript }]);
      expect(edits.some((e) => e.id === 'alpha' && e.key === 'timer')).toBe(true);
    } finally {
      for (const f of [f3, f2, f1].reverse()) await f.dispose();
      await po.close();
    }
  });
});
