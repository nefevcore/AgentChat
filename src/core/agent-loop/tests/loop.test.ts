// ============================================================
// src/core/loop 单元测试 —— ReAct 编排纯函数 run(ctx)
//
// 用脚本化 mock LLM 覆盖：
//   · 基本回复（无工具）         · 工具调用循环（assistant→tool→assistant）
//   · maxSteps 步数保护          · abort 前置中断
//   · steer 注入与消费            · LLM 错误（含网络错误回调）
//   · 拦截器管道                 · 工具异常 → error tool 消息
//   · ToolInterrupt → 语义化中断  · usage 累计 / emit 事件流
// ============================================================

import { describe, it, expect } from 'vitest';
import { run } from '../src/loop';
import { createContext, pushSteer } from '../src/context';
import { hashDialogId } from '../src/hash';
import type { CurrentContext } from '../src/context';
import type { Tool } from '../src/contracts';
import type { LLMProvider, LLMRequest, LLMResponse } from '@agentchat/llm';
import type { LLMRequestMessage } from '@agentchat/types';
import { ToolInterrupt } from '../src/interrupt';
import { ChatStream } from '@agentchat/llm/src/chat-stream';

// ---- 脚本化 mock LLM：handler 按调用顺序返回响应 ----
function makeMockLLM(
  handler: (req: LLMRequest, callIndex: number) => LLMResponse | Promise<LLMResponse>,
): LLMProvider {
  let callIndex = 0;
  return {
    model: 'mock-model',
    async chat(req) {
      const resp = await handler(req, callIndex);
      callIndex++;
      return resp;
    },
    stream(req) {
      const cs = new ChatStream();
      void (async () => {
        const resp = await handler(req, callIndex);
        callIndex++;
        if (resp.reasoning) {
          cs.push({ type: 'thinking_start', partial: { content: '', reasoning: '' } });
          cs.push({ type: 'thinking_end', partial: { content: resp.content ?? '', reasoning: resp.reasoning } });
        }
        if (resp.content) {
          cs.push({ type: 'message_start', partial: { content: '', reasoning: '' } });
          cs.push({ type: 'message_update', delta: resp.content, partial: { content: resp.content, reasoning: resp.reasoning ?? '' } });
          cs.push({ type: 'message_end', partial: { content: resp.content, reasoning: resp.reasoning ?? '' } });
        }
        // 流式错误路径：finishReason='error' 经 error token 传递（对齐真实 provider 契约）
        if (resp.finishReason === 'error') {
          cs.push({ type: 'error', error: 'mock stream error', partial: { content: resp.content ?? '', reasoning: resp.reasoning ?? '' } });
        }
        cs.done(resp);
      })().catch((err) => cs.error({ content: null, toolCalls: [], finishReason: 'error' }, String(err)));
      return cs;
    },
    toProviderMessages: (msgs) => msgs as any[],
    fromProviderMessages: (msgs) => msgs as any[],
  };
}

function mkTool(name: string, execute: Tool['execute']): Tool {
  return {
    name, label: name, ns: `tool.${name}`,
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute,
  };
}

const userMsg = { role: 'user' as const, content: '你好' };

describe('run —— 基本流程', () => {
  it('无工具：直接返回最终内容，产出 assistant 消息', async () => {
    const llm = makeMockLLM(() => ({ content: '你好，我是助手', toolCalls: [], finishReason: 'stop' }));
    const result = await run(createContext({
      llm, systemPrompt: '你是助手', history: [], currentMessage: userMsg, tools: new Map(),
    }));
    expect(result.content).toBe('你好，我是助手');
    expect(result.interrupted).toBe(false);
    expect(result.interruptReason).toBeUndefined();
    // 产出消息序列：用户提问 + assistant（提问随 result.messages 落盘）
    expect(result.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(result.messages[0].content).toBe('你好');
    expect(result.messages[1].content).toBe('你好，我是助手');
  });

  it('工具调用循环：assistant(tool_calls) → tool → assistant(最终)', async () => {
    const calls: string[] = [];
    const llm = makeMockLLM((req, i) => {
      calls.push(req.messages.map(m => m.role).join(','));
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'call_1', name: 'add', arguments: { a: 1, b: 2 } }], finishReason: 'tool_calls' };
      }
      return { content: '结果是 3', toolCalls: [], finishReason: 'stop' };
    });
    const tool = mkTool('add', async (args) => String((args.a ?? 0) + (args.b ?? 0)));
    const result = await run(createContext({
      llm, systemPrompt: '你是助手', history: [], currentMessage: userMsg,
      tools: new Map([['add', tool]]),
    }));

    expect(result.content).toBe('结果是 3');
    expect(result.interrupted).toBe(false);
    // 产出消息序列：user(提问) → assistant(tool_calls) → tool(结果) → assistant(最终)
    expect(result.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.messages[2].content).toBe('3');
    expect(result.messages[2].tool_call_id).toBe('call_1');
    // 第二次 LLM 调用应收到 tool 结果（配对成功）
    expect(calls[1]).toContain('tool');
  });

  it('多个工具调用：全部执行完，但同一时刻最多 5 个并发', async () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ id: `call_${i}`, name: `tool${i}`, arguments: {} }));
    let active = 0;
    let maxActive = 0;
    const executed = new Set<number>();
    const llm = makeMockLLM((_req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: calls, finishReason: 'tool_calls' };
      }
      return { content: '全部完成', toolCalls: [], finishReason: 'stop' };
    });
    const tools = new Map(calls.map((tc, i) => [tc.name, mkTool(tc.name, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      executed.add(i);
      active--;
      return `result${i}`;
    })]));

    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools,
    }));

    // 限制并发不代表丢弃任务：8 个工具调用必须全部执行
    expect(executed.size).toBe(8);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(result.messages.filter(m => m.role === 'tool')).toHaveLength(8);
    expect(result.content).toBe('全部完成');
  });

  it('toolExecutionEndHook 变换：工具结果在写入消息前被替换（脱敏挂点）', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const llm = makeMockLLM((_req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'x' } }], finishReason: 'tool_calls' };
      }
      return { content: '完成', toolCalls: [], finishReason: 'stop' };
    });
    const tool = mkTool('read', async () => JSON.stringify({ status: 'ok', data: { content: secret } }));
    const seenHooks: string[] = [];
    const result = await run(createContext({
      llm, systemPrompt: '你是助手', history: [], currentMessage: userMsg,
      tools: new Map([['read', tool]]),
      toolExecutionEndHook: [async (outcome) => {
        seenHooks.push(outcome.toolName);
        const raw = typeof outcome.result === 'string' ? outcome.result : outcome.result?.content ?? '';
        return raw.split(secret).join('***');
      }],
    }));

    // tool 消息内容已变换（toolExecutionEndHook 在插入消息前生效）
    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toContain('***');
    expect(toolMsg?.content).not.toContain(secret);
    // 挂点被调用且收到工具名
    expect(seenHooks).toContain('read');
  });

  it('history 与 currentMessage 装配进 LLM 请求', async () => {
    // 注意：messages 数组是 loop 的活引用（循环内原地追加），需在调用时快照角色
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const llm = makeMockLLM((req) => {
      seen.push(req.messages.map(m => ({ role: m.role, content: m.content })));
      return { content: 'ok', toolCalls: [], finishReason: 'stop' };
    });
    await run(createContext({
      llm, systemPrompt: '系统提示', history: [{ role: 'user', content: '历史' }],
      currentMessage: userMsg, tools: new Map(),
    }));
    expect(seen[0].map(m => m.role)).toEqual(['system', 'user', 'user']);
    expect(seen[0][0].content).toBe('系统提示');
    expect(seen[0][2].content).toBe('你好');
  });

  it('dialogId/thinking 透传至 LLM 请求', async () => {
    const seen: LLMRequest[] = [];
    const llm = makeMockLLM((req) => {
      seen.push(req);
      return { content: 'ok', toolCalls: [], finishReason: 'stop' };
    });
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      deepThink: false,
      dialogId: 'user__assistant-a',
    }));
    expect(seen[0].userId).toBe(hashDialogId('user__assistant-a'));
    expect(seen[0].thinking).toBe(false);
  });
});

describe('run —— 中断与保护', () => {
  it('signal 已 abort：立即返回 user-abort 中断', async () => {
    const ac = new AbortController();
    ac.abort();
    const llm = makeMockLLM(() => ({ content: '不应调用', toolCalls: [], finishReason: 'stop' }));
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(), signal: ac.signal,
    }));
    expect(result.interrupted).toBe(true);
    expect(result.interruptReason?.type).toBe('user-abort');
    expect(result.content).toBe('');
    expect(result.messages).toHaveLength(0);
  });

  it('maxSteps 步数保护：工具死循环在达到上限后终止', async () => {
    const llm = makeMockLLM(() => ({
      content: '', toolCalls: [{ id: 'c', name: 'loop', arguments: {} }], finishReason: 'tool_calls',
    }));
    const tool = mkTool('loop', async () => 'again');
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], tools: new Map([['loop', tool]]), maxSteps: 3,
    }));
    expect(result.interrupted).toBe(true);
    expect(result.interruptReason?.type).toBe('max-steps');
    expect(result.content).toContain('最大推理步数');
  });

  it('ToolInterrupt（reload）→ 语义化中断，产出 (工具中断) 消息', async () => {
    const llm = makeMockLLM(() => ({
      content: '', toolCalls: [{ id: 'c1', name: 'reload', arguments: {} }], finishReason: 'tool_calls',
    }));
    const tool = mkTool('reload', async () => {
      throw new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
    });
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['reload', tool]]),
    }));
    expect(result.interrupted).toBe(true);
    expect(result.interruptReason).toEqual({ type: 'reload-requested', scope: 'self' });
    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toContain('(工具中断)');
  });

  it('reload-requested + interruptHandlers 继续决议 → 执行热重载后继续推理（不戛然而止）', async () => {
    const calls: LLMRequest[] = [];
    const llm = makeMockLLM((req) => {
      calls.push(req);
      if (calls.length === 1) {
        // 第 1 步：调用 reload 工具
        return { content: '开始自测，先热加载：', toolCalls: [{ id: 'c1', name: 'reload', arguments: {} }], finishReason: 'tool_calls' };
      }
      // 第 2 步（reload 后继续）：正常收尾总结
      return { content: '热加载完成，自测继续 ✅', toolCalls: [], finishReason: 'stop' };
    });
    const tool = mkTool('reload', async () => {
      throw new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
    });
    let reloadedScopes: string[] = [];
    const ctx = createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['reload', tool]]),
    });
    ctx.interruptHandlers = [async (_current, reason) => {
      if (reason.type !== 'reload-requested') return;
      reloadedScopes.push(reason.scope);
      return { action: 'continue', patch: { systemPrompt: 'reloaded' } };
    }];

    const result = await run(ctx);

    expect(reloadedScopes).toEqual(['self']);
    expect(calls.length).toBe(2); // reload 后确实继续了下一步推理
    expect(result.interrupted).toBe(false);
    expect(result.content).toContain('热加载完成');
    // 上下文累积：reload 工具的中断消息也在最终 messages 里
    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toContain('(工具中断)');
    expect(result.messages.some(m => m.role === 'assistant' && m.content.includes('热加载完成'))).toBe(true);
  });
});

describe('run —— steer 转向注入', () => {
  it('工具执行中注入的 steer 在下一步被消费进上下文', async () => {
    const calls: LLMRequest[] = [];
    const llm = makeMockLLM((req) => {
      calls.push(req);
      if (calls.length === 1) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'inject_steer', arguments: {} }], finishReason: 'tool_calls' };
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    });
    let ctx!: CurrentContext;
    const tool = mkTool('inject_steer', async () => {
      pushSteer(ctx, { role: 'user', content: '中途插入指令' });
      return 'ok';
    });
    ctx = createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['inject_steer', tool]]),
    });
    const result = await run(ctx);

    expect(result.content).toBe('done');
    // 第二轮 LLM 请求应包含 steer 消息
    expect(calls[1].messages.some(m => m.content === '中途插入指令')).toBe(true);
    // next-step 队列已被消费清空
    expect(ctx.inbox.nextStep).toHaveLength(0);
    // 结果消息中包含 steer
    expect(result.messages.some(m => m.content === '中途插入指令')).toBe(true);
  });

  it('末轮工具注入 next-step：run 不结束，继续一个 step 消费（竞态修复）', async () => {
    const calls: LLMRequest[] = [];
    const llm = makeMockLLM((req) => {
      calls.push(req);
      if (calls.length === 1) {
        // 第一轮无工具，直接返回；工具不会执行——改为在 stepEndHook 注入 next-step
        return { content: '第一轮结束', toolCalls: [], finishReason: 'stop' };
      }
      return { content: '继续消费', toolCalls: [], finishReason: 'stop' };
    });
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const ctx = createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map(),
      emit: (type, _payload, data) => events.push({ type, data }),
    });
    ctx.stepEndHook = [async () => {
      if (calls.length === 1) pushSteer(ctx, { role: 'user', content: '末轮注入' });
    }];

    const result = await run(ctx);
    expect(calls.length).toBe(2);
    expect(result.content).toBe('继续消费');
    expect(calls[1].messages.some(m => m.content === '末轮注入')).toBe(true);
    expect(events.some(e => e.type === 'chat.step.steered' && e.data?.count === 1)).toBe(true);
  });
});

describe('run —— 错误处理', () => {
  it('LLM chat 抛错：返回 LLM 错误，产出 error 消息', async () => {
    const llm = makeMockLLM(() => { throw new Error('服务内部错误'); });
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
    }));
    expect(result.content).toContain('LLM 错误');
    expect(result.interrupted).toBe(false);
    expect(result.messages.some(m => m.role === 'error')).toBe(true);
  });

  it('工具执行抛普通异常：写入 error tool 消息，循环继续', async () => {
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }], finishReason: 'tool_calls' };
      }
      return { content: '错误已处理', toolCalls: [], finishReason: 'stop' };
    });
    const tool = mkTool('boom', async () => { throw new Error('内部错误'); });
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['boom', tool]]),
    }));
    expect(result.content).toBe('错误已处理');
    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content).data.message).toBe('内部错误');
  });

  it('未找到工具：返回错误 JSON 工具结果', async () => {
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'missing', arguments: {} }], finishReason: 'tool_calls' };
      }
      return { content: 'fin', toolCalls: [], finishReason: 'stop' };
    });
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
    }));
    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content).status).toBe('error');
    expect(JSON.parse(toolMsg!.content).data.message).toContain('未找到工具');
  });

  it('finishReason=error + signal 已中止（主动打断）：按中断收尾，不产出 error 消息', async () => {
    const llm = makeMockLLM(() => ({ content: '', toolCalls: [], finishReason: 'error' as const }));
    const controller = new AbortController();
    controller.abort();
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      signal: controller.signal,
    }));
    expect(result.interrupted).toBe(true);
    expect(result.interruptReason?.type).toBe('user-abort');
    expect(result.messages.some(m => m.role === 'error')).toBe(false);
    expect(result.content).not.toContain('LLM 错误');
  });

  it('流式 error token + signal 中止：不 emit chat.message.error（主动打断不是失败）', async () => {
    const llm = makeMockLLM(() => ({ content: '', toolCalls: [], finishReason: 'error' as const }));
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      signal: controller.signal,
      emit: (type) => { events.push(type); },
    }));
    expect(events).not.toContain('chat.message.error');
    expect(result.interrupted).toBe(true);
    expect(result.messages.some(m => m.role === 'error')).toBe(false);
  });
});

describe('run —— usage 与事件', () => {
  it('多步 LLM 调用累计 usage（覆盖/累加双轨）', async () => {
    let n = 0;
    const llm = makeMockLLM(() => {
      n++;
      if (n === 1) {
        return {
          content: '', toolCalls: [{ id: 'c1', name: 'add', arguments: {} }], finishReason: 'tool_calls',
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      }
      return {
        content: 'done', toolCalls: [], finishReason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
      };
    });
    const tool = mkTool('add', async () => 'ok');
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['add', tool]]),
    }));
    // 覆盖为最新一次
    expect(result.usage?.prompt_tokens).toBe(20);
    expect(result.usage?.total_tokens).toBe(23);
    // 累加
    expect(result.usage?.accumulated_prompt_tokens).toBe(30);
    expect(result.usage?.accumulated_total_tokens).toBe(35);
    expect(result.usage?.completion_tokens).toBe(5);
    expect(result.usage?.react_steps).toBe(2);
  });

  it('emit 事件流：step/message 生命周期事件按序发射', async () => {
    const events: string[] = [];
    const llm = makeMockLLM(() => ({ content: '你好', toolCalls: [], finishReason: 'stop' }));
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      emit: (type) => { events.push(type); },
    }));
    expect(result.content).toBe('你好');
    expect(events).toContain('chat.step.start');
    expect(events).toContain('chat.message.start');
    expect(events).toContain('chat.message.end');
    expect(events).toContain('chat.step.end');
    expect(events.indexOf('chat.step.start')).toBeLessThan(events.indexOf('chat.step.end'));
  });

  it('流式 thinking：emit 收到 thinking 事件', async () => {
    const events: string[] = [];
    const llm = makeMockLLM(() => ({
      content: '答', toolCalls: [], finishReason: 'stop', reasoning: '让我想想',
    }));
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      emit: (type) => { events.push(type); },
    }));
    expect(events).toContain('chat.thinking.start');
    expect(events).toContain('chat.thinking.end');
  });

  it('chat.start/chat.end：整次执行边界事件按序发射', async () => {
    const events: string[] = [];
    const llm = makeMockLLM(() => ({ content: '你好', toolCalls: [], finishReason: 'stop' }));
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      emit: (type) => { events.push(type); },
    }));
    expect(events[0]).toBe('chat.start');
    expect(events[events.length - 1]).toBe('chat.end');
    // start → step.start → … → step.end → end
    expect(events.indexOf('chat.start')).toBeLessThan(events.indexOf('chat.step.start'));
    expect(events.indexOf('chat.step.end')).toBeLessThan(events.indexOf('chat.end'));
  });

  it('chat.start：只透传 meta["chat.start"] 的 hint/source，不判断 isTrigger、不整包广播 meta', async () => {
    const starts: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const llm = makeMockLLM(() => ({ content: 'ok', toolCalls: [], finishReason: 'stop' }));

    // 无论 currentMessage 是否存在，loop 都只展开 meta['chat.start']
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      meta: {
        'chat.start': { hint: '定时巡检', source: { kind: 'timer', form: 'hint', summary: '巡检' } },
        'archive-review': true,
      },
      emit: (type, _payload, data) => { if (type === 'chat.start') starts.push({ type, data }); },
    }));
    expect(starts[0].data?.isTrigger).toBeUndefined();
    expect(starts[0].data?.hint).toBe('定时巡检');
    expect(starts[0].data?.source).toEqual({ kind: 'timer', form: 'hint', summary: '巡检' });
    // 其他 meta 键不整包广播
    expect(starts[0].data?.['archive-review']).toBeUndefined();

    // 未提供 meta['chat.start']：chat.start 不带 hint/source
    await run(createContext({
      llm, systemPrompt: 's', history: [], tools: new Map(),
      emit: (type, _payload, data) => { if (type === 'chat.start') starts.push({ type, data }); },
    }));
    expect(starts[1].data?.hint).toBeUndefined();
    expect(starts[1].data?.source).toBeUndefined();
  });

  it('chat.end：致命兜底路径也发射（事件流始终闭合）', async () => {
    const events: string[] = [];
    // currentMessage.content getter 抛错 → 初始装配阶段触发外层兜底
    const boomMsg = { role: 'user' as const, get content(): string { throw new Error('boom'); } };
    const result = await run(createContext({
      llm: makeMockLLM(() => ({ content: 'ok', toolCalls: [], finishReason: 'stop' })),
      systemPrompt: 's', history: [], currentMessage: boomMsg, tools: new Map(),
      emit: (type) => { events.push(type); },
    }));
    expect(events[0]).toBe('chat.start');
    expect(events[events.length - 1]).toBe('chat.end');
    expect(result.content).toContain('执行异常');
  });
});

describe('run —— 生命周期钩子', () => {
  it('stepStartHook：每步触发，可修改实时消息', async () => {
    const seen: Array<{ step: number; count: number }> = [];
    let n = 0;
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'add', arguments: {} }], finishReason: 'tool_calls' };
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    });
    const tool = mkTool('add', async () => '1');
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['add', tool]]),
      stepStartHook: [async (_ctx, messages) => {
        n++;
        seen.push({ step: n, count: messages.length });
      }],
    }));
    expect(result.content).toBe('done');
    expect(seen).toHaveLength(2); // 两步各触发一次
    expect(seen[1].count).toBeGreaterThan(seen[0].count); // 第二步含 tool 结果，消息更多
  });

  it('stepEndHook：观察本步结果与本步产出', async () => {
    const seen: any[] = [];
    const llm = makeMockLLM(() => ({ content: '你好', toolCalls: [], finishReason: 'stop' }));
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      stepEndHook: [async (ctx, outcome, loopMessages) => { seen.push({ outcome, produced: loopMessages.length }); }],
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome.done).toBe(true);
    expect(seen[0].outcome.interrupted).toBe(false);
    // loopMessages 含用户提问 + assistant 产出
    expect(seen[0].produced).toBe(2);
  });

  it('toolExecutionStartHook：拦截工具执行', async () => {
    let executed = false;
    const tool = mkTool('blocked', async () => { executed = true; return 'x'; });
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'blocked', arguments: {} }], finishReason: 'tool_calls' };
      }
      return { content: '已拦截', toolCalls: [], finishReason: 'stop' };
    });
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['blocked', tool]]),
      toolExecutionStartHook: [async () => ({ allow: false, reason: '禁止执行' })],
    }));
    expect(executed).toBe(false);
    expect(result.content).toBe('已拦截');
    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content).data.message).toBe('禁止执行');
  });

  it('toolExecutionStartHook：改写参数', async () => {
    let received: any;
    const tool = mkTool('echo', async (args) => { received = args; return 'ok'; });
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { a: 1 } }], finishReason: 'tool_calls' };
      }
      return { content: 'fin', toolCalls: [], finishReason: 'stop' };
    });
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['echo', tool]]),
      toolExecutionStartHook: [async (name, args) => ({ allow: true, args: { ...args, injected: true } })],
    }));
    expect(received).toMatchObject({ a: 1, injected: true });
  });

  it('Tool.execute 第四参与 toolExecutionStart 第三参：注入 toolCallId/dialogId/agentId/messages', async () => {
    let execSeen: any;
    let hookSeen: any;
    const tool = mkTool('echo', async (_args, _stream, _signal, exec) => { execSeen = exec; return 'ok'; });
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { a: 1 } }], finishReason: 'tool_calls' };
      }
      return { content: 'fin', toolCalls: [], finishReason: 'stop' };
    });
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, dialogId: 'chat~user~a', agentId: 'a',
      tools: new Map([['echo', tool]]),
      toolExecutionStartHook: [async (_name, _args, execution) => { hookSeen = execution; return { allow: true }; }],
    }));
    expect(execSeen).toMatchObject({ toolCallId: 'c1', dialogId: 'chat~user~a', agentId: 'a' });
    expect(hookSeen.toolCallId).toBe('c1');
    expect(hookSeen.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'c1')).toBe(true);
  });

  it('toolExecutionEndHook：观察工具结果', async () => {
    const outcomes: any[] = [];
    const llm = makeMockLLM((req, i) => {
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }], finishReason: 'tool_calls' };
      }
      return { content: 'fin', toolCalls: [], finishReason: 'stop' };
    });
    const tool = mkTool('add', async (args) => String((args.a ?? 0) + (args.b ?? 0)));
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg,
      tools: new Map([['add', tool]]),
      toolExecutionEndHook: [async (o) => { outcomes.push(o); }],
    }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].toolName).toBe('add');
    expect(outcomes[0].result).toBe('3');
  });

  it('fallbackHook：LLM 调用失败时触发，run 正常返回', async () => {
    const calls: unknown[] = [];
    const llm = makeMockLLM(() => { throw new Error('connect ECONNREFUSED'); });
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      fallbackHook: [async (_ctx, err) => { calls.push(err); }],
    }));
    expect(calls).toHaveLength(1);
    expect(result.content).toContain('LLM 错误');
    expect(result.interrupted).toBe(false);
  });

  it('fallbackHook：未捕获异常时兜底，run 不抛', async () => {
    const calls: unknown[] = [];
    // currentMessage.content getter 抛错 → 初始装配阶段触发外层兜底
    const boomMsg = { role: 'user' as const, get content(): string { throw new Error('boom'); } };
    const result = await run(createContext({
      llm: makeMockLLM(() => ({ content: 'ok', toolCalls: [], finishReason: 'stop' })),
      systemPrompt: 's', history: [], currentMessage: boomMsg, tools: new Map(),
      fallbackHook: [async (_ctx, err) => { calls.push(err); }],
    }));
    expect(calls).toHaveLength(1);
    expect(result.content).toContain('执行异常');
    expect(result.messages.some(m => m.role === 'error')).toBe(true);
  });

  it('流式 finishReason=error：触发 fallbackHook + 产出 error 消息（B1）', async () => {
    const calls: unknown[] = [];
    // 流式路径（emit 已接）：错误经流协议传递，result() 返回 finishReason='error'，
    // 不应被当作正常 stop（done:true + 空 final），而应触发 fallbackHook + error 消息收尾
    const llm = makeMockLLM(() => ({ content: null, toolCalls: [], finishReason: 'error' as const }));
    const events: string[] = [];
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      emit: (type) => { events.push(type); },
      fallbackHook: [async (_ctx, err) => { calls.push(err); }],
    }));
    expect(calls).toHaveLength(1);
    expect(result.content).toContain('LLM 错误');
    expect(result.interrupted).toBe(false);
    expect(result.messages.some(m => m.role === 'error')).toBe(true);
    // 事件流：含 error 事件且只发射一次（流式 error token + finishReason='error' 不重复）
    expect(events.filter((e) => e === 'chat.message.error')).toHaveLength(1);
    expect(events[0]).toBe('chat.start');
    expect(events[events.length - 1]).toBe('chat.end');
  });

  it('钩子抛错不影响主流程', async () => {
    const llm = makeMockLLM(() => ({ content: 'ok', toolCalls: [], finishReason: 'stop' }));
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      stepStartHook: [async () => { throw new Error('hook boom'); }],
      stepEndHook: [async () => { throw new Error('hook boom'); }],
    }));
    expect(result.content).toBe('ok');
  });

  it('runStartHook/runEndHook：整次执行边界各触发一次，先于/后于 step 钩子', async () => {
    const order: string[] = [];
    const llm = makeMockLLM(() => ({ content: '你好', toolCalls: [], finishReason: 'stop' }));
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      runStartHook: [async () => { order.push('runStart'); }],
      runEndHook: [async () => { order.push('runEnd'); }],
      stepStartHook: [async () => { order.push('stepStart'); }],
      stepEndHook: [async () => { order.push('stepEnd'); }],
    }));
    expect(order).toEqual(['runStart', 'stepStart', 'stepEnd', 'runEnd']);
  });

  it('runEndHook：可观察整次结果（content/interrupted/messages）', async () => {
    let observed: any;
    const llm = makeMockLLM(() => ({ content: '最终回复', toolCalls: [], finishReason: 'stop' }));
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      runEndHook: [async (_ctx, r) => { observed = r; }],
    }));
    expect(observed.content).toBe('最终回复');
    expect(observed.interrupted).toBe(false);
    expect(observed.messages).toBe(result.messages);
  });

  it('runStartHook：可修改 ctx（如注入运行时字段）', async () => {
    const seen: any[] = [];
    const llm = makeMockLLM((req) => {
      seen.push((req as any).customField);
      return { content: 'ok', toolCalls: [], finishReason: 'stop' };
    });
    await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      runStartHook: [async (ctx) => { (ctx as any).customField = 'injected'; }],
    }));
    // LLM 请求不直接携带 customField；验证 hook 已执行且未抛错
    expect(seen).toHaveLength(1);
  });

  it('runEndHook：致命兜底路径也触发（含异常时观察 error 消息）', async () => {
    let observed: any = null;
    const boomMsg = { role: 'user' as const, get content(): string { throw new Error('boom'); } };
    const result = await run(createContext({
      llm: makeMockLLM(() => ({ content: 'ok', toolCalls: [], finishReason: 'stop' })),
      systemPrompt: 's', history: [], currentMessage: boomMsg, tools: new Map(),
      runEndHook: [async (_ctx, r) => { observed = r; }],
    }));
    expect(observed).not.toBeNull();
    expect(observed.content).toContain('执行异常');
    expect(observed.messages.some((m: any) => m.role === 'error')).toBe(true);
  });

  it('runStartHook/runEndHook：抛错不影响主流程（与 step 钩子一致）', async () => {
    const llm = makeMockLLM(() => ({ content: 'ok', toolCalls: [], finishReason: 'stop' }));
    const result = await run(createContext({
      llm, systemPrompt: 's', history: [], currentMessage: userMsg, tools: new Map(),
      runStartHook: [async () => { throw new Error('start boom'); }],
      runEndHook: [async () => { throw new Error('end boom'); }],
    }));
    expect(result.content).toBe('ok');
  });
});
