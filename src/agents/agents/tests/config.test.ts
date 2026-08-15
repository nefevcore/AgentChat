// ============================================================
// src/agents/config 单元测试 —— AgentConfig + createAgentContext
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  createAgentContext,
  type AgentAssembly,
} from '../src/config';
import {
  collectToolNames, collectHookNames, getNamespaceConfig,
  type AgentConfig, type AgentPlugin, type HookNames,
} from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { LLMProvider, LLMResponse } from '@agentchat/llm';
import { ChatStream } from '@agentchat/llm';
import { run, createContext, pushSteer } from '@agentchat/agent-loop';

/** 真实 ReAct 引擎（测试注入：assembly.engine 契约面） */
const engine = { run, createContext, pushSteer };

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
    engine,
    createLLM: () => makeMockLLM(),
    resolveTools: () => new Map([['t1', tool]]),
    loadHistory: () => [],
    systemPrompt: (c) => `SP:${c.name}`,
    ...overrides,
  };
}

describe('AgentConfig —— 以 CurrentContext 为基类的配置文件形态', () => {
  it('持有 llm/presets/tools/hooks 设置 + 继承 deepThink/maxTurns + 命名空间配置', () => {
    const config: AgentConfig = {
      agent_id: 'a',
      name: 'A',
      virtual: false,
      tags: ['dev'],
      llm: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      presets: ['agentchat-fs-tools', 'agentchat-agent-session'],
      tools: ['bash', 'read'],
      hooks: {
        runStart: ['agent-session.load-history'],
        runEnd: ['agent-session.save-session'],
      },
      deepThink: false,
      maxTurns: 5,
      'tool.bash': { defaultTimeout: 60000 },
      security: { allowedPaths: ['/tmp/scratch/'] },
    };
    expect(config.agent_id).toBe('a');
    expect(config.name).toBe('A');
    expect(config.llm).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(config.presets).toEqual(['agentchat-fs-tools', 'agentchat-agent-session']);
    expect(config.tools).toEqual(['bash', 'read']);
    expect(config.hooks?.runStart).toEqual(['agent-session.load-history']);
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

describe('旧插件聚合（迁移期兼容）', () => {
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
  it('把 config + 注入能力装配为可执行 CurrentContext（presets/tools/hooks 契约）', () => {
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
      presets: ['agentchat-fs-tools'],
      tools: ['bash'],
      hooks: { turnStart: ['a.pre'] },
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
    // 显式工具名直接传给 resolveTools（presets 过滤在 ToolsService 内完成）
    expect(toolNames).toEqual([['bash']]);
    // 顶层 hooks 顺序表传给 resolveHooks
    expect(hookNames.length).toBe(1);
    expect(hookNames[0].turnStart).toEqual(['a.pre']);
    // 历史按 dialogId 加载
    expect(calls).toEqual(['user__a']);
  });

  it('旧 plugins 契约回退：无 presets/tools/hooks 时按旧聚合传入', () => {
    const toolNames: Array<string[] | undefined> = [];
    const hookNames: HookNames[] = [];
    const assembly = makeAssembly({
      resolveTools: (names) => { toolNames.push(names); return new Map(); },
      resolveHooks: (names) => { hookNames.push(names); return {}; },
    });
    const config: AgentConfig = {
      agent_id: 'a', name: 'A',
      plugins: [{ name: 'x', tools: ['bash'], turnStart: ['a.pre'] }],
    };
    createAgentContext(config, assembly);
    expect(toolNames).toEqual([['bash']]);
    expect(hookNames[0]?.turnStart).toEqual(['a.pre']);
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
