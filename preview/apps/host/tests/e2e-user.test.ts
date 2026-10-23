// ============================================================
// M8.4 级联验收：user 壳半边端到端——真子进程壳 + 邮局真投递 +
// user 壳桩（宿主内极薄）：
//   ① user send 全链：签发（R-1）→ own 落账 → 邮局 dispatch → 壳
//      ipc 直投 → conversation 全链（mock run + 账本终稿）→ 终稿
//      回链（R-2 恒投回 sender）→ user 账本 writeThrough；
//   ② 多轮：同 uuid 续聊，历史延续；
//   ③ 幂等：同 requestId 重发 → 壳 deduped + user 账本不重复入账。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPathFor } from 'ac-envelope-core';
import { PostOffice } from 'ac-post-office';
import { UserStub } from '../user-stub.ts';
import { readLedger } from 'ac-ledger';

const ROOT = path.join('preview', 'sandbox', 'test-user-e2e-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function seedConfig(agentId: string): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock' }), 'utf-8');
}

async function spawnShell(agentId: string): Promise<{ child: ChildProcess; hint: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', BOOT,
    '--data-root', path.resolve(ROOT), '--agent-id', agentId, '--catalog', CATALOG,
    // 邮局地址 = socketPathFor（win32 named pipe / posix .sock——与 PostOffice 构造同源）
    '--mock-provider', '1', '--post-office', socketPathFor(path.resolve(ROOT), 'post-office')],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  spawned.push(child);
  const lines: string[] = [];
  child.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l); });
  const deadline = Date.now() + 15_000;
  while (!lines.some((l) => l.startsWith('boot.ready'))) {
    if (Date.now() > deadline) throw new Error('boot.ready 超时：' + lines.join(' | '));
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, hint: lines.find((l) => l.startsWith('boot.ready'))!.split('\t')[2] };
}

describe('M8.4 user 壳半边端到端', () => {
  it('user send 全链 + 终稿回链 user 账本（R-1 签发 / R-2 写穿）', async () => {
    seedConfig('alpha');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const user = new UserStub(po, ROOT);
    user.start();
    const { hint } = await spawnShell('alpha');
    po.reach.markReachable('alpha', hint);
    try {
      // user 发言（R-1 签发 + own 落账 + 邮局投递）
      const { uuid, dispatched } = await user.send('alpha', '第一问');
      expect(uuid).toMatch(/-7/); // UUIDv7 签发
      expect(dispatched[0]).toMatchObject({ to: 'alpha', channel: 'direct' });
      // 等终稿回链：user 账本出现 peer 终稿行（mock 回声）
      const udir = path.join(ROOT, 'users', 'user', 'sessions', uuid);
      const deadline = Date.now() + 10_000;
      let rows: ReturnType<typeof readLedger>['rows'];
      for (;;) {
        rows = readLedger(udir).rows;
        if (rows.length >= 2) break;
        if (Date.now() > deadline) throw new Error('终稿未回链：' + JSON.stringify(rows));
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(rows.map((r) => r.content)).toEqual(['第一问', '[mock 回复 第一问]']);
      // agent 侧账本对拍：同会话双视角（D4 视角主义——两账本各自为真）
      const arows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', uuid)).rows;
      expect(arows.map((r) => r.content)).toEqual(['第一问', '[mock 回复 第一问]']);
      // run 键盖戳（cr-595）：peer 终稿行 source=run:<id> 与 agent 终稿行
      // run 一致——webui history 按此联查 agent journal 带出思考/工具卡
      //（D4.2；回信信封缺 run 载体时此断言红——刷新后历史只剩终稿文本）。
      expect(rows[1].source).toBe('run:' + arows[1].run);
      expect(user.replay(uuid)[1].run).toBe(arows[1].run);
    } finally {
      user.stop();
      await po.close();
    }
  }, 45_000);

  it('多轮续聊 + 幂等：同 uuid 第二问 / 重发不重复入账', async () => {
    seedConfig('alpha');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const user = new UserStub(po, ROOT);
    user.start();
    const { hint } = await spawnShell('alpha');
    po.reach.markReachable('alpha', hint);
    try {
      const first = await user.send('alpha', '第一问');
      const udir = path.join(ROOT, 'users', 'user', 'sessions', first.uuid);
      const waitRows = async (n: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (readLedger(udir).rows.length >= n) return;
          if (Date.now() > deadline) throw new Error('等待 ' + n + ' 行超时：' + JSON.stringify(readLedger(udir).rows));
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      await waitRows(2);
      // 第二问（同 uuid 续聊）
      const second = await user.send('alpha', '第二问', { uuid: first.uuid });
      expect(second.uuid).toBe(first.uuid);
      await waitRows(4);
      const replay = user.replay(first.uuid);
      expect(replay.map((r) => r.content)).toEqual([
        '第一问', '[mock 回复 第一问]', '第二问', '[mock 回复 第二问]',
      ]);
      // 幂等（R-3）：同 requestId 重投 → 接收方去重不重复入账（user 桩
      // ledgerFor 缓存同 writer——AdmissionGate 同键短路；agent 侧账本
      // 同理由 boot 收信面 AdmissionGate + ledger writer 双层承载）
      const dupReq = 'dup-e2e';
      await user.send('alpha', '幂等问', { uuid: first.uuid, requestId: dupReq });
      const before = user.replay(first.uuid).filter((r) => r.role === 'user').length;
      // 直接重发同一信封（邮局 dispatch → 壳 AdmissionGate 去重 → ack fresh:false）
      const dup = await user.send('alpha', '幂等问', { uuid: first.uuid, requestId: dupReq });
      expect(dup.dispatched[0]).toMatchObject({ ack: { ack: dupReq, fresh: false } }); // 壳侧去重
      const after = user.replay(first.uuid).filter((r) => r.role === 'user').length;
      expect(after).toBe(before); // user 账本未增行（同 writer 幂等）
    } finally {
      user.stop();
      await po.close();
    }
  }, 45_000);
});
