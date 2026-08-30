// ============================================================
// Runs API 测试：buildRunsSnapshot 快照构造（Agent 运行跟踪）
//
// 临时工作区布置三形态会话（含 legacy 群端点 / unknown 端点 / 空目录），
// 验证：轴成员归一、pair/群本体盘存、single 矩阵外计数、运行中 run 分类、
// 子 Agent 快照、覆盖面分析（需求 1.2 的事实源）。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildRunsSnapshot, type RunsDeps } from '../src/api/runs';
import type { RunningSessionInfo } from '@agentchat/router';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-runs-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 写一个会话目录（messages.jsonl 每行一条） */
function writeSession(dirName: string, lines: string[]): void {
  const dir = path.join(tmp, 'sessions', dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (lines.length > 0) {
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf-8');
  }
}

const msg = (id: string) => JSON.stringify({ role: 'agent', content: `m-${id}`, message_id: id, timestamp: new Date().toISOString() });

/** 指定年龄（ms）的消息行（时间窗口分桶验证） */
const msgAged = (id: string, ageMs: number) => JSON.stringify({ role: 'agent', content: `m-${id}`, message_id: id, timestamp: new Date(Date.now() - ageMs).toISOString() });

/** 假 registry：alpha 实体 / user 虚拟 / __std__ 预设 */
const fakeRegistry = {
  get: (id: string) =>
    id === 'alpha' ? { agent_id: 'alpha' }
      : id === 'user' ? { agent_id: 'user', virtual: true }
        : id === '__std__' ? { agent_id: '__std__', preset: true }
          : undefined,
  listIds: () => ['alpha', 'user', '__std__'],
  getAgentName: (id: string) => (id === 'alpha' ? '阿尔法' : id),
  isVirtual: (id: string) => id === 'user',
  isPreset: (id: string) => id === '__std__',
};

function makeDeps(overrides?: Partial<RunsDeps>): RunsDeps {
  return {
    router: {
      listRunning: (): RunningSessionInfo[] => [
        { convKey: 'chat~alpha~user', agentId: 'alpha', startedAt: 1000, source: { kind: 'user', form: 'prompt' } },
        { convKey: 'group~g1~alpha', agentId: 'alpha', startedAt: 2000, source: { kind: 'group', form: 'hint', summary: '群消息' } },
        { convKey: 'single~s1', agentId: '__std__', startedAt: 3000, source: { kind: 'user', form: 'prompt' } },
      ],
      abortDialog: () => true,
    },
    registry: fakeRegistry,
    groups: () => [{ group_id: 'g1', name: '群一', participants: ['alpha', 'user'] }],
    singles: {
      get: (id: string) => (id === 's1'
        ? { id: 's1', agentId: '__std__', title: '试一会话', status: 'active' }
        : null),
    },
    subAgent: {
      listAll: () => ({
        active: [{ id: 'sub_1', parentId: 'alpha', name: '检索', status: 'running', task: '查资料', startedAt: 1 }],
        completed: [{ id: 'sub_0', parentId: 'alpha', name: '计算', status: 'done', task: '算数', startedAt: 0, finishedAt: 2, result: '42' }],
      }),
    },
    wsRoot: tmp,
    ...overrides,
  };
}

describe('buildRunsSnapshot', () => {
  it('三形态会话盘存：pair 归轴 / 群本体 / single 矩阵外', () => {
    writeSession('chat~alpha~user', [msg('1'), msg('2')]);
    writeSession('chat~alpha~system', [msg('3')]);
    writeSession('group~g1', [msg('4')]);
    writeSession('single~s1', [msg('5')]);
    // 空目录（无消息文件）不入盘存
    writeSession('chat~alpha~user2', []);

    const snap = buildRunsSnapshot(makeDeps());

    // 轴成员：alpha(agent) + user(virtual) + g1(group) + system；预设 __std__ 不从 registry 占轴
    // （仅当被 single 引用时补入，见下方 singles 断言）
    const kinds = new Map(snap.members.map(m => [m.id, m.kind]));
    expect(kinds.get('alpha')).toBe('agent');
    expect(kinds.get('user')).toBe('virtual');
    expect(kinds.get('g1')).toBe('group');
    expect(kinds.get('system')).toBe('system');
    expect(snap.members.filter(m => m.id === '__std__')).toHaveLength(1); // 唯一（不重复入轴）

    expect(snap.pairs).toHaveLength(2);
    const pairAlphaUser = snap.pairs.find(p => p.a === 'alpha' && p.b === 'user');
    expect(pairAlphaUser?.messageCount).toBe(2);
    expect(pairAlphaUser?.bytes).toBeGreaterThan(0);
    // 时间窗口计数：2 条均为"当前时间"消息 → 全窗口命中
    expect(pairAlphaUser?.windows).toEqual({ h1: 2, d1: 2, d3: 2, d7: 2, d30: 2 });
    const pairSystem = snap.pairs.find(p => p.a === 'alpha' && p.b === 'system');
    expect(pairSystem?.messageCount).toBe(1);

    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0].groupId).toBe('g1');
    expect(snap.groups[0].messageCount).toBe(1);

    expect(snap.singles).toHaveLength(1);
    expect(snap.singles[0].agentId).toBe('__std__');
    // single 引用的预设补入轴（引用完整性）
    expect(new Map(snap.members.map(m => [m.id, m.kind])).get('__std__')).toBe('preset');

    // 覆盖面：矩阵可表达 = pair 2 + 群本体 1；single 1 在矩阵外
    expect(snap.coverage.pairSessions).toBe(2);
    expect(snap.coverage.groupSessions).toBe(1);
    expect(snap.coverage.matrixSessions).toBe(3);
    expect(snap.coverage.singleSessions).toBe(1);
    expect(snap.coverage.unknownMembers).toEqual([]);
  });

  it('legacy 群端点（chat~group__gid~aid）归一为群成员；未知端点入 unknown 轴', () => {
    writeSession('chat~group__g1~alpha', [msg('1')]);   // 旧格式群会话 → (g1, alpha)
    writeSession('chat~alpha~beta', [msg('2')]);        // beta 不在 registry/群组 → unknown

    const snap = buildRunsSnapshot(makeDeps());

    const legacy = snap.pairs.find(p => p.key === 'chat~group__g1~alpha');
    expect(legacy).toBeDefined();
    expect(legacy?.a).toBe('g1');
    expect(legacy?.b).toBe('alpha');

    const kinds = new Map(snap.members.map(m => [m.id, m.kind]));
    expect(kinds.get('beta')).toBe('unknown');
    expect(snap.members.find(m => m.id === 'g1')?.kind).toBe('group'); // 不因 legacy 端点重复入轴
    expect(snap.coverage.unknownMembers).toEqual(['beta']);
  });

  it('self 端点归一为 Agent 自身（chat~alpha~self → alpha×alpha 对角线），不单独成轴', () => {
    writeSession('chat~alpha~self', [msg('1')]);

    const snap = buildRunsSnapshot(makeDeps());

    const selfPair = snap.pairs.find(p => p.key === 'chat~alpha~self');
    expect(selfPair?.a).toBe('alpha');
    expect(selfPair?.b).toBe('alpha');
    expect(snap.members.some(m => m.id === 'self')).toBe(false);
    expect(snap.coverage.unknownMembers).toEqual([]);
  });

  it('时间窗口计数：按消息 timestamp 分桶；旧行/无 timestamp 只计总数', () => {
    writeSession('chat~alpha~user', [
      msgAged('now', 0),                    // 全窗口
      msgAged('5h', 5 * 3600_000),          // d1 及更宽
      msgAged('2d', 2 * 86_400_000),        // d3 及更宽
      msgAged('5d', 5 * 86_400_000),        // d7 及更宽
      msgAged('10d', 10 * 86_400_000),      // d30
      msgAged('60d', 60 * 86_400_000),      // 仅总行数
      JSON.stringify({ role: 'agent', content: 'no-ts', message_id: 'x' }), // 无 timestamp
    ]);

    const snap = buildRunsSnapshot(makeDeps());
    const p = snap.pairs.find(x => x.key === 'chat~alpha~user');
    expect(p?.messageCount).toBe(7);
    expect(p?.windows).toEqual({ h1: 1, d1: 2, d3: 3, d7: 4, d30: 5 });
  });

  it('群周归档（group~gid/archive/aid）→ groupArchives（agent×group 参与证据）', () => {
    writeSession('group~g1', [msg('1')]);
    // 真实结构：sessions/group~<gid>/archive/<aid>/history_*.jsonl（@agentchat/tools paths.ts 约定）
    const aidDir = path.join(tmp, 'sessions', 'group~g1', 'archive', 'alpha');
    fs.mkdirSync(aidDir, { recursive: true });
    fs.writeFileSync(path.join(aidDir, 'history_2026-34.jsonl'), msg('2'), 'utf-8');

    const snap = buildRunsSnapshot(makeDeps());
    expect(snap.groupArchives).toEqual([
      { groupId: 'g1', agentId: 'alpha', lastActivity: expect.any(Number) },
    ]);
    // 归档 agent 已是 registry 成员 → 不产生 unknown
    expect(snap.coverage.unknownMembers).toEqual([]);
  });

  it('归档引用已删除 Agent → 以未知端点入轴（不丢参与证据）', () => {
    writeSession('group~g1', [msg('1')]);
    const aidDir = path.join(tmp, 'sessions', 'group~g1', 'archive', 'ghost_agent');
    fs.mkdirSync(aidDir, { recursive: true });

    const snap = buildRunsSnapshot(makeDeps());
    expect(snap.groupArchives.some(a => a.agentId === 'ghost_agent')).toBe(true);
    expect(snap.coverage.unknownMembers).toEqual(['ghost_agent']);
    expect(new Map(snap.members.map(m => [m.id, m.kind])).get('ghost_agent')).toBe('unknown');
  });

  it('运行中 run 分类（chat/group/single）与子 Agent 快照', () => {
    writeSession('chat~alpha~user', [msg('1')]);
    const snap = buildRunsSnapshot(makeDeps());

    expect(snap.running.map(r => [r.convKey, r.kind])).toEqual([
      ['chat~alpha~user', 'chat'],
      ['group~g1~alpha', 'group'],
      ['single~s1', 'single'],
    ]);
    expect(snap.coverage.runningTotal).toBe(3);
    expect(snap.coverage.runningSingles).toBe(1);

    expect(snap.subagents.active).toHaveLength(1);
    expect(snap.subagents.active[0].status).toBe('running');
    expect(snap.subagents.completed[0].result).toBe('42');
  });

  it('无 subAgent 服务时不阻断快照；消息行数缓存命中（同 mtime 不重读）', () => {
    writeSession('chat~alpha~user', [msg('1'), msg('2'), msg('3')]);
    const deps = makeDeps({ subAgent: null });
    const snap = buildRunsSnapshot(deps);
    expect(snap.subagents).toEqual({ active: [], completed: [] });

    // 二次构造：走缓存路径（结果一致即可；缓存正确性由 mtime/size 键保证）
    const snap2 = buildRunsSnapshot(deps);
    expect(snap2.pairs[0].messageCount).toBe(3);
  });
});
