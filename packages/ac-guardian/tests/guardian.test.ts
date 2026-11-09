// ============================================================
// ac-guardian 单测（M4.3 验收）：三节拍 adopt / 心跳 3 拍判死 /
// idle 收割 / 崩溃退避熔断 / 正常退出清零
// ============================================================
import { describe, it, expect } from 'vitest';
import { ShellWarden, DEFAULT_GUARDIAN_CONFIG } from '../src/guardian.ts';

const cfg = { ...DEFAULT_GUARDIAN_CONFIG, heartbeatIntervalMs: 1000, idleExitMs: 60_000 };

function adopted(agentId = 'alpha', now = 0): ShellWarden {
  const w = new ShellWarden(agentId, cfg);
  w.feedLine('boot.lock.acquired\tb1\tT', now);
  w.feedLine('boot.rows.ready\tb1\t20', now);
  w.feedLine('boot.ready\tb1\t/data/ipc/alpha.sock', now);
  return w;
}

describe('拉起三节拍', () => {
  it('rows-ready 事件 + boot.ready → adopted（hint 携带）', () => {
    const w = adopted();
    expect(w.isAdopted()).toBe(true);
    expect(w.emitted()).toEqual([
      { type: 'rows-ready', agentId: 'alpha', bootId: 'b1', rows: 20 },
      { type: 'adopted', agentId: 'alpha', bootId: 'b1', transportHint: '/data/ipc/alpha.sock' },
    ]);
  });
});

describe('心跳监视', () => {
  it('ping 重置；3 拍丢失判死（declare-dead）', () => {
    const w = adopted();
    // 正常心跳：每拍内 ping
    w.feedLine('guardian.ping\tT', 900);
    expect(w.tick(1500)).toBe('ok');
    // 断心跳：miss 累计
    expect(w.tick(2100)).toBe('ok'); // miss 1
    expect(w.tick(3100)).toBe('ok'); // miss 2
    expect(w.tick(4100)).toBe('declare-dead'); // miss 3 → 判死
    expect(w.emitted().at(-1)).toMatchObject({ type: 'declared-dead', reason: 'heartbeat-lost' });
  });
});

describe('socket 探测喂活（换代接管 D1 双源）', () => {
  it('noteProbe = 等价心跳：stdout 静默、探测在喂 → 不判死', () => {
    const w = adopted();
    // 无 ping，仅探测喂活（每拍一次）
    w.noteProbe(900);
    expect(w.tick(1500)).toBe('ok');
    w.noteProbe(1900);
    expect(w.tick(2500)).toBe('ok');
    w.noteProbe(2900);
    expect(w.tick(3500)).toBe('ok');
    expect(w.emitted().some((ev) => ev.type === 'declared-dead')).toBe(false);
  });
  it('双源齐断才判死：探测也停 → 跨窗 declare-dead', () => {
    const w = adopted();
    w.noteProbe(900);
    expect(w.tick(2100)).toBe('ok'); // miss 1
    expect(w.tick(3100)).toBe('ok'); // miss 2
    expect(w.tick(4100)).toBe('declare-dead'); // miss 3
  });
  it('busy 探测兼喂活跃时钟；非 busy 不喂（idle 收割不因探测成功而失效）', () => {
    const idleCfg = { ...cfg, idleExitMs: 5000 };
    const w = new ShellWarden('alpha', idleCfg);
    w.feedLine('boot.ready	b1	h', 0);
    // 非 busy 探测：心跳在喂但 idle 照走
    w.noteProbe(4500);
    expect(w.tick(9600)).toBe('kill-idle');
    const w2 = new ShellWarden('alpha', idleCfg);
    w2.feedLine('boot.ready	b1	h', 0);
    w2.noteProbe(4500, true); // busy → 活跃重置
    expect(w2.tick(9400)).toBe('ok'); // 4500 起算 5000ms 未到
    expect(w2.tick(9600)).toBe('kill-idle'); // busy 之后无新活跃 → 收割照走
  });
  it('未 adopt / 已终结时探测不喂（拉起窗与判死后零副作用）', () => {
    const w = new ShellWarden('alpha', cfg);
    w.noteProbe(500); // 未 adopt——无效果
    w.feedLine('boot.ready	b1	h', 1000);
    expect(w.tick(1100)).toBe('ok');
    expect(w.tick(2100)).toBe('ok'); // miss 1（500 的喂活未计入）
    expect(w.tick(3100)).toBe('ok'); // miss 2
    expect(w.tick(4100)).toBe('declare-dead');
  });
});

describe('idle-exit 收割', () => {
  it('空闲超 idleExitMs → kill-idle；run 节拍重置计时', () => {
    const idleCfg = { ...cfg, idleExitMs: 5000 };
    const w = new ShellWarden('alpha', idleCfg);
    w.feedLine('boot.ready\tb1\th', 0);
    expect(w.tick(4000)).toBe('ok');
    // run 活跃重置 + 心跳保持（本用例只测 idle 面）
    w.feedLine('guardian.ping\tT', 4500);
    w.feedLine('run.started\trun1\tconv1', 4500);
    expect(w.tick(8000)).toBe('ok'); // 4500 起算 5000ms 未到
    expect(w.tick(9600)).toBe('kill-idle');
    expect(w.emitted().at(-1)).toMatchObject({ type: 'declared-dead', reason: 'idle-exit' });
  });
});

describe('崩溃退避熔断', () => {
  it('退出码 42 = 安全重启（cr-629）：立即 respawn、崩溃计数归零——连续安全重启不熔断', () => {
    const w = adopted();
    expect(w.shellExited(1, 100)).toBe('respawn');
    expect(w.shellExited(42, 200)).toBe('respawn'); // 有意重启不计崩溃
    expect(w.shellExited(1, 300)).toBe('respawn'); // 计数已被 42 归零（1→0→1）
    expect(w.shellExited(42, 400)).toBe('respawn');
    expect(w.shellExited(42, 500)).toBe('respawn');
    expect(w.isBroken()).toBe(false);
  });
  it('60s 窗内连续 ≥3 → broken（不再自动拉起）；正常退出清零', () => {
    const w = adopted();
    expect(w.shellExited(1, 100)).toBe('respawn');
    expect(w.shellExited(1, 200)).toBe('respawn');
    expect(w.shellExited(1, 300)).toBe('broken');
    expect(w.isBroken()).toBe(true);
    // 熔断后再退出 = done（不重拉）
    expect(w.shellExited(1, 400)).toBe('done');
    // 对照：正常退出清零计数
    const w2 = adopted();
    expect(w2.shellExited(1, 100)).toBe('respawn');
    expect(w2.shellExited(0, 200)).toBe('done');
    expect(w2.shellExited(1, 300)).toBe('respawn');
    expect(w2.shellExited(1, 400)).toBe('respawn');
    expect(w2.shellExited(1, 500)).toBe('broken');
  });
  it('窗外崩溃不计入连续数（F 表 60s 窗——窗滚动重置计数）', () => {
    const w = adopted();
    expect(w.shellExited(1, 100)).toBe('respawn');
    // 第二次崩在窗外（100 + 61s）→ 窗重置从头累计
    expect(w.shellExited(1, 61_100)).toBe('respawn');
    expect(w.shellExited(1, 61_200)).toBe('respawn');
    // 窗内第三次才熔断：61_100 起窗的第 2 崩，未到 3
    expect(w.shellExited(1, 61_300)).toBe('broken');
  });
  it('三崩散布超窗 → 不熔断（每崩各自起新窗）', () => {
    const w = adopted();
    expect(w.shellExited(1, 0)).toBe('respawn');
    expect(w.shellExited(1, 120_000)).toBe('respawn'); // 窗外 → 计数重置为 1
    expect(w.shellExited(1, 240_000)).toBe('respawn'); // 再窗外 → 重置为 1
    expect(w.isBroken()).toBe(false);
  });
});
