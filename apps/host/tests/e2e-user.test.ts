// ============================================================
// M8.4 级联验收：user 壳半边端到端——真子进程壳 + 邮局真投递 +
// user 壳桩（宿主内极薄）：
//   ① user send 全链：签发（R-1）→ 邮局 dispatch → 壳 ipc 直投 →
//      conversation 全链（mock run + 账本终稿）→ 终稿回链通知；
//      cr-973 起 viewer 停写——发言行 = agent 域入站行，终稿层经
//      projectUserReplay 读时投影（不再物化 viewer 账本）；
//   ② 多轮：同 uuid 续聊，历史延续；
//   ③ 幂等：同 requestId 重发 → 壳 deduped + agent 域不重复入账。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPathFor, makeEnvelope, waitForShellReady } from 'ac-envelope-core';
import { PostOffice } from 'ac-post-office';
import { UserStub } from '../user-stub.ts';
import { readLedger } from 'ac-ledger';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-user-e2e-' + process.pid);
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

// v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud——「先迁移」）
function seedConfig(agentId: string): void {
  fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
  writeAgentConfig(ROOT, { id: agentId, model: 'mock' });
}

async function spawnShell(agentId: string): Promise<{ child: ChildProcess; hint: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', BOOT,
    '--data-root', path.resolve(ROOT), '--agent-id', agentId, '--catalog', CATALOG,
    // 邮局地址 = socketPathFor（win32 named pipe / posix .sock——与 PostOffice 构造同源）
    '--mock-provider', '1', '--post-office', socketPathFor(path.resolve(ROOT), 'post-office')],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  spawned.push(child);
  child.stdout.on('data', () => {}); // cr-1129 批4：排水防反压（stdout 信号退役）
  const lock = await waitForShellReady(path.join(ROOT, 'agents', agentId), 25_000);
  return { child, hint: lock.transportHint };
}

describe('M8.4 user 壳半边端到端', () => {
  it('user send 全链 + 终稿回链（R-1 签发 / cr-973 读时投影）', async () => {
    seedConfig('alpha');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const user = new UserStub(po, ROOT);
    user.start();
    const { hint } = await spawnShell('alpha');
    po.reach.markReachable('alpha', hint);
    try {
      // user 发言（R-1 签发 + 邮局投递；发言行由壳落 agent 域入站行）
      const { uuid, dispatched } = await user.send('alpha', '第一问');
      expect(uuid).toMatch(/-7/); // UUIDv7 签发
      expect(dispatched[0]).toMatchObject({ to: 'alpha', channel: 'direct' });
      // 等终稿回链：agent 域账本出现终稿行（mock 回声）——viewer 不再
      // 物化（cr-973），终稿层经 projectUserReplay 读时投影
      const adir = path.join(ROOT, 'agents', 'alpha', 'sessions', uuid);
      const deadline = Date.now() + 10_000;
      let arows: ReturnType<typeof readLedger>['rows'];
      for (;;) {
        arows = readLedger(adir).rows
          .filter((r) => r.role !== undefined && r.source !== 'segment' && r.source !== 'inject');
        if (arows.length >= 2) break;
        if (Date.now() > deadline) throw new Error('终稿未回链：' + JSON.stringify(arows));
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(arows.map((r) => r.content)).toEqual(['第一问', '[mock 回复 第一问]']);
      // 读时投影（cr-973）：user 视角终稿层 = agent 域账本纯函数
      const replay = user.replay(uuid);
      expect(replay.map((r) => r.content)).toEqual(['第一问', '[mock 回复 第一问]']);
      // run 键盖戳（cr-595）：投影行 run 与 agent 终稿行 run 一致——webui
      // history 按此联查 agent journal 带出思考/工具卡（D4.2）。
      expect(replay[1].run).toBe(arows[1].run);
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
      // cr-973：等待面 = agent 域账本（viewer 不再物化）；cr-974 v2：相位/
      // run-end 行无 role——终稿层只看发言行（段行/注入行不计）
      const adir = path.join(ROOT, 'agents', 'alpha', 'sessions', first.uuid);
      const talkRows = (): ReturnType<typeof readLedger>['rows'] =>
        readLedger(adir).rows.filter((r) => r.role !== undefined && r.source !== 'segment' && r.source !== 'inject');
      const waitRows = async (n: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (talkRows().length >= n) return;
          if (Date.now() > deadline) throw new Error('等待 ' + n + ' 行超时：' + JSON.stringify(talkRows()));
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
      // 幂等（R-3）：同 requestId 重投 → 接收方去重不重复入账（壳收信面
      // AdmissionGate + ledger writer 双层承载——cr-973 起 user 桩无本地
      // 账本，幂等锚全在 agent 域入站行）
      const dupReq = 'dup-e2e';
      await user.send('alpha', '幂等问', { uuid: first.uuid, requestId: dupReq });
      // 先等首投的入站行落账（cr-973：落账在壳侧异步——计数基准须等行在场）
      const landed = Date.now() + 10_000;
      while (!user.replay(first.uuid).some((r) => r.role === 'user' && r.content === '幂等问')) {
        if (Date.now() > landed) throw new Error('幂等问入站行未落账：' + JSON.stringify(user.replay(first.uuid)));
        await new Promise((r) => setTimeout(r, 100));
      }
      const before = user.replay(first.uuid).filter((r) => r.role === 'user').length;
      // 直接重发同一信封（邮局 dispatch → 壳 AdmissionGate 去重 → ack fresh:false）
      const dup = await user.send('alpha', '幂等问', { uuid: first.uuid, requestId: dupReq });
      expect(dup.dispatched[0]).toMatchObject({ ack: { ack: dupReq, fresh: false } }); // 壳侧去重
      const after = user.replay(first.uuid).filter((r) => r.role === 'user').length;
      expect(after).toBe(before); // agent 域入站行未增（壳侧幂等）
    } finally {
      user.stop();
      await po.close();
    }
  }, 45_000);
});

describe('会话新行通知（cr-870/973：onAppend 回调——宿主装配点连 ctx.emit）', () => {
  it('send 投递后触发（uuid 载荷——发言行由壳落 agent 域，通知 = 宜失效语义）', async () => {
    seedConfig('alpha');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const seen: string[] = [];
    const user = new UserStub(po, ROOT, (uuid) => { seen.push(uuid); });
    user.start();
    try {
      const { uuid } = await user.send('alpha', '通知问');
      expect(seen).toEqual([uuid]); // 投递完成 → 通知一次
      // 无对端壳在场：dispatch 无 ack 也无终稿回链——仅投递通知
    } finally {
      user.stop();
      await po.close();
    }
  });

  it('终稿通知信到达后触发（receive → agent 域行已 durable，通知缓存面失效）', async () => {
    seedConfig('beta');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const seen: string[] = [];
    const user = new UserStub(po, ROOT, (uuid) => { seen.push(uuid); });
    user.start();
    try {
      const { uuid } = await user.send('beta', '首问');
      seen.length = 0; // 排除 send 投递通知
      // agent 域账本手工落终稿行（模拟壳写者）→ 直投终稿通知信封给 user 端点
      const adir = path.join(ROOT, 'agents', 'beta', 'sessions', uuid);
      fs.mkdirSync(adir, { recursive: true });
      fs.writeFileSync(path.join(adir, 'messages.jsonl'), [
        JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-11-02T00:00:00.000Z', participants: ['beta', 'user'], kind: 'agent' }),
        JSON.stringify({ role: 'agent', message_id: uuid + '-f1', agent_id: 'beta', content: '终稿回复', timestamp: '2026-11-02T00:00:01.000Z' }),
      ].join('\n') + '\n', 'utf-8');
      const ack = await po.dispatch(makeEnvelope({
        uuid, requestId: 'fin-' + uuid, sender: 'beta', to: 'user',
        payload: { text: '终稿回复' },
      }));
      expect(ack[0]).toMatchObject({ to: 'user', channel: 'local' });
      expect(seen).toEqual([uuid]); // 终稿信到达 → 通知一次（cr-973：纯通知）
    } finally {
      user.stop();
      await po.close();
    }
  });
});

describe('独立私信直播帧（cr-1144：onStandalone——send_agent(to:user) 非回信信封）', () => {
  it('非回信信封 → 出帧（message_id = requestId 幂等锚）；回信信封（payload.run）跳过', async () => {
    seedConfig('alpha');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const frames: Array<{ agentId: string; text: string; requestId: string; uuid: string }> = [];
    const user = new UserStub(po, ROOT, undefined, (agentId, text, requestId, uuid) => {
      frames.push({ agentId, text, requestId, uuid });
    });
    user.start();
    try {
      const conv = 'alpha~user';
      // 独立私信（send_agent(to:'user') 的跨壳信封形态：payload 无 run）
      await po.dispatch(makeEnvelope({
        uuid: conv, requestId: 'sa-1', sender: 'alpha', to: 'user',
        payload: { text: '定时汇报：今日事项已完成' },
      }));
      expect(frames).toEqual([
        { agentId: 'alpha', text: '定时汇报：今日事项已完成', requestId: 'sa-1', uuid: conv },
      ]);
      // 回信信封（postReply 形态：payload.run 在场）→ 不出帧（run/settled 已计）
      await po.dispatch(makeEnvelope({
        uuid: conv, requestId: 'reply-x', sender: 'alpha', to: 'user',
        payload: { text: '终稿', run: 'run-x' },
      }));
      expect(frames).toHaveLength(1);
    } finally {
      user.stop();
      await po.close();
    }
  });
});
