// ============================================================
// ac-persona/tests/persona.test.ts —— 人设注入
//
// 人设来源 = AgentConfig.settings['persona']（settings[具名] 模式）：
// 经 ctx.agents 注册，loop/before-run 时按 request.agent 查询注入。
// M14 形状升级：string 兼容 | {enabled?, text?, file?}（file 优先、
// text 回退；裸名走 agentStore 文档，路径走文件系统；frontmatter 剥离）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as personaRow from '../src/index';
import * as systemPromptRow from 'ac-system-prompt';
import * as toolsRow from 'ac-tools';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

/** 脚本 provider：单步文本收束，捕获到达 LLM 的完整请求 */
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
});

describe('ac-persona 人设注入（settings[具名]）', () => {
  it("settings['persona'] → <persona> 块前置进 system（原有 system 保留其后）", async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    ctx.agents.register({
      id: 'p1',
      model: 'mock-1',
      system: 'BASE',
      settings: { persona: '你是海盗，说话带腔调' },
    });
    // 直连 loop 需自带 system（router 路径会从 AgentConfig 填充）
    await ctx.agentLoop.run({ agent: 'p1', model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: '<persona>\n你是海盗，说话带腔调\n</persona>\n\nBASE',
    });
  });

  it('persona 块自成 system（Agent 无 system 时）', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    ctx.agents.register({ id: 'p2', model: 'mock-1', settings: { persona: '猫娘' } });
    await ctx.agentLoop.run({ agent: 'p2', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: '<persona>\n猫娘\n</persona>',
    });
  });

  it('无 settings.persona 的 Agent → system 原样透传', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    ctx.agents.register({ id: 'p3', model: 'mock-1', system: 'BASE' });
    await ctx.agentLoop.run({ agent: 'p3', model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('request.agent 缺省（直连 loop，未注册 Agent）→ 不注入', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    await ctx.agentLoop.run({ model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('与 ac-system-prompt 组合：角色块前置、静态块追加（顺序无关收敛）', async () => {
    captured.length = 0;
    const ctx = new Context();
    // system-prompt 先于 persona 注册（与推荐顺序相反）——仍收敛到同一结构
    await boot(ctx, [...standardRows(), systemPromptRow, personaRow]);
    ctx.agents.register({ id: 'p4', model: 'mock-1', settings: { persona: '海盗' } });
    await ctx.agentLoop.run({ agent: 'p4', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    const system = String(captured[0].messages[0].content);
    expect(system.startsWith('<persona>')).toBe(true);
    // v3（2026-09-02）：framework 块退役——以首个静态块（系统环境）为锚断言前置关系
    expect(system).toContain('## 系统环境');
    expect(system.indexOf('<persona>')).toBeLessThan(system.indexOf('## 系统环境'));
  });
});

describe('ac-persona 文件装载（M14 形状升级）', () => {
  let tmp = '';

  afterEach(async () => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = '';
    }
  });

  it("settings['persona'].file（路径）→ 读文件 + 剥离 frontmatter", async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-persona-'));
    const personaFile = join(tmp, 'persona.md');
    writeFileSync(personaFile, '---\ntitle: x\n---\n\n文件人设正文\n', 'utf-8');
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    ctx.agents.register({ id: 'f1', model: 'mock-1', settings: { persona: { file: personaFile } } });
    await ctx.agentLoop.run({ agent: 'f1', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: '<persona>\n文件人设正文\n</persona>',
    });
  });

  it("settings['persona'].file（裸名 AGENT.md）→ agentStore 文档；file 优先 text 回退", async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-persona-'));
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), agentStoreRow, personaRow]);
    // 直接经 owning 服务写 AGENT.md（ac-agent-store 是 Agent 文档唯一写口）
    ctx.agentStore.saveAgent({ id: 'f2', model: 'mock-1' });
    ctx.agentStore.saveDoc('f2', 'AGENT.md', '# 人物设定\n\n目录实体人设\n');
    ctx.agents.register({ id: 'f2', model: 'mock-1', settings: { persona: { file: 'AGENT.md', text: '内联回退' } } });
    await ctx.agentLoop.run({ agent: 'f2', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: '<persona>\n# 人物设定\n\n目录实体人设\n</persona>',
    });
  });

  it('agentStore 未装 + 裸名缺失 → text 回退；file 缺失 → 不注入', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    ctx.agents.register({
      id: 'f3',
      model: 'mock-1',
      settings: { persona: { file: 'AGENT.md', text: '内联人设' } },
    });
    await ctx.agentLoop.run({ agent: 'f3', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: '<persona>\n内联人设\n</persona>',
    });

    captured.length = 0;
    ctx.agents.register({
      id: 'f4',
      model: 'mock-1',
      settings: { persona: { file: 'AGENT.md' } },
    });
    await ctx.agentLoop.run({ agent: 'f4', model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it("settings['persona'].enabled=false → 软停用（含旧 string 形状不受影响）", async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow]);
    ctx.agents.register({
      id: 'f5',
      model: 'mock-1',
      settings: { persona: { enabled: false, text: '不该出现' } },
    });
    await ctx.agentLoop.run({ agent: 'f5', model: 'mock-1', system: 'BASE', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});
