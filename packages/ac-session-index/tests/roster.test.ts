// ============================================================
// roster.test.ts —— 名册小表回归（cr-1185）
//
// refreshConversation 同源维护 roster 行（发言口径身份/时标 + seek 回源
// 正文截断 + stat 指纹）；rosterGapOf 缺口判定（未入账/追加后陈旧/孤儿）；
// rosterSnapshot 群成员流折叠（gid 无账本目录——成员流聚合派生）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionIndex } from '../src/core.ts';

let root: string;
let dbFile: string;
const openIdx: SessionIndex[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-index-roster-'));
  dbFile = path.join(root, 'index', 'session-index.db');
});
afterEach(() => {
  for (const idx of openIdx.splice(0)) idx.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function newIndex(): SessionIndex {
  const idx = new SessionIndex(dbFile);
  openIdx.push(idx);
  return idx;
}

const fileOf = (domain: string, convId: string): string =>
  path.join(root, 'agents', domain, 'sessions', convId, 'messages.jsonl');
function writeMessages(domain: string, convId: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(fileOf(domain, convId)), { recursive: true });
  fs.writeFileSync(fileOf(domain, convId), lines.join('\n') + '\n');
}
function appendMessages(domain: string, convId: string, lines: string[]): void {
  fs.appendFileSync(fileOf(domain, convId), lines.join('\n') + '\n');
}

const row = (o: Record<string, unknown>) => JSON.stringify(o);
const UUID = '3f2b8c1a-9d4e-4f7a-b2c6-1e8a5d0f9b31';

describe('cr-1185 · roster 行同源维护', () => {
  it('发言口径末行身份/时标 + seek 回源正文截断 + speech/total', () => {
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'user', agent_id: 'user', content: '在吗', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
      row({ type: 'run-end', ts: 1762786805000, seq: 2, run: 'r1' }),
      row({ role: 'agent', agent_id: 'alpha', content: '在的，这条回复很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', timestamp: '2026-11-10T01:00:05.000Z', seq: 3, run: 'r1' }),
    ]);
    const idx = newIndex();
    idx.refreshConversation(root, 'alpha~user');
    const rows = idx.rosterSnapshot();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.key).toBe('alpha~user');
    expect(r.kind).toBe('pair');
    expect(r.lastAgent).toBe('alpha'); // run-end 事件行不占末发言位
    expect(r.lastSpeechAt).toBe('2026-11-10T01:00:05.000Z');
    expect(r.lastAt).toBe('2026-11-10T01:00:05.000Z');
    expect(r.speech).toBe(2);
    expect(r.total).toBe(3);
    expect(r.messageCount).toBe(2); // 批3：snapshot messageCount 换源口径（发言行数）
    expect(r.lastText).not.toBeNull();
    expect(r.lastText!.length).toBeLessThanOrEqual(120);
    expect(r.lastText!.startsWith('在的')).toBe(true);
  });

  it('入站用户行（账本原形 role:agent + agent_id:user）→ lastAgent = user', () => {
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'agent', agent_id: 'user', content: '用户入站', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    const idx = newIndex();
    idx.refreshConversation(root, 'alpha~user');
    expect(idx.rosterSnapshot()[0]!.lastAgent).toBe('user');
    expect(idx.rosterSnapshot()[0]!.lastRole).toBe('agent');
  });

  it('rosterGapOf：未入账 → true；入账 → false；追加 → 再 true；增量后复 false；孤儿行 → true', () => {
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'user', agent_id: 'user', content: 'a', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    const idx = newIndex();
    expect(idx.rosterGapOf(root, 'alpha~user')).toBe(true);
    idx.refreshConversation(root, 'alpha~user');
    expect(idx.rosterGapOf(root, 'alpha~user')).toBe(false);
    appendMessages('alpha', 'alpha~user', [
      row({ role: 'agent', agent_id: 'alpha', content: 'b', timestamp: '2026-11-10T01:01:00.000Z', seq: 2, run: 'r1' }),
    ]);
    expect(idx.rosterGapOf(root, 'alpha~user')).toBe(true);
    idx.refreshConversation(root, 'alpha~user');
    expect(idx.rosterGapOf(root, 'alpha~user')).toBe(false);
    const r = idx.rosterSnapshot()[0]!;
    expect(r.lastAgent).toBe('alpha');
    expect(r.speech).toBe(2);
    // 孤儿行：目录消失（drop 由 reconcile 负责，缺口判定如实报需处理）
    fs.rmSync(path.join(root, 'agents', 'alpha', 'sessions', 'alpha~user'), { recursive: true, force: true });
    expect(idx.rosterGapOf(root, 'alpha~user')).toBe(true);
  });

  it('drop 清 roster 行（目录消失后 rosterGapOf 判孤儿）', () => {
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'user', agent_id: 'user', content: 'a', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    const idx = newIndex();
    idx.refreshConversation(root, 'alpha~user');
    idx.drop('alpha~user');
    expect(idx.rosterSnapshot()).toEqual([]);
  });
});

describe('cr-1185 · rosterSnapshot 群成员流折叠', () => {
  it('g-<gid>~<member> 行折叠进 gid：last_* 取最大、speech/total 求和', () => {
    writeMessages('alpha', 'g-g1x~alpha', [
      row({ role: 'agent', agent_id: 'alpha', content: 'A 说', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    writeMessages('beta', 'g-g1x~beta', [
      row({ role: 'agent', agent_id: 'beta', content: 'B 说', timestamp: '2026-11-10T02:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    const idx = newIndex();
    idx.refreshConversation(root, 'g-g1x~alpha');
    idx.refreshConversation(root, 'g-g1x~beta');
    const snap = idx.rosterSnapshot();
    expect(snap).toHaveLength(1); // 成员流折叠，不产独立行
    const g = snap[0]!;
    expect(g.key).toBe('g-g1x');
    expect(g.kind).toBe('group');
    expect(g.lastAgent).toBe('beta'); // 时标最大成员的末发言
    expect(g.lastText).toBe('B 说');
    expect(g.speech).toBe(2);
    // 对桶（非 g- 前缀）不折叠
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'agent', agent_id: 'alpha', content: 'x', timestamp: '2026-11-10T03:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    idx.refreshConversation(root, 'alpha~user');
    expect(idx.rosterSnapshot()).toHaveLength(2);
  });
});
