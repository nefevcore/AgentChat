// ============================================================
// ac-migration-core/tests/migration.test.ts —— 迁移执行器 + 词汇 v2 迁移体
//
// · 版本标记读写（meta.json / .initialized 推断 v0 / 损坏 meta → -1）
// · runMigrations：按序应用 + 幂等跳过 + 迁移前快照 + 断点续跑（逐迁移落版本）
// · SESSION_MIGRATIONS：role v2 改写 + subcall 剥离（同 pass）+ 坏行保留
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDataVersion, runMigrations, writeDataVersion, type Migration } from '../src/index.ts';
import { SESSION_MIGRATIONS } from 'ac-session/src/migrations.ts';

let tmp = '';

function makeRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), 'ac-migration-'));
  return tmp;
}

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

describe('版本标记', () => {
  it('meta.json 读取 / 原子写', () => {
    const root = makeRoot();
    expect(readDataVersion(root)).toBe(0); // 空目录 v0
    writeDataVersion(root, 2, [{ id: 'x', at: 't' }]);
    expect(readDataVersion(root)).toBe(2);
  });

  it('损坏 meta → -1（全量重放窗口，幂等安全）', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'meta.json'), '{broken', 'utf-8');
    expect(readDataVersion(root)).toBe(-1);
  });
});

describe('runMigrations 执行器', () => {
  it('按序应用 + 幂等跳过（dataVersion 已达 → 零迁移）', () => {
    const root = makeRoot();
    const applied: string[] = [];
    const migrations: Migration[] = [
      { version: 1, id: 'm1', description: '', apply: () => { applied.push('m1'); } },
      { version: 2, id: 'm2', description: '', apply: () => { applied.push('m2'); } },
    ];
    const done = runMigrations(root, migrations);
    expect(done.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(readDataVersion(root)).toBe(2);
    // 再跑：已应用跳过
    expect(runMigrations(root, migrations)).toEqual([]);
    expect(applied).toEqual(['m1', 'm2']);
  });

  it('断点续跑：首迁移完成后崩溃 → 下次从断点继续', () => {
    const root = makeRoot();
    const boom: Migration = {
      version: 2,
      id: 'boom',
      description: '',
      apply: () => { throw new Error('crash'); },
    };
    const first: Migration = { version: 1, id: 'ok', description: '', apply: () => {} };
    expect(() => runMigrations(root, [first, boom])).toThrow('crash');
    expect(readDataVersion(root)).toBe(1); // v1 已落，v2 未
    // 修复后重跑：只应用 v2
    const fixed: Migration[] = [
      first,
      { version: 2, id: 'boom-fixed', description: '', apply: () => {} },
    ];
    expect(runMigrations(root, fixed).map((m) => m.id)).toEqual(['boom-fixed']);
  });
});

describe('SESSION_MIGRATIONS（词汇 v2）', () => {
  it('event/error → context+source；subcall 行剥离主文件；坏行保留', () => {
    const root = makeRoot();
    const dir = join(root, 'sessions', 'a~user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1 }),
      JSON.stringify({ role: 'agent', content: 'hi', agent_id: 'user', message_id: 'm1', timestamp: 't', seq: 1 }),
      JSON.stringify({ role: 'event', source: 'event', content: '任务完成', agent_id: 'a', message_id: 'm2', timestamp: 't', seq: 2 }),
      JSON.stringify({ role: 'error', content: 'fail', agent_id: 'a', message_id: 'm3', timestamp: 't', seq: 3 }),
      JSON.stringify({ type: 'tool-result', subcall: true, run: 'r1', tool_call_id: 'c#1', result: { ok: true }, seq: 4 }),
      JSON.stringify({ role: 'agent', content: '', agent_id: 'a', message_id: 'm4', timestamp: 't', seq: 5, partial: true, run: 'r1', steps: [{ content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: '{}', result: null }] }] }),
      JSON.stringify({ type: 'tool-result', run: 'r1', tool_call_id: 'c2', result: { ok: true, output: 'x' }, seq: 6 }),
      'BROKEN LINE {{{',
      JSON.stringify({ role: 'agent', content: 'done', agent_id: 'a', message_id: 'm7', timestamp: 't', seq: 7 }),
    ].join('\n'), 'utf-8');

    const done = runMigrations(root, SESSION_MIGRATIONS);
    expect(done.map((m) => m.id)).toEqual(['role-v2-subcall-split', 'partials-split']);
    const raw = readFileSync(join(dir, 'messages.jsonl'), 'utf-8');
    // 改写：event/error → context+source
    expect(raw).toContain('"role":"context"');
    expect(raw).toContain('"source":"event"');
    expect(raw).toContain('"source":"error"');
    // subcall 剥离：主文件不再含
    expect(raw).not.toContain('"subcall":true');
    // partials 摘除：partial 步行 + 直调补行迁 partials.jsonl（主文件零死重）
    expect(raw).not.toContain('"partial":true');
    expect(raw).not.toContain('"type":"tool-result"');
    const partRaw = readFileSync(join(dir, 'partials.jsonl'), 'utf-8');
    expect(partRaw).toContain('"partial":true');
    expect(partRaw).toContain('"type":"tool-result"');
    // 坏行原样保留
    expect(raw).toContain('BROKEN LINE {{{');
    // 剥离行落 subcalls.jsonl
    const sub = readFileSync(join(dir, 'subcalls.jsonl'), 'utf-8');
    expect(sub).toContain('"subcall":true');
    // 幂等：再跑零迁移
    expect(runMigrations(root, SESSION_MIGRATIONS)).toEqual([]);
    // 无 sessions 目录：安全 no-op
    expect(runMigrations(join(root, 'nonexistent' + 'x'), []).length === 0).toBe(true);
  });

  it('分步（live 已 v1 的根）：只应用 v2 partials-split——v1 行为不动', () => {
    const root = makeRoot();
    const dir = join(root, 'sessions', 'a~user');
    mkdirSync(dir, { recursive: true });
    // v1 后、v2 前的形态：role 已 context，但 partial/补行仍在主文件
    writeFileSync(join(dir, 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1 }),
      JSON.stringify({ role: 'agent', content: 'hi', agent_id: 'user', message_id: 'm1', timestamp: 't', seq: 1 }),
      JSON.stringify({ role: 'agent', content: '', agent_id: 'a', message_id: 'm2', timestamp: 't', seq: 2, partial: true, run: 'r1', steps: [{ content: '', toolCalls: [{ id: 'c1', name: 'run_code', arguments: '{}', result: null }] }] }),
      JSON.stringify({ type: 'tool-result', run: 'r1', tool_call_id: 'c1', result: { ok: true }, seq: 3 }),
      JSON.stringify({ role: 'context', source: 'event', content: '通知', agent_id: 'a', message_id: 'm4', timestamp: 't', seq: 4 }),
    ].join('\n'), 'utf-8');
    // 预置 meta v1（模拟 live 根已应用 v1）
    writeFileSync(join(root, 'meta.json'), JSON.stringify({ dataVersion: 1, applied: [{ id: 'role-v2-subcall-split', at: 't' }] }), 'utf-8');

    const done = runMigrations(root, SESSION_MIGRATIONS);
    expect(done.map((m) => m.id)).toEqual(['partials-split']); // 只 v2
    const raw = readFileSync(join(dir, 'messages.jsonl'), 'utf-8');
    expect(raw).not.toContain('"partial":true');
    expect(raw).not.toContain('"type":"tool-result"');
    expect(raw).toContain('"role":"context","source":"event"'); // v1 形态未动
    expect(raw).toContain('"content":"hi"');
    const partRaw = readFileSync(join(dir, 'partials.jsonl'), 'utf-8');
    expect(partRaw).toContain('"partial":true');
    expect(partRaw).toContain('"tool_call_id":"c1"');
    expect(readDataVersion(root)).toBe(2);
  });
});
