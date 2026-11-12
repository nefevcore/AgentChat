import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmProvider, LlmStreamChunk } from 'ac-llm';
import * as llmRow from '../src/index';

// ---- chat() 中止/错误收敛（cr-766 / cr-1042）：流不完整不再丢弃已聚合内容 ----
// 中断/失败时已流出的思考/正文是会话事实——部分聚合（aborted: true）返回，
// 调用方（loop）据此构造保真步记录（落盘）。流中途失败（cr-1042）额外带
// streamError 供归因。reasoningMs 在中止时以最后 reasoning 片时刻收口
//（不把 abort 往返延迟计入思考时长）。

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 流中段 abort 的 provider：产出 2 个 reasoning 片后中止 signal 并抛
 *  AbortError（fetch 现实语义——AbortError 由 signal 触发，signal 必已
 *  aborted，收敛判定按此对偶） */
function abortingProvider(controller: AbortController): LlmProvider {
  return {
    stream: async function* (): AsyncIterable<LlmStreamChunk> {
      yield { delta: '', reasoning: '想了一半' };
      await sleep(30);
      yield { delta: '', reasoning: '又想了一些' };
      await sleep(30);
      controller.abort(new Error('stop 请求'));
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
}

function providerRow(name: string, provider: LlmProvider) {
  return {
    name: `mock-${name}`,
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(name, () => provider, { models: [name] });
    },
  };
}

const USER = [{ role: 'user' as const, content: 'hi' }];
const booted: { fibers: Fiber[] }[] = [];

async function boot(rows: unknown[]) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const router = ctx.plugin(llmRow);
  await router;
  fibers.push(router);
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ fibers });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('chat 聚合：中止收敛（cr-766）', () => {
  it('signal 中止 → 部分聚合返回（aborted + reasoning 保留），不上抛', async () => {
    const controller = new AbortController();
    const ctx = await boot([providerRow('aborter', abortingProvider(controller))]);
    const result = await ctx.llm.chat({
      provider: 'aborter', model: 'aborter', messages: USER,
      signal: controller.signal,
    });
    // 两个 reasoning 片都在——中断前模型已流出的思考不蒸发
    expect(result.aborted).toBe(true);
    expect(result.reasoning).toBe('想了一半又想了一些');
    // 思考相位以最后 reasoning 片收口（≥60ms：两片间隔；abort 后无正文）
    expect(result.reasoningMs).toBeGreaterThanOrEqual(30);
  });

  it('signal 已中止（首块前）→ 空部分结果（aborted，无内容）', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop 请求'));
    const ctx = await boot([providerRow('late', abortingProvider(new AbortController()))]);
    const result = await ctx.llm.chat({
      provider: 'late', model: 'late', messages: USER,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.text).toBe('');
  });

  it('流中途失败（已产出内容）→ 部分聚合返回（aborted + streamError），不上抛（cr-1042）', async () => {
    const failing: LlmProvider = {
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { delta: '', reasoning: '想了一半' };
        yield { delta: '部分正文' };
        throw new Error('ECONNRESET 网络故障');
      },
    };
    const ctx = await boot([providerRow('failing', failing)]);
    const result = await ctx.llm.chat({ provider: 'failing', model: 'failing', messages: USER });
    // 失败前模型已流出的思考/正文不蒸发；streamError 供调用方归因错误
    expect(result.aborted).toBe(true);
    expect(result.streamError).toContain('ECONNRESET');
    expect(result.reasoning).toBe('想了一半');
    expect(result.text).toBe('部分正文');
  });

  it('首块前失败（无内容可保真）→ 照常上抛', async () => {
    const failing: LlmProvider = {
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        throw new Error('ECONNRESET 网络故障');
      },
    };
    const ctx = await boot([providerRow('early-fail', failing)]);
    await expect(ctx.llm.chat({ provider: 'early-fail', model: 'early-fail', messages: USER }))
      .rejects.toThrow('ECONNRESET');
  });

  it('正文相位 textMs：首个 delta → 流末', async () => {
    const texter: LlmProvider = {
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { delta: '', reasoning: '想' };
        yield { delta: '正', waitMs: undefined } as LlmStreamChunk;
        await sleep(60);
        yield { delta: '文', finish: 'stop' };
      },
    };
    const ctx = await boot([providerRow('texter', texter)]);
    const result = await ctx.llm.chat({ provider: 'texter', model: 'texter', messages: USER });
    expect(result.text).toBe('正文');
    expect(result.textMs).toBeGreaterThanOrEqual(50);
    expect(result.reasoningMs!).toBeLessThan(50); // 思考→正文即时切换
  });
});
