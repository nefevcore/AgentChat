// 一次性验证脚本：memory_append 工具在真实 run 内是否可用（跑完即删）
import { Context } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as memoryRow from 'ac-memory';

const ctx = new Context();
for (const row of [toolsRow, llmRow] as unknown[]) await ctx.plugin(row as never);
const mockRow = {
  name: 'mock',
  inject: ['llm'],
  apply(c: Context) {
    let calls = 0;
    c.llm.register(
      'mock',
      () => ({
        async *stream(input: never) {
          if (calls++ === 0) {
            yield { delta: '', toolCalls: [{ index: 0, id: 't1', name: 'memory_append' }] };
            yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: JSON.stringify({ line: '偏好简洁' }) }] };
            yield { delta: '', finish: 'tool_calls' };
          } else {
            yield { delta: 'ok' };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          }
        },
      }),
      { models: ['mock-1'] },
    );
  },
};
await ctx.plugin(mockRow as never);
await ctx.plugin(loopRow as never);
await ctx.plugin(memoryRow as never, { persist: false });
for (let i = 0; i < 500; i++) {
  if ((ctx as never as Record<string, unknown>).tools && (ctx as never as Record<string, unknown>).llm &&
      (ctx as never as Record<string, unknown>).agentLoop && (ctx as never as Record<string, unknown>).memory) break;
  await new Promise((r) => setTimeout(r, 2));
}
const res = await ctx.agentLoop.run({
  agent: 'a1',
  model: 'mock-1',
  conversationId: 'a1~user',
  messages: [{ role: 'user', content: '记住一件事' }],
});
console.log('finish:', res.finish, 'steps:', res.steps.length);
console.log('tool result:', JSON.stringify(res.steps[0]?.toolResults?.[0]));
console.log('memory:', JSON.stringify(ctx.memory.get('a1~user')));
process.exit(0);
