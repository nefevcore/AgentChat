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
