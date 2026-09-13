// ============================================================
// ac-client-ui-conversation/tests/chunked-markdown.test.ts
// useChunkedMarkdown 分块渲染 + idle-commit（2026-12 反馈修正：
// ask_questions 挂起窗口原始 markdown 纯文本残留）
//
// node 环境：rAF 以 16ms setTimeout 垫片、vitest fake timers 驱动。
// useChunkedMarkdown 只依赖 vue ref 与定时器，无需 DOM。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useChunkedMarkdown } from '../client/useChunkedMarkdown.ts';

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

const identity = (s: string) => s;

function mount(renderFn: (s: string) => string = identity) {
  const scope = effectScope(true);
  const api = scope.run(() => useChunkedMarkdown(renderFn))!;
  return { scope, api };
}

/** 走完一帧（rAF 垫片 = 16ms setTimeout） */
const nextFrame = () => vi.advanceTimersByTimeAsync(32);

describe('useChunkedMarkdown · idle-commit（静止提交）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('流式静止 600ms → 待提交尾部并入渲染（ask_questions 挂起窗口）', async () => {
    const { scope, api } = mount();
    const content = '第一段已完整。\n\n第二段还在流式输出中 abc';
    // 空行安全边界：第一段已提交渲染，第二段挂 pending（转义纯文本）
    api.update(content, true);
    await nextFrame();
    expect(api.html.value).toBe('第一段已完整。\n\n');
    expect(api.pendingText.value).toBe('第二段还在流式输出中 abc');
    // 静止 700ms（工具挂起 / 用户阅读作答窗口）→ 尾部并入完整渲染
    await vi.advanceTimersByTimeAsync(700);
    expect(api.pendingText.value).toBe('');
    expect(api.html.value).toBe(content);
    scope.stop();
  });

  it('无增量不重渲染：静止后 committed === latestContent，提交回调不再触发', async () => {
    let renders = 0;
    const { scope, api } = mount((x) => { renders++; return x; });
    api.update('第一段已完整。\n\n第二段流式中', true);
    await nextFrame();
    const streamingRenders = renders;
    // 首个静止窗口：idle-commit 渲染一次（并入尾部）
    await vi.advanceTimersByTimeAsync(700);
    expect(renders).toBe(streamingRenders + 1);
    expect(api.pendingText.value).toBe('');
    // 后续多个静止窗口：无 delta 到来 → 不再产生任何渲染（守卫：无增量不触发）
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(renders).toBe(streamingRenders + 1);
    scope.stop();
  });

  it('idle-commit 后 delta 续流 → 回到增量模式（尾部重新挂 pending）', async () => {
    const { scope, api } = mount();
    const p1 = '第一段已完整。\n\n第二段流式中';
    api.update(p1, true);
    await nextFrame();
    await vi.advanceTimersByTimeAsync(700); // idle-commit 并入
    expect(api.html.value).toBe(p1);
    // 续流：delta 到来 → 重走 split，新尾部为 pending
    const p2 = p1 + '继续追加的新内容';
    api.update(p2, true);
    await nextFrame();
    expect(api.pendingText.value).toBe('第二段流式中继续追加的新内容');
    // 流结束 → flush 全量
    api.flush(p2);
    expect(api.pendingText.value).toBe('');
    expect(api.html.value).toBe(p2);
    scope.stop();
  });

  it('未闭合代码围栏内的静止同样提交（挂起窗口代码块渲染为进行中围栏）', async () => {
    const { scope, api } = mount();
    const content = '说明：\n\n```typescript\nconst a = 1;';
    api.update(content, true);
    await nextFrame();
    // 围栏未闭合：围栏内尾部保持 pending（不破坏围栏）
    expect(api.pendingText.value).toContain('```');
    await vi.advanceTimersByTimeAsync(700);
    // idle-commit 无视围栏闭合性整体提交
    expect(api.pendingText.value).toBe('');
    expect(api.html.value).toBe(content);
    scope.stop();
  });

  it('流式收束 flush 覆盖静止窗口的最终正确性', async () => {
    const { scope, api } = mount();
    api.update('流式中内容', true);
    await nextFrame();
    api.update('流式中内容完整版', true);
    await nextFrame();
    api.flush('流式中内容完整版');
    expect(api.html.value).toBe('流式中内容完整版');
    expect(api.pendingText.value).toBe('');
    // flush 后无 pending → 静止不再起 idle 定时器、不重渲染
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.html.value).toBe('流式中内容完整版');
    scope.stop();
  });
});
