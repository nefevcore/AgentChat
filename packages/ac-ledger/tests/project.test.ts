// ============================================================
// project.test.ts —— user 终稿层读时投影（projectUserReplay）单测
//
// cr-973（cr-972 第一刀）：viewer 物化账本（cr-698 UserLedger /
// deriveViewerLedger）退役——终稿层不再是落盘派生物，而是 agent 域账本
// 的纯读时投影。本文件接替 user.test.ts / derive.test.ts 的语义覆盖：
//   · user 发言行 = agent 域入站行（agent_id='user'——viewer 时代
//     writeOwn 落账的同一条消息，写权归壳侧）；peer 行 = agent 自著
//     终稿/通知行（原 derive 谓词：requestId 幂等 / run 键单行 /
//     空终稿不投 / 段行与注入行不投）；
//   · 排序事实键 = 行时间戳（同刻 user 行先于 peer 行——稳定排序）。
// cr-998：viewer 存量直读兼容窗退役（数据根已迁移归零）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectUserReplay } from '../src/project.ts';
import { LedgerWriter, sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-project-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** agent 域 writer 缓存（同 agentId+uuid 恒同实例——requestId 准入门在实例上） */
const writers = new Map<string, LedgerWriter>();
function writerOf(agent: string, uuid: string): LedgerWriter {
  const key = agent + '/' + uuid;
  let w = writers.get(key);
  if (w === undefined) {
    w = new LedgerWriter(sessionDir(ROOT, agent, uuid), { participants: [agent, 'user'], kind: 'user' });
    writers.set(key, w);
  }
  return w;
}

/** user 发言行（壳侧入站落账形态——cr-973 起 writeOwn 退役后的落账侧） */
async function userSays(agent: string, uuid: string, text: string, requestId: string, ts?: string): Promise<boolean> {
  return writerOf(agent, uuid).deliver({ role: 'agent', content: text, agent_id: 'user', requestId, uuid, ...(ts !== undefined ? { timestamp: ts } : {}) });
}

/** agent 终稿行（自著——run 键 + runMs 透传） */
async function agentFinal(agent: string, uuid: string, text: string, requestId: string, run: string | undefined, ts?: string, runMs?: number): Promise<boolean> {
  return writerOf(agent, uuid).deliver({
    role: 'agent', content: text, agent_id: agent, requestId, uuid,
    ...(run !== undefined ? { run } : {}), ...(runMs !== undefined ? { runMs } : {}),
    ...(ts !== undefined ? { timestamp: ts } : {}),
  });
}

describe('projectUserReplay（cr-973 读时投影）', () => {
  it('user + peer 投影：入站行投 user、自著终稿投 peer（run/runMs/requestId/timestamp 透传）', async () => {
    const uuid = 'p-basic';
    await userSays('alpha', uuid, '第一问', 'q-1', '2026-11-09T10:00:00.000Z');
    await agentFinal('alpha', uuid, '终稿回复', 'reply-q-1', 'run-9', '2026-11-09T10:00:01.000Z', 4200);
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay).toHaveLength(2);
    expect(replay[0]).toMatchObject({ role: 'user', agentId: 'user', content: '第一问', requestId: 'q-1', timestamp: '2026-11-09T10:00:00.000Z' });
    expect(replay[0]!.run).toBeUndefined();
    expect(replay[1]).toMatchObject({ role: 'peer', agentId: 'alpha', content: '终稿回复', run: 'run-9', runMs: 4200, requestId: 'reply-q-1' });
    // 行时间戳在场（cr-716）：读面历史排序的事实键
    expect(typeof replay[0].timestamp).toBe('string');
    expect(Date.parse(replay[0].timestamp)).not.toBeNaN();
    expect(Date.parse(replay[1].timestamp)).not.toBeNaN();
    // 行级 seq 透传（B1——agent 域 seq 空间，viewer 行已不存在）
    expect(typeof replay[0].seq).toBe('number');
    expect(typeof replay[1].seq).toBe('number');
  });

  it('排序：时间戳升序；同刻 user 行先于 peer 行（稳定排序）', async () => {
    const uuid = 'p-order';
    await agentFinal('alpha', uuid, '终稿', 'r-1', 'run-1', '2026-11-09T10:00:00.000Z');
    await userSays('alpha', uuid, '同刻问', 'q-same', '2026-11-09T10:00:00.000Z');
    await userSays('alpha', uuid, '更早问', 'q-early', '2026-11-09T09:59:59.000Z');
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay.map((r) => [r.role, r.content])).toEqual([
      ['user', '更早问'],
      ['user', '同刻问'], // 同刻：user 行先于 peer 行
      ['peer', '终稿'],
    ]);
  });

  it('requestId 幂等：同键入站重发短路（落账准入）+ 同键行不重复投影', async () => {
    const uuid = 'p-dedup';
    expect(await userSays('alpha', uuid, '问', 'q-1', '2026-11-09T10:00:00.000Z')).toBe(true);
    expect(await userSays('alpha', uuid, '问（重投）', 'q-1', '2026-11-09T10:00:01.000Z')).toBe(false);
    // 跨域同键（同一消息落两端域）也只投一行
    await userSays('beta', uuid, '问', 'q-1', '2026-11-09T10:00:00.000Z');
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ role: 'user', content: '问' });
  });

  it('run 键单行：同 run 空 content 终稿不投、非空终稿投一行（原 derive 谓词）', async () => {
    const uuid = 'p-run';
    await agentFinal('alpha', uuid, '', 'orphan-r', 'run-r', '2026-11-09T10:00:00.000Z');
    await agentFinal('alpha', uuid, '真终稿', 'reply-r', 'run-r', '2026-11-09T10:00:01.000Z');
    await agentFinal('alpha', uuid, '同 run 第二稿', 'reply-r2', 'run-r', '2026-11-09T10:00:02.000Z');
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ role: 'peer', content: '真终稿', run: 'run-r' });
  });

  it('段行 / 注入行不投影（steps 联查与注入卡归口读面 view 组装）', async () => {
    const uuid = 'p-seg';
    await agentFinal('alpha', uuid, '终稿', 'r-1', 'run-1', '2026-11-09T10:00:02.000Z');
    const file = path.join(sessionDir(ROOT, 'alpha', uuid), 'messages.jsonl');
    fs.appendFileSync(file, [
      JSON.stringify({ role: 'agent', content: '', agent_id: 'alpha', run: 'run-1', source: 'segment', steps: [{ content: '步' }], message_id: 'seg-run-1-0', timestamp: '2026-11-09T10:00:00.000Z', seq: 90 }),
      JSON.stringify({ role: 'agent', content: '插队消息', agent_id: 'alpha', run: 'run-1', source: 'inject', requestId: 'send-1', message_id: 'inj-1', timestamp: '2026-11-09T10:00:01.000Z', seq: 91 }),
      JSON.stringify({ role: 'agent', content: '', agent_id: 'alpha', run: 'run-1', source: 'material', message_id: 'seg-run-1-2', timestamp: '2026-11-09T10:00:01.500Z', seq: 92 }),
    ].join('\n') + '\n', 'utf-8');
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay.map((r) => r.content)).toEqual(['终稿']);
  });

  it('cr-1309：cr-946 前 restarted-* speech 落形已归一——replay 无 legacy 滤除分支也不投影通知', async () => {
    const uuid = 'p-restart';
    await userSays('alpha', uuid, '正常问', 'q-1', '2026-11-09T10:00:00.000Z');
    // 现行词形直接落盘（归一工具的产物形态）——user replay 天然不投 context 行
    const file = path.join(sessionDir(ROOT, 'alpha', uuid), 'messages.jsonl');
    fs.appendFileSync(file, JSON.stringify({
      role: 'context', source: 'event', content: '壳已重启完成（归一后形态）',
      agent_id: 'alpha', requestId: 'restarted-legacy-1', uuid,
      message_id: 'restarted-legacy-1', timestamp: '2026-11-09T10:00:01.000Z', seq: 2,
    }) + '\n', 'utf-8');
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay.map((r) => r.content)).toEqual(['正常问']);
  });

  it('对桶键 pair：两 agent 域并读（双方终稿 + 双端入站 user 行同键归一）', async () => {
    const uuid = 'alpha~beta';
    // 同一条 user 消息落两端域（同 requestId——归一投一行）
    await userSays('alpha', uuid, '群里问', 'q-1', '2026-11-09T10:00:00.000Z');
    await userSays('beta', uuid, '群里问', 'q-1', '2026-11-09T10:00:00.000Z');
    await agentFinal('alpha', uuid, 'alpha 终稿', 'ra-1', 'run-a', '2026-11-09T10:00:01.000Z');
    await agentFinal('beta', uuid, 'beta 终稿', 'rb-1', 'run-b', '2026-11-09T10:00:02.000Z');
    const replay = projectUserReplay(ROOT, uuid);
    expect(replay.map((r) => [r.role, r.agentId, r.content])).toEqual([
      ['user', 'user', '群里问'],
      ['peer', 'alpha', 'alpha 终稿'],
      ['peer', 'beta', 'beta 终稿'],
    ]);
  });

});
