// ============================================================
// ac-wire-format 测试：投影瘦身 / 首帧即发 + 窗口攒批 / 边界 flush / 解包
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmDeltaBatcher, LLM_DELTA_BATCH, unpackWireFrames, wireLlmInput } from '../src/index.ts';

afterEach(() => { vi.useRealTimers(); });

describe('wireLlmInput 投影', () => {
  it('剥 messages/tools 全量上下文，只留 {model, meta}', () => {
    const input = { model: 'm', meta: { agent: 'a' }, messages: new Array(1000).fill('x'), tools: [{ t: 1 }] };
    expect(wireLlmInput(input)).toEqual({ model: 'm', meta: { agent: 'a' } });
  });

  it('非对象原样返回（防御契约）', () => {
    expect(wireLlmInput(undefined)).toBeUndefined();
    expect(wireLlmInput(null)).toBeNull();
  });
});

describe('LlmDeltaBatcher', () => {
  it('窗口首帧立即发（起步零延迟），窗口内后续帧同帧下发', () => {
    vi.useFakeTimers();
    const out: Array<{ deltas: unknown[][] }> = [];
    const b = new LlmDeltaBatcher((args) => out.push(args), 30);
    b.push({ model: 'm', messages: [] }, { delta: 'a' }, { agent: 'x' });
    expect(out).toHaveLength(1); // 首帧即发
    expect(out[0]!.deltas).toHaveLength(1);
    // input 已投影（帧面无 messages）
    expect((out[0]!.deltas[0]![0] as { messages?: unknown }).messages).toBeUndefined();
    b.push({ model: 'm' }, { delta: 'b' }, {});
    b.push({ model: 'm' }, { delta: 'c' }, {});
    expect(out).toHaveLength(1); // 窗口内攒批
    vi.advanceTimersByTime(30);
    expect(out).toHaveLength(2);
    expect(out[1]!.deltas).toHaveLength(2); // b、c 合一帧
  });

  it('窗口过后新窗口自动开启（持续流式多窗批）', () => {
    vi.useFakeTimers();
    const out: Array<{ deltas: unknown[][] }> = [];
    const b = new LlmDeltaBatcher((args) => out.push(args), 30);
    b.push({}, { delta: 1 }, {});
    vi.advanceTimersByTime(30); // 窗口 1 收
    b.push({}, { delta: 2 }, {}); // 新窗口首帧即发
    vi.advanceTimersByTime(30);
    expect(out).toHaveLength(2);
  });

  it('flushNow 清空在途（边界不丢帧、不留悬挂定时器）', () => {
    vi.useFakeTimers();
    const out: Array<{ deltas: unknown[][] }> = [];
    const b = new LlmDeltaBatcher((args) => out.push(args), 30);
    b.push({}, { delta: 1 }, {}); // 首帧即发（队空）
    b.push({}, { delta: 2 }, {}); // 进窗口
    b.flushNow();
    expect(out).toHaveLength(2);
    expect(out[1]!.deltas).toEqual([[{}, { delta: 2 }, {}]]);
    vi.advanceTimersByTime(100); // 无悬挂定时器再触发
    expect(out).toHaveLength(2);
  });
});

describe('unpackWireFrames 解包', () => {
  it('批帧展开为 llm/delta 序列（参数序原样）', () => {
    const frames = unpackWireFrames(LLM_DELTA_BATCH, [{ deltas: [[{ model: 'm' }, { delta: 'a' }, {}], [{ model: 'm' }, { delta: 'b' }, {}]] }]);
    expect(frames).toEqual([
      ['llm/delta', [{ model: 'm' }, { delta: 'a' }, {}]],
      ['llm/delta', [{ model: 'm' }, { delta: 'b' }, {}]],
    ]);
  });

  it('非批帧原样返回（普通事件零变化）', () => {
    expect(unpackWireFrames('loop/after-step', [{ id: 1 }])).toEqual([['loop/after-step', [{ id: 1 }]]]);
  });

  it('畸形批帧安全展开为空（防御：不炸 wire 入口）', () => {
    expect(unpackWireFrames(LLM_DELTA_BATCH, [{}])).toEqual([]);
    expect(unpackWireFrames(LLM_DELTA_BATCH, [])).toEqual([]);
  });
});