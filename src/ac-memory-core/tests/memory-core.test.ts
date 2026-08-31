// ============================================================
// ac-memory-core/tests/memory-core.test.ts —— 预算截断
// ============================================================
import { describe, it, expect } from 'vitest';
import { clipMemoryForInjection, MEMORY_TRUNCATION_MARKER } from '../src/index';
import { estimateTokens } from 'ac-text-budget';

describe('clipMemoryForInjection', () => {
  it('预算内 / 非法预算 → 原文', () => {
    expect(clipMemoryForInjection('短记忆', 100)).toBe('短记忆');
    expect(clipMemoryForInjection('任意长度', 0)).toBe('任意长度');
    expect(clipMemoryForInjection('', 10)).toBe('');
  });

  it('超预算 → 保留尾部 + 截断标记；结果不超预算（含标记）', () => {
    const memory = Array.from({ length: 500 }, (_, i) => `记忆条目${i}。`).join('\n');
    const clipped = clipMemoryForInjection(memory, 60);
    expect(clipped.startsWith(MEMORY_TRUNCATION_MARKER)).toBe(true);
    // 尾部近期记忆保留（最后一条在场）
    expect(clipped).toContain('记忆条目499。');
    // 头部被剪
    expect(clipped).not.toContain('记忆条目0。');
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(60 + 1);
  });

  it('代理对不被切断', () => {
    const emoji = '🚀'.repeat(2000);
    const clipped = clipMemoryForInjection(emoji, 50);
    // 尾部字符完整（无孤立代理项——lone surrogate 正则不命中）
    expect(clipped.endsWith('🚀')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped)).toBe(false);
  });
});
