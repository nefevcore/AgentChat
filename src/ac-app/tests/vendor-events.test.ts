// ============================================================
// vendor 事件总线隔离回归（C1 / D4，2026-08-31 审计）
//
// ac-app 是进程级兜底（boot.ts unhandledRejection/uncaughtException）
// 的宿主面，vendor emit 逐回调隔离与 waterfall next() once 化是同一
// 类"单点故障不得放大为宿主崩溃/重复执行"的结构保证，回归测试落本包。
//
//   · emit：同步 throw 的监听器被记日志跳过——后续监听器照常执行
//     （此前 throw 会跳过同事件剩余监听器并上窜为 uncaughtException，
//     ac-session 落账监听器可被饿死）；
//   · emit：返回 rejected Promise 的监听器不再产生悬空 rejection
//     （Node ≥15 默认 unhandledRejection → 进程崩溃）；
//   · waterfall：同一监听器双调 next() 只生效一次——剩余链与真实现
//     不再被重复执行（工具双执行/双装载类数据事故的机械防线）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context } from '@agentchat/cordis';

declare module '@agentchat/cordis' {
  interface Events {
    /** 测试专用：emit 隔离验证 */
    'test/vendor-isolation'(payload: { tag: string }): void;
    /** 测试专用：waterfall next once 验证 */
    'test/vendor-waterfall'(payload: { n: number }, next: () => string): string;
  }
}

describe('vendor 事件总线隔离（C1/D4 回归）', () => {
  it('emit：抛错监听器被隔离——不跳过后续监听器、不上窜 throw', () => {
    const ctx = new Context();
    const seen: string[] = [];
    ctx.on('test/vendor-isolation', () => {
      seen.push('thrower');
      throw new Error('监听器同步爆炸');
    });
    ctx.on('test/vendor-isolation', () => {
      seen.push('after');
    });
    expect(() => ctx.emit('test/vendor-isolation', { tag: 'x' })).not.toThrow();
    expect(seen).toEqual(['thrower', 'after']); // 后续监听器不被饿死
  });

  it('emit：返回 rejected Promise 的监听器不产生 unhandledRejection', async () => {
    const ctx = new Context();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      ctx.on('test/vendor-isolation', () => Promise.reject(new Error('悬空拒绝')));
      ctx.emit('test/vendor-isolation', { tag: 'x' });
      // 微任务两拍落定（vendror 内部 .catch 已挂接则无悬空）
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('waterfall：同一监听器双调 next() 只生效一次（真实现不重复执行）', async () => {
    const ctx = new Context();
    let implRuns = 0;
    let secondListenerRuns = 0;
    ctx.on('test/vendor-waterfall', (payload, next) => {
      void next();
      next(); // 双调：第二次应 no-op + warn
      payload.n += 1;
      return 'outer';
    });
    ctx.on('test/vendor-waterfall', (_payload, next) => {
      secondListenerRuns += 1;
      return next();
    });
    const payload = { n: 0 };
    const result = await ctx.waterfall('test/vendor-waterfall', payload, () => {
      implRuns += 1;
      return 'impl';
    });
    expect(implRuns).toBe(1); // 真实现恰好一次
    expect(secondListenerRuns).toBe(1); // 中间监听器恰好一次
    expect(result).toBe('outer'); // 外层返回值语义不变
    expect(payload.n).toBe(1);
  });

  it('waterfall：不调 next 的 veto 语义不变（下游与真实现均不执行）', async () => {
    const ctx = new Context();
    let implRuns = 0;
    ctx.on('test/vendor-waterfall', () => 'vetoed');
    const result = await ctx.waterfall('test/vendor-waterfall', { n: 0 }, () => {
      implRuns += 1;
      return 'impl';
    });
    expect(result).toBe('vetoed');
    expect(implRuns).toBe(0);
  });
});
