// ============================================================
// ac-system-prompt/tests/system-prompt.test.ts —— 分块装配器（v3）
//
// · 静态块装配（framework 块已退役 2026-09-02：系统环境为首块）
// · 系统环境块（settings['security'].workdir/allowedPaths + workspace 根）
// · 术语约定/指引块：工具门控读 request.tools（指引为条目级门控）
// · 指引条目基线：三档工具集 + 单工具门控，**条目整段措辞锁定**
//   （改措辞 = 显式改这里——防渐进膨胀，audit 教训）
// · 对话信息块：信封 sender/conversationId + 群场景（可选 ctx.group）
// · settings['system-prompt']：enabled/guidelines/systemEnv/
//   conversationPartner/override
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
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
  /** 预注册 Agent */
  agent?: Record<string, unknown>;
  /** mock provider 注册 meta 附加键（visionModels 等能力元数据） */
  providerMeta?: Record<string, unknown>;
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
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'], ...(opts.providerMeta ?? {}) });
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
  const fiber = ctx.plugin(systemPromptRow);
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

describe('ac-system-prompt 静态块装配（v3：framework 已退役）', () => {
  it('系统环境块为首个静态块，追加到既有 system 之后', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ model: 'mock-1', system: 'BASE', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('BASE\n\n## 系统环境')).toBe(true);
    // framework 块退役回归锚（2026-09-02 用户裁决）
    expect(content).not.toContain('你是 AgentChat');
    expect(content).not.toContain('<framework>');
    // 无信封（loop 直连）→ 无对话信息块
    expect(content).not.toContain('## 对话信息');
  });

  it('无 system 时系统环境块自成 system 开头', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content.startsWith('## 系统环境')).toBe(true);
  });

  it('模型能力行（多模态防幻觉）：视觉模型注入"支持图片输入"，注册面无元数据则零注入', async () => {
    // ① 视觉模型（注册 meta visionModels 命中）→ 注入能力行（措辞锁定）
    const v = await boot({ providerMeta: { visionModels: ['mock-1'] } });
    await v.ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    const vc = String(captured[0].messages[0].content);
    expect(vc).toContain('[模型能力] 当前对话模型 mock-1 支持图片输入（多模态）');
    expect(vc).toContain('不要声称无法查看图片');

    // ② 纯文本模型（清单在场但不命中）→ 注入"纯文本"行（含如实说明边界）
    const t = await boot({ providerMeta: { visionModels: ['other-v'] } });
    await t.ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    const tc = String(captured[0].messages[0].content);
    expect(tc).toContain('[模型能力] 当前对话模型 mock-1 为纯文本模型');
    expect(tc).toContain('不要猜测或虚构图片');

    // ③ 注册面无能力元数据（未声明 visionModels）→ 不注入（零噪音）
    const b = await boot();
    await b.ctx.agentLoop.run({ model: 'mock-1', messages: USER });
    expect(String(captured[0].messages[0].content)).not.toContain('[模型能力]');
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
  it('协作工具在场 → 术语约定 + 指引（含命令执行/后台任务条目）', async () => {
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
    expect(content).toContain('命令执行');
    expect(content).toContain('后台任务');
    // v3：独立"后台任务"块并入指引（条目），块标题不再出现
    expect(content).not.toContain('## 后台任务');
    // 块序：术语约定在指引前（静态在前）
    expect(content.indexOf('## 术语约定')).toBeLessThan(content.indexOf('## 指引'));
  });

  it('非协作小工具集 → 术语约定/指引全不注入', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ model: 'mock-1', tools: ['math'], messages: USER });
    const content = String(captured[0].messages[0].content);
    expect(content).not.toContain('## 术语约定');
    expect(content).not.toContain('## 指引');
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

// ============================================================
// 指引条目基线（v3）：条目文本与 src/index.ts 逐字对齐——改措辞
// 必须显式改这里（防"顺手加一句"的渐进膨胀；audit 曾发现 20% 冗余）
// ============================================================

const E_FILE = '文件操作：改现有文件用 edit，old_string 从 read 的输出中原样复制（自拟文本会匹配失败）；同一文件有多处独立修改时，并行发多个 edit 调用。write 是整文件覆盖，只用于新建文件。找文件用 glob，搜内容用 grep；不确定文件位置时先用 glob 确认，不要凭记忆拼路径。bash 只做文件工具办不到的事（组合命令、进程、环境）。';
const E_FILE_NOEDIT = '文件操作：edit 不可用，修改文件需先 read 再用 write 写入完整内容。';
const E_CMD = '命令执行：命令以非零退出码结束时，先读输出定位原因，修正后再继续（原样重跑大概率再次失败）；被中断的命令按已终止处理，不代表命令本身有错。长输出会被截断，需要完整输出时先重定向到文件再 read。';
const E_JOB = '后台任务：后台命令会返回 job_id，记住 id，任务完成时会收到通知，不要用 job list 忙轮询；确需等待完成时，用前台 bash 配合较长 timeout 更直接。给出最终回答前，先收集仍在运行的相关任务的结果；不再重要的任务用 job kill 及时清理，避免占用并发额度。';
const E_OUT = '产出物引用：创建或修改文件后，最终回复中简要列出主要产出文件，路径用 markdown 行内代码格式；只说"已修改"而不给路径，用户无法定位文件。';
const E_AGENTS = '多Agent协作：先 list_agents 找对象，再 send_agent 发消息。消息异步送达：发出后继续手头工作，回复会作为新消息到达；仅当下一步依赖对方结果时才设 wait=true。';
const E_GROUP = '群聊协作：先 list_groups 查看所在群组，再 send_group 发消息。';
const E_TIMER = '主动安排：发现值得持续跟进或适时提醒的事项时，主动用 timer(action="set") 安排，不必等用户指令。';
const E_ASK = '不可逆操作前询问：删除、覆盖、花钱、对外发言等不可逆或涉及授权的操作，先 ask_questions 征求确认，不要擅自替用户决定。';
const E_SUB = '并行子任务：独立、可并行的子任务用 subagent(action="spawn") 派出，完成后 subagent(action="await") 取结果；若后续步骤依赖其输出，则不适合派出。';
const E_RESTART = '系统管理：修改 src/ 业务包源码后，需要 system_restart 重启才能生效（reload 只重读配置，不加载代码改动）；仅在确实需要时使用。';
const E_TRACK = '目标与待办：承担跨会话的长期任务时，用 goal(action="create") 登记目标——登记后宿主自动逐轮推进直至完成/受阻；多步工作先写 todo(action="write") 清单，随做随更新状态（开工标 in_progress、完成即标）；达成即 goal(action="update", status="completed") 收口，确认无法推进则 status="blocked" 并给 blocked_reason。';

/** 全量 dev 工具集（三档基线③） */
const FULL_TOOLS = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'job',
  'ask_questions', 'subagent', 'timer', 'system_restart',
  'list_agents', 'send_agent', 'list_groups', 'send_group',
  'goal', 'todo',
];

/** 取装配产物中的指引块（无则空串） */
function guidelineBlock(toolNames: string[]): string {
  return systemPromptRow.assembleBlocks({ toolNames }).find((b) => b.startsWith('## 指引')) ?? '';
}

describe('ac-system-prompt 指引条目基线（v3：条目级门控 + 整段措辞锁定）', () => {
  it('基线① 基础 fs（read/write/edit）→ 文件操作 + 产出物引用', () => {
    expect(guidelineBlock(['read', 'write', 'edit'])).toBe(`## 指引\n1. ${E_FILE}\n2. ${E_OUT}`);
  });

  it('基线② 仅 bash → 命令执行 + 后台任务 + 产出物引用', () => {
    expect(guidelineBlock(['bash'])).toBe(`## 指引\n1. ${E_CMD}\n2. ${E_JOB}\n3. ${E_OUT}`);
  });

  it('基线③ 全量 dev 工具集 → 11 条全出，顺序与编号锁定', () => {
    expect(guidelineBlock(FULL_TOOLS)).toBe(
      `## 指引\n1. ${E_FILE}\n2. ${E_CMD}\n3. ${E_JOB}\n4. ${E_OUT}\n5. ${E_AGENTS}\n6. ${E_GROUP}\n7. ${E_TIMER}\n8. ${E_ASK}\n9. ${E_SUB}\n10. ${E_RESTART}\n11. ${E_TRACK}`,
    );
  });

  it('条目级门控：单工具只出对应条目；全不匹配则整块消失', () => {
    expect(guidelineBlock(['timer'])).toBe(`## 指引\n1. ${E_TIMER}`);
    expect(guidelineBlock(['system_restart'])).toBe(`## 指引\n1. ${E_RESTART}`);
    expect(guidelineBlock(['ask_questions'])).toBe(`## 指引\n1. ${E_ASK}`);
    expect(guidelineBlock(['subagent'])).toBe(`## 指引\n1. ${E_SUB}`);
    expect(guidelineBlock(['list_agents', 'send_agent'])).toBe(`## 指引\n1. ${E_AGENTS}`);
    expect(guidelineBlock(['list_groups', 'send_group'])).toBe(`## 指引\n1. ${E_GROUP}`);
    expect(guidelineBlock(['goal'])).toBe(`## 指引\n1. ${E_TRACK}`);
    expect(guidelineBlock(['todo'])).toBe(`## 指引\n1. ${E_TRACK}`);
    expect(guidelineBlock(['math'])).toBe('');
  });

  it('edit 缺席分支（read+write）→ 无 edit 提示 + 产出物引用', () => {
    expect(guidelineBlock(['read', 'write'])).toBe(`## 指引\n1. ${E_FILE_NOEDIT}\n2. ${E_OUT}`);
  });

  it('词形锁定：全量产物含工具名/参数名原文', () => {
    const g = guidelineBlock(FULL_TOOLS);
    for (const token of ['old_string', 'timer(action="set")', 'job_id', 'wait=true', 'subagent(action="spawn")', 'goal(action="create")', 'todo(action="write")']) {
      expect(g).toContain(token);
    }
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
    // 缺省：files/<id>（恒完整路径展示，期望值经 path.resolve 归一）
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      agentWorkdir: 'C:/ws/files/neko',
      wsRoot: 'C:/ws',
    });
    const content = blocks.join('\n\n');
    expect(content).toContain(`[工作目录] ${path.resolve('C:/ws/files/neko')}`);
    // 显式 workdir 覆盖专用空间
    const explicit = systemPromptRow.assembleBlocks({
      toolNames: [],
      security: { workdir: 'C:/mounted' },
      agentWorkdir: 'C:/ws/files/neko',
      wsRoot: 'C:/ws',
    });
    expect(explicit.join('\n\n')).toContain(`[工作目录] ${path.resolve('C:/mounted')}`);
    // 预设 Agent（agentWorkdir = 工作区根）：回落根展示
    const preset = systemPromptRow.assembleBlocks({
      toolNames: [],
      agentWorkdir: 'C:/ws',
      wsRoot: 'C:/ws',
    });
    expect(preset.join('\n\n')).toContain(`[工作目录] ${path.resolve('C:/ws')}`);
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

  it('source=event 但非自会话桶（1v1/群/singles）→ 不标注，与该 sender 普通轮同渲染（KV 前缀不翻转）', () => {
    // goal-round / job 通知等机制触发轮落在用户可见桶：对话信息行必须与
    // 用户轮字节一致，否则 source 交替即翻转 system → 每边界全量前缀 miss
    const round = systemPromptRow.assembleBlocks({
      toolNames: [],
      sender: 'user',
      source: 'event',
      conversationId: 'admin~user',
    });
    const userTurn = systemPromptRow.assembleBlocks({
      toolNames: [],
      sender: 'user',
      source: 'user',
      conversationId: 'admin~user',
    });
    expect(round.join('\n\n')).toContain('[当前对话对象] user - user');
    expect(round.join('\n\n')).not.toContain('机制触发');
    expect(round).toEqual(userTurn);
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

  it('workspace 根 + workdir 完整路径展示（无相对形态附注）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      security: { workdir: 'C:/ws/files/a1', allowedPaths: ['./shared'] },
      wsRoot: 'C:/ws',
    });
    const content = blocks.join('\n\n');
    expect(content).toContain(`[工作目录] ${path.resolve('C:/ws/files/a1')}`);
    expect(content).not.toContain('[工作目录] ./');
    expect(content).toContain('[路径穿透白名单] C:\\ws\\shared');
  });

  it('无 workdir 挂载 → 工作目录 = 工作区根（完整路径展示）', () => {
    const blocks = systemPromptRow.assembleBlocks({
      toolNames: [],
      wsRoot: 'C:/ws',
    });
    const content = blocks.join('\n\n');
    expect(content).toContain(`[工作目录] ${path.resolve('C:/ws')}`);
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
    expect(content).not.toContain('## 系统环境');
    expect(content).not.toContain('## 术语约定');
    expect(content).not.toContain('## 指引');
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
    // 相对 workdir 具体化为完整路径（path.resolve 锚 process.cwd()，与沙箱同源）
    expect(content).toContain(`[工作目录] ${path.resolve('./files/a6')}`);
    expect(content).not.toContain('[工作目录] ./files/a6');
    expect(content).toContain('[路径穿透白名单]');
    expect(content).toContain('shared');
  });
});
