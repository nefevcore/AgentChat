// ============================================================
// per-Agent services 作用域测试（8/19 竞态修复）
//
// 病灶：旧「当前 Agent 约定」把 llm/tools 写进进程级共享 services
// （loader.makeAgentAssembly services.llm/tools），多 Agent 并发投递时
// 互相覆写——先烘焙的 list_tools（捕获共享引用）后执行时读到别人的
// 工具集（8/9 观察到 deloitte 125 个 ABAP 工具泄漏、8/19 本人 26 工具
// 缺失 4 个 admin 工具，均为同源）。
//
// 修复：按 agentId 建原型链作用域（scopeFor），单例服务读穿透共享层，
// llm/tools 各自独立写入。本测试验证：
//   1. B resolveTools 后，A 的 list_tools 仍显示 A 的工具集（不串读）
//   2. 共享 services 层不被 llm/tools 污染（旧代码会留下最后写入者的值）
//   3. agentId 缺省时保持旧共享行为（兼容通道）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Context } from '@agentchat/cordis';
import { LLMService } from '@agentchat/llm';
import type { LLMProvider, LLMConfig } from '@agentchat/llm';
import type { AgentConfig } from '@agentchat/agent-config';
import { registerCoreServices } from '../src/register-core';
import { makeAgentAssembly } from '../src/loader';

describe('per-Agent services 作用域（并发竞态修复）', () => {
  let tmp: string;
  let prevWs: string | undefined;
  let prevFactory: ((config: LLMConfig) => LLMProvider) | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
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

  const makeAssembly = (ctx: Context, services: Record<string, unknown>) =>
    makeAgentAssembly({
      getRouter: () => ({ emit: () => {} }) as never,
      services: services as never,
      globalConfig: { workspaceDir: tmp, agentsDir: path.join(tmp, 'agents'), timezone: 'Asia/Shanghai' },
      ctx,
    });

  const configA = {
    agent_id: 'a1',
    name: 'A',
    tags: ['base'],
    presets: ['agentchat-fs-tools', 'agentchat-agent-tools'],
    tools: { include: ['read'] },
  } as unknown as AgentConfig;

  const configB = {
    agent_id: 'b1',
    name: 'B',
    tags: ['base'],
    presets: ['agentchat-fs-tools', 'agentchat-agent-tools', 'agentchat-math'],
    tools: { include: ['read', 'math'] },
  } as unknown as AgentConfig;

  it('B resolveTools 后 A 的 list_tools 仍显示 A 的工具集（旧代码串读 B）', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const services: Record<string, unknown> = {};
    const assembly = makeAssembly(ctx, services);

    const toolsA = assembly.resolveTools(configA);   // A 烘焙（含 list_tools，捕获 A 作用域）
    const toolsB = assembly.resolveTools(configB);   // B 随后解析——旧代码此刻覆写共享 services.tools
    expect(toolsB.has('math')).toBe(true);

    const outA = await toolsA.get('list_tools')!.execute({});   // 迟到执行（竞态现场）
    expect(outA).not.toContain('- math');                       // A 无 math：不应串读 B 的工具集
    expect(outA).toContain('- read');

    const outB = await toolsB.get('list_tools')!.execute({});
    expect(outB).toContain('- math');                           // B 自己有 math
  });

  it('共享 services 层不被 llm/tools 污染（写入落在 per-Agent 作用域）', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const services: Record<string, unknown> = {};
    const assembly = makeAssembly(ctx, services);

    LLMService.factory = (c) => ({ model: `mock-${c.provider ?? 'x'}` } as unknown as LLMProvider);
    assembly.createLLM({ provider: 'openai' }, 'a1');
    assembly.createLLM({ provider: 'openai' }, 'b1');
    assembly.resolveTools(configA);
    assembly.resolveTools(configB);

    expect(services.llm).toBeUndefined();     // 旧代码 = 最后写入者的 LLM
    expect(services.tools).toBeUndefined();   // 旧代码 = 最后写入者的工具表
  });

  it('agentId 缺省时保持旧共享行为（兼容通道）', async () => {
    const ctx = new Context();
    await registerCoreServices(ctx);
    const services: Record<string, unknown> = {};
    const assembly = makeAssembly(ctx, services);

    LLMService.factory = (c) => ({ model: `mock-${c.provider ?? 'x'}` } as unknown as LLMProvider);
    assembly.createLLM({ provider: 'openai' });   // 无 agentId → 写共享层（旧语义）
    expect(services.llm).toBeDefined();

    const legacyConfig = { ...configB, agent_id: undefined } as unknown as AgentConfig;
    assembly.resolveTools(legacyConfig);           // 无 agent_id → 写共享层
    expect(services.tools).toBeDefined();
  });
});
