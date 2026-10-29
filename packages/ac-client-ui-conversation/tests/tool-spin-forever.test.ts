// @vitest-environment jsdom
// ============================================================
// tool-spin-forever.test.ts —— 工具卡永转圈根治回归（cr-763）：
//   ① 空输出工具（result 空串 = 合法终值）收束后不再判在途；
//   ② 中段已收束步不转 + 末尾步 tool 行在途照转（在途信号源修正）；
//   ③ 重连收口不以分区 streaming 为前提（run-started 丢失形态）；
//   ④ 权威判死收口原语把 toolCalls running 一并收口。
// 数据形态：FeedAgentMsg 重建把内嵌 toolCalls 的 result/running 重置，
// 真实在途信号走 tool 行匹配回填——用例按直播真实形态构造。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let feedPure: typeof import('../client/feed.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  feedPure = await import('../client/feed.ts');
});

function stubRpc() {
  const eventHandlers: Array<(type: string, args: unknown[]) => void> = [];
  const openHandlers: Array<() => void> = [];
  return {
    eventHandlers, openHandlers,
    call(method: string) {
      if (method === 'conversation/stats') return Promise.resolve({ running: [] });
      return Promise.resolve({});
    },
    onEvent(handler: (type: string, args: unknown[]) => void) {
      eventHandlers.push(handler);
      return () => undefined;
    },
    onOpen(handler: () => void) { openHandlers.push(handler); return () => undefined; },
  };
}

const CONV = 'alpha~user';
const DLG = 'pair:alpha|user' as never;

function fire(rpc: ReturnType<typeof stubRpc>, type: string, args: unknown[]) {
  rpc.eventHandlers.forEach(h => h(type, args));
}

describe('工具卡永转圈根治（cr-763）', () => {
  it('空输出工具：result 空串 + tool 行已收口 → 不判在途', () => {
    const turns = feedPure.buildTurns([
      { id: 'u1', role: 'user', content: 'q', agent_id: 'user', timestamp: 1 } as never,
      {
        id: 'a1', role: 'agent', agent_id: 'alpha', timestamp: 2, isStreaming: false,
        content: '', thinking: '', toolCalls: [{ id: 't1', name: 'read', arguments: {} }],
      } as never,
      // 空输出终值：tool 行已到（isStreaming=false）但 content 为空串
      { id: 'tool-t1', role: 'tool', content: '', tool_call_id: 't1', name: 'read', toolName: 'read', isStreaming: false, timestamp: 3 } as never,
    ]);
    const last = turns[turns.length - 1]!;
    const tool = last.steps[0]!.tools[0]!;
    expect(tool.isStreaming).toBe(false); // 修复前：!'' === true → 恒转
    expect(tool.status).toBeUndefined();
  });

  it('直播在途：tool 行 isStreaming 回填 → 末尾步工具卡照转、中段已收束步不转', () => {
    const turns = feedPure.buildTurns([
      { id: 'u1', role: 'user', content: 'q', agent_id: 'user', timestamp: 1 } as never,
      {
        id: 'a1', role: 'agent', agent_id: 'alpha', timestamp: 2, isStreaming: false,
        content: '', thinking: '', toolCalls: [{ id: 't1', name: 'bash', arguments: {} }],
      } as never,
      { id: 'tool-t1', role: 'tool', content: '', tool_call_id: 't1', name: 'bash', toolName: 'bash', isStreaming: false, timestamp: 3 } as never,
      // 第二步进行中：工具执行窗口（tool 行在途）
      {
        id: 'a2', role: 'agent', agent_id: 'alpha', timestamp: 4, isStreaming: true,
        content: '', thinking: '', toolCalls: [{ id: 't2', name: 'read', arguments: {} }],
      } as never,
      { id: 'tool-t2', role: 'tool', content: '', tool_call_id: 't2', name: 'read', toolName: 'read', isStreaming: true, timestamp: 5 } as never,
    ], true);
    const t = turns.find((x: { agent_id: string }) => x.agent_id === 'alpha')!;
    expect(t.steps.length).toBe(2);
    expect(t.steps[0]!.tools[0]!.isStreaming).toBe(false); // 中段已收束步：不转
    expect(t.steps[1]!.tools[0]!.isStreaming).toBe(true); // 末尾步 tool 行在途：照转
  });

  it('重连收口：分区 streaming 未置位但占位在场（resume 快照形态）也收口', async () => {
    const rpc = stubRpc();
    const roster = new RosterCore();
    const feed = feedCore.createFeedCore(rpc as never, () => roster);
    feed.init();
    // 真实形态：刷新后 resume 快照合并（handleResume）——进行中步骤原地续流/新建
    // isStreaming 占位，全程不经 run-started（streaming 不置位）。断线发生在快照
    // 合并后 → 收尾帧断供 → 旧代码按 streaming 门控永不收口。
    // 先经一轮完整 run 建立分区 + 落盘消息（resume 快照对齐的锚），收束后
    // streaming 已熄灭，再喂快照（active 进行中）。
    fire(rpc, 'loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, 'loop/step-started', ['alpha', 0, [], { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, 'llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:s1' } }, { delta: 'done' }]);
    fire(rpc, 'loop/after-step', ['alpha', { index: 0, text: 'done', toolCalls: [] }, { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    const before = feed.getDialog(DLG);
    expect(before?.streaming).toBe(false); // 纯文本步收束已熄灭（复现前提）
    // resume 快照：同 Agent 新一轮进行中（无 session → activeAgentId 路由，
    // 经 roster.selectAgent 联动激活）
    roster.bindRpc(rpc as never);
    void roster.requestAgents().then(() => roster.selectAgent('alpha'));
    await new Promise(resolve => setTimeout(resolve, 30)); // roster 联动落地
    feed.handleResume({ active: true, agentId: 'alpha', content: '部分', phase: 'answer', userMessage: 'q2' });
    const d = feed.getDialog(DLG);
    expect(d?.streaming).toBeFalsy(); // resume 路径不置位 streaming（复现前提）
    expect(d?.rawMessages.some(m => m.isStreaming)).toBe(true); // 但占位在场
    rpc.openHandlers.forEach(fn => fn());
    const d2 = feed.getDialog(DLG);
    expect(d2?.rawMessages.some(m => m.isStreaming)).toBe(false); // 修复前：永不收口
  });

  it('权威判死收口原语：toolCalls running 标记一并收口', () => {
    const rpc = stubRpc();
    const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
    feed.init();
    // 正常路径建在途态：step-started 建占位 + 工具分片建 preparing 卡
    fire(rpc, 'loop/step-started', ['alpha', 0, [], { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, 'llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:s1' } }, { toolCalls: [{ index: 0, id: 'call-1', name: 'bash' }] }]);
    const d = feed.getDialog(DLG);
    const carrier = d?.rawMessages.find(m => m.role === 'agent');
    expect((carrier?.toolCalls ?? []).some((tc: any) => tc.running === true)).toBe(true);
    expect(d?.rawMessages.some(m => m.role === 'tool' && m.isStreaming)).toBe(true);
    feed.settleDeadDialog(DLG);
    const d2 = feed.getDialog(DLG);
    const rows = d2?.rawMessages ?? [];
    expect(rows.some(m => m.isStreaming)).toBe(false);
    expect(rows.some(m => (m.toolCalls ?? []).some((tc: any) => tc.running === true))).toBe(false);
    expect(d2?.streaming).toBe(false);
  });
});
