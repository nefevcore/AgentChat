// ============================================================
// ac-openai-completions：per-request headers 传输层键（单次覆盖构造
// 默认、同名覆盖、序列化前剥离不进 body）——2026-09 会话亲和头支持
// ============================================================
import { describe, it, expect } from 'vitest';
import { OpenAICompletions } from '../src/index.ts';

/** SSE 假 fetch：捕获请求头与 body，返回单 chunk 流 */
function captureFetch() {
  const seen: Array<{ headers: Record<string, string>; body: unknown }> = [];
  const encoder = new TextEncoder();
  const fake: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
    return new Response(encoder.encode(sse), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { seen, fake };
}

describe('OpenAICompletions per-request headers', () => {
  it('单次 headers 并入请求且同名覆盖构造默认', async () => {
    const { seen, fake } = captureFetch();
    const c = new OpenAICompletions({ baseUrl: 'https://gw/v1', headers: { 'x-static': 'a', 'x-both': 'ctor' }, fetchImpl: fake });
    await c.chat({ model: 'm', messages: [{ role: 'user', content: '1' }], headers: { 'x-opencode-session': 'sess-1', 'x-both': 'req' } });
    expect(seen[0].headers['x-static']).toBe('a');
    expect(seen[0].headers['x-both']).toBe('req'); // 单次覆盖构造默认
    expect(seen[0].headers['x-opencode-session']).toBe('sess-1');
  });

  it('headers 是传输层键——剥离后不进请求体', async () => {
    const { seen, fake } = captureFetch();
    const c = new OpenAICompletions({ baseUrl: 'https://gw/v1', fetchImpl: fake });
    await c.chat({ model: 'm', messages: [{ role: 'user', content: '1' }], headers: { 'x-session': 's' } });
    expect((seen[0].body as Record<string, unknown>).headers).toBeUndefined();
    expect(JSON.stringify(seen[0].body)).not.toContain('x-session');
  });

  it('listModels 单次 headers 并入', async () => {
    const seen: Array<Record<string, string>> = [];
    const fake: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    }) as typeof fetch;
    const c = new OpenAICompletions({ baseUrl: 'https://gw/v1', headers: { 'x-static': 'a' }, fetchImpl: fake });
    await c.listModels({ headers: { 'x-session': 's' } });
    expect(seen[0]['x-static']).toBe('a');
    expect(seen[0]['x-session']).toBe('s');
  });
});