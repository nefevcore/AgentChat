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
  type AgentConfig, type AgentPlugin,
} from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { LLMProvider, LLMResponse } from '@agentchat/llm';
import { ChatStream } from '@agentchat/llm';
import {
  run, createContext,
  enqueue, followup, steer, inject, drainInbox, pushSteer,
} from '@agentchat/agent-loop';

/** 真实 ReAct 引擎（测试注入：assembly.engine 契约面） */
const engine = { run, createContext, enqueue, followup, steer, inject, drainInbox, pushSteer };

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
  it('持有 llm/presets/tools/hooks 设置 + 继承 deepThink/maxSteps + 命名空间配置', () => {
    const config: AgentConfig = {
      agent_id: 'a',
      name: 'A',
      virtual: false,
      tags: ['dev'],
      llm: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      presets: ['agentchat-fs-tools', 'agentchat-agent-session'],
      tools: { include: ['bash'], exclude: ['write'] },
      hooks: {
        runStart: ['agent-session.load-history'],
        runEnd: ['agent-session.save-session'],
      },
      deepThink: false,
      maxSteps: 5,
      'tool.bash': { defaultTimeout: 60000 },
      security: { allowedPaths: ['/tmp/scratch/'] },
    };
    expect(config.agent_id).toBe('a');
    expect(config.name).toBe('A');
    expect(config.llm).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(config.presets).toEqual(['agentchat-fs-tools', 'agentchat-agent-session']);
    expect(config.tools).toEqual({ include: ['bash'], exclude: ['write'] });
    expect(config.hooks?.runStart).toEqual(['agent-session.load-history']);
    // 继承自 CurrentContext 的字段
    expect(config.deepThink).toBe(false);
    expect(config.maxSteps).toBe(5);
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
    { name: 'a', tools: ['bash', 'read'], stepStart: ['a.pre'], fallback: ['a.fb'] },
    { name: 'b', tools: ['read', 'edit'], stepStart: ['b.pre'], toolExecutionStart: ['b.tx'] },
  ];

  it('collectToolNames：跨插件合并、去重、保序', () => {
    expect(collectToolNames(plugins)).toEqual(['bash', 'read', 'edit']);
    expect(collectToolNames(undefined)).toBeUndefined();
    expect(collectToolNames([])).toBeUndefined();
    expect(collectToolNames([{ name: 'x' }])).toBeUndefined();
  });

  it('collectHookNames：按五类分别合并、去重、保序', () => {
    const names = collectHookNames(plugins);
    expect(names.stepStart).toEqual(['a.pre', 'b.pre']);
    expect(names.toolExecutionStart).toEqual(['b.tx']);
    expect(names.fallback).toEqual(['a.fb']);
    expect(names.stepEnd).toBeUndefined();
    expect(collectHookNames(undefined)).toEqual({});
  });

  it('collectHookNames：旧 builtin.* 钩子名归一化为新契约名', () => {
    const names = collectHookNames([{
      name: 'builtin',
      runStart: ['builtin.load-history'],
      runEnd: ['builtin.save-session', 'builtin.log-usage'],
      toolExecutionStart: ['builtin.security-check'],
    }]);
    expect(names.runStart).toEqual(['agent-session.load-history']);
    expect(names.runEnd).toEqual(['agent-session.save-session', 'agent-session.log-usage']);
    expect(names.toolExecutionStart).toEqual(['security.security-check']);
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
    const toolConfigs: AgentConfig[] = [];
    const hookConfigs: AgentConfig[] = [];
    const calls: string[] = [];
    const assembly = makeAssembly({
      createLLM: () => llm,
      resolveTools: (cfg) => { toolConfigs.push(cfg); return tools; },
      resolveHooks: (cfg) => { hookConfigs.push(cfg); return {}; },
      loadHistory: (key) => { calls.push(key); return [{ role: 'agent', content: 'hi', agent_id: 'user' }]; },
      systemPrompt: (c) => `SP:${c.name}`,
    });

    const config: AgentConfig = {
      agent_id: 'a', name: 'A', llm: 'pool-ref',
      presets: ['agentchat-fs-tools'],
      tools: { include: ['bash'] },
      hooks: { stepStart: ['a.pre'] },
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
    expect(ctx.inbox).toEqual({ nextTurn: [], nextStep: [] });
    // resolveTools/resolveHooks 以 config 为单一意图来源（presets/tools/hooks 归一化在服务内完成）
    expect(toolConfigs).toEqual([config]);
    expect(hookConfigs).toEqual([config]);
    // 历史按 dialogId 加载
    expect(calls).toEqual(['user__a']);
  });

  it('旧 plugins 契约回退：无 presets/tools/hooks 时 config 原样传给装配实现', () => {
    const toolConfigs: AgentConfig[] = [];
    const hookConfigs: AgentConfig[] = [];
    const assembly = makeAssembly({
      resolveTools: (cfg) => { toolConfigs.push(cfg); return new Map(); },
      resolveHooks: (cfg) => { hookConfigs.push(cfg); return {}; },
    });
    const config: AgentConfig = {
      agent_id: 'a', name: 'A',
      plugins: [{ name: 'x', tools: ['bash'], stepStart: ['a.pre'] }],
    };
    createAgentContext(config, assembly);
    expect(toolConfigs).toEqual([config]);
    expect(hookConfigs).toEqual([config]);
  });

  it('无 dialogId：不加载历史；hooks 未提供时为 undefined（loop 容忍）', () => {
    const ctx = createAgentContext({ agent_id: 'a', name: 'A' }, makeAssembly());
    expect(ctx.history).toEqual([]);
    expect(ctx.currentMessage).toBeUndefined();
    expect(ctx.dialogId).toBeUndefined();
    expect(ctx.stepStartHook).toBeUndefined();
    expect(ctx.tools.size).toBe(1);
  });

  it('resolveHooks 注入五类钩子数组', () => {
    const stepStartHook = [async () => {}];
    const fallbackHook = [async () => {}];
    const assembly = makeAssembly({
      resolveHooks: () => ({ stepStartHook, fallbackHook }),
    });
    const ctx = createAgentContext({ agent_id: 'a', name: 'A' }, assembly);
    expect(ctx.stepStartHook).toBe(stepStartHook);
    expect(ctx.fallbackHook).toBe(fallbackHook);
  });

  it('maxSteps/deepThink：输入覆写优先于 config', () => {
    const assembly = makeAssembly();
    const ctx = createAgentContext(
      { agent_id: 'a', name: 'A', maxSteps: 10, deepThink: false },
      assembly,
      { maxSteps: 3, deepThink: true },
    );
    expect(ctx.maxSteps).toBe(3);
    expect(ctx.deepThink).toBe(true);
  });
});
