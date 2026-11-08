// ============================================================
// resync-retry.test.ts —— 恢复钩子退避重试（cr-948）验收
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { resyncRetry } from '../src/resyncRetry.ts';

describe('cr-948 · resyncRetry', () => {
  it('成功即停（无重试）', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const h = resyncRetry('t-ok', fn);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    h.cancel();
  });

  it('失败退避重试到成功（2/4/8s 步进由 fake timers 驱动）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = vi.fn().mockImplementation(() => { calls++; return calls < 3 ? Promise.reject(new Error('boot 窗口')) : Promise.resolve(); });
      const h = resyncRetry('t-retry', fn);
      await vi.advanceTimersByTimeAsync(2000); // 第 1 次退避
      expect(fn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000); // 第 2 次
      expect(fn).toHaveBeenCalledTimes(3);
      expect(fn).toHaveLastReturnedWith(Promise.resolve());
      h.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('同 key 新链取消旧链（重连风暴只留最新）', async () => {
    vi.useFakeTimers();
    try {
      const fn1 = vi.fn().mockRejectedValue(new Error('x'));
      const fn2 = vi.fn().mockResolvedValue(undefined);
      resyncRetry('t-key', fn1);
      const h2 = resyncRetry('t-key', fn2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fn1).toHaveBeenCalledTimes(1); // 旧链被取消不再重试
      expect(fn2).toHaveBeenCalledTimes(1);
      h2.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
