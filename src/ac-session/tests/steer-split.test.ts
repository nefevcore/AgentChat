// steer 中途注入的落盘回归（变体乙：busy 会话 steer → stash → 步边界切分落账）
// 走真实链：conversation.deliver(lane steer) → steerQueue → 步边界消费 → conversation/steered emit
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
import * as conversationRow from 'ac-conversation';
import * as sessionRow from 'ac-session';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
let tmp = '';

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

function toolThenText() {
  let n = 0;
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      if (n++ === 0) {
        yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'echo', argumentsDelta: '{"text":"x"}' }] } as never;
        yield { delta: '', finish: 'tool_calls' as const } as never;
      } else {
        yield { delta: 'done' };
        yield { delta: '', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } };
      }
    },
  });
}

describe('steer 中途注入（busy 会话切分落账，真实 deliver 链）', () => {
  it('工具执行期 deliver steer → 步边界消费 → 切分落账：user → 关闭行 → steer 行 → 终稿', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-steer-'));
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const row of [toolsRow, llmRow, { name: 'mock', inject: ['llm'], apply(c: Context) { c.llm.register('mock', toolThenText(), { models: ['mock-1'] }); } }, agentsRow, loopRow, routerRow, conversationRow] as unknown[]) {
      const fiber = ctx.plugin(row as never, {} as never);
      await fiber;
      fibers.push(fiber);
    }
    {
      const fiber = ctx.plugin(sessionRow, { root: tmp });
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 60)); // 阻塞窗口：确保 steer 投递时 run 活跃（busy 路径）
        return { ok: true, output: 'x' };
      },
    });
    // 主消息：真实 deliver（空闲路径——message-received 入账 user 行）
    const runPromise = ctx.conversation.deliver('a', 'start', { conversationId: 'a~user', sender: 'user' });
    // 等 run-started + 首步工具执行中（60ms 阻塞窗口内）投 steer——busy 路径
    await new Promise((r) => setTimeout(r, 30));
    await ctx.conversation.deliver('a', '中途补充：换个思路', { conversationId: 'a~user', sender: 'user', lane: 'next-step' });
    await runPromise;
    await new Promise((r) => setTimeout(r, 80));
    const raw = readFileSync(join(tmp, 'sessions', 'a~user', 'messages.jsonl'), 'utf-8');
    // 核心：steer 消息必须落盘（切分插入行——变体乙）
    expect(raw).toContain('中途补充：换个思路');
    // 顺序：user → 关闭行(run 键) → steer 行 → 收束行（落盘自然序 = 回放序）
    const lines = raw.split('\n').filter((x) => x.trim());
    const idxOf = (needle: string) => lines.findIndex((x) => x.includes(needle));
    const iUser = idxOf('"content":"start"');
    const iClosed = lines.findIndex((x) => x.includes('"run":"run-') && !x.includes('"partial"'));
    const iSteer = idxOf('中途补充');
    const iFinal = idxOf('"content":"done"');
    expect(iUser).toBeGreaterThanOrEqual(0);
    expect(iClosed).toBeGreaterThan(iUser);
    expect(iSteer).toBeGreaterThan(iClosed);
    expect(iFinal).toBeGreaterThan(iSteer);
  });
});
