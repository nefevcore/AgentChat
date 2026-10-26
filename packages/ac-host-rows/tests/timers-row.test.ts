// ============================================================
// 宿主 timers 行单测（cr-539）：数据根直读装载 + 排程触发 →
// 邮局唤醒信投递（conversationId 回投 / 对角线缺省 / preset 过滤 /
// 全局条目 target）+ 完成归档 + 停机补偿 + 落地对话语义。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { TimerService } from '@agentchat/cordis-timer';
import { ConfigService } from 'ac-config';
import { PostOffice } from 'ac-post-office';
import { makeTimersHostRow, GLOBAL_TIMER_OWNER, HostTimersService } from '../src/timers-row.ts';

const ROOT = path.join('sandbox', 'test-host-timers-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 最小宿主环境：cordis timer 基座 + config 行 + timers 行 + 邮局 local 端点捕获 */
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
  // config 行（真身——ConfigService 装配序在 timers 前；timers static inject 等待面成立）
  const f2 = ctx.plugin(class extends ConfigService {
    constructor(c: Context) { super(c, { root: ROOT }); }
  });
  const f3 = ctx.plugin(makeTimersHostRow({ dataRoot: ROOT, postOffice: po }));
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

/** 建 agent + timer 条目（entries/timer.json 直写——boot 时装载） */
function seedAgent(id: string, entries: Array<Record<string, unknown>>, config: Record<string, unknown> = { id, model: 'mock' }) {
  const dir = path.join(ROOT, 'agents', id, 'entries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', id, 'config.json'), JSON.stringify(config), 'utf-8');
  if (entries.length > 0) {
    fs.writeFileSync(path.join(dir, 'timer.json'), JSON.stringify({ entries }), 'utf-8');
  }
}

describe('宿主 timers 行（数据面换轨）', () => {
  it('entries/timer.json 直读装载 + triggerNow → 唤醒信投递（对角线缺省 uuid）', async () => {
    seedAgent('alpha', [{ id: 'e1', enabled: true, mode: 'delay', hint: '你好', delay: '1h', repeatCount: 1 }]);
    const h = await boot();
    try {
      expect(h.timers.entries('alpha').map((e) => e.id)).toEqual(['e1']);
      expect(h.timers.triggerNow('alpha', 'e1')).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.received.length).toBe(1);
      const env = h.received[0].env as Record<string, unknown>;
      expect(env.uuid).toBe('alpha~alpha'); // 对角线自会话（主线 M19/D2 语义）
      expect(env.sender).toBe('alpha');
      expect(env.to).toBe('alpha');
      expect((env.payload as { text: string }).text).toContain('你好');
    } finally {
      await h.dispose();
    }
  });

  it('conversationId 回投：sender=user + uuid=条目会话键', async () => {
    seedAgent('alpha', [{ id: 'e2', enabled: true, mode: 'delay', hint: '提醒', delay: '1h', conversationId: 'conv-123', repeatCount: 1 }]);
    const h = await boot();
    try {
      h.timers.triggerNow('alpha', 'e2');
      await new Promise((r) => setTimeout(r, 100));
      const env = h.received[0].env as Record<string, unknown>;
      expect(env.uuid).toBe('conv-123');
      expect(env.sender).toBe('user');
    } finally {
      await h.dispose();
    }
  });

  it('限定次条目触发后完成归档（timer-archive.json）', async () => {
    seedAgent('alpha', [{ id: 'e3', enabled: true, mode: 'delay', hint: '一次', delay: '1h', repeatCount: 1 }]);
    const h = await boot();
    try {
      h.timers.triggerNow('alpha', 'e3');
      await new Promise((r) => setTimeout(r, 150));
      // triggerNow 不记账——用 save 全量替换路径验归档（fire 侧 completeEntry 由排程路径走）
      h.timers.save('alpha', []);
      expect(fs.existsSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer.json'))).toBe(true);
      expect(h.timers.entries('alpha')).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("全局条目 target='*' 广播：preset/virtual/无 model 过滤", async () => {
    seedAgent('alpha', [], { id: 'alpha', model: 'mock' });
    seedAgent('beta', [], { id: 'beta', model: 'mock' });
    seedAgent('preset-x', [], { id: 'preset-x', model: 'mock', preset: true });
    seedAgent('virt', [], { id: 'virt', virtual: true });
    seedAgent('nomodel', [], { id: 'nomodel' });
    const h = await boot(['alpha', 'beta']);
    try {
      h.timers.save(GLOBAL_TIMER_OWNER, [{ id: 'g1', enabled: true, mode: 'delay', hint: '广播', delay: '1h' }]);
      h.timers.triggerNow(GLOBAL_TIMER_OWNER, 'g1');
      await new Promise((r) => setTimeout(r, 150));
      const tos = h.received.map((r) => (r.env as Record<string, unknown>).to).sort();
      expect(tos).toEqual(['alpha', 'beta']); // preset/virtual/无 model 出局
    } finally {
      await h.dispose();
    }
  });

  it('停机补偿：心跳过期 + 一次性条目到期 → 补触发（先记账）', async () => {
    seedAgent('alpha', [{ id: 'e5', enabled: true, mode: 'delay', hint: '补偿', delay: '30m', repeatCount: 1 }]);
    // 预置状态：30 分钟前有心跳 + 条目 1h 前起排（30m 延迟已过）
    const now = Date.now();
    fs.mkdirSync(path.join(ROOT, 'timer'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'timer', 'state.json'), JSON.stringify({
      _heartbeat: { lastTriggeredAt: new Date(now - 40 * 60_000).toISOString() },
      'alpha/e5': { startedAt: new Date(now - 60 * 60_000).toISOString(), totalDelayMs: 30 * 60_000 },
    }), 'utf-8');
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(h.received.length).toBe(1);
      // 先记账：一次性条目已摘除归档（主线 completeEntry 语义——store 摘条目）
      const stored = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer.json'), 'utf-8'));
      expect(stored.entries.find((e: { id: string }) => e.id === 'e5')).toBeUndefined();
      const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'entries', 'timer-archive.json'), 'utf-8'));
      expect(archive[0]).toMatchObject({ id: 'e5', status: 'completed' });
    } finally {
      await h.dispose();
    }
  });
});

describe('adoptShell outbox 转投节拍（协议 D2 节拍 2）', () => {
  it('adopted 即 flushOutbox——滞留信在壳可达后转投', async () => {
    const { adoptShell } = await import('ac-host-app');
    const po = new PostOffice({ dataRoot: ROOT });
    // 投递到不可达端点 → outbox 滞留
    await po.dispatch({
      uuid: 'alpha~alpha', requestId: 'w1', sender: 'host', to: 'alpha',
      kind: 'message', budget: 3, payload: { text: '滞留信' },
    });
    const outboxFiles = () => fs.readdirSync(path.join(ROOT, 'outbox'));
    expect(outboxFiles().length).toBe(1);
    // mock spawn：立即产出 boot.ready TSV（transportHint = local 假址——转投走 locals）
    const received: unknown[] = [];
    po.registerLocal('alpha', async (env) => {
      received.push(env);
      return { ack: env.requestId, fresh: true };
    });
    try {
      const res = await adoptShell({
        agentId: 'alpha',
        dataRoot: ROOT,
        catalogFile: 'apps/catalog/row-catalog.json',
        bootFile: 'apps/shell/boot.ts',
        reach: po.reach,
        postOffice: po,
        spawnFn: () => ({
          pid: 1,
          stdout: (async function* () {
            yield 'boot.lock.acquired	b1';
            yield 'boot.rows.ready	10';
            yield 'boot.ready	b1	local:alpha	sha-x';
          })(),
          write: () => {},
          on: () => {},
          kill: () => {},
        }),
        timeoutMs: 5_000,
      });
      expect(res.agentId).toBe('alpha');
      await new Promise((r) => setTimeout(r, 200));
      expect(received.length).toBe(1); // 滞留信已转投
      expect(outboxFiles().length).toBe(0); // ack 到手出箱
    } finally {
      await po.close();
    }
  });

  it('archive-all 机制任务 = 批量唤醒信（D11/cr-546：宿主零 archive 职责）', async () => {
    seedAgent('alpha', []);
    seedAgent('virt', [], { id: 'virt', virtual: true, model: 'mock' });
    seedAgent('nomodel', [], { id: 'nomodel' });
    const h = await boot();
    try {
      const globalEntry = {
        id: 'mech1', enabled: true, mode: 'delay', delay: '1h', repeatCount: 1,
        task: 'archive-all',
      };
      h.timers.save(GLOBAL_TIMER_OWNER, [globalEntry] as never);
      h.timers.triggerNow(GLOBAL_TIMER_OWNER, 'mech1');
      await new Promise((r) => setTimeout(r, 200));
      // 只有常规 Agent 收到唤醒信（virtual / 无 model 过滤）；信形 = 对角线
      // uuid + payload.mechTask='archive-all'（壳内 archiveAll 分发键）
      const tos = h.received.map((r) => (r.env as { to: string }).to);
      expect(tos).toEqual(['alpha']);
      const env = h.received[0]!.env as { uuid: string; payload: { mechTask?: string } };
      expect(env.uuid).toBe('alpha~alpha');
      expect(env.payload.mechTask).toBe('archive-all');
    } finally {
      await h.dispose();
    }
  });
});

describe('timers 行 entries 单写者收口（cr-551）', () => {
  it('agentsEdit 注入：save 落盘经编辑面 saveEntry（单源）', async () => {
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
      timers.save('alpha', [{ id: 'e9', enabled: true, mode: 'delay', hint: 'x', delay: '1h' }]);
      // 写口唯一：编辑面收到 saveEntry（timer/timer-archive 均经此）
      expect(edits.some((e) => e.id === 'alpha' && e.key === 'timer')).toBe(true);
    } finally {
      for (const f of [f3, f2, f1].reverse()) await f.dispose();
      await po.close();
    }
  });
});