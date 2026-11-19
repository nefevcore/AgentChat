// cr1157-unread.test.ts —— 未读计数器纯库（bump 幂等 / take 清零 / clear 定向）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bumpUnread, takeUnread, clearUnread, readUnread } from '../src/unread.ts';

const ROOT = path.join('sandbox', 'test-core-unread-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const file = () => path.join(ROOT, 'meta', 'unread.json');

describe('bumpUnread（事件计数 + 幂等）', () => {
  it('首 bump 落盘 version 2 且 n=1', () => {
    const got = bumpUnread(ROOT, 'alpha~user', 'run-1');
    expect(got.n).toBe(1);
    expect(got.lastKey).toBe('run-1');
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as { version: number; entries: Record<string, { n: number }> };
    expect(raw.version).toBe(2);
    expect(raw.entries['alpha~user']!.n).toBe(1);
  });

  it('幂等：同 key 重复 bump 不双计（at-least-once 重投防）', () => {
    bumpUnread(ROOT, 'alpha~user', 'run-1');
    const again = bumpUnread(ROOT, 'alpha~user', 'run-1');
    expect(again.n).toBe(1);
    expect(readUnread(ROOT)['alpha~user']!.n).toBe(1);
  });

  it('异 key 递增；无 key 事件恒计（宁多不漏）', () => {
    bumpUnread(ROOT, 'alpha~user', 'run-1');
    bumpUnread(ROOT, 'alpha~user', 'run-2');
    bumpUnread(ROOT, 'alpha~user', undefined);
    expect(readUnread(ROOT)['alpha~user']!.n).toBe(3);
  });

  it('不同会话键独立计数；非法键 fail-loud', () => {
    bumpUnread(ROOT, 'alpha~user', 'run-1');
    bumpUnread(ROOT, 'g-abc', 'g-x1');
    expect(readUnread(ROOT)['alpha~user']!.n).toBe(1);
    expect(readUnread(ROOT)['g-abc']!.n).toBe(1);
    expect(() => bumpUnread(ROOT, 'a/b', 'k')).toThrow();
    expect(() => bumpUnread(ROOT, '..', 'k')).toThrow();
  });

  it('version 1 旧读位文件作废：读为空表并留档', () => {
    fs.mkdirSync(path.join(ROOT, 'meta'), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, entries: { 'alpha~user': { seq: 5, ts: 1 } } }), 'utf-8');
    expect(readUnread(ROOT)).toEqual({});
    expect(fs.existsSync(file() + '.corrupt')).toBe(true);
    // 旧语义清零后新计数从 1 起
    expect(bumpUnread(ROOT, 'alpha~user', 'run-9').n).toBe(1);
  });

  it('损坏文件留档不阻塞：读为空表', () => {
    fs.mkdirSync(path.join(ROOT, 'meta'), { recursive: true });
    fs.writeFileSync(file(), '{not json', 'utf-8');
    expect(readUnread(ROOT)).toEqual({});
    expect(fs.existsSync(file() + '.corrupt')).toBe(true);
  });
});

describe('takeUnread（全量取走清零）', () => {
  it('取走全部计数并落盘空表', () => {
    bumpUnread(ROOT, 'alpha~user', 'run-1');
    bumpUnread(ROOT, 'alpha~user', 'run-2');
    bumpUnread(ROOT, 'g-abc', 'g-x1');
    const taken = takeUnread(ROOT);
    expect(taken['alpha~user']!.n).toBe(2);
    expect(taken['g-abc']!.n).toBe(1);
    expect(readUnread(ROOT)).toEqual({});
    expect(takeUnread(ROOT)).toEqual({});
  });

  it('take 后新事件重新计数（清零不粘滞）', () => {
    bumpUnread(ROOT, 'a~user', 'r1');
    takeUnread(ROOT);
    expect(bumpUnread(ROOT, 'a~user', 'r2').n).toBe(1);
  });
});

describe('clearUnread（定向清零）', () => {
  it('只清目标会话，他键保留', () => {
    bumpUnread(ROOT, 'alpha~user', 'run-1');
    bumpUnread(ROOT, 'g-abc', 'g-x1');
    clearUnread(ROOT, 'alpha~user');
    expect(readUnread(ROOT)['alpha~user']).toBeUndefined();
    expect(readUnread(ROOT)['g-abc']!.n).toBe(1);
  });

  it('空键/已清键幂等（不写盘）', () => {
    clearUnread(ROOT, 'alpha~user');
    bumpUnread(ROOT, 'alpha~user', 'r1');
    clearUnread(ROOT, 'alpha~user');
    clearUnread(ROOT, 'alpha~user');
    expect(readUnread(ROOT)).toEqual({});
  });
});
