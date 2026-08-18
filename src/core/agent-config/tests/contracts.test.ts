// ============================================================
// contracts.test.ts —— 宿主契约兼容判定 + manifest.contracts 校验
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  HOST_CONTRACTS_VERSION,
  compareVersions,
  isContractsCompatible,
  isValidContractsRange,
  parseVersion,
  validatePluginManifest,
} from '../src';

describe('parseVersion / compareVersions', () => {
  it('解析三元组与预发布', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseVersion('2.0.0-beta.1')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: 'beta.1' });
    expect(() => parseVersion('1.2')).toThrow();
    expect(() => parseVersion('abc')).toThrow();
  });

  it('预发布 < 同版本正式版', () => {
    const release = parseVersion('1.0.0');
    const beta = parseVersion('1.0.0-beta.1');
    expect(compareVersions(beta, release)).toBe(-1);
    expect(compareVersions(release, beta)).toBe(1);
  });
});

describe('isContractsCompatible', () => {
  it.each([
    ['*', '2.5.0', true],
    ['^1', '1.9.9', true],
    ['^1', '2.0.0', false],
    ['^1', '0.9.0', false],
    ['^1.2', '1.2.0', true],
    ['^1.2', '1.9.9', true],
    ['^1.2', '2.0.0', false],
    ['~1.2', '1.2.9', true],
    ['~1.2', '1.3.0', false],
    ['1.2', '1.2.5', true],   // 短形态 ≡ ~1.2
    ['1.2', '1.3.0', false],
    ['1', '1.4.0', true],    // 短形态 ≡ ^1
    ['1', '2.0.0', false],
    ['1.x', '1.7.3', true],  // 通配 ≡ ^1
    ['1.x', '2.0.0', false],
    ['>=1 <2', '1.5.0', true],
    ['>=1 <2', '2.0.0', false],
    ['^1 || ^2', '2.3.0', true],
    ['^1 || ^2', '3.0.0', false],
    ['>1.0.0', '1.0.0', false],
    ['>1.0.0', '1.0.1', true],
    ['<=2', '2.0.0', true],
    ['<=2', '2.0.1', false],
    ['=1.0.0', '1.0.0', true],
    ['=1.0.0', '1.0.1', false],
    ['1.0.0', '1.0.0', true],
  ])('range %s × host %s → %s', (range, host, expected) => {
    expect(isContractsCompatible(range, host)).toBe(expected);
  });

  it('缺省 = 存量插件默认兼容（弃用窗口内不惩罚）', () => {
    expect(isContractsCompatible(undefined, '99.0.0')).toBe(true);
    expect(isContractsCompatible('', '1.0.0')).toBe(true);
  });

  it('非法 range fail closed', () => {
    expect(isContractsCompatible('abc', '1.0.0')).toBe(false);
    expect(isContractsCompatible('^1.x.3', '1.0.0')).toBe(false);
    expect(isContractsCompatible('>=1 <', '1.0.0')).toBe(false);
  });

  it('缺省 host = HOST_CONTRACTS_VERSION', () => {
    expect(isContractsCompatible(`^${HOST_CONTRACTS_VERSION.split('.')[0]}`)).toBe(true);
  });
});

describe('isValidContractsRange', () => {
  it('合法字符集', () => {
    expect(isValidContractsRange('^1')).toBe(true);
    expect(isValidContractsRange('>=1 <2')).toBe(true);
    expect(isValidContractsRange('*')).toBe(true);
    expect(isValidContractsRange('  ')).toBe(false);
    expect(isValidContractsRange('^1 && 2')).toBe(false); // && 不是合法 token
    expect(isValidContractsRange('abc')).toBe(false);
  });
});

describe('validatePluginManifest contracts 字段', () => {
  const base = { name: 'agentchat-demo', version: '1.0.0' };

  it('合法 range 通过并保留', () => {
    const check = validatePluginManifest({ ...base, contracts: '^1' });
    expect(check.ok).toBe(true);
    expect(check.manifest?.contracts).toBe('^1');
  });

  it('缺省不产生字段', () => {
    const check = validatePluginManifest(base);
    expect(check.ok).toBe(true);
    expect(check.manifest?.contracts).toBeUndefined();
  });

  it('非法 range 报错', () => {
    const check = validatePluginManifest({ ...base, contracts: 'nope' });
    expect(check.ok).toBe(false);
    expect(check.errors.join()).toContain('contracts');
  });

  it('非字符串报错', () => {
    const check = validatePluginManifest({ ...base, contracts: 1 });
    expect(check.ok).toBe(false);
  });
});
