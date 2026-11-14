import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertConfig, importAgentsTree } from '../src/agents-tree.ts';
import { importSession } from '../src/writer.ts';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-import-tree-'));
});

describe('convertConfig（tags→rows + 结构化档位换轨）', () => {
  it('装载词展开为行引用；档位词丢弃（cr-1082）/tc-* 换轨 toolMode；行内档位归 levels', () => {
    const out = convertConfig('a', {
      id: 'a',
      tags: ['shell', 'web', 'fs', 'full-access', 'tc-programmatic', 'observe', 'manipulate', 'admin'],
    });
    expect(out.rows).toEqual(expect.arrayContaining(['shell-tools', 'web-tools', 'fs-tools', 'fs-search']));
    expect(out.access).toBeUndefined(); // cr-1082：access 档位词丢弃（轴退役）
    expect(out.toolMode).toBe('tc-programmatic');
    expect(out.tags).toBeUndefined(); // cr-953：tags 键输出恒删
    expect(out.levels).toEqual({
      browser: 'manipulate', // 层级取最高
      collab: 'admin',
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
    expect(fs.existsSync(path.join(target, 'agents/demo/agent.patch.yml'))).toBe(true); // cr-1036 批3：v3 写口（config.json 产线退役）
    expect(fs.existsSync(path.join(target, 'agents/demo/entries/todo.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'agents/demo/AGENT.md'))).toBe(true);
    // 幂等重入：二跑零新增
    const r2 = importAgentsTree(path.join(tmp), target);
    expect(r2[0].configConverted).toBe(false);
    expect(r2[0].entriesMoved).toBe(0);
    expect(r2[0].identityFilesCopied).toBe(0);
  });
});

// cr-973（cr-972 第一刀）：viewer 物化账本退役——projectUserLedger(s)
// 随 user-projection.ts 删除（终稿层 = ac-ledger projectUserReplay 读时
// 投影，导入不再物化 viewer/sessions；投影语义回归锁见
// packages/ac-ledger/tests/project.test.ts）。
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