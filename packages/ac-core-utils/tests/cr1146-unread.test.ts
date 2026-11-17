// cr1146-unread.test.ts —— 未读读位读写面 + 水位合并 + 未读派生纯函数
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { markRead, readMarks, readMarkOf, mergeMark, unreadOf, type ReadMark, type UnreadRow } from '../src/unread.ts';

const ROOT = path.join('sandbox', 'test-core-unread-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const file = () => path.join(ROOT, 'meta', 'unread.json');

function row(p: Partial<UnreadRow> & { message_id: string }): UnreadRow {
  return { role: 'agent', agent_id: 'alpha', content: 'x', ...p };
}

describe('markRead / readMarks（读写面）', () => {
  it('首写落盘（meta/unread.json version 1）且可读回', () => {
    const got = markRead(ROOT, 'alpha~user', { seq: 5, messageId: 'm-5' });
    expect(got.seq).toBe(5);
    expect(got.messageId).toBe('m-5');
    expect(typeof got.ts).toBe('number');
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as { version: number; entries: Record<string, ReadMark> };
    expect(raw.version).toBe(1);
    expect(raw.entries['alpha~user']!.seq).toBe(5);
    expect(readMarkOf(ROOT, 'alpha~user')!.seq).toBe(5);
    expect(readMarkOf(ROOT, 'nonexistent')).toBeUndefined();
  });

  it('幂等：重复调用同水位不变（文件 mtime 不动语义——落定值恒等）', () => {
    const a = markRead(ROOT, 'g1', { seq: 10, messageId: 'm-a', ts: 1000 });
    const b = markRead(ROOT, 'g1', { seq: 10, messageId: 'm-a', ts: 2000 });
    expect(b.seq).toBe(10);
    // 幂等路径 ts 取大刷新（诊断面）
    expect(b.ts).toBe(2000);
    expect(a.seq).toBe(b.seq);
    expect(readMarks(ROOT)['g1']!.seq).toBe(10);
  });

  it('低水位不回退：seq 5 在场后 seq 3 被拒', () => {
    markRead(ROOT, 's1', { seq: 5, messageId: 'm-5', ts: 1000 });
    const got = markRead(ROOT, 's1', { seq: 3, messageId: 'm-3', ts: 9000 });
    expect(got.seq).toBe(5); // 高水位保持
  });

  it('损坏文件留档后空态（不炸）', () => {
    fs.mkdirSync(path.join(ROOT, 'meta'), { recursive: true });
    fs.writeFileSync(file(), '{broken json', 'utf-8');
    expect(readMarks(ROOT)).toEqual({});
    expect(fs.existsSync(file() + '.corrupt')).toBe(true);
  });

  it('非法会话键拒绝（路径分隔 / ..）', () => {
    expect(() => markRead(ROOT, 'a/b', { seq: 1 })).toThrow();
    expect(() => markRead(ROOT, '..', { seq: 1 })).toThrow();
  });

  it('seq 与 messageId 双缺席拒绝（读位须有锚）', () => {
    expect(() => markRead(ROOT, 'k', {})).toThrow();
  });
});

describe('mergeMark（水位合并语义）', () => {
  const m = (seq: number | undefined, messageId: string | undefined, ts: number): ReadMark =>
    ({ ...(seq !== undefined ? { seq } : {}), ...(messageId !== undefined ? { messageId } : {}), ts });

  it('单调取大：后读覆盖先读', () => {
    expect(mergeMark(m(3, 'a', 1), m(7, 'b', 2))?.seq).toBe(7);
    expect(mergeMark(m(7, 'b', 2), m(3, 'a', 1))).toBeNull();
  });

  it('seq 缺席回落 messageId：旧无 seq 新有 → 升格；旧有新无 → 不回退', () => {
    expect(mergeMark(undefined, m(2, 'b', 1))?.seq).toBe(2);
    expect(mergeMark(m(undefined, 'old', 1), m(9, 'b', 2))?.seq).toBe(9);
    expect(mergeMark(m(9, 'b', 2), m(undefined, 'old', 1))).toBeNull();
  });

  it('双无 seq：同 messageId 幂等（ts 取大）；异锚 ts 大者胜', () => {
    expect(mergeMark(m(undefined, 'x', 1), m(undefined, 'x', 5))?.ts).toBe(5);
    expect(mergeMark(m(undefined, 'x', 5), m(undefined, 'x', 1))).toBeNull();
    expect(mergeMark(m(undefined, 'x', 5), m(undefined, 'y', 9))?.messageId).toBe('y');
    expect(mergeMark(m(undefined, 'x', 9), m(undefined, 'y', 5))).toBeNull();
  });

  it('孤儿会话键安全缺席：未登记键读取 = undefined（对账面自处理）', () => {
    expect(readMarkOf(ROOT, 'gone-conv')).toBeUndefined();
  });
});

describe('unreadOf（未读派生）', () => {
  it('无读位 = 全量未读（事实行计数）', () => {
    const rows = [row({ message_id: 'm1', seq: 1 }), row({ message_id: 'm2', seq: 2 })];
    expect(unreadOf(rows, undefined)).toBe(2);
  });

  it('seq 水位：新于水位的行计数', () => {
    const rows = [row({ message_id: 'm1', seq: 1 }), row({ message_id: 'm2', seq: 2 }), row({ message_id: 'm3', seq: 3 })];
    expect(unreadOf(rows, { seq: 2, ts: 1 })).toBe(1);
    expect(unreadOf(rows, { seq: 3, ts: 1 })).toBe(0);
  });

  it('messageId 回落：旧数据（行无 seq）按锚判定——已读行不计', () => {
    const rows = [row({ message_id: 'm1' }), row({ message_id: 'm2' })];
    expect(unreadOf(rows, { messageId: 'm1', ts: 1 })).toBe(1);
  });

  it('非事实行不计：user 入站行 / 段行 / 注入行 / 空终稿 / context 行', () => {
    const rows = [
      row({ message_id: 'u1', agent_id: 'user' }),
      row({ message_id: 'sg1', source: 'segment' }),
      row({ message_id: 'ij1', source: 'inject' }),
      row({ message_id: 'sg2' }), // seg- 前缀
      row({ message_id: 'e1', content: '' }),
      row({ message_id: 'c1', role: 'context' }),
      row({ message_id: 'f1' }),
    ].map((r) => ({ ...r, message_id: r.message_id.startsWith('sg') && r.source === undefined ? 'seg-' + r.message_id : r.message_id }));
    expect(unreadOf(rows, undefined)).toBe(1);
  });

  it('跨域判重：同 requestId 只计一次；同 run 多行只计一次', () => {
    const rows = [
      row({ message_id: 'm1', requestId: 'rq1', agent_id: 'alpha' }),
      row({ message_id: 'm2', requestId: 'rq1', agent_id: 'beta' }),
      row({ message_id: 'm3', run: 'run-9', agent_id: 'alpha' }),
      row({ message_id: 'm4', run: 'run-9', agent_id: 'beta' }),
    ];
    expect(unreadOf(rows, undefined)).toBe(2);
  });
});
