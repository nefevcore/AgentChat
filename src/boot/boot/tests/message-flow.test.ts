// ============================================================
// 消息流端到端测试（全面 cordis 化 P3.3）
//
// 验证"ctx 服务 → AgentAssembly → createAgentContext"完整装配链路，
// 以及钩子（save-session）与工具（read/write/edit tag 注入）经 ctx 服务生效。
// （loop.run 的执行语义已由 @agentchat/agent-loop 的 34 个测试覆盖。）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Context } from '@agentchat/cordis';
import { LLMService, ChatStream } from '@agentchat/llm';
import type { LLMProvider, LLMConfig } from '@agentchat/llm';
import { createAgentContext } from '@agentchat/agents';
import type { AgentConfig } from '@agentchat/agent-config';
import { run } from '@agentchat/agent-loop';
import type { CurrentContext } from '@agentchat/agent-loop';
import { registerCoreServices } from '../src/register-core';
import { makeAgentAssembly } from '../src/loader';

describe('消息流端到端（ctx 服务链路）', () => {
  let tmp: string;
  let prevWs: string | undefined;
  let prevFactory: ((config: LLMConfig) => LLMProvider) | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
    prevWs = process.env.AGENTCHAT_WORKSPACE;
    process.env.AGENTCHAT_WORKSPACE = tmp;
    prevFactory = LLMService.factory;
  });

  afterEach(() => {
    if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
    else process.env.AGENTCHAT_WORKSPACE = prevWs;
    LLMService.factory = prevFactory;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const makeConfig = (): AgentConfig => ({
    agent_id: 't1',
    name: '测试',
    tags: ['dev'],
    presets: [
      'agentchat-fs-tools',
      'agentchat-hooks',
      'agentchat-agent-session',
    ],
    tools: ['read', 'write'],
    hooks: {
      runStart: ['agent-session.load-history'],
      runEnd: ['agent-session.save-session'],
    },
  } as AgentConfig);

  const makeAssembly = (ctx: Context) => {
    const services: Record<string, unknown> = {};
    const globalConfig = { workspaceDir: tmp, agentsDir: path.join(tmp, 'agents'), timezone: 'Asia/Shanghai' };
    return makeAgentAssembly({
      getRouter: () => ({ emit: () => {} }) as never,
      services: services as never,
      globalConfig,
      ctx,
    });
  };

  it('核心服务注册：ctx.llm / ctx.tools / ctx.hooks', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    expect(ctx.llm).toBeDefined();
    expect(ctx.tools).toBeDefined();
    expect(ctx.hooks).toBeDefined();
    // 能力插件已挂载：钩子目录非空、工具工厂可解析
    expect(ctx.hooks.listNames('runStart')).toContain('agent-session.load-history');
    expect(ctx.hooks.listNames('runEnd')).toContain('agent-session.save-session');
  });

  it('工具 tag 注入：ctx.tools.resolveTools 返回 read/write/edit（requires: base 命中）', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const config = makeConfig();
    const tools = ctx.tools.resolveTools(['read', 'write'], config, {});
    expect([...tools.keys()]).toEqual(expect.arrayContaining(['read', 'write', 'edit']));
    expect(tools.get('read')?.name).toBe('read');
    expect(tools.get('edit')?.name).toBe('edit');
  });

  it('钩子收集：ctx.hooks.collect 按 Agent 配置烘焙 runStart/runEnd 数组', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const config = makeConfig();
    const hooks = ctx.hooks.collect({ runStart: ['agent-session.load-history'], runEnd: ['agent-session.save-session'] }, config, {});
    // automatic 基础设施钩子追加在显式 load-history 之后：
    //   agent-session: recover-history + group-contract
    //   来源标签契约（各域自带，@agentchat/contracts 工厂）:
    //     hooks(system) + timer + subagent + agent-tools(agent+group) + restart = 6
    expect(hooks.runStartHook).toHaveLength(9);
    expect(hooks.runEndHook).toHaveLength(1);
  });

  it('LLM 工厂经 ctx.llm：LLMService.factory 注入 mock 生效', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const mock: LLMProvider = {
      model: 'mock',
      async chat() { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
      stream() { throw new Error('unused'); },
      toProviderMessages: (m) => m as never,
      fromProviderMessages: (m) => m as never,
    };
    LLMService.factory = () => mock;
    const assembly = makeAssembly(ctx);
    expect(assembly.createLLM({ provider: 'deepseek' })).toBe(mock);
  });

  it('装配链路：createAgentContext 产出含注入工具与钩子的 CurrentContext', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const config = makeConfig();
    const assembly = makeAssembly(ctx);
    const current: CurrentContext = createAgentContext(config, assembly, {
      currentMessage: { role: 'user', content: 'hello' },
      dialogId: 'chat~t1~user',
    });
    // 工具经 ctx.tools 注入
    expect(current.tools.has('read')).toBe(true);
    expect(current.tools.has('write')).toBe(true);
    expect(current.tools.has('edit')).toBe(true);
    // 钩子经 ctx.hooks 收集（清单 load-history + automatic 8 个：
    // recover-history/group-contract + 6 个来源标签契约钩子）
    expect(current.runStartHook).toHaveLength(9);
    expect(current.runEndHook).toHaveLength(1);
  });

  it('runEnd 钩子执行：save-session 落盘会话文件', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const config = makeConfig();
    const assembly = makeAssembly(ctx);
    const current: CurrentContext = createAgentContext(config, assembly, {
      currentMessage: { role: 'user', content: '你好' },
      dialogId: 'chat~t1~user',
    });
    const result = {
      content: '回复内容',
      interrupted: false,
      messages: [
        { role: 'user', content: '你好', message_id: 'm1' },
        { role: 'agent', content: '回复内容', message_id: 'm2', agent_id: 't1' },
      ],
    };
    for (const hook of current.runEndHook ?? []) {
      await hook(current, result as never);
    }
    // 会话文件落盘（<ws>/sessions/chat~t1~user/messages.jsonl）
    const sessionFile = path.join(tmp, 'sessions', 'chat~t1~user', 'messages.jsonl');
    expect(fs.existsSync(sessionFile)).toBe(true);
    const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[1]!).content).toBe('回复内容');
  });

  it('旧 plugins 契约兼容：builtin.save-session 别名仍命中 save-session 并落盘', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const legacyConfig = {
      agent_id: 't1',
      name: '测试',
      plugins: [{ name: 'builtin', runEnd: ['builtin.save-session'] }],
    } as AgentConfig;
    const assembly = makeAssembly(ctx);
    const current = createAgentContext(legacyConfig, assembly, {
      currentMessage: { role: 'user', content: '你好' },
      dialogId: 'chat~t1~user',
    });

    // 旧钩子名经兼容映射后解析到 agent-session.save-session
    expect(current.runEndHook).toHaveLength(1);
    await current.runEndHook![0]!(current, {
      content: '回复内容',
      interrupted: false,
      messages: [
        { role: 'user', content: '你好', message_id: 'm1' },
        { role: 'agent', content: '回复内容', message_id: 'm2', agent_id: 't1' },
      ],
    } as never);

    const sessionFile = path.join(tmp, 'sessions', 'chat~t1~user', 'messages.jsonl');
    expect(fs.existsSync(sessionFile)).toBe(true);
    const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[1]!).content).toBe('回复内容');
  });

  it('完整链路（经 ctx 服务装配后）—— 默认走注册表分发（无静态 factory 注入）', async () => {
    // 回归保护：默认 factory 未被测试污染
    expect(LLMService.factory).toBeUndefined();
    const ctx = new Context();
    await registerCoreServices(ctx);
    expect(ctx.llm.create).toBeDefined();
    // 适配器插件行已注册：openai/default 可创建实例
    expect(ctx.llm.create({ provider: 'openai', api_key: 'sk-test', model: 'gpt-4o' }).model).toBe('gpt-4o');
  });

  it('完整 ReAct 会话：read 工具执行 + 多步 + 会话落盘（端到端）', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);

    const file = path.join(tmp, 'hello.txt');
    fs.writeFileSync(file, 'hello world');

    // mock LLM（loop 从 stream result() 读 toolCalls）：第 1 轮 read，第 2 轮最终回复
    const mock = makeMockLLM((_req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'hello.txt' } }], finishReason: 'tool_calls' };
      }
      return { content: '文件内容：hello world', toolCalls: [], finishReason: 'stop' };
    });
    LLMService.factory = () => mock;

    const config = makeConfig();
    const assembly = makeAssembly(ctx);
    const current = createAgentContext(config, assembly, {
      currentMessage: { role: 'user', content: 'read hello.txt' },
      dialogId: 'chat~t1~user',
    });

    const result = await run(current);

    // ReAct 多步：最终回复包含 read 工具结果
    expect(result.content).toContain('hello world');
    // 工具调用消息存在（tool 角色 + read 结果）
    const toolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'read');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg?.content)).toContain('hello world');
    // runEnd 钩子（save-session）随 run 完成落盘
    const sessionFile = path.join(tmp, 'sessions', 'chat~t1~user', 'messages.jsonl');
    expect(fs.existsSync(sessionFile)).toBe(true);
    const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
    expect(lines.some((l) => l.includes('hello world'))).toBe(true);
  });
});

/** mock LLM（参考 @agentchat/agent-loop 测试的 makeMockLLM：loop 从 stream result() 读 toolCalls） */
function makeMockLLM(
  handler: (req: unknown, callIndex: number) => { content: string; toolCalls: unknown[]; finishReason: string; reasoning?: string },
): LLMProvider {
  let callIndex = 0;
  return {
    model: 'mock-model',
    async chat(req) {
      const resp = await handler(req, callIndex);
      callIndex++;
      return resp as never;
    },
    stream(req) {
      const cs = new ChatStream();
      void (async () => {
        const resp = await handler(req, callIndex);
        callIndex++;
        if (resp.content) {
          cs.push({ type: 'message_start', partial: { content: '', reasoning: '' } });
          cs.push({ type: 'message_update', delta: resp.content, partial: { content: resp.content, reasoning: resp.reasoning ?? '' } });
          cs.push({ type: 'message_end', partial: { content: resp.content, reasoning: resp.reasoning ?? '' } });
        }
        cs.done(resp as never);
      })().catch((err) => cs.error({ content: null, toolCalls: [], finishReason: 'error' }, String(err)));
      return cs;
    },
    toProviderMessages: (msgs) => msgs as never,
    fromProviderMessages: (msgs) => msgs as never,
  };
}
