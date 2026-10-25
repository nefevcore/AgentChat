import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertConfig, importAgentsTree } from '../src/agents-tree.ts';
import { projectUserLedger, projectUserLedgers } from '../src/user-projection.ts';
import { importSession } from '../src/writer.ts';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-import-tree-'));
});

describe('convertConfig（tags→tools 换轨）', () => {
  it('装载词展开为行引用；档位词留 tags；行内档位归 settings', () => {
    const out = convertConfig('a', {
      id: 'a',
      tags: ['shell', 'web', 'fs', 'full-access', 'tc-programmatic', 'observe', 'manipulate', 'admin'],
    });
    expect(out.rows).toEqual(expect.arrayContaining(['shell-tools', 'web-tools', 'fs-tools', 'fs-search']));
    expect(out.tags).toEqual(['full-access', 'tc-programmatic']);
    expect(out.settings).toEqual({
      browser: { observe: true, manipulate: true },
      collab: { admin: true },
    });
  });

  it('未知装载词 fail-loud', () => {
    expect(() => convertConfig('a', { id: 'a', tags: ['no-such-tag'] })).toThrow(/未知词/);
  });

  it('无 tags 不产生 rows（行集全集语义保持）', () => {
    const out = convertConfig('a', { id: 'a', model: null });
    expect(out.rows).toBeUndefined();
    expect(out.tags).toBeUndefined();
  });

  it('旧 tools 在场 = 并集落 rows 键（点名单不被换轨收窄）', () => {
    const out = convertConfig('a', { id: 'a', tags: ['infra'], tools: ['fs_read'] });
    expect(out.rows).toEqual(expect.arrayContaining(['fs_read', 'math']));
  });
});

describe('importAgentsTree（树域迁移）', () => {
  it('config 换轨 + entries 归拢 + 身份文件拷贝 + 幂等重入', () => {
    const legacy = path.join(tmp, 'agents', 'demo');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ id: 'demo', tags: ['shell', 'full-access'] }));
    fs.writeFileSync(path.join(legacy, 'todo.json'), '{"items":[]}');
    fs.writeFileSync(path.join(legacy, 'AGENT.md'), '# demo');
    fs.writeFileSync(path.join(legacy, 'avatar.svg'), '<svg/>');
    const target = path.join(tmp, 'target');
    const r1 = importAgentsTree(path.join(tmp), target);
    expect(r1).toEqual([{ agentId: 'demo', configConverted: true, entriesMoved: 1, identityFilesCopied: 2 }]);
    expect(fs.existsSync(path.join(target, 'agents/demo/config.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'agents/demo/entries/todo.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'agents/demo/AGENT.md'))).toBe(true);
    // 幂等重入：二跑零新增
    const r2 = importAgentsTree(path.join(tmp), target);
    expect(r2[0].configConverted).toBe(false);
    expect(r2[0].entriesMoved).toBe(0);
    expect(r2[0].identityFilesCopied).toBe(0);
  });
});

describe('projectUserLedger（user 账本投影）', () => {
  it('转义目录名（remote:x 形态）不双重转义（cr-547 回归锁）', async () => {
    const target = path.join(tmp, 'target');
    const legacySession = path.join(tmp, 'l-esc');
    fs.mkdirSync(legacySession, { recursive: true });
    fs.writeFileSync(path.join(legacySession, 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-01-01T00:00:00Z', participants: ['remote:dev-1', 'user'] }),
      JSON.stringify({ role: 'user', content: 'x', message_id: 'm', timestamp: '2026-01-01T00:00:01Z', agent_id: 'user' }),
    ].join('\n') + '\n');
    // 导入：agentId 'remote:dev-1' → 目录名 remote%3Adev-1
    importSession(legacySession, { agentId: 'remote:dev-1', uuid: 'e1', participants: ['remote:dev-1', 'user'], kind: 'user' }, target, path.join(tmp, 'staging'));
    // 投影：扫描面传盘上目录名（已转义）——不得再转义（remote%253A 形态读不到）
    const stats = await projectUserLedgers(target);
    expect(stats.sessions).toBe(1);
    expect(stats.rows).toBe(1);
  });
  it('终稿层 own/peer 投影 + context 行不入 + 幂等跳过', async () => {
    const legacySession = path.join(tmp, 'legacy-sess');
    fs.mkdirSync(legacySession, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-01-01T00:00:00Z', participants: ['a', 'user'] }),
      JSON.stringify({ role: 'user', content: 'hi', message_id: 'm1', timestamp: '2026-01-01T00:00:01Z', agent_id: 'user' }),
      JSON.stringify({ role: 'assistant', content: 'hello', message_id: 'm2', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a', run: 'r1' }),
      JSON.stringify({ role: 'event', content: 'x', message_id: 'm3', timestamp: '2026-01-01T00:00:03Z', agent_id: 'a' }),
    ];
    fs.writeFileSync(path.join(legacySession, 'messages.jsonl'), lines.join('\n') + '\n');
    const target = path.join(tmp, 'target');
    importSession(legacySession, { agentId: 'a', uuid: 'u1', participants: ['a', 'user'], kind: 'user' }, target, path.join(tmp, 'staging'));
    const r = await projectUserLedger(target, 'a', 'u1');
    expect(r.skipped).toBe(false);
    expect(r.rows).toBe(2); // user 行 + assistant 行；event context 行不入
    const r2 = await projectUserLedger(target, 'a', 'u1');
    expect(r2.skipped).toBe(true); // 幂等
  });

  it('全域扫描：kind=user 与含 user 的直答 pair 投影；agent⇄agent pair 不投（cr-611）', async () => {
    const target = path.join(tmp, 'target');
    const mk = (uuid: string, kind: string, participants: string[]) => {
      const legacySession = path.join(tmp, 'l-' + uuid);
      fs.mkdirSync(legacySession, { recursive: true });
      fs.writeFileSync(path.join(legacySession, 'messages.jsonl'), [
        JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-01-01T00:00:00Z', participants }),
        JSON.stringify({ role: 'user', content: 'x', message_id: 'm', timestamp: '2026-01-01T00:00:01Z', agent_id: 'user' }),
      ].join('\n') + '\n');
      importSession(legacySession, { agentId: participants[0] ?? 'a', uuid, participants, kind }, target, path.join(tmp, 'staging'));
    };
    mk('s-user', 'user', ['a', 'user']);
    mk('s-direct', 'agent-pair', ['a', 'user']); // 直答对桶（前端 1v1 视图按此键取历史）
    mk('s-delegate', 'agent-pair', ['a', 'b']); // 委托 pair——非 viewer 会话
    const stats = await projectUserLedgers(target);
    expect(stats.sessions).toBe(2);
    expect(stats.rows).toBe(2);
    expect(fs.existsSync(path.join(target, 'viewer', 'sessions', 's-direct'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'viewer', 'sessions', 's-delegate'))).toBe(false);
  });
});

describe('importSession 幂等护栏（cr-547 全内容比对）', () => {
  it('同 uuid 不同内容 fail-loud（双位分叉形态）', () => {
    const target = path.join(tmp, 'target');
    const mk = (dir: string, text: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
        JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-01-01T00:00:00Z', participants: ['a', 'user'] }),
        JSON.stringify({ role: 'user', content: text, message_id: 'm', timestamp: '2026-01-01T00:00:01Z', agent_id: 'user' }),
      ].join('\n') + '\n');
    };
    mk(path.join(tmp, 'v1'), 'one');
    importSession(path.join(tmp, 'v1'), { agentId: 'a', uuid: 'z', participants: ['a', 'user'], kind: 'user' }, target, path.join(tmp, 'staging'));
    mk(path.join(tmp, 'v2'), 'two');
    expect(() => importSession(path.join(tmp, 'v2'), { agentId: 'a', uuid: 'z', participants: ['a', 'user'], kind: 'user' }, target, path.join(tmp, 'staging'))).toThrow(/内容不一致/);
  });
});