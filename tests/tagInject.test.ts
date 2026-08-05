// ============================================================
// selectToolsByRequires —— 按 requires 自动注入工具 单元测试
//
// 背景（v0.4.5）：工具集从"config.tools 写死白名单"改为
// "按工具 requires 匹配 Agent tags 自动注入"——
//   · 基础工具 requires ["agent"] → 所有实 Agent 自动获得
//   · dev 工具 requires ["dev"] → 有 dev 标签的 Agent 获得
//   · admin 工具 requires ["admin"] → 有 admin 标签的 Agent 获得
//   · 领域工具 requires ["sap"] 等 → 未来领域标签匹配
//   · config.tools 退化为显式追加（向后兼容）
// ============================================================

import { describe, it, expect } from 'vitest';
import { selectToolsByRequires } from '../src/plugins/loader';
import type { Tool } from '../src/core/types';

// ---- 构造工具辅助 ----
function mkTool(name: string): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: '', parameters: { type: 'object', properties: {} } },
    },
  } as unknown as Tool;
}

function build(
  toolDefs: Array<[string, string[] | undefined]>, // [name, requires]
  toolLevels: Record<string, 'basic' | 'tool' | 'dev' | 'admin'> = {},
) {
  const merged = new Map<string, Tool>();
  const requires = new Map<string, string[]>();
  const levels = new Map<string, 'basic' | 'tool' | 'dev' | 'admin'>();
  for (const [name, req] of toolDefs) {
    merged.set(name, mkTool(name));
    if (req) requires.set(name, [...req]);
    if (toolLevels[name]) levels.set(name, toolLevels[name]);
  }
  return { merged, requires, levels };
}

function names(tools: Tool[]): string[] {
  return tools.map(t => t.definition.function.name).sort();
}

describe('selectToolsByRequires 按 requires 自动注入', () => {
  it('agent tag → 自动获得全部 requires=["agent"] 的基础工具', () => {
    const { merged, requires, levels } = build([
      ['read', ['agent']],
      ['write', ['agent']],
      ['bash', ['agent']],
      ['code_search', ['dev']],
      ['system_restart', ['admin']],
      ['custom', undefined], // 无 requires
    ]);
    const selected = selectToolsByRequires(merged, requires, levels, ['agent'], []);
    const got = names(selected);
    expect(got).toContain('read');
    expect(got).toContain('write');
    expect(got).toContain('bash');
    expect(got).not.toContain('code_search');
    expect(got).not.toContain('system_restart');
    expect(got).not.toContain('custom'); // 无 requires 不自动注入
  });

  it('agent+dev → 自动获得基础 + dev 工具', () => {
    const { merged, requires, levels } = build([
      ['read', ['agent']],
      ['code_search', ['dev']],
      ['reload', ['dev']],
    ]);
    const selected = selectToolsByRequires(merged, requires, levels, ['agent', 'dev'], []);
    const got = names(selected);
    expect(got).toContain('read');
    expect(got).toContain('code_search');
    expect(got).toContain('reload');
  });

  it('agent+admin+dev → 自动获得基础 + dev + admin 工具', () => {
    const { merged, requires, levels } = build([
      ['read', ['agent']],
      ['code_search', ['dev']],
      ['system_restart', ['admin']],
    ]);
    const selected = selectToolsByRequires(merged, requires, levels, ['agent', 'admin', 'dev'], []);
    const got = names(selected);
    expect(got).toContain('read');
    expect(got).toContain('code_search');
    expect(got).toContain('system_restart');
  });

  it('领域 tag（sap）无 agent → 不自动获得基础工具；explicitTools 可显式追加', () => {
    const { merged, requires, levels } = build([
      ['read', ['agent']],
      ['custom', undefined],
    ]);
    // sap tag 无 agent → 基础工具不自动注入
    const selected1 = selectToolsByRequires(merged, requires, levels, ['sap'], []);
    expect(names(selected1)).not.toContain('read');

    // explicitTools 显式追加：无 requires 的工具可显式启用；requires 不匹配仍被拒
    const selected2 = selectToolsByRequires(merged, requires, levels, ['sap'], ['read', 'custom']);
    const got = names(selected2);
    expect(got).not.toContain('read'); // requires ['agent']，sap 无 agent → 拒绝
    expect(got).toContain('custom');   // 无 requires → 显式启用
  });

  it('explicitTools 显式追加但 requires 不匹配 → 剔除（安全）', () => {
    const { merged, requires, levels } = build([
      ['read', ['agent']],
      ['code_search', ['dev']],
    ]);
    // sap tag 显式要 code_search（需 dev）→ 拒绝
    const selected = selectToolsByRequires(merged, requires, levels, ['sap'], ['code_search']);
    expect(names(selected)).not.toContain('code_search');
  });

  it('admin 标签 → 额外注入 level=admin 工具（兼容旧角色体系）', () => {
    const { merged, requires, levels } = build([
      ['read', ['agent']],
      ['system_restart', undefined], // 无 requires，仅 level=admin
    ], { system_restart: 'admin' });
    const selected = selectToolsByRequires(merged, requires, levels, ['agent', 'admin'], []);
    expect(names(selected)).toContain('system_restart');
  });
});
