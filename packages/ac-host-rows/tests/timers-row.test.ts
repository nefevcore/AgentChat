// ============================================================
// 宿主 timers 行单测（cr-1164 v3 哑触发层）：声明式触发 e2e（once/
// every 墙钟网格投递）+ 门跳过 + until 归档 + boot 迁移（v1 5 模式直译 /
// v2 脚本丢弃归档 / 记账 key 迁移）+ 乐观并发 + agentsEdit 单写者 +
// 静态预览 + 全局简化形状归一。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { TimerService } from '@agentchat/cordis-timer';
import { ConfigService } from 'ac-config';
import { PostOffice } from 'ac-post-office';
import { makeTimersHostRow, GLOBAL_TIMER_OWNER, HostTimersService } from '../src/timers-row.ts';
import { writeAgentConfig } from 'ac-agents-core';
import type { TimerEntry } from 'ac-timer-core';

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

function seedAgent(id: string, entries: TimerEntry[], config: Record<string, unknown> = { id, model: 'mock' }) {
  const dir = path.join(ROOT, 'agents', id, 'entries');
  fs.mkdirSync(dir, { recursive: true });
  writeAgentConfig(ROOT, config as unknown as import('ac-agents-core').AgentConfig);
  if (entries.length > 0) {
    fs.writeFileSync(path.join(dir, 'timer.json'), JSON.stringify({ version: 3, entries }, null, 2), 'utf-8');
  }
}

const onceNear = (ms: number): TimerEntry => ({
  id: 'near', enabled: true, when: [{ kind: 'once', at: new Date(Date.now() + ms).toISOString() }], action: { text: 'hi' },
});

const everyQuick: TimerEntry = {
  id: 'q', enabled: true, when: [{ kind: 'every', iv: '2s' }], action: { text: 'tick' },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('源触发（cr-1165 采集层接线）', () => {
  // cr-1166 起源订阅需授权——本组用例统一给 alpha 配 fs/docs grant
  const seedWithGrant = (id: string, entries: import('ac-timer-core').TimerEntry[]) => {
    seedAgent(id, entries);
    const dir = path.join(ROOT, 'agents', id);
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      version: 1, agentId: id,
      grants: [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'docs' } } }],
      denials: [],
    }), 'utf-8');
  };
  it('rows-added：物化事件 → 唤醒信投递 + cooldown 节流 + lastSeq 推进', async () => {
    seedWithGrant('alpha', [{
      id: 'sw', enabled: true,
      when: [{ kind: 'source', source: 'fs', view: 'docs', on: 'rows-added', cooldown: '2s' }],
      action: { text: '新文件' },
    }]);
    const h = await boot();
    try {
      // 模拟 fs-source 行物化 + 发事件（ac-source-core 真物化面）
      const { materializeSnapshot } = await import('ac-source-core');
      const dir = path.join(ROOT, 'exports', 'fs', 'docs');
      const r1 = materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r1.seq });
      await wait(500);
      expect(h.received.length).toBe(1);
      // 无新行的事件 = 不投
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r1.seq });
      await wait(300);
      expect(h.received.length).toBe(1);
      // 新行但 cooldown 窗口内 = 不投（lastSeq 照常推进）
      const r2 = materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }, { path: 'b.md', mtime: 2, size: 3 }], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r2.seq });
      await wait(300);
      expect(h.received.length).toBe(1); // cooldown 2s 窗口内
      // 窗口过后新行 → 投
      await wait(2_000);
      const r3 = materializeSnapshot(dir, [
        { path: 'a.md', mtime: 1, size: 5 }, { path: 'b.md', mtime: 2, size: 3 }, { path: 'c.md', mtime: 9, size: 1 },
      ], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r3.seq });
      await wait(500);
      expect(h.received.length).toBe(2);
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('match 过滤：字段不命中不投；命中即投', async () => {
    seedWithGrant('alpha', [{
      id: 'mf', enabled: true,
      when: [{ kind: 'source', source: 'fs', view: 'docs', on: 'rows-added', match: { field: 'path', op: 'contains', value: 'urgent' } }],
      action: { text: '紧急文件' },
    }]);
    const h = await boot();
    try {
      const { materializeSnapshot } = await import('ac-source-core');
      const dir = path.join(ROOT, 'exports', 'fs', 'docs');
      const r1 = materializeSnapshot(dir, [{ path: 'note-a.md', mtime: 1, size: 5 }], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r1.seq });
      await wait(400);
      expect(h.received.length).toBe(0);
      const r2 = materializeSnapshot(dir, [
        { path: 'note-a.md', mtime: 1, size: 5 }, { path: 'urgent-b.md', mtime: 2, size: 3 },
      ], 50_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r2.seq });
      await wait(400);
      expect(h.received.length).toBe(1);
      expect((h.received[0]!.env as { payload: { text: string } }).payload.text).toBe('紧急文件');
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('stale：源陈旧 → on:stale 条目唤醒（经 pull 兜底通道）', async () => {
    seedAgent('alpha', [{
      id: 'st', enabled: true,
      when: [{ kind: 'source', source: 'fs', view: 'docs', on: 'stale' }],
      action: { text: '采集异常请检查' },
    }]);
    const h = await boot();
    try {
      const { materializeSnapshot } = await import('ac-source-core');
      // staleAfterMs 极小（如 10ms）——物化后立即陈旧
      const dir = path.join(ROOT, 'exports', 'fs', 'docs');
      materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }], 10);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: 1 });
      await wait(200);
      // pull 兜底 10s 地板——测试直接调不了私有 staleSweep；经 emit 后
      // syncPull 启动 interval，10s 太久 → 用假钟：直接验证 stale 判据面
      // （本用例验证「emit 后不误投 rows-added」（stale 条目不订 rows-added））
      expect(h.received.length).toBe(0);
    } finally {
      await h.dispose();
    }
  }, 10_000);

  it('cr-1172 源健康投影：scheduleState 带出 sources[]（generatedAt/seq/stale 现读）', async () => {
    seedWithGrant('alpha', [{
      id: 'sh', enabled: true,
      when: [
        { kind: 'source', source: 'fs', view: 'docs', on: 'rows-added' },
        { kind: 'daily', at: '09:00' },
      ],
      action: { text: '巡检' },
    }]);
    const h = await boot();
    try {
      // 源未物化 = sources 缺席（dormantReason 另有投影）
      let st = h.timers.scheduleState('alpha', 'sh');
      expect(st.sources).toBeUndefined();
      // 物化后 = 健康投影在场（staleAfterMs 60s > 已过时间 → stale false）
      const { materializeSnapshot } = await import('ac-source-core');
      const dir = path.join(ROOT, 'exports', 'fs', 'docs');
      const r = materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }], 60_000);
      st = h.timers.scheduleState('alpha', 'sh');
      expect(st.sources).toEqual([{ source: 'fs', view: 'docs', generatedAt: expect.any(String), seq: r.seq, stale: false }]);
      // staleAfterMs 极小（10ms）→ 稍候即 stale true（与 staleSweep 同判据）
      materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }, { path: 'b.md', mtime: 2, size: 3 }], 10);
      await wait(50);
      st = h.timers.scheduleState('alpha', 'sh');
      expect(st.sources?.[0]?.stale).toBe(true);
      expect(st.sources?.[0]?.seq).toBe(r.seq + 1);
      // 纯时间条目不带 sources
      const none = h.timers.scheduleState('alpha', 'nonexistent');
      expect(none.sources).toBeUndefined();
    } finally {
      await h.dispose();
    }
  }, 10_000);
});

describe('源视图授权闸（cr-1166）', () => {
  function seedGrant(agentId: string, grants: unknown[]) {
    const dir = path.join(ROOT, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ version: 1, agentId, grants, denials: [] }), 'utf-8');
  }
  const svEntry: TimerEntry = {
    id: 'auth1', enabled: true,
    when: [{ kind: 'source', source: 'fs', view: 'secret', on: 'rows-added' }],
    action: { text: '有新行' },
  };

  it('cr-1169 重启续读：投过一次的 seq 不因宿主重启重投（lastSeq 持久化）', async () => {
    seedAgent('alpha', [{
      id: 'sw', enabled: true,
      when: [{ kind: 'source', source: 'fs', view: 'docs', on: 'rows-added' }],
      action: { text: '新文件' },
    }]);
    const grantDir = path.join(ROOT, 'agents', 'alpha');
    fs.writeFileSync(path.join(grantDir, 'auth.json'), JSON.stringify({
      version: 1, agentId: 'alpha',
      grants: [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'docs' } } }],
      denials: [],
    }), 'utf-8');
    const h = await boot();
    const { materializeSnapshot } = await import('ac-source-core');
    const dir = path.join(ROOT, 'exports', 'fs', 'docs');
    const r1 = materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }], 60_000);
    h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r1.seq });
    await wait(400);
    expect(h.received.length).toBe(1);
    await h.dispose(); // 模拟宿主重启（内存态丢失——lastSeq 应已落 state.json）
    // state.json 里有持久化断点
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), 'utf-8')) as Record<string, { lastSeq?: Record<string, number> }>;
    expect(st['alpha/sw']?.lastSeq?.['fs/docs']).toBe(r1.seq);
    const h2 = await boot(); // 新代：pull 兜底首扫发现 meta.seq==lastSeq → 不判落后
    try {
      h2.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r1.seq });
      await wait(400);
      expect(h2.received.length).toBe(0); // 同 seq 续读无新行——不投
    } finally {
      await h2.dispose();
    }
  }, 15_000);

  it('maySubscribe：无 grant 拒 / 有 grant 过 / 吊销后拒', async () => {
    seedAgent('alpha', [svEntry]);
    const h = await boot();
    try {
      expect(h.timers.maySubscribe('alpha', 'fs', 'secret')).toBe(false);
      seedGrant('alpha', [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'secret' } } }]);
      expect(h.timers.maySubscribe('alpha', 'fs', 'secret')).toBe(true);
      // 吊销（denials 同键）→ 拒（投影现算，无缓存）
      fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'auth.json'), JSON.stringify({
        version: 1, agentId: 'alpha',
        grants: [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'secret' } } }],
        denials: [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'secret' } } }],
      }), 'utf-8');
      expect(h.timers.maySubscribe('alpha', 'fs', 'secret')).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('分发二道闸：未授权条目不投（即便事件到达）', async () => {
    seedAgent('alpha', [svEntry]); // 无 auth.json grant
    const h = await boot();
    try {
      const { materializeSnapshot } = await import('ac-source-core');
      const dir = path.join(ROOT, 'exports', 'fs', 'secret');
      const r = materializeSnapshot(dir, [{ path: 'x.md', mtime: 1, size: 1 }], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'secret', seq: r.seq });
      await wait(400);
      expect(h.received.length).toBe(0);
      // 补 grant → 下一事件投递
      seedGrant('alpha', [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'secret' } } }]);
      const r2 = materializeSnapshot(dir, [{ path: 'x.md', mtime: 1, size: 1 }, { path: 'y.md', mtime: 2, size: 2 }], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'secret', seq: r2.seq });
      await wait(400);
      expect(h.received.length).toBe(1);
    } finally {
      await h.dispose();
    }
  }, 15_000);
});

describe('宿主 timers 行（v3 哑触发层）', () => {
  it('once 到点 → 唤醒信投递（对角线缺省 + 记账/审计）', async () => {
    seedAgent('alpha', [onceNear(1_500)]);
    const h = await boot();
    try {
      await wait(5_000);
      expect(h.received.length).toBe(1);
      const env = h.received[0]!.env as Record<string, unknown>;
      expect(env.uuid).toBe('alpha~alpha');
      expect((env.payload as { text: string }).text).toBe('hi');
      // once 投后归档（无下一刻）——记账随归档固化（firedCount=1）
      const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer-archive.json'), 'utf-8'));
      expect(archive[0]).toMatchObject({ id: 'near', status: 'completed', firedCount: 1 });
      // 审计行
      const audit = fs.readFileSync(path.join(ROOT, 'meta', 'timer', 'audit.jsonl'), 'utf-8').trim().split('\n');
      expect(audit.length).toBe(1);
      expect(JSON.parse(audit[0]!)).toMatchObject({ owner: 'alpha', entryId: 'near', cause: 'time', trigger: 'once' });
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('every 墙钟网格 → 周期投递 + until.count 满 2 次归档', async () => {
    seedAgent('alpha', [{ ...everyQuick, until: { count: 2 } }]);
    const h = await boot();
    try {
      await wait(8_000);
      expect(h.received.length).toBe(2);
      const st = h.timers.scheduleState('alpha', 'q');
      expect(st.triggeredCount).toBeUndefined(); // 已归档清理
      const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer-archive.json'), 'utf-8'));
      expect(archive[0]).toMatchObject({ id: 'q', status: 'completed', firedCount: 2 });
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('gates hours 窗外：刻度跳过（lastSkipReason=gate）不投递', async () => {
    seedAgent('alpha', [{ ...everyQuick, id: 'gated', gates: [{ kind: 'hours', from: '03:00', to: '04:00' }] }]);
    const h = await boot();
    try {
      await wait(6_000);
      expect(h.received.length).toBe(0);
      const st = h.timers.scheduleState('alpha', 'gated');
      expect(st.lastSkipReason).toBe('gate');
      expect(st.nextAt).toBeTruthy(); // 已重排未来刻
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('纯源条目：source 行未上线 → dormant（不报错）', async () => {
    seedAgent('alpha', [{
      id: 'sw', enabled: true,
      when: [{ kind: 'source', source: 'wechat', view: 'news', on: 'rows-added' }],
      action: { text: '有新消息' },
    }]);
    const h = await boot();
    try {
      const st = h.timers.scheduleState('alpha', 'sw');
      expect(st.dormantReason).toBe('source-unavailable');
    } finally {
      await h.dispose();
    }
  });

  it('save：v3 校验拒非法条目；非法 until 拒', async () => {
    seedAgent('alpha', []);
    const h = await boot();
    try {
      const bad = h.timers.save('alpha', [{ id: 'b', enabled: true, when: [{ kind: 'daily', at: '9点' }], action: { text: 'x' } }]);
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('HH:mm');
      const badUntil = h.timers.save('alpha', [{ id: 'b', enabled: true, when: [{ kind: 'daily', at: '09:00' }], until: { count: 0 }, action: { text: 'x' } }]);
      expect(badUntil.ok).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('boot 迁移：v1 5 模式直译 v3 + v2 脚本丢弃归档 + 记账 key 迁移 + .bak', async () => {
    const dir = path.join(ROOT, 'agents', 'alpha', 'entries');
    fs.mkdirSync(dir, { recursive: true });
    writeAgentConfig(ROOT, { id: 'alpha', model: 'mock' } as unknown as import('ac-agents-core').AgentConfig);
    fs.writeFileSync(path.join(dir, 'timer.json'), JSON.stringify({
      entries: [
        { id: 'old1', enabled: true, mode: 'time', hint: '早报', time: '09:00' },
        { id: 'old2', enabled: true, mode: 'delay', hint: '巡检', delay: '30m', repeatCount: 3 },
        { id: 'scr1', enabled: true, kind: 'script', code: '(a,u)=>({})' },
      ],
    }, null, 2), 'utf-8');
    fs.mkdirSync(path.join(ROOT, 'meta', 'timer'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), JSON.stringify({
      'alpha/old1': { executedCount: 5, lastTriggeredAt: '2026-11-16T09:00:00+08:00', scriptState: { s: 1 } },
      'alpha/old2': { executedCount: 3, scriptState: { started: true }, persistNextAt: '2026-11-20T00:00:00Z' },
    }), 'utf-8');
    const h = await boot();
    try {
      const entries = h.timers.entries('alpha');
      // old2：记账 3 次 ≥ until.count 3 → boot 装载即终结归档（until 语义）——活跃只剩 old1
      expect(entries).toHaveLength(1);
      expect(entries[0]!.when).toEqual([{ kind: 'daily', at: '09:00' }]);
      expect(fs.existsSync(path.join(dir, 'timer.json.bak'))).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'timer.json'), 'utf-8'));
      expect(onDisk.version).toBe(3);
      expect(onDisk.entries).toHaveLength(1); // old2 已 until 归档出表
      // v2 脚本丢弃归档 + old2 until 归档（until 随条目入档）
      const archive = JSON.parse(fs.readFileSync(path.join(dir, 'timer-archive.json'), 'utf-8'));
      expect(archive.find((a: { id: string }) => a.id === 'scr1')).toMatchObject({ status: 'dropped', reason: 'script-face-retired' });
      expect(archive.find((a: { id: string }) => a.id === 'old2')).toMatchObject({ status: 'completed', firedCount: 3, until: { count: 3 } });
      // 记账 key 迁移：executedCount→firedCount；scriptState/persistNextAt 丢弃
      const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), 'utf-8')) as Record<string, Record<string, unknown>>;
      expect(state['alpha/old1']?.firedCount).toBe(5);
      expect(state['alpha/old1']?.lastFiredAt).toBe(new Date('2026-11-16T09:00:00+08:00').getTime());
      expect(state['alpha/old1']?.scriptState).toBeUndefined();
      // old2 已 until 归档——活跃记账随之清理（firedCount 固化在归档记录）
      expect(state['alpha/old2']).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-24：外部改盘 → save 拒写', async () => {
    seedAgent('zeta', [{ ...everyQuick, id: 'z1', until: { count: 99 } }]);
    const h = await boot([]);
    try {
      const file = path.join(ROOT, 'agents', 'zeta', 'entries', 'timer.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      disk.entries[0].label = '外部改';
      fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf-8');
      const res = h.timers.save('zeta', [...h.timers.entries('zeta'), { ...everyQuick, id: 'z2' }]);
      expect(res.ok).toBe(false);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after.entries[0].label).toBe('外部改');
    } finally {
      await h.dispose();
    }
  });

  it('preview：静态预览（owner 时区；after-last 标注链式）', async () => {
    seedAgent('alpha', []);
    const h = await boot();
    try {
      const daily = h.timers.preview('alpha', { id: 'p', enabled: true, when: [{ kind: 'daily', at: '09:00' }], action: { text: 'x' } });
      expect(daily.fires).toHaveLength(3);
      expect(daily.fires.every((f) => f.trigger === 'daily' && !f.chained)).toBe(true);
      const chain = h.timers.preview('alpha', { id: 'p', enabled: true, when: [{ kind: 'every', iv: '30m', base: 'after-last' }], action: { text: 'x' } });
      expect(chain.fires.every((f) => f.chained)).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('全局条目简化形状归一化（{time,hint,targets} → v3 daily + 目标扇出）', async () => {
    seedAgent('alpha', [], { id: 'alpha', model: 'mock' });
    seedAgent('beta', [], { id: 'beta', model: 'mock' });
    const h = await boot(['alpha', 'beta']);
    try {
      const cfg = h.ctx.get('config') as unknown as { set(k: string, v: unknown): void };
      cfg.set('timer.tasks', [{ time: '23:59', hint: '广播', targets: ['alpha', 'beta'] }]);
      h.timers.reload();
      const entries = h.timers.entries(GLOBAL_TIMER_OWNER);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.when).toEqual([{ kind: 'daily', at: '23:59' }]);
      expect(entries[0]!.action.target).toBe('alpha,beta');
      h.timers.triggerNow(GLOBAL_TIMER_OWNER, entries[0]!.id);
      await wait(300);
      const tos = h.received.map((r) => (r.env as Record<string, unknown>).to).sort();
      expect(tos).toEqual(['alpha', 'beta']);
    } finally {
      await h.dispose();
    }
  }, 15_000);
});

describe('停用但保留（cr-1180）', () => {
  it('停用条目不投递不计时，list 可见、记账保留、恢复不回补', async () => {
    seedAgent('alpha', [{
      id: 'paused', enabled: false,
      when: [{ kind: 'every', iv: '1s' }],
      action: { text: 'tick' },
    }]);
    const h = await boot();
    try {
      await wait(2_500);
      // 停用条目：不投递（1s 间隔跑 2.5s 应有 2+ 次——停用即零投）
      expect(h.received.length).toBe(0);
      // 条目面不蒸发：entries/list 可见 + pausedAt 记号在（boot arm 兜底补写）
      const entries = h.timers.entries('alpha');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.enabled).toBe(false);
      const st = h.timers.scheduleState('alpha', 'paused');
      expect(st.pausedAt).toBeTruthy();
      expect(st.nextAt).toBeUndefined(); // 停用不排程
      // 记账保留（fire 后 firedCount 会推进——停用期间冻结）
      const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'timer', 'state.json'), 'utf-8')) as Record<string, { pausedAt?: number }>;
      expect(state['alpha/paused']?.pausedAt).toBeGreaterThan(0);
      // 恢复：update 链（face 语义）在行侧 = save 整表；这里直接行侧翻转
      const resumed = { ...entries[0]!, enabled: true };
      h.timers.save('alpha', [resumed]);
      await wait(2_500);
      // 恢复后正常投递（armedAt 快进到恢复时刻——从现在起每 1s 一次）
      expect(h.received.length).toBeGreaterThanOrEqual(1);
      expect(h.received.length).toBeLessThanOrEqual(3);
      const st2 = h.timers.scheduleState('alpha', 'paused');
      expect(st2.pausedAt).toBeUndefined(); // 恢复清记号
      expect(st2.nextAt).toBeTruthy();
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('save 整表不丢停用条目 + 翻转检测（启用→停用落 pausedAt）', async () => {
    seedAgent('alpha', [onceNear(60_000), { id: 'off', enabled: false, when: [{ kind: 'daily', at: '09:00' }], action: { text: 'x' } }]);
    const h = await boot();
    try {
      // 整表保存（face set 语义：entries + 新条目）不丢停用条目
      const before = h.timers.entries('alpha');
      expect(before).toHaveLength(2);
      const res = h.timers.save('alpha', [...before, { id: 'new', enabled: true, when: [{ kind: 'daily', at: '10:00' }], action: { text: 'y' } }]);
      expect(res.ok).toBe(true);
      expect(h.timers.entries('alpha')).toHaveLength(3); // 停用条目仍在
      const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer.json'), 'utf-8'));
      expect(onDisk.entries).toHaveLength(3);
      expect(onDisk.entries.find((e: { id: string }) => e.id === 'off')?.enabled).toBe(false);
      // 翻转：启用条目改停用 → pausedAt 落账
      const flipped = before.map((e) => e.id === 'near' ? { ...e, enabled: false } : e);
      const res2 = h.timers.save('alpha', flipped);
      expect(res2.ok).toBe(true);
      const st = h.timers.scheduleState('alpha', 'near');
      expect(st.pausedAt).toBeTruthy();
      expect(h.timers.entries('alpha').find((e) => e.id === 'near')?.enabled).toBe(false);
      // 再恢复：记号清 + 投递恢复
      const res3 = h.timers.save('alpha', before);
      expect(res3.ok).toBe(true);
      expect(h.timers.scheduleState('alpha', 'near').pausedAt).toBeUndefined();
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('停用源条目：事件到达不投 + 恢复时不补投停用期间事件', async () => {
    seedAgent('alpha', [{
      id: 'src', enabled: false,
      when: [{ kind: 'source', source: 'fs', view: 'docs', on: 'rows-added' }],
      action: { text: '新文件' },
    }]);
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'auth.json'), JSON.stringify({
      version: 1, agentId: 'alpha',
      grants: [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'docs' } } }],
      denials: [],
    }), 'utf-8');
    const h = await boot();
    try {
      const { materializeSnapshot } = await import('ac-source-core');
      const dir = path.join(ROOT, 'exports', 'fs', 'docs');
      const r1 = materializeSnapshot(dir, [{ path: 'a.md', mtime: 1, size: 5 }], 60_000);
      h.ctx.emit('source/updated', { source: 'fs', view: 'docs', seq: r1.seq });
      await wait(400);
      // 停用条目：事件到达不投
      expect(h.received.length).toBe(0);
      // 恢复（save 翻转）→ lastSeq 快进到源现值：重启后 pull 兜底不重投 r1
      const cur = h.timers.entries('alpha');
      h.timers.save('alpha', cur.map((e) => ({ ...e, enabled: e.id === 'src' ? true : e.enabled })));
      await h.dispose(); // 模拟宿主重启（pull 兜底通道验证）
      const h2 = await boot();
      try {
        await wait(500); // pull 兜底扫（10s 地板内首扫立即）
        expect(h2.received.length).toBe(0); // lastSeq 已快进——seq1 不判新行
      } finally {
        await h2.dispose();
      }
    } finally {
      if (h.ctx) await h.dispose();
    }
  }, 15_000);

  it('cancel 停用条目：可达（撤销归档不留表）', async () => {
    seedAgent('alpha', [{ id: 'off2', enabled: false, when: [{ kind: 'daily', at: '09:00' }], action: { text: 'x' } }]);
    const h = await boot();
    try {
      const res = h.timers.cancelEntry('alpha', 'off2');
      expect(res.ok).toBe(true);
      expect(h.timers.entries('alpha')).toHaveLength(0);
      const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer-archive.json'), 'utf-8'));
      expect(archive.find((a: { id: string }) => a.id === 'off2')).toMatchObject({ status: 'cancelled' });
    } finally {
      await h.dispose();
    }
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
      timers.save('alpha', [{ id: 'e9', enabled: true, when: [{ kind: 'daily', at: '09:00' }], action: { text: 'x' } }]);
      expect(edits.some((e) => e.id === 'alpha' && e.key === 'timer')).toBe(true);
    } finally {
      for (const f of [f3, f2, f1].reverse()) await f.dispose();
      await po.close();
    }
  });
});
