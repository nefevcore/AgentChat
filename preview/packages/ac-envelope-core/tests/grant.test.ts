// ============================================================
// grant.ts 单测（cr-545）：schema 校验（资产面/指纹必填/scope 门）
// + 信封构造（kind=action、budget=0、to=host）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  validateGrantPayload,
  validateGrantReceiptPayload,
  makeGrantEnvelope,
  makeGrantReceiptEnvelope,
} from '../src/grant.ts';

describe('validateGrantPayload', () => {
  it('合法两资产面过', () => {
    expect(validateGrantPayload({ action: 'grant', asset: { kind: 'credential', ref: 'openai' }, scope: 'per-agent', priorFingerprint: 'fp' })).toEqual([]);
    expect(validateGrantPayload({ action: 'revoke', asset: { kind: 'mcp-server', name: 'wiki' }, scope: 'global', priorFingerprint: 'fp' })).toEqual([]);
  });

  it('row/inline 资产面恒拒（A10 用户域）', () => {
    const issues = validateGrantPayload({ action: 'grant', asset: { kind: 'row-load', rowId: 'browser' }, scope: 'per-agent', priorFingerprint: 'fp' });
    expect(issues.join()).toContain('asset.kind 非法');
  });

  it('action/scope/priorFingerprint 缺席各报一条', () => {
    expect(validateGrantPayload({ asset: { kind: 'mcp-server', name: 'x' }, scope: 'per-agent', priorFingerprint: 'f' })).toEqual(['action 非法']);
    expect(validateGrantPayload({ action: 'grant', asset: { kind: 'mcp-server', name: 'x' }, priorFingerprint: 'f' })).toEqual(['scope 非法']);
    expect(validateGrantPayload({ action: 'grant', asset: { kind: 'mcp-server', name: 'x' }, scope: 'per-agent' })).toEqual(['priorFingerprint 缺席']);
    expect(validateGrantPayload(null)).toEqual(['payload 非对象']);
  });
});

describe('validateGrantReceiptPayload', () => {
  it('成功/拒收两态形状', () => {
    expect(validateGrantReceiptPayload({ subject: 'grant-applied', agent: 'a', ok: true, newFingerprint: 'nf' })).toEqual([]);
    expect(validateGrantReceiptPayload({ subject: 'grant-rejected', agent: 'a', ok: false, reason: 'r' })).toEqual([]);
    expect(validateGrantReceiptPayload({ subject: 'grant-applied', agent: 'a', ok: true })).toContain('成功回执缺 newFingerprint');
    expect(validateGrantReceiptPayload({ subject: 'grant-rejected', agent: 'a', ok: false })).toContain('拒收回执缺 reason');
  });
});

describe('信封构造', () => {
  it('grant 信：kind=action、to=host、budget=0；回执 uuid/requestId 原值', () => {
    const env = makeGrantEnvelope({
      uuid: 'u1', requestId: 'r1', sender: 'alpha',
      payload: { action: 'grant', asset: { kind: 'mcp-server', name: 'wiki' }, scope: 'per-agent', priorFingerprint: 'f' },
    });
    expect(env.kind).toBe('grant');
    expect(env.to).toBe('host');
    expect(env.budget).toBe(0);
    const rc = makeGrantReceiptEnvelope({
      uuid: 'u1', requestId: 'r1', to: 'alpha',
      payload: { subject: 'grant-applied', agent: 'alpha', ok: true, newFingerprint: 'nf' },
    });
    expect(rc.kind).toBe('receipt');
    expect(rc.requestId).toBe('r1');
    expect(rc.sender).toBe('host');
  });
});
