// ============================================================
// plugin-guard.test.ts —— 装载边界硬闸测试（cr-1074 批3 切片一）
// ============================================================
import { describe, it, expect } from 'vitest';
import { guardPluginModule, isOfficialFiberName } from '../src/plugin-guard.ts';
import type { Plugin } from '@agentchat/cordis';

describe('isOfficialFiberName（官方命名空间判定）', () => {
  it('ac- / shell- 前缀与 root 命中（官方命名空间两类前缀）', () => {
    expect(isOfficialFiberName('ac-fs-tools')).toBe(true);
    expect(isOfficialFiberName('ac-anything')).toBe(true);
    expect(isOfficialFiberName('shell-tools-gate')).toBe(true);
    expect(isOfficialFiberName('shell-plugin-dev-row')).toBe(true);
    expect(isOfficialFiberName('root')).toBe(true);
  });

  it('普通插件名不命中', () => {
    expect(isOfficialFiberName('my-agent-hello')).toBe(false);
    expect(isOfficialFiberName('my-hello')).toBe(false);
  });
});

describe('guardPluginModule（装载边界守卫）', () => {
  it('模块名冒充官方 → 拒载（throw，代码不进进程）', () => {
    const evil = { name: 'ac-fs-tools', apply: () => {} } as unknown as Plugin;
    expect(() => guardPluginModule(evil, 'my-plugin')).toThrow(/冒充官方命名空间/);
  });

  it('manifest.name 冒充官方 → 拒载（钉死目标本身即冒充者）', () => {
    const mod = { apply: () => {} } as unknown as Plugin;
    expect(() => guardPluginModule(mod, 'ac-evil')).toThrow(/冒充官方命名空间/);
    expect(() => guardPluginModule(mod, 'shell-fake')).toThrow(/冒充官方命名空间/);
  });

  it('无名对象模块 → 钉死为 manifest.name', () => {
    const applied: unknown[] = [];
    const mod = { apply: (ctx: unknown) => { applied.push(ctx); } } as unknown as Plugin;
    const guarded = guardPluginModule(mod, 'my-plugin');
    expect((guarded as { name?: unknown }).name).toBe('my-plugin');
    expect((guarded as { apply?: unknown }).apply).toBeTypeOf('function');
  });

  it('函数插件 → 包装钉名且 apply 可执行', () => {
    let called = 0;
    const fn = ((ctx: unknown) => { called += 1; return 'ran'; }) as unknown as Plugin;
    const guarded = guardPluginModule(fn, 'fn-plugin');
    const apply = (guarded as { apply: (ctx: unknown, config: unknown) => unknown }).apply;
    expect(apply({}, undefined)).toBe('ran');
    expect(called).toBe(1);
    expect((guarded as { name?: unknown }).name).toBe('fn-plugin');
  });

  it('自有名插件 → 名被 manifest.name 覆盖（归属单源）', () => {
    const mod = { name: 'self-named', apply: () => {} } as unknown as Plugin;
    const guarded = guardPluginModule(mod, 'manifest-name-x');
    expect((guarded as { name?: unknown }).name).toBe('manifest-name-x');
  });
});
