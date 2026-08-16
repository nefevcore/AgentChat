// ============================================================
// ask_questions 工具测试 —— ToolExecutionContext 注入与永久等待
// ============================================================

import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import { makeInteractionTools } from '../src';

describe('ask_questions × ToolExecutionContext', () => {
  it('convKey 与 correlationId 优先取 loop 注入的执行上下文', async () => {
    let received: any;
    const services: ToolContext = {
      interaction: {
        async askQuestions(opts) {
          received = opts;
          return ['A'];
        },
      },
    };
    const config = { agent_id: 'a' } as AgentConfig;
    const [tool] = makeInteractionTools(config, services);
    expect(tool.name).toBe('ask_questions');

    const raw = await tool.execute(
      { questions: [{ question: 'Q', options: ['A'] }] },
      undefined,
      undefined,
      { toolCallId: 'call_1', dialogId: 'chat~user~a', agentId: 'a' },
    );
    expect(raw).toBe(JSON.stringify({
      status: 'ok',
      data: { answers: ['A'], questions: [{ question: 'Q', options: ['A'] }] },
    }));
    expect(received).toMatchObject({
      agentId: 'a',
      convKey: 'chat~user~a',
      correlationId: 'call_1',
    });
  });

  it('timeout_ms=0 透传（永久等待）；缺省仍为 120000', async () => {
    const seen: number[] = [];
    const services: ToolContext = {
      interaction: {
        async askQuestions(opts) {
          seen.push(opts.timeoutMs ?? -1);
          return ['A'];
        },
      },
    };
    const tool = makeInteractionTools({ agent_id: 'a' } as AgentConfig, services)[0];

    await tool.execute({ questions: [{ question: 'Q', options: ['A'] }], timeout_ms: 0 });
    await tool.execute({ questions: [{ question: 'Q', options: ['A'] }] });
    expect(seen).toEqual([0, 120000]);
  });
});
