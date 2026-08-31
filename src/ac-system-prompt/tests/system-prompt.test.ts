// ============================================================
// ac-system-prompt/tests/system-prompt.test.ts —— 分块装配器（M14）
//
// · 默认/自定义框架块追加到既有 system 之后（向后兼容面）
// · 系统环境块（settings['security'].workdir/allowedPaths + workspace 根）
// · 术语约定/指引/后台任务块：工具门控读 request.tools
// · 对话信息块：信封 sender/conversationId + 群场景（可选 ctx.group）
// · settings['system-prompt']：enabled/framework/guidelines/systemEnv/
//   conversationPartner/override
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as systemPromptRow from '../src/index';
import * as toolsRow from 'ac-tools';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

interface BootOptions {
  /** 额外行（group/workspace 等按需注入） */
  extraRows?: unknown[];
  /** system-prompt 行配置 */
  config?: Record<string, unknown>;
  /** 预注册 Agent */
  agent?: Record<string, unknown>;
}

async function boot(opts: BootOptions = {}) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    ...(opts.agent ? [agentsRow] : []),
    loopRow,
    ...(opts.extraRows ?? []),
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  const fiber =
    opts.config === undefined
      ? ctx.plugin(systemPromptRow)
      : ctx.plugin(systemPromptRow, opts.config);
  await fiber;
  fibers.push(fiber);
  if (opts.agent) ctx.agents.register(opts.agent as any);
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

const USER = [{ role: 'user' as const, content: 'hi' }];

describe('ac-system-prompt 框架块（向后兼容面）', () => {
  it('默认框架块 + 系统环境块追加到既有 system 之后', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ model: 'mock-1', system: 'BASE', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('BASE\n\n你是 AgentChat')).toBe(true);
    expect(content).toContain('AgentChat');
    expect(content).toContain('## 系统环境');
    // 无信封（loop 直连）→ 无对话信息块
    expect(content).not.toContain('## 对话信息');
  });

  it('无 system 时框架块自成 system 开头（无标签包裹）', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('你是 AgentChat')).toBe(true);
    expect(content).not.toContain('<framework>');
  });

  it('Config.framework 自定义框架块（行级缺省）', async () => {
    const { ctx } = await boot({ config: { framework: '自定义框架指令' } });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('自定义框架指令\n\n## 系统环境')).toBe(true);
  });

  it("settings['system-prompt'].framework per-Agent 覆盖行缺省", async () => {
    const { ctx } = await boot({
      config: { framework: '行级框架' },
      agent: { id: 'a1', model: 'mock-1', settings: { 'system-prompt': { framework: 'Agent 级框架' } } },
    });
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('Agent 级框架')).toBe(true);
    expect(content).not.toContain('行级框架');
  });

  it("settings['system-prompt'].enabled=false → 软停用（零注入）", async () => {
    const { ctx } = await boot({
      agent: { id: 'a2', model: 'mock-1', settings: { 'system-prompt': { enabled: false } } },
    });
    await ctx.agentLoop.run({ agent: 'a2', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});

describe('ac-system-prompt 工具门控（读 request.tools）', () => {
  it('协作工具在场 → 术语约定 + 协作指引；bash/job → 后台任务块', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({
      model: 'mock-1',
      tools: ['send_agent', 'list_agents', 'read', 'write', 'edit', 'bash'],
      messages: USER,
    });
    const content = String(captured[0].messages[0].content);
    expect(content).toContain('## 术语约定');
    expect(content).toContain('## 指引');
    expect(content).toContain('多Agent协作');
    expect(content).toContain('文件操作');
    expect(content).toContain('## 后台任务');
    // 块序：术语约定在指引前（静态在前）
    expect(content.indexOf('## 术语约定')).toBeLessThan(content.indexOf('## 指引'));
  });

  it('非协作小工具集 → 术语约定/指引/后台任务全不注入', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ model: 'mock-1', tools: ['math'], messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content).not.toContain('## 术语约定');
    expect(content).not.toContain('## 指引');
    expect(content).not.toContain('## 后台任务');
  });

  it("request.tools 缺省 → 门控回退到全部已注册工具", async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'send_agent',
      description: 'x',
      async execute() {
        return { ok: true, output: '' };
      },
    });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content).toContain('## 术语约定');
  });

  it("settings['system-prompt'].guidelines=false → 只关指引块", async () => {
    const { ctx } = await boot({
      agent: { id: 'a3', model: 'mock-1', settings: { 'system-prompt': { guidelines: false } } },
    });
    await ctx.agentLoop.run({
      agent: 'a3',
      model: 'mock-1',
      tools: ['send_agent', 'list_agents', 'read', 'write', 'edit'],
      messages: USER,
    });
    const content = String(captured[0].messages[0].content);
    expect(content).toContain('## 术语约定');
    expect(content).not.toContain('## 指引');
  });
});

describe('ac-system-prompt 对话信息块（信封）', () => {
  it('sender=user → 当前对话对象 = viewer（注册表显示名；src 格式；动态块在最后）', async () => {
    const { ctx } = await boot({ agent: { id: 'user', virtual: true, description: '用户' } });
    await ctx.agentLoop.run({
      model: 'mock-1',
      sender: 'user',
      source: 'user',
      conversationId: 'c-1',
      messages: USER,
    });
    const content = String(captured[0].messages[0].content);
    expect(content).toContain('## 对话信息');
    expect(content).toContain('[当前对话对象] user - 用户');
    // 动态块在最后（KV cache：静态前缀稳定）
    expect(content.lastIndexOf('## 对话信息')).toBeGreaterThan(content.indexOf('## 系统环境'));
  });

  it('user 虚拟端点配置了显示名（如"风栗"）→ 对话对象行如实展示（M18 #4）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      sender: 'user',
      conversationId: 'neko',
      labelOf: (id) => (id === 'user' ? '风栗' : id),
    });
    expect(blocks.join('\n\n')).toContain('[当前对话对象] user - 风栗');
  });

  it('Agent 专用空间缺省：工作目录 = files/<agentId>（M18 #3；显式 security.workdir 仍最优先）', () => {
    // 缺省：files/<id>（相对工作区根展示 + 附绝对路径）
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      agentWorkdir: 'C:/ws/files/neko',
      wsRoot: 'C:/ws',
    });
    const content = blocks.join('\n\n');
    expect(content).toContain('[工作目录] ./files/neko（C:/ws/files/neko）');
    // 显式 workdir 覆盖专用空间
    const explicit = systemPromptRow.assembleBlocks({
      toolNames: [],
      security: { workdir: 'C:/mounted' },
      agentWorkdir: 'C:/ws/files/neko',
      wsRoot: 'C:/ws',
    });
    expect(explicit.join('\n\n')).toContain('[工作目录] C:/mounted');
    // 预设 Agent（agentWorkdir = 工作区根）：回落根展示
    const preset = systemPromptRow.assembleBlocks({
      toolNames: [],
      agentWorkdir: 'C:/ws',
      wsRoot: 'C:/ws',
    });
    expect(preset.join('\n\n')).toContain('[工作目录] C:/ws');
  });

  it('sender=委托方 Agent id + source=agent → 当前对话对象 = 委托方（M19 身份修复）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      sender: 'writer',
      source: 'agent',
      conversationId: 'writer~responder',
      labelOf: (id) => (id === 'writer' ? '写作助手' : id),
    });
    const content = blocks.join('\n\n');
    expect(content).toContain('[当前对话对象] writer - 写作助手');
  });

  it('sender=目标自身 + source=event → 当前对话对象 = 自己（D2 机制触发·自会话）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      sender: 'watchdog',
      source: 'event',
      conversationId: 'watchdog~watchdog',
    });
    expect(blocks.join('\n\n')).toContain('[当前对话对象] watchdog - watchdog（机制触发·自会话）');
  });

  it('conversationId 命中群 → 群成员表（assembleBlocks 纯函数；apply 侧经可选 ctx.group 解析）', async () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: ['send_group', 'list_groups'],
      sender: 'g1',
      source: 'agent',
      conversationId: 'team',
      group: { name: '项目组', members: ['g1', 'g2'], description: '协作群' },
    });
    const content = blocks.join('\n\n');
    expect(content).toContain('[当前群聊] 项目组（team）');
    expect(content).toContain('[群聊成员] g1、g2');
    expect(content).toContain('[群聊简介] 协作群');
    expect(content).toContain('[当前对话对象] g1 - g1');
    // 群聊协作指引 + 对话信息块在最后（动态块收尾）
    expect(content.lastIndexOf('## 对话信息')).toBeGreaterThan(content.indexOf('## 指引'));
  });

  it('信封全空（子 Agent / loop 直连）→ 无对话信息块（assembleBlocks）', () => {
    const blocks = systemPromptRow.assembleBlocks({ toolNames: ['math'] });
    expect(blocks.join('\n\n')).not.toContain('## 对话信息');
  });

  it('workspace 根 + workdir 相对展示（附绝对路径）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      security: { workdir: 'C:/ws/files/a1', allowedPaths: ['./shared'] },
      wsRoot: 'C:/ws',
    });
    const content = blocks.join('\n\n');
    expect(content).toContain('[工作目录] ./files/a1（');
    expect(content).toContain('C:/ws/files/a1');
    expect(content).toContain('[路径穿透白名单] C:\\ws\\shared');
  });

  it('无 workdir 挂载 → 工作目录 = 工作区根（绝对路径具体展示）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      wsRoot: 'C:/ws',
    });
    const content = blocks.join('\n\n');
    expect(content).toContain(`[工作目录] C:/ws`);
    expect(content).not.toContain('工作区根）');
  });

  it("settings['system-prompt'].conversationPartner=false → 不注入对话信息块", async () => {
    const { ctx } = await boot({
      agent: { id: 'a4', model: 'mock-1', settings: { 'system-prompt': { conversationPartner: false } } },
    });
    await ctx.agentLoop.run({
      agent: 'a4',
      model: 'mock-1',
      sender: 'user',
      conversationId: 'c-2',
      messages: USER,
    });
    expect(String(captured[0].messages[0].content)).not.toContain('## 对话信息');
  });
});

describe('ac-system-prompt override（SYSTEM.md 覆盖语义）', () => {
  it('override 替换全部静态块；对话信息块仍追加', async () => {
    const { ctx } = await boot({
      agent: {
        id: 'a5',
        model: 'mock-1',
        settings: { 'system-prompt': { override: '完全自定义的静态提示词' } },
      },
    });
    await ctx.agentLoop.run({
      agent: 'a5',
      model: 'mock-1',
      sender: 'user',
      conversationId: 'c-3',
      tools: ['send_agent'],
      messages: USER,
    });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('完全自定义的静态提示词')).toBe(true);
    expect(content).not.toContain('<framework>');
    expect(content).not.toContain('## 系统环境');
    expect(content).not.toContain('## 术语约定');
    expect(content).toContain('## 对话信息'); // 动态信息不丢
  });

  it("settings['security'].workdir/allowedPaths → 环境块展示", async () => {
    const { ctx } = await boot({
      agent: {
        id: 'a6',
        model: 'mock-1',
        settings: { security: { workdir: './files/a6', allowedPaths: ['./shared'] } },
      },
    });
    await ctx.agentLoop.run({ agent: 'a6', model: 'mock-1', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content).toContain('[工作目录] ./files/a6');
    expect(content).toContain('[路径穿透白名单]');
    expect(content).toContain('shared');
  });
});
