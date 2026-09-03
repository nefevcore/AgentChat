// ============================================================
// ac-session：多模态附件引用（attachments）落盘 + 回放透传
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk, LlmMessage } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-att-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

async function boot(root: string) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              captured.push(input);
              yield { delta: '收到图' };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    sessionRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, { root });
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).llm && (ctx as any).agentLoop &&
        (ctx as any).agents && (ctx as any).router && (ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('attachments 落盘 + 回放（多模态一期）', () => {
  it('带图入站：provider 收到 attachments、落盘行携带、history 回放带回', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const inbound: LlmMessage = {
      role: 'user',
      content: '看这张图\n[附件] files/user/_tmp/x.png',
      attachments: [{ kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png', detail: 'low' }],
    };
    await ctx.router.send('a', inbound);

    // ① 直达 LLM 的请求保留 attachments 引用（物化在 provider 适配层）
    const firstUser = captured[0].messages.find((m) => m.role === 'user')!;
    expect(firstUser.attachments).toEqual([
      { kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png', detail: 'low' },
    ]);

    // ② 落盘行携带 attachments（只存引用，不内联 base64）
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const line = JSON.parse(fs.readFileSync(file, 'utf-8').trim().split('\n')[1]);
    expect(line.role).toBe('agent');
    expect(line.attachments).toEqual([
      { kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png', detail: 'low' },
    ]);

    // ③ 回放投影（viewer 视角）带回 attachments——下一轮 run 历史仍可见
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log[0]).toMatchObject({ role: 'user', name: 'user' });
    expect(log[0].attachments).toEqual([
      { kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png', detail: 'low' },
    ]);

    // ④ 第二轮（历史回放投喂）：到达 LLM 的历史 user 行仍带附件引用
    await ctx.router.send('a', '再看看', { history: log });
    const secondRun = captured[1].messages;
    expect(secondRun[0]).toMatchObject({ role: 'user' });
    expect(secondRun[0].attachments).toBeDefined();
  });

  it('records() 读取与重解析保持 attachments（UI 刷新恢复源）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const dir = path.join(root, 'sessions', 'a~user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ type: 'session-header', version: 1, createdAt: 't0' }),
        JSON.stringify({
          role: 'agent', content: '看图', agent_id: 'user', message_id: 'm1', timestamp: 't1', seq: 1,
          attachments: [{ kind: 'image', ref: 'files/user/_tmp/a.jpg' }],
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const records = await ctx.session.records('a~user');
    expect(records[0].attachments).toEqual([{ kind: 'image', ref: 'files/user/_tmp/a.jpg' }]);
  });

  it('无附件行不产生 attachments 键（旧数据零回归）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const dir = path.join(root, 'sessions', 'a~user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ type: 'session-header', version: 1, createdAt: 't0' }),
        JSON.stringify({ role: 'agent', content: '纯文本', agent_id: 'user', message_id: 'm1', timestamp: 't1', seq: 1 }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log[0]).not.toHaveProperty('attachments');
  });
});
