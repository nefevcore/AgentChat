import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
// rpc 桩：session/history 静默成功（run/settled 帧触发 delay=0 收敛重拉——
// 拒绝形态会走 feed-core 的 logger.warn，node 测试环境无 window 抛二次错）
const rpcStub = {
  call: (method: string) => Promise.resolve(method === 'session/history' ? { records: [], hasMore: false } : {}),
  onEvent: () => () => undefined,
};
let runStatus: typeof import('../client/runStatus.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  runStatus = await import('../client/runStatus.ts');
});

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user';

function newFeed() {
  return feedCore.createFeedCore(rpcStub as never, () => new RosterCore());
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
    seq.push(st(feed)); // calling（runStartAt 已设、step 未到）
    // step 0：首个带 stepId 的 delta 惰性建卡（空占位 → calling 档同判据）
    seq.push(st(feed)); // calling（占位面尚未变化）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:0' } }, { reasoning: '思考' }]);
    seq.push(st(feed)); // thinking
    // 工具参数分片（preparing 占位链建 tool 行）——载体已有思考内容，
    // 边思考边生成参数仍属思考相位（载体优先）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}' }] }]);
    seq.push(st(feed)); // thinking
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: 'r1', step: 0, stepId: 'r1:0', seq: 10, rows: [{ type: 'step/tool-call', toolCallId: 'tc1', name: 'read', arguments: '{}', ts: 1 }] }]);
    seq.push(st(feed)); // tooling（步间工具执行窗口——载体已关、tool 行在途）
    feed.ingestFrame('tool/result', [{ agent: 'alpha', conversationId: CONV, run: 'r1', toolCallId: 'tc1', result: { ok: true, output: '内容' } }]);
    seq.push(st(feed)); // tooling（最短转圈延迟窗内 isStreaming 未清）
    // 新步空占位（step-started 退役后的等价物：带 stepId 的空载荷 delta 惰性建卡）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:1' } }, {}]);
    seq.push(st(feed)); // calling（新步空占位——不为历史工具残留卡 tooling）
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:1' } }, { delta: '回复' }]);
    seq.push(st(feed)); // replying（流式输出正确显示回复中）
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: 'r1', step: 1, stepId: 'r1:1', seq: 11, rows: [{ type: 'step/content', text: '回复内容', ts: 2 }] }]);
    feed.ingestFrame('run/settled', [{ agent: 'alpha', conversationId: CONV, run: 'r1', finish: 'stop', text: '回复内容' }]);
    seq.push(st(feed)); // hidden（收束）
    expect(seq).toEqual([
      'waking', 'calling', 'calling', 'thinking', 'thinking',
      'tooling', 'tooling',
      'calling', 'replying', 'hidden',
    ]);
  });
});
