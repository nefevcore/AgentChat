// keys.test.ts —— 键库回归（cr-1238 B2）：1.1 五案 + 表 A 边界案
import { describe, expect, it } from 'vitest';
import {
  parseKey,
  isUuidKey,
  isPairKey,
  isGroupKey,
  isSubKey,
  pairIncludes,
  pairKey,
  runAddress,
  participantsOfKey,
  memberStreamKey,
  isReservedEndpointId,
  isAgentIdentity,
  isMechanismEndpointId,
} from '../src/keys.ts';

describe('parseKey 总函数（表 A 全键形）', () => {
  it('uuid 形（v4/v7 兼容）', () => {
    expect(parseKey('0198b2c1-7a2e-7d1e-9f0a-112233445566')).toEqual({ shape: 'uuid', id: '0198b2c1-7a2e-7d1e-9f0a-112233445566' });
    expect(parseKey('0198b2c1-7a2e-4d1e-9f0a-112233445566').shape).toBe('uuid');
  });
  it('pair 形（对角线与 gid~member 同形——键面不可辨公理）', () => {
    expect(parseKey('alpha~beta')).toEqual({ shape: 'pair', left: 'alpha', right: 'beta' });
    expect(parseKey('alpha~alpha').shape).toBe('pair');
    expect(parseKey('g-mkt~alpha').shape).toBe('pair');
  });
  it('group / sub / plain 兜底', () => {
    expect(parseKey('g-mkt')).toEqual({ shape: 'group', gid: 'mkt' });
    expect(parseKey('sub_abc')).toEqual({ shape: 'sub', id: 'sub_abc' });
    expect(parseKey('alpha')).toEqual({ shape: 'plain', id: 'alpha' });
    expect(parseKey('')).toEqual({ shape: 'plain', id: '' });
  });
});

describe('1.1 五案回归锁', () => {
  it('cr-1120/1137：isUuidKey/isSubKey/isGroupKey 分型——uuid/sub/g 键不误落对桶', () => {
    expect(isUuidKey('0198b2c1-7a2e-7d1e-9f0a-112233445566')).toBe(true);
    expect(isPairKey('0198b2c1-7a2e-7d1e-9f0a-112233445566')).toBe(false);
    expect(isSubKey('sub_abc')).toBe(true);
    expect(isGroupKey('g-mkt')).toBe(true);
    expect(isPairKey('alpha~beta')).toBe(true);
    expect(isPairKey('alpha')).toBe(false);
  });
  it('cr-1192：无 ~ 键 split 单元素命中自身的坑——parseKey 总函数消灭', () => {
    const s = parseKey('0198b2c1-7a2e-7d1e-9f0a-112233445566');
    expect(s.shape).toBe('uuid');
  });
  it('cr-1186：isAgentIdentity 词法单义——user/host 放行、~ 拒斥', () => {
    expect(isAgentIdentity('user')).toBe(true);
    expect(isAgentIdentity('host')).toBe(true);
    expect(isAgentIdentity('plain')).toBe(true);
    expect(isAgentIdentity('a~b')).toBe(false);
    expect(isAgentIdentity('')).toBe(false);
  });
  it('cr-1175 D6：isReservedEndpointId——host/user/@ 前缀拒斥', () => {
    expect(isReservedEndpointId('host')).toBe(true);
    expect(isReservedEndpointId('user')).toBe(true);
    expect(isReservedEndpointId('@g-mkt')).toBe(true);
    expect(isReservedEndpointId('alpha')).toBe(false);
  });
});

describe('构造词与反演', () => {
  it('pairKey 排序连接；participantsOfKey 对称反演；pairIncludes 段成员资格', () => {
    expect(pairKey('beta', 'alpha')).toBe('alpha~beta');
    expect(participantsOfKey('alpha~beta')).toEqual(['alpha', 'beta']);
    expect(participantsOfKey('g-mkt')).toBeUndefined();
    expect(pairIncludes('alpha~beta', 'beta')).toBe(true);
    expect(pairIncludes('alpha~beta', 'gamma')).toBe(false);
  });
  it('runAddress 与 memberStreamKey', () => {
    expect(runAddress('alpha', undefined)).toBe('alpha');
    expect(runAddress('alpha', 'alpha')).toBe('alpha');
    expect(runAddress('alpha', 'g-mkt')).toBe('g-mkt~alpha');
    expect(runAddress(undefined, 'g-mkt')).toBeUndefined();
    expect(memberStreamKey('g-mkt', 'alpha')).toBe('g-mkt~alpha');
  });
  it('isMechanismEndpointId：host/@ 豁免面，user 不豁免', () => {
    expect(isMechanismEndpointId('host')).toBe(true);
    expect(isMechanismEndpointId('@g')).toBe(true);
    expect(isMechanismEndpointId('user')).toBe(false);
  });
});