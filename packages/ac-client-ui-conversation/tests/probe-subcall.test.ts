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

function st(feed: any) {
  return runStatus.deriveRunStatus(feed.getDialog(DIALOG as never), '', 'info').kind;
}

const meta = { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' };

describe('探针：run_code subcall 运行期的状态', () => {
  it('宿主步收束后 subcall started → 应 tooling', () => {
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    feed.ensureById(DIALOG as never).streaming = true;
    feed.ingestFrame('loop/run-started', [meta]);
    // step0：模型调用 run_code
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { delta: '写个程序' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{}' }] }]);
    console.log('host-toolfrag:', st(feed));
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '写个程序', toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{}' }] }, { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    console.log('host-after-step:', st(feed));
    // subcall 开始（run_code 程序内调用工具）
    feed.ingestFrame('tool/started', [{ agentId: 'alpha', conversationId: CONV, toolCallId: 'r1#1', name: 'read', runCodeSubcall: true, runId: 'r1' }]);
    console.log('subcall-started:', st(feed));
    // 载体形态检查
    const raw = feed.getRaw(DIALOG as never);
    const lastAgent = [...raw].reverse().find((m: any) => m.role === 'agent');
    console.log('carrier isStreaming:', lastAgent?.isStreaming, 'toolCalls:', JSON.stringify((lastAgent?.toolCalls ?? []).map((t: any) => ({ id: t.id, running: t.running, subcall: t.subcall }))));
    const toolRows = raw.filter((m: any) => m.role === 'tool');
    console.log('tool rows:', JSON.stringify(toolRows.map((m: any) => ({ id: m.tool_call_id, isStreaming: m.isStreaming, len: (m.content||'').length }))));
    expect(st(feed)).toBe('tooling');
  });
});