// ============================================================
// M7.3 user 账本（形态二）单测：终稿写穿 / 幂等 / run 键带出
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UserLedger, userSessionDir } from '../src/user.ts';
import { readLedger } from '../src/reader.ts';

const ROOT = path.join('sandbox', 'test-userled-' + process.pid);
function cleanup(): void { fs.rmSync(ROOT, { recursive: true, force: true }); }

describe('M7.3 user 账本（形态二：仅终稿层）', () => {
  it('终稿写穿 + user 视角回放（own/peer 投影）', async () => {
    cleanup();
    const led = new UserLedger(ROOT, 'u-777', ['alpha', 'user']);
    await led.writeOwn('第一问', 'rq-1');
    expect(await led.writeThrough({ agentId: 'alpha', content: '终稿回复', uuid: 'u-777', run: 'run-9', requestId: 'rq-2' })).toBe(true);
    const replay = led.replay();
    expect(replay).toEqual([
      { role: 'user', agentId: 'user', content: '第一问', run: undefined },
      { role: 'peer', agentId: 'alpha', content: '终稿回复', run: 'run-9' },
    ]);
    // 物理布局：<dataRoot>/viewer/sessions/<uuid>/
    expect(fs.existsSync(path.join(userSessionDir(ROOT, 'u-777'), 'messages.jsonl'))).toBe(true);
  });

  it('requestId 幂等：同键写穿短路', async () => {
    cleanup();
    const led = new UserLedger(ROOT, 'u-778', ['beta', 'user']);
    expect(await led.writeThrough({ agentId: 'beta', content: 'A', uuid: 'u-778', requestId: 'rq-x' })).toBe(true);
    expect(await led.writeThrough({ agentId: 'beta', content: 'A（重投）', uuid: 'u-778', requestId: 'rq-x' })).toBe(false);
    const { rows } = readLedger(userSessionDir(ROOT, 'u-778'));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('A');
  });

  it('run 键带出：user 账本 run 字段 → agent 账本 journal 直读关联', async () => {
    cleanup();
    const led = new UserLedger(ROOT, 'u-779', ['gamma', 'user']);
    await led.writeThrough({ agentId: 'gamma', content: '带 run 的终稿', uuid: 'u-779', run: 'run-42', requestId: 'rq-r' });
    const replay = led.replay();
    expect(replay[0].run).toBe('run-42');
  });
});

afterAll(cleanup);
