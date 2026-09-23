// ============================================================
// 视图增量层退役（2026-11 根因消除）的核心回归：
// 2026-09-23 事故——run 以 error 收束（网络中断）后同进程续聊，上下文
// 丢失该 run 的全部 steps 轨迹（旧 error 分支只投错误行不投轨迹且视图
// 不失效）。视图层退役后：上下文每 run 从文件重派生，error 收束的
// settlement 段行完整可见——与重启后（session.history 文件派生）字节一致。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
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
import * as conversationRow from '../src/index';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = `${import.meta.dirname}/.tmp-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

/** 剧本 provider：调用 1 出工具调用；调用 2 抛网络错（fetch failed 模拟）；调用 3 回文本 */
function scriptedProvider() {
  let calls = 0;
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      calls += 1;
      if (calls === 1) {
        yield { delta: '', toolCalls: [{ index: 0, id: 'tc1', name: 'probe' }] };
        yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"q":"探"}' }] };
        yield { delta: '', finish: 'tool_calls' };
      } else if (calls === 2) {
        throw new Error('fetch failed ← ENOTFOUND: getaddrinfo ENOTFOUND open.bigmodel.cn');
      } else {
        yield { delta: '续聊回复' };
        yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
      }
    },
  });
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('error 收束续聊轨迹完整（2026-09-23 事故回归）', () => {
  it('run1 error 收束（带工具步）→ 续聊 run2 上下文含 run1 完整轨迹 ≡ history() 字节一致', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows = [
      toolsRow,
      llmRow,
      {
        name: 'mock-provider',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register('err-1', scriptedProvider(), { models: ['err-1'] });
        },
      },
      loopRow,
      agentsRow,
      routerRow,
      sessionRow,
      conversationRow,
    ] as Array<{ apply(ctx: Context): unknown } & object>;
    for (const row of rows) {
      const fiber = ctx.plugin(row as any, row as any === sessionRow ? { root } : undefined);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    ctx.tools.register({
      name: 'probe',
      description: '探测工具',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      async execute() {
        return { ok: true, output: '工具结果A' };
      },
    });
    ctx.agents.register({ id: 'a', model: 'err-1' }); // replayTrajectory 缺省开

    // run1：工具步完成后下一步 LLM 调用网络失败 → error 收束
    const out1 = await ctx.conversation.deliver('a', '网络会断的问题');
    expect(out1.kind).toBe('run');
    if (out1.kind === 'run') {
      expect(out1.result.finish).toBe('error');
      expect(out1.result.steps).toHaveLength(1); // 工具步已完成
    }

    // run2：断网恢复后续聊（同进程——事故场景）
    const out2 = await ctx.conversation.deliver('a', '继续，刚才网络中断');
    expect(out2.kind).toBe('run');

    // 核心断言 1：run2 上下文含 run1 的完整轨迹
    // （assistant tool_calls + tool 结果 + 错误行——不丢 steps）
    const msgs = captured.at(-1)!.messages;
    const contents = msgs.map((m) => m.content);
    expect(contents).toContain('网络会断的问题');
    expect(contents).toContain('继续，刚才网络中断');
    const toolRow = msgs.find((m) => m.role === 'tool');
    expect(toolRow).toMatchObject({ tool_call_id: 'tc1' });
    expect(String(toolRow!.content)).toContain('工具结果A');
    const asstWithCalls = msgs.find((m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls);
    expect(asstWithCalls).toBeDefined();
    // 错误行（error 收束的 context 行——user 语义位回放）
    expect(contents.some((c) => String(c).includes('fetch failed'))).toBe(true);

    // 核心断言 2：进程内上下文 ≡ history() 文件重派生（S3 字节一致）
    // run2 信封 = history 快照去掉本轮入站；对照 history() 去掉本轮入站/回复
    const replay = await ctx.session.history('a~user', { viewer: 'a' });
    const expected = replay.slice(0, -2);
    expect(JSON.stringify(msgs.slice(0, -1))).toBe(JSON.stringify(expected));
  });
});