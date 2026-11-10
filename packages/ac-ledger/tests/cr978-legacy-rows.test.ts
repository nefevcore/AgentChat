// ============================================================
// cr978-legacy-rows.test.ts —— v1 裸行形态容错：早期子 Agent 会话写面
// 落过缺 message_id/timestamp 的行（role/content/agent_id/uuid）。回归面：
//   · projectUserReplay 不再崩溃（message_id.startsWith 未守卫曾使
//     runs/snapshot 恒 500——全根扫描风暴拖死宿主，首屏 17s 根因）
//   · 无身份行不参与判重（旧 seen.add(undefined) 把全部裸行塌缩成一条
//     = 静默丢消息）；无 requestId/message_id 各行独立保留
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectUserReplay } from '../src/project.ts';
import { sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-ledger-cr978-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff3001';

function writeRaw(agentId: string, rows: Array<Record<string, unknown>>): void {
  const dir = sessionDir(ROOT, agentId, uuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

describe('cr-978：v1 裸行（缺 message_id/timestamp）容错', () => {
  it('projectUserReplay 不崩溃且无身份行不判重塌缩（逐行保留）', () => {
    writeRaw('legacy', [
      // 早期子 Agent 会话形态：无 message_id / timestamp / seq
      { role: 'agent', agent_id: 'user', content: '第一问', uuid },
      { role: 'agent', agent_id: 'legacy', content: '第一答', uuid },
      { role: 'agent', agent_id: 'user', content: '第二问', uuid },
      { role: 'agent', agent_id: 'legacy', content: '第二答', uuid },
    ]);
    const rows = projectUserReplay(ROOT, uuid);
    expect(rows).toHaveLength(4);
    // 时间戳全缺席 → 回落收集序（user 批先于 peer 批——排序语义不变）
    expect(rows.map((r) => r.role)).toEqual(['user', 'user', 'peer', 'peer']);
    expect(rows.map((r) => r.content).sort()).toEqual(['第一问', '第一答', '第二问', '第二答'].sort());
  });

  it('有身份行判重照常（requestId 幂等语义不受归一影响）', () => {
    writeRaw('legacy2', [
      { role: 'agent', agent_id: 'user', content: 'A', message_id: 'm1', requestId: 'rq-1', timestamp: '2026-11-10T00:00:01Z' },
      { role: 'agent', agent_id: 'user', content: 'A 重发', message_id: 'm2', requestId: 'rq-1', timestamp: '2026-11-10T00:00:02Z' },
      { role: 'agent', agent_id: 'legacy2', content: '答', message_id: 'm3', timestamp: '2026-11-10T00:00:03Z' },
    ]);
    const rows = projectUserReplay(ROOT, uuid);
    expect(rows).toHaveLength(2); // requestId 判重吃掉重发行
    expect(rows[0]).toMatchObject({ role: 'user', content: 'A' });
    expect(rows[1]).toMatchObject({ role: 'peer', content: '答' });
  });
});

