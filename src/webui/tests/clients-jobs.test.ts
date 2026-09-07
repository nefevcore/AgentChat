// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-jobs.test.ts —— jobs 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-jobs/client（D19 改裁——前端
// 行独立包；api/jobs.ts re-export 维持旧路径）。「域投影 + ctx 服务面」
// 形态（§0.3 层 3）+ 可摘除性（D19：运行时动态卸载 → UI 消费面消失，
// 无残留无报错）。宿主半边 boot graph 声明验收见
// ac-client-ui-jobs/tests/jobs-row.test.ts。
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { createClient, type ClientContext, type Fiber } from 'ac-client-runtime';
import { jobsClientPlugin } from 'ac-client-ui-jobs/client';
import { bootWebuiRuntime } from './lib/webuiBoot';

/** rpc 桩（call 离线空态 + onEvent 捕获——行 client 数据面走契约） */
async function stubRpc(ctx: ClientContext): Promise<void> {
  await ctx.plugin({
    name: 'test-rpc-stub',
    apply(c: ClientContext) {
      c.provide('rpc', {
        call<T>(_method: string, _params?: unknown): Promise<T> {
          return Promise.reject(new Error('stub offline'));
        },
        onEvent(_h: (type: string, args: unknown[]) => void): () => void {
          return () => undefined;
        },
      });
    },
  });
}

describe('S3-1b · jobs 域行 client（域投影 + ctx.jobBoard 服务面）', () => {
  it('服务装载：ctx.jobBoard 可解析；投影 reactive（消费面 computed 依赖成立）', async () => {
    const ctx = await createClient();
    await stubRpc(ctx);
    const fiber: Fiber = await ctx.plugin(jobsClientPlugin);
    const board = ctx.jobBoard;
    expect(board).toBeDefined();
    expect(board.jobs.value).toBeNull(); // 拉取失败/未连接 → null（空态语义保持）

    const seen: number[] = [];
    const probe = computed(() => {
      seen.push(1);
      return board.jobs.value;
    });
    expect(probe.value).toBeNull();
    board.jobs.value = [];
    expect(probe.value).toEqual([]); // 响应式驱动（消费面重算）
    expect(seen.length).toBe(2);
    await fiber.dispose();
  });

  it('kill 状态机：killing 标记即时 + 终态清理（无连接 → fetch 失败也不残留标记）', async () => {
    const ctx = await createClient();
    await stubRpc(ctx);
    const fiber = await ctx.plugin(jobsClientPlugin);
    const board = ctx.jobBoard;
    const p = board.kill('bash-1');
    await p;
    // rpc stub 离线：killJob 静默 null → finally 清理 killing（按钮态不卡死）
    expect(board.killing.value.has('bash-1')).toBe(false);
    await fiber.dispose();
  });

  it('可摘除性（D19 验收）：卸载域插件 fiber → ctx.jobBoard 消失、无残留报错', async () => {
    const { ctx } = await bootWebuiRuntime();
    await stubRpc(ctx);
    const fiber = await ctx.plugin(jobsClientPlugin);
    expect(ctx.jobBoard).toBeDefined();
    const board = ctx.jobBoard;
    board.ensureStarted(); // 启动域帧订阅（绑定域 fiber）

    await fiber.dispose(); // 卸载：服务 + 帧订阅一并回收
    expect((ctx as { jobBoard?: unknown }).jobBoard).toBeUndefined();
    // 旧 board 引用只读不炸（组件缓存场景）；不再接收帧刷新
    expect(board.jobs.value).toBeNull();
  });

  it('跨域消费语义：未装载域件的 runtime → useClientContext()?.jobBoard = undefined（空态渲染）', async () => {
    const boot = await bootWebuiRuntime(); // 不装 jobs 域件
    expect((boot.ctx as { jobBoard?: unknown }).jobBoard).toBeUndefined();
  });
});
