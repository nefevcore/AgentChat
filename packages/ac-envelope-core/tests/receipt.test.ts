// ============================================================
// 6.3 观察回执单测：payload schema 校验 / 信封构造 / 失败线强制
// rolledBackTo（R-7 三元组列非裸根）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { makeReceiptEnvelope, validateReceiptPayload, type ReceiptPayload } from '../src/receipt.ts';

const good: ReceiptPayload = {
  subject: 'upgrade-success',
  root: 'abc123',
  agent: 'alpha',
  ok: true,
  snapshotId: 'snap-000001',
  rollbackTargets: [{ root: 'abc123', snapshotId: 'snap-000001', takenAt: '2026-10-18T08:00:00Z', evidence: 'boot-smoke' }],
};

describe('M6.3 观察回执', () => {
  it('合法成功回执零 issues + 信封形态（kind=receipt / budget=0 / sender=host）', () => {
    expect(validateReceiptPayload(good)).toEqual([]);
    const env = makeReceiptEnvelope({ uuid: 'u1', requestId: 'r1', to: 'alpha', payload: good });
    expect(env).toMatchObject({ kind: 'receipt', budget: 0, sender: 'host', to: 'alpha' });
  });

  it('失败回执须 ok=false + rolledBackTo（缺席 = issue）', () => {
    const bad: ReceiptPayload = { ...good, subject: 'upgrade-failed', ok: false };
    delete (bad as Partial<ReceiptPayload>).rolledBackTo;
    expect(validateReceiptPayload(bad)).toContain('失败回执缺 rolledBackTo');
    const fixed: ReceiptPayload = { ...bad, rolledBackTo: { snapshotId: 'snap-000001', root: 'old' } };
    expect(validateReceiptPayload(fixed)).toEqual([]);
  });

  it('subject/root/rollbackTargets 各失败面', () => {
    expect(validateReceiptPayload({ ...good, subject: 'bogus' as ReceiptPayload['subject'] })).toContain('subject 非法');
    expect(validateReceiptPayload({ ...good, root: '' })).toContain('root 缺席');
    expect(validateReceiptPayload({ ...good, rollbackTargets: 'nope' as unknown })).toContain('rollbackTargets 缺席');
    expect(validateReceiptPayload({ ...good, rollbackTargets: [{ root: 'r' } as ReceiptPayload['rollbackTargets'][number]] })).toContain('rollbackTargets 含非三元组条目');
    expect(validateReceiptPayload(null)).toEqual(['payload 非对象']);
  });
});
