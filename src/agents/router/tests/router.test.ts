// ============================================================
// src/agents/router 单元测试 —— 电话交换机
//
// 覆盖：send（wait/placement 两态）、trigger（永远 fire-and-forget）、
//       route 单路径、steer/next-run 决策、关机 pending 序列化与恢复、
//       whenSessionIdle、abort、广播 fanout、群组委托。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRouter } from '../src/router';
import { chatDialogKey, groupDialogKey } from '@agentchat/agents';
import type { AgentAssembly } from '@agentchat/agents';
import type { LLMProvider, LLMRequest, LLMResponse } from '@agentchat/llm';
import type { Tool } from '@agentchat/agent-loop';
import { ChatStream } from '@agentchat/llm';
import {
  ToolInterrupt, run, createContext,
  enqueue, followup, steer, inject, drainInbox, pushSteer,
} from '@agentchat/agent-loop';

/** 真实 ReAct 引擎（测试注入：assembly.engine 契约面） */
const engine = { run, createContext, enqueue, followup, steer, inject, drainInbox, pushSteer };

// ---- 脚本化 mock LLM：按调用顺序返回响应 ----
function makeLLM(
  handler: (req: LLMRequest, callIndex: number) => LLMResponse | Promise<LLMResponse>,
): LLMProvider & { callCount: () => number } {
  let callIndex = 0;
  const llm: LLMProvider = {
    model: 'mock-model',
    async chat(req) {
      // 调用时即自增：handler 阻塞时，后续调用也能拿到正确的递增 index
      const i = callIndex++;
      const resp = await handler(req, i);
      return resp;
    },
    stream(req) {
      const cs = new ChatStream();
      void (async () => {
        const i = callIndex++;
        const resp = await handler(req, i);
        cs.done(resp);
      })().catch((err) => cs.error({ content: null, toolCalls: [], finishReason: 'error' }, String(err)));
      return cs;
    },
    toProviderMessages: (m) => m as any[],
    fromProviderMessages: (m) => m as any[],
  };
  return Object.assign(llm, { callCount: () => callIndex });
}

function makeAssembly(
  handler: (req: LLMRequest, i: number) => LLMResponse | Promise<LLMResponse>,
  opts: { loadHistory?: (key: string) => any[] } = {},
): AgentAssembly {
  const llm = makeLLM(handler);
  return {
    engine,
    createLLM: () => llm,
    resolveTools: () => new Map<string, Tool>(),
    loadHistory: opts.loadHistory ?? (() => []),
  };
}

const mkTool = (name: string, execute: Tool['execute']): Tool => ({
  name, label: name, ns: `tool.${name}`,
  definition: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
  execute,
});

const stop = (content: string): LLMResponse => ({ content, toolCalls: [], finishReason: 'stop' });
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error('waitFor 超时');
    await tick(10);
  }
}

/** 创建 router（内置 registry/groupManager），注册默认 3 个 Agent */
function makeRouter(assembly: AgentAssembly): AgentRouter {
  const r = new AgentRouter(assembly);
  r.getRegistry().register({ agent_id: 'agentA', name: 'Agent A' });
  r.getRegistry().register({ agent_id: 'agentB', name: 'Agent B' });
  r.getRegistry().register({ agent_id: 'user', name: '用户', virtual: true });
  return r;
}

describe('AgentRouter.send', () => {
  it('点到点：返回目标 Agent 的 LLM 响应（wait=true 默认）', async () => {
    const r = makeRouter(makeAssembly(() => stop('resp0')));
    const resp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '你好' });
    expect(resp).toBe('resp0');
  });

  it('wait=false：立即返回确认，后台投递', async () => {
    const llm = makeLLM(() => stop('async'));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });
    const resp = await r.send(
      { from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' },
      { wait: false },
    );
    expect(resp).toContain('已异步投递');
    await tick(10);
    expect(llm.callCount()).toBe(1);
  });

  it('sendAsync：wait=false 糖，立即返回', async () => {
    const llm = makeLLM(() => stop('async'));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });
    const resp = await r.sendAsync({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(resp).toContain('已异步投递');
    await tick(10);
    expect(llm.callCount()).toBe(1);
  });

  it('未注册目标：返回提示，不崩溃', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const resp = await r.send({ from: 'user', to: 'ghost', type: 'chat.send', payload: 'hi' });
    expect(resp).toContain('未在注册表中找到');
    expect(resp).toContain('agentA');
  });

  it('虚拟 Agent（user）：统一 run 流程——回执 + 不调用 LLM + runEnd hook 收到 currentMessage（落盘依据）', async () => {
    const llm = makeLLM(() => stop('x'));
    const runEndSeen: any[] = [];
    const assembly: AgentAssembly = {
      createLLM: () => llm,
      resolveTools: () => new Map<string, Tool>(),
      loadHistory: () => [],
      engine,
      resolveHooks: () => ({ runEndHook: [async (_ctx, result: any) => { runEndSeen.push(result.messages); }] }),
    };
    const r = makeRouter(assembly);
    const resp = await r.send({ from: 'agentA', to: 'user', type: 'chat.send', payload: '你好' });
    expect(resp).toContain('已收到');
    expect(llm.callCount()).toBe(0); // 跳过 LLM 推理，不装配真实模型
    expect(runEndSeen.length).toBe(1);
    const msgs = runEndSeen[0];
    expect(msgs.some((m: any) => m.role === 'user' && m.content === '你好' && m.agent_id === 'agentA')).toBe(true);
    expect(msgs.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
  });

  it('虚拟 Agent wait=false：受理即返回，chat.virtual.receive 仍由后台 run 完成后发射', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const seen: any[] = [];
    r.on('message', (m) => seen.push(m));
    const resp = await r.send(
      { from: 'agentA', to: 'user', type: 'chat.send', payload: '社区动态', correlation_id: 'cid-1' },
      { wait: false },
    );
    expect(resp).toContain('已异步投递');
    expect(seen.length).toBe(0); // 尚未跑完，不提前发射
    await tick(20);
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe('chat.virtual.receive');
    expect(seen[0].payload).toBe('社区动态');
  });

  it('虚拟 Agent 收到消息：emit "message" chat.virtual.receive（供 L5 WS 广播到前端）', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const seen: any[] = [];
    r.on('message', (m) => seen.push(m));
    await r.send({ from: 'agentA', to: 'user', type: 'chat.send', payload: '社区动态', correlation_id: 'cid-1' });
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe('chat.virtual.receive');
    expect(seen[0].from).toBe('agentA');
    expect(seen[0].to).toBe('user');
    expect(seen[0].payload).toBe('社区动态');
    expect(seen[0].correlation_id).toBe('cid-1');
    expect(seen[0].data.agent).toBe('user');
    expect(seen[0].data.payload).toBe('社区动态');
    expect(seen[0].data.from).toBe('agentA');
  });

  it('广播到虚拟 Agent（to="*" 含 user）：也 emit chat.virtual.receive（不重复落盘依赖）', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const seen: any[] = [];
    r.on('message', (m) => seen.push(m));
    await r.send({ from: 'agentA', to: '*', type: 'broadcast', payload: '全员通知' });
    const virt = seen.filter((m) => m.type === 'chat.virtual.receive');
    expect(virt.length).toBe(1);
    expect(virt[0].data.agent).toBe('user');
  });

  it('构造的 ctx：dialogId = chatDialogKey，currentMessage 含发送者', async () => {
    const seen: LLMRequest[] = [];
    const r = makeRouter(makeAssembly((req) => { seen.push(req); return stop('ok'); }));
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(seen.length).toBe(1);
    expect(seen[0].messages.some(m => m.role === 'user' && m.content === 'hi')).toBe(true);
  });

  it('receive run：meta["chat.start"].source 来自 currentMessage 来源（user → prompt）', async () => {
    const runEndCtx: any[] = [];
    const llm = makeLLM(() => stop('ok'));
    const r = makeRouter({
      createLLM: () => llm,
      resolveTools: () => new Map(),
      loadHistory: () => [],
      engine,
      resolveHooks: () => ({ runEndHook: [async (ctx) => { runEndCtx.push(ctx); }] }),
    });
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(runEndCtx[0].meta?.['chat.start']).toEqual({
      source: { kind: 'user', form: 'prompt' },
    });
  });

  it('广播（to="*"）wait=true：fanout 投递到所有非发送者', async () => {
    const r = makeRouter(makeAssembly(() => stop('broadcasted')));
    const resp = await r.send({ from: 'user', to: '*', type: 'broadcast', payload: 'hello' });
    expect(resp).toContain('[agentA]');
    expect(resp).toContain('[agentB]');
  });

  it('广播（to="*"）wait=false：fanout fire-and-forget', async () => {
    const llm = makeLLM(() => stop('broadcasted'));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });
    const resp = await r.send({ from: 'user', to: '*', type: 'broadcast', payload: 'hello' }, { wait: false });
    expect(resp).toContain('已异步投递到 2 个 Agent');
    await tick(10);
    expect(llm.callCount()).toBe(2);
  });

  it('emit "message.received" 事件：供 L4/L5 监听（持久化/WebUI）', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const seen: any[] = [];
    r.on('message.received', (m) => seen.push(m));
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(seen.length).toBe(1);
    expect(seen[0].to).toBe('agentA');
  });

  it('群组消息：委托内置 GroupManager 投递', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    r.getGroupManager().createGroup({ group_id: 'g1', name: 'G', participants: ['agentA', 'agentB'] });
    const resp = await r.send({ from: 'user', to: '*', type: 'chat.send', payload: '大家好', group_id: 'g1' });
    expect(resp).toContain('已投递到群组');
    expect(resp).toContain('2 个参与者');
  });
});

describe('AgentRouter 串行化 + placement 决策', () => {
  it('同会话运行中收到新消息：注入为 steer，不新开 run；下一步被消费', async () => {
    const tools = new Map([['noop', mkTool('noop', async () => 'ok')]]);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let call1Messages: any[] = [];
    const llm = makeLLM((req, i) => {
      if (i === 0) {
        return gate.then(() => ({ content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], finishReason: 'tool_calls' as const }));
      }
      call1Messages = req.messages;
      return stop('final');
    });
    const assembly: AgentAssembly = { createLLM: () => llm, resolveTools: () => tools, loadHistory: () => [], engine };
    const r = makeRouter(assembly);

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    await tick(10);
    const p2 = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'second' });
    expect(p2).toContain('已注入为下一步 steer');

    release();
    const resp1 = await p1;
    expect(resp1).toBe('final');
    expect(call1Messages.some((m: any) => m.role === 'user' && m.content === 'second')).toBe(true);
  });

  it('不同会话（不同 convKey）可并行运行', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(r => { releaseA = r; });
    const llm = makeLLM((_req, i) => {
      if (i === 0) return gateA.then(() => stop('A-done'));
      return stop('B-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const pA = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'toA' });
    await tick(10);
    const respB = await r.send({ from: 'user', to: 'agentB', type: 'chat.send', payload: 'toB' });
    expect(respB).toBe('B-done');
    releaseA();
    expect(await pA).toBe('A-done');
  });

  it('trigger busy + steer（无 run 级选项）：pushSteer，不新开 run', async () => {
    const tools = new Map([['noop', mkTool('noop', async () => 'ok')]]);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let secondCallMessages: any[] = [];
    const llm = makeLLM((req, i) => {
      if (i === 0) {
        return gate.then(() => ({ content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], finishReason: 'tool_calls' as const }));
      }
      secondCallMessages = req.messages;
      return stop('final');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => tools, loadHistory: () => [], engine });

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    await tick(10);
    const ack = await r.trigger('agentA', {
      hint: 'tick', source: 'cron', target: 'user',
      sourceMeta: { kind: 'timer', form: 'hint', summary: 'tick' },
    });
    expect(ack).toContain('已注入为下一步 steer');

    release();
    expect(await p1).toBe('final');
    expect(secondCallMessages.some((m: any) =>
      m.role === 'user' && m.content === 'tick' && m.source?.kind === 'timer' && m.source?.form === 'hint',
    )).toBe(true);
  });

  it('trigger busy + meta（run 级选项）：受理即返回，后台等待空闲后作为独立 run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let llmCalls = 0;
    const llm = makeLLM((_req, i) => {
      llmCalls++;
      if (i === 0) return gate.then(() => stop('first-done'));
      return stop('meta-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    await tick(10);

    // 带 meta 的 trigger：受理即返回（不再是 LLM 最终内容），后台等待空闲后新开 run
    const ack = await r.trigger('agentA', {
      hint: 'meta-hint', source: 'archive-review', target: 'user',
      sourceMeta: { kind: 'archive', form: 'hint' },
      meta: { 'archive-review': true },
    });
    expect(ack).toContain('已受理');
    expect(ack).toContain('会话空闲后');
    expect(ack).not.toBe('meta-done');

    release();
    expect(await p1).toBe('first-done');
    // trigger 的 run 在后台完成；等待 LLM 调用达到 2 次（send 1 次 + trigger 1 次）
    await waitFor(() => llmCalls >= 2);
    expect(llmCalls).toBe(2);
  });

  it('trigger busy + maxSteps（run 级选项）：同样强制 next-run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let llmCalls = 0;
    const seen: any[][] = [];
    const llm = makeLLM((req, i) => {
      llmCalls++;
      seen.push(req.messages as any[]);
      if (i === 0) return gate.then(() => stop('first-done'));
      return stop('maxsteps-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    await tick(10);
    const ack = await r.trigger('agentA', {
      hint: 'tick', target: 'user', maxSteps: 3,
      sourceMeta: { kind: 'timer', form: 'hint', summary: 'tick' },
    });
    expect(ack).toContain('会话空闲后');

    release();
    expect(await p1).toBe('first-done');
    await waitFor(() => llmCalls >= 2);
    expect(seen[1].some((m: any) =>
      m.role === 'user' && m.content === 'tick' && m.source?.kind === 'timer',
    )).toBe(true);
  });

  it('receive 显式 placement=next-run：文本消息也等待会话空闲后作为独立 run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let llmCalls = 0;
    const llm = makeLLM((_req, i) => {
      llmCalls++;
      if (i === 0) return gate.then(() => stop('first-done'));
      return stop('second-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    await tick(10);
    const p2 = r.send(
      { from: 'user', to: 'agentA', type: 'chat.send', payload: 'second' },
      { placement: 'next-run' },
    );
    let p2Done = false;
    void p2.then(() => { p2Done = true; });
    await tick(30);
    expect(p2Done).toBe(false); // 仍在等空闲

    release();
    expect(await p1).toBe('first-done');
    expect(await p2).toBe('second-done');
    expect(llmCalls).toBe(2);
  });
});

describe('AgentRouter.trigger（永远 fire-and-forget）', () => {
  it('空闲触发：返回受理确认，LLM 最终结果不再作为返回值', async () => {
    const seen: LLMRequest[] = [];
    const llm = makeLLM((req) => { seen.push(req); return stop('tick-done'); });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const resp = await r.trigger('agentA', {
      hint: 'tick', source: 'cron', maxSteps: 3,
      sourceMeta: { kind: 'timer', form: 'hint', summary: 'tick' },
    });
    expect(resp).toContain('已触发');
    expect(resp).not.toBe('tick-done');

    const idle = await r.whenSessionIdle(chatDialogKey('system', 'agentA'));
    expect(idle).toBe(true);
    expect(llm.callCount()).toBe(1);
    // hint 作为普通 user 消息注入，来源语义由 source 表达（不再使用 trigger 角色/正文包装）
    expect(seen[0].messages.some(m =>
      m.role === 'user' && m.content === 'tick' && m.source?.kind === 'timer',
    )).toBe(true);
  });

  it('未注册目标：返回提示', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const resp = await r.trigger('ghost', { hint: 'hi' });
    expect(resp).toContain('未在注册表中找到');
  });

  it('虚拟 Agent：不支持自主推理', async () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const resp = await r.trigger('user', { hint: 'hi' });
    expect(resp).toContain('不支持自主推理');
  });
});

describe('AgentRouter.whenSessionIdle', () => {
  it('触发后能等到 run 结束；aborted 场景同样收尾', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const llm = makeLLM(() => gate.then(() => stop('slow')));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const convKey = chatDialogKey('system', 'agentA');
    const ack = await r.trigger('agentA', { hint: 'tick' });
    expect(ack).toContain('已触发');
    expect(r.hasActiveSession('agentA')).toBe(true); // trigger resolve 时 running 已注册

    const idlePromise = r.whenSessionIdle(convKey);
    await tick(20);
    expect(r.abortSession('agentA')).toBe(true);
    release();
    expect(await idlePromise).toBe(true);
    expect(r.hasActiveSession('agentA')).toBe(false);
  });
});

describe('AgentRouter inbox 投递原语（followup / steer / inject）', () => {
  it('followup：当前 run 结束后作为独立 next-turn run 消费', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const seen: LLMRequest[] = [];
    const llm = makeLLM(async (req, i) => {
      seen.push(req);
      if (i === 0) { await gate; return stop('first'); }
      return stop('follow-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm1' });
    await tick(10);
    const ack = await r.followup('agentA', {
      role: 'user', content: 'follow-msg', source: { kind: 'user', form: 'prompt' },
    }, { target: 'user' });
    expect(ack).toContain('next-turn');

    release();
    expect(await p1).toBe('first');
    expect(llm.callCount()).toBe(2);
    // 第二个 run 的 currentMessage 是 followup 消息（不与第一个 run 合并）
    expect(seen[1].messages.some(m => m.content === 'follow-msg' && m.role === 'user')).toBe(true);
  });

  it('steer：当前 run 的下一 ReAct step 消费 next-step（同 run 不新开）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const seen: LLMRequest[] = [];
    const llm = makeLLM(async (req, i) => {
      seen.push(req);
      if (i === 0) { await gate; return stop(''); }
      return stop('steer-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm1' });
    await tick(10);
    const ack = await r.steer('agentA', {
      role: 'user', content: 'steer-msg', source: { kind: 'system', form: 'hint' },
    }, { target: 'user' });
    expect(ack).toContain('next-step');

    release();
    // 末轮竞态修复：steer 令同一 run 继续一个 step（不新开 run），run 最终返回第二 step 产出
    expect(await p1).toBe('steer-done');
    expect(llm.callCount()).toBe(2);
    expect(seen[1].messages.some(m => m.content === 'steer-msg')).toBe(true);
  });

  it('inject：idle 不唤醒；后续 followup 首轮一并消费挂起的 next-step', async () => {
    const seen: LLMRequest[] = [];
    const llm = makeLLM((req) => { seen.push(req); return stop('ok'); });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const ack = await r.inject('agentA', {
      role: 'user', content: 'ctx-notice', source: { kind: 'subagent', form: 'notice' },
    }, { target: 'user' });
    expect(ack).toContain('未唤醒');
    expect(llm.callCount()).toBe(0);

    await r.followup('agentA', {
      role: 'user', content: 'real-input', source: { kind: 'user', form: 'prompt' },
    }, { target: 'user' });
    expect(llm.callCount()).toBe(1);
    expect(seen[0].messages.some(m => m.content === 'ctx-notice')).toBe(true);
    expect(seen[0].messages.some(m => m.content === 'real-input')).toBe(true);
  });
});

describe('AgentRouter 关机模式 / pending 序列化与恢复', () => {
  it('enterShutdownMode 后消息入队；flush 重投', async () => {
    const llm = makeLLM(() => stop('redelivered'));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    r.enterShutdownMode();
    expect(r.isShutdownMode()).toBe(true);

    const resp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(resp).toContain('重启');
    expect(llm.callCount()).toBe(0);

    const flushed = await r.flushPendingMessages();
    expect(flushed).toBe(1);
    expect(r.isShutdownMode()).toBe(false);
    expect(llm.callCount()).toBe(1);
  });

  it('shutdown 后新 send/trigger 全部落盘，新 Router 实例能恢复', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-pending-restore-'));
    try {
      const seen: any[][] = [];
      const llm = makeLLM((req) => { seen.push(req.messages as any[]); return stop('ok'); });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map(),
        loadHistory: () => [],
        engine,
      };
      const r = makeRouter(assembly);
      r.enterShutdownMode();

      const sendResp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
      expect(sendResp).toContain('重启');
      const trigResp = await r.trigger('agentA', {
        hint: 'tick', source: 'cron', maxSteps: 3, wrapHint: false, meta: { archive: true },
        sourceMeta: { kind: 'timer', form: 'hint', summary: 'tick' },
      });
      expect(trigResp).toContain('trigger 已入队');

      const file = path.join(tmpWs, '.router_pending.jsonl');
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(lines.length).toBe(2);
      expect(lines[0].input).toBe('receive');
      expect(lines[0].wait).toBe(true);
      expect(lines[0].placement).toBe('steer');
      const trig = lines[1];
      expect(trig.input).toBe('trigger');
      expect(trig.placement).toBe('next-run'); // maxSteps/meta 强制 next-run
      expect(trig.triggerOptions.maxSteps).toBe(3);
      expect(trig.triggerOptions.wrapHint).toBe(false);
      expect(trig.triggerOptions.meta).toEqual({ archive: true });
      expect(trig.triggerOptions.sourceMeta).toEqual({ kind: 'timer', form: 'hint', summary: 'tick' });

      // 模拟进程重启：新实例从文件恢复，不丢任何字段
      const r2 = makeRouter({ ...assembly, createLLM: () => llm, resolveTools: () => new Map() });
      const flushed = await r2.flushPendingMessages();
      expect(flushed).toBe(2);
      expect(llm.callCount()).toBe(2);
      expect(fs.existsSync(file)).toBe(false);
      // trigger 恢复：普通 user 文本 + source 元数据，而非 trigger 角色/<trigger> 包装
      expect(seen.some(msgs => msgs.some((m: any) =>
        m.role === 'user' && m.content === 'tick' && m.source?.kind === 'timer',
      ))).toBe(true);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('flush trigger 恢复完整 options：maxSteps/meta/deepThink 重启后不丢', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-flush-trigger-options-'));
    try {
      const file = path.join(tmpWs, '.router_pending.jsonl');
      fs.writeFileSync(file, JSON.stringify({
        from: 'system', to: 'agentA', type: 'trigger', payload: 'hint',
        input: 'trigger', placement: 'next-run',
        data: { target: 'user' },
        triggerOptions: {
          hint: 'hint', wrapHint: false, maxSteps: 3, deepThink: true,
          meta: { 'archive-review': true }, target: 'user',
        },
      }), 'utf-8');

      const seen: LLMRequest[] = [];
      const runEndCtx: any[] = [];
      const llm = makeLLM((req) => { seen.push(req); return stop('done'); });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map(),
        loadHistory: () => [],
        engine,
        resolveHooks: () => ({ runEndHook: [async (ctx) => { runEndCtx.push(ctx); }] }),
      };
      const r = makeRouter(assembly);
      const flushed = await r.flushPendingMessages();
      expect(flushed).toBe(1);
      expect(fs.existsSync(file)).toBe(false);

      expect(runEndCtx.length).toBe(1);
      expect(runEndCtx[0].maxSteps).toBe(3);
      expect(runEndCtx[0].deepThink).toBe(true);
      // trigger 元数据经 meta['chat.start'] 命名空间传递（不丢失原有 meta 键）
      expect(runEndCtx[0].meta).toEqual({
        'archive-review': true,
        'chat.start': { hint: 'hint', source: { kind: 'system', form: 'hint' } },
      });
      expect(seen[0].messages.some((m: any) =>
        m.role === 'user' && m.content === 'hint' && m.source?.kind === 'system',
      )).toBe(true);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('flush：同会话消息合并为一个 run，不同会话并行', async () => {
    const seen: any[][] = [];
    const llm = makeLLM((req) => { seen.push(req.messages as any[]); return stop('ok'); });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    r.enterShutdownMode();
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm1' });
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm2' });
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm3' });
    await r.send({ from: 'user', to: 'agentB', type: 'chat.send', payload: 'b1' });
    expect(llm.callCount()).toBe(0);

    const flushed = await r.flushPendingMessages();
    expect(flushed).toBe(2); // agentA 合并 1 组 + agentB 1 组
    expect(llm.callCount()).toBe(2);

    const aReq = seen.find(msgs => msgs.some((m: any) => m.content === 'm1'));
    expect(aReq).toBeDefined();
    const aContents = aReq!.filter((m: any) => m.role === 'user').map((m: any) => m.content);
    expect(aContents).toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
    expect(seen.some(msgs => msgs.some((m: any) => m.content === 'b1'))).toBe(true);
  });

  it('pending 分组键与运行态一致：from/to 倒序 / 群组键', () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    const pendingKeyOf = (r as any).pendingKeyOf.bind(r) as (m: any) => string;

    expect(pendingKeyOf({ from: 'agentA', to: 'agentB', type: 'chat.send', payload: '' }))
      .toBe(chatDialogKey('agentA', 'agentB'));
    expect(pendingKeyOf({ from: 'agentB', to: 'agentA', type: 'chat.send', payload: '' }))
      .toBe(chatDialogKey('agentA', 'agentB')); // from/to 倒序仍是同一会话键

    expect(pendingKeyOf({ from: 'user', to: '*', type: 'chat.send', payload: '', group_id: 'g1' }))
      .toBe(groupDialogKey('g1', '*'));
    expect(pendingKeyOf({
      from: 'system', to: 'agentA', type: 'trigger', payload: '',
      triggerOptions: { group_id: 'g1' },
    })).toBe(groupDialogKey('g1', 'agentA'));
    expect(pendingKeyOf({ from: 'system', to: 'agentA', type: 'trigger', payload: '', data: { target: 'user' } }))
      .toBe(chatDialogKey('agentA', 'user'));
  });

  it('enqueuePending：主动入队并返回长度', () => {
    const r = makeRouter(makeAssembly(() => stop('x')));
    expect(r.enqueuePending({ from: 'system', to: 'agentA', type: 'trigger', payload: 'continue' })).toBe(1);
  });
});

describe('AgentRouter restart-requested 消费', () => {
  it('system_restart 中断 → 入队继续会话 trigger + 关机 + requestRestart + 落盘，flush 走 trigger 语义恢复', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-restart-'));
    try {
      const restarts: string[] = [];
      const seenMsgs: any[] = [];
      const llm = makeLLM((req, i) => {
        seenMsgs.push(req.messages as any[]);
        if (i === 0) {
          return { content: '', toolCalls: [{ id: 'c1', name: 'restart', arguments: {} }], finishReason: 'tool_calls' };
        }
        return stop('重启完成，已继续 ✅');
      });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map([['restart', mkTool('restart', async () => {
          throw new ToolInterrupt({ type: 'restart-requested', reason: 'test-reason' });
        })]]),
        loadHistory: () => [],
        engine,
        requestRestart: (reason) => { restarts.push(reason ?? ''); },
      };
      const r = makeRouter(assembly);

      const res = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '请重启后端' });

      expect(restarts).toEqual(['test-reason']);
      expect(r.isShutdownMode()).toBe(true);
      expect(res).toBe('');

      const pendingFile = path.join(tmpWs, '.router_pending.jsonl');
      expect(fs.existsSync(pendingFile)).toBe(true);
      const r2 = makeRouter({ ...assembly, createLLM: () => llm, resolveTools: () => new Map() });
      const flushed = await r2.flushPendingMessages();
      expect(flushed).toBe(1);
      expect(llm.callCount()).toBe(2);
      expect(fs.existsSync(pendingFile)).toBe(false);
      expect(r2.isShutdownMode()).toBe(false);

      const resumeReq = seenMsgs[1];
      expect(resumeReq).toBeDefined();
      const trig = resumeReq.find((m: any) => m.role === 'user' && m.source?.kind === 'restart');
      expect(trig).toBeDefined();
      expect(trig.source).toMatchObject({ kind: 'restart', form: 'resume' });
      expect(trig.content).not.toContain('<trigger>');
      expect(trig.content).toContain('系统已重启完成');
      expect(trig.content).toContain('test-reason');
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });
});

describe('AgentRouter 通用重启恢复（enqueueResumeForActiveSessions）', () => {
  it('gracefulShutdown 前活跃会话全部入队 continue-trigger，flush 后自动继续', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-resume-'));
    try {
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const seenTriggers: string[] = [];
      const llm = makeLLM(async (req, i) => {
        if (i < 2) { await gate; return stop('blocked'); }
        const trig = req.messages.find((m: any) => m.role === 'user' && m.source?.kind === 'restart');
        seenTriggers.push((trig?.content as string) ?? '');
        return stop(`继续完成 ${i}`);
      });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map(),
        loadHistory: () => [],
        engine,
      };
      const r = makeRouter(assembly);
      const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '任务 A' });
      const p2 = r.send({ from: 'user', to: 'agentB', type: 'chat.send', payload: '任务 B' });
      await tick(30);
      expect(r.hasActiveSession('agentA')).toBe(true);
      expect(r.hasActiveSession('agentB')).toBe(true);

      const resumed = r.enqueueResumeForActiveSessions();
      expect(resumed).toBe(2);

      const pendingFile = path.join(tmpWs, '.router_pending.jsonl');
      expect(fs.existsSync(pendingFile)).toBe(true);
      const lines = fs.readFileSync(pendingFile, 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const m = JSON.parse(line);
        expect(m.type).toBe('trigger');
        expect(m.from).toBe('system');
        expect(m.data?.target).toBe('user');
        expect(m.input).toBe('trigger');
        expect(m.triggerOptions?.hint).toContain('系统已重启完成');
        expect(m.triggerOptions?.sourceMeta).toMatchObject({ kind: 'restart', form: 'resume' });
      }

      release();
      await Promise.all([p1, p2]);
      const r2 = makeRouter({ ...assembly, createLLM: () => llm, resolveTools: () => new Map() });
      const flushed = await r2.flushPendingMessages();
      expect(flushed).toBe(2);
      expect(fs.existsSync(pendingFile)).toBe(false);
      expect(seenTriggers.length).toBe(2);
      for (const t of seenTriggers) expect(t).toContain('系统已重启完成');
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('runWithGate restart-requested 已入队 continue 的会话不重复入队', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-resume-dedup-'));
    try {
      const restarts: string[] = [];
      const llm = makeLLM((req, i) => {
        if (i === 0) return { content: '', toolCalls: [{ id: 'c1', name: 'restart', arguments: {} }], finishReason: 'tool_calls' };
        return stop('重启完成 ✅');
      });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map([['restart', mkTool('restart', async () => {
          throw new ToolInterrupt({ type: 'restart-requested', reason: 'test' });
        })]]),
        loadHistory: () => [],
        engine,
        requestRestart: (reason) => { restarts.push(reason ?? ''); },
      };
      const r = makeRouter(assembly);
      await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '请重启后端' });
      expect(r.isShutdownMode()).toBe(true);
      const resumed = r.enqueueResumeForActiveSessions();
      expect(resumed).toBe(0);
      const lines = fs.readFileSync(path.join(tmpWs, '.router_pending.jsonl'), 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('flush 重投失败 → pending 保留供下次重启重试（不丢恢复信号）', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-flush-retry-'));
    try {
      const file = path.join(tmpWs, '.router_pending.jsonl');
      fs.writeFileSync(file, JSON.stringify({
        from: 'system', to: 'agentA', type: 'trigger',
        payload: '系统已重启完成。请基于对话历史继续。',
        correlation_id: 'restart-continue-1', data: { target: 'user' },
      }), 'utf-8');

      const badAssembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => { throw new Error('LLM 初始化失败'); },
        resolveTools: () => new Map(),
        loadHistory: () => [],
        engine,
      };
      const r1 = makeRouter(badAssembly);
      const flushed1 = await r1.flushPendingMessages();
      expect(flushed1).toBe(0);
      expect(fs.existsSync(file)).toBe(true);

      const llm = makeLLM(() => stop('继续完成 ✅'));
      const okAssembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map(),
        loadHistory: () => [],
        engine,
      };
      const r2 = makeRouter(okAssembly);
      const flushed2 = await r2.flushPendingMessages();
      expect(flushed2).toBe(1);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });
});

describe('AgentRouter abort', () => {
  it('abortSession：中断指定 Agent 的活跃会话', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const llm = makeLLM(() => gate.then(() => stop('slow')));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [], engine });

    const p = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    await tick(10);
    expect(r.hasActiveSession('agentA')).toBe(true);
    expect(r.abortSession('agentA')).toBe(true);
    expect(r.abortSession('agentB')).toBe(false);
    release();
    await p;
    expect(r.hasActiveSession('agentA')).toBe(false);
  });
});
