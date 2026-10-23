// ============================================================
// import.test.ts —— 恒等门导入测试（fixture 双侧往返）
//
// 数据根隔离红线：测试数据根恒 preview/sandbox/ 下独立目录。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanLegacyRoot, readLegacySession, agentIdOfPairKey, type LegacyRow, type LegacyRunSettled } from '../src/legacy.ts';
import { projectSession, projectSubcalls } from '../src/project.ts';
import { verifySession } from '../src/verify.ts';
import { readLedger, readJournal } from 'ac-ledger';

const ROOT = path.join(__dirname, '..', '..', 'sandbox', 'ac-import-test-' + process.pid);

beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 造一个旧形态会话目录（v1 中性格式行 + 三文件布局） */
function makeLegacyPair(conversationId: string, rows: unknown[], partials: unknown[] = [], subcalls: unknown[] = []): string {
  const dir = path.join(ROOT, 'sessions', conversationId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'),
    [JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-10-18T00:00:00Z' }), ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n');
  if (partials.length > 0) {
    fs.writeFileSync(path.join(dir, 'partials.jsonl'), partials.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  if (subcalls.length > 0) {
    fs.writeFileSync(path.join(dir, 'subcalls.jsonl'), subcalls.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return dir;
}

describe('scanLegacyRoot 四域扫描', () => {
  it('pairKey 会话（含 ~）归 pairs 域', () => {
    makeLegacyPair('abap-dev~user', [{ role: 'agent', content: 'hi', message_id: 'm1', timestamp: 'T', agent_id: 'abap-dev' }]);
    const inv = scanLegacyRoot(ROOT);
    expect(inv.pairs).toHaveLength(1);
    expect(inv.pairs[0].conversationId).toBe('abap-dev~user');
  });

  it('singles 会话（uuid 无 ~ + 顶层 singles/<sid>/session.json 元数据）归 singles 域', () => {
    makeLegacyPair('0192aaaa-uuid-1', [{ role: 'agent', content: 'x', message_id: 'm1', timestamp: 'T', agent_id: '' }]);
    fs.mkdirSync(path.join(ROOT, 'singles', '0192aaaa-uuid-1'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'singles', '0192aaaa-uuid-1', 'session.json'), JSON.stringify({ id: '0192aaaa-uuid-1', agentId: '', title: 't' }));
    const inv = scanLegacyRoot(ROOT);
    expect(inv.singles).toHaveLength(1);
    expect(inv.singles[0].sid).toBe('0192aaaa-uuid-1');
  });

  it('无 ~ 且无 singles 元数据的目录归 unknown 域（fail-loud 人工裁决面）', () => {
    makeLegacyPair('mystery-dir', [{ role: 'agent', content: 'x', message_id: 'm1', timestamp: 'T' }]);
    const inv = scanLegacyRoot(ROOT);
    expect(inv.unknown).toHaveLength(1);
  });

  it('shelf 形态 singles（sessions/singles/<ws>/<sid>/）归 singles 域', () => {
    const dir = path.join(ROOT, 'sessions', 'singles', 'ws-1', 'sid-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    const inv = scanLegacyRoot(ROOT);
    expect(inv.singles).toHaveLength(1);
    expect(inv.singles[0].sid).toBe('sid-a');
    expect(inv.singles[0].metaPath).toBeNull(); // 元数据缺席（已删档 single）
  });

  it('groups 域（sessions/groups/<gid>/ 群本体账本）识别', () => {
    const dir = path.join(ROOT, 'sessions', 'groups', 'g-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    const inv = scanLegacyRoot(ROOT);
    expect(inv.groups).toHaveLength(1);
    expect(inv.groups[0].gid).toBe('g-1');
  });

  it('subagents 域目录化会话识别', () => {
    const dir = path.join(ROOT, 'subagents', 'sub-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    const inv = scanLegacyRoot(ROOT);
    expect(inv.subagents).toHaveLength(1);
    expect(inv.subagents[0].subId).toBe('sub-1');
  });
});

describe('agentIdOfPairKey 尾段提取', () => {
  it('右起首 ~ 后段 = agent id（排序 pairKey）', () => {
    expect(agentIdOfPairKey('abap-dev~user')).toBe('user');
    expect(agentIdOfPairKey('user~abap-dev')).toBe('abap-dev'); // 排序后 user 在前
  });
  it('群转录流 gid~member 同形（成员恒最右）', () => {
    expect(agentIdOfPairKey('g1~neko')).toBe('neko');
  });
  it('无 ~ 抛错 fail-loud', () => {
    expect(() => agentIdOfPairKey('nosep')).toThrow();
  });
});

describe('projectSession 行投影（恒等门核心面）', () => {
  const ctx = { agentId: 'abap-dev', uuid: 'abap-dev~user', participants: ['abap-dev', 'user'], kind: 'agent-pair' };

  it('全字段恒等：role/agent_id/content/message_id/timestamp 逐行对齐', () => {
    const rows: LegacyRow[] = [
      { role: 'agent', content: '你好', message_id: 'm1', timestamp: '2026-10-01T00:00:01Z', agent_id: 'user' },
      { role: 'agent', content: '你好，有什么可以帮你？', message_id: 'm2', timestamp: '2026-10-01T00:00:02Z', agent_id: 'abap-dev', run: 'r1', steps: [{ content: '思考中…', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}' }] }] },
      { role: 'context', content: '[后台事件]', message_id: 'm3', timestamp: '2026-10-01T00:00:03Z', agent_id: 'abap-dev', source: 'event' },
    ];
    const p = projectSession(rows, [], ctx, []);
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toMatchObject({ role: 'agent', content: '你好', agent_id: 'user', message_id: 'm1' });
    expect(p.rows[1]).toMatchObject({ role: 'agent', content: '你好，有什么可以帮你？', agent_id: 'abap-dev' });
    expect(p.rows[2]).toMatchObject({ role: 'context', source: 'event' });
    // header
    expect(p.header.kind).toBe('agent-pair');
    expect(p.header.participants).toEqual(['abap-dev', 'user']);
    expect((p.header as { migrated?: boolean }).migrated).toBe(true);
    // journal 重建：steps → journal-step（工具卡全字段）+ settled
    expect(p.journal.filter((l) => l.type === 'journal-step')).toHaveLength(1);
    const step = p.journal.find((l) => l.type === 'journal-step') as { toolCalls?: unknown[] };
    expect(step.toolCalls).toHaveLength(1);
  });

  it('partial 死数据不入新账本', () => {
    const rows: LegacyRow[] = [
      { role: 'agent', content: '正常行', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
      { role: 'agent', content: '部分行', message_id: 'm2', timestamp: 'T', agent_id: 'abap-dev', partial: true, run: 'r9' },
    ];
    const p = projectSession(rows, [], ctx, []);
    expect(p.rows).toHaveLength(1);
    expect(p.stats.dropped).toBe(1);
  });

  it('baked 旧词（user/assistant）投影为 agent + 端点标注', () => {
    const rows: LegacyRow[] = [
      { role: 'user', content: '旧格式', message_id: 'm1', timestamp: 'T', name: 'user' },
      { role: 'assistant', content: '旧回复', message_id: 'm2', timestamp: 'T', name: 'abap-dev' },
    ];
    const p = projectSession(rows, [], ctx, []);
    expect(p.rows[0]).toMatchObject({ role: 'agent', agent_id: 'user' });
    expect(p.rows[1]).toMatchObject({ role: 'agent', agent_id: 'abap-dev' });
  });

  it('event/error 旧词 → context+source（双保险）', () => {
    const rows: LegacyRow[] = [{ role: 'event', content: '分隔', message_id: 'm1', timestamp: 'T', agent_id: 'abap-dev' }];
    const p = projectSession(rows, [], ctx, []);
    expect(p.rows[0]).toMatchObject({ role: 'context', source: 'event' });
  });

  it('未收束 run 部分行物化（recoverJournal 语义）', () => {
    const rows: LegacyRow[] = [
      { role: 'agent', content: '已收束', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
    ];
    const partials = [
      { run: 'r2', content: '未收束的中间推理', message_id: 'p1', timestamp: 'T2' },
    ];
    const p = projectSession(rows, partials, ctx, []);
    expect(p.stats.materialized).toBe(1);
    expect(p.rows[p.rows.length - 1]).toMatchObject({ content: '未收束的中间推理', run: 'r2' });
  });
});

describe('verifySession 恒等门', () => {
  const ctx = { agentId: 'a', uuid: 'a~user', participants: ['a', 'user'], kind: 'agent-pair' };

  it('干净投影零问题', () => {
    const rows: Array<LegacyRow | LegacyRunSettled> = [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
      { role: 'agent', content: 'a', message_id: 'm2', timestamp: 'T', agent_id: 'a', run: 'r1', steps: [{ content: 's', toolCalls: [{ id: 't1', name: 'n', arguments: '{}' }] }] },
      { type: 'run-settled', run: 'r1' } as const,
    ];
    const p = projectSession(rows, [], ctx, []);
    expect(verifySession(rows, [], p)).toEqual([]);
  });

  it('条数不符检出', () => {
    const rows: LegacyRow[] = [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: 'T', agent_id: 'user' },
    ];
    const p = projectSession(rows, [], ctx, []);
    p.rows.push({ role: 'agent', content: '多出来', message_id: 'x', timestamp: 'T', agent_id: 'a' });
    const problems = verifySession(rows, [], p);
    expect(problems.some((x) => x.kind === 'count')).toBe(true);
  });

  it('工具卡缺失检出', () => {
    const rows: LegacyRow[] = [
      { role: 'agent', content: 'a', message_id: 'm1', timestamp: 'T', agent_id: 'a', run: 'r1', steps: [{ content: 's', toolCalls: [{ id: 't1', name: 'n', arguments: '{}' }] }] },
    ];
    const p = projectSession(rows, [], ctx, []);
    p.journal = p.journal.filter((l) => l.type !== 'journal-step');
    const problems = verifySession(rows, [], p);
    expect(problems.some((x) => x.kind === 'tool-card')).toBe(true);
  });

  it('盘上往返：投影产物落盘 → readLedger/readJournal 回读对齐（新读面消费）', () => {
    const dir = path.join(ROOT, 'agents', 'a', 'sessions', 'a~user');
    fs.mkdirSync(path.dirname(path.join(dir, 'messages.jsonl')), { recursive: true });
    // 落盘前先造旧侧 fixture
    makeLegacyPair('a~user', [
      { role: 'agent', content: 'q', message_id: 'm1', timestamp: '2026-10-01T00:00:01Z', agent_id: 'user' },
      { role: 'agent', content: 'a', message_id: 'm2', timestamp: '2026-10-01T00:00:02Z', agent_id: 'a', run: 'r1' },
      { type: 'run-settled', run: 'r1' } as const,
    ]);
    const files = readLegacySession(path.join(ROOT, 'sessions', 'a~user'));
    const p = projectSession(files.rows, files.partials, ctx, files.extraFiles, files.headerCreatedAt);
    expect(verifySession(files.rows, files.partials, p)).toEqual([]);
    // 落盘（导入写面——messages.jsonl + journal/partials.jsonl）
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [JSON.stringify(p.header), ...p.rows.map((r) => JSON.stringify(r))].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'), p.journal.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // 新读面回读对齐
    const { rows: back, header } = readLedger(dir);
    expect(back).toHaveLength(2);
    expect(back[0].content).toBe('q');
    expect(header?.kind).toBe('agent-pair');
    const journal = readJournal(dir);
    expect(journal.filter((l) => l.type === 'journal-settled')).toHaveLength(1);
  });
});

describe('projectSubcalls 子调用档案', () => {
  it('subcall 行 → context + source:subcall + run 关联', () => {
    const ctx = { agentId: 'a', uuid: 'a~user', participants: ['a', 'user'], kind: 'agent-pair' };
    const rows: LegacyRow[] = [{ role: 'agent', content: '子调用结果', message_id: 's1', timestamp: 'T', agent_id: 'a', run: 'r1' }];
    const out = projectSubcalls(rows, ctx);
    expect(out[0]).toMatchObject({ role: 'context', source: 'subcall', run: 'r1' });
  });
});