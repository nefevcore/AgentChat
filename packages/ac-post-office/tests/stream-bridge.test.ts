// ============================================================
// stream-bridge.test.ts —— 8.5d 旁带帧 → 前端流式帧桥接单测
// 帧形与主线 ws-bridge 对拍：llm/delta-batch（30ms 微批 + 首帧直发）
// 与 llm/delta-end（flush 保序）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { ShellStreamBridge, type FrontendFrame } from '../src/stream-bridge.ts';
import { LlmDeltaBatcher, LLM_DELTA_BATCH } from 'ac-wire-format';
import { streamFrameToFrontend } from '../src/stream-bridge.ts';

describe('8.5d ShellStreamBridge（旁带 → 前端帧）', () => {
  it('delta 帧入批：首帧直发 llm/delta-batch（input 已投影——帧面只留 model+meta）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 'run-1:0', kind: 'delta', text: '你好', meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 'run-1:0' } });
    // 首帧直发（30ms 窗口语义——流式起步延迟为零）
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('llm/delta-batch');
    const batch = frames[0].data.args[0] as { deltas: unknown[][] };
    expect(batch.deltas).toEqual([[
      { model: undefined, meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 'run-1:0' } },
      { delta: '你好' },
      { agent: 'alpha', conversationId: 'u~alpha', stepId: 'run-1:0' },
    ]]);
  });

  it('end 帧：flush 在途批（保序）+ llm/delta-end 帧（meta 双位路由）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 's1', kind: 'delta', text: 'a', meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 's1' } });
    bridge.ingest({ stream: 's1', kind: 'delta', text: 'b' });
    bridge.ingest({ stream: 's1', kind: 'end', finish: 'ok', meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 's1' } });
    // 首帧直发 + 第二帧入窗 → end flushNow 保序下发
    const batches = frames.filter((f) => f.type === LLM_DELTA_BATCH);
    expect(batches).toHaveLength(2);
    expect((batches[0].data.args[0] as { deltas: unknown[][] }).deltas).toHaveLength(1);
    expect((batches[1].data.args[0] as { deltas: unknown[][] }).deltas).toHaveLength(1);
    const ends = frames.filter((f) => f.type === 'llm/delta-end');
    expect(ends).toHaveLength(1);
    expect(ends[0].data.args).toEqual([
      { model: undefined, meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 's1' } },
      { agent: 'alpha', conversationId: 'u~alpha', stepId: 's1' },
    ]);
  });

  it('close()：清空在途批不丢帧；非 StreamFrame 忽略', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 's1', kind: 'delta', text: 'x', meta: { stepId: 's1' } });
    bridge.ingest({ stream: 's1', kind: 'delta', text: 'y' }); // 第二帧入窗
    bridge.ingest({ ack: 'req-1', fresh: true }); // 非 StreamFrame 忽略
    bridge.close();
    // 首帧直发 + 第二帧经 close flush——delta 守恒（两条各达一次）
    const texts: string[] = [];
    for (const f of frames.filter((x) => x.type === LLM_DELTA_BATCH)) {
      const batch = f.data.args[0] as { deltas: Array<[unknown, { delta: string }]> };
      for (const d of batch.deltas) texts.push(d[1].delta);
    }
    expect(texts).toEqual(['x', 'y']);
  });

  it('end 无 meta：仍产出 delta-end 帧（finish 词汇映射）', () => {
    const frames: FrontendFrame[] = [];
    const batcher = new LlmDeltaBatcher((args) => frames.push({ type: LLM_DELTA_BATCH, data: { args: [args] } }));
    streamFrameToFrontend({ stream: 'r1', kind: 'end', finish: 'error' }, batcher, (f) => frames.push(f));
    const ends = frames.filter((f) => f.type === 'llm/delta-end');
    expect(ends).toHaveLength(1);
  });

  it('ledger-event 收束切片（cr-976）：→ run/settled 帧（completed→stop + 同批终稿 text + seq 锚 + flush 在途批保序）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f), immediateFirst: true });
    bridge.ingest({ stream: 's1', kind: 'delta', text: '半截', meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 's1' } });
    bridge.ingest({ stream: 's1', kind: 'delta', text: '流' });
    bridge.ingest({
      stream: 'run-r1',
      kind: 'ledger-event',
      rows: [
        { type: 'message', role: 'agent', content: '终稿全文', run: 'run-r1', seq: 12 },
        { type: 'run-end', run: 'run-r1', finish: 'completed', runMs: 4200, ts: 1 },
      ],
      meta: { agent: 'alpha', conversationId: 'u~alpha', runId: 'run-r1' },
    });
    // 在途批已 flush（run/settled 前保序——收敛前零在途）
    const batches = frames.filter((f) => f.type === LLM_DELTA_BATCH);
    expect(batches).toHaveLength(2);
    const settled = frames.filter((f) => f.type === 'run/settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].data.args).toEqual([{
      agent: 'alpha', conversationId: 'u~alpha', run: 'run-r1', seq: undefined,
      finish: 'stop', text: '终稿全文', runMs: 4200, ts: 1,
    }]);
  });

  it('ledger-event 收束 error/interrupted：finish 透传 + errorMessage（前端红条/中断分隔符路径）', () => {
    for (const [finish, want] of [['error', 'error'], ['interrupted', 'interrupted']] as const) {
      const frames: FrontendFrame[] = [];
      const batcher = new LlmDeltaBatcher((args) => frames.push({ type: LLM_DELTA_BATCH, data: { args: [args] } }));
      streamFrameToFrontend(
        { stream: 'r1', kind: 'ledger-event', rows: [{ type: 'run-end', run: 'r1', finish, errorMessage: '连接超时', seq: 9, ts: 2 }] },
        batcher,
        (f) => frames.push(f),
      );
      const settled = frames.filter((f) => f.type === 'run/settled');
      expect(settled).toHaveLength(1);
      expect(settled[0].data.args[0]).toMatchObject({ finish: want, error: '连接超时', text: '', seq: 9 });
    }
  });

  it('run 生命周期帧（cr-592/976）：run-started 直转 + ledger-event 步相位批 → step/journaled 帧（行序即步内序 + seq 锚）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 'run-r1', kind: 'run-started', meta: { agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user', runId: 'run-r1' } });
    bridge.ingest({
      stream: 'run-r1:0',
      kind: 'ledger-event',
      rows: [
        { type: 'step/reasoning', run: 'run-r1', step: 0, stepId: 'run-r1:0', text: '思考', reasoningMs: 4200, ts: 1, seq: 3 },
        { type: 'step/content', run: 'run-r1', step: 0, stepId: 'run-r1:0', text: '终值', ts: 1, seq: 4 },
      ],
      meta: { agent: 'alpha', conversationId: 'u~alpha', runId: 'run-r1', stepId: 'run-r1:0' },
    });
    const runStarted = frames.filter((f) => f.type === 'loop/run-started');
    expect(runStarted).toHaveLength(1);
    expect(runStarted[0].data.args).toEqual([{ agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user' }]);
    const stepJourn = frames.filter((f) => f.type === 'step/journaled');
    expect(stepJourn).toHaveLength(1);
    // 步相位行原样直通（聚合归前端）；seq = 批末行（B2 水位锚）
    expect(stepJourn[0].data.args).toEqual([{
      agent: 'alpha', conversationId: 'u~alpha', run: 'run-r1', step: 0,
      stepId: 'run-r1:0', seq: 4,
      rows: [
        { type: 'step/reasoning', run: 'run-r1', step: 0, stepId: 'run-r1:0', text: '思考', reasoningMs: 4200, ts: 1, seq: 3 },
        { type: 'step/content', run: 'run-r1', step: 0, stepId: 'run-r1:0', text: '终值', ts: 1, seq: 4 },
      ],
    }]);
  });

  it('工具执行帧（cr-593/976）：tool-started / tool-progress 流帧直转 + tool-call-result 行 → tool/result 帧', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    const call = { agentId: 'alpha', conversationId: 'u~alpha', toolCallId: 'call-1', runId: 'run-r1', name: 'pwsh' };
    bridge.ingest({ stream: 'call-1', kind: 'tool-started', call, meta: { agent: 'alpha', conversationId: 'u~alpha', runId: 'run-r1' } });
    bridge.ingest({ stream: 'call-1', kind: 'tool-progress', call, chunk: '半截输出', meta: { agent: 'alpha' } });
    bridge.ingest({
      stream: 'run-r1',
      kind: 'ledger-event',
      rows: [{ type: 'step/tool-call-result', run: 'run-r1', toolCallId: 'call-1', result: { ok: true }, durationMs: 30, ts: 1, seq: 7 }],
      meta: { agent: 'alpha', conversationId: 'u~alpha', runId: 'run-r1' },
    });
    expect(frames.filter((f) => f.type === 'tool/started')).toEqual([{ type: 'tool/started', data: { args: [call] } }]);
    expect(frames.filter((f) => f.type === 'tool/progress')).toEqual([{ type: 'tool/progress', data: { args: [call, '半截输出'] } }]);
    const tr = frames.filter((f) => f.type === 'tool/result');
    expect(tr).toHaveLength(1);
    expect(tr[0].data.args[0]).toMatchObject({
      agent: 'alpha', conversationId: 'u~alpha', run: 'run-r1', toolCallId: 'call-1',
      seq: 7, result: { ok: true }, durationMs: 30,
    });
  });

  it('run/settled 前 flush 在途批（保序：收敛边界不吞尾批——步收束不再强制 flush，流帧自然出窗）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 'run-r1:0', kind: 'delta', text: '尾段', meta: { agent: 'alpha', stepId: 'run-r1:0' } });
    bridge.ingest({ stream: 'run-r1:0', kind: 'delta', text: '流' });
    bridge.ingest({ stream: 'run-r1', kind: 'ledger-event', rows: [{ type: 'run-end', run: 'run-r1', finish: 'completed', ts: 1, seq: 9 }], meta: { agent: 'alpha', runId: 'run-r1' } });
    const batches = frames.filter((f) => f.type === LLM_DELTA_BATCH);
    expect(batches).toHaveLength(2); // 首帧直发 + 收敛 flush
  });
  it('queue-changed 帧（cr-579）：→ 主线 conversation/queue-changed 帧形（四参序快照直套）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({
      stream: 'u~alpha',
      kind: 'queue-changed',
      handle: 'u~alpha~alpha',
      items: [{ id: 'q2', preview: '排队消息A', sender: 'user', source: 'user', queuedAt: 42 }],
      meta: { agent: 'alpha', conversationId: 'u~alpha' },
    });
    const qc = frames.filter((f) => f.type === 'conversation/queue-changed');
    expect(qc).toHaveLength(1);
    expect(qc[0].data.args).toEqual([
      'alpha',
      'u~alpha',
      'u~alpha~alpha',
      [{ id: 'q2', preview: '排队消息A', sender: 'user', source: 'user', queuedAt: 42 }],
    ]);
  });

  it('持久化交互帧（cr-625）：opened 整形 questions 上提 / 他 kind 原样 / replied·closed 透传', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    const askq = { id: 'dur-1', kind: 'ask_questions', key: 'sid-1', state: 'pending', payload: { questions: [{ question: '选 A 还是 B？', options: ['A', 'B'] }] } };
    bridge.ingest({ stream: 'dur-1', kind: 'interaction-opened', record: askq, meta: { agent: 'alpha' } });
    const other = { id: 'dur-2', kind: 'approval', key: 'sid-2', state: 'pending', payload: { scope: 'global' } };
    bridge.ingest({ stream: 'dur-2', kind: 'interaction-opened', record: other, meta: { agent: 'alpha' } });
    bridge.ingest({ stream: 'dur-1', kind: 'interaction-replied', record: { id: 'dur-1', state: 'answered' }, meta: { agent: 'alpha' } });
    bridge.ingest({ stream: 'dur-2', kind: 'interaction-closed', record: { id: 'dur-2', state: 'closed' }, meta: { agent: 'alpha' } });
    const opened = frames.filter((f) => f.type === 'durable-interaction/opened');
    expect(opened).toHaveLength(2);
    // ask_questions：payload.questions 上提顶层（主线 M7 §二B 整形，payload 剥除）
    expect(opened[0].data.args).toEqual([{
      id: 'dur-1', kind: 'ask_questions', key: 'sid-1', state: 'pending',
      questions: [{ question: '选 A 还是 B？', options: ['A', 'B'] }],
    }]);
    expect(opened[1].data.args).toEqual([other]); // 他 kind 原样（payload 不动）
    expect(frames.filter((f) => f.type === 'durable-interaction/replied')[0].data.args)
      .toEqual([{ id: 'dur-1', state: 'answered' }]);
    expect(frames.filter((f) => f.type === 'durable-interaction/closed')[0].data.args)
      .toEqual([{ id: 'dur-2', state: 'closed' }]);
  });

  it('上下文注入帧（cr-625）：→ 主线 session/context-injected 帧形（三参序，meta 子集透传）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({
      stream: 'sid-1',
      kind: 'context-injected',
      source: 'durable-interaction',
      label: '已收到用户回答',
      injectionId: 'ctx-1',
      meta: { agent: 'alpha', conversationId: 'sid-1' },
    });
    const ci = frames.filter((f) => f.type === 'session/context-injected');
    expect(ci).toEqual([{
      type: 'session/context-injected',
      data: { args: ['sid-1', 'alpha', { source: 'durable-interaction', injectionId: 'ctx-1', label: '已收到用户回答' }] },
    }]);
  });

  it('思考/工具分片透传（cr-586）：chunk.reasoning / chunk.toolCalls 直达前端消费面', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 's1', kind: 'delta', text: '', reasoning: '推演中', meta: { agent: 'alpha', stepId: 's1' } });
    bridge.ingest({ stream: 's1', kind: 'delta', text: '', toolCalls: [{ index: 0, name: 'hello' }], meta: { agent: 'alpha', stepId: 's1' } });
    bridge.close(); // 第二帧在 30ms 窗口内——收束清批不丢帧
    const chunks: unknown[] = [];
    for (const f of frames.filter((x) => x.type === LLM_DELTA_BATCH)) {
      const batch = f.data.args[0] as { deltas: Array<[unknown, unknown]> };
      for (const d of batch.deltas) chunks.push(d[1]);
    }
    // feed-core 消费词汇原样：reasoning 直播 + preparing 卡
    expect(chunks).toEqual([
      { delta: '', reasoning: '推演中' },
      { delta: '', toolCalls: [{ index: 0, name: 'hello' }] },
    ]);
  });

  it('job-event 帧（cr-677）：→ 主线 job/started · job/settled 帧形（args = [job] 恒等透传）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    const started = { id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: 1 };
    const settled = { id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'completed', startedAt: 1, finishedAt: 2 };
    bridge.ingest({ stream: 'bash-1', kind: 'job-event', phase: 'started', job: started, meta: { agent: 'alpha' } });
    bridge.ingest({ stream: 'bash-1', kind: 'job-event', phase: 'settled', job: settled, meta: { agent: 'alpha' } });
    expect(frames.filter((f) => f.type === 'job/started')[0].data.args).toEqual([started]);
    expect(frames.filter((f) => f.type === 'job/settled')[0].data.args).toEqual([settled]);
  });

  it('【cr-1188】event 帧（archive/completed）：宿主直转同名前端帧（args = [payload] 单参恒等透传）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    const payload = { agentId: 'alpha', conversationId: 'user~alpha', archived: 12 };
    bridge.ingest({ stream: 'user~alpha', kind: 'event', name: 'archive/completed', payload, meta: { agent: 'alpha', conversationId: 'user~alpha' } });
    expect(frames).toEqual([{ type: 'archive/completed', data: { args: [payload] } }]);
  });

  it('【cr-1188】run-started 帧 runMeta 透传：meta.runMeta → args[0].meta（前端 archive-review 判定消费面）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 'run-r1', kind: 'run-started', meta: { agent: 'alpha', conversationId: 'user~alpha', source: 'event', runId: 'run-r1', runMeta: { 'archive-review': true } } });
    const started = frames.filter((f) => f.type === 'loop/run-started');
    expect(started).toHaveLength(1);
    expect(started[0].data.args).toEqual([{
      agent: 'alpha', conversationId: 'user~alpha', source: 'event',
      meta: { 'archive-review': true },
    }]);
    // 无 runMeta 帧：args[0] 不带 meta 键（形状与主线一致——旧帧兼容）
    frames.length = 0;
    bridge.ingest({ stream: 'run-r2', kind: 'run-started', meta: { agent: 'alpha', conversationId: 'user~alpha', source: 'user', runId: 'run-r2' } });
    expect(frames[0].data.args).toEqual([{ agent: 'alpha', conversationId: 'user~alpha', source: 'user' }]);
  });

  it('subagents-updated 帧（cr-677）：→ 主线 subagents/updated 帧形（args = [info, action] 参数序）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    const info = { id: 'sub-abc', parentId: 'alpha', name: '调研员', status: 'ready', displayStatus: 'running', task: '查证', runs: 0, createdAt: 1, updatedAt: 2, deleted: false };
    bridge.ingest({ stream: 'sub-abc', kind: 'subagents-updated', info, action: 'spawned', meta: { agent: 'alpha' } });
    const out = frames.filter((f) => f.type === 'subagents/updated');
    expect(out).toHaveLength(1);
    expect(out[0].data.args).toEqual([info, 'spawned']);
  });
});