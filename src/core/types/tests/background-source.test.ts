import { describe, it, expect } from 'vitest';
import { isBackgroundRunSource } from '../src/index';

describe('isBackgroundRunSource —— 基于 MessageSource 的后台会话分类', () => {
  it('form=hint/resume/notice 为后台', () => {
    expect(isBackgroundRunSource({ kind: 'timer', form: 'hint' })).toBe(true);
    expect(isBackgroundRunSource({ kind: 'restart', form: 'resume' })).toBe(true);
    expect(isBackgroundRunSource({ kind: 'system', form: 'notice' })).toBe(true);
  });

  it('form=prompt/relay 为前台', () => {
    expect(isBackgroundRunSource({ kind: 'user', form: 'prompt' })).toBe(false);
    expect(isBackgroundRunSource({ kind: 'agent', form: 'relay' })).toBe(false);
  });

  it('旧数据只有 kind 时按后台 kind 兜底', () => {
    for (const kind of ['timer', 'group', 'subagent', 'continue', 'restart', 'archive'] as const) {
      expect(isBackgroundRunSource({ kind })).toBe(true);
    }
    expect(isBackgroundRunSource({ kind: 'system' })).toBe(false);
    expect(isBackgroundRunSource({ kind: 'user' })).toBe(false);
    expect(isBackgroundRunSource({ kind: 'agent' })).toBe(false);
  });

  it('无 source 按前台处理（宁可多广播）', () => {
    expect(isBackgroundRunSource(undefined)).toBe(false);
  });
});
