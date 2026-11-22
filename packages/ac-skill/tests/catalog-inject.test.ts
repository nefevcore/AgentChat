// ============================================================
// ac-skill/tests/catalog-inject.test.ts —— cr-1249
//   技能目录注入改造：SKILLS 段退役（system 全静态），<available_skills>
//   改 loop/before-run 指纹注入——变化才落 context 行（source=skill）+
//   同字节 user 行双写；指纹未变零注入。datetime/env-pulse 同构。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as skillRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
/** recordContext 捕获面（session 服务替身） */
const recorded: Array<{ id: string; agent: string; content: string; source: string; label?: string }> = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

/** agents 替身（settingsOf 恒 undefined——无白名单） */
function agentsStubRow() {
  return {
    name: 'agents-stub',
    apply(c: Context) {
      c.provide('agents', { settingsOf: () => undefined });
    },
  };
}

/** session 替身行：recordContext 捕获到数组 */
function sessionStubRow() {
  return {
    name: 'session-stub',
    apply(c: Context) {
      c.provide('session', {
        recordContext(id: string, agent: string, content: string, extra: { source: string; label?: string }) {
          recorded.push({ id, agent, content, source: extra.source, ...(extra.label !== undefined ? { label: extra.label } : {}) });
        },
      });
    },
  };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr1249-'));
  tmps.push(dir);
  return dir;
}

function mkSkill(root: string, name: string): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + name + ' 测试技能\n---\n正文', 'utf-8');
}

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, {
    name: 'mock-provider',
    inject: ['llm'],
    apply(c: Context) {
      c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
    },
  }, agentsStubRow(), loopRow, sessionStubRow()]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  const fiber = ctx.plugin(skillRow as any, { root });
  await fiber;
  fibers.push(fiber);
  booted.push({ ctx, fibers });
  return ctx;
}

describe('ac-skill 目录注入（cr-1249：before-run 指纹注入）', () => {
  it('首 run：目录注入面进入消息数组 + 消费点事件（meta 随行）；system 无 <available_skills>', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    mkSkill(root, 'demo-skill');
    const ctx = await boot(root);
    const consumed: Array<{ injectSource: string; label?: string }> = [];
    ctx.on('loop/inject-consumed', (_agent, _conv, _run, items) => {
      for (const c of items) consumed.push({ injectSource: c.meta.injectSource, ...(c.meta.label !== undefined ? { label: c.meta.label } : {}) });
    });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // system 全静态（SKILLS 段退役）
    const system = String(captured[0].messages[0].content);
    expect(system).toBe('BASE');
    expect(system).not.toContain('<available_skills>');
    // 消费点事件（cr-1251：落账面输入）source=skill + label
    expect(consumed).toHaveLength(1);
    expect(consumed[0].injectSource).toBe('skill');
    expect(consumed[0].label).toBe('技能目录');
    // 注入体（wrapSystemReminder 包裹）在信封尾
    const last = captured[0].messages.at(-1);
    expect(String(last?.content)).toContain('<system-reminder>');
    expect(String(last?.content)).toContain('<available_skills>');
    expect(String(last?.content)).toContain('demo-skill');
    // 锚文件落盘
    expect(fs.existsSync(path.join(root, 'files', 'a1', 'skill', '.anchors.json'))).toBe(true);
  });

  it('指纹未变（第二 run）：零注入（锚命中跳过）', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    mkSkill(root, 'demo-skill');
    const ctx = await boot(root);
    let consumptions = 0;
    ctx.on('loop/inject-consumed', () => { consumptions++; });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'again' }],
    });
    expect(consumptions).toBe(1); // 仅首 run
    const last = captured[1].messages.at(-1);
    expect(String(last?.content)).toBe('again'); // 尾部仍是用户消息——未注入
  });

  it('目录新增技能（指纹变化）：重注新目录', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    mkSkill(root, 'demo-skill');
    const ctx = await boot(root);
    const contents: string[] = [];
    ctx.on('loop/inject-consumed', (_a, _c, _r, items) => {
      for (const c of items) contents.push(String(c.message.content));
    });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    mkSkill(root, 'another-skill');
    (ctx.get('skills') as unknown as { refresh(): unknown }).refresh();
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'new' }],
    });
    expect(contents).toHaveLength(2); // 首注 + 变化重注
    expect(contents[1]).toContain('another-skill');
  });

  it('三源全空：不注入不落账（load_skill 空态线索兜底）', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    const ctx = await boot(root);
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'files', 'a1', 'skill', '.anchors.json'))).toBe(false);
  });

  it('cr-1233 dryRun → 不落账不写锚', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    mkSkill(root, 'demo-skill');
    const ctx = await boot(root);
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'c-dry',
      messages: [], dryRun: true,
    });
    expect(recorded).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'files', 'a1', 'skill', '.anchors.json'))).toBe(false);
  });

  it('cr-1251：ledger 行未装 → 注入照常（模型可见性优先），锚指纹自防重', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    mkSkill(root, 'demo-skill');
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const row of [toolsRow, llmRow, {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    }, agentsStubRow(), loopRow]) {
      const fiber = ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    const fiber = ctx.plugin(skillRow as any, { root });
    await fiber;
    fibers.push(fiber);
    booted.push({ ctx, fibers });
    let consumptions = 0;
    ctx.on('loop/inject-consumed', () => { consumptions++; });
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 注入面在场即注入（消费点事件照发——落账方缺席 = 组合选择）；
    // 防重由锚指纹承担（第二 run 同指纹跳过）
    expect(consumptions).toBe(1);
    expect(fs.existsSync(path.join(root, 'files', 'a1', 'skill', '.anchors.json'))).toBe(true);
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1', conversationId: 'u~a1',
      messages: [{ role: 'user', content: 'again' }],
    });
    expect(consumptions).toBe(1); // 锚命中——不重注
  });

  it('无会话键（loop 直连）→ 不注入不写锚', async () => {
    captured.length = 0;
    recorded.length = 0;
    const root = tmpRoot();
    mkSkill(root, 'demo-skill');
    const ctx = await boot(root);
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', agent: 'a1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(recorded).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'files', 'a1', 'skill', '.anchors.json'))).toBe(false);
  });
});
