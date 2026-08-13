// ============================================================
// truncateMemory 单元测试 —— 记忆注入预算截断
//
// 背景（2026-08-02 系统提示词瘦身）：memory.md 全量注入是系统提示词
// 最大占比（agent_chat_dev 曾占 41%）。引入 memoryBudgetTokens 预算，
// 超限时保留头部（人设/偏好/方向）并追加提示，Agent 可 read 全量。
// ============================================================

import { describe, it, expect } from 'vitest';
import { truncateMemory, pruneMemory } from '@plugins/builtin/hooks/memory';
import { estimateTokens } from '@plugins/builtin/tools/shared';

describe('truncateMemory', () => {
  it('内容未超预算时原样返回', () => {
    const content = '# 记忆\n\n偏好：简洁。';
    const result = truncateMemory(content, 1000, 'a', 'user');
    expect(result).toBe(content);
  });

  it('超预算时保留头部并追加截断提示', () => {
    // 构造约 120 token 的正文（每行 40 字 → 24 token/行）
    const lines = ['# 记忆'];
    for (let i = 0; i < 5; i++) {
      lines.push(`第${i + 1}行：${'重要信息'.repeat(10)}`); // 每行 ~31 token
    }
    const content = lines.join('\n'); // ~156 token

    const result = truncateMemory(content, 100, 'chat~agent1~user', 'user');
    // 应被截断
    expect(result).not.toBe(content);
    // 保留标题
    expect(result).toContain('# 记忆');
    // 追加截断提示，且提示中包含可 read 的完整路径（集中 memory/ 目录）
    expect(result).toContain('[记忆已截断]');
    expect(result).toContain('./files/user/memory/agent1.memory.md');
  });

  it('预算过小时至少保留首行标题', () => {
    const content = '# 标题\n很长的正文内容'.repeat(50);
    const result = truncateMemory(content, 20, 'a', 'b');
    expect(result).toContain('# 标题');
    expect(result).toContain('[记忆已截断]');
  });

  it('截断结果 token 不超预算（含提示）', () => {
    // 用与实现一致的估算验证预算约束
    const content = Array.from({ length: 50 }, (_, i) => `第${i}行：${'内容'.repeat(20)}`).join('\n');
    const budget = 300;
    const result = truncateMemory(content, budget, 'a', 'b');
    // 估算器与实现同源，直接验证不超过预算
    expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
    expect(estimateTokens(result)).toBeGreaterThan(0);
  });
});

describe('pruneMemory（文件硬上限裁剪/遗忘）', () => {
  it('未超上限时原样返回', () => {
    const content = '# 记忆\n\n偏好：简洁。';
    expect(pruneMemory(content, 1000)).toBe(content);
  });

  it('超上限时剪除中间过时内容：头部与最近更新均保留', () => {
    const head = ['# 记忆', '人设：喜欢简洁'];
    const middle = Array.from({ length: 40 }, (_, i) => `过时记录${i}：${'旧信息'.repeat(12)}`);
    const tail = ['最新：8/13 用户换了新项目', '最新：偏好改为详细'];
    const content = [...head, ...middle, ...tail].join('\n');
    const before = estimateTokens(content);

    const result = pruneMemory(content, 300);
    expect(result).not.toBe(content);
    // 首行（标题）与末尾最新记录保留
    expect(result).toContain('# 记忆');
    expect(result).toContain('最新：偏好改为详细');
    // 中间较旧内容被剪除（远离头部与尾部的中间记录）
    expect(result).not.toContain('过时记录15');
    // 结果明显短于原文
    expect(estimateTokens(result)).toBeLessThan(before);
    expect(result).toContain('[记忆裁剪]');
  });

  it('过小上限也至少保留首行', () => {
    const content = '# 标题\n' + '正文'.repeat(200);
    const result = pruneMemory(content, 40);
    expect(result).toContain('# 标题');
    expect(result).toContain('[记忆裁剪]');
  });
});
