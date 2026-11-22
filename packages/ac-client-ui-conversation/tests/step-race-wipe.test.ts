// ============================================================
// step-race-wipe.test.ts —— cr-1200 步边界乱序丢段回归
// 症状：live 会话中思考+正文整段消失、只剩工具卡。根因链：
//   ① llm/delta（直播快路）与 step/journaled（durable 慢路：队列+逐行
//      fsync）物理可乱序；B3 瞬态语义下收束帧可整帧丢失；
//   ② 下一步 delta 到达时旧载体仍在流（等它迟到的收束帧）→ 惰性建卡
//      不触发 → carrierOf 回落把旧载体冒领登记为本步 carrier；
//   ③ 步终值全量替换（空串覆盖 content/thinking）把并轨内容一并抹空；
//      工具结果走独立 tool/result 帧幸存 → 只剩工具卡。
// 修复语义（三处）：
//   A) carrierOf 拒绝跨步冒领（回落命中驻留别步 stepId 的载体 → null）；
//   B) delta 前沿：残留他步载体定格收口 + 建本步新载体；
//   C) step/journaled 兜底建卡：同款收口+建卡（迟到收束帧补投形态）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
});

const rpcStub = {
  call: (method: string) => Promise.resolve(method === 'session/history' ? { records: [], hasMore: false } : {}),
  onEvent: () => () => undefined,
};

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user' as never;

function newFeed() {
  return feedCore.createFeedCore(rpcStub as never, () => new RosterCore());
}

/** 帧 meta（身份贯通键全携——同 identity-throughput 词汇） */
function metaOf(runId: string, step: number) {
  return { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId, stepId: runId + ':' + step };
}

describe('cr-1200 步边界乱序：收束帧迟到/丢失不丢段', () => {
  it('收束帧丢失：步1 delta 先到不冒领步0载体，步0 内容不被终值抹空', () => {
    const feed = newFeed();
    const runId = 'run-lost';
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    // 步0：思考+正文+工具调用（用户看到完整过程）
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 0) }, { reasoning: '先想想。', delta: '我需要查一下文件。' }]);
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 0) }, { toolCalls: [{ index: 0, id: 'tcA', name: 'read' }] }]);
    feed.ingestFrame('llm/delta-end', [{ meta: metaOf(runId, 0) }]);
    // 步0 的 step/journaled 丢失——工具结果帧（独立通道）照常到达
    feed.ingestFrame('tool/result', [{ agent: 'alpha', conversationId: CONV, run: runId, toolCallId: 'tcA', result: { ok: true, output: '内容' } }]);
    // 步1（纯工具步）delta 到达——修复前：冒领步0载体
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 1) }, { toolCalls: [{ index: 0, id: 'tcB', name: 'grep' }] }]);
    feed.ingestFrame('llm/delta-end', [{ meta: metaOf(runId, 1) }]);
    // 步1 收束帧到达：rows 只有 tool-call（text/reasoning 空）
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: runId, step: 1, stepId: runId + ':1', seq: 12, rows: [{ type: 'step/tool-call', toolCallId: 'tcB', name: 'grep', arguments: '{}', ts: 3 }] }]);
    const raw = feed.getRaw(DIALOG);
    const step0 = raw.find((m: any) => m.role === 'agent' && m.stepId === runId + ':0');
    const step1 = raw.find((m: any) => m.role === 'agent' && m.stepId === runId + ':1');
    // 两步各自独立载体（不并轨）
    expect(step0).toBeTruthy();
    expect(step1).toBeTruthy();
    if (!step0 || !step1) throw new Error('步0/步1 载体缺席（类型收窄守卫）');
    // 步0 思考+正文保留（修复前：被步1 终值全量替换抹空）
    expect(step0.thinking).toBe('先想想。');
    expect(step0.content).toBe('我需要查一下文件。');
    // 步1 工具卡独立落位
    expect((step1.toolCalls ?? []).map((t: any) => t.name)).toEqual(['grep']);
    // 步0 残留载体已收口（不悬挂转圈）
    expect(step0.isStreaming).toBe(false);
  });

  it('收束帧迟到（乱序）：迟到的步0 journaled 不覆盖已流的步1 内容', () => {
    const feed = newFeed();
    const runId = 'run-late';
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    // 步0：纯工具步
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 0) }, { toolCalls: [{ index: 0, id: 'tcA', name: 'read' }] }]);
    feed.ingestFrame('llm/delta-end', [{ meta: metaOf(runId, 0) }]);
    // 步0 journaled 迟到——步1 的思考+正文 delta 先到
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 1) }, { reasoning: '思考一。' }]);
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 1) }, { delta: '正文一。' }]);
    // 步0 收束帧此刻才到（rows 只有 tool-call）
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: runId, step: 0, stepId: runId + ':0', seq: 10, rows: [{ type: 'step/tool-call', toolCallId: 'tcA', name: 'read', arguments: '{}', ts: 1 }] }]);
    const raw = feed.getRaw(DIALOG);
    const byStep = new Map(raw.filter((m: any) => m.role === 'agent').map((m: any) => [m.stepId, m]));
    expect(byStep.get(runId + ':0')).toMatchObject({ thinking: '', content: '' });
    expect(byStep.get(runId + ':1')).toMatchObject({ thinking: '思考一。', content: '正文一。' });
  });

  it('正常时序不回归：journaled 先于下一步 delta，各步落位同旧语义', () => {
    const feed = newFeed();
    const runId = 'run-normal';
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 0) }, { delta: '第一步' }]);
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: runId, step: 0, stepId: runId + ':0', seq: 10, rows: [{ type: 'step/content', text: '第一步', ts: 1 }, { type: 'step/tool-call', toolCallId: 'tc1', name: 'read', arguments: '{}', ts: 1 }] }]);
    feed.ingestFrame('llm/delta', [{ meta: metaOf(runId, 1) }, { delta: '第二步' }]);
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: runId, step: 1, stepId: runId + ':1', seq: 11, rows: [{ type: 'step/content', text: '第二步', ts: 2 }] }]);
    const raw = feed.getRaw(DIALOG);
    const agents = raw.filter((m: any) => m.role === 'agent' && m.stepId);
    expect(agents.map((m: any) => m.stepId)).toEqual([runId + ':0', runId + ':1']);
    expect(agents[0].content).toBe('第一步');
    expect(agents[1].content).toBe('第二步');
    expect(raw.some((m: any) => m.isStreaming)).toBe(false);
  });

  it('缺键回落（旧后端帧）不回归：无 stepId delta 续流 lastStreaming 载体', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    // 键控 delta 建载体后，keyless delta（旧式帧）回落追加（同 identity-throughput 用例语义）
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'run-k', stepId: 'run-k:0' } }, { delta: '旧式' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' } }, { delta: '流' }]);
    feed.ingestFrame('step/journaled', [{ agent: 'alpha', conversationId: CONV, run: 'run-k', rows: [{ type: 'step/content', text: '旧式流', ts: 1 }] }]);
    feed.ingestFrame('run/settled', [{ agent: 'alpha', conversationId: CONV, run: 'run-k', finish: 'stop', text: '旧式流' }]);
    const raw = feed.getRaw(DIALOG);
    const asst = raw.find((m: any) => m.role === 'agent' && m.content === '旧式流');
    expect(asst).toBeTruthy();
    expect(raw.some((m: any) => m.isStreaming)).toBe(false);
  });
});
