// ============================================================
// ac-agent-loop M11 工具执行面：执行身份装配 + 并发执行（mapLimit 5）
// + 语义化中断收束（ToolResult.interrupt → finish='interrupted'）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import type { ToolCall, ToolResult } from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';

interface Script {
  calls: LlmChatInput[];
  chunks: (input: LlmChatInput) => LlmStreamChunk[];
}

function textChunks(text: string): LlmStreamChunk[] {
  return [{ delta: text }, { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } }];
}

function toolCallChunks(...specs: Array<{ id: string; name: string; args: string }>): LlmStreamChunk[] {
  // 多工具调用一气流式（index 分片）
  const chunks: LlmStreamChunk[] = [{ delta: '', toolCalls: specs.map((s, i) => ({ index: i, id: s.id, name: s.name })) }];
  for (let i = 0; i < specs.length; i++) {
    chunks.push({ delta: '', toolCalls: [{ index: i, argumentsDelta: specs[i].args }] });
  }
  chunks.push({ delta: '', finish: 'tool_calls' });
  return chunks;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(scripts: Script[]) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  let counter = 0;
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
              const idx = Math.min(scripts.length - 1, counter++);
              scripts[idx].calls.push(input);
              yield* scripts[idx].chunks(input);
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
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
});

const USER = (text: string) => [{ role: 'user' as const, content: text }];

describe('M11 执行身份', () => {
  it('loop 装配 agentId/conversationId/toolCallId 进工具调用；signal 透传', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks({ id: 'c9', name: 'echo', args: '{}' }) };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    const seen: ToolCall[] = [];
    const controller = new AbortController();
    ctx.tools.register({
      name: 'echo',
      execute: (_args, call) => {
        seen.push(call);
        return { ok: true };
      },
    });
    await ctx.agentLoop.run({
      model: 'mock-1',
      messages: USER('q'),
      agent: 'writer',
      conversationId: 'writer',
      signal: controller.signal,
    });
    expect(seen[0]).toMatchObject({
      agentId: 'writer',
      conversationId: 'writer',
      toolCallId: 'c9',
      signal: controller.signal,
    });
  });

  it('身份缺省不装配（宿主直连 subagent 形态）', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks({ id: 'c1', name: 'echo', args: '{}' }) };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    const seen: ToolCall[] = [];
    ctx.tools.register({ name: 'echo', execute: (_args, call) => (seen.push(call), { ok: true }) });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(seen[0].agentId).toBeUndefined();
    expect(seen[0].conversationId).toBeUndefined();
  });
});

describe('M11 并发工具执行（mapLimit 5）', () => {
  it('同一步多工具并发执行；结果按 tool_calls 序回填', async () => {
    const s1: Script = {
      calls: [],
      chunks: () =>
        toolCallChunks(
          { id: 'a', name: 'slow', args: '{"v":"A"}' },
          { id: 'b', name: 'slow', args: '{"v":"B"}' },
          { id: 'c', name: 'slow', args: '{"v":"C"}' },
        ),
    };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    let active = 0;
    let maxActive = 0;
    ctx.tools.register({
      name: 'slow',
      execute: async (args) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { ok: true, output: args.v };
      },
    });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(maxActive).toBe(3); // 并发（串行时 maxActive 恒 1）
    expect(result.steps[0].toolResults.map((r) => r.output)).toEqual(['A', 'B', 'C']); // 序保持
    // 回填消息与 tool_calls 对齐
    const toolMsgs = s2.calls[0].messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['a', 'b', 'c']);
  });

  it('超过 5 个工具调用仍有界并发', async () => {
    const s1: Script = {
      calls: [],
      chunks: () =>
        toolCallChunks(
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `t${n}`, name: 'slow', args: `{}` })),
        ),
    };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    let active = 0;
    let maxActive = 0;
    ctx.tools.register({
      name: 'slow',
      execute: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { ok: true };
      },
    });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
  });
});

describe('M11 语义化中断通道', () => {
  it('ToolResult.interrupt → finish interrupted + interruptReason.toolInterrupt；模型不再续步', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks({ id: 'c1', name: 'reload', args: '{}' }) };
    const s2: Script = { calls: [], chunks: () => textChunks('不应出现的续步') };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({
      name: 'reload',
      execute: (): ToolResult => ({
        ok: true,
        output: '请求热重载',
        interrupt: { type: 'reload', reason: '插件清单变更' },
      }),
    });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('重载') });
    expect(result.finish).toBe('interrupted');
    expect(result.interruptReason).toMatchObject({
      type: 'tool-interrupt',
      toolInterrupt: { type: 'reload', reason: '插件清单变更' },
    });
    expect(result.interruptReason?.reason).toContain('reload');
    // 中断结果如实入步记录；模型未被再次调用
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].toolResults[0]).toMatchObject({ interrupt: { type: 'reload' } });
    expect(s2.calls).toHaveLength(0);
    // 步级时序锚（2026-09-02 顺序反馈）：步收束时盖章 epoch ms——落盘
    // steps[].ts 据此恢复 run 中途插行的渲染序
    expect(typeof result.steps[0].ts).toBe('number');
  });

  it('多工具并发下任一 interrupt 即收束', async () => {
    const s1: Script = {
      calls: [],
      chunks: () =>
        toolCallChunks(
          { id: 'a', name: 'plain', args: '{}' },
          { id: 'b', name: 'restart', args: '{}' },
        ),
    };
    const { ctx } = await boot([s1]);
    ctx.tools.register({ name: 'plain', execute: () => ({ ok: true }) });
    ctx.tools.register({
      name: 'restart',
      execute: (): ToolResult => ({ ok: true, interrupt: { type: 'system-restart' } }),
    });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('重启') });
    expect(result.finish).toBe('interrupted');
    expect(result.interruptReason?.toolInterrupt).toMatchObject({ type: 'system-restart' });
    // 两个结果都如实入档
    expect(result.steps[0].toolResults).toHaveLength(2);
  });
});
