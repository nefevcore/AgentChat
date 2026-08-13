// ============================================================
// src/agents/router 单元测试 —— 电话交换机
//
// 覆盖：send 基本/未注册/虚拟/广播、steer 注入（同会话运行中）、
//       trigger、sendAsync、关机模式、abort、群组委托。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRouter } from '../src/agents/router';
import type { AgentAssembly } from '../src/agents/config';
import type { LLMProvider, LLMRequest, LLMResponse, Tool } from '../src/core/types';
import { ChatStream } from '../src/core/llm/chat-stream';
import { ToolInterrupt } from '../src/core/interrupt';

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

/** 创建 router（内置 registry/groupManager），注册默认 3 个 Agent */
function makeRouter(assembly: AgentAssembly): AgentRouter {
  const r = new AgentRouter(assembly);
  r.getRegistry().register({ agent_id: 'agentA', name: 'Agent A' });
  r.getRegistry().register({ agent_id: 'agentB', name: 'Agent B' });
  r.getRegistry().register({ agent_id: 'user', name: '用户', virtual: true });
  return r;
}

describe('AgentRouter.send', () => {
  it('点到点：返回目标 Agent 的 LLM 响应', async () => {
    const r = makeRouter(makeAssembly(() => stop('resp0')));
    const resp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '你好' });
    expect(resp).toBe('resp0');
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
      resolveHooks: () => ({ runEndHook: [async (_ctx, result: any) => { runEndSeen.push(result.messages); }] }),
    };
    const r = makeRouter(assembly);
    const resp = await r.send({ from: 'agentA', to: 'user', type: 'chat.send', payload: '你好' });
    expect(resp).toContain('已收到');
    expect(llm.callCount()).toBe(0); // 跳过 LLM 推理，不装配真实模型
    // runEnd hook（save-session 同款挂点）已执行，result.messages 含 currentMessage
    expect(runEndSeen.length).toBe(1);
    const msgs = runEndSeen[0];
    expect(msgs.some((m: any) => m.role === 'user' && m.content === '你好' && m.agent_id === 'agentA')).toBe(true);
    // 跳过推理 → 不产生空 assistant 消息污染会话
    expect(msgs.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
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
    // data：agent=接收方虚拟 Agent（前端定位 user 对话），payload/from 透传
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
    expect(virt.length).toBe(1); // 仅 user（唯一虚拟 Agent）触发推送
    expect(virt[0].data.agent).toBe('user');
  });

  it('构造的 ctx：dialogId = <from>__<to>，currentMessage 含发送者', async () => {
    const seen: LLMRequest[] = [];
    const r = makeRouter(makeAssembly((req) => { seen.push(req); return stop('ok'); }));
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(seen.length).toBe(1);
    expect(seen[0].messages.some(m => m.role === 'user' && m.content === 'hi')).toBe(true);
  });

  it('广播（to="*"）：投递到所有非发送者', async () => {
    const r = makeRouter(makeAssembly(() => stop('broadcasted')));
    const resp = await r.send({ from: 'user', to: '*', type: 'broadcast', payload: 'hello' });
    expect(resp).toContain('[agentA]');
    expect(resp).toContain('[agentB]');
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

describe('AgentRouter 串行化 + steer 注入', () => {
  it('同会话运行中收到新消息：注入为 steer，不新开 run；下一轮被消费', async () => {
    const tools = new Map([['noop', mkTool('noop', async () => 'ok')]]);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let call1Messages: any[] = [];
    const llm = makeLLM((req, i) => {
      if (i === 0) {
        // 第一轮：阻塞直到 steer 注入完成，然后返回工具调用让循环继续
        return gate.then(() => ({ content: '', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }], finishReason: 'tool_calls' as const }));
      }
      // 第二轮：应包含被注入的 steer 消息
      call1Messages = req.messages;
      return stop('final');
    });
    const assembly: AgentAssembly = { createLLM: () => llm, resolveTools: () => tools, loadHistory: () => [] };
    const r = makeRouter(assembly);

    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    // 等待 running 注册（runWithGate 同步注册，微任务后已生效）
    await new Promise(res => setTimeout(res, 10));
    const p2 = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'second' });
    expect(p2).toContain('正在处理');
    expect(p2).toContain('转向消息');

    release();
    const resp1 = await p1;
    expect(resp1).toBe('final');
    // 第二轮 LLM 请求应包含 steer 消息（second）
    expect(call1Messages.some((m: any) => m.role === 'user' && m.content === 'second')).toBe(true);
  });

  it('不同会话（不同 convKey）可并行运行', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(r => { releaseA = r; });
    const llm = makeLLM((_req, i) => {
      // agentA 阻塞，agentB 直接返回
      if (i === 0) return gateA.then(() => stop('A-done'));
      return stop('B-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [] });

    const pA = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'toA' });
    await new Promise(res => setTimeout(res, 10));
    // agentB 与 agentA 不同会话，不应被 steer
    const respB = await r.send({ from: 'user', to: 'agentB', type: 'chat.send', payload: 'toB' });
    expect(respB).toBe('B-done');
    releaseA();
    expect(await pA).toBe('A-done');
  });

  it('同会话运行中带 meta 的 trigger：等待空闲后作为独立 run 执行（不降级为 steer）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let runCount = 0;
    const llm = makeLLM((_req, i) => {
      runCount++;
      if (i === 0) {
        // 第一个 run（普通 send）：阻塞直到 meta trigger 进来
        return gate.then(() => stop('first-done'));
      }
      return stop('meta-done');
    });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [] });

    // 启动第一个 run（阻塞）
    const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'first' });
    await new Promise(res => setTimeout(res, 10));

    // 带 meta 的 trigger：应等待空闲后新开 run（而非注入 steer）
    const pMeta = r.trigger('agentA', { hint: 'meta-hint', source: 'archive-review', meta: { 'archive-review': true } });
    await new Promise(res => setTimeout(res, 30));
    // 第一个 run 仍在阻塞 → meta trigger 未完成（在等待空闲）
    let metaDone = false;
    void pMeta.then(() => { metaDone = true; });
    expect(metaDone).toBe(false);

    release();
    expect(await p1).toBe('first-done');
    expect(await pMeta).toBe('meta-done');
    // 两个 run 都执行了（send 1 次 + trigger 1 次）
    expect(runCount).toBe(2);
  });
});

describe('AgentRouter.trigger', () => {
  it('自主推理：hint 以 <trigger> 注入；返回 LLM 内容', async () => {
    const seen: LLMRequest[] = [];
    const r = makeRouter(makeAssembly((req) => { seen.push(req); return stop('tick-done'); }));
    const resp = await r.trigger('agentA', { hint: 'tick', source: 'cron', maxTurns: 3 });
    expect(resp).toBe('tick-done');
    // hint 进入消息（role=trigger，<trigger> 包装）
    expect(seen[0].messages.some(m => m.role === 'trigger' && m.content === '<trigger>tick</trigger>')).toBe(true);
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

describe('AgentRouter.sendAsync', () => {
  it('fire-and-forget：立即返回确认，后台投递', async () => {
    const llm = makeLLM(() => stop('async'));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [] });
    const resp = await r.sendAsync({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(resp).toContain('已异步投递');
    await new Promise(res => setTimeout(res, 10));
    expect(llm.callCount()).toBe(1);
  });
});

describe('AgentRouter 关机模式', () => {
  it('enterShutdownMode 后消息入队；flush 重投', async () => {
    const llm = makeLLM(() => stop('redelivered'));
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [] });

    r.enterShutdownMode();
    expect(r.isShutdownMode()).toBe(true);

    const resp = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    expect(resp).toContain('重启');
    expect(llm.callCount()).toBe(0); // 未投递

    const flushed = await r.flushPendingMessages();
    expect(flushed).toBe(1);
    expect(r.isShutdownMode()).toBe(false);
    expect(llm.callCount()).toBe(1); // 重投成功
  });

  it('flush：同会话消息合并为一个 run，不同会话并行', async () => {
    const seen: any[][] = [];
    const llm = makeLLM((req) => { seen.push(req.messages as any[]); return stop('ok'); });
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [] });

    r.enterShutdownMode();
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm1' });
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm2' });
    await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'm3' });
    await r.send({ from: 'user', to: 'agentB', type: 'chat.send', payload: 'b1' });
    expect(llm.callCount()).toBe(0); // 关机期间未投递

    const flushed = await r.flushPendingMessages();
    expect(flushed).toBe(2); // agentA 合并 1 组 + agentB 1 组
    expect(llm.callCount()).toBe(2);

    // agentA 的 run 应包含全部 3 条（m1 currentMessage + m2/m3 初始 steer）
    const aReq = seen.find(msgs => msgs.some((m: any) => m.content === 'm1'));
    expect(aReq).toBeDefined();
    const aContents = aReq!.filter((m: any) => m.role === 'user').map((m: any) => m.content);
    expect(aContents).toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
    // agentB 单独一个 run
    expect(seen.some(msgs => msgs.some((m: any) => m.content === 'b1'))).toBe(true);
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
      // 第 1 次调用：system_restart；flush 重投（trigger）后的第 2 次：正常收尾
      const llm = makeLLM((req, i) => {
        seenMsgs.push(req.messages as any[]);
        if (i === 0) {
          return { content: '', toolCalls: [{ id: 'c1', name: 'restart', arguments: {} }], finishReason: 'tool_calls' };
        }
        return stop('重启完成，已继续 ✅');
      });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs, // 落盘到临时目录，不污染真实工作区
        createLLM: () => llm,
        resolveTools: () => new Map([['restart', mkTool('restart', async () => {
          throw new ToolInterrupt({ type: 'restart-requested', reason: 'test-reason' });
        })]]),
        loadHistory: () => [],
        requestRestart: (reason) => { restarts.push(reason ?? ''); },
      };
      const r = makeRouter(assembly);

      const res = await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '请重启后端' });

      expect(restarts).toEqual(['test-reason']); // 请求后端重启
      expect(r.isShutdownMode()).toBe(true);     // 进入关机模式（新消息入 pending）
      expect(res).toBe('');                      // run 因中断无最终回复

      // pending 已落盘（进程退出不丢）：模拟"新进程"——新建 router 实例 flush 读盘恢复
      const pendingFile = path.join(tmpWs, '.router_pending.jsonl');
      expect(fs.existsSync(pendingFile)).toBe(true);
      const r2 = makeRouter({ ...assembly, createLLM: () => llm, resolveTools: () => new Map() });
      const flushed = await r2.flushPendingMessages();
      expect(flushed).toBe(1);
      expect(llm.callCount()).toBe(2);
      expect(fs.existsSync(pendingFile)).toBe(false); // 读盘后已清理
      expect(r2.isShutdownMode()).toBe(false);

      // 继续消息必须是 trigger 语义（系统自动触发 + <trigger> 标签），而非普通 user 消息
      const resumeReq = seenMsgs[1];
      expect(resumeReq).toBeDefined();
      const trig = resumeReq.find((m: any) => m.role === 'trigger');
      expect(trig).toBeDefined();
      expect(trig.content).toContain('<trigger>');
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
        if (i < 2) { await gate; return stop('blocked'); } // 前两个调用挂起 → 活跃会话停留 running
        const trig = req.messages.find((m: any) => m.role === 'trigger');
        seenTriggers.push((trig?.content as string) ?? '');
        return stop(`继续完成 ${i}`);
      });
      const assembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map(),
        loadHistory: () => [],
      };
      const r = makeRouter(assembly);
      // 两个 Agent 各自建立活跃会话（并发 send，LLM 挂起 → 均停留 running）
      const p1 = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '任务 A' });
      const p2 = r.send({ from: 'user', to: 'agentB', type: 'chat.send', payload: '任务 B' });
      await new Promise(res => setTimeout(res, 30));
      expect(r.hasActiveSession('agentA')).toBe(true);
      expect(r.hasActiveSession('agentB')).toBe(true);

      // gracefulShutdown 同款调用：入队全部活跃 1v1 会话的 continue-trigger
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
        expect(m.data?.target).toBe('user'); // 会话对方（1v1 双方）
      }

      // 释放原会话（模拟进程退出），新进程 flush 恢复
      release();
      await Promise.all([p1, p2]);
      const r2 = makeRouter({ ...assembly, createLLM: () => llm, resolveTools: () => new Map() });
      const flushed = await r2.flushPendingMessages();
      expect(flushed).toBe(2);
      expect(fs.existsSync(pendingFile)).toBe(false); // 读盘后已清理
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
        requestRestart: (reason) => { restarts.push(reason ?? ''); },
      };
      const r = makeRouter(assembly);
      await r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '请重启后端' });
      // 关机模式已进入；runWithGate 已入队 1 条 continue-trigger
      expect(r.isShutdownMode()).toBe(true);
      // 通用恢复：应跳过已入队的 agentA（不重复）
      const resumed = r.enqueueResumeForActiveSessions();
      expect(resumed).toBe(0);
      const lines = fs.readFileSync(path.join(tmpWs, '.router_pending.jsonl'), 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBe(1); // 仍只有 runWithGate 入队的那条
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

      // 第 1 次重启：createLLM 抛错 → trigger 重投失败 → pending 必须保留
      const badAssembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => { throw new Error('LLM 初始化失败'); },
        resolveTools: () => new Map(),
        loadHistory: () => [],
      };
      const r1 = makeRouter(badAssembly);
      const flushed1 = await r1.flushPendingMessages();
      expect(flushed1).toBe(0);
      expect(fs.existsSync(file)).toBe(true); // 失败消息已保留

      // 第 2 次重启（环境恢复）：重投成功 → pending 清理
      const llm = makeLLM(() => stop('继续完成 ✅'));
      const okAssembly: AgentAssembly = {
        workspaceDir: tmpWs,
        createLLM: () => llm,
        resolveTools: () => new Map(),
        loadHistory: () => [],
      };
      const r2 = makeRouter(okAssembly);
      const flushed2 = await r2.flushPendingMessages();
      expect(flushed2).toBe(1);
      expect(fs.existsSync(file)).toBe(false); // 成功后清理
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
    const r = makeRouter({ createLLM: () => llm, resolveTools: () => new Map(), loadHistory: () => [] });

    const p = r.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: 'hi' });
    await new Promise(res => setTimeout(res, 10));
    expect(r.hasActiveSession('agentA')).toBe(true);
    expect(r.abortSession('agentA')).toBe(true);
    expect(r.abortSession('agentB')).toBe(false);
    release();
    await p;
    expect(r.hasActiveSession('agentA')).toBe(false);
  });
});
