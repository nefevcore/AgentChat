// ============================================================
// ac-run-code-core：precheckInvokeArgs 参数侧可克隆预检（cr-1216）
// 口径：与 postMessage（structured clone）序列化同向——BigInt / 循环引用 /
// 函数 / Symbol 值 → 拒（含嵌套与 Map/Set 内部）；干净参数（含 undefined、
// Map/Set/Date 等可克隆形态）→ undefined 放行。
// ============================================================
import { describe, it, expect } from 'vitest';
import { precheckInvokeArgs } from '../src/index.ts';

describe('precheckInvokeArgs（cr-1216 参数侧可克隆预检）', () => {
  it('干净参数放行：基元 / undefined / Date / Map / Set / 深嵌套对象', () => {
    expect(precheckInvokeArgs('read', { path: 'a.ts', offset: 1, limit: 2000 })).toBeUndefined();
    expect(precheckInvokeArgs('read', { x: undefined, y: null, z: [1, 'two', false] })).toBeUndefined();
    expect(precheckInvokeArgs('read', { d: new Date(0), m: new Map([['k', 'v']]), s: new Set([1, 2]) })).toBeUndefined();
    expect(precheckInvokeArgs('read', { deep: { a: { b: { c: { d: { e: ['ok'] } } } } } })).toBeUndefined();
    expect(precheckInvokeArgs('read', {})).toBeUndefined();
  });

  it('顶层 BigInt / 函数 / Symbol → 拒（错误含工具名 + 字段名 + 类型 + 指引）', () => {
    const bi = precheckInvokeArgs('read', { offset: 10n });
    expect(bi).toContain('tools.read 参数 offset');
    expect(bi).toContain('BigInt');
    expect(bi).toContain('String(v)');
    const fn = precheckInvokeArgs('read', { path: () => 1 });
    expect(fn).toContain('tools.read 参数 path');
    expect(fn).toContain('源码串');
    const sym = precheckInvokeArgs('read', { path: Symbol.for('probe-sym') });
    expect(sym).toContain('tools.read 参数 path');
    expect(sym).toContain('Symbol');
  });

  it('嵌套定位：对象内 / 数组内 / Map 值 / Set 内 → 错误带路径尾巴', () => {
    expect(precheckInvokeArgs('write', { content: { inner: 5n } })).toContain('content.inner');
    expect(precheckInvokeArgs('write', { list: ['a', () => 2] })).toContain('list[1]');
    expect(precheckInvokeArgs('write', { m: new Map<string, unknown>([['k', 'v'], ['bad', 3n]]) })).toContain('m.get(');
    expect(precheckInvokeArgs('write', { s: new Set([1, Symbol.for('probe-sym-2')]) })).toMatch(/s\[\d\]/);
  });

  it('循环引用 → 拒（含「循环引用」指引）；菱形共享不误报', () => {
    const a: Record<string, unknown> = { name: 'x' };
    const shared = { id: 1 };
    a.self = a;
    expect(precheckInvokeArgs('edit', { old_string: a })).toContain('循环引用');
    const diamond = { l: shared, r: shared };
    expect(precheckInvokeArgs('edit', { old_string: diamond })).toBeUndefined();
  });

  it('自循环 Map 同样拦截', () => {
    const m = new Map();
    m.set('self', m);
    expect(precheckInvokeArgs('write', { m })).toContain('循环引用');
  });
});