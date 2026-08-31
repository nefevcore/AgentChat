// ============================================================
// applySearchPoolDefault 单测（搜索池"设为默认"同步到全局 tool.web_search）
// 背景 bug：池 default:true 会被全局 ns 残留的显式 provider 遮蔽，
// 用户"设为默认"看似不生效；同步函数让默认确定性落到全局 ns。
// ============================================================
import { describe, expect, it } from 'vitest';
import { applySearchPoolDefault } from '../src/settings/schema';

const POOLS = {
  'tavily-free': { provider: 'tavily', default: false },
  deepseek: { provider: 'deepseek', default: true },
};

describe('applySearchPoolDefault', () => {
  it('核心场景：ns 残留显式 provider 遮蔽池默认 → 重写为 $ref 指向默认条目', () => {
    const gc: Record<string, any> = {
      'tool.web_search': { provider: 'tavily', quota: 30, defaultResults: 8 },
    };
    applySearchPoolDefault(POOLS, gc);
    // 遮蔽字段剥离，中性字段保留，指向默认条目
    expect(gc['tool.web_search']).toEqual({ defaultResults: 8, $ref: 'deepseek' });
  });

  it('ns 残留 apiKey 字段同样被剥离', () => {
    const gc: Record<string, any> = {
      'tool.web_search': { tavilyApiKey: 'tvly-xxx', provider: 'tavily' },
    };
    applySearchPoolDefault(POOLS, gc);
    expect(gc['tool.web_search']).toEqual({ $ref: 'deepseek' });
    expect(JSON.stringify(gc)).not.toContain('tvly-xxx');
  });

  it('ns 已指向默认条目 → 原样不动', () => {
    const gc: Record<string, any> = { 'tool.web_search': { $ref: 'deepseek' } };
    const before = gc['tool.web_search'];
    applySearchPoolDefault(POOLS, gc);
    expect(gc['tool.web_search']).toBe(before);
  });

  it('ns 缺失 → 创建 {$ref}', () => {
    const gc: Record<string, any> = {};
    applySearchPoolDefault(POOLS, gc);
    expect(gc['tool.web_search']).toEqual({ $ref: 'deepseek' });
  });

  it('切换默认条目 → $ref 跟随切换，保留中性覆盖', () => {
    const gc: Record<string, any> = { 'tool.web_search': { $ref: 'tavily-free', defaultDepth: 'basic' } };
    applySearchPoolDefault({
      'tavily-free': { provider: 'tavily' },
      deepseek: { provider: 'deepseek', default: true },
    }, gc);
    expect(gc['tool.web_search']).toEqual({ defaultDepth: 'basic', $ref: 'deepseek' });
  });

  it('默认条目被删且 $ref 悬空 → 删除该 ns（解析层回落池首项）', () => {
    const gc: Record<string, any> = { 'tool.web_search': { $ref: 'deepseek' } };
    applySearchPoolDefault({ 'tavily-free': { provider: 'tavily' } }, gc);
    expect(gc['tool.web_search']).toBeUndefined();
  });

  it('无默认条目但 ns 完好（如指向非默认条目）→ 不动', () => {
    const gc: Record<string, any> = { 'tool.web_search': { $ref: 'tavily-free' } };
    applySearchPoolDefault({ 'tavily-free': { provider: 'tavily' }, deepseek: { provider: 'deepseek' } }, gc);
    expect(gc['tool.web_search']).toEqual({ $ref: 'tavily-free' });
  });

  it('空池 + 有 ns → 不动（无从推断默认）', () => {
    const gc: Record<string, any> = { 'tool.web_search': { provider: 'tavily' } };
    applySearchPoolDefault({}, gc);
    expect(gc['tool.web_search']).toEqual({ provider: 'tavily' });
  });
});
