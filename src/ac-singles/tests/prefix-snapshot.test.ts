// ============================================================
// ac-singles 前缀快照（M21 步骤 4 / D5，session-design §5.2）：
// [system + tool schema] 前缀对独立会话跨轮、跨重启字节不变；
// datetime 日快照行（不进 system）；修订键失效路径显式可测。
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as datetimeRow from 'ac-datetime';
import * as personaRow from 'ac-persona';
import * as memoryRow from 'ac-memory';
import * as conversationRow from 'ac-conversation';
import * as singlesRow from '../src/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-singles-prefix-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: '好的' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<{ name?: string; inject?: string[]; apply?: (c: Context) => void }> = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    sessionRow,
    datetimeRow,
    personaRow,
    conversationRow,
    singlesRow,
    memoryRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(
      row as any,
      sessionRow === (row as any) || singlesRow === (row as any) || memoryRow === (row as any)
        ? { root }
        : undefined,
    );
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).singles && (ctx as any).conversation && (ctx as any).session) break;
    await sleep(1);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

const AGENT = {
  id: 'a',
  model: 'mock-1',
  system: '你是测试员。',
  settings: { persona: { text: '冷静、精确、简短。' } },
};

afterEach(async () => {
  vi.useRealTimers();
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 正式对话的 LLM 调用（首条为 system；排除自动标题的单消息调用） */
function chatCalls(): LlmChatInput[] {
  return captured.filter((c) => c.messages[0]?.role === 'system');
}

describe('singles 前缀快照（M21 步骤 4）', () => {
  it('跨重启字节不变：同 sid 两次 boot 的 system 前缀逐字节一致 + 快照落盘', async () => {
    const root = tmpRoot();
    const first = await boot(root);
    first.ctx.agents.register(AGENT);
    const single = first.ctx.singles.create({ agentId: 'a' });
    await first.ctx.conversation.deliver('a', '第一句', { conversationId: single.id, sender: 'user' });
    // 快照已落盘：修订键 + 终态 system（persona 前置 + agent.system）
    const snapFile = path.join(root, 'singles', single.id, 'prefix-snapshot.json');
    expect(fs.existsSync(snapFile)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
    expect(snap.system).toContain('<persona>');
    expect(snap.system).toContain('你是测试员。');
    const sys1 = chatCalls()[0].messages[0];
    expect(sys1.role).toBe('system');
    // 日期不进 system（日快照行形态）
    expect(String(sys1.content)).not.toContain('[当前时间]');

    // "重启"：同 root 全新组合——system 前缀逐字节一致（D5 验收门）
    const second = await boot(root);
    second.ctx.agents.register(AGENT);
    await second.ctx.conversation.deliver('a', '重启后的问题', { conversationId: single.id, sender: 'user' });
    const sys2 = chatCalls().at(-1)!.messages[0];
    expect(JSON.stringify(sys2)).toBe(JSON.stringify(sys1));
  });

  it('datetime 日快照行：每信封恰一行、role user、位于当前消息之前；跨日仅换一行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register(AGENT);
    const single = ctx.singles.create({ agentId: 'a' });
    const t1 = new Date('2026-08-27T10:00:00');
    vi.useFakeTimers({ now: t1 });
    await ctx.conversation.deliver('a', '今日第一问', { conversationId: single.id, sender: 'user' });
    const env1 = chatCalls().at(-1)!.messages;
    const dateRows1 = env1.filter((m) => String(m.content).includes('[当前时间]'));
    expect(dateRows1).toHaveLength(1);
    expect(dateRows1[0].role).toBe('user');
    expect(env1.at(-2)).toEqual(dateRows1[0]); // 位于当前消息（末条）之前
    expect(env1[0].role).toBe('system');
    expect(String(env1[0].content)).not.toContain('[当前时间]');
    // 同日第二轮：仍恰一行、内容恒定
    await ctx.conversation.deliver('a', '今日第二问', { conversationId: single.id, sender: 'user' });
    const env2 = chatCalls().at(-1)!.messages;
    expect(env2.filter((m) => String(m.content).includes('[当前时间]'))).toHaveLength(1);
    expect(JSON.stringify(env2.filter((m) => String(m.content).includes('[当前时间]')))).toBe(
      JSON.stringify(dateRows1),
    );
    // 跨日：仅换新一行（仍恰一行；前缀 system 不变）
    vi.setSystemTime(new Date('2026-08-28T09:00:00'));
    await ctx.conversation.deliver('a', '次日一问', { conversationId: single.id, sender: 'user' });
    const env3 = chatCalls().at(-1)!.messages;
    const dateRows3 = env3.filter((m) => String(m.content).includes('[当前时间]'));
    expect(dateRows3).toHaveLength(1);
    expect(String(dateRows3[0].content)).toContain('2026-08-28');
    expect(JSON.stringify(env3[0])).toBe(JSON.stringify(env1[0])); // system 不随日变
  });

  it('修订失效显式：Agent 档案编辑 → 修订键变 → 快照重拍（一次 replace）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register(AGENT);
    const single = ctx.singles.create({ agentId: 'a' });
    await ctx.conversation.deliver('a', '第一句', { conversationId: single.id, sender: 'user' });
    const snapFile = path.join(root, 'singles', single.id, 'prefix-snapshot.json');
    const before = JSON.parse(fs.readFileSync(snapFile, 'utf-8')) as { revision: string; system: string };

    ctx.agents.reassign({ ...AGENT, system: '你是改版测试员。' });
    await ctx.conversation.deliver('a', '第二句', { conversationId: single.id, sender: 'user' });
    const after = JSON.parse(fs.readFileSync(snapFile, 'utf-8')) as { revision: string; system: string };
    expect(after.revision).not.toBe(before.revision); // 显式失效
    expect(after.system).toContain('你是改版测试员。');
    // 快照读取口（诊断面）
    expect(ctx.singles.prefixSnapshotOf(single.id)?.revision).toBe(after.revision);
  });

  it('记忆进修订键（memoryBucketOf 注入同口径）：对桶记忆外写 → 快照失效重拍 + <memory> 注入', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register(AGENT);
    const single = ctx.singles.create({ agentId: 'a' });
    await ctx.conversation.deliver('a', '第一句', { conversationId: single.id, sender: 'user' });
    const snapFile = path.join(root, 'singles', single.id, 'prefix-snapshot.json');
    const before = JSON.parse(fs.readFileSync(snapFile, 'utf-8')) as { revision: string; system: string };
    // 首轮 system 已含自描述记忆块：singles 重定向对用户对桶 + file 头
    expect(before.system).toContain('<memory file="memory/a~user.md">');
    // Agent 经 fs 工具外写对用户记忆（不经 ctx.memory——注入直读文件）
    fs.mkdirSync(path.join(root, 'files', 'a', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'a', 'memory', 'a~user.md'), '用户喜欢简短回复', 'utf-8');
    await ctx.conversation.deliver('a', '第二句', { conversationId: single.id, sender: 'user' });
    const after = JSON.parse(fs.readFileSync(snapFile, 'utf-8')) as { revision: string; system: string };
    expect(after.revision).not.toBe(before.revision); // 记忆变化 → 显式失效重拍
    expect(after.system).toContain('用户喜欢简短回复');
  });

  it('非 singles 会话不受影响：datetime 仍走 system（§4.4 原状）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register(AGENT);
    await ctx.conversation.deliver('a', '直答', { sender: 'user' }); // 对桶 a~user
    const env = chatCalls().at(-1)!.messages;
    expect(String(env[0].content)).toContain('[当前时间]'); // system 位（原状）
    expect(env.filter((m) => String(m.content).includes('[当前时间]'))).toHaveLength(1);
    // 且对桶 run 不产生快照副作用（gate 非 singles 早退）
    expect(fs.existsSync(path.join(root, 'singles')) ? fs.readdirSync(path.join(root, 'singles')).length : 0).toBe(0);
  });
});
