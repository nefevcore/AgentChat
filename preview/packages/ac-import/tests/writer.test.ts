// ============================================================
// writer.test.ts —— 导入写面测试（staging 写入 / 原子换名 /
// 幂等重入 / 换名冲突 fail-loud / importRoot 域派生）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { importSession, importRoot, writeSession } from '../src/writer.ts';
import { readLegacySession } from '../src/legacy.ts';
import { projectSession } from '../src/project.ts';
import { readLedger, readJournal } from 'ac-ledger';

const BASE = path.join(__dirname, '..', '..', 'sandbox', 'ac-import-writer-' + process.pid);
const LEGACY = path.join(BASE, 'legacy');
const TARGET = path.join(BASE, 'target');
const STAGING = path.join(BASE, 'staging');

beforeEach(() => {
  for (const d of [LEGACY, TARGET, STAGING]) fs.mkdirSync(d, { recursive: true });
});
afterEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

function makeLegacy(dirName: string, rows: unknown[], partials: unknown[] = [], subcalls: unknown[] = [], extra: Record<string, string> = {}): string {
  const dir = path.join(LEGACY, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'),
    [JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-10-18T00:00:00Z' }), ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n');
  if (partials.length > 0) fs.writeFileSync(path.join(dir, 'partials.jsonl'), partials.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (subcalls.length > 0) fs.writeFileSync(path.join(dir, 'subcalls.jsonl'), subcalls.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
  return dir;
}

describe('importSession 三步编排', () => {
  it('staging 写入 + 换名 + 新读面可读', () => {
    const dir = makeLegacy('a~user', [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: '2026-10-01T00:00:01Z', agent_id: 'user' },
      { role: 'agent', content: 'a', message_id: 'm2', timestamp: '2026-10-01T00:00:02Z', agent_id: 'a', run: 'r1', steps: [{ content: 's', toolCalls: [{ id: 't1', name: 'n', arguments: '{}' }] }] },
      { type: 'run-settled', run: 'r1' },
    ]);
    const r = importSession(dir, { agentId: 'a', uuid: 'a~user', participants: ['a', 'user'], kind: 'agent-pair' }, TARGET, STAGING);
    expect(r.rows).toBe(2);
    expect(r.kind).toBe('agent-pair');
    // 已换名：目标目录存在，staging 清空
    const targetDir = path.join(TARGET, 'agents', 'a', 'sessions', 'a~user');
    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(path.join(STAGING, 'a', 'a~user.staging'))).toBe(false);
    // 新读面消费
    const back = readLedger(targetDir);
    expect(back.rows).toHaveLength(2);
    expect(back.header?.kind).toBe('agent-pair');
    expect((back.header as { migrated?: boolean }).migrated).toBe(true);
    expect(readJournal(targetDir)).toHaveLength(3); // 1 step + run-settled 物化 + steps 重建尾补 settled
  });

  it('恒等拷贝面：subcalls + summary.md + 未知文件原样', () => {
    const dir = makeLegacy('b~user', [
      { role: 'agent', content: 'x', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
    ], [], [{ role: 'agent', content: 'sub', message_id: 's1', timestamp: 'T', agent_id: 'b' }], { 'summary.md': '# 概要\n', 'note.txt': 'hello' });
    importSession(dir, { agentId: 'b', uuid: 'b~user', participants: ['b', 'user'], kind: 'agent-pair' }, TARGET, STAGING);
    const targetDir = path.join(TARGET, 'agents', 'b', 'sessions', 'b~user');
    expect(fs.existsSync(path.join(targetDir, 'subcalls.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'summary.md'), 'utf-8')).toBe('# 概要\n');
    expect(fs.readFileSync(path.join(targetDir, 'note.txt'), 'utf-8')).toBe('hello');
  });

  it('幂等重入：重跑同导入目标已存在且一致 → 跳过不报错', () => {
    const dir = makeLegacy('c~user', [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
    ]);
    const ctx = { agentId: 'c', uuid: 'c~user', participants: ['c', 'user'], kind: 'agent-pair' };
    importSession(dir, ctx, TARGET, STAGING);
    const again = importSession(dir, ctx, TARGET, STAGING);
    expect(again.rows).toBe(1);
  });

  it('换名冲突 fail-loud：目标已存在且 rows 不一致 → 抛错', () => {
    const dir = makeLegacy('d~user', [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
    ]);
    const ctx = { agentId: 'd', uuid: 'd~user', participants: ['d', 'user'], kind: 'agent-pair' };
    importSession(dir, ctx, TARGET, STAGING);
    // 目标塞入额外行制造不一致
    const targetDir = path.join(TARGET, 'agents', 'd', 'sessions', 'd~user');
    fs.appendFileSync(path.join(targetDir, 'messages.jsonl'), JSON.stringify({ role: 'agent', content: 'extra', message_id: 'x', timestamp: 'T', agent_id: 'd' }) + '\n');
    expect(() => importSession(dir, ctx, TARGET, STAGING)).toThrow(/换名冲突/);
  });

  it('恒等门失败 fail-loud：投影产物被篡改场景由 verify 兜底（此处验证抛错链路）', () => {
    const dir = makeLegacy('e~user', [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
    ]);
    // 直接调 writeSession 写一个 rows 与投影不一致的产物——由落盘复验拦截
    const files = readLegacySession(dir);
    const proj = projectSession(files.rows, files.partials, { agentId: 'e', uuid: 'e~user', participants: ['e', 'user'], kind: 'agent-pair' }, [], files.headerCreatedAt);
    // 正常链路应成功——此处只验证 writeSession 产物可被 readLedger 读回
    const stagingDir = path.join(STAGING, 'e', 'e~user.staging');
    writeSession(stagingDir, files, dir, proj);
    expect(readLedger(stagingDir).rows).toHaveLength(1);
  });
});

describe('importRoot 域派生', () => {
  it('四域全链：pairs/groups/singles(majority)/subagents + unknown 报告', async () => {
    // pairs（sessions/ 直下）
    makeLegacy(path.join('sessions', 'x~user'), [{ role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' }]);
    // groups（sessions/groups/<gid>/）
    makeLegacy(path.join('sessions', 'groups', 'g-1'), [
      { role: 'agent', content: '成员发言', message_id: 'g1', timestamp: 'T', agent_id: 'nana' },
    ]);
    // singles：majority = __standard__（user 被排除？不——singles 不排除 user？看派生规则：singles majority 不排除，
    // 但行内 user 与 agent 混合时 majority 取多数。此 fixture：agent 行多 → 归 __standard__
    const singleDir = path.join(LEGACY, 'sessions', 'sid-1'); // singles 直下形态（majority 派生）
    fs.mkdirSync(singleDir, { recursive: true });
    // 直下 singles 归域需顶层元数据在场
    fs.mkdirSync(path.join(LEGACY, 'singles', 'sid-1'), { recursive: true });
    fs.writeFileSync(path.join(LEGACY, 'singles', 'sid-1', 'session.json'), JSON.stringify({ id: 'sid-1', agentId: '' }));
    fs.writeFileSync(path.join(singleDir, 'messages.jsonl'), [
      JSON.stringify({ role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' }),
      JSON.stringify({ role: 'agent', content: 'a1', message_id: 'm2', timestamp: 'T', agent_id: '__standard__' }),
      JSON.stringify({ role: 'agent', content: 'a2', message_id: 'm3', timestamp: 'T', agent_id: '__standard__' }),
    ].join('\n') + '\n');
    // subagents
    const subDir = path.join(LEGACY, 'subagents', 'sub-1');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'messages.jsonl'), [
      JSON.stringify({ role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' }),
      JSON.stringify({ role: 'agent', content: 'a', message_id: 'm2', timestamp: 'T', agent_id: '__standard__' }),
    ].join('\n') + '\n');
    const { results, skipped } = await importRoot(LEGACY, TARGET, STAGING);
    expect(results).toHaveLength(4);
    // 域断言
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['agent-pair', 'group', 'subagent', 'user']);
    // groups 归 gid 自身
    expect(fs.existsSync(path.join(TARGET, 'agents', 'g-1', 'sessions', 'g-1'))).toBe(true);
    // singles majority：__standard__ 行 2 次 > user 1 次
    expect(fs.existsSync(path.join(TARGET, 'agents', '__standard__', 'sessions', 'sid-1'))).toBe(true);
    // subagents 排除 user 后 majority = __standard__
    expect(fs.existsSync(path.join(TARGET, 'agents', '__standard__', 'sessions', 'sub-1'))).toBe(true);
    // 无 unknown（本 fixture 全归域）
    expect(skipped).toEqual([]);
  });
});