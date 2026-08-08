// ============================================================
// requires 自动注入 单元测试（PluginRegistry.resolveTools）
//
// 背景（v0.4.5）：工具集从"config.tools 写死白名单"改为
// "按工具 requires 匹配 Agent tags 自动注入"——
//   · 基础工具 requires ["agent"] → 所有实 Agent 自动获得（agent 为隐式基础标签）
//   · dev 工具 requires ["dev"] → 有 dev 标签的 Agent 获得
//   · admin 工具 requires ["admin"] → 有 admin 标签的 Agent 获得
//   · 领域工具 requires ["sap"] 等 → 未来领域标签匹配
//   · config.plugins[].tools 退化为显式追加（向后兼容）
//
// 新架构（5 层重构后）：agent 是隐式基础标签（agentTags = Set(['agent', ...tags]）），
//   resolveTools(names, config) 按 requires AND 语义自动注入 + 显式 names 追加。
// ============================================================

import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../src/plugins/registry';
import type { AgentConfig } from '../src/agents/config';
import type { Tool } from '../src/core/types';

// ---- 构造插件：工具工厂 per-Agent 烘焙 ----
function makePlugin(toolDefs: Array<[string, string[] | undefined]>) {
  return {
    meta: { name: 'test', label: 'Test' },
    tools: (): Tool[] => toolDefs.map(([name, requires]) => ({
      name,
      label: name,
      ...(requires ? { requires } : {}),
      definition: {
        type: 'function' as const,
        function: { name, description: '', parameters: { type: 'object', properties: {} } },
      },
      execute: async () => 'ok',
    })),
  };
}

function resolve(toolDefs: Array<[string, string[] | undefined]>, tags: string[], names?: string[]): string[] {
  const registry = new PluginRegistry();
  registry.register(makePlugin(toolDefs) as any);
  const cfg: AgentConfig = { agent_id: 'a', name: 'A', ...(tags.length ? { tags } : {}) };
  const tools = registry.resolveTools(names, cfg);
  return Array.from(tools.keys()).sort();
}

describe('requires 自动注入（resolveTools）', () => {
  it('agent tag（隐式）→ 自动获得全部 requires=["agent"] 的基础工具', () => {
    const got = resolve([
      ['read', ['agent']],
      ['write', ['agent']],
      ['bash', ['agent']],
      ['code_search', ['dev']],
      ['system_restart', ['admin']],
      ['custom', undefined], // 无 requires
    ], []);
    expect(got).toContain('read');
    expect(got).toContain('write');
    expect(got).toContain('bash');
    expect(got).not.toContain('code_search');
    expect(got).not.toContain('system_restart');
    expect(got).not.toContain('custom'); // 无 requires 不自动注入
  });

  it('dev 标签 → 自动获得基础 + dev 工具', () => {
    const got = resolve([
      ['read', ['agent']],
      ['code_search', ['dev']],
      ['reload', ['dev']],
    ], ['dev']);
    expect(got).toContain('read');
    expect(got).toContain('code_search');
    expect(got).toContain('reload');
  });

  it('admin+dev 标签 → 自动获得基础 + dev + admin 工具', () => {
    const got = resolve([
      ['read', ['agent']],
      ['code_search', ['dev']],
      ['system_restart', ['admin']],
    ], ['admin', 'dev']);
    expect(got).toContain('read');
    expect(got).toContain('code_search');
    expect(got).toContain('system_restart');
  });

  it('领域 tag（sap）→ 仍自动获得基础工具（agent 隐式）；requires 不匹配的 dev 工具被拒', () => {
    const got = resolve([
      ['read', ['agent']],
      ['code_search', ['dev']],
    ], ['sap']);
    expect(got).toContain('read'); // agent 隐式 → 基础工具仍可得
    expect(got).not.toContain('code_search');
  });

  it('显式 names 追加：无 requires 的工具可显式启用；requires 不匹配仍被拒', () => {
    const got = resolve([
      ['read', ['agent']],
      ['custom', undefined],
      ['code_search', ['dev']],
    ], ['sap'], ['custom', 'code_search']);
    expect(got).toContain('custom');  // 无 requires → 显式启用
    expect(got).not.toContain('code_search'); // requires ['dev']，sap 无 dev → 拒绝
  });
});
