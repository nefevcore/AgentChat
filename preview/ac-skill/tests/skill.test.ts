// ============================================================
// ac-skill/tests/skill.test.ts —— 技能发现与注入
//
// · 全局 skills/ 目录发现（懒扫描 + refresh 重扫）
// · before-run 注入 <available_skills>（system 尾部追加）
// · settings['skill'].whitelist per-Agent 白名单 / enabled=false 软停用
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
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

function writeSkill(dirName: string, name: string, description: string): void {
  mkdirSync(join(tmp, 'skills', dirName), { recursive: true });
  writeFileSync(
    join(tmp, 'skills', dirName, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文`,
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
    const ctx = new Context();
    await boot(ctx, standardRows());
    const fiber = ctx.plugin(skillRow, { root: tmp });
    await fiber;
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

  it("settings['skill'].whitelist → per-Agent 白名单过滤", async () => {
    makeRoot();
    writeSkill('pdf', 'pdf-export', '导出 PDF 文档');
    writeSkill('triage', 'triage', '对输入分类');
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, standardRows());
    const fiber = ctx.plugin(skillRow, { root: tmp });
    await fiber;
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
    const ctx = new Context();
    await boot(ctx, standardRows());
    const fiber = ctx.plugin(skillRow, { root: tmp });
    await fiber;
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
    const ctx = new Context();
    await boot(ctx, standardRows());
    const fiber = ctx.plugin(skillRow, { root: tmp });
    await fiber;
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});
