// ============================================================
// feed-midrun-history-merge.test.ts —— run 进行中历史合并回归
//
// 背景 bug（2026-09-04 反馈：流式中出现两张工具卡——一张永久"运行中"、
// 一张 OK）：run 进行中 loadHistory（切走切回/刷新）时，首屏整体替换会把
// 直播行（唯一带工具结果的载体）丢掉，换上后端的 partial 检查点行
// （result:null——结果只在 run 收束行落盘）→ 已完成步的工具卡永久转圈；
// 续流的新步正常 OK——同名工具连排时视觉即"同一调用两张卡"。
//
// 修复语义：run 进行中的历史首屏合并，直播行整体保留（live-wins），历史
// 页中同 run 的行（按 tool_call_id 识别）剔除；run 收束后自动重拉首屏
// （收束行吸收 partial、携带权威结果与 persistedMsgId）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ method: string; params: any; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) =>
      new Promise((resolve, reject) => { rpcCalls.push({ method, params, resolve, reject }); })),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => () => {}),
  },
}));
vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';
const conv = `${A}~user`;
const delta = (chunk: Record<string, unknown>) => [{ model: 'm' }, chunk, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];
const META = [undefined, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];
const env = { conversationId: conv, sender: 'user' };

interface StepRec { content: string; reasoning?: string; toolCalls: Array<{ id: string; name: string; arguments: string; result: unknown }> }
function partialRecord(id: string, step: StepRec) {
  return {
    message_id: id, role: 'agent', agent_id: A, content: '', timestamp: new Date().toISOString(),
    partial: true, run: 'run-x', steps: [step],
  };
}
function toolCard(feed: any, id: string, tcId: string) {
  const turns = feed.getTurns(id).value;
  return (turns.at(-1)?.steps ?? []).flatMap((s: any) => s.tools as any[]).filter((t: any) => t.tool_call_id === tcId);
}

describe('run 进行中历史合并：live-wins（工具卡不重复、不永久转圈）', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  it('切走切回（step2 流式中 loadHistory）：tcW1 只有一张卡且有结果', async () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    // step1（write tcW1）：完整走完（delta-end → after-step → after-execute——
    // 注意真实顺序：after-step 先于工具执行）
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tcW1', name: 'write', argumentsDelta: '{"file_path":"a.md","content":"x"}' }] }));
    feed.ingestFrame('llm/delta-end', META);
    feed.ingestFrame('loop/after-step', [A, { text: '', reasoning: '写文件' }, env]);
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tcW1', agentId: A, conversationId: conv }, { ok: true, output: { message: '已写入 a.md', path: 'a.md' } }, undefined]);

    // step2（write tcW2）流式中（thinking 阶段）——用户此刻切走又切回
    feed.ingestFrame('loop/step-started', [A, 1, [], env]);
    feed.ingestFrame('llm/delta', delta({ reasoning: '再写一个' }));

    // loadHistory：后端返回 user 行 + step1 的 partial 行（result:null）
    feed.loadHistory(id, 'user', A);
    expect(rpcCalls[0].method).toBe('session/history');
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm1', role: 'user', agent_id: 'user', content: '整理一下', timestamp: new Date().toISOString() },
        partialRecord('m2', { content: '', reasoning: '写文件', toolCalls: [{ id: 'tcW1', name: 'write', arguments: '{"file_path":"a.md"}', result: null }] }),
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    // tcW1：一张卡；内容在（直播结果不被 partial 行顶掉）；不在转圈
    const w1 = toolCard(feed, id, 'tcW1');
    expect(w1).toHaveLength(1);
    expect((w1[0].content || '').length).toBeGreaterThan(0);
    expect(w1[0].isStreaming).toBeFalsy();

    // step2 续流完成
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tcW2', name: 'write', argumentsDelta: '{"file_path":"b.md"}' }] }));
    feed.ingestFrame('llm/delta-end', META);
    feed.ingestFrame('loop/after-step', [A, { text: '', reasoning: '再写一个' }, env]);
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tcW2', agentId: A, conversationId: conv }, { ok: true, output: { message: '已写入 b.md', path: 'b.md' } }, undefined]);

    const w2 = toolCard(feed, id, 'tcW2');
    expect(w2).toHaveLength(1);
    expect(w2[0].isStreaming).toBeFalsy();

    // run 收束：自动重拉首屏（收束行吸收 partial）——rpc 再次发出
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'user' }, { finish: 'stop', text: '完成' }]);
    await new Promise((r) => setTimeout(r, 20));
    rpcCalls.at(-1)!.resolve({
      records: [
        { message_id: 'm1', role: 'user', agent_id: 'user', content: '整理一下', timestamp: new Date().toISOString() },
        {
          message_id: 'm3', role: 'agent', agent_id: A, content: '完成', timestamp: new Date().toISOString(),
          steps: [
            { content: '', reasoning: '写文件', toolCalls: [{ id: 'tcW1', name: 'write', arguments: '{}', result: { ok: true, output: { message: '已写入 a.md', path: 'a.md' } } }] },
            { content: '', reasoning: '再写一个', toolCalls: [{ id: 'tcW2', name: 'write', arguments: '{}', result: { ok: true, output: { message: '已写入 b.md', path: 'b.md' } } }] },
          ],
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    // 收束后视图：每个调用仍只有一张卡，结果在
    const w1b = toolCard(feed, id, 'tcW1');
    const w2b = toolCard(feed, id, 'tcW2');
    expect(w1b).toHaveLength(1);
    expect(w2b).toHaveLength(1);
    expect(w1b[0].isStreaming).toBeFalsy();
    expect(w2b[0].isStreaming).toBeFalsy();
  });

  it('run 收束后的常规 loadHistory（无进行中直播）不受影响', async () => {
    const feed = useFeedStore();
    const id = directDialog(A);
    feed.loadHistory(id, 'user', A);
    rpcCalls[0].resolve({
      records: [
        { message_id: 'm1', role: 'user', agent_id: 'user', content: '问', timestamp: new Date().toISOString() },
        {
          message_id: 'm2', role: 'agent', agent_id: A, content: '答', timestamp: new Date().toISOString(),
          steps: [{ content: '答', toolCalls: [{ id: 'tcZ1', name: 'read', arguments: '{}', result: { ok: true, output: { path: 'a.ts', content: '1:x', total_lines: 1 } } }] }],
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    const z1 = toolCard(feed, id, 'tcZ1');
    expect(z1).toHaveLength(1);
    expect(z1[0].content).toContain('a.ts');
  });
});
