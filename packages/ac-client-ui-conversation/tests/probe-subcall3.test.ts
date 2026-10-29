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

describe('探针：真实分片形态（无 id 幻影 → 有 id）+ run_code 执行窗口', () => {
  it('状态序列', () => {
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    feed.ensureById(DIALOG as never).streaming = true;
    feed.ingestFrame('loop/run-started', [meta]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    // 思考流（GLM 先思考）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { reasoning: '计划' }]);
    console.log('1.reasoning:', st(feed));
    // 工具分片：先 arguments 累积（无 id）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: '', name: '', arguments: '{"cod' }] }]);
    console.log('2.frag-noid:', st(feed));
    // 分片继续（id 出现）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: 'e":1}' }] }]);
    console.log('3.frag-id:', st(feed));
    // after-step 收束 → run_code 执行（无 tool/started——宿主是模型直调工具，无 started 帧！）
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '', toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{}' }] }, { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    console.log('4.after-step(run_code 执行中):', st(feed));
    // 【run_code 长执行——没有任何帧到达的窗口】
    console.log('5.长执行窗口:', st(feed));
    // 首个 subcall
    feed.ingestFrame('tool/started', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'r1#1', name: 'pwsh', runCodeSubcall: true, runId: 'r1' }]);
    console.log('6.subcall:', st(feed));
    expect(true).toBe(true);
  });
});