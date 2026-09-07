// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-jobs.test.ts —— S2 jobs 域插件试点验收
//
// 「域投影 + ctx 服务面」形态（§0.3 层 3）+ 可摘除性（D19/S2 验收：
// 运行时动态卸载模块 → UI 消费面消失，无残留无报错）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { createClient, type Fiber } from 'ac-client-runtime';
import { jobsDomainPlugin } from '../src/clients/jobs';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S2 试点 · jobs 域插件（域投影 + ctx.jobBoard 服务面）', () => {
  it('服务装载：ctx.jobBoard 可解析；投影 reactive（消费面 computed 依赖成立）', async () => {
    const ctx = await createClient();
    const fiber: Fiber = await ctx.plugin(jobsDomainPlugin);
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
    const fiber = await ctx.plugin(jobsDomainPlugin);
    const board = ctx.jobBoard;
    const p = board.kill('bash-1');
    await p;
    // 无 WS 连接：killJob 抛错 → finally 清理 killing（按钮态不卡死）
    expect(board.killing.value.has('bash-1')).toBe(false);
    await fiber.dispose();
  });

  it('可摘除性（D19/S2 验收）：卸载域插件 fiber → ctx.jobBoard 消失、无残留报错', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(jobsDomainPlugin);
    expect(ctx.jobBoard).toBeDefined();
    const board = ctx.jobBoard;
    board.ensureStarted(); // 启动域帧订阅（绑定域 fiber）

    await fiber.dispose(); // 卸载：服务 + 帧订阅一并回收
    expect((ctx as { jobBoard?: unknown }).jobBoard).toBeUndefined();
    // 旧 board 引用只读不炸（组件缓存场景）；不再接收帧刷新
    expect(board.jobs.value).toBeNull();
  });

  it('跨域消费语义：未装载域件的 runtime → useClientContext()?.jobBoard = undefined（空态渲染）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 jobs 域件
    expect((ctx as { jobBoard?: unknown }).jobBoard).toBeUndefined();
  });
});
