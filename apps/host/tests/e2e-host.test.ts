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
import { makeEnvelope } from 'ac-envelope-core';
import { ConversationRegistry, ReachabilityTable, routeEnvelope } from 'ac-post-office';
import { adoptShell } from '../orchestrate.ts';

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
      .filter((r) => r.type !== 'session-header' && r.source !== 'segment' && r.source !== 'inject');
  } catch {
    return [];
  }
}

describe('M5.4 药丸形端到端（D9 三步合一）', () => {
  function seedConfig(agentId: string): void {
    const dir = path.join(ROOT, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock' }), 'utf-8');
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
    const lines: string[] = [];
    child.stdout.on('data', (c: Buffer) => {
      for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l);
    });
    // 等三节拍（boot.ready 在 ipc 监听开启后才发——常驻壳语义）
    const deadline = Date.now() + 15_000;
    while (!lines.some((l) => l.startsWith('boot.ready'))) {
      if (Date.now() > deadline) throw new Error('boot.ready 超时：' + lines.join(' | '));
      await new Promise((r) => setTimeout(r, 50));
    }
    const ready = lines.find((l) => l.startsWith('boot.ready'))!;
    const hint = ready.split('\t')[2];
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
    expect(rows.map((r) => r.content)).toEqual(['药丸全链', '[mock 回复 药丸全链]']);
    expect(rows[1]).toMatchObject({ agent_id: 'alpha', requestId: 'reply-req-full' });
    // shutdown 优雅退出 + 锁释放
    child.stdin.write('shutdown\n');
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
    const lines1: string[] = [];
    first.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines1.push(l); });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('boot.ready 超时')), 15_000);
      const iv = setInterval(() => {
        if (lines1.some((l) => l.startsWith('boot.ready'))) { clearTimeout(t); clearInterval(iv); resolve(); }
      }, 50);
    });
    const bootId1 = lines1.find((l) => l.startsWith('boot.lock.acquired'))!.split('\t')[1];
    // SIGKILL 崩溃（不跑任何 handler——陈锁）
    first.kill('SIGKILL');
    await new Promise<void>((res) => first.on('exit', () => res()));
    expect(fs.existsSync(path.join(ROOT, 'agents', 'gamma', 'activation.lock'))).toBe(true); // 陈锁残留
    // 重拉：接管陈锁续跑
    const second = mk();
    const lines2: string[] = [];
    second.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines2.push(l); });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('重拉 boot.ready 超时')), 15_000);
      const iv = setInterval(() => {
        if (lines2.some((l) => l.startsWith('boot.ready'))) { clearTimeout(t); clearInterval(iv); resolve(); }
      }, 50);
    });
    const bootId2 = lines2.find((l) => l.startsWith('boot.lock.acquired'))!.split('\t')[1];
    expect(bootId2).not.toBe(bootId1);
    // 陈锁副本留证
    expect(fs.existsSync(path.join(ROOT, 'agents', 'gamma', 'activation.lock.stale-' + bootId1))).toBe(true);
    second.stdin.write('shutdown\n');
    const code = await new Promise<number | null>((res) => second.on('exit', (c) => res(c)));
    expect(code).toBe(0);
  }, 45_000);
});
