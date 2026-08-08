// ============================================================
// L2 ↔ L3 装配链路集成测试
//
// 验证：PluginRegistry（L3 真实插件）→ AgentAssembly → createAgentContext
//       → AgentRouter（L2）→ loop（L1）→ 真实工具执行，整条链路打通。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PluginRegistry } from '../src/plugins/registry';
import builtinPlugin from '../src/plugins/builtin';
import mathPlugin from '../src/plugins/builtin-math';
import { createAgentContext, AgentRouter } from '../src/agents/index';
import type { AgentAssembly, AgentConfig } from '../src/agents/config';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/types';
import { ChatStream } from '../src/core/llm/chat-stream';

let ws = '';
beforeEach(() => {
  ws = path.join(os.tmpdir(), `agentchat-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(ws, { recursive: true });
  process.env.AGENTCHAT_WORKSPACE = ws;
});
afterEach(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
});

const stop = (content: string): LLMResponse => ({ content, toolCalls: [], finishReason: 'stop' });

function makeLLM(handler: (req: LLMRequest, i: number) => LLMResponse | Promise<LLMResponse>): LLMProvider {
  let i = 0;
  return {
    model: 'mock-model',
    chat: async (req) => { const r = await handler(req, i); i++; return r; },
    stream: (req) => {
      const cs = new ChatStream();
      void (async () => { const r = await handler(req, i); i++; cs.done(r); })()
        .catch((err) => cs.error({ content: null, toolCalls: [], finishReason: 'error' }, String(err)));
      return cs;
    },
    toProviderMessages: (m) => m as any[],
    fromProviderMessages: (m) => m as any[],
  };
}

function makeAssembly(registry: PluginRegistry, llm: LLMProvider): AgentAssembly {
  return {
    createLLM: () => llm,
    resolveTools: (names, config) => registry.resolveTools(names, config),
    resolveHooks: (names, config) => registry.resolveHooks(names, config),
    loadHistory: () => [],
  };
}

describe('L2 ↔ L3 装配链路', () => {
  it('createAgentContext 用真实插件装配（工具按名 + 钩子按名）', () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    registry.register(mathPlugin);
    const assembly = makeAssembly(registry, makeLLM(() => stop('ok')));

    const config: AgentConfig = {
      agent_id: 'a', name: 'A',
      plugins: [
        { name: 'builtin', tools: ['read', 'write'], runEnd: ['builtin.save-session', 'builtin.update-memory'] },
        { name: 'builtin-math', tools: ['math'] },
      ],
    };
    const ctx = createAgentContext(config, assembly, { dialogId: 'user__a' });

    expect(ctx.tools.get('read')).toBeDefined();
    expect(ctx.tools.get('write')).toBeDefined();
    expect(ctx.tools.get('math')).toBeDefined();
    // requires:['agent'] 自动注入（对齐旧 v0.4.5 语义：基础+协作工具无需显式声明）
    expect(ctx.tools.get('bash')).toBeDefined();
    expect(ctx.tools.get('send_agent')).toBeDefined();
    // dev 工具不满足（无 dev 标签）→ 不注入
    expect(ctx.tools.get('browser')).toBeUndefined();
    expect(ctx.runEndHook).toHaveLength(2);
    expect(ctx.turnStartHook?.length ?? 0).toBe(0); // inject-time/inject-tools 已移除
  });

  it('runStart 钩子工厂：build-system-prompt / load-history 按 Agent 烘焙并可执行', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const assembly = makeAssembly(registry, makeLLM(() => stop('ok')));

    const config: AgentConfig = {
      agent_id: 'agentA', name: 'A',
      plugins: [{ name: 'builtin', runStart: ['builtin.build-system-prompt', 'builtin.load-history'] }],
    };
    const ctx = createAgentContext(config, assembly, { dialogId: 'user__agentA' });

    // 工厂烘焙：runStart 钩子已解析（按声明顺序）
    expect(ctx.runStartHook).toHaveLength(2);

    // 按名定位：build-system-prompt 在第一个，load-history 在第二个
    const buildPrompt = ctx.runStartHook![0];
    const loadHist = ctx.runStartHook![1];

    // build-system-prompt：装配完整 system prompt（含 系统环境/标签约定 等）
    await buildPrompt(ctx);
    expect(ctx.systemPrompt).toContain('## 系统环境');
    expect(ctx.systemPrompt).toContain('## 标签约定');
    expect(ctx.systemPrompt).toContain('## 对话信息');

    // load-history：历史已由装配层加载（空）→ 钩子不重复；新会话无文件
    await loadHist(ctx);
    expect(ctx.history).toEqual([]);
  });

  it('runStart build-system-prompt：群组模式注入群聊成员上下文', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const assembly = makeAssembly(registry, makeLLM(() => stop('ok')));

    const config: AgentConfig = {
      agent_id: 'agentA', name: 'A',
      plugins: [{ name: 'builtin', runStart: ['builtin.build-system-prompt'] }],
    };
    const ctx = createAgentContext(config, assembly, { dialogId: 'group~g1~agentA' });
    await ctx.runStartHook![0](ctx);
    expect(ctx.systemPrompt).toContain('[当前群聊] g1');
  });

  it('router + 真实插件：LLM 调 read 工具真实执行并读回文件', async () => {
    fs.writeFileSync(path.join(ws, 'data.txt'), '集成测试内容', 'utf-8');

    const registry = new PluginRegistry();
    registry.register(builtinPlugin);

    const llm = makeLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'data.txt' } }], finishReason: 'tool_calls' as const };
      }
      // 第二轮：断言工具真实执行并返回了文件内容
      expect(req.messages.some(m => m.role === 'tool' && m.content === '集成测试内容')).toBe(true);
      return stop('读到了');
    });

    const r = new AgentRouter(makeAssembly(registry, llm));
    r.getRegistry().register({
      agent_id: 'agentA', name: 'A',
      plugins: [{ name: 'builtin', tools: ['read'] }],
    });

    const resp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '读一下 data.txt' });
    expect(resp).toBe('读到了');
  });

  it('越界工具调用：沙箱拒绝，错误作为 tool 结果返回给 LLM，循环继续', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);

    const llm = makeLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '../escape.txt' } }], finishReason: 'tool_calls' as const };
      }
      // 第二轮：断言工具结果含越界错误
      expect(req.messages.some(m => m.role === 'tool' && String(m.content).includes('越界'))).toBe(true);
      return stop('已处理越界');
    });

    const r = new AgentRouter(makeAssembly(registry, llm));
    r.getRegistry().register({
      agent_id: 'agentA', name: 'A',
      plugins: [{ name: 'builtin', tools: ['read'] }],
    });

    const resp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '读越界文件' });
    expect(resp).toBe('已处理越界');
  });

  it('B 类工具经 PluginServices.router 工作（send_agent 身份烘焙 / list_*）', async () => {
    // 装配环：registry → assembly → router → registry.setServices({ router })
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);

    let received: any;
    const llm = makeLLM((req, i) => {
      if (i === 0) received = req.messages; // B 的 run（send_agent 投递触发）
      return stop('ok');
    });
    const router = new AgentRouter(makeAssembly(registry, llm));
    router.getRegistry().register({ agent_id: 'agentA', name: 'Agent A' });
    router.getRegistry().register({ agent_id: 'agentB', name: 'Agent B' });
    router.getGroupManager().createGroup({ group_id: 'g1', name: 'G', participants: ['agentA', 'agentB'] });
    registry.setServices({ router });

    const cfgA: AgentConfig = { agent_id: 'agentA', name: 'Agent A', plugins: [{ name: 'builtin', tools: ['send_agent', 'list_tools'] }] };
    const tools = registry.resolveTools(['send_agent', 'list_agents', 'list_groups', 'list_tools'], cfgA);

    // send_agent：投递给 B，from=agentA（工厂烘焙身份）
    const r1 = await tools.get('send_agent')!.execute({ to: 'agentB', message: '你好 B' });
    expect(String(r1)).toContain('已异步投递');
    await new Promise(res => setTimeout(res, 20));
    expect(received?.some((m: any) => m.role === 'user' && m.agent_id === 'agentA' && m.content === '你好 B')).toBe(true);

    // list_agents / list_groups / list_tools
    const r2 = await tools.get('list_agents')!.execute({});
    expect(String(r2)).toContain('agentA');
    expect(String(r2)).toContain('agentB');
    const r3 = await tools.get('list_groups')!.execute({});
    expect(String(r3)).toContain('g1');
    const r4 = await tools.get('list_tools')!.execute({});
    expect(String(r4)).toContain('send_agent');
    expect(String(r4)).toContain('list_tools');
  });
});
