// ============================================================
// migrate-sessions-v2.test.ts —— M-B cr-1271 迁移工具锁定：
//   多代夹具（v0 无标注 / 纯 v1 / 过渡态）全量迁移对拍 + staging 原子
//   换名（journal/subcalls 转 .migrated 防双计）+ 幂等重入（v2 头跳过 /
//   中断残留补归档）+ --dry 零写入 + --agent/--conv 过滤 + 崩溃孤儿跳过。
// 工具本体零换算代码（链驱动）——对账判据 sessionFactsEqual 在工具内
// fail-loud，本测试锁工具面行为与产物形态。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger, readJournal } from '../../ac-ledger/src/reader.ts';
import { domainFactsOf } from '../src/events-core.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts/migrate-sessions-v2.mjs');
const ROOT = path.join('sandbox', 'test-migrate-sessions-' + process.pid);

const ISO = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const RUN = 'run-send-1';

function run(...args: string[]): string {
  return execFileSync('node', [SCRIPT, ROOT, ...args], { encoding: 'utf-8' });
}

/** 纯 v1 会话夹具（M-A pureV1 同构：入站 + 单步 run + 注入 + 收束） */
function writePureV1(domain: string, convId: string, opts: { v0?: boolean; bare?: boolean; torn?: boolean } = {}): string {
  const dir = path.join(ROOT, 'agents', domain, 'sessions', convId);
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  const header: Record<string, unknown> = { type: 'session-header', createdAt: ISO(T0), participants: ['user', domain], kind: 'user', migrated: true };
  if (!opts.v0) header.version = 1;
  const rows = [
    JSON.stringify(header),
    JSON.stringify({ role: 'agent', content: '问个问题', message_id: 'm-1', timestamp: ISO(T0), agent_id: 'user', requestId: 'send-1', seq: 1 }),
    JSON.stringify({ role: 'agent', content: '终稿答案', message_id: 'm-2', timestamp: ISO(T0 + 30_000), agent_id: domain, requestId: 'send-1', run: RUN, runMs: 30_000, seq: 5 }),
  ];
  if (opts.bare) rows.push(JSON.stringify({ role: 'agent', content: '裸行', agent_id: domain })); // cr-978 缺 message_id/timestamp
  if (opts.torn) rows.push('{"role":"agent","content":"撕裂'); // 坏行（readLedger 滤）
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'journal/partials.jsonl'), [
    JSON.stringify({ type: 'journal-step', run: RUN, step: 0, content: '', reasoning: '先想想', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], ts: T0 + 1000, seq: 2 }),
    JSON.stringify({ type: 'journal-inject', run: RUN, content: '<sys>提醒</sys>', injectSource: 'skill', label: '已加载技能', ts: T0 + 1500, seq: 3 }),
    JSON.stringify({ type: 'journal-tool-result', run: RUN, toolCallId: 'c1', result: { ok: true, output: 'file-body' }, durationMs: 120, ts: T0 + 2000, seq: 4 }),
    JSON.stringify({ type: 'journal-settled', run: RUN, finish: 'ok', usage: { prompt: 100, completion: 20, total: 120 }, model: 'test-model', ts: T0 + 29_000, seq: 6 }),
  ].join('\n') + '\n', 'utf-8');
  return dir;
}

beforeEach(() => { fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('M-B 多代夹具全量迁移', () => {
  it('纯 v1：v2 头 + 注入锚回填 + journal/subcalls 转 .migrated + 零双计', () => {
    const dir = writePureV1('alpha', 'conv-1');
    const out = run();
    expect(out).toContain('可迁移 v1/v0→v2       : 1');
    const { header, rows } = readLedger(dir);
    expect(header?.version).toBe(2);
    expect(header?.migratedFrom).toBe(1);
    expect(header?.migrated).toBe(true); // 旧头附加键继承
    // journal 转挂（防双计——v2 头 + journal 原名同场会双计）
    expect(fs.existsSync(path.join(dir, 'journal/partials.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'journal/partials.jsonl.migrated'))).toBe(true);
    const facts = domainFactsOf('alpha', 2, rows, readJournal(dir), []);
    const inj = [...facts.runs.values()].flatMap((f) => f.events).find((e) => e.kind === 'inject');
    expect(inj && (inj as { injectionId?: string }).injectionId).toBe('jinj-' + RUN + '-3'); // seq=3 回填
    expect(facts.runs.get(RUN)!.events.filter((e) => e.kind === 'inject')).toHaveLength(1); // 单份（零双计）
    expect(facts.speech.map((s) => s.messageId).sort()).toEqual(['m-1', 'm-2']);
  });

  it('v0 无 version 头（回落 1）照迁 + 过渡态（v1 头混 v2 词汇行）照迁', () => {
    writePureV1('alpha', 'conv-v0', { v0: true });
    const dir2 = writePureV1('alpha', 'conv-mix');
    const rows2 = [
      ...fs.readFileSync(path.join(dir2, 'messages.jsonl'), 'utf-8').trim().split('\n'),
      JSON.stringify({ type: 'step/reasoning', run: 'run-2', step: 0, text: '新词汇行思考', ts: T0 + 60_000, seq: 7 }),
      JSON.stringify({ type: 'run-end', run: 'run-2', finish: 'completed', ts: T0 + 61_000, seq: 8 }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir2, 'messages.jsonl'), rows2, 'utf-8');
    const out = run();
    expect(out).toContain('可迁移 v1/v0→v2       : 2');
    for (const convId of ['conv-v0', 'conv-mix']) {
      const { header } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', convId));
      expect(header?.version).toBe(2);
    }
  });

  it('cr-978 裸行：缺 message_id 迁后落空串（note 计数）；撕裂行两侧读面均滤', () => {
    const dir = writePureV1('alpha', 'conv-bare', { bare: true, torn: true });
    const out = run();
    expect(out).toContain('1 行缺 message_id（cr-978 裸行——迁后落空串）');
    const { rows } = readLedger(dir);
    const bare = rows.filter((r) => r.content === '裸行');
    expect(bare).toHaveLength(1);
    expect(bare[0]!.message_id).toBeUndefined(); // 行面键缺席；facts 层 v2RowToEvent String 兜底 ''（读侧既有容错）
    expect(rows.some((r) => r.content === '撕裂')).toBe(false); // 撕裂行不进产物
  });
});

describe('M-B 幂等重入与残留', () => {
  it('v2 头跳过：重跑零变化；--dry 零写入', () => {
    writePureV1('alpha', 'conv-1');
    run();
    const dir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-1');
    const snap = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8');
    const out2 = run();
    expect(out2).toContain('已最新（v2 头跳过）   : 1');
    expect(out2).toContain('可迁移 v1/v0→v2       : 0');
    expect(fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8')).toBe(snap);
    // --dry 对 v1 会话零写入
    writePureV1('beta', 'conv-dry');
    const dirB = path.join(ROOT, 'agents', 'beta', 'sessions', 'conv-dry');
    const before = fs.readFileSync(path.join(dirB, 'messages.jsonl'), 'utf-8');
    const out3 = run('--dry');
    expect(out3).toContain('dry-run 预演');
    expect(fs.readFileSync(path.join(dirB, 'messages.jsonl'), 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(dirB, 'journal/partials.jsonl'))).toBe(true); // journal 未动
  });

  it('中断残留：v2 头 + journal 原名在场 → 补转 .migrated 后报告', () => {
    const dir = writePureV1('alpha', 'conv-1');
    run();
    // 人为复原中断态：journal 从 .migrated 改回原名（模拟换名后、转挂前崩溃）
    fs.renameSync(path.join(dir, 'journal/partials.jsonl.migrated'), path.join(dir, 'journal/partials.jsonl'));
    const { rows } = readLedger(dir); // v2 头 + journal 原名 = 双计现场
    const doubled = domainFactsOf('alpha', 2, rows, readJournal(dir), []);
    expect(doubled.runs.get(RUN)!.events.filter((e) => e.kind === 'inject')).toHaveLength(2); // 双计证据
    const out = run();
    expect(out).toContain('中断残留补归档        : 1');
    expect(fs.existsSync(path.join(dir, 'journal/partials.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'journal/partials.jsonl.migrated'))).toBe(true);
    expect(out).toContain('可迁移 v1/v0→v2       : 0'); // 不重迁（头已 v2）
  });

  it('崩溃孤儿域（仅 journal、messages 缺席）：显式跳过不静默', () => {
    const dir = path.join(ROOT, 'agents', 'gamma', 'sessions', 'conv-orphan');
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'journal/partials.jsonl'), JSON.stringify({ type: 'journal-step', run: 'r1', step: 0, content: 'x', ts: T0, seq: 1 }) + '\n', 'utf-8');
    const out = run();
    expect(out).toContain('仅 journal 跳过       : 1');
    expect(out).toContain('崩溃孤儿域');
    expect(fs.existsSync(path.join(dir, 'messages.jsonl'))).toBe(false); // 未物化
  });

  it('空会话目录：不计错误', () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'delta', 'sessions', 'conv-empty'), { recursive: true });
    const out = run();
    expect(out).toContain('空会话                : 1');
    expect(out).toContain('错误                  : 0');
  });
});

describe('M-B 过滤与子域', () => {
  it('--agent glob：直属域与 children 子域；--conv 子串', () => {
    writePureV1('alpha', 'conv-1');
    writePureV1('beta', 'conv-2');
    // 子域夹具：alpha/children/sub-1
    const sub = path.join(ROOT, 'agents', 'alpha', 'children', 'sub-1', 'sessions', 'conv-sub');
    fs.mkdirSync(path.join(sub, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'messages.jsonl'), JSON.stringify({ type: 'session-header', version: 1, createdAt: ISO(T0), participants: [], kind: 'user' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(sub, 'journal/partials.jsonl'), JSON.stringify({ type: 'journal-settled', run: 'r9', finish: 'ok', ts: T0, seq: 1 }) + '\n', 'utf-8');
    const outA = run('--agent', 'alpha');
    expect(outA).toContain('alpha — conv-1');
    expect(outA).not.toContain('alpha/children/sub-1'); // 精确 id 不递归（children 是独立身份域）
    expect(outA).not.toContain('beta — conv-2');
    const outR = run('--agent', 'alpha**'); // ** 递归覆盖子域
    expect(outR).toContain('alpha/children/sub-1');
    const outC = run('--conv', 'conv-2');
    expect(outC).toContain('beta — conv-2');
    expect(outC).toContain('可迁移 v1/v0→v2       : 1');
  });
});
