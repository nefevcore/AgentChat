// ============================================================
// agent-cascade.test.ts —— agent 删除的会话面级联（cr-1209 / D1 硬删全部）
// 数据根恒 sandbox（红线）。验收四面孤儿：对端 agent 副本 / meta 元数据 /
// 群名册与成员流 / 会话快照；以及不动他人数据的边界。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAgentConfig } from 'ac-agents-core';
import { writeGroupConfig } from 'ac-core-utils';
import { collectAgentTraces, cleanupAgentTraces } from '../src/agent-cascade.ts';

const ROOT = path.join('sandbox', 'test-agent-cascade-' + process.pid);
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 会话目录（agents/<agent>/sessions/<key>，带 messages.jsonl 头行） */
function seedSession(agent: string, key: string, rows: string[] = []): string {
  const dir = path.join(ROOT, 'agents', agent, 'sessions', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => r + '\n').join(''), 'utf-8');
  return dir;
}

/** 会话元数据（meta/sessions/<sid>.json） */
function seedMeta(sid: string, agentId: string): string {
  const file = path.join(ROOT, 'meta', 'sessions', sid + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: sid, agentId, status: 'active' }), 'utf-8');
  return file;
}

/** 快照目录（file-snapshots/<encodeURIComponent(key)>） */
function seedSnapshot(key: string): string {
  const dir = path.join(ROOT, 'file-snapshots', encodeURIComponent(key));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ts.meta.json'), '{}', 'utf-8');
  return dir;
}

/** 群成员流（gid~member） */
function seedMemberStream(agent: string, gid: string, member: string): string {
  return seedSession(agent, gid + '~' + member);
}

describe('collectAgentTraces（删树前枚举）', () => {
  it('收本域会话键 + meta 归属会话 + 名册含该 agent 的群；不含他人数据', () => {
    writeAgentConfig(ROOT, { id: 'gone', model: 'mock' });
    seedSession('gone', 'aaaaaaaa-1111-2222-3333-444444444444');
    seedSession('gone', 'gone~peer');
    seedMeta('bbbbbbbb-1111-2222-3333-444444444444', 'gone'); // 消息未落域、元数据在
    seedMeta('cccccccc-1111-2222-3333-444444444444', 'keep'); // 他人会话
    seedSession('keep', 'dddddddd-1111-2222-3333-444444444444');
    writeGroupConfig(ROOT, { id: 'g1', name: 'G1', members: ['gone', 'keep'], createdAt: 1 });
    writeGroupConfig(ROOT, { id: 'g2', name: 'G2', members: ['keep'], createdAt: 2 });

    const traces = collectAgentTraces(ROOT, 'gone');
    expect(traces.conversations.sort()).toEqual([
      'aaaaaaaa-1111-2222-3333-444444444444',
      'bbbbbbbb-1111-2222-3333-444444444444',
      'gone~peer',
    ]);
    expect(traces.groupIds).toEqual(['g1']); // g2 名册无此人
  });

  it('无 sessions 域 / 无 meta 域 = 空集合（良定义降级）', () => {
    expect(collectAgentTraces(ROOT, 'ghost')).toEqual({ conversations: [], groupIds: [] });
  });
});

describe('cleanupAgentTraces（删树后清理）', () => {
  it('四面孤儿全清：对端副本 + meta + 群名册/成员流 + 快照；他人数据不动', () => {
    writeAgentConfig(ROOT, { id: 'gone', model: 'mock' });
    writeAgentConfig(ROOT, { id: 'keep', model: 'mock' });
    const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const peerCopy = seedSession('keep', sid); // 对端副本（本侧树已删）
    const meta = seedMeta(sid, 'gone');
    const snap = seedSnapshot(sid);
    const streamSnap = seedSnapshot('g1~gone'); // 被删者的群成员流快照（全局目录）
    const otherStream = seedMemberStream('keep', 'g1', 'keep'); // 他人流——保留
    writeGroupConfig(ROOT, { id: 'g1', name: 'G1', members: ['gone', 'keep'], createdAt: 1 });
    const untouched = seedSession('keep', 'dddddddd-1111-2222-3333-444444444444');

    const traces = collectAgentTraces(ROOT, 'gone');
    fs.rmSync(path.join(ROOT, 'agents', 'gone'), { recursive: true, force: true }); // 删树（RPC 侧动作）
    const { stats, groups } = cleanupAgentTraces(ROOT, 'gone', traces);

    expect(fs.existsSync(peerCopy)).toBe(false);          // 对端副本清
    expect(fs.existsSync(meta)).toBe(false);              // 元数据清
    expect(fs.existsSync(snap)).toBe(false);              // 快照清
    expect(fs.existsSync(streamSnap)).toBe(false);        // 被删者成员流快照清
    expect(fs.existsSync(otherStream)).toBe(true);        // 他人成员流保留
    expect(fs.existsSync(untouched)).toBe(true);          // 他人会话保留
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual(['keep']); // 名册已移出
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'groups', 'g1', 'group.json'), 'utf-8')).members).toEqual(['keep']);
    expect(stats).toMatchObject({ conversations: 1, peerDirs: 1, metaFiles: 1, groups: 1, snapshots: 2 });
  });

  it('幂等：重复 cleanup 不再报错、计数归零（目录/文件已缺席）', () => {
    writeAgentConfig(ROOT, { id: 'gone' });
    const sid = 'eeeeeeee-1111-2222-3333-444444444444';
    seedMeta(sid, 'gone');
    const traces = collectAgentTraces(ROOT, 'gone');
    fs.rmSync(path.join(ROOT, 'agents', 'gone'), { recursive: true, force: true });
    cleanupAgentTraces(ROOT, 'gone', traces);
    const second = cleanupAgentTraces(ROOT, 'gone', traces);
    expect(second.stats).toMatchObject({ peerDirs: 0, metaFiles: 0, snapshots: 0, groups: 0 });
  });
});