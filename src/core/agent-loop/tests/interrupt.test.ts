// ============================================================
// src/core/interrupt 单元测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { ToolInterrupt, isToolInterrupt, describeInterrupt } from '../src/interrupt';

describe('ToolInterrupt', () => {
  it('构造 reason 并序列化 name/message', () => {
    const t = new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
    expect(t).toBeInstanceOf(Error);
    expect(t.name).toBe('ToolInterrupt');
    expect(t.message).toBe('tool-interrupt:reload-requested');
    expect(t.reason).toEqual({ type: 'reload-requested', scope: 'self' });
  });

  it('isToolInterrupt 识别实例与跨 bundle 对象', () => {
    expect(isToolInterrupt(new ToolInterrupt({ type: 'user-abort' }))).toBe(true);
    expect(isToolInterrupt(new Error('普通错误'))).toBe(false);
    // 跨 bundle：仅凭 name 判断（如多份打包副本）
    expect(isToolInterrupt({ name: 'ToolInterrupt' })).toBe(true);
    expect(isToolInterrupt(undefined)).toBe(false);
    expect(isToolInterrupt(null)).toBe(false);
  });
});

describe('describeInterrupt', () => {
  it('未定义返回空串', () => {
    expect(describeInterrupt(undefined)).toBe('');
  });

  it('各类型生成人类可读摘要', () => {
    expect(describeInterrupt({ type: 'user-abort' })).toBe('已由用户打断');
    expect(describeInterrupt({ type: 'tool-interrupt', tool: 'bash' })).toContain('bash');
    expect(describeInterrupt({ type: 'reload-requested', scope: 'global' })).toContain('global');
    expect(describeInterrupt({ type: 'restart-requested' })).toContain('重启');
    expect(describeInterrupt({ type: 'max-steps' })).toContain('最大推理步数');
  });

  it("scope='modules' 摘要含文件数与清单（截断显示）", () => {
    const text = describeInterrupt({
      type: 'reload-requested', scope: 'modules',
      files: ['file:///repo/src/a.ts', 'file:///repo/src/b.ts'],
    });
    expect(text).toContain('2 个文件');
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('下一 step 生效');
    // 超长清单：只显示前 6 个 basename
    const many = describeInterrupt({
      type: 'reload-requested', scope: 'modules',
      files: Array.from({ length: 10 }, (_, i) => `file:///repo/src/f${i}.ts`),
    });
    expect(many).toContain('10 个文件');
    expect(many).toContain('f5.ts');
    expect(many).not.toContain('f6.ts');
    expect(many).toContain('…');
  });
});
