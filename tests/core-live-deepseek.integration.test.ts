// ============================================================
// DeepSeek 实连冒烟测试（可选）
//
// 运行前提：设置环境变量 DEEPSEEK_API_KEY（对应模型池 deepseek-v4-flash 条目）。
// 未设置时整组跳过。API 与 Key 参考配置：
//   {
//     "provider": "deepseek",
//     "base_url": "https://api.deepseek.com",
//     "model": "deepseek-v4-flash",
//     "reasoning_effort": "high",
//     "thinking": true,
//     "logprobs": false,
//     "tool_choice": "auto"
//   }
//
// 注意：这是真实 API 调用，会产生 token 费用；默认跳过。
// ============================================================

import { describe, it, expect } from 'vitest';
import { createLLM } from '../src/core/llm';
import type { LLMConfig } from '../src/core/types';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';

const DEEPSEEK_V4_FLASH: LLMConfig = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  reasoning_effort: 'high',
  thinking: true,
  logprobs: false,
  tool_choice: 'auto',
  api_key: apiKey || '${DEEPSEEK_API_KEY}',
};

describe.skipIf(!apiKey)('DeepSeek 实连冒烟（需 DEEPSEEK_API_KEY）', () => {
  const llm = createLLM(DEEPSEEK_V4_FLASH);

  it('chat 非流式：返回内容与用量', async () => {
    const resp = await llm.chat({ messages: [{ role: 'user', content: '只回复两个字：明白' }] });
    expect(resp.content).toBeTruthy();
    expect(resp.finishReason).not.toBe('error');
    expect(resp.usage?.total_tokens).toBeGreaterThan(0);
  }, 60000);

  it('stream 流式：逐 token 累积内容', async () => {
    let got = '';
    const stream = llm.stream({ messages: [{ role: 'user', content: '从 1 数到 3，逗号分隔' }] });
    for await (const t of stream) {
      if (t.type === 'message_update' && t.delta) got += t.delta;
    }
    const resp = await stream.result();
    expect(got.length).toBeGreaterThan(0);
    expect(resp.content).toBeTruthy();
  }, 60000);

  it('思考模式：返回 reasoning 内容', async () => {
    const resp = await llm.chat({
      messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？只给结论' }],
      thinking: true,
    });
    // 模型可能选择不展示思考内容，不强断言；至少完成且非 error
    expect(resp.finishReason).not.toBe('error');
    expect(resp.content).toBeTruthy();
  }, 60000);
});
