// ============================================================
// ac-skill/tests/skill.test.ts —— 技能发现/注入/加载
//
// · 全局 skills/ 目录发现（懒扫描 + refresh 重扫）
// · before-run 注入 <available_skills>（全局 + 本 Agent 专属）
// · settings['skill'].whitelist per-Agent 白名单 / enabled=false 软停用
// · 本 Agent 专属技能目录 files/<agentId>/skills（只对该 Agent 可见）
// · load_skill 工具：按名加载全局/专属技能正文（参照 DSH skill 工具）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import type { ToolResult } from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as agentStoreRow from 'ac-agent-store';
import * as sessionRow from 'ac-session';
import * as workspaceRow from 'ac-workspace';
import * as singlesRow from 'ac-singles';
import * as skillRow from '../src/index';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
let tmp = '';

function makeRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), 'ac-skill-'));
  return tmp;
}

function writeSkill(dirName: string, name: string, description: string, body = '正文'): void {
  mkdirSync(join(tmp, 'skills', dirName), { recursive: true });
  writeFileSync(
    join(tmp, 'skills', dirName, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    'utf-8',
  );
}

function writeAgentSkill(agentId: string, dirName: string, name: string, description: string, body = '专属正文'): void {
  mkdirSync(join(tmp, 'files', agentId, 'skills', dirName), { recursive: true });
  writeFileSync(
    join(tmp, 'files', agentId, 'skills', dirName, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    'utf-8',
  );
}

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(ctx: Context, rows: unknown[]) {
  const fibers: Fiber[] = [];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return fibers;
}

function standardRows() {
  return [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    agentsRow,
    loopRow,
  ];
}

async function bootSkill(options: Record<string, unknown> = {}) {
  const ctx = new Context();
  await boot(ctx, standardRows());
  const fiber = ctx.plugin(skillRow, { root: tmp, ...options });
  await fiber;
  return { ctx, fiber };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

describe('SkillsService 发现', () => {
  it('懒扫描 + refresh 重扫（目录增删可见）', async () => {
    makeRoot();
    const ctx = new Context();
    await boot(ctx, standardRows());
    const fiber = ctx.plugin(skillRow, { root: tmp });
    await fiber;
    expect(ctx.skills.list()).toEqual([]);
    writeSkill('pdf', 'pdf-export', '导出 PDF');
    // 缓存未失效：仍为空
    expect(ctx.skills.list()).toEqual([]);
    ctx.skills.refresh();
    expect(ctx.skills.list().map((s) => s.name)).toEqual(['pdf-export']);
  });

  it('locationPrefix 缺省 = <root>/skills 的 POSIX 形', async () => {
    makeRoot();
    const ctx = new Context();
    await boot(ctx, standardRows());
    const fiber = ctx.plugin(skillRow, { root: './data' });
    await fiber;
    expect((ctx.skills as any).locationPrefix).toBe('./data/skills');
  });
});

describe('ac-skill 注入', () => {
  it('发现技能 → <available_skills> 追加到 system 尾部', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeSkill('triage', 'triage', '对输入分类');
    captured.length = 0;
    const { ctx } = await bootSkill();
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system.startsWith('BASE')).toBe(true);
    expect(system).toContain('<available_skills>');
    expect(system).toContain(`<location>${String(tmp).replace(/\\/g, '/')}/skills/pdf/SKILL.md</location>`);
    // 按名称排序：pdf-export < triage
    expect(system.indexOf('pdf-export')).toBeLessThan(system.indexOf('>triage<'));
  });

  it("settings['skill'].whitelist → per-Agent 全局技能白名单过滤", async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeSkill('triage', 'triage', '对输入分类');
    captured.length = 0;
    const { ctx } = await bootSkill();
    ctx.agents.register({
      id: 's1',
      model: 'mock-1',
      settings: { skill: { whitelist: ['triage'] } },
    });
    await ctx.agentLoop.run({
      agent: 's1',
      model: 'mock-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system).toContain('>triage<');
    expect(system).not.toContain('pdf-export');
  });

  it("settings['skill'].enabled=false → 软停用", async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    captured.length = 0;
    const { ctx } = await bootSkill();
    ctx.agents.register({
      id: 's2',
      model: 'mock-1',
      settings: { skill: { enabled: false } },
    });
    await ctx.agentLoop.run({
      agent: 's2',
      model: 'mock-1',
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('目录不存在 / 无技能 → 不注入', async () => {
    makeRoot();
    captured.length = 0;
    const { ctx } = await bootSkill();
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});

describe('本 Agent 专属技能（files/<agent>/skills）', () => {
  it('随全局一起注入，location 指向 files/<agent>/skills', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeAgentSkill('a', 'secret', 'agent-only', '只给 a 的内部流程');
    captured.length = 0;
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system).toContain('>pdf-export<');
    expect(system).toContain('>agent-only<');
    const posixTmp = String(tmp).replace(/\\/g, '/');
    expect(system).toContain(`<location>${posixTmp}/skills/pdf/SKILL.md</location>`);
    expect(system).toContain(`<location>${posixTmp}/files/a/skills/secret/SKILL.md</location>`);
  });

  it('专属技能只对 owner 可见（其他 Agent 不注入）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeAgentSkill('a', 'secret', 'agent-only', '只给 a 的内部流程');
    captured.length = 0;
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    await ctx.agentLoop.run({ agent: 'b', model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    const aSystem = String(captured[0].messages[0].content);
    const bSystem = String(captured[1].messages[0].content);
    expect(aSystem).toContain('agent-only');
    expect(bSystem).toContain('pdf-export');
    expect(bSystem).not.toContain('agent-only');
  });

  it('专属技能不受全局 whitelist 约束', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeSkill('triage', 'triage', '对输入分类');
    writeAgentSkill('a', 'own1', 'own-one', 'a 的专属');
    captured.length = 0;
    const { ctx } = await bootSkill();
    ctx.agents.register({
      id: 'a',
      model: 'mock-1',
      settings: { skill: { whitelist: ['triage'] } },
    });
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system).toContain('>triage<');
    expect(system).toContain('>own-one<');
    expect(system).not.toContain('pdf-export');
    // listForAgent 同口径
    const view = ctx.skills.listForAgent('a');
    expect(view.global.map((s) => s.name)).toEqual(['triage']);
    expect(view.own.map((s) => s.name)).toEqual(['own-one']);
  });

  it('未注册/预设 Agent 的专属目录不镜像全局（workdir=根守卫）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    const { ctx } = await bootSkill();
    // 未注册 id：agentWorkdir 回落数据根 → own 目录即全局 skills 目录，
    // 不得把全局清单重复计成"专属"（skills/list 读面会看到双份）
    const ghost = ctx.skills.listForAgent('ghost-agent');
    expect(ghost.global.map((s) => s.name)).toEqual(['pdf-export']);
    expect(ghost.own).toEqual([]);
  });
});

describe('load_skill 工具', () => {
  it('注册在工具面（名称 load_skill）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    const { ctx } = await bootSkill();
    expect(ctx.tools.has('load_skill')).toBe(true);
  });

  it('按名加载全局技能正文（frontmatter 剥离，scope=global）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档', '# PDF 正文\n\n按规则导出。');
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const res = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'pdf-export' },
      agentId: 'a',
    })) as ToolResult;
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({
      name: 'pdf-export',
      scope: 'global',
      content: '# PDF 正文\n\n按规则导出。',
    });
    expect(String(res.output && (res.output as { baseDir?: string }).baseDir).replace(/\\/g, '/')).toBe(
      `${String(tmp).replace(/\\/g, '/')}/skills/pdf`,
    );
  });

  it('加载本 Agent 专属技能（scope=agent）', async () => {
    makeRoot();
    writeAgentSkill('a', 'secret', 'agent-only', '内部流程', '专属指令正文');
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const res = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'agent-only' },
      agentId: 'a',
    })) as ToolResult;
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ name: 'agent-only', scope: 'agent', content: '专属指令正文' });
  });

  it('专属技能同名遮蔽全局同名技能', async () => {
    makeRoot();
    writeSkill('dup', 'dup', '全局版本');
    writeAgentSkill('a', 'dup', 'dup', '专属版本', '本 Agent 的 dup 正文');
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const res = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'dup' },
      agentId: 'a',
    })) as ToolResult;
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ scope: 'agent', content: '本 Agent 的 dup 正文' });
  });

  it('白名单外的全局技能不可加载（目录未列出）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeSkill('triage', 'triage', '对输入分类');
    const { ctx } = await bootSkill();
    ctx.agents.register({
      id: 'a',
      model: 'mock-1',
      settings: { skill: { whitelist: ['triage'] } },
    });
    const denied = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'pdf-export' },
      agentId: 'a',
    })) as ToolResult;
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('不存在或当前不可用');
    const allowed = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'triage' },
      agentId: 'a',
    })) as ToolResult;
    expect(allowed.ok).toBe(true);
  });

  it('未知技能名 → 报错', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const res = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'no-such' },
      agentId: 'a',
    })) as ToolResult;
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('不存在或当前不可用');
  });

  it('非法技能名 / 无 Agent 身份 / 软停用 → 各自报错', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'off', model: 'mock-1', settings: { skill: { enabled: false } } });

    const badName = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'Bad Name' },
      agentId: 'a',
    })) as ToolResult;
    expect(badName.ok).toBe(false);
    expect(String(badName.error)).toContain('非法');

    const noIdentity = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'pdf-export' },
    })) as ToolResult;
    expect(noIdentity.ok).toBe(false);
    expect(String(noIdentity.error)).toContain('Agent 身份');

    const disabled = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'pdf-export' },
      agentId: 'off',
    })) as ToolResult;
    expect(disabled.ok).toBe(false);
    expect(String(disabled.error)).toContain('已停用');
  });
});

describe('会话工作区技能（singles 挂载工作区）', () => {
  /** 带 agentStore/session/workspace/singles 的 boot（工作区根 = <tmp>/ws；
   *  行式装载（ctx.plugin）——WorkspaceService 静态依赖 agents/agentStore/
   *  session，直构绕过 fiber inject 填充会在 agentWorkdir 处断链） */
  async function bootSkillWithSession() {
    const ctx = new Context();
    await boot(ctx, standardRows());
    await boot(ctx, [
      agentStoreRow,
      sessionRow,
      {
        name: 'workspace-row',
        apply(c: Context) {
          void c.plugin(workspaceRow, { root: tmp, browserDaemon: false });
        },
      },
      {
        name: 'singles-row',
        apply(c: Context) {
          void c.plugin(singlesRow, { root: tmp });
        },
      },
    ]);
    const fiber = ctx.plugin(skillRow, { root: tmp });
    await fiber;
    return { ctx, fiber };
  }

  function writeWsSkill(rel: string, dirName: string, name: string, body = '工作区正文'): string {
    const wsRoot = join(tmp, 'ws');
    mkdirSync(join(wsRoot, ...rel.split('/'), dirName), { recursive: true });
    writeFileSync(
      join(wsRoot, ...rel.split('/'), dirName, 'SKILL.md'),
      `---\nname: ${name}\ndescription: 工作区技能 ${name}\n---\n\n${body}`,
      'utf-8',
    );
    return wsRoot;
  }

  it('挂载工作区 → 约定目录技能注入 + load_skill 可加载（enabled=false 预设同样可见）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '全局技能');
    const wsRoot = writeWsSkill('.claude/skills', 'ws-review', 'ws-review', '# 审查正文');
    const { ctx } = await bootSkillWithSession();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    const single = ctx.singles.create({ workspaceId: ws.id });
    // __standard__ 同款预设语义：skill.enabled=false——工作区组是会话挂载
    // 资产，不受门控；全局/专属照旧被挡
    ctx.agents.register({ id: 'p1', model: 'mock-1', settings: { skill: { enabled: false } } });
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'p1',
      model: 'mock-1',
      messages: [{ role: 'user', content: 'hi' }],
      conversationId: single.id,
    });
    const system = String(captured[0].messages[0].content);
    expect(system).toContain('>ws-review<');
    expect(system).toContain(`<location>${wsRoot.replace(/\\/g, '/')}/.claude/skills/ws-review/SKILL.md</location>`);
    expect(system).not.toContain('pdf-export'); // 全局被 enabled=false 挡

    const res = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'ws-review' },
      agentId: 'p1',
      conversationId: single.id,
    })) as ToolResult;
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ name: 'ws-review', scope: 'workspace', content: '# 审查正文' });

    // 全局技能在该 Agent 下被软停用挡住（门控语义不变）
    const denied = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'pdf-export' },
      agentId: 'p1',
      conversationId: single.id,
    })) as ToolResult;
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('已停用');
  });

  it('会话隔离：未挂工作区的会话看不到工作区组；1v1/群键恒无', async () => {
    makeRoot();
    const wsRoot = writeWsSkill('.github/skills', 'gh', 'gh-skill');
    const { ctx } = await bootSkillWithSession();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    const attached = ctx.singles.create({ workspaceId: ws.id });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    captured.length = 0;
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], conversationId: attached.id });
    // attached 已有消息（非空白）再建第二个会话——create 前置 purgeEmpty
    // 会清理遗留空白会话（全局唯一不变量），先跑一轮使其免于被清
    const bare = ctx.singles.create({});
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], conversationId: bare.id });
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(String(captured[0].messages[0].content)).toContain('gh-skill');
    expect(String(captured[1].messages[0].content)).not.toContain('gh-skill');
    expect(String(captured[2].messages[0].content)).not.toContain('gh-skill');
  });

  it('同名遮蔽序：本 Agent 专属 > 会话工作区 > 全局', async () => {
    makeRoot();
    writeSkill('dup', 'dup', '全局版本', '全局正文');
    writeAgentSkill('a', 'dup', 'dup', '专属版本', '专属正文');
    const wsRoot = writeWsSkill('skills', 'dup', 'dup', '工作区正文');
    const { ctx } = await bootSkillWithSession();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    const single = ctx.singles.create({ workspaceId: ws.id });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const res = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'dup' },
      agentId: 'a',
      conversationId: single.id,
    })) as ToolResult;
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ scope: 'agent', content: '专属正文' });
    // 无专属时工作区遮蔽全局
    const res2 = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'dup' },
      agentId: 'b',
      conversationId: single.id,
    })) as ToolResult;
    expect(res2.ok).toBe(true);
    expect(res2.output).toMatchObject({ scope: 'workspace', content: '工作区正文' });
  });

  it('/name 用户显式调用：before-step 确定性注入 <skill_content>（DSH pre-step 同款）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF', '# PDF 正文\n\n按规则导出。');
    writeSkill('triage', 'triage', '对输入分类', '分类正文');
    const { ctx } = await bootSkill();
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    // 用户消息带 /pdf-export token → 步尾注入 system-reminder + 正文
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '请用 /pdf-export 处理这份文档\nhttps://x.com/a 不算调用' }],
    });
    const stepMessages = captured[0].messages;
    const reminder = stepMessages[stepMessages.length - 1];
    expect(reminder.role).toBe('user');
    expect(String(reminder.content)).toContain('<system-reminder>');
    expect(String(reminder.content)).toContain('<skill_content name="pdf-export">');
    expect(String(reminder.content)).toContain('# PDF 正文');
    expect(String(reminder.content)).not.toContain('skill_content name="triage"'); // 只注入被点名的
    // URL 的 // 不触发；原始用户消息保持不动（改写仅注入尾部）
    expect(String(stepMessages[1]?.content ?? stepMessages[0]?.content)).toContain('/pdf-export 处理这份文档');

    // 无 /name 的普通消息 → 零注入
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '普通消息，https://example.com/x 链接不算' }],
    });
    const plain = captured[0].messages;
    expect(plain.some((m) => String(m.content).includes('<system-reminder>'))).toBe(false);
  });

  it('/name 手势与工作区技能：conversationId（步载体出生字段）解析挂载工作区', async () => {
    makeRoot();
    const wsRoot = writeWsSkill('.claude/skills', 'ws-tool', 'ws-tool', '# 工作区技能正文');
    const { ctx } = await bootSkillWithSession();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    const single = ctx.singles.create({ workspaceId: ws.id });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '按 /ws-tool 执行' }],
      conversationId: single.id,
    });
    const stepMessages = captured[0].messages;
    const reminder = stepMessages[stepMessages.length - 1];
    expect(String(reminder.content)).toContain('<skill_content name="ws-tool">');
    expect(String(reminder.content)).toContain('# 工作区技能正文');
    // 未挂工作区的会话：/ws-tool 定位不到 → 不注入（token 留给 load_skill 报可读错误）
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '按 /ws-tool 执行' }],
    });
    expect(captured[0].messages.some((m) => String(m.content).includes('<system-reminder>'))).toBe(false);
  });
});
