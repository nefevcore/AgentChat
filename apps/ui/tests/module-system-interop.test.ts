// ============================================================
// module-system-interop.test.ts —— markEsmNamespace 协议锁
//（crash-hardening 批：冻结命名空间替身——rollup 生产构建产物
//  Object.freeze 命名空间在 vitest 态不复现，真机才踩）
// ============================================================
import { describe, it, expect } from 'vitest';
import { markEsmNamespace } from '../client/module-system.ts';

const interopDefault = (e: unknown) => {
  const o = e as { __esModule?: boolean; default?: unknown };
  return o && o.__esModule ? o : { default: e };
};

describe('markEsmNamespace（CJS interop 旗标协议）', () => {
  it('普通命名空间：原位标注（身份不变、幂等）', () => {
    const ns = { default: 1 };
    const out = markEsmNamespace(ns);
    expect(out).toBe(ns);
    expect((ns as { __esModule?: boolean }).__esModule).toBe(true);
    expect(markEsmNamespace(ns)).toBe(ns);
  });

  it('冻结命名空间（rollup 生产产物形态）：可写替身 + 旗标 + 导出面复制 + 恒等', () => {
    const component = { name: 'X' };
    const ns = Object.freeze(Object.defineProperty(
      { __proto__: null, default: component }, Symbol.toStringTag, { value: 'Module' },
    ));
    const out = markEsmNamespace(ns) as Record<string, unknown>;
    expect(out).not.toBe(ns);
    expect(out.__esModule).toBe(true);
    expect(out.default).toBe(component);
    expect(markEsmNamespace(ns)).toBe(out);
  });

  it('已带旗标 / 非对象：原样返回', () => {
    const flagged = { __esModule: true, default: 2 };
    expect(markEsmNamespace(flagged)).toBe(flagged);
    expect(markEsmNamespace(null)).toBeNull();
    expect(markEsmNamespace(42)).toBe(42);
  });

  it('interop 语义闭环：_interopDefault(标注结果).default === 组件（rollup 同款辅助）', () => {
    const component = { name: 'ConversationView' };
    const ns = Object.freeze({ __proto__: null, default: component });
    expect((interopDefault(markEsmNamespace(ns)) as { default: unknown }).default).toBe(component);
  });
});
