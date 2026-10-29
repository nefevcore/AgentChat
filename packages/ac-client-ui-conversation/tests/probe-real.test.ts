import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;
let runStatus: typeof import('../client/runStatus.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
  runStatus = await import('../client/runStatus.ts');
});

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user';
function st(feed: any) { return runStatus.deriveRunStatus(feed.getDialog(DIALOG as never), '', 'info').kind; }
const meta = { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' };

describe('探针：真实帧还原（tool_calls snake_case 终值替换）', () => {
  it('run_code 执行期状态', () => {
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    feed.ensureById(DIALOG as never).streaming = true;
    feed.ingestFrame('loop/run-started', [meta]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    // 思考 + 正文 + 工具分片
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { reasoning: '计划' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { delta: '写程序' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{}' }] }]);
    console.log('1.frag:', st(feed));
    // after-step：真实形状——step 对象 toolCalls 数组（loop 盖章）
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, stepId: 'r1:0', text: '写程序', toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{}' }] }, { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    console.log('2.after-step:', st(feed));
    // run_code 执行（子调用逐个跑）——先看无 subcall 帧的纯执行窗口
    console.log('3.执行窗口(无subcall帧):', st(feed));
    // 载体形态
    const raw = feed.getRaw(DIALOG as never);
    const lastAgent = [...raw].reverse().find((m: any) => m.role === 'agent');
    console.log('carrier tc:', JSON.stringify((lastAgent?.toolCalls ?? []).map((t: any) => ({ id: t.id, running: t.running }))));
    // subcall started
    feed.ingestFrame('tool/started', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'r1#1', name: 'pwsh', runCodeSubcall: true, runId: 'r1' }]);
    console.log('4.subcall-start:', st(feed));
    expect(true).toBe(true);
  });
});