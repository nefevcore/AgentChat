// ============================================================
// usage 计量单测（cr-538；cr-1175 批 3b 起去信封面）：writer settle
// 计量随 run-end 落事件日志 / usage.report 帧 payload schema 校验。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readLedger } from '../src/reader.ts';
import { validateUsagePayload } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-ledger-usage-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0010';
const meter = { usage: { prompt: 120, completion: 30, promptAccumulated: 200, steps: 2, cacheHit: 50 }, model: 'mock' };

describe('writer settle 计量（run-end 事件行——R2）', () => {
  it('meter 随 run-end 落盘（usage + model 字段）', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', uuid), { participants: ['alpha', 'user'], kind: 'user' });
    await w.settle({
      role: 'agent', content: '终稿', agent_id: 'alpha', requestId: 'reply-r1', uuid,
    }, 'run-r1', 'ok', meter);
    const rows = readLedger(sessionDir(ROOT, 'alpha', uuid)).rows as unknown as Array<Record<string, unknown>>;
    const end = rows.find((r) => r.type === 'run-end');
    expect(end).toMatchObject({ run: 'run-r1', finish: 'completed', model: 'mock' });
    expect(end!.usage).toMatchObject({ prompt: 120, steps: 2 });
  });

  it('meter 缺席 = 旧行为（无 usage/model 键——additive 兼容）', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'beta', uuid), { participants: ['beta', 'user'], kind: 'user' });
    await w.settle({
      role: 'agent', content: '终稿', agent_id: 'beta', requestId: 'reply-r2', uuid,
    }, 'run-r2', 'ok');
    const rows = readLedger(sessionDir(ROOT, 'beta', uuid)).rows as unknown as Array<Record<string, unknown>>;
    const end = rows.find((r) => r.type === 'run-end');
    expect('usage' in end!).toBe(false);
    expect('model' in end!).toBe(false);
  });
});

describe('usage.report 帧 payload schema（envelope-core）', () => {
  const payload = {
    subject: 'usage-run' as const, agent: 'alpha', model: 'mock', finish: 'ok',
    usage: { prompt: 1, completion: 1, promptAccumulated: 2, steps: 1 },
    conversationId: 'user~alpha', runId: 'run-r1',
  };

  it('合法 payload 零 issues', () => {
    expect(validateUsagePayload(payload)).toEqual([]);
  });

  it('缺失面 fail-closed（subject/agent/usage/conversationId）', () => {
    expect(validateUsagePayload({ ...payload, subject: 'other' })).toContain('subject 非 usage-run/usage-step');
    expect(validateUsagePayload({ ...payload, agent: '' })).toContain('agent 缺席');
    expect(validateUsagePayload({ ...payload, usage: undefined })).toContain('usage 聚合字段缺失');
    expect(validateUsagePayload({ ...payload, conversationId: '' })).toContain('conversationId 缺席');
  });

  it('usage-step 步级缓存帧（cr-760）：合法零 issues + fail-closed', () => {
    const step = { subject: 'usage-step' as const, agent: 'alpha', conversationId: 'user~alpha', runId: 'run-r1', step: 2, ts: 1234, hit: 100, miss: 5 };
    expect(validateUsagePayload(step)).toEqual([]);
    expect(validateUsagePayload({ ...step, hit: undefined })).toContain('hit 缺席');
    expect(validateUsagePayload({ ...step, step: undefined })).toContain('step 缺席');
  });
});
