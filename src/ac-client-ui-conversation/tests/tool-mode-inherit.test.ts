// ============================================================
// tool-mode-inherit.test.ts —— 工具调用模式「新会话跟随上次选择」
// 继承写登记验收（2026-09-17 恢复后重建）
//
// 被测面 = 纯登记语义（无 rpc/无 DOM）：persistToolMode 登记后，
// settleToolMode 必须等到该写入收束（成功/失败都放行）才返回；无登记
// 立即返回；同会话重写覆盖旧登记；异会话互不阻塞。
// ============================================================
import { describe, it, expect } from 'vitest';
import { persistToolMode, settleToolMode, pendingToolModeCount } from '../client/toolModeInherit.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('toolModeInherit：偏好 → 会话 conv-settings 的继承写登记', () => {
  it('无登记：立即返回（常态零开销）', async () => {
    await expect(settleToolMode('nobody~there')).resolves.toBeUndefined();
    await expect(settleToolMode(null)).resolves.toBeUndefined();
    await expect(settleToolMode(undefined)).resolves.toBeUndefined();
  });

  it('登记后：settle 等到写入收束（成功）才返回', async () => {
    const d = deferred<void>();
    persistToolMode('user~coder', d.promise);
    expect(pendingToolModeCount()).toBe(1);
    let settled = false;
    const waiting = settleToolMode('user~coder').then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // 写入未收束：等待中
    d.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(pendingToolModeCount()).toBe(0); // 收束即清空（后续发送零开销）
  });

  it('写入失败（reject）：同样放行（跟随态兜底，不阻塞投递）', async () => {
    const d = deferred<void>();
    persistToolMode('user~coder', d.promise);
    const waiting = settleToolMode('user~coder');
    d.reject(new Error('rpc down'));
    await expect(waiting).resolves.toBeUndefined();
    expect(pendingToolModeCount()).toBe(0);
  });

  it('同会话重写：旧登记收束不误清新登记', async () => {
    const first = deferred<void>();
    persistToolMode('sid-1', first.promise);
    const second = deferred<void>();
    persistToolMode('sid-1', second.promise); // 覆盖登记
    expect(pendingToolModeCount()).toBe(1);
    first.resolve(); // 旧写收束——不清 second
    await new Promise((r) => setTimeout(r, 5));
    expect(pendingToolModeCount()).toBe(1); // 新登记仍在
    let settled = false;
    const waiting = settleToolMode('sid-1').then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false); // second 未收束：仍等待
    second.resolve();
    await waiting;
    expect(pendingToolModeCount()).toBe(0);
  });

  it('异会话互不阻塞：等 A 不等 B', async () => {
    const d = deferred<void>();
    persistToolMode('sid-a', d.promise);
    await expect(settleToolMode('sid-b')).resolves.toBeUndefined(); // B 无等待
    expect(pendingToolModeCount()).toBe(1);
    d.resolve();
    await new Promise((r) => setTimeout(r, 5)); // drop 在 then 微任务——让渡后再查
    expect(pendingToolModeCount()).toBe(0);
  });

  it('空会话键不登记', () => {
    persistToolMode('', Promise.resolve());
    expect(pendingToolModeCount()).toBe(0);
  });
});
