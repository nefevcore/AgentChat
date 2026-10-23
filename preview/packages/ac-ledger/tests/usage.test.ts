// ============================================================
// usage 自报链单测（cr-538）：writer settle 计量落 journal-settled /
// 事件信 schema 校验与信封形态。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readJournal } from '../src/reader.ts';
import { makeUsageEnvelope, validateUsagePayload, isUsageReport, usageStreamKey } from 'ac-envelope-core';

const ROOT = path.join('preview', 'sandbox', 'test-ledger-usage-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0010';
const meter = { usage: { prompt: 120, completion: 30, promptAccumulated: 200, steps: 2, cacheHit: 50 }, model: 'mock' };

describe('writer settle 计量（journal 计量——R2）', () => {
  it('meter 随 journal-settled 落盘（usage + model 字段）', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', uuid), { participants: ['alpha', 'user'], kind: 'user' });
    await w.settle({
      role: 'agent', content: '终稿', agent_id: 'alpha', requestId: 'reply-r1', uuid,
    }, 'run-r1', 'ok', meter);
    const j = readJournal(sessionDir(ROOT, 'alpha', uuid));
    const settled = j.find((l) => l.type === 'journal-settled');
    expect(settled).toMatchObject({ run: 'run-r1', finish: 'ok', model: 'mock' });
    expect((settled as { usage?: { prompt: number } }).usage).toMatchObject({ prompt: 120, steps: 2 });
  });

  it('meter 缺席 = 旧行为（无 usage/model 键——additive 兼容）', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'beta', uuid), { participants: ['beta', 'user'], kind: 'user' });
    await w.settle({
      role: 'agent', content: '终稿', agent_id: 'beta', requestId: 'reply-r2', uuid,
    }, 'run-r2', 'ok');
    const j = readJournal(sessionDir(ROOT, 'beta', uuid));
    const settled = j.find((l) => l.type === 'journal-settled') as unknown as Record<string, unknown>;
    expect('usage' in settled).toBe(false);
    expect('model' in settled).toBe(false);
  });
});

describe('usage 事件信 schema（envelope-core）', () => {
  const payload = {
    subject: 'usage-run' as const, agent: 'alpha', model: 'mock', finish: 'ok',
    usage: { prompt: 1, completion: 1, promptAccumulated: 2, steps: 1 },
    conversationId: 'user~alpha', runId: 'run-r1',
  };

  it('合法 payload 零 issues + 信封形态（kind=receipt / budget=0 / to=host）', () => {
    expect(validateUsagePayload(payload)).toEqual([]);
    const env = makeUsageEnvelope({ requestId: 'usage-run-r1', payload });
    expect(env).toMatchObject({ kind: 'receipt', budget: 0, to: 'host', sender: 'alpha', uuid: usageStreamKey('alpha') });
    expect(isUsageReport(env)).toBe(true);
  });

  it('缺失面 fail-closed（subject/agent/usage/conversationId）', () => {
    expect(validateUsagePayload({ ...payload, subject: 'other' })).toContain('subject 非 usage-run');
    expect(validateUsagePayload({ ...payload, agent: '' })).toContain('agent 缺席');
    expect(validateUsagePayload({ ...payload, usage: undefined })).toContain('usage 聚合字段缺失');
    expect(validateUsagePayload({ ...payload, conversationId: '' })).toContain('conversationId 缺席');
  });

  it('非 usage 信不误判（升级回执 receipt）', () => {
    const env = { ...makeUsageEnvelope({ requestId: 'x', payload }), payload: { subject: 'upgrade-success' } };
    expect(isUsageReport(env)).toBe(false);
  });
});