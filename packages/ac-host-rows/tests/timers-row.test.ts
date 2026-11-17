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
import { makeTimersHostRow, GLOBAL_TIMER_OWNER, HostTimersService, gateStderrTail } from '../src/timers-row.ts';
import { writeAgentConfig } from 'ac-agents-core';

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
  writeAgentConfig(ROOT, config as unknown as import('ac-agents-core').AgentConfig); // cr-1036 批3：v3 写口
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
    seedAgent('__preset_x__', [], { id: '__preset_x__', model: 'mock' });
    seedAgent('virt', [], { id: 'virt', virtual: true });
    seedAgent('nomodel', [], { id: 'nomodel' });
    const h = await boot(['alpha', 'beta']);
    try {
      h.timers.save(GLOBAL_TIMER_OWNER, [{ id: 'g1', enabled: true, mode: 'delay', hint: '广播', delay: '1h' }]);
      h.timers.triggerNow(GLOBAL_TIMER_OWNER, 'g1');
      await new Promise((r) => setTimeout(r, 150));
      const tos = h.received.map((r) => (r.env as Record<string, unknown>).to).sort();
      expect(tos).toEqual(['alpha', 'beta']); // 预设/virtual/无 model 出局
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

  it('ISSUE-20：arm 幂等——宿主重启不重置 delay 周期（锚点仍是上次触发）', async () => {
    seedAgent('alpha', [{ id: 'e10', enabled: true, mode: 'delay', hint: '轮巡', delay: '30m' }]);
    // 预置状态：10 分钟前起排的 30m 周期 → 下一档应在 ~20 分钟后（而不是整 30 分钟）
    const now = Date.now();
    fs.mkdirSync(path.join(ROOT, 'timer'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'timer', 'state.json'), JSON.stringify({
      _heartbeat: { lastTriggeredAt: new Date(now - 30_000).toISOString() },
      'alpha/e10': { startedAt: new Date(now - 10 * 60_000).toISOString(), totalDelayMs: 30 * 60_000, executedCount: 3 },
    }), 'utf-8');
    const h1 = await boot();
    const next1 = h1.timers.scheduleState('alpha', 'e10').nextAt;
    await h1.dispose();
    // 连续重启（两次 boot）：nextAt 必须基本不变——旧写法每次 arm 把周期从头计，会顺延
    const h2 = await boot();
    try {
      const next2 = h2.timers.scheduleState('alpha', 'e10').nextAt;
      expect(next1).toBeTruthy();
      expect(next2).toBeTruthy();
      expect(Math.abs(new Date(next2!).getTime() - new Date(next1!).getTime())).toBeLessThan(2_000);
      const remain = new Date(next2!).getTime() - Date.now();
      expect(remain).toBeGreaterThan(17 * 60_000);
      expect(remain).toBeLessThan(21 * 60_000);
    } finally {
      await h2.dispose();
    }
  });

  it('ISSUE-22：按策略跳过不写 lastAt，但记 lastSkipReason/skipStreak（可分辨「未触发」的三因）', async () => {
    // 造一个「当前时刻不在其中」的单分钟窗口（DEFAULT_TZ = Asia/Shanghai 墙钟）
    const sh = new Date(Date.now() + 8 * 3600_000);
    const nowMin = sh.getUTCHours() * 60 + sh.getUTCMinutes();
    const [a, b] = nowMin <= 1437 ? [nowMin + 1, nowMin + 2] : [0, 1];
    const pad = (n: number) => String(n).padStart(2, '0');
    const win = `${pad(Math.floor(a / 60))}:${pad(a % 60)}-${pad(Math.floor(b / 60))}:${pad(b % 60)}`;
    seedAgent('alpha', [{ id: 'e11', enabled: true, mode: 'delay', hint: '夜静默', delay: '1s', activeHours: win }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 1_600)); // 到点 → 活动窗口外 → 跳过
      const st = h.timers.scheduleState('alpha', 'e11');
      expect(st.lastAt).toBeUndefined(); // 跳过不算触发
      expect(st.lastSkipReason).toBe('activeHours');
      expect(st.skipStreak).toBeGreaterThanOrEqual(1);
      expect(h.received.length).toBe(0); // 未投递
      expect(st.nextAt).toBeTruthy(); // 但排程继续
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-22：gate 退出码 1 = 预期静默（gate），其它非零 = gate-error（可分辨「gate 崩了」）', async () => {
    seedAgent('alpha', [{ id: 'e12', enabled: true, mode: 'delay', hint: '静默', delay: '1s', gate: 'exit 1' }]);
    seedAgent('beta', [{ id: 'e13', enabled: true, mode: 'delay', hint: '崩', delay: '1s', gate: 'exit 2' }]);
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 1_800));
      // 约定码 1：预期静默——与旧语义一致，不进 lastAt
      const s1 = h.timers.scheduleState('alpha', 'e12');
      expect(s1.lastSkipReason).toBe('gate');
      expect(s1.lastAt).toBeUndefined();
      // 其它非零：gate 自身故障——仍跳过，但必须与「预期静默」分格
      const s2 = h.timers.scheduleState('beta', 'e13');
      expect(s2.lastSkipReason).toBe('gate-error');
      expect(s2.lastAt).toBeUndefined();
      expect(h.received.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("ISSUE-22：gateOnError='run' 时 gate 故障 fail-open（照投递，但留 lastGateErrorAt）", async () => {
    seedAgent('gamma', [{
      id: 'e14', enabled: true, mode: 'delay', hint: '优化型 gate', delay: '1s',
      gate: 'exit 2', gateOnError: 'run',
    }]);
    const h = await boot(['gamma']);
    try {
      await new Promise((r) => setTimeout(r, 1_800));
      // 照常投递（脚本侧静默由业务自己兜），不因 gate 崩了而永久停摆
      expect(h.received.length).toBe(1);
      const st = h.timers.scheduleState('gamma', 'e14');
      expect(st.lastAt).toBeTruthy();
      expect(st.lastSkipReason).toBeUndefined(); // 没跳过
      expect(st.lastGateErrorAt).toBeTruthy();   // 但故障留痕
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-24：storeState 让「磁盘已变、内存未重载」可见（configStale）', async () => {
    seedAgent('kappa', [{ id: 'k1', enabled: true, mode: 'delay', hint: 'h', delay: '30m' }]);
    const h = await boot([]);
    try {
      expect(h.timers.storeState('kappa').configStale).toBeUndefined(); // 启动时一致
      // 外部改盘（模拟直接用编辑器补字段）
      const file = path.join(ROOT, 'agents', 'kappa', 'entries', 'timer.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      disk.entries[0].gate = 'exit 0';
      fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf-8');
      // 内存视图未变、但能看出「磁盘已变」
      expect(h.timers.storeState('kappa').configStale).toBe(true);
      expect(h.timers.entries('kappa')[0]?.gate).toBeUndefined(); // list 仍是旧视图
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-24：内存侧补默认值不会造成假冲突（基准与比较都取磁盘原样）', async () => {
    // 磁盘条目只有最小键集（没有 gateOnError / repeatCount 等缺省字段）
    seedAgent('theta', [{ id: 'w1', enabled: true, mode: 'delay', hint: 'h', delay: '30m' }]);
    const h = await boot([]);
    try {
      // 模拟内存副本被补默认值（这类加工将来可能出现在任何消费方）
      const mem = h.timers.entries('theta');
      const raw = mem[0] as unknown as Record<string, unknown>;
      raw.gateOnError = 'skip';
      raw.repeatCount = 0;
      const res = h.timers.save('theta', mem);
      // 关键：不能因为「内存多了默认键」就判冲突——那会变成每次 set 都被拒
      expect(res.ok).toBe(true);
      // 写盘后自愈：磁盘与内存一致，再存一次也不冲突
      const again = h.timers.save('theta', h.timers.entries('theta'));
      expect(again.ok).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-24：多次 save 幂等（自己的写入不会被误判为外部改动）', async () => {
    seedAgent('iota', [{ id: 'v1', enabled: true, mode: 'delay', hint: 'h', delay: '30m' }]);
    const h = await boot([]);
    try {
      for (let i = 0; i < 3; i++) {
        const res = h.timers.save('iota', h.timers.entries('iota'));
        expect(res.ok, `第 ${i + 1} 次 save 应成功`).toBe(true);
      }
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-24：磁盘被外部改过 → save 拒写（不整表覆盖外部改动），并以磁盘为准重载', async () => {
    seedAgent('zeta', [{ id: 'z1', enabled: true, mode: 'delay', hint: '原', delay: '30m' }]);
    const h = await boot([]);
    try {
      const file = path.join(ROOT, 'agents', 'zeta', 'entries', 'timer.json');
      // 外部改盘：加一个 gate 字段（模拟 admin 直接编辑文件），同时保证内容确实变了
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      disk.entries[0].gate = 'exit 0';
      disk.entries[0].gateOnError = 'run';
      fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf-8');
      // 此时宿主内存里仍是旧条目 → set 会用 stale 副本整表覆盖
      const res = h.timers.save('zeta', [...h.timers.entries('zeta'), { id: 'z2', enabled: true, mode: 'delay', hint: '新', delay: '1h' } as never]);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('外部修改');
      // 关键：磁盘上的 gate 没被抹掉，新条目也没写进去
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after.entries.find((e: { id: string }) => e.id === 'z1')?.gate).toBe('exit 0');
      expect(after.entries.find((e: { id: string }) => e.id === 'z2')).toBeUndefined();
      // 内存已按磁盘重载：list 能看到 gate
      expect(h.timers.entries('zeta')[0]?.gate).toBe('exit 0');
      // 重试一次即成功（此时基准已对齐）
      const retry = h.timers.save('zeta', [...h.timers.entries('zeta'), { id: 'z2', enabled: true, mode: 'delay', hint: '新', delay: '1h' } as never]);
      expect(retry.ok).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-24：内容未变但键序不同 → 不算冲突（稳定序列化）', async () => {
    seedAgent('eta', [{ id: 'y1', enabled: true, mode: 'delay', hint: 'h', delay: '30m' }]);
    const h = await boot([]);
    try {
      const file = path.join(ROOT, 'agents', 'eta', 'entries', 'timer.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // 只重排键序、不改内容
      const reordered = { entries: disk.entries.map((e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).reverse())) };
      fs.writeFileSync(file, JSON.stringify(reordered, null, 2), 'utf-8');
      const res = h.timers.save('eta', h.timers.entries('eta'));
      expect(res.ok).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('gate 四码语义：20=静默；1+stderr空=静默；1+stderr非空=崩溃(gate-error)；其它=gate-error', async () => {
    // 造三个 gate 脚本文件（避开 cmd.exe 的嵌套引号问题）
    // 用相对路径 + 引号（顺带覆盖 Windows 引号陷阱：cmd /c 需 verbatim args）
    const mk = (name: string, body: string) => {
      fs.writeFileSync(path.join(ROOT, name), body, 'utf-8');
      return `node "${name}"`;
    };
    const gSilent20 = mk('g20.js', 'process.exit(20);');
    const gSilent1 = mk('g1.js', 'process.exit(1);');
    const gCrash1 = mk('gc.js', "process.stderr.write('boom\\n'); process.exit(1);");
    const gOther = mk('g3.js', 'process.exit(3);');
    seedAgent('a20', [{ id: 'x20', enabled: true, mode: 'delay', hint: 'h', delay: '1s', gate: gSilent20 }]);
    seedAgent('a1', [{ id: 'x1', enabled: true, mode: 'delay', hint: 'h', delay: '1s', gate: gSilent1 }]);
    seedAgent('ac', [{ id: 'xc', enabled: true, mode: 'delay', hint: 'h', delay: '1s', gate: gCrash1 }]);
    seedAgent('a3', [{ id: 'x3', enabled: true, mode: 'delay', hint: 'h', delay: '1s', gate: gOther }]);
    const h = await boot([]);
    try {
      await new Promise((r) => setTimeout(r, 2_500));
      expect(h.timers.scheduleState('a20', 'x20').lastSkipReason).toBe('gate');
      expect(h.timers.scheduleState('a1', 'x1').lastSkipReason).toBe('gate');
      // 关键：1 + traceback 不能被当成「预期静默」
      expect(h.timers.scheduleState('ac', 'xc').lastSkipReason).toBe('gate-error');
      expect(h.timers.scheduleState('a3', 'x3').lastSkipReason).toBe('gate-error');
      // 退出码留痕：静默也能区分「脚本声明的 20」与「旧契约的 1」
      expect(h.timers.scheduleState('a20', 'x20').lastGateCode).toBe(20);
      expect(h.timers.scheduleState('a1', 'x1').lastGateCode).toBe(1);
      expect(h.received.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('gate 故障归因：stderr 抽取（[gate-error] 不能被丢）+ 故障走 gate-error 格', async () => {
    // 末行抽取（截断保护）
    expect(gateStderrTail("warning\n[gate-error] boom\r\n")).toBe('[gate-error] boom');
    expect(gateStderrTail('')).toBe('');
    expect(gateStderrTail(undefined)).toBe('');
    expect(gateStderrTail('x'.repeat(500)).length).toBe(401); // 400 + 省略号
    // 真跑一次 gate（脚本文件形态，避开 shell 嵌套引号）：退出码 3 → gate-error
    fs.writeFileSync(path.join(ROOT, 'g-err.js'), "process.stderr.write('[gate-error] boom\\n'); process.exit(3);", 'utf-8');
    seedAgent('eps', [{ id: 'e16', enabled: true, mode: 'delay', hint: 'x', delay: '1s', gate: `node "g-err.js"` }]);
    const h = await boot([]);
    try {
      await new Promise((r) => setTimeout(r, 1_800));
      const st = h.timers.scheduleState('eps', 'e16');
      expect(st.lastSkipReason).toBe('gate-error');
      expect(st.lastGateErrorAt).toBeTruthy();
    } finally {
      await h.dispose();
    }
  });

  it('ISSUE-23：delay 周期串非法 → 停排并告警（旧写法 ?? 0 会忙循环狂投递）', async () => {
    // 注意 '30 mi' 不算非法——parseInterval 的正则会宽松命中前缀 'm'（30 分钟）
    seedAgent('delta', [{ id: 'e15', enabled: true, mode: 'delay', hint: '坏周期', delay: 'thirty-minutes' }]);
    const h = await boot(['delta']);
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      // 只可能因「首次 arm 的 nextDelayOf 返回 null」而完全没排程——关键是不能刷屏投递
      expect(h.received.length).toBeLessThanOrEqual(1);
      const st = h.timers.scheduleState('delta', 'e15');
      expect(st.nextAt).toBeUndefined(); // 停排（不再挂下一档）
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