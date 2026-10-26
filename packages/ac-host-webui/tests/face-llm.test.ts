// ============================================================
// face-llm.test.ts —— 模型发现面（cr-572）：probe/models 协议与错误分支
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import type { Context } from '@agentchat/cordis';
import { registerOpsFace } from '../src/face-ops.ts';

type Handler = (params: unknown) => unknown;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function collect(ctx: Context, dataRoot = 'sandbox/test-face-llm-' + process.pid): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerOpsFace({ registerRpc: (m, h) => { handlers.set(m, h); } }, ctx, { dataRoot });
  return handlers;
}

describe('模型发现面', () => {
  it('probe-models：GET <base_url>/models + Bearer 头，data/models 双形态归一去重排序', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    globalThis.fetch = (async (url: string, init: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init.headers?.authorization ?? '' });
      return { ok: true, json: async () => ({ data: [{ id: 'b' }, { id: 'a' }], models: [{ name: 'b' }, 'c'] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const handlers = collect({ get: () => undefined } as unknown as Context);
    const out = await handlers.get('llm/probe-models')!({ base_url: 'https://demo.example/v1/', api_key: 'sk-1' }) as { models: string[] };
    expect(out.models).toEqual(['a', 'b', 'c']);
    expect(seen[0]).toEqual({ url: 'https://demo.example/v1/models', auth: 'Bearer sk-1' });
  });

  it('probe-models：非 2xx 可读失败（不吞成空清单）', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch;
    const handlers = collect({ get: () => undefined } as unknown as Context);
    await expect(handlers.get('llm/probe-models')!({ base_url: 'https://x' })).rejects.toThrow(/401/);
  });

  it('llm/models：连接不存在 / 缺 base_url 都 fail-loud', async () => {
    const handlers = collect({ get: (key: string) => (key === 'config' ? { get: () => ({ solo: {} }), set: () => {} } : undefined) } as unknown as Context);
    await expect(handlers.get('llm/models')!({ name: 'ghost' })).rejects.toThrow(/连接不存在/);
    await expect(handlers.get('llm/models')!({ name: 'solo' })).rejects.toThrow(/缺 base_url/);
  });
});
