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

  it('run-settled 帧（cr-591）：→ 主线 loop/after-run 帧形（ok→stop + 终稿 + args 参数序 + flush 在途批保序）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f), immediateFirst: true });
    bridge.ingest({ stream: 's1', kind: 'delta', text: '半截', meta: { agent: 'alpha', conversationId: 'u~alpha', stepId: 's1' } });
    bridge.ingest({ stream: 's1', kind: 'delta', text: '流' });
    bridge.ingest({
      stream: 'run-r1',
      kind: 'run-settled',
      finish: 'ok',
      text: '终稿全文',
      meta: { agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user', runId: 'run-r1' },
    });
    // 在途批已 flush（after-run 前保序）
    const batches = frames.filter((f) => f.type === LLM_DELTA_BATCH);
    expect(batches).toHaveLength(2);
    const afterRun = frames.filter((f) => f.type === 'loop/after-run');
    expect(afterRun).toHaveLength(1);
    expect(afterRun[0].data.args).toEqual([
      { agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user' },
      { finish: 'stop', text: '终稿全文' },
    ]);
  });

  it('run-settled error：finish 透传 + error 文案（前端红条路径）', () => {
    const frames: FrontendFrame[] = [];
    const batcher = new LlmDeltaBatcher((args) => frames.push({ type: LLM_DELTA_BATCH, data: { args: [args] } }));
    streamFrameToFrontend(
      { stream: 'r1', kind: 'run-settled', finish: 'error', text: '', message: '连接超时' },
      batcher,
      (f) => frames.push(f),
    );
    const afterRun = frames.filter((f) => f.type === 'loop/after-run');
    expect(afterRun).toHaveLength(1);
    expect(afterRun[0].data.args[1]).toEqual({ finish: 'error', text: '', error: '连接超时' });
  });

  it('run-settled interrupted：同帧形透传 finish（前端已中断分隔符路径）', () => {
    const frames: FrontendFrame[] = [];
    const batcher = new LlmDeltaBatcher((args) => frames.push({ type: LLM_DELTA_BATCH, data: { args: [args] } }));
    streamFrameToFrontend(
      { stream: 'r1', kind: 'run-settled', finish: 'interrupted', text: '', message: 'run 以 interrupted 收束' },
      batcher,
      (f) => frames.push(f),
    );
    const afterRun = frames.filter((f) => f.type === 'loop/after-run');
    expect(afterRun).toHaveLength(1);
    expect(afterRun[0].data.args[1]).toEqual({ finish: 'interrupted', text: '', error: 'run 以 interrupted 收束' });
  });

  it('run 生命周期帧（cr-592）：run-started / step-started / after-step → 主线 loop/* 帧形（args 参数序 + envelope 路由键）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 'run-r1', kind: 'run-started', meta: { agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user', runId: 'run-r1' } });
    bridge.ingest({ stream: 'run-r1:0', kind: 'step-started', index: 0, meta: { agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user', runId: 'run-r1', stepId: 'run-r1:0' } });
    bridge.ingest({ stream: 'run-r1:0', kind: 'after-step', step: { stepId: 'run-r1:0', text: '终值', reasoning: '思考', reasoningMs: 4200 }, meta: { agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user', runId: 'run-r1', stepId: 'run-r1:0' } });
    const runStarted = frames.filter((f) => f.type === 'loop/run-started');
    expect(runStarted).toHaveLength(1);
    expect(runStarted[0].data.args).toEqual([{ agent: 'alpha', conversationId: 'u~alpha', sender: 'user', source: 'user' }]);
    const stepStarted = frames.filter((f) => f.type === 'loop/step-started');
    expect(stepStarted).toHaveLength(1);
    // 前端只消费 agent 与 envelope（messages 空占位）；envelope.stepId = 载体索引键
    expect(stepStarted[0].data.args).toEqual([
      'alpha', 0, [],
      { runId: 'run-r1', stepId: 'run-r1:0', conversationId: 'u~alpha', sender: 'user', source: 'user' },
    ]);
    const afterStep = frames.filter((f) => f.type === 'loop/after-step');
    expect(afterStep).toHaveLength(1);
    // step 终值透传（text/reasoning/reasoningMs——前端「已思考 · Xs」权威计时源）
    expect(afterStep[0].data.args).toEqual([
      'alpha',
      { stepId: 'run-r1:0', text: '终值', reasoning: '思考', reasoningMs: 4200 },
      { runId: 'run-r1', stepId: 'run-r1:0', conversationId: 'u~alpha', sender: 'user', source: 'user' },
    ]);
  });

  it('工具执行帧（cr-593）：tool-started / tool-progress / tool-result → 主线 tool/* 帧形（args 参数序，call 透传）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    const call = { agentId: 'alpha', conversationId: 'u~alpha', toolCallId: 'call-1', runId: 'run-r1', name: 'pwsh' };
    bridge.ingest({ stream: 'call-1', kind: 'tool-started', call, meta: { agent: 'alpha', conversationId: 'u~alpha', runId: 'run-r1' } });
    bridge.ingest({ stream: 'call-1', kind: 'tool-progress', call, chunk: '半截输出', meta: { agent: 'alpha' } });
    bridge.ingest({ stream: 'call-1', kind: 'tool-result', call, result: { ok: true }, meta: { agent: 'alpha' } });
    expect(frames.filter((f) => f.type === 'tool/started')).toEqual([{ type: 'tool/started', data: { args: [call] } }]);
    expect(frames.filter((f) => f.type === 'tool/progress')).toEqual([{ type: 'tool/progress', data: { args: [call, '半截输出'] } }]);
    expect(frames.filter((f) => f.type === 'tool/after-execute')).toEqual([{ type: 'tool/after-execute', data: { args: [call, { ok: true }, undefined] } }]);
  });

  it('after-step 前 flush 在途批（保序：步收束边界不吞尾批）', () => {
    const frames: FrontendFrame[] = [];
    const bridge = new ShellStreamBridge({ send: (f) => frames.push(f) });
    bridge.ingest({ stream: 'run-r1:0', kind: 'delta', text: '尾段', meta: { agent: 'alpha', stepId: 'run-r1:0' } });
    bridge.ingest({ stream: 'run-r1:0', kind: 'delta', text: '流' });
    bridge.ingest({ stream: 'run-r1:0', kind: 'after-step', step: { stepId: 'run-r1:0' }, meta: { agent: 'alpha', stepId: 'run-r1:0' } });
    const batches = frames.filter((f) => f.type === LLM_DELTA_BATCH);
    expect(batches).toHaveLength(2); // 首帧直发 + 收束 flush
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