// ============================================================
// ac-ledger/tests/cr1102-records-for.test.ts —— cr-1102/1103
//   recordsFor 统一行读面：context 行（存量 v1/v2）+ inject 事件
//   （v2 现行）投影为 role:'context' 行，source=injectSource，seq 升序；
//   发言行不入投影；缺席域 = 空清单（fail-open）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { makeLedgerRow } from '../src/service.ts';

const ROOT = path.join('sandbox', 'test-cr1102-records-' + process.pid);
const fibers: Fiber[] = [];
afterEach(async () => {
  for (const fiber of [...fibers].reverse()) if (fiber.uid !== null) await fiber.dispose();
  fibers.length = 0;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('recordsFor（cr-1102/1103 统一行读面）', () => {
  it('context 行 + inject 事件统一投影（seq 升序；inject 行 source=injectSource）；发言行不入投影', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'alpha' }));
    fibers.push(fiber);
    await fiber;
    const svc = ctx.ledger as unknown as {
      deliverRow(u: string, p: string[], k: string, row: Record<string, unknown>): Promise<boolean>;
      journalInject(u: string, run: string, content: string, requestId?: string, extra?: { injectSource?: string; label?: string }): Promise<void>;
      recordsFor(u: string): Array<{ role: string; source?: string; agent_id?: string; content: string; injectSource?: string; label?: string; run?: string; seq?: number }>;
    };
    const uid = 'user~alpha';
    await svc.deliverRow(uid, ['alpha', 'user'], 'user', { role: 'agent', content: '任务', agent_id: 'user', requestId: 'q1', uuid: uid });
    await svc.deliverRow(uid, ['alpha', 'user'], 'user', { role: 'context', source: 'skill', content: '<skill_content name="old-skill">\n存量 context 行\n</skill_content>', agent_id: 'alpha', requestId: 'q0', uuid: uid });
    await svc.journalInject(uid, 'run-1', '<skill_content name="new-skill">\n现行 inject 行\n</skill_content>', 'steer-1', { injectSource: 'skill', label: '已加载技能 new-skill' });
    const rows = svc.recordsFor(uid);
    expect(rows).toHaveLength(2); // 发言行不入投影
    expect(rows[0]).toMatchObject({ role: 'context', source: 'skill', agent_id: 'alpha' });
    expect(rows[0].content).toContain('old-skill');
    expect(rows[1]).toMatchObject({ role: 'context', source: 'skill', injectSource: 'skill', run: 'run-1', agent_id: 'alpha' });
    expect(rows[1].content).toContain('new-skill');
    expect((rows[0].seq ?? 0) <= (rows[1].seq ?? 0)).toBe(true);
    // 缺席会话域 = 空清单（fail-open——消费方锚检测/去重降级不阻断）
    expect(svc.recordsFor('none~alpha')).toEqual([]);
  });

  it('cr-1155：无 seq 的 v1 存量行归位最旧——不排投影尾部冒充最新', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'alpha' }));
    fibers.push(fiber);
    await fiber;
    const svc = ctx.ledger as unknown as {
      deliverRow(u: string, p: string[], k: string, row: Record<string, unknown>): Promise<boolean>;
      journalInject(u: string, run: string, content: string, requestId?: string, extra?: { injectSource?: string }): Promise<void>;
      recordsFor(u: string): Array<{ role: string; source?: string; seq?: number; content: string }>;
    };
    const uid = 'user~alpha';
    // 直接文件预置 v1 无 seq 行（写面已恒 v2 形态，v1 行只能手工落盘——现场正是如此）
    const dir = path.join(ROOT, 'agents', 'alpha', 'sessions', uid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'messages.jsonl');
    fs.writeFileSync(file, JSON.stringify({ role: 'context', source: 'memory-delta', agent_id: 'alpha', content: 'v1 旧行（2026-10）' }) + '\n', 'utf-8');
    await svc.journalInject(uid, 'run-2', 'v2 新行', undefined, { injectSource: 'memory-delta' });
    const rows = svc.recordsFor(uid);
    expect(rows).toHaveLength(2);
    // v1 行排最前（最旧），v2 行在后——倒扫取「最近」时命中 v2 而非 v1
    expect(rows[0].content).toBe('v1 旧行（2026-10）');
    expect(rows[0].seq).toBeUndefined();
    expect(rows[1].content).toBe('v2 新行');
    expect(typeof rows[1].seq).toBe('number');
  });
});
