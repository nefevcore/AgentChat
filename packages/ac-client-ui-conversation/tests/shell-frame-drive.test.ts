// ============================================================
// shell-frame-drive.test.ts —— P4-2 跟随引擎由调度器驱动（cr-1287）
//
// §四 P4-2 测试标准「流式回归（useChatShell 测试族）」：滚动引擎从
// 自持 rAF 链改为调度器 scroll 阶段驱动后，行为语义零变化——
//   · 贴底小增量当帧直接吸收（不跳变、不多帧延迟）；
//   · 整卡上屏走缓动段平滑揭示；
//   · 贴底静默后引擎停机（释放持帧，调度循环不再空转）；
//   · 用户上翻让位（不把视口拉回底部）。
// 容器为 stub 元素（node 无 DOM）：scrollTop 赋值按最大滚动值钳制，
// 与浏览器行为一致。fake timers 一并接管 performance（缓动按 dt 推进）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useChatShell } from '../client/useChatShell.ts';
import { frameStats, resetFrameScheduler } from '../client/frameScheduler.ts';

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

const nextFrame = () => vi.advanceTimersByTimeAsync(17);
const frames = (n: number) => vi.advanceTimersByTimeAsync(17 * n);

interface StubEl {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  setContent(h: number): void;
}

/** stub 滚动容器：scrollTop 读写按最大滚动值钳制（浏览器同款） */
function makeEl(content: number, viewport = 400): StubEl {
  let scrollTop = 0;
  let scrollHeight = content;
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(v: number) { scrollTop = Math.max(0, Math.min(v, scrollHeight - viewport)); },
    get scrollHeight() { return scrollHeight; },
    get clientHeight() { return viewport; },
    setContent(h: number) { scrollHeight = h; },
  };
}

function mount(el: StubEl, signal: { value: readonly [number, number] }) {
  const scope = effectScope(true);
  const api = scope.run(() => useChatShell({
    container: ref(el as unknown as HTMLElement),
    onTopThreshold: () => {},
    signal: () => signal.value,
  }))!;
  return { scope, api };
}

describe('P4-2 跟随引擎：调度器 scroll 阶段驱动', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    resetFrameScheduler();
  });
  afterEach(() => { vi.useRealTimers(); resetFrameScheduler(); });

  it('已贴底 + 流式小增量 → 当帧直接吸收（无缓动延迟）', async () => {
    const el = makeEl(1000);
    el.scrollTop = 600; // 初始已贴底（max = 1000-400）
    const signal = ref<readonly [number, number]>([0, 0]);
    const { scope } = mount(el, signal);
    el.setContent(1020); // 内容增长 20px（< SNAP_ABSORB_MAX）
    signal.value = [1, 1];
    await nextFrame(); // watch → 登记 scroll 任务
    await nextFrame(); // ensureFollow → 首拍执行
    expect(el.scrollTop).toBe(620); // 直接吸附（不是缓动中途值）
    scope.stop();
  });

  it('整卡上屏 → 切入缓动段平滑揭示（不瞬跳），多帧后收敛贴底', async () => {
    const el = makeEl(1000);
    el.scrollTop = 600;
    const signal = ref<readonly [number, number]>([0, 0]);
    const { scope } = mount(el, signal);
    el.setContent(1500); // +500px 整卡（> SNAP_ABSORB_MAX 48）
    signal.value = [2, 2];
    await nextFrame();
    await nextFrame();
    const first = el.scrollTop;
    expect(first).toBeGreaterThan(600);
    expect(first).toBeLessThan(1100); // 缓动首拍：未瞬跳到底
    await frames(40); // ~3τ（240ms）+ 兜底
    expect(el.scrollTop).toBe(1100); // 收敛贴底
    scope.stop();
  });

  it('贴底静默后引擎停机：调度循环不再空转（持帧释放）', async () => {
    const el = makeEl(1000);
    el.scrollTop = 600;
    const signal = ref<readonly [number, number]>([0, 0]);
    const { scope } = mount(el, signal);
    el.setContent(1020);
    signal.value = [1, 1];
    await frames(3);
    expect(el.scrollTop).toBe(620);
    await frames(120); // 越过 FOLLOW_IDLE_MS(1200ms) 静默窗
    const settled = frameStats().frames;
    await frames(10);
    expect(frameStats().frames).toBe(settled); // 停机后不再耗帧
    scope.stop();
  });

  it('用户上翻察觉：引擎让位（不把视口拉回底部）', async () => {
    const el = makeEl(1000);
    el.scrollTop = 600;
    const signal = ref<readonly [number, number]>([0, 0]);
    const { scope, api } = mount(el, signal);
    el.setContent(1020);
    signal.value = [1, 1];
    await frames(3);
    el.scrollTop = 420; // 用户上滚 200px
    await frames(3);
    expect(api.isUserScrolledUp.value).toBe(true);
    const held = el.scrollTop;
    el.setContent(1100);
    signal.value = [2, 2];
    await frames(5);
    expect(el.scrollTop).toBe(held); // 上翻态不自动跟随
    scope.stop();
  });
});

