// ============================================================
// ac-tools/tests/risk-contract.test.ts —— risk 契约字段类型锚（cr-1066 批1a）
// 纯类型面测试：risk 三值建议的签名在契约上可声明（运行时语义——建议非
// 决定/throw 按 ask/等价映射——由 ac-permission-gate 门行测试锁定，本档
// 只锚 ToolDefinition 形状不漂移）。
// ============================================================
import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../src/contract.ts';

describe('ToolDefinition.risk 契约字段（cr-1066）', () => {
  it('risk 声明面：三值纯函数可挂；缺省 undefined = 门视野外/等价映射的判据位', () => {
    const def: ToolDefinition = {
      name: 'sample',
      risk: (args) => (
        args.mode === 'read' ? 'allow' : args.mode === 'write' ? 'ask' : 'deny'
      ),
      execute: () => ({ ok: true }),
    };
    expect(def.risk!({ mode: 'read' })).toBe('allow');
    expect(def.risk!({ mode: 'write' })).toBe('ask');
    expect(def.risk!({ mode: 'nuke' })).toBe('deny');
    expect(def.risk).toBeTypeOf('function');
  });

  it('risk 缺省时 needPermission 布尔仍在位（存量等价映射的声明面判据）', () => {
    const def: ToolDefinition = {
      name: 'legacy',
      needPermission: true,
      execute: () => ({ ok: true }),
    };
    expect(def.risk).toBeUndefined();
    expect(def.needPermission).toBe(true);
  });
});
