// ============================================================
// frame-scheduler.test.ts —— P4-2 单 rAF 流水线（cr-1287）
//
// 验证目标（§四 P4-2）：每帧恰一次提交（探针断言）；五节拍归一为
//   ingest → derive → commit → scroll 单链同帧有序。
// node 环境：rAF 以 16ms setTimeout 垫片、vitest fake timers 驱动
//（与 chunked-markdown.test.ts 同款）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  frameStats, markActivity, noteCommit, resetFrameScheduler,
  retainLoop, scheduleFrame, whenIdle,
} from '../client/frameScheduler.ts';
import { effectScope } from 'vue';
import { useChunkedMarkdown } from '../client/useChunkedMarkdown.ts';

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

/** 走完恰好一帧（rAF 垫片 = 16ms setTimeout；17ms 不跨越第二帧边界） */
const nextFrame = () => vi.advanceTimersByTimeAsync(17);

describe('P4-2 帧阶段序：ingest → derive → commit → scroll 同帧有序', () => {
  beforeEach(() => { vi.useFakeTimers(); resetFrameScheduler(); });
  afterEach(() => { vi.useRealTimers(); resetFrameScheduler(); });

  it('跨阶段按固定序执行（与登记序无关）——提交先于滚动：本帧渲染的高度当帧可见', async () => {
    const order: string[] = [];
    scheduleFrame('scroll', () => order.push('scroll'));
    scheduleFrame('commit', () => order.push('commit'));
    scheduleFrame('ingest', () => order.push('ingest'));
    scheduleFrame('derive', () => order.push('derive'));
    await nextFrame();
    expect(order).toEqual(['ingest', 'derive', 'commit', 'scroll']);
  });

  it('同阶段同帧按登记序执行，且同帧只跑一遍队列快照', async () => {
    const order: number[] = [];
    scheduleFrame('commit', () => order.push(1));
    scheduleFrame('commit', () => order.push(2));
    scheduleFrame('commit', () => order.push(3));
    await nextFrame();
    expect(order).toEqual([1, 2, 3]);
  });

  it('任务内登记同阶段任务 → 落下一帧（防同帧自激）', async () => {
    const frames: string[] = [];
    scheduleFrame('commit', () => { frames.push('a'); scheduleFrame('commit', () => frames.push('b')); });
    await nextFrame();
    expect(frames).toEqual(['a']);
    await nextFrame();
    expect(frames).toEqual(['a', 'b']);
  });

  it('单任务异常不拖垮整帧（其余阶段照常推进）', async () => {
    const order: string[] = [];
    scheduleFrame('ingest', () => { throw new Error('boom'); });
    scheduleFrame('commit', () => order.push('commit'));
    scheduleFrame('scroll', () => order.push('scroll'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await nextFrame();
    expect(order).toEqual(['commit', 'scroll']);
    spy.mockRestore();
  });

});

describe('P4-2 探针：每帧恰一次提交', () => {
  beforeEach(() => { vi.useFakeTimers(); resetFrameScheduler(); });
  afterEach(() => { vi.useRealTimers(); resetFrameScheduler(); });

  it('单帧多任务提交打点如实累计（上界可见性：同帧两提交即被记到）', async () => {
    scheduleFrame('commit', () => noteCommit());
    scheduleFrame('commit', () => noteCommit());
    await nextFrame();
    const s = frameStats();
    expect(s.commits).toBe(2);
    expect(s.maxCommitsPerFrame).toBe(2); // 探针如实反映；真实 hook 内同帧只登记一次
  });

  it('连续多帧提交：maxCommitsPerFrame 恒 1（每帧至多一次）', async () => {
    for (let i = 0; i < 5; i++) {
      scheduleFrame('commit', () => noteCommit());
      await nextFrame();
    }
    const s = frameStats();
    expect(s.frames).toBe(5);
    expect(s.commits).toBe(5);
    expect(s.maxCommitsPerFrame).toBe(1); // 验证目标：每帧恰一次提交
  });

  it('静默提交单独计数（idle-commit 可观测）', () => {
    noteCommit(true);
    noteCommit();
    const s = frameStats();
    expect(s.idleCommits).toBe(1);
    expect(s.commits).toBe(2);
  });
});

describe('P4-2 调度器级静默判据', () => {
  beforeEach(() => { vi.useFakeTimers(); resetFrameScheduler(); });
  afterEach(() => { vi.useRealTimers(); resetFrameScheduler(); });

  it('活动打点重置计时：持续活动不触发静默回调', async () => {
    let fired = 0;
    whenIdle(600, () => { fired++; });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(300);
      markActivity(); // 模拟持续 ingest
    }
    expect(fired).toBe(0); // 1.5s 内的持续活动从未凑满 600ms 静默
    await vi.advanceTimersByTimeAsync(700);
    expect(fired).toBe(1);
  });

  it('触发即退订（一次性）——不再重复回调', async () => {
    let fired = 0;
    whenIdle(600, () => { fired++; });
    await vi.advanceTimersByTimeAsync(700);
    expect(fired).toBe(1);
    markActivity();
    await vi.advanceTimersByTimeAsync(700);
    expect(fired).toBe(1); // 未被重新武装
  });

  it('取消函数撤销订阅', async () => {
    let fired = 0;
    const cancel = whenIdle(600, () => { fired++; });
    cancel();
    await vi.advanceTimersByTimeAsync(700);
    expect(fired).toBe(0);
  });

  it('多订阅者共用同一活动时钟（各自阈值）', async () => {
    const log: string[] = [];
    whenIdle(200, () => log.push('fast'));
    whenIdle(600, () => log.push('slow'));
    await vi.advanceTimersByTimeAsync(250);
    expect(log).toEqual(['fast']);
    await vi.advanceTimersByTimeAsync(400);
    expect(log).toEqual(['fast', 'slow']);
  });
});

describe('P4-2 真实 hook：每帧恰一次提交（markdown commit 阶段）', () => {
  beforeEach(() => { vi.useFakeTimers(); resetFrameScheduler(); });
  afterEach(() => { vi.useRealTimers(); resetFrameScheduler(); });

  it('同帧多次 update → 恰一次提交（同帧合并构造性保证）', async () => {
    const scope = effectScope(true);
    let renders = 0;
    const api = scope.run(() => useChunkedMarkdown((s) => { renders++; return s; }))!;
    api.update('段一\n\n', true);
    api.update('段一\n\nab', true);
    api.update('段一\n\nabc', true); // 同帧三次 delta
    await nextFrame();
    const s = frameStats();
    expect(s.maxCommitsPerFrame).toBe(1); // 每帧恰一次提交
    expect(renders).toBe(1); // 渲染函数一次（前缀只提交一次）
    expect(api.pendingText.value).toBe('abc');
    scope.stop();
  });

  it('多帧流式：每帧至多一次提交，前缀增长才重渲染', async () => {
    const scope = effectScope(true);
    let renders = 0;
    const api = scope.run(() => useChunkedMarkdown((s) => { renders++; return s; }))!;
    api.update('一\n\na', true);
    await nextFrame();
    api.update('一\n\nab', true);
    await nextFrame();
    api.update('一\n\nabc', true);
    await nextFrame();
    expect(frameStats().maxCommitsPerFrame).toBe(1);
    expect(renders).toBe(1); // 前缀「一\n\n」三帧内未变，只渲染一次
    expect(api.pendingText.value).toBe('abc');
    scope.stop();
  });
});

describe('P4-2 持帧循环', () => {
  beforeEach(() => { vi.useFakeTimers(); resetFrameScheduler(); });
  afterEach(() => { vi.useRealTimers(); resetFrameScheduler(); });

  it('retainLoop 空帧保活；释放后循环停摆', async () => {
    const release = retainLoop();
    await nextFrame();
    const f1 = frameStats().frames;
    expect(f1).toBeGreaterThanOrEqual(1);
    await nextFrame();
    expect(frameStats().frames).toBeGreaterThan(f1); // 无任务也持续跑帧
    release();
    release(); // 幂等
    await nextFrame(); // 吃掉释放时已排程的那一拍（rAF 无法撤回——语义上无害）
    const f2 = frameStats().frames;
    await nextFrame();
    expect(frameStats().frames).toBe(f2); // 释放后不再续排
  });
});

