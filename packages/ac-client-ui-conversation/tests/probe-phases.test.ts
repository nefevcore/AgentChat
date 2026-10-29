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

function newFeed() {
  return feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
}

function st(feed: any) {
  return runStatus.deriveRunStatus(feed.getDialog(DIALOG as never), '', 'info').kind;
}

describe('agentic run 全相位状态序列（cr-744 回归）', () => {
  it('唤醒→API→思考→工具→API→回复→收束，各相位正确', () => {
    const feed = newFeed();
    feed.init();
    const seq: string[] = [];
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    feed.ensureById(DIALOG as never).streaming = true;
    seq.push(st(feed)); // waking
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    seq.push(st(feed)); // calling
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { runId: 'r1', stepId: 'r1:0', conversationId: CONV, sender: 'user', source: 'user' }]);
    seq.push(st(feed)); // calling（空占位）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:0' } }, { reasoning: '思考' }]);
    seq.push(st(feed)); // thinking
    // 工具参数分片（preparing 占位链建 tool 行）——载体已有思考内容，
    // 边思考边生成参数仍属思考相位（载体优先）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}' }] }]);
    seq.push(st(feed)); // thinking
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}' }] }, { runId: 'r1', stepId: 'r1:0', conversationId: CONV, sender: 'user', source: 'user' }]);
    seq.push(st(feed)); // tooling（步间工具执行窗口——载体已关、tool 行在途）
    feed.ingestFrame('tool/after-execute', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'tc1', name: 'read' }, { ok: true, output: '内容' }]);
    seq.push(st(feed)); // tooling（最短转圈延迟窗内 isStreaming 未清）
    feed.ingestFrame('loop/step-started', ['alpha', 1, [], { runId: 'r1', stepId: 'r1:1', conversationId: CONV, sender: 'user', source: 'user' }]);
    seq.push(st(feed)); // calling（新步空占位——不为历史工具残留卡 tooling）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:1' } }, { delta: '回复' }]);
    seq.push(st(feed)); // replying（流式输出正确显示回复中）
    feed.ingestFrame('loop/after-step', ['alpha', { index: 1, text: '回复内容', toolCalls: [] }, { runId: 'r1', stepId: 'r1:1', conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/after-run', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }, { finish: 'stop', text: '回复内容' }]);
    seq.push(st(feed)); // hidden（收束）
    expect(seq).toEqual([
      'waking', 'calling', 'calling', 'thinking', 'thinking',
      'tooling', 'tooling',
      'calling', 'replying', 'hidden',
    ]);
  });
});