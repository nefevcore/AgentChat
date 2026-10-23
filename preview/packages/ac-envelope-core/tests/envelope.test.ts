// ============================================================
// ac-envelope-core 全字段单测（M1.1 验收）：schema 校验 / 工厂 /
// 幂等准入（cr-250 语义）/ budget 状态机 / 确认状态机（A2）/ inbox 边界（A4）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  validateEnvelope, makeEnvelope, DEFAULT_BUDGET,
  type Envelope,
} from '../src/envelope.ts';
import { AdmissionGate, ADMISSION_MAX } from '../src/admission.ts';
import {
  entersInbox, isBudgetSource, budgetAfterReceive, consumedByAutoWake,
} from '../src/budget.ts';
import { EnvelopeTracker, shouldResend, RESEND_TIMEOUT_MS } from '../src/confirm.ts';

const base = { uuid: 'u1', requestId: 'r1', sender: 'user', to: 'agent-a' };

describe('schema：makeEnvelope 与 validateEnvelope', () => {
  it('工厂缺省化：kind=message / budget=3（MAX_AUTO_WAKES 同源）/ payload=null', () => {
    const env = makeEnvelope(base);
    expect(env.kind).toBe('message');
    expect(env.budget).toBe(DEFAULT_BUDGET);
    expect(env.hop).toBeUndefined();
    expect(env.payload).toBeNull();
    expect(validateEnvelope(env)).toEqual([]);
  });

  it('全字段合法信封零问题', () => {
    const env = makeEnvelope({ ...base, kind: 'receipt', budget: 0, hop: 2, payload: { f: 'x' } });
    expect(validateEnvelope(env)).toEqual([]);
  });

  it('四端点字段缺失逐一报问题（fail-closed 收集不修复）', () => {
    const bad = { ...makeEnvelope(base), uuid: '', requestId: '', sender: '', to: '' } as Envelope;
    const fields = validateEnvelope(bad).map((i) => i.field);
    expect(fields).toEqual(['uuid', 'requestId', 'sender', 'to']);
  });

  it('未知 kind / 非整数 budget / 负 budget / 非法 hop 各报其位', () => {
    const bad1 = { ...makeEnvelope(base), kind: 'shout' as Envelope['kind'] };
    expect(validateEnvelope(bad1).map((i) => i.field)).toEqual(['kind']);
    const bad2 = { ...makeEnvelope(base), budget: 1.5 };
    expect(validateEnvelope(bad2).map((i) => i.field)).toEqual(['budget']);
    const bad3 = { ...makeEnvelope(base), budget: -1 };
    expect(validateEnvelope(bad3).map((i) => i.field)).toEqual(['budget']);
    const bad4 = { ...makeEnvelope(base), hop: -2 };
    expect(validateEnvelope(bad4).map((i) => i.field)).toEqual(['hop']);
  });
});

describe('admission：requestId 幂等准入（cr-250 语义）', () => {
  it('先查后登记：首键受理、同键重发短路、异键正常受理', () => {
    const gate = new AdmissionGate();
    expect(gate.admit('r1')).toBe(true);
    expect(gate.admit('r1')).toBe(false);
    expect(gate.admit('r2')).toBe(true);
    expect(gate.admit('r2')).toBe(false);
  });

  it('FIFO 淘汰：超容量后最旧键被挤出，重发被挤出键不再去重', () => {
    const gate = new AdmissionGate(3);
    gate.admit('a'); gate.admit('b'); gate.admit('c');
    expect(gate.snapshot()).toEqual(['a', 'b', 'c']);
    gate.admit('d');
    expect(gate.snapshot()).toEqual(['b', 'c', 'd']);
    expect(gate.admit('a')).toBe(true); // a 已被挤出——重新受理
  });

  it('持久化钩子：每次新受理回调全量集，restore 恢复后去重跨实例生效', () => {
    const persisted: string[][] = [];
    const gate = new AdmissionGate(10, { persist: (ids) => persisted.push(ids) });
    gate.admit('r1'); gate.admit('r2');
    const gate2 = new AdmissionGate(10);
    gate2.restore(persisted.at(-1)!);
    expect(gate2.admit('r1')).toBe(false);
    expect(gate2.admit('r3')).toBe(true);
  });

  it('容量常量与现状先例同源（SEEN_REQUESTS_MAX = 200）', () => {
    expect(ADMISSION_MAX).toBe(200);
  });
});

describe('budget：防自激预算（A1 + A4）', () => {
  it('user 是预算之源：直发重置满额 3', () => {
    expect(isBudgetSource('user')).toBe(true);
    expect(isBudgetSource('agent-a')).toBe(false);
    expect(budgetAfterReceive(0, 'user')).toBe(3);
    expect(budgetAfterReceive(1, 'user')).toBe(3);
  });
  it('非 user 直发预算不变；自动唤醒 -1 至下限 0', () => {
    expect(budgetAfterReceive(2, 'agent-b')).toBe(2);
    expect(consumedByAutoWake(3)).toBe(2);
    expect(consumedByAutoWake(1)).toBe(0);
    expect(consumedByAutoWake(0)).toBe(0);
  });
  it('inbox 边界（A4）：receipt / grant / revoke / budget=0 不入队', () => kindBudgetCases());
});

function kindBudgetCases() {
  expect(entersInbox('message', 1)).toBe(true);
  expect(entersInbox('message', 0)).toBe(false);
  expect(entersInbox('receipt', 3)).toBe(false);
  expect(entersInbox('grant', 3)).toBe(false);
  expect(entersInbox('revoke', 3)).toBe(false);
}

describe('confirm：确认状态机（A2 落账即确认）', () => {
  it('正常推进：acquire → delivered → acked → settled', () => {
    const t = new EnvelopeTracker();
    expect(t.current()).toBe('acquire');
    expect(t.advance('delivered')).toEqual({ ok: true, phase: 'delivered' });
    expect(t.advance('acked')).toEqual({ ok: true, phase: 'acked' });
    expect(t.advance('settled')).toEqual({ ok: true, phase: 'settled' });
  });

  it('跳阶段合法（传输层直收：acquire+delivered 同步）', () => {
    const t = new EnvelopeTracker();
    expect(t.advance('acked').ok).toBe(true);
  });

  it('回退非法（delivered 后不能再 acquire）', () => {
    const t = new EnvelopeTracker();
    t.advance('delivered');
    expect(t.advance('acquire')).toEqual({ ok: false, reason: 'illegal-transition' });
  });

  it('delivered 重入合法（重投补 ack，不降阶段）', () => {
    const t = new EnvelopeTracker();
    t.advance('delivered');
    expect(t.advance('delivered')).toEqual({ ok: true, phase: 'delivered' });
  });

  it('重投判定：30s 超时未 ack 才可重发', () => {
    expect(RESEND_TIMEOUT_MS).toBe(30_000);
    expect(shouldResend(0, 29_999, false)).toBe(false);
    expect(shouldResend(0, 30_000, false)).toBe(true);
    expect(shouldResend(0, 60_000, true)).toBe(false);
  });
});
