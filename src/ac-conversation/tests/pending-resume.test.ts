// ============================================================
// ac-conversation 待投持久化（M15）：next-turn 入队落盘 · 消费重写 ·
// 二次 boot 回放恢复
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from '../src/index.ts';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as toolsRow from 'ac-tools';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-conv-pending-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

/** 手动闸门 provider（busy 控制） */
function gatedLlm() {
  const gates: Array<() => void> = [];
  return {
    row() {
      return {
        name: 'mock-gated-llm',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (_: LlmChatInput): AsyncIterable<LlmStreamChunk> {
                await new Promise<void>((r) => gates.push(r));
                yield { delta: '回复' };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              },
            }),
            { models: ['mock-1'] },
          );
        },
      };
    },
    /** 放行当前挂起的调用（无挂起则等下一个挂起出现后放行——链跑安全） */
    async releaseNext() {
      for (let i = 0; i < 500; i++) {
        if (gates.length > 0) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      gates.splice(0).forEach((r) => r());
    },
  };
}

async function boot(root?: string) {
  const m = gatedLlm();
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    VendorTimer,
    toolsRow,
    llmRow,
    m.row() as any,
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
  ];
  for (const row of rows) {
    const isConv = (row as { name?: string }).name === 'ac-conversation';
    const fiber =
      isConv && root !== undefined ? ctx.plugin(row as any, { root }) : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).conversation) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers, m };
}

async function disposeAll() {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
}

afterEach(async () => {
  await disposeAll();
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-conversation 待投持久化（M15 最小闭环）', () => {
  it('busy 时 next-turn 入队 → 落盘 pending-<handle>.jsonl；消费后文件清除', async () => {
    const root = tmpRoot();
    const { ctx, m } = await boot(root);
    const p1 = ctx.conversation.deliver('a', '占住会话');
    await new Promise((r) => setTimeout(r, 20)); // a 忙（run1 卡闸门）
    const out = await ctx.conversation.deliver('a', '排队的消息', { lane: 'next-turn' });
    expect(out.kind).toBe('queued');
    const file = path.join(root, 'conversation', 'pending-a~user~a.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).message.content).toBe('排队的消息');

    // 链跑：run1 与 run2 都要过闸门——逐拍放行再等收尾
    await m.releaseNext();
    await m.releaseNext();
    await p1;
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(file)).toBe(false); // 消费完清盘
  });

  it('盘上残留（崩溃/42 中断后形态）→ 二次 boot 回放恢复并链跑', async () => {
    const root = tmpRoot();
    // 直接构造崩溃残留（崩溃模拟的等价简化：入队后未消费即退出）
    fs.mkdirSync(path.join(root, 'conversation'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'conversation', 'pending-a~user~a.jsonl'),
      `${JSON.stringify({ message: { role: 'user', content: '崩溃前排队' }, sender: 'user' })}\n`,
      'utf-8',
    );

    const { ctx, m } = await boot(root);
    const p = ctx.conversation.deliver('a', '恢复后的新消息'); // run1 卡闸门
    await new Promise((r) => setTimeout(r, 20));
    await m.releaseNext();
    await m.releaseNext(); // run1 + 链跑 run2（消费恢复的待投）
    await p;
    await new Promise((r) => setTimeout(r, 50));
    // 待投被消费：盘清空
    expect(fs.existsSync(path.join(root, 'conversation', 'pending-a~user~a.jsonl'))).toBe(false);
  });

  it('无 root = 纯内存（现有语义不变，不落盘）', async () => {
    const { ctx, m } = await boot();
    const p1 = ctx.conversation.deliver('a', '占住');
    await new Promise((r) => setTimeout(r, 20));
    const out = await ctx.conversation.deliver('a', '排队', { lane: 'next-turn' });
    expect(out.kind).toBe('queued');
    await m.releaseNext();
    await m.releaseNext();
    await p1;
    await new Promise((r) => setTimeout(r, 30));
  });
});
