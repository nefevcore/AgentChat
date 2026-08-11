// ============================================================
// 思考模式空 content 兜底恢复回归测试（2026-08-10）
//
// 背景：DeepSeek 思考模式（deepseek-v4-pro）边缘行为——个别请求下模型把最终回答
// 留在 reasoning_content、content 返回为空（deloitte-dev-kic/user 会话实测：
// contentLen=0、reasoningLen=2240 且结尾为完整回答，前端只剩思考块、回复丢失）。
//
// 修复：src/core/llm/openai.ts _runStream 收尾时，若 content 为空但 reasoning 非空
// 且无工具调用，则把 reasoning 提升为 content 并补发 message 事件。
// 本测试用 mock fetch 模拟 SSE 流验证三条路径：
//   1. 空 content + 非空 reasoning + 无工具调用 → 提升为 content
//   2. 有工具调用（reasoning 只是思考）→ 不提升
//   3. 正常 content 非空 → 不提升、reasoning 保留
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIChatLLM } from '../src/core/llm/openai';
import type { LLMRequest, LLMResponse } from '../src/core/types';

const BASE = 'https://mock-llm.test/v1';
const originalFetch = globalThis.fetch;

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
}

/** 空 content + 非空 reasoning + 无工具调用（触发兜底提升） */
function mockAnswerInThinking(): typeof fetch {
  const lines = [
    sse({ choices: [{ delta: { reasoning_content: '让我分析一下用户的问题，' } }] }),
    sse({ choices: [{ delta: { reasoning_content: '结论是：可以，一次查询即可。' } }] }),
    sse({ choices: [{ delta: {} }] }),
    'data: [DONE]\n\n',
  ];
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/models')) return new Response('{}', { status: 200 });
    return new Response(sseStream(lines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

/** 有工具调用 + reasoning（不触发兜底） */
function mockToolCallTurn(): typeof fetch {
  const lines = [
    sse({ choices: [{ delta: { reasoning_content: '需要先查表结构，再调用工具' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'query', arguments: '{"sql":"SELECT 1"}' } }] } }] }),
    sse({ choices: [{ delta: {} }] }),
    'data: [DONE]\n\n',
  ];
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/models')) return new Response('{}', { status: 200 });
    return new Response(sseStream(lines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

/** 正常：thinking → content 都有（不触发兜底） */
function mockNormalTurn(): typeof fetch {
  const lines = [
    sse({ choices: [{ delta: { reasoning_content: '思考过程一' } }] }),
    sse({ choices: [{ delta: { reasoning_content: '' } }] }),
    sse({ choices: [{ delta: { content: '正常回答内容' } }] }),
    sse({ choices: [{ delta: {} }] }),
    'data: [DONE]\n\n',
  ];
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/models')) return new Response('{}', { status: 200 });
    return new Response(sseStream(lines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function makeLLM(): OpenAIChatLLM {
  return new OpenAIChatLLM({ apiKey: 'sk-test', baseURL: BASE, model: 'deepseek-v4-pro' });
}

const req: LLMRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('OpenAIChatLLM 思考模式空 content 兜底恢复', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('content 为空但 reasoning 非空且无工具调用 → 提升为 content（回复不丢失）', async () => {
    globalThis.fetch = mockAnswerInThinking();
    const llm = makeLLM();
    const stream = llm.stream(req);
    const types: string[] = [];
    let updateText = '';
    for await (const t of stream) {
      types.push(t.type);
      if (t.type === 'message_update' && t.delta) updateText += t.delta;
    }
    const resp: LLMResponse = await stream.result();

    // 兜底后应补发 message 事件（顺序：thinking_end → message_start/update/end）
    const tail = types.slice(-3);
    expect(tail).toEqual(['message_start', 'message_update', 'message_end']);
    expect(types[types.length - 4]).toBe('thinking_end');

    // 最终结果：content 被提升、reasoning 清空
    expect(resp.content).toContain('结论是：可以，一次查询即可。');
    expect(resp.reasoning).toBeUndefined();
    expect(updateText).toContain('结论是：可以，一次查询即可。');
    expect(resp.finishReason).toBe('stop');
  });

  it('有工具调用时不提升（reasoning 只是思考，不是回答）', async () => {
    globalThis.fetch = mockToolCallTurn();
    const llm = makeLLM();
    const resp = await llm.chat(req);

    expect(resp.content).toBeNull();
    expect(resp.reasoning).toContain('需要先查表结构');
    expect(resp.toolCalls.length).toBe(1);
    expect(resp.finishReason).toBe('tool_calls');
  });

  it('正常 content 非空时不提升，reasoning 保留', async () => {
    globalThis.fetch = mockNormalTurn();
    const llm = makeLLM();
    const resp = await llm.chat(req);

    expect(resp.content).toBe('正常回答内容');
    expect(resp.reasoning).toContain('思考过程一');
    expect(resp.finishReason).toBe('stop');
  });
});
