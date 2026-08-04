// ============================================================
// 能力标签（tags）体系测试
// ============================================================

import { describe, it, expect } from 'vitest';

// 模拟 agent-loader 的标签匹配逻辑（与实现一致的纯函数）
function roleToTags(role?: string): string[] {
  const map: Record<string, string[]> = { user: [], developer: ['dev'], admin: ['admin', 'dev'] };
  return map[role ?? 'user'] ?? [];
}

function canUseTool(agentTags: string[], requires?: string[]): boolean {
  if (!requires?.length) return true;
  return requires.every(r => agentTags.includes(r));
}

describe('能力标签（tags）体系', () => {
  it('role → tags 兼容映射', () => {
    expect(roleToTags()).toEqual([]);
    expect(roleToTags('user')).toEqual([]);
    expect(roleToTags('developer')).toEqual(['dev']);
    expect(roleToTags('admin')).toEqual(['admin', 'dev']); // admin 默认含 dev
  });

  it('无 requires 的工具所有人可用', () => {
    expect(canUseTool([], undefined)).toBe(true);
    expect(canUseTool([], [])).toBe(true);
  });

  it('requires AND 语义：需全部标签', () => {
    expect(canUseTool(['dev'], ['dev'])).toBe(true);
    expect(canUseTool([], ['dev'])).toBe(false);
    expect(canUseTool(['sap'], ['sap', 'dev'])).toBe(false); // 缺 dev
    expect(canUseTool(['sap', 'dev'], ['sap', 'dev'])).toBe(true); // 全有
  });

  it('admin 标签可用 admin 工具，dev 标签可用 dev 工具', () => {
    expect(canUseTool(['admin', 'dev'], ['admin'])).toBe(true);
    expect(canUseTool(['dev'], ['admin'])).toBe(false);
    expect(canUseTool(['admin', 'dev'], ['dev'])).toBe(true);
  });

  it('组合标签：admin 能开发也能管理', () => {
    const adminTags = roleToTags('admin');
    expect(canUseTool(adminTags, ['dev'])).toBe(true);
    expect(canUseTool(adminTags, ['admin'])).toBe(true);
  });
});
