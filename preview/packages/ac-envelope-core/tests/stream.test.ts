// ============================================================
// M7.2 B3 流式旁带帧单测：schema 判别 / 发射器语义 / 帧往返
// ============================================================
import { describe, it, expect } from 'vitest';
import { isStreamFrame, StreamEmitter, streamFrameFromDelta, encodeFrame, FrameDecoder } from '../src/index.ts';

describe('M7.2 B3 流式旁带', () => {
  it('isStreamFrame 判别：delta/end 合法，信封/ack/杂物非法', () => {
    expect(isStreamFrame({ stream: 's1', kind: 'delta', text: 'hi' })).toBe(true);
    expect(isStreamFrame({ stream: 's1', kind: 'end', finish: 'ok' })).toBe(true);
    expect(isStreamFrame({ stream: 'r1', kind: 'run-settled', finish: 'error', text: '', message: '连接超时' })).toBe(true);
    expect(isStreamFrame({ stream: 'r1', kind: 'run-settled', finish: 'ok', text: '终稿' })).toBe(true);
    expect(isStreamFrame({ stream: 'r1', kind: 'run-settled', finish: 'ok' })).toBe(false); // 缺 text
    expect(isStreamFrame({ stream: 'c1', kind: 'queue-changed', handle: 'c1~a', items: [] })).toBe(true);
    expect(isStreamFrame({ stream: 'c1', kind: 'queue-changed', items: [] })).toBe(false); // 缺 handle
    // cr-592 run 生命周期帧：run-started / step-started / after-step
    expect(isStreamFrame({ stream: 'run-r1', kind: 'run-started' })).toBe(true);
    expect(isStreamFrame({ stream: 'run-r1:0', kind: 'step-started', index: 0 })).toBe(true);
    expect(isStreamFrame({ stream: 'run-r1:0', kind: 'step-started' })).toBe(false); // 缺 index
    expect(isStreamFrame({ stream: 'run-r1:0', kind: 'after-step', step: { stepId: 'run-r1:0' } })).toBe(true);
    expect(isStreamFrame({ stream: 'run-r1:0', kind: 'after-step' })).toBe(false); // 缺 step
    // cr-593 工具执行帧
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-started', call: { toolCallId: 'call-1' } })).toBe(true);
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-progress', call: {}, chunk: '半截输出' })).toBe(true);
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-progress', call: {} })).toBe(false); // 缺 chunk
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-result', call: {}, result: { ok: true } })).toBe(true);
    expect(isStreamFrame({ stream: 'call-1', kind: 'tool-result' })).toBe(false); // 缺 call
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
