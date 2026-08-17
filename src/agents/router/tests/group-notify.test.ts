// ============================================================
// 群消息 notify 投递（单通道化 v3）测试
//
// 覆盖（docs/group-single-channel-design.md 不变量）：
//   I2/I11 idle·tail：currentMessage = <msg>全文+时间，不含契约（契约归 group-contract 钩子）
//   I11  idle·history：极简通知（无 <msg> 全文），sourceMeta 不带 message_id（历史保留全文）
//   I3/I4 busy：readSince(锚点) 增量 steer + 推进锚点；空增量不注入
//   失效安全：notify 无 groupFeed → 回落 legacy
// ============================================================
import { describe, it, expect } from 'vitest';
import { AgentRouter } from '../src/router';
import { GROUP_CONTRACT_TEXT, GROUP_SYNC_META_KEY } from '@agentchat/contracts';
import type { GroupFeed, GroupFeedAnchor, GroupFeedPage } from '@agentchat/contracts';
import type { AgentAssembly } from '@agentchat/agents';
import { groupDialogKey } from '@agentchat/agents';
import type { LLMProvider, LLMRequest, LLMResponse } from '@agentchat/llm';
import type { Tool } from '@agentchat/agent-loop';
import { ChatStream } from '@agentchat/llm';
import { run, createContext, enqueue, followup, steer, inject, drainInbox, pushSteer } from '@agentchat/agent-loop';

const engine = { run, createContext, enqueue, followup, steer, inject, drainInbox, pushSteer };

function makeLLM(handler: (req: LLMRequest, i: number) => LLMResponse | Promise<LLMResponse>) {
  let callIndex = 0;
  const llm: LLMProvider = {
    model: 'mock-model',
    async chat(req) { const i = callIndex++; return await handler(req, i); },
    stream(req) {
      const cs = new ChatStream();
      void (async () => { const i = callIndex++; cs.done(await handler(req, i)); })()
        .catch((err) => cs.error({ content: null, toolCalls: [], finishReason: 'error' }, String(err)));
      return cs;
    },
    toProviderMessages: (m) => m as any[],
    fromProviderMessages: (m) => m as any[],
  };
  return Object.assign(llm, { callCount: () => callIndex });
}

const stop = (content: string): LLMResponse => ({ content, toolCalls: [], finishReason: 'stop' });
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error('waitFor 超时');
    await tick(10);
  }
}

function makeRouter(handler: (req: LLMRequest, i: number) => LLMResponse | Promise<LLMResponse>, hooks: Record<string, any[]> = {}) {
  const llm = makeLLM(handler);
  const assembly: AgentAssembly = {
    engine,
    createLLM: () => llm,
    resolveTools: () => new Map<string, Tool>(),
    loadHistory: () => [],
    resolveHooks: () => hooks as any,
  };
  const r = new AgentRouter(assembly);
  r.getRegistry().register({ agent_id: 'agentA', name: 'Agent A' });
  r.getRegistry().register({ agent_id: 'news', name: '莉莉新闻' });
  return { r, llm };
}

/** 可脚本化 GroupFeed fake */
function makeFeed(script: GroupFeedPage[] = []): GroupFeed & { calls: GroupFeedAnchor[] } {
  const calls: (GroupFeedAnchor | undefined)[] = [];
  let idx = 0;
  return {
    calls: calls as any,
    async readSince(_gid: string, anchor?: GroupFeedAnchor) {
      calls.push(anchor);
      return script[Math.min(idx++, script.length - 1)] ?? { injected: '', message_ids: [], anchor: { line: 0 } };
    },
    async currentAnchor() { return { line: 0 }; },
  } as any;
}

describe('群消息 notify 投递（单通道化）', () => {
  it('idle·tail：currentMessage 携带 <msg>全文+时间，不含契约；sourceMeta 带 message_id（历史按 id 剔除）', async () => {
    const seen: LLMRequest[] = [];
    let capturedMeta: any;
    const { r } = makeRouter((req) => { seen.push(req); return stop('ok'); }, {
      runStartHook: [async (ctx: any) => { capturedMeta = ctx.meta?.['chat.start']; }],
    });
    r.getGroupManager().createGroup({ group_id: 'g1', name: '群1', participants: ['agentA', 'news'] });
    r.applyGroupDelivery({ groupFeed: makeFeed(), delivery: 'notify', deliveryVariant: 'tail' });

    await r.getGroupManager().deliverGroupMessage({
      from: 'news', to: '*', type: 'chat.send', payload: '晚间速递全文内容', group_id: 'g1',
    } as any);
    await waitFor(() => seen.length >= 1);

    // currentMessage（最后一条 user）= <msg>全文 + [当前时间]，且不含契约（契约归钩子）
    const lastUser = [...seen[0].messages].reverse().find((m: any) => m.role === 'user') as any;
    expect(lastUser.content).toContain('<msg from="news" name="莉莉新闻" group="群1">晚间速递全文内容</msg>');
    expect(lastUser.content).toContain('[当前时间]');
    expect(lastUser.content).not.toContain(GROUP_CONTRACT_TEXT);
    // sourceMeta.message_id 贯通（load-history excludeIds 据此剔除历史重复）
    expect(capturedMeta?.source?.message_id).toMatch(/^msg-\d+-\w+$/);
  });

  it('idle·history：极简通知（无 <msg> 全文），sourceMeta 不带 message_id（全文留在历史）', async () => {
    const seen: LLMRequest[] = [];
    let capturedMeta: any;
    const { r } = makeRouter((req) => { seen.push(req); return stop('ok'); }, {
      runStartHook: [async (ctx: any) => { capturedMeta = ctx.meta?.['chat.start']; }],
    });
    r.getGroupManager().createGroup({ group_id: 'g1', name: '群1', participants: ['agentA', 'news'] });
    r.applyGroupDelivery({ groupFeed: makeFeed(), delivery: 'notify', deliveryVariant: 'history' });

    await r.getGroupManager().deliverGroupMessage({
      from: 'news', to: '*', type: 'chat.send', payload: '这是一条很长的晚间速递正文'.repeat(10), group_id: 'g1',
    } as any);
    await waitFor(() => seen.length >= 1);

    const lastUser = [...seen[0].messages].reverse().find((m: any) => m.role === 'user') as any;
    expect(lastUser.content).toContain('新消息');
    expect(lastUser.content).not.toContain('<msg from="news"');
    expect(capturedMeta?.source?.message_id).toBeUndefined();
  });

  it('busy：readSince(锚点) 增量 steer + 推进锚点；空增量不注入（I3/I4）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const seen: LLMRequest[] = [];
    let capturedCtx: any;
    const { r, llm } = makeRouter(async (req, i) => {
      seen.push(req);
      if (i === 0) await gate;
      return stop('busy-done');
    }, {
      runStartHook: [async (ctx: any) => { capturedCtx = ctx; }],
    });
    r.getGroupManager().createGroup({ group_id: 'g1', name: '群1', participants: ['agentA', 'news'] });

    // 第一次 readSince 返回增量；第二次返回空（I4 双发通知幂等）
    const feed = makeFeed([
      { injected: '<msg from="news" name="莉莉新闻" group="群1">忙时增量内容</msg>', message_ids: ['m2'], anchor: { message_id: 'm2', line: 2 } },
      { injected: '', message_ids: [], anchor: { message_id: 'm2', line: 2 } },
    ]);
    r.applyGroupDelivery({ groupFeed: feed, delivery: 'notify', deliveryVariant: 'tail' });

    // agentA 先进入长 run（call 0 阻塞在 gate）——group_id 使 convKey 为群会话（busy 分支命中）
    void r.trigger('agentA', { source: 'test-busy', group_id: 'g1' });
    await waitFor(() => llm.callCount() >= 1);

    const gm = r.getGroupManager();
    // 第一条：busy 增量注入
    await gm.deliverGroupMessage({ from: 'news', to: '*', type: 'chat.send', payload: '第一条', group_id: 'g1' } as any);
    await waitFor(() => (capturedCtx?.inbox?.nextStep?.length ?? 0) >= 1);
    expect(capturedCtx.inbox.nextStep[0].content).toContain('忙时增量内容');
    // 锚点推进到 readSince 返回的 anchor
    expect((capturedCtx.meta as any)[GROUP_SYNC_META_KEY]).toEqual({ message_id: 'm2', line: 2 });

    // 第二条：空增量 → 不注入（nextStep 仍为 1）
    await gm.deliverGroupMessage({ from: 'news', to: '*', type: 'chat.send', payload: '第二条', group_id: 'g1' } as any);
    await tick(30);
    expect(capturedCtx.inbox.nextStep.length).toBe(1);

    release();
    await tick(30);
  });

  it('失效安全：notify 模式未绑定 groupFeed → 回落 legacy（hint 携带契约与全文）', async () => {
    const seen: LLMRequest[] = [];
    const { r } = makeRouter((req) => { seen.push(req); return stop('ok'); });
    r.getGroupManager().createGroup({ group_id: 'g1', name: '群1', participants: ['agentA', 'news'] });
    r.applyGroupDelivery({ delivery: 'notify' }); // 无 groupFeed
    expect(r.groupDeliveryMode.delivery).toBe('legacy');

    await r.getGroupManager().deliverGroupMessage({
      from: 'news', to: '*', type: 'chat.send', payload: 'legacy 兜底', group_id: 'g1',
    } as any);
    await waitFor(() => seen.length >= 1);

    const lastUser = [...seen[0].messages].reverse().find((m: any) => m.role === 'user') as any;
    expect(lastUser.content).toContain('<msg from="news"');
    expect(lastUser.content).toContain(GROUP_CONTRACT_TEXT); // legacy：契约随 hint（现状行为）
  });

  it('legacy 契约按目标 Agent 配置覆盖（agent.session.groupContractText）', async () => {
    const seen: LLMRequest[] = [];
    const { r } = makeRouter((req) => { seen.push(req); return stop('ok'); });
    // 覆盖注册：agentA 携带自定义契约（agent.group 命名空间）
    r.getRegistry().register({
      agent_id: 'agentA', name: 'Agent A',
      'agent.group': { groupContractText: '风栗定制契约：安静观察为主' },
    } as any);
    r.getGroupManager().createGroup({ group_id: 'g1', name: '群1', participants: ['agentA', 'news'] });

    await r.getGroupManager().deliverGroupMessage({
      from: 'news', to: '*', type: 'chat.send', payload: 'hi', group_id: 'g1',
    } as any);
    await waitFor(() => seen.length >= 1);

    const lastUser = [...seen[0].messages].reverse().find((m: any) => m.role === 'user') as any;
    expect(lastUser.content).toContain('风栗定制契约：安静观察为主');
    expect(lastUser.content).not.toContain(GROUP_CONTRACT_TEXT);
  });
});
