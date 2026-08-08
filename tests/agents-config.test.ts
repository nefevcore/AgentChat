// ============================================================
// src/agents/config 单元测试 —— AgentConfig + createAgentContext
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  createAgentContext, collectToolNames, collectHookNames,
  getNamespaceConfig,
  type AgentAssembly, type AgentConfig, type AgentPlugin, type HookNames,
} from '../src/agents/config';
import type { LLMProvider, LLMResponse, Tool } from '../src/core/types';
import { ChatStream } from '../src/core/llm/chat-stream';

// ---- 最小 mock LLM ----
const stopResp: LLMResponse = { content: 'ok', toolCalls: [], finishReason: 'stop' };
function makeMockLLM(): LLMProvider {
  return {
    model: 'mock-model',
    chat: async () => ({ ...stopResp }),
    stream: () => {
      const cs = new ChatStream();
      cs.push({ type: 'message_start', partial: { content: '', reasoning: '' } });
      cs.push({ type: 'message_end', partial: { content: 'ok', reasoning: '' } });
      cs.done({ ...stopResp });
      return cs;
    },
    toProviderMessages: (m) => m as any[],
    fromProviderMessages: (m) => m as any[],
  };
}

const tool: Tool = {
  name: 't1', label: 'T1', ns: 'tool.t1',
  definition: { type: 'function', function: { name: 't1', description: 't', parameters: { type: 'object', properties: {} } } },
  execute: async () => 'ok',
};

function makeAssembly(overrides: Partial<AgentAssembly> = {}): AgentAssembly {
  return {
    createLLM: () => makeMockLLM(),
    resolveTools: () => new Map([['t1', tool]]),
    loadHistory: () => [],
    systemPrompt: (c) => `SP:${c.name}`,
    ...overrides,
  };
}

describe('AgentConfig —— 以 CurrentContext 为基类的配置文件形态', () => {
  it('持有 llm/plugins 设置 + 继承 deepThink/maxTurns + 命名空间配置', () => {
    const config: AgentConfig = {
      agent_id: 'a',
      name: 'A',
      virtual: false,
      tags: ['dev'],
      llm: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      plugins: [
        { name: 'builtin', tools: ['bash', 'read'] },
        { name: 'session', turnStart: ['session.load'], turnEnd: ['session.save'] },
      ],
      deepThink: false,
      maxTurns: 5,
      'tool.bash': { defaultTimeout: 60000 },
      security: { allowedPaths: ['/tmp/scratch/'] },
    };
    expect(config.agent_id).toBe('a');
    expect(config.name).toBe('A');
    expect(config.llm).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(config.plugins?.length).toBe(2);
    // 继承自 CurrentContext 的字段
    expect(config.deepThink).toBe(false);
    expect(config.maxTurns).toBe(5);
    // 命名空间配置
    expect(config['tool.bash']).toEqual({ defaultTimeout: 60000 });
    expect(config['security']).toEqual({ allowedPaths: ['/tmp/scratch/'] });
  });

  it('虚拟 Agent 配置（user 端点）', () => {
    const config: AgentConfig = { agent_id: 'user', name: '用户', virtual: true };
    expect(config.virtual).toBe(true);
  });
});

describe('插件聚合', () => {
  const plugins: AgentPlugin[] = [
    { name: 'a', tools: ['bash', 'read'], turnStart: ['a.pre'], fallback: ['a.fb'] },
    { name: 'b', tools: ['read', 'edit'], turnStart: ['b.pre'], toolExecutionStart: ['b.tx'] },
  ];

  it('collectToolNames：跨插件合并、去重、保序', () => {
    expect(collectToolNames(plugins)).toEqual(['bash', 'read', 'edit']);
    expect(collectToolNames(undefined)).toBeUndefined();
    expect(collectToolNames([])).toBeUndefined();
    expect(collectToolNames([{ name: 'x' }])).toBeUndefined();
  });

  it('collectHookNames：按五类分别合并、去重、保序', () => {
    const names = collectHookNames(plugins);
    expect(names.turnStart).toEqual(['a.pre', 'b.pre']);
    expect(names.toolExecutionStart).toEqual(['b.tx']);
    expect(names.fallback).toEqual(['a.fb']);
    expect(names.turnEnd).toBeUndefined();
    expect(collectHookNames(undefined)).toEqual({});
  });
});

describe('命名空间配置读取', () => {
  it('getNamespaceConfig：缺省返回空对象；非对象返回空', () => {
    const config: AgentConfig = { agent_id: 'a', name: 'A', 'tool.bash': { x: 1 } };
    expect(getNamespaceConfig(config, 'tool.bash')).toEqual({ x: 1 });
    expect(getNamespaceConfig(config, 'nope')).toEqual({});
    const config2 = { agent_id: 'a', name: 'A', 'tool.bash': 'string' } as AgentConfig;
    expect(getNamespaceConfig(config2, 'tool.bash')).toEqual({});
  });
});

describe('createAgentContext —— 装配工厂（§7.4 createLoop）', () => {
  it('把 config + 注入能力装配为可执行 CurrentContext（含 plugins 聚合）', () => {
    const llm = makeMockLLM();
    const tools = new Map([['t1', tool]]);
    const toolNames: Array<string[] | undefined> = [];
    const hookNames: HookNames[] = [];
    const calls: string[] = [];
    const assembly = makeAssembly({
      createLLM: () => llm,
      resolveTools: (names) => { toolNames.push(names); return tools; },
      resolveHooks: (names) => { hookNames.push(names); return {}; },
      loadHistory: (key) => { calls.push(key); return [{ role: 'agent', content: 'hi', agent_id: 'user' }]; },
      systemPrompt: (c) => `SP:${c.name}`,
    });

    const config: AgentConfig = {
      agent_id: 'a', name: 'A', llm: 'pool-ref',
      plugins: [{ name: 'x', tools: ['bash'], turnStart: ['a.pre'] }],
    };
    const ctx = createAgentContext(config, assembly, {
      currentMessage: { role: 'user', content: 'hello' },
      dialogId: 'user__a',
      signal: new AbortController().signal,
    });

    expect(ctx.llm).toBe(llm);
    expect(ctx.tools).toBe(tools);
    expect(ctx.systemPrompt).toBe('SP:A');
    expect(ctx.history.length).toBe(1);
    expect(ctx.currentMessage?.content).toBe('hello');
    expect(ctx.dialogId).toBe('user__a');
    expect(ctx.steer).toEqual([]);
    // 工具名按 plugins 聚合后传给 resolveTools
    expect(toolNames).toEqual([['bash']]);
    // 钩子名聚合后传给 resolveHooks
    expect(hookNames.length).toBe(1);
    expect(hookNames[0].turnStart).toEqual(['a.pre']);
    // 历史按 dialogId 加载
    expect(calls).toEqual(['user__a']);
  });

  it('无 dialogId：不加载历史；hooks 未提供时为 undefined（loop 容忍）', () => {
    const ctx = createAgentContext({ agent_id: 'a', name: 'A' }, makeAssembly());
    expect(ctx.history).toEqual([]);
    expect(ctx.currentMessage).toBeUndefined();
    expect(ctx.dialogId).toBeUndefined();
    expect(ctx.turnStartHook).toBeUndefined();
    expect(ctx.tools.size).toBe(1);
  });

  it('resolveHooks 注入五类钩子数组', () => {
    const turnStartHook = [async () => {}];
    const fallbackHook = [async () => {}];
    const assembly = makeAssembly({
      resolveHooks: () => ({ turnStartHook, fallbackHook }),
    });
    const ctx = createAgentContext({ agent_id: 'a', name: 'A' }, assembly);
    expect(ctx.turnStartHook).toBe(turnStartHook);
    expect(ctx.fallbackHook).toBe(fallbackHook);
  });

  it('maxTurns/deepThink：输入覆写优先于 config', () => {
    const assembly = makeAssembly();
    const ctx = createAgentContext(
      { agent_id: 'a', name: 'A', maxTurns: 10, deepThink: false },
      assembly,
      { maxTurns: 3, deepThink: true },
    );
    expect(ctx.maxTurns).toBe(3);
    expect(ctx.deepThink).toBe(true);
  });
});
