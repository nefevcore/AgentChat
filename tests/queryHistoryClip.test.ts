// ============================================================
// clipByTokens 单元测试 —— query_history 工具结果预览截取
//
// 背景（2026-08-03）：query_history 会把工具调用结果放进历史摘要，
// 超长 dump（曾出现 441K 单行消息）既浪费 token 又易触发 DeepSeek 网关
// \\x 贪婪解析 bug。引入 TOOL_PREVIEW_TOKENS=100 的 token 预算。
// 策略：工具结果保留尾部（错误/关键输出在末尾，开头多为 JSON 结构样板）。
// ============================================================

import { describe, it, expect } from 'vitest';
import { safeClipByTokens } from '@plugins/builtin/tools/shared';
import { estimateTokens } from '@plugins/builtin/tools/shared';

describe('clipByTokens（safeClipByTokens，UTF-16 安全）', () => {
  it('空字符串 → 空', () => {
    expect(safeClipByTokens('', 100, true)).toBe('');
    expect(safeClipByTokens('', 100, false)).toBe('');
  });

  it('未超预算时原样返回', () => {
    const content = '短内容：成功。';
    expect(safeClipByTokens(content, 100, true)).toBe(content);
    expect(safeClipByTokens(content, 100, false)).toBe(content);
  });

  it('keepTail=true 保留尾部并加 … 前缀', () => {
    const content = 'A'.repeat(500) + 'TAILMARKER'; // 头尾可区分
    const out = safeClipByTokens(content, 100, true);
    expect(out.startsWith('…')).toBe(true);
    // 尾部标记被保留
    expect(out.endsWith('TAILMARKER')).toBe(true);
    // 头部被截掉（纯 A 的开头部分丢失）
    expect(out.length).toBeLessThan(content.length);
    expect(estimateTokens(out)).toBeLessThanOrEqual(100);
  });

  it('keepTail=false 保留头部并加 … 后缀', () => {
    const content = 'A'.repeat(500) + 'TAILMARKER';
    const out = safeClipByTokens(content, 100, false);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('A')).toBe(true);
    // 尾部标记被截掉
    expect(out.includes('TAILMARKER')).toBe(false);
    expect(estimateTokens(out)).toBeLessThanOrEqual(100);
  });

  it('预算极小也至少返回省略标记 + 若干字符', () => {
    const out = safeClipByTokens('一段足够长的中文文本用于截断测试', 5, true);
    expect(out.length).toBeGreaterThan(0);
    expect(estimateTokens(out)).toBeLessThanOrEqual(5);
  });
});
