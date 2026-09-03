import { describe, it, expect } from 'vitest';
import { splitModelRef, joinModelRef } from '../src/refs.ts';

describe('splitModelRef', () => {
  it('标准形态：首个 @ 拆分 provider 与 model', () => {
    expect(splitModelRef('deepseek@deepseek-v4-pro')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
  });

  it('model 侧再含 @：只按首个 @ 拆（右段原样）', () => {
    expect(splitModelRef('gw@gpt-4o@latest')).toEqual({ provider: 'gw', model: 'gpt-4o@latest' });
  });

  it('裸模型名：不拆，provider 缺省（旧路由语义）', () => {
    expect(splitModelRef('glm-5.3')).toEqual({ model: 'glm-5.3' });
    expect(splitModelRef('deepseek-v4-flash')).toEqual({ model: 'deepseek-v4-flash' });
  });

  it('不完整形态视作裸模型：@ 在头部 / @ 在尾部 / 空串', () => {
    expect(splitModelRef('@model')).toEqual({ model: '@model' });
    expect(splitModelRef('deepseek@')).toEqual({ model: 'deepseek@' });
    expect(splitModelRef('')).toEqual({ model: '' });
  });
});

describe('joinModelRef', () => {
  it('provider 存在 → name@model；缺省 → 裸名', () => {
    expect(joinModelRef('deepseek', 'deepseek-v4-pro')).toBe('deepseek@deepseek-v4-pro');
    expect(joinModelRef(undefined, 'glm-5.3')).toBe('glm-5.3');
  });

  it('与 splitModelRef 互逆（标准形态）', () => {
    const ref = 'deepseek@deepseek-v4-flash';
    const split = splitModelRef(ref);
    expect(joinModelRef(split.provider, split.model)).toBe(ref);
  });
});
