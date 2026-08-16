// ============================================================
// @agentchat/tools/src/service.ts —— owner 归属 / presets 过滤测试
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ToolsService } from '../src/service';
import { defineTool } from '@agentchat/toolkit';
import type { AgentConfig } from '@agentchat/agent-config';

const mk = (name: string, requires?: string[]) => defineTool({
  name, label: name, description: name,
  parameters: { type: 'object', properties: {} },
  ...(requires ? { requires } : {}),
  execute: async () => name,
});

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  agent_id: 'a', name: 'A', tags: ['base'],
  ...over,
} as AgentConfig);

describe('ToolsService owner / presets', () => {
  it('owner 归属：presets 决定哪些插件的工具参与烘焙', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.register('agentchat-math', [mk('math', ['base'])]);
    tools.registerFactory('agentchat-fs-tools', (c) => [mk('read', ['base'])]);
    tools.registerFactory('agentchat-dev-tools', (c) => [mk('reload', ['dev'])]);

    // presets 未声明（旧契约）：全部参与
    expect(tools.resolveTools(config(), {}).has('reload')).toBe(false); // tags 不匹配
    expect([...tools.resolveTools(config({ tags: ['base', 'dev'] }), {}).keys()].sort())
      .toEqual(['math', 'read', 'reload']);

    // presets 过滤：仅 fs 参与（math 未启用 → 默认注入失败）
    const filtered = tools.resolveTools(config({ presets: ['agentchat-fs-tools'] }), {});
    expect(filtered.has('read')).toBe(true);
    expect(filtered.has('math')).toBe(false);

    // 显式 include 也要先过 presets 过滤
    expect(tools.resolveTools(config({ presets: ['agentchat-fs-tools'], tools: { include: ['math'] } }), {}).has('math')).toBe(false);
    expect(tools.resolveTools(config({ presets: ['agentchat-math'], tools: { include: ['math'] } }), {}).has('math')).toBe(true);
  });

  it('tools {include,exclude}：exclude 覆盖默认与 include，移除 exclude 后恢复', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.register('agentchat-math', [mk('math', ['base'])]);
    tools.register('agentchat-fs-tools', [mk('bash')]);

    // 默认启用的 math 被 exclude；requires 为空的 bash 经 include 显式启用后也被 exclude
    const disabled = tools.resolveTools(config({ tools: { include: ['bash'], exclude: ['math', 'bash'] } }), {});
    expect(disabled.has('math')).toBe(false);
    expect(disabled.has('bash')).toBe(false);

    const enabled = tools.resolveTools(config({ tools: { include: ['bash'], exclude: [] } }), {});
    expect(enabled.has('math')).toBe(true);
    expect(enabled.has('bash')).toBe(true);
  });

  it('旧契约兼容：tools string[] 与 disabledTools 自动归一化', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.register('agentchat-math', [mk('math', ['base'])]);
    tools.register('agentchat-fs-tools', [mk('bash')]);

    // 旧调用签名（names 显式清单）+ 旧 disabledTools 字段仍然生效
    const legacy = tools.resolveTools(['bash'], config({ disabledTools: ['math'] }), {});
    expect(legacy.has('math')).toBe(false);
    expect(legacy.has('bash')).toBe(true);
  });

  it('旧 agent 标签读取时归一化为 base（兼容存量配置）', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.register('agentchat-math', [mk('math', ['base'])]);
    expect(tools.resolveTools(config({ tags: ['agent'] }), {}).has('math')).toBe(true);
    expect(tools.resolveTools(config({ tags: [] }), {}).has('math')).toBe(true); // base 隐式
  });

  it('unregister(owner)：精确回收工具与工厂', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.register('p1', [mk('a')]);
    tools.registerFactory('p2', () => [mk('b')]);
    expect(tools.listOwners().sort()).toEqual(['p1', 'p2']);
    expect(tools.unregister('p1')).toBe(1);
    expect(tools.unregister('p1')).toBe(0);
    expect(tools.unregister('p2')).toBe(1);
    expect(tools.listOwners()).toEqual([]);
  });

  it('无主注册（兼容通道）与 always 注册（运行时工具）不过滤', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.register(undefined, [mk('legacy')]);
    tools.register('runtime:t1', [mk('runtime')], { always: true });
    const resolved = tools.resolveTools(config({ presets: [], tools: { include: ['legacy', 'runtime'] } }), {});
    expect(resolved.has('legacy')).toBe(true);
    expect(resolved.has('runtime')).toBe(true);
  });

  it('replace 注册：后注册者替换同名共享工具并遮蔽工厂；owner 卸载后工厂恢复', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    tools.registerFactory('factory-owner', () => [mk('dup')]);
    tools.register('old-owner', [mk('dup')]);
    const v2 = mk('dup');
    (v2 as any).description = 'v2';
    tools.register('new-owner', [v2], { replace: true });

    const resolved = tools.resolveTools(config({ tools: { include: ['dup'] } }), {});
    expect(resolved.get('dup')?.description).toBe('v2');
    // 同名注册表只保留最新一份（不叠加）
    expect(tools.listAll(config(), {}).filter((t) => t.name === 'dup')).toHaveLength(1);

    // 卸载 replace owner → 工厂同名工具恢复可见
    tools.unregister('new-owner');
    expect(tools.resolveTools(config({ tools: { include: ['dup'] } }), {}).has('dup')).toBe(true);
  });
});
