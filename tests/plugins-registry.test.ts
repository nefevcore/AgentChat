// ============================================================
// src/plugins/registry 单元测试 —— 插件注册表
// ============================================================
import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../src/plugins/registry';
import { defineTool } from '../src/plugins/define-tool';
import builtinPlugin from '../src/plugins/builtin';
import type { AgentConfig } from '../src/agents/config';

const cfg: AgentConfig = { agent_id: 'a', name: 'A' };

const toolA = defineTool({ name: 'a', label: 'A', ns: 't.a', description: 'a', parameters: {}, execute: async () => 'a' });
const toolB = defineTool({ name: 'b', label: 'B', ns: 't.b', description: 'b', parameters: {}, execute: async () => 'b' });
const toolC = defineTool({ name: 'c', label: 'C', ns: 't.c', description: 'c', parameters: {}, execute: async () => 'c' });

const simplePlugin = {
  meta: { name: 'simple', label: 'S' },
  tools: [toolA, toolB],
};

const hookPlugin = {
  meta: { name: 'hooks', label: 'H' },
  hooks: {
    runStart: { 'rs1': async () => {} },
    runEnd: { 're1': async () => {} },
    turnStart: { 'h1': async () => {}, 'h2': async () => {} },
    fallback: { 'f1': async () => {} },
  },
};

describe('PluginRegistry 工具解析', () => {
  it('数组工具：按名解析', () => {
    const r = new PluginRegistry();
    r.register(simplePlugin);
    const tools = r.resolveTools(['a', 'b'], cfg);
    expect(tools.get('a')).toBe(toolA);
    expect(tools.get('b')).toBe(toolB);
    expect(tools.size).toBe(2);
  });

  it('按名过滤：只返回请求的工具', () => {
    const r = new PluginRegistry();
    r.register(simplePlugin);
    const tools = r.resolveTools(['b'], cfg);
    expect(tools.size).toBe(1);
    expect(tools.get('b')).toBe(toolB);
  });

  it('未注册的名字：忽略', () => {
    const r = new PluginRegistry();
    r.register(simplePlugin);
    expect(r.resolveTools(['nope'], cfg).size).toBe(0);
    expect(r.resolveTools(undefined, cfg).size).toBe(0);
    expect(r.resolveTools([], cfg).size).toBe(0);
  });

  it('工厂工具：按 Agent 配置烘焙（收到 config）', () => {
    const seen: string[] = [];
    const r = new PluginRegistry();
    r.register({
      meta: { name: 'factory', label: 'F' },
      tools: (config: AgentConfig) => { seen.push(config.agent_id); return [toolC]; },
    });
    const m = r.resolveTools(['c'], { agent_id: 'agentA', name: 'A' });
    expect(m.get('c')).toBe(toolC);
    expect(seen).toEqual(['agentA']);
  });

  it('同名工具：先注册的插件优先', () => {
    const r = new PluginRegistry();
    const v1 = defineTool({ name: 'x', label: 'X1', ns: 't', description: 'x', parameters: {}, execute: async () => 'v1' });
    const v2 = defineTool({ name: 'x', label: 'X2', ns: 't', description: 'x', parameters: {}, execute: async () => 'v2' });
    r.register({ meta: { name: 'p1', label: 'P1' }, tools: [v1] });
    r.register({ meta: { name: 'p2', label: 'P2' }, tools: [v2] });
    expect(r.resolveTools(['x'], cfg).get('x')).toBe(v1);
  });

  it('unregister 后工具不再可解析', () => {
    const r = new PluginRegistry();
    r.register(simplePlugin);
    r.unregister('simple');
    expect(r.resolveTools(['a'], cfg).size).toBe(0);
    expect(r.listPlugins()).toEqual([]);
  });
});

describe('PluginRegistry requires 门控（能力标签 AND 语义）', () => {
  const devTool = defineTool({ name: 'code_search', label: '代码搜索', requires: ['dev'], description: 'd', parameters: {}, execute: async () => 'd' });
  const adminTool = defineTool({ name: 'system_restart', label: '重启', requires: ['admin'], description: 'r', parameters: {}, execute: async () => 'r' });
  const condTool = defineTool({ name: 'spawn_subagent', label: '子Agent', requires: ['conductor'], description: 's', parameters: {}, execute: async () => 's' });
  const baseTool = defineTool({ name: 'read', label: '读取', requires: ['agent'], description: 'b', parameters: {}, execute: async () => 'b' });
  const freeTool = defineTool({ name: 'ask_user', label: '询问', description: 'f', parameters: {}, execute: async () => 'f' });

  const gatedPlugin = { meta: { name: 'gated', label: 'G' }, tools: [devTool, adminTool, condTool, baseTool, freeTool] };

  it('agent 为隐式基础标签：空 tags 也获得基础工具', () => {
    const r = new PluginRegistry();
    r.register(gatedPlugin);
    const tools = r.resolveTools(['read', 'ask_user'], cfg); // cfg 无 tags
    expect(tools.get('read')).toBe(baseTool);
    expect(tools.get('ask_user')).toBe(freeTool);
  });

  it('requires 门控：缺标签的工具不注入（基础 agent 工具仍自动注入）', () => {
    const r = new PluginRegistry();
    r.register(gatedPlugin);
    const tools = r.resolveTools(['code_search', 'system_restart', 'spawn_subagent'], cfg); // 无 dev/admin/conductor
    // 自动注入 requires 匹配的 read；dev/admin/conductor 工具不满足标签 → 不注入
    expect(tools.get('code_search')).toBeUndefined();
    expect(tools.get('system_restart')).toBeUndefined();
    expect(tools.get('spawn_subagent')).toBeUndefined();
    expect(tools.get('read')).toBe(baseTool);
  });

  it('dev 标签解锁 dev 工具（AND 语义：需全部标签）', () => {
    const r = new PluginRegistry();
    r.register(gatedPlugin);
    const cfgDev: AgentConfig = { agent_id: 'd', name: 'D', tags: ['dev'] };
    const tools = r.resolveTools(['code_search', 'system_restart'], cfgDev);
    expect(tools.get('code_search')).toBe(devTool);
    expect(tools.get('system_restart')).toBeUndefined(); // admin 不满足
  });

  it('admin 标签解锁 admin 工具；admin 隐含 dev（旧角色映射）', () => {
    const r = new PluginRegistry();
    r.register(gatedPlugin);
    const cfgAdmin: AgentConfig = { agent_id: 'ad', name: 'AD', tags: ['admin', 'dev'] };
    const tools = r.resolveTools(['system_restart', 'code_search'], cfgAdmin);
    expect(tools.get('system_restart')).toBe(adminTool);
    expect(tools.get('code_search')).toBe(devTool);
  });

  it('conductor 标签解锁子 Agent 工具', () => {
    const r = new PluginRegistry();
    r.register(gatedPlugin);
    const cfgC: AgentConfig = { agent_id: 'c', name: 'C', tags: ['conductor'] };
    const tools = r.resolveTools(['spawn_subagent'], cfgC);
    expect(tools.get('spawn_subagent')).toBe(condTool);
  });
});

describe('PluginRegistry 钩子解析', () => {
  it('按名收集成数组；未找到的忽略；未声明的类为 undefined', () => {
    const r = new PluginRegistry();
    r.register(hookPlugin);
    const res = r.resolveHooks({
      runStart: ['rs1'],
      runEnd: ['re1'],
      turnStart: ['h1', 'h2', 'missing'],
      fallback: ['f1'],
    });
    expect(res.runStartHook).toHaveLength(1);
    expect(res.runEndHook).toHaveLength(1);
    expect(res.turnStartHook).toHaveLength(2);
    expect(res.fallbackHook).toHaveLength(1);
    expect(res.turnEndHook).toBeUndefined();
  });

  it('runStart/runEnd：不声明则为 undefined', () => {
    const r = new PluginRegistry();
    r.register(hookPlugin);
    const res = r.resolveHooks({ turnStart: ['h1'] });
    expect(res.turnStartHook).toHaveLength(1);
    expect(res.runStartHook).toBeUndefined();
    expect(res.runEndHook).toBeUndefined();
  });

  it('空钩子名 → 空结果', () => {
    const r = new PluginRegistry();
    r.register(hookPlugin);
    const res = r.resolveHooks({});
    expect(res.turnStartHook).toBeUndefined();
    expect(res.fallbackHook).toBeUndefined();
    expect(res.runStartHook).toBeUndefined();
  });
});

describe('PluginRegistry 服务装载（useService）', () => {
  it('惰性装载：首次 useService 时执行工厂，之后单例缓存', () => {
    let factoryCalls = 0;
    const r = new PluginRegistry();
    r.register({
      meta: { name: 'svc', label: 'S' },
      services: {
        makeThing: () => { factoryCalls++; return { id: factoryCalls }; },
      },
    });
    const a = r.useService<{ id: number }>('makeThing');
    const b = r.useService<{ id: number }>('makeThing');
    expect(a).toBe(b);          // 单例缓存
    expect(factoryCalls).toBe(1);
  });

  it('装配上下文注入：工厂收到 setServiceContext 的 ctx', () => {
    const seen: any[] = [];
    const r = new PluginRegistry();
    r.register({
      meta: { name: 'svc', label: 'S' },
      services: {
        probe: (ctx: any) => { seen.push(ctx); return ctx; },
      },
    });
    r.setServiceContext({ workspaceDir: '/ws', agentsDir: '/ws/agents', timezone: 'UTC' });
    const s = r.useService<{ workspaceDir: string }>('probe');
    expect(s?.workspaceDir).toBe('/ws');
    expect(seen[0].timezone).toBe('UTC');
  });

  it('未注册的服务 → undefined；listServiceNames 列出全部', () => {
    const r = new PluginRegistry();
    r.register({
      meta: { name: 'svc', label: 'S' },
      services: { a: () => 1, b: () => 2 },
    });
    expect(r.useService('nope')).toBeUndefined();
    expect(r.listServiceNames().sort()).toEqual(['a', 'b']);
  });

  it('setService 可预置实例（测试/装配用）', () => {
    const r = new PluginRegistry();
    r.setService('premade', { ok: true });
    expect(r.useService('premade')).toEqual({ ok: true });
  });

  it('builtin 插件的 loadHistory 服务经 useService 获取并可用', () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const loadHist = r.useService<(dialogId: string) => unknown[]>('loadHistory');
    expect(typeof loadHist).toBe('function');
    // 无会话文件 → 空数组
    expect(loadHist!('nope__x')).toEqual([]);
  });

  it('builtin 插件的 timer/subagent 服务经 useService 惰性装载（ctx 装配）', async () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    r.setServiceContext({ workspaceDir: '/tmp/ws', agentsDir: '/tmp/ws/agents', timezone: 'Asia/Shanghai' });

    const timer = r.useService<{ reloadAll: () => void; stopAll: () => void }>('timer');
    expect(timer).toBeDefined();
    expect(typeof timer!.reloadAll).toBe('function');
    // 单例缓存
    expect(r.useService('timer')).toBe(timer);

    const subagent = r.useService<{ size: number }>('subagent');
    expect(subagent).toBeDefined();
    expect(subagent!.size).toBe(0);
  });
});
