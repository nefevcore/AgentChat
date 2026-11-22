// ============================================================
// allowlist.test.ts —— 设置化低风险命令白名单（cr-1217 面1）单测：
// 解析过滤 + 全文匹配语义（复合命令不收）
// ============================================================
import { describe, it, expect } from 'vitest';
import { extraLowRiskListOf, hitsAllowlist } from '../src/allowlist.ts';

describe('extraLowRiskListOf（settings 解析——非法值 fail-closed）', () => {
  it('字符串数组通过；空串/非串/非数组/缺省过滤', () => {
    expect(extraLowRiskListOf({ extraLowRisk: ['node cr/cr.mjs list', 'git status'] })).toEqual(['node cr/cr.mjs list', 'git status']);
    expect(extraLowRiskListOf({ extraLowRisk: ['', 42, null, 'ok'] })).toEqual(['ok']);
    expect(extraLowRiskListOf({ extraLowRisk: 'node x' })).toEqual([]);
    expect(extraLowRiskListOf(undefined)).toEqual([]);
    expect(extraLowRiskListOf([])).toEqual([]);
  });
});

describe('hitsAllowlist（首部前缀 + 词边界 + 危险字符闸——cr-1218）', () => {
  const list = ['node cr/cr.mjs list', 'node cr/cr.mjs grep'];

  it('精确命中与带参数命中（只读子命令必须能带参数才有用）', () => {
    expect(hitsAllowlist('node cr/cr.mjs list', list)).toBe(true);
    expect(hitsAllowlist('node cr/cr.mjs list -n 10', list)).toBe(true);
    expect(hitsAllowlist('node cr/cr.mjs grep detail ISSUE-20', list)).toBe(true); // 全文匹配时代会被误判失效
  });

  it('词边界：首部之后必须空白或结尾', () => {
    expect(hitsAllowlist('node cr/cr.mjs liste', list)).toBe(false);
    expect(hitsAllowlist('node cr/cr.mjs grepX detail', list)).toBe(false);
  });

  it('危险字符闸：复合命令/重定向/替换/变量一律不收', () => {
    expect(hitsAllowlist('node cr/cr.mjs list; rm -rf /', list)).toBe(false);
    expect(hitsAllowlist('node cr/cr.mjs list | tee out', list)).toBe(false);
    expect(hitsAllowlist('node cr/cr.mjs list > out.txt', list)).toBe(false);
    expect(hitsAllowlist('node cr/cr.mjs list && whoami', list)).toBe(false);
    expect(hitsAllowlist('node cr/cr.mjs grep $env:SECRET', list)).toBe(false);
  });

  it('非首部不命中（低险命令不得作为复合段掩护）', () => {
    expect(hitsAllowlist('echo x && node cr/cr.mjs list', list)).toBe(false);
    expect(hitsAllowlist('  node cr/cr.mjs list', list)).toBe(true); // 前导空白归一后仍算首部
  });

  it('未声明子命令不命中（append 类写操作永不放行）', () => {
    expect(hitsAllowlist('node cr/cr.mjs append x', list)).toBe(false);
  });
});
