// ============================================================
// M5.4 级联验收（D9 三步合一，药丸形）——真壳常驻形态：
//   宿主 spawn boot.ts → 三节拍 adopt（hint 真值）→ 邮局直投 →
//   壳幂等落账 → shutdown 优雅退出 + 锁释放。
//   崩溃接管：SIGKILL → 陈锁 → 重拉续跑。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, waitForShellReady, manageRoundTrip } from 'ac-envelope-core';
import { ConversationRegistry, ReachabilityTable, routeEnvelope } from 'ac-post-office';
import { adoptShell } from '../orchestrate.ts';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-host2-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
// 收割兜底（2026-10-17 事故防复发）：本文件 spawn 的一切壳进程登记在此，
// afterEach 按精确 pid 统一 kill——绝不扫进程表（宿主也是 node+boot.ts 形态，
// 子串匹配必误伤）。正常路径用例内已 shutdown，这里只兜漏网。
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function readReceived(agentId: string): Array<{ requestId: string; fresh: boolean; sender: string; text: string }> {
  try {
    return fs.readFileSync(path.join(ROOT, 'agents', agentId, 'received.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** M8.2：账本断言面（messages.jsonl 行——入站行 + settle 终稿行；
 *  cr-697 物化段行/注入行（source 标记）过滤——终稿层口径） */
function readLedgerRows(agentId: string, uuid: string): Array<{ role: string; content: string; agent_id: string; requestId?: string }> {
  try {
    return fs.readFileSync(path.join(ROOT, 'agents', agentId, 'sessions', uuid, 'messages.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
      // cr-974 v2：相位/run-end 行无 role——终稿层只看发言行
    .filter((r) => r.type !== 'session-header' && r.role !== undefined && r.source !== 'segment' && r.source !== 'inject');
  } catch {
    return [];
  }
}

describe('M5.4 药丸形端到端（D9 三步合一）', () => {
  // v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud——「先迁移」）
  function seedConfig(agentId: string): void {
    fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
    writeAgentConfig(ROOT, { id: agentId, model: 'mock' });
  }

  it('全链：spawn 壳常驻 → adopt（hint 真值）→ 直投 → conversation 全链（mock run + 账本终稿）→ shutdown 释放锁', async () => {
    seedConfig('alpha');
    const reach = new ReachabilityTable();
    // 注意：adoptShell 现形态不驻留进程——本用例手动 spawn 常驻壳并手动喂节拍。
    // M8.2：--mock-provider 1 = 确定性 mock（model 'mock' 路由命中——信封
    // 驱动全量 loop 真身跑通，终稿回声入账）。
    const child = spawn(process.execPath, ['--experimental-strip-types', BOOT,
      '--data-root', path.resolve(ROOT), '--agent-id', 'alpha', '--catalog', CATALOG,
      '--mock-provider', '1'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    spawned.push(child);
    child.stdout.on('data', () => {}); // cr-1129 批4：排水防反压（stdout 信号退役）
    // 就绪判据 = 锁 + probeIpc 实连（cr-1129 批4：stdout 信号退役）
    const hint = (await waitForShellReady(path.join(ROOT, 'agents', 'alpha'), 25_000)).transportHint;
    expect(hint).toContain('pipe'); // win32 named pipe 真值（posix 为 .sock）
    reach.markReachable('alpha', hint);
    // 邮局直投
    const env = makeEnvelope({
      uuid: 'u-m5-full', requestId: 'req-full', sender: 'user', to: 'alpha',
      payload: { text: '药丸全链' },
    });
    const instructions = routeEnvelope(env, { registry: new ConversationRegistry(), reach });
    const direct = instructions[0];
    if (direct.channel !== 'direct') throw new Error('路由未给直投指令');
    // M8.2：原生 net 连接 + 帧解码断言 ack（同一连接混走旁带流帧——
    // 壳→宿主单向，忽略；ack 帧按 requestId 配对）
    const { encodeFrame, FrameDecoder } = await import('ac-envelope-core');
    const net = await import('node:net');
    const sock = net.connect(hint);
    await new Promise<void>((res) => sock.once('connect', res));
    const replies: unknown[] = [];
    const decoder = new FrameDecoder();
    sock.on('data', (c: Buffer) => { replies.push(...decoder.push(c)); });
    sock.write(encodeFrame(direct.envelope));
    const awaitAck = async (want: { ack: string; fresh: boolean }): Promise<void> => {
      const dl = Date.now() + 8000;
      while (!replies.some((p) => JSON.stringify(p) === JSON.stringify(want))) {
        if (Date.now() > dl) throw new Error('ack 未到：' + JSON.stringify(replies));
        await new Promise((r2) => setTimeout(r2, 50));
      }
    };
    await awaitAck({ ack: 'req-full', fresh: true });
    sock.write(encodeFrame(env));
    await awaitAck({ ack: 'req-full', fresh: false });
    sock.destroy();
    // M8.2 conversation 全链断言：入站行 + mock 终稿行落账（等待 run 收束——
    // mock 即时但异步；轮询至终稿出现，超时 fail）
    const settleDeadline = Date.now() + 10_000;
    let rows = readLedgerRows('alpha', 'u-m5-full');
    while (rows.length < 2) {
      if (Date.now() > settleDeadline) throw new Error('run 终稿未落账：' + JSON.stringify(rows));
      await new Promise((r) => setTimeout(r, 100));
      rows = readLedgerRows('alpha', 'u-m5-full');
    }
    // cr-1251：datetime 注入不再寄生 session 门控（防重归 .day-anchor 私有状态）——
    // 精简树（无 ledger/session）注入照常，mock 回显最后 user 行 = 日期锚（包裹形）
    expect(rows.map((r) => r.content)).toEqual(['药丸全链', expect.stringMatching(/^\[mock 回复 <system-reminder>\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]<\/system-reminder>\]$/)]);
    expect(rows[1]).toMatchObject({ agent_id: 'alpha', requestId: 'reply-req-full' });
    // shutdown 优雅退出 + 锁释放
    await manageRoundTrip(hint, { ctrl: 'system', op: 'shutdown' }, 5_000);
    const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(ROOT, 'agents', 'alpha', 'activation.lock'))).toBe(false);
  }, 30_000);

  it('崩溃接管：SIGKILL 常驻壳 → 陈锁 → 重拉同 agent 续跑（新 bootId 接管）', async () => {
    seedConfig('gamma');
    const mk = () => {
      const c = spawn(process.execPath, ['--experimental-strip-types', BOOT,
        '--data-root', path.resolve(ROOT), '--agent-id', 'gamma', '--catalog', CATALOG],
        { stdio: ['pipe', 'pipe', 'inherit'] });
      spawned.push(c);
      return c;
    };
    const first = mk();
    first.stdout.on('data', () => {});
    const lock1 = await waitForShellReady(path.join(ROOT, 'agents', 'gamma'), 25_000);
    const bootId1 = lock1.bootId;
    // SIGKILL 崩溃（不跑任何 handler——陈锁）
    first.kill('SIGKILL');
    await new Promise<void>((res) => first.on('exit', () => res()));
    expect(fs.existsSync(path.join(ROOT, 'agents', 'gamma', 'activation.lock'))).toBe(true); // 陈锁残留
    // 重拉：接管陈锁续跑
    const second = mk();
    second.stdout.on('data', () => {});
    const lock2 = await waitForShellReady(path.join(ROOT, 'agents', 'gamma'), 25_000);
    const bootId2 = lock2.bootId;
    expect(bootId2).not.toBe(bootId1);
    // 陈锁副本留证
    expect(fs.existsSync(path.join(ROOT, 'agents', 'gamma', 'activation.lock.stale-' + bootId1))).toBe(true);
    await manageRoundTrip(lock2.transportHint, { ctrl: 'system', op: 'shutdown' }, 5_000);
    const code = await new Promise<number | null>((res) => second.on('exit', (c) => res(c)));
    expect(code).toBe(0);
  }, 45_000);
});
