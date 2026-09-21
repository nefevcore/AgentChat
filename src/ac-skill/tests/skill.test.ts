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

/** 两步脚本 provider：首调用出 tool_call（缺省 echo），其余文本收束——
 *  多步 run 的手势注入测试用（第 2 步的历史里仍含手势消息） */
function toolThenTextProvider(tool = 'echo', args = '{"text":"x"}') {
  let n = 0;
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      if (n++ === 0) {
        yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: tool }] };
        yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: args }] };
        yield { delta: '', finish: 'tool_calls' as const };
      } else {
        yield { delta: 'ok' };
        yield { delta: '', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } };
      }
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

function standardRows(provider = scriptedProvider) {
  return [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', provider(), { models: ['mock-1'] });
      },
    },
    agentsRow,
    loopRow,
  ];
}

async function bootSkill(provider: typeof scriptedProvider = scriptedProvider, options: Record<string, unknown> = {}) {
  const ctx = new Context();
  await boot(ctx, standardRows(provider));
  const fiber = ctx.plugin(skillRow, { root: tmp, ...options });
  await fiber;
  return { ctx, fiber };
}

/** 带 agentStore/session/workspace/singles 的 boot（工作区根 = <tmp>/ws；
 *  行式装载（ctx.plugin）——WorkspaceService 静态依赖 agents/agentStore/
 *  session，直构绕过 fiber inject 填充会在 agentWorkdir 处断链）。
 *  词汇 v2：手势判定/落账需要会话键 + session 行——提升模块级共用 */
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

  it('与 [引用约定] 行同场：任意激活顺序 → 技能块恒居引用约定组之前（收敛式定序）', async () => {
    // Loader 路径（官方 boot）行并发创建（行序 ≠ 激活序），四行以任意顺序
    // 激活须收敛到同一形态：…静态块 → [引用约定]×N（聚齐）→ 之后的块。
    // 用例覆盖三类时序：
    //   a) 技能先激活（无锚点 append 末尾，引用约定后到 → 聚齐在它后面）
    //   b) 引用约定先激活（技能块插到首条之前）
    //   c) 部分引用约定在技能前、部分在技能后（锚点命中已就位的首条）
    const GUIDES = [
      '[引用约定] 用户消息中的 @<路径>…',
      '[引用约定] 用户消息中的 #<标题>(<会话 id>)…',
      '[引用约定] 用户消息中的 @<名称>…',
    ];
    const mkGuideRow = (text: string, order: number) => ({
      name: `guide-row-${order}`,
      apply(c: Context) {
        c.on('loop/before-run', (call: any, next: () => unknown) => {
          call.request = {
            ...call.request,
            system: call.request.system ? `${call.request.system}\n${text}` : text,
          };
          return next() as any;
        });
      },
    });
    for (const perm of [
      ['skill', 'g0', 'g1', 'g2'], // a) 技能最先
      ['g0', 'skill', 'g1', 'g2'], // b) 首条引用约定最先
      ['g0', 'g1', 'skill', 'g2'], // c) 技能居中
    ] as const) {
      makeRoot();
      writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
      captured.length = 0;
      const ctx = new Context();
      await boot(ctx, standardRows());
      const mounted: Fiber[] = [];
      // 按 perm 指定顺序串行挂载（await fiber = 程序化路径下等价激活序）
      const mountSkill = async () => mounted.push(await ctx.plugin(skillRow, { root: tmp }));
      const mountGuides = GUIDES.map((text, i) => async () => {
        mounted.push(await ctx.plugin(mkGuideRow(text, i)));
      });
      for (const slot of perm) {
        await (slot === 'skill' ? mountSkill() : mountGuides[Number(slot.slice(1))]());
      }
      await ctx.agentLoop.run({
        model: 'mock-1',
        system: 'BASE',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const system = String(captured[0].messages[0].content);
      // 收敛不变量：技能块恒居首条引用约定之前、三条聚齐其后、无粘连
      const firstRef = system.indexOf('[引用约定]');
      expect(firstRef).toBeGreaterThan(0);
      const skillPos = system.indexOf('## 可用技能');
      expect(skillPos).toBeGreaterThan(0);
      expect(skillPos).toBeLessThan(firstRef);
      expect(system).toMatch(/BASE\n\n## 可用技能/);
      expect(system.indexOf('[引用约定]', firstRef + 1)).toBeGreaterThan(skillPos);
      expect(system.lastIndexOf('[引用约定]')).toBeGreaterThan(skillPos);
      // 三条全部在场且不被技能块拆开
      for (const text of GUIDES) {
        expect(system).toContain(text);
        expect(system.indexOf(text)).toBeGreaterThan(skillPos);
      }
      booted.push({ ctx, fibers: mounted });
    }
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
      status: 'injected',
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
    expect(res.output).toMatchObject({ name: 'agent-only', scope: 'agent', status: 'injected' });
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
    expect(res.output).toMatchObject({ scope: 'agent', status: 'injected' });
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
  async function bootSkillWithSessionLocal() {
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
    const { ctx } = await bootSkillWithSessionLocal();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    // 预置 title：短路 singles 自动标题（run-started 的 fire-and-forget LLM
    // 调用会插进 mock captured，污染 captured[0] 断言）——本组用例测注入，不关心标题
    const single = ctx.singles.create({ workspaceId: ws.id, title: '挂工作区' });
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
    expect(res.output).toMatchObject({ name: 'ws-review', scope: 'workspace', status: 'injected' });

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
    const { ctx } = await bootSkillWithSessionLocal();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    const attached = ctx.singles.create({ workspaceId: ws.id, title: '已挂载' });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    captured.length = 0;
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], conversationId: attached.id });
    // attached 已有消息（非空白）再建第二个会话——create 前置 purgeEmpty
    // 会清理遗留空白会话（全局唯一不变量），先跑一轮使其免于被清
    const bare = ctx.singles.create({ title: '未挂载' });
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
    const { ctx } = await bootSkillWithSessionLocal();
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
    expect(res.output).toMatchObject({ scope: 'agent', status: 'injected' });
    // 无专属时工作区遮蔽全局
    const res2 = (await ctx.tools.execute({
      name: 'load_skill',
      args: { name: 'dup' },
      agentId: 'b',
      conversationId: single.id,
    })) as ToolResult;
    expect(res2.ok).toBe(true);
    expect(res2.output).toMatchObject({ scope: 'workspace', status: 'injected' });
  });

  it('/name 手势与工作区技能：conversationId 解析挂载工作区（before-run 判定 + 落账）', async () => {
    makeRoot();
    const wsRoot = writeWsSkill('.claude/skills', 'ws-tool', 'ws-tool', '# 工作区技能正文');
    const { ctx } = await bootSkillWithSessionLocal();
    const ws = ctx.workspace.registerWorkspace(wsRoot);
    const single = ctx.singles.create({ workspaceId: ws.id, title: '手势会话' });
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
      conversationId: ctx.singles.create({ title: '无工作区' }).id,
    });
    expect(captured[0].messages.some((m) => String(m.content).includes('<system-reminder>'))).toBe(false);
  });
});

describe('/name 手势与注入通道（词汇 v2：before-run 判定 + context 行落账）', () => {
  it('before-run 判定尾部 user 块：工作数组注入 + context 行落账 + 回放含正文', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF', '# PDF 正文');
    writeSkill('triage', 'triage', '对输入分类', '分类正文');
    const { ctx } = await bootSkillWithSession();
    const single = ctx.singles.create({ title: '手势会话' });
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '请用 /pdf-export 处理这份文档\nhttps://x.com/a 不算调用' }],
      conversationId: single.id,
    });
    const stepMessages = captured[0].messages;
    const reminder = stepMessages[stepMessages.length - 1];
    expect(reminder.role).toBe('user');
    expect(String(reminder.content)).toContain('<system-reminder>');
    expect(String(reminder.content)).toContain('<skill_content name="pdf-export">');
    expect(String(reminder.content)).toContain('# PDF 正文');
    expect(String(reminder.content)).not.toContain('skill_content name="triage"');
    // context 行落账：history() 回放含注入正文（context → user 语义位）
    const rows = await ctx.session.history(single.id, { viewer: 'a' });
    expect(rows.some((m) => String(m.content).includes('skill_content name="pdf-export"'))).toBe(true);
    // 落账行 role 形态：records() 直读（context + source:skill + label）
    const recs = await ctx.session.records(single.id);
    const ctxRow = recs.find((r) => r.role === 'context');
    expect(ctxRow).toBeDefined();
    expect(ctxRow?.source).toBe('skill');
    expect(String(ctxRow?.label ?? '')).toContain('pdf-export');

    // 无 /name 普通消息 → 零注入
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '普通消息，https://example.com/x 链接不算' }],
      conversationId: single.id,
    });
    expect(captured[0].messages.some((m) => String(m.content).includes('<system-reminder>用户以 /<name>'))).toBe(false);
  });

  it('一次性判定：尾部已含注入体 → 跳过（busy 排队重触发窗口去重）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF', '# PDF 正文');
    const { ctx } = await bootSkillWithSession();
    const single = ctx.singles.create({ title: '手势会话' });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    captured.length = 0;
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: '请用 /pdf-export 处理文档' }], conversationId: single.id });
    expect(captured[0].messages.some((m) => String(m.content).startsWith('<system-reminder>用户以 /<name>'))).toBe(true);
    // 第二轮：messages 尾部已带注入体（等价于 busy 排队后重触发同消息）→ 不再注入
    // （第二轮请求中手势注入体恰为传入的那一条，未新增）
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: '请用 /pdf-export 处理文档' }, { role: 'user', content: '<system-reminder>用户以 /<name> 显式调用以下技能，按其指令执行；这些技能已内联注入，无需再经 load_skill 加载。\n<skill_content name="pdf-export">\n# PDF 正文\n</skill_content></system-reminder>' }], conversationId: single.id });
    const secondRunInputs = captured.slice(1);
    const gestureCounts = secondRunInputs.map(
      (input) => input.messages.filter((m) => String(m.content).startsWith('<system-reminder>用户以 /<name>')).length,
    );
    expect(gestureCounts.every((n) => n === 1)).toBe(true); // 每步恰 1（传入的那条），无新增
  });

  it('mid-run steer 手势不再服务（判定收窄为 run 触发消息——档案 §5 行为变更）', async () => {
    makeRoot();
    writeSkill('triage', 'triage', '对输入分类', '分类正文');
    const { ctx } = await bootSkillWithSession();
    const single = ctx.singles.create({ title: 'steer 会话' });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: (args) => ({ ok: true, output: String(args.text ?? '') }),
    });
    captured.length = 0;
    const runPromise = ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      messages: [{ role: 'user', content: '开始工作' }],
      conversationId: single.id,
    });
    ctx.agentLoop.steer('a', { role: 'user', content: '补充：用 /triage 也处理' });
    await runPromise;
    expect(captured.some((input) => input.messages.some((m) => String(m.content).includes('skill_content name="triage"')))).toBe(false);
  });

  it('run_code 子调用通道：run 内注入一次即销账（多步不重注、脏键不进渲染）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF', '# PDF 正文');
    const { ctx } = await bootSkillWithSession();
    const single = ctx.singles.create({ title: '子调用会话' });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // echo 工具体内 await 子调用 load_skill（真实 run_code 形态：程序 await 子调用后工具体才返回；
    // after-execute 在工具结果前同步完成 → 登记先于下一步 before-step）
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (args, call) => {
        await ctx.tools.execute({
          name: 'load_skill',
          args: { name: 'pdf-export' },
          agentId: call.agentId,
          conversationId: call.conversationId,
          runCodeSubcall: true,
        } as never);
        return { ok: true, output: String(args.text ?? '') };
      },
    });
    // 三步脚本：echo / echo / 文本收束 —— 步 1 注入一次，步 2、3 不再重注
    let n = 0;
    const { ctx: _c } = { ctx }; // lint 占位（避免误用 _c）
    const scripted = () => ({
      stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
        captured.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        if (n++ < 2) {
          yield { delta: '', toolCalls: [{ index: 0, id: 'c' + n, name: 'echo', argumentsDelta: '' }] };
          yield { delta: '', finish: 'tool_calls' as const };
        } else {
          yield { delta: 'ok' };
          yield { delta: '', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } };
        }
      },
    });
    // 覆盖 provider（bootSkillWithSession 用 scriptedProvider）——注册新名 provider
    ctx.llm.register('mock3', scripted, { models: ['mock-3'] });
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-3',
      messages: [{ role: 'user', content: 'load then think' }],
      conversationId: single.id,
    });
    // 三步各自送入模型的消息（run 级驻留，2026-11 裁决）：load 发生在步 1
    // 工具执行中 → before-step 时刻 injectDurable 入队 → 步 2 边界 splice 进
    // 工作数组 → 步 2/3 继承（前缀稳定 KV 全命中——每步恰 1 条，无堆积；
    // 旧「每步尾部重现」形态已退役：尾部字节稳定但每步重算正文）
    const snapshots = captured.map((input) => input.messages.map((m) => ({ role: m.role, content: m.content })));
    const counts = snapshots.map(
      (msgs) => msgs.filter((m) => String(m.content).startsWith('<system-reminder>以下技能已加载')).length,
    );
    console.log('DBG counts', JSON.stringify(counts), 'msgs2', JSON.stringify(snapshots.map((m) => m.map((x) => String(x.content).slice(0, 30)))));
        expect(counts).toEqual([0, 1, 1]);
    // 注入体正文恰含一份技能（脏键不进渲染）
    const inj = captured[1].messages.find((m) => String(m.content).startsWith('<system-reminder>以下技能已加载'));
    expect(String(inj?.content).match(/<skill_content name="pdf-export">/g)?.length).toBe(1);
    expect(String(inj?.content)).not.toContain('__recorded__');
    // 落账恰一行；label 无脏键
    const recs = await ctx.session.records(single.id);
    const skillRows = recs.filter((r) => r.role === 'context' && r.source === 'skill');
    expect(skillRows.length).toBe(1);
    expect(String(skillRows[0]?.label ?? '')).not.toContain('__recorded__');
    expect(String(skillRows[0]?.content ?? '')).not.toContain('__recorded__');
    // 第二个 run 再 load 同一技能（跨 run 在场）：不再登记、不再落新行
    n = 0;
    captured.length = 0;
    await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-3',
      messages: [{ role: 'user', content: 'load again' }],
      conversationId: single.id,
    });
    const recs2 = await ctx.session.records(single.id);
    expect(recs2.filter((r) => r.role === 'context' && r.source === 'skill').length).toBe(1);
    // 新 run 消息里无新注入体（历史行在场即不重注）
    expect(captured.every((input) => input.messages.filter((m) => String(m.content).startsWith('<system-reminder>以下技能已加载')).length <= 1)).toBe(true);
  });

  it('run_code 子调用通道：直调 load_skill 不瞬态注入（steps 回放承担）', async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF', '# PDF 正文');
    const { ctx } = await bootSkillWithSession();
    const single = ctx.singles.create({ title: '直调会话' });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    captured.length = 0;
    // 直调（runCodeSubcall 未标）：load_skill 结果在 steps，无步内注入体
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', messages: [{ role: 'user', content: 'load pdf' }], conversationId: single.id });
    expect(captured[0].messages.every((m) => !String(m.content).startsWith('<system-reminder>以下技能已加载'))).toBe(true);
  });
});

