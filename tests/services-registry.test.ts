// ============================================================
// src/services/registry 单元测试 —— 服务注册表（L4）
// ============================================================
import { describe, it, expect } from 'vitest';
import { ServiceRegistry } from '../src/services/registry';

describe('ServiceRegistry', () => {
  it('register / get / list', () => {
    const r = new ServiceRegistry();
    const svc = { ping: () => 'pong' };
    r.register('ping', svc);
    expect(r.get('ping')).toBe(svc);
    expect(r.get<{ ping: () => string }>('ping')!.ping()).toBe('pong');
    expect(r.list()).toEqual(['ping']);
  });

  it('同名重复注册告警并覆盖', () => {
    const r = new ServiceRegistry();
    r.register('a', { v: 1 });
    r.register('a', { v: 2 });
    expect(r.get('a')).toEqual({ v: 2 });
    expect(r.list().length).toBe(1);
  });

  it('get 未注册返回 undefined；require 抛错', () => {
    const r = new ServiceRegistry();
    expect(r.get('nope')).toBeUndefined();
    expect(() => r.require('nope')).toThrow(/未注册/);
  });
});
