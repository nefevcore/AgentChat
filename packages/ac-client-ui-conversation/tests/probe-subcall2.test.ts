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

describe('探针：run_code 完整真实序列（subcall 连续 + 间隙）', () => {
  it('全窗口状态', () => {
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    feed.ensureById(DIALOG as never).streaming = true;
    feed.ingestFrame('loop/run-started', [meta]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    // 模型只出工具调用（无正文——最典型 run_code 场景）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{code}' }] }]);
    console.log('1.toolfrag:', st(feed));
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '', toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{code}' }] }, { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    console.log('2.after-step:', st(feed));
    // subcall 1（read）
    feed.ingestFrame('tool/started', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'r1#1', name: 'read', runCodeSubcall: true, runId: 'r1' }]);
    console.log('3.sub1-start:', st(feed));
    feed.ingestFrame('tool/after-execute', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'r1#1', name: 'read', runCodeSubcall: true, runId: 'r1' }, { ok: true, output: '内容' }]);
    console.log('4.sub1-end:', st(feed));
    // 【间隙】subcall 2 未开始——run_code 还在跑（宿主工具未返回）
    console.log('5.gap:', st(feed));
    // subcall 2（write）
    feed.ingestFrame('tool/started', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'r1#2', name: 'write', runCodeSubcall: true, runId: 'r1' }]);
    console.log('6.sub2-start:', st(feed));
    expect(true).toBe(true);
  });
});