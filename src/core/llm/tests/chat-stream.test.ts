// ============================================================
// src/core/llm/chat-stream 单元测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { ChatStream } from '../src/chat-stream';
import type { StreamToken } from '../src/contracts';

const DONE = { content: '你好', toolCalls: [], finishReason: 'stop' as const };

describe('ChatStream', () => {
  it('push 后逐 token 消费', async () => {
    const cs = new ChatStream();
    cs.push({ type: 'message_start', partial: { content: '', reasoning: '' } });
    cs.push({ type: 'message_update', delta: '你', partial: { content: '你', reasoning: '' } });
    cs.done(DONE);
    const seen: string[] = [];
    for await (const t of cs) seen.push(t.type);
    expect(seen).toEqual(['message_start', 'message_update']);
  });

  it('result() 返回 done 传入的最终结果', async () => {
    const cs = new ChatStream();
    cs.done(DONE);
    await expect(cs.result()).resolves.toMatchObject({ content: '你好', finishReason: 'stop' });
  });

  it('error 先推送 error token 再标记结束', async () => {
    const cs = new ChatStream();
    cs.error({ content: null, toolCalls: [], finishReason: 'error' }, 'boom');
    const seen: StreamToken[] = [];
    for await (const t of cs) seen.push(t);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('error');
    expect(seen[0].error).toBe('boom');
    const r = await cs.result();
    expect(r.finishReason).toBe('error');
  });

  it('done 后 push 被忽略', async () => {
    const cs = new ChatStream();
    cs.done(DONE);
    cs.push({ type: 'message_update', delta: 'x', partial: { content: 'x', reasoning: '' } });
    const seen: string[] = [];
    for await (const t of cs) seen.push(t.type);
    expect(seen).toHaveLength(0);
  });

  it('先等待迭代再 push（异步唤醒）', async () => {
    const cs = new ChatStream();
    const iter = cs[Symbol.asyncIterator]();
    const pending = iter.next().then(r => r.value);
    cs.push({ type: 'message_start', partial: { content: '', reasoning: '' } });
    const v = await pending;
    expect(v.type).toBe('message_start');
    cs.done(DONE);
  });

  it('重复 done 幂等', async () => {
    const cs = new ChatStream();
    cs.done(DONE);
    cs.done({ content: '第二次', toolCalls: [], finishReason: 'stop' });
    await expect(cs.result()).resolves.toMatchObject({ content: '你好' });
  });
});
