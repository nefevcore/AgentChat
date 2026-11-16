// ============================================================
// session-meta.test.ts —— 聚合读面回归（cr-1138）
//
// sessionMeta/sessionByDay：records 表 SQL 统计——total/speech/firstAt/
// lastAt/activeDays/runs/lastRole/lastAgent + 词法 kind；单会话权威
//（带 refresh 对账）vs 全局已索引子集；跨域镜像合计；空会话/不存在
// 会话语义。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionIndex, sessionKindOf } from '../src/core.ts';

let root: string;
let dbFile: string;
const openIdx: SessionIndex[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-index-meta-'));
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

function writeMessages(domain: string, convId: string, lines: string[]): void {
  const dir = path.join(root, 'agents', domain, 'sessions', convId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n');
}

const row = (o: Record<string, unknown>) => JSON.stringify(o);
const UUID = '3f2b8c1a-9d4e-4f7a-b2c6-1e8a5d0f9b31';

describe('cr-1138 · sessionKindOf 词法分类', () => {
  it('g- 前缀 = group；含 ~ = pair；uuid = single；其余 other', () => {
    expect(sessionKindOf('g-m0abcd12')).toBe('group');
    expect(sessionKindOf('g-m0abcd12~beta')).toBe('group');
    expect(sessionKindOf('alpha~user')).toBe('pair');
    expect(sessionKindOf(UUID)).toBe('single');
    expect(sessionKindOf('alpha')).toBe('other');
    expect(sessionKindOf('sub_9x1')).toBe('other');
  });
});

describe('cr-1138 · sessionMeta 单会话聚合', () => {
  it('发言/非发行计数、时间锚、activeDays、runs、lastRole/lastAgent、kind、domains', () => {
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'user', agent_id: 'user', content: '在吗', message_id: 'm1', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
      row({ role: 'context', agent_id: 'alpha', source: 'skill', content: '技能上下文', message_id: 'm2', timestamp: '2026-11-10T01:00:01.000Z', seq: 2, run: 'r1' }),
      row({ role: 'agent', agent_id: 'alpha', content: '在的', message_id: 'm3', timestamp: '2026-11-10T01:00:05.000Z', seq: 3, run: 'r1' }),
      row({ role: 'agent', agent_id: 'alpha', content: '次日回复', message_id: 'm4', timestamp: '2026-11-11T09:30:00.000Z', seq: 4, run: 'r2' }),
    ]);
    const idx = newIndex();
    const m = idx.sessionMeta(root, 'alpha~user')!;
    expect(m).not.toBeNull();
    expect(m.kind).toBe('pair');
    expect(m.domains).toEqual(['alpha']);
    expect(m.total).toBe(4);
    expect(m.speech).toBe(3); // 2 agent + 1 user（context 不计）
    expect(m.firstAt).toBe('2026-11-10T01:00:00.000Z');
    expect(m.lastAt).toBe('2026-11-11T09:30:00.000Z');
    expect(m.activeDays).toBe(2);
    expect(m.runs).toBe(2);
    expect(m.lastRole).toBe('agent');
    expect(m.lastAgent).toBe('alpha');
  });

  it('跨域镜像（对桶双侧各记）合计入 total；追加后 refresh 增量更新', () => {
    writeMessages('alpha', 'alpha~beta', [
      row({ role: 'agent', agent_id: 'alpha', content: 'A', message_id: 'a1', timestamp: '2026-11-10T01:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    writeMessages('beta', 'alpha~beta', [
      row({ role: 'agent', agent_id: 'beta', content: 'B', message_id: 'b1', timestamp: '2026-11-10T02:00:00.000Z', seq: 1, run: 'r1' }),
    ]);
    const idx = newIndex();
    const m = idx.sessionMeta(root, 'alpha~beta')!;
    expect(m.total).toBe(2);
    expect(m.domains).toEqual(['alpha', 'beta']);
    expect(m.lastAgent).toBe('beta'); // ts 最大者
    // 追加（未对账先查 → refreshConversation 惰性补账）
    fs.appendFileSync(path.join(root, 'agents', 'alpha', 'sessions', 'alpha~beta', 'messages.jsonl'),
      row({ role: 'agent', agent_id: 'alpha', content: 'A2', message_id: 'a2', timestamp: '2026-11-12T03:00:00.000Z', seq: 2, run: 'r2' }) + '\n');
    const m2 = idx.sessionMeta(root, 'alpha~beta')!;
    expect(m2.total).toBe(3);
    expect(m2.lastAgent).toBe('alpha');
  });

  it('空会话（目录在场零行）= 全零 meta；不存在会话 = null', () => {
    writeMessages('alpha', UUID, []);
    const idx = newIndex();
    const empty = idx.sessionMeta(root, UUID)!;
    expect(empty.kind).toBe('single');
    expect(empty.total).toBe(0);
    expect(empty.speech).toBe(0);
    expect(empty.firstAt).toBeNull();
    expect(idx.sessionMeta(root, 'no-such-conv')).toBeNull();
  });
});

describe('cr-1138 · v2 事件行形态（真实落盘行——初版测试只覆盖 v1 的漏网面）', () => {
  it('v2 step/* 行只有数字 ts 无 role/timestamp：计入活动口径、不计入发言口径', () => {
    const stepTs = Date.parse('2026-11-14T10:00:00.000Z');
    writeMessages('alpha', UUID, [
      // 一条 v2 发言行（message：带 role + ISO timestamp）
      row({ type: 'message', role: 'agent', agent_id: 'alpha', content: '开始', message_id: 'v1', timestamp: '2026-11-14T09:00:00.000Z', seq: 1, run: 'r1' }),
      // v2 事件行（只有数字 ts，无 role/timestamp）——真实形态
      row({ type: 'step/reasoning', run: 'r1', step: 0, stepId: 'r1:0', text: '思考', reasoningMs: 100, ts: stepTs, seq: 2 }),
      row({ type: 'step/tool-call', run: 'r1', step: 0, toolCallId: 'tc1', name: 'read', arguments: '{}', ts: stepTs + 1000, seq: 3 }),
      row({ type: 'run-end', run: 'r1', finish: 'stop', ts: stepTs + 2000, seq: 4 }),
    ]);
    const idx = newIndex();
    const m = idx.sessionMeta(root, UUID)!;
    expect(m.total).toBe(4);
    // 发言口径：仅 1 条 message 行
    expect(m.speech).toBe(1);
    expect(m.speechDays).toBe(1);
    expect(m.lastSpeechAt).toBe('2026-11-14T09:00:00.000Z');
    // 活动口径：step/run-end 的数字 ts 同样计入（初版 ts 列对 v2 行恒 NULL → 全丢）
    expect(m.lastAt).toBe('2026-11-14T10:00:02.000Z');
    expect(m.firstAt).toBe('2026-11-14T09:00:00.000Z');
    expect(m.activeDays).toBe(1);
    // 末发言者口径 = message 行（不是活动末行 run-end）
    expect(m.lastRole).toBe('agent');
    expect(m.lastAgent).toBe('alpha');
    // 末活动行型 = run-end
    expect(m.lastType).toBe('run-end');
  });

  it('跨日：活动日 vs 发言日可分离（Agent 跑了长 run 没发言的形态）', () => {
    const d1 = Date.parse('2026-11-13T08:00:00.000Z');
    const d2 = Date.parse('2026-11-14T20:00:00.000Z');
    writeMessages('beta', 'beta~user', [
      row({ role: 'agent', agent_id: 'beta', content: '回复', message_id: 'm1', timestamp: '2026-11-13T08:00:00.000Z', seq: 1, run: 'r1' }),
      // 次日只有 step 活动（无发言）
      row({ type: 'step/content', run: 'r2', step: 0, text: '静默产出', ts: d2, seq: 2 }),
      row({ type: 'run-end', run: 'r2', finish: 'stop', ts: d2 + 5000, seq: 3 }),
    ]);
    const idx = newIndex();
    const m = idx.sessionMeta(root, 'beta~user')!;
    expect(m.activeDays).toBe(2);   // 11-13 与 11-14 都有活动
    expect(m.speechDays).toBe(1);   // 只有 11-13 有发言
    expect(m.lastAt).toBe('2026-11-14T20:00:05.000Z');
    expect(m.lastSpeechAt).toBe('2026-11-13T08:00:00.000Z'); // diving 沉默天数取此
    void d1;
  });
});

describe('cr-1138 · sessionByDay 日聚合', () => {
  it('单会话：按 UTC 日分桶；全局：跨会话聚合已索引子集', () => {
    writeMessages('alpha', 'alpha~user', [
      row({ role: 'user', agent_id: 'user', content: 'x', message_id: 'm1', timestamp: '2026-11-10T23:59:59.000Z', seq: 1, run: 'r1' }),
      row({ role: 'agent', agent_id: 'alpha', content: 'y', message_id: 'm2', timestamp: '2026-11-11T00:00:01.000Z', seq: 2, run: 'r1' }),
    ]);
    writeMessages('beta', UUID, [
      row({ role: 'agent', agent_id: 'beta', content: 'z', message_id: 's1', timestamp: '2026-11-11T05:00:00.000Z', seq: 1, run: 'q1' }),
    ]);
    const idx = newIndex();
    const days = idx.sessionByDay(root, 'alpha~user').days;
    expect(days).toEqual([
      { day: '2026-11-10', total: 1, speech: 1 },
      { day: '2026-11-11', total: 1, speech: 1 },
    ]);
    // 全局 = 已索引子集：单会话查询只对账 alpha~user（beta 的 single 未
    // 索引不在内）——与注释语义一致；需要其入列则先经 sessionMeta 对账。
    const r0 = idx.sessionByDay(root);
    const g0 = r0.days;
    expect(r0.coverage.totalConversations).toBe(2); // 盘上共 2 个会话目录
    expect(r0.coverage.indexedConversations).toBe(1); // 只对账过 alpha~user
    expect(g0).toEqual([
      { day: '2026-11-10', total: 1, speech: 1 },
      { day: '2026-11-11', total: 1, speech: 1 },
    ]);
    idx.sessionMeta(root, UUID); // 对账 single 会话后全局收口
    const r1 = idx.sessionByDay(root);
    expect(r1.coverage.indexedConversations).toBe(2);
    expect(r1.days).toEqual([
      { day: '2026-11-10', total: 1, speech: 1 },
      { day: '2026-11-11', total: 2, speech: 2 },
    ]);
  });
});
