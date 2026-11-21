// ============================================================
// M7.2 B3 流式旁带帧单测：schema 判别 / 发射器语义 / 帧往返
// ============================================================
import { describe, it, expect } from 'vitest';
import { isStreamFrame, StreamEmitter, streamFrameFromDelta, encodeFrame, FrameDecoder } from '../src/index.ts';

describe('M7.2 B3 流式旁带', () => {
  it('isStreamFrame 判别：delta/end 合法，信封/ack/杂物非法', () => {
    expect(isStreamFrame({ stream: 's1', kind: 'delta', text: 'hi' })).toBe(true);
    expect(isStreamFrame({ stream: 's1', kind: 'end', finish: 'ok' })).toBe(true);
    // cr-976 B 案（D3-3）：run-settled / step-started / after-step /
    // tool-result 帧族退役——判别面拒识（旧词汇旁带帧不再合法）
    expect(isStreamFrame({ stream: 'r1', kind: 'run-settled', finish: 'error', text: '', message: '连接超时' })).toBe(false);
    expect(isStreamFrame({ stream: 'run-r1:0', kind: 'step-started', index: 0 })).toBe(false);
    expect(isStreamFrame({ stream: 'run-r1:0', kind: 'after-step', step: { stepId: 'run-r1:0' } })).toBe(false);
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-result', call: {}, result: { ok: true } })).toBe(false);
    expect(isStreamFrame({ stream: 'c1', kind: 'queue-changed', handle: 'c1~a', items: [] })).toBe(true);
    expect(isStreamFrame({ stream: 'c1', kind: 'queue-changed', items: [] })).toBe(false); // 缺 handle
    // cr-592 run 生命周期帧：run-started（流时序帧，D3-1 保留）
    expect(isStreamFrame({ stream: 'run-r1', kind: 'run-started' })).toBe(true);
    // cr-976 事件日志落账帧：rows 非空数组即合法
    expect(isStreamFrame({ stream: 'run-r1', kind: 'ledger-event', rows: [{ type: 'run-end', run: 'run-r1', seq: 9 }] })).toBe(true);
    expect(isStreamFrame({ stream: 'run-r1', kind: 'ledger-event', rows: [] })).toBe(false); // 空批
    expect(isStreamFrame({ stream: 'run-r1', kind: 'ledger-event' })).toBe(false); // 缺 rows
    // cr-593 工具执行流帧（started/progress 保留；终值走 ledger-event）
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-started', call: { toolCallId: 'call-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-progress', call: {}, chunk: '半截输出' })).toBe(true);
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-progress', call: {} })).toBe(false); // 缺 chunk
    // cr-625 持久化交互帧
    expect(isStreamFrame({ stream: 'dur-1', kind: 'interaction-opened', record: { id: 'dur-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'dur-1', kind: 'interaction-replied', record: { id: 'dur-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'dur-1', kind: 'interaction-closed', record: { id: 'dur-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'dur-1', kind: 'interaction-opened' })).toBe(false); // 缺 record
    // cr-625 上下文注入帧
    expect(isStreamFrame({ stream: 'c1', kind: 'context-injected', source: 'durable-interaction', label: '已收到用户回答' })).toBe(true);
    expect(isStreamFrame({ stream: 'c1', kind: 'context-injected' })).toBe(false); // 缺 source
    // cr-677 后台任务/子Agent 清单帧
    expect(isStreamFrame({ stream: 'bash-1', kind: 'job-event', phase: 'started', job: { id: 'bash-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'bash-1', kind: 'job-event', phase: 'settled', job: { id: 'bash-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'bash-1', kind: 'job-event', phase: 'other', job: {} })).toBe(false); // phase 词表外
    expect(isStreamFrame({ stream: 'bash-1', kind: 'job-event', phase: 'started' })).toBe(false); // 缺 job
    expect(isStreamFrame({ stream: 'sub-abc', kind: 'subagents-updated', info: { id: 'sub-abc' }, action: 'spawned' })).toBe(true);
    expect(isStreamFrame({ stream: 'sub-abc', kind: 'subagents-updated', action: 'spawned' })).toBe(false); // 缺 info
    // cr-1188 低频机制事件帧：name 非空即合法（archive/completed 等）
    expect(isStreamFrame({ stream: 'c1', kind: 'event', name: 'archive/completed', payload: {} })).toBe(true);
    expect(isStreamFrame({ stream: 'c1', kind: 'event', name: '', payload: {} })).toBe(false); // 空名
    expect(isStreamFrame({ stream: 'c1', kind: 'event', payload: {} })).toBe(false); // 缺 name
    expect(isStreamFrame({ ack: 'req-1', fresh: true })).toBe(false); // ack 帧
    expect(isStreamFrame({ uuid: 'u', requestId: 'r', sender: 'user', to: 'a', kind: 'message', budget: 3, payload: {} })).toBe(false); // 信封
    expect(isStreamFrame(null)).toBe(false);
    expect(isStreamFrame({ stream: 's1', kind: 'other' })).toBe(false);
    expect(isStreamFrame({ kind: 'delta', text: '缺 stream' })).toBe(false);
  });

  it('StreamEmitter：delta/end 语义（end 后静默）+ 帧编码往返', () => {
    const sent: unknown[] = [];
    const emitter = new StreamEmitter((f) => sent.push(f));
    emitter.delta('你');
    emitter.delta('好');
    emitter.end('ok');
    emitter.delta('end 后静默');
    emitter.end('error');
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ stream: expect.any(String), kind: 'delta', text: '你' });
    expect(sent[2]).toEqual({ stream: expect.any(String), kind: 'end', finish: 'ok' });
    // 帧编码往返（B2 长度前缀帧）
    const decoder = new FrameDecoder();
    const back = decoder.push(encodeFrame(sent[1]));
    expect(back).toEqual([sent[1]]);
  });

  it('多流并发：两个 emitter 各自 stream id 不同', () => {
    const ids: string[] = [];
    const a = new StreamEmitter((f) => ids.push(f.stream));
    const b = new StreamEmitter((f) => ids.push(f.stream));
    a.delta('1');
    b.delta('2');
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('streamFrameFromDelta（cr-586）：正文/思考/工具分片帧化，全空不出帧', () => {
    const meta = { agent: 'a', stepId: 's1' };
    // 纯 reasoning 帧（思考模型思考期——text 空串占位，判别式不破）
    const [think] = streamFrameFromDelta(meta, { reasoning: '推演中' });
    expect(think).toEqual({ stream: 's1', kind: 'delta', text: '', reasoning: '推演中', meta });
    expect(isStreamFrame(think)).toBe(true);
    // 工具调用分片
    const [tool] = streamFrameFromDelta(meta, { toolCalls: [{ index: 0, name: 'hello' }] });
    expect(tool).toMatchObject({ kind: 'delta', text: '', toolCalls: [{ index: 0, name: 'hello' }] });
    // 正文 + finish 同 chunk → 两帧
    const both = streamFrameFromDelta(meta, { delta: '你好', finish: 'stop' });
    expect(both).toEqual([
      { stream: 's1', kind: 'delta', text: '你好', meta },
      { stream: 's1', kind: 'end', finish: 'ok', meta },
    ]);
    // 全空且无 finish → 零帧；stepId/runId 双缺 → 零帧
    expect(streamFrameFromDelta(meta, { delta: '' })).toEqual([]);
    expect(streamFrameFromDelta(undefined, { delta: 'x' })).toEqual([]);
  });
});
