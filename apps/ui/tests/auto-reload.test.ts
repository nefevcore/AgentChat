// @vitest-environment jsdom
// ============================================================
// auto-reload.test.ts —— 产物更新自动刷新验收（cr-846）
//
// 锁三条主路径：指纹差异 → reload；指纹一致/校验失败 → 不刷；
// 流式/后台守卫 → 推迟（回前台/流式结束补刷）。触发轨全注入（onTrigger
// 桩收 fire——不建真 WS/定时器）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { startAutoReload, type AutoReloadHandle } from '../client/auto-reload.ts';

function setup(fp: () => string, opts: { streaming?: () => boolean; hidden?: () => boolean } = {}) {
  const reloads: number[] = [];
  let fire: () => void = () => {};
  let current: string = fp();
  const handle = startAutoReload({
    fingerprint: async () => current,
    onTrigger: (f) => { fire = f; },
    reload: () => reloads.push(Date.now()),
    guard: { isStreaming: opts.streaming ?? (() => false), isHidden: opts.hidden ?? (() => false) },
  });
  return {
    reloads,
    handle,
    /** 换产物指纹并触发一轮校验 */
    bump: async (v: string) => { current = v; fire(); await new Promise((r) => setTimeout(r, 0)); },
    /** 同指纹触发（不应刷） */
    noop: async () => { fire(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

describe('cr-846 · auto-reload', () => {
  it('指纹差异 → reload；基线采集后同指纹触发不刷', async () => {
    const s = setup(() => 'fp-1');
    await new Promise((r) => setTimeout(r, 0)); // 基线采集
    await s.noop();
    expect(s.reloads.length).toBe(0);
    await s.bump('fp-2');
    expect(s.reloads.length).toBe(1);
    s.handle.disposeForTest();
  });

  it('校验异常（指纹采集失败）→ 静默不刷', async () => {
    let current: string | null = 'fp-1';
    let fire: () => void = () => {};
    const reloads: number[] = [];
    const handle = startAutoReload({
      fingerprint: async () => { if (current === null) throw new Error('net down'); return current; },
      onTrigger: (f) => { fire = f; },
      reload: () => reloads.push(1),
    });
    await new Promise((r) => setTimeout(r, 0));
    current = null; // 换成抛错
    fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(reloads.length).toBe(0);
    handle.disposeForTest();
  });

  it('流式中差异 → 推迟；流式结束回前台补刷（reloadNow 面）', async () => {
    let streaming = true;
    const s = setup(() => 'fp-1', { streaming: () => streaming, hidden: () => false });
    await new Promise((r) => setTimeout(r, 0));
    await s.bump('fp-2');
    expect(s.reloads.length).toBe(0); // 流式拦下
    streaming = false;
    s.handle.reloadNow(); // 守卫放行 → 补刷
    expect(s.reloads.length).toBe(1);
    s.handle.disposeForTest();
  });

  it('后台标签差异 → 推迟；visibilitychange 回前台补刷', async () => {
    let hidden = true;
    const s = setup(() => 'fp-1', { hidden: () => hidden });
    await new Promise((r) => setTimeout(r, 0));
    await s.bump('fp-2');
    expect(s.reloads.length).toBe(0); // 后台拦下
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.reloads.length).toBe(1);
    s.handle.disposeForTest();
  });

  it('单例幂等：二次启动返回既有句柄（不双跑）', async () => {
    const s = setup(() => 'fp-1');
    await new Promise((r) => setTimeout(r, 0));
    const again = startAutoReload({ fingerprint: async () => 'x', reload: () => {} });
    expect(again).toBe(s.handle);
    s.handle.disposeForTest();
  });
});
