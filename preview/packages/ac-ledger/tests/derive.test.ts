// ============================================================
// cr-698 viewer 账本派生器单测：幂等 / run 键单行 / 空终稿不落行 /
// 原 ts / 存量双锚行迁移
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveViewerLedger } from '../src/derive.ts';
import { readLedger } from '../src/reader.ts';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { userSessionDir } from '../src/user.ts';

const ROOT = path.join('preview', 'sandbox', 'test-derive-' + process.pid);
function cleanup(): void { fs.rmSync(ROOT, { recursive: true, force: true }); }
afterAll(cleanup);

const uuid = 'u-derive-1';

function agentWriter(domain: string): LedgerWriter {
  return new LedgerWriter(sessionDir(ROOT, domain, uuid), { participants: [domain, 'user'], kind: 'user' });
}

describe('viewer 派生（cr-698）', () => {
  it('agent 自著行（终稿/通知）派生 viewer 行：requestId 幂等 + 原 ts + run 键单行；空终稿/段行/user 行不派生', async () => {
    cleanup();
    const w = agentWriter('alpha');
    // user 入站行（viewer 由 writeOwn 覆盖——不派生）
    await w.deliver({ role: 'agent', content: '问', agent_id: 'user', requestId: 'send-1', uuid });
    // 终稿行（run 键 + 原 ts）
    await w.deliver({ role: 'agent', content: '终稿', agent_id: 'alpha', requestId: 'reply-send-1', uuid, run: 'run-send-1', timestamp: '2026-10-25T15:18:53.213Z' });
    // 空终稿行（中断 run——不落 viewer，读面盲区投影渲染）
    await w.deliver({ role: 'agent', content: '', agent_id: 'alpha', requestId: 'reply-send-2', uuid, run: 'run-send-2' });
    // 通知行（无 run 键）
    await w.deliver({ role: 'agent', content: '[系统通知] 已收到回答', agent_id: 'alpha', requestId: 'late-reply-1', uuid });
    // 物化段行（不派生）
    fs.appendFileSync(path.join(sessionDir(ROOT, 'alpha', uuid), 'messages.jsonl'), JSON.stringify({
      role: 'agent', content: '', agent_id: 'alpha', run: 'run-send-1', source: 'segment',
      steps: [{ content: '步' }], message_id: 'seg-run-send-1-0', timestamp: 'T', seq: 9,
    }) + '\n', 'utf-8');

    expect(await deriveViewerLedger(ROOT, uuid, ['alpha'])).toBe(2);
    const rows = readLedger(userSessionDir(ROOT, uuid)).rows;
    expect(rows.map((r) => [r.content, r.agent_id, r.source ?? ''])).toEqual([
      ['终稿', 'alpha', 'run:run-send-1'],
      ['[系统通知] 已收到回答', 'alpha', ''],
    ]);
    expect(rows[0]).toMatchObject({ requestId: 'reply-send-1', timestamp: '2026-10-25T15:18:53.213Z' });
    // 幂等：重派生零新增
    expect(await deriveViewerLedger(ROOT, uuid, ['alpha'])).toBe(0);
  });

  it('run 键单行：同 run 二条非空行只派生首条（锚信双行事故根因回归）', async () => {
    cleanup();
    const w = agentWriter('beta');
    await w.deliver({ role: 'agent', content: '', agent_id: 'beta', requestId: 'orphan-run-r', uuid, run: 'run-r' });
    await w.deliver({ role: 'agent', content: '真终稿', agent_id: 'beta', requestId: 'reply-r', uuid, run: 'run-r' });
    expect(await deriveViewerLedger(ROOT, uuid, ['beta'])).toBe(1);
    let rows = readLedger(userSessionDir(ROOT, uuid)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: '真终稿' });
    // 幂等
    expect(await deriveViewerLedger(ROOT, uuid, ['beta'])).toBe(0);
    rows = readLedger(userSessionDir(ROOT, uuid)).rows;
    expect(rows).toHaveLength(1);
  });

  it('存量迁移：viewer 同 run 空 content 锚行 + 其后非空同 run 行 → 锚行剔除（原子重写，头行保留）', async () => {
    cleanup();
    const dir = userSessionDir(ROOT, uuid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: 'T', participants: ['user'], kind: 'user' }),
      JSON.stringify({ role: 'agent', content: '问', agent_id: 'user', requestId: 's1', uuid, message_id: 'm1', timestamp: 'T1', seq: 1 }),
      JSON.stringify({ role: 'agent', content: '', agent_id: 'x', source: 'run:run-dup', requestId: 'orphan-run-dup', uuid, message_id: 'm2', timestamp: 'T2', seq: 2 }),
      JSON.stringify({ role: 'agent', content: '终稿', agent_id: 'x', source: 'run:run-dup', requestId: 'reply-dup', uuid, message_id: 'm3', timestamp: 'T3', seq: 3 }),
    ].join('\n') + '\n', 'utf-8');
    await deriveViewerLedger(ROOT, uuid, ['x']);
    const { header, rows } = readLedger(dir);
    expect(header).not.toBeNull();
    expect(rows.map((r) => r.content)).toEqual(['问', '终稿']);
  });
});
