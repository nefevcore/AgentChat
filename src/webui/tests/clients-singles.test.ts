// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-singles.test.ts —— S2 singles 域插件验收
//
// 「域投影 + ctx.singleBoard 服务面」+ 可摘除性（D19/S2）。
// 上下文协调（chatStore/feed）在 pinia 面下验证（feed/chat 收尾时改
// 服务面互调）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createClient, type Fiber } from 'ac-client-runtime';
import { singlesDomainPlugin } from '../src/clients/singles';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S2 · singles 域插件（域投影 + ctx.singleBoard 服务面）', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); // 上下文协调经 pinia store（过渡期）
  });

  it('服务装载：ctx.singleBoard 可解析；列表/激活态派生（activeSingles 过滤归档）', async () => {
    const ctx = await createClient();
    const fiber: Fiber = await ctx.plugin(singlesDomainPlugin);
    const board = ctx.singleBoard;
    expect(board).toBeDefined();
    expect(board.singles.value).toEqual([]);
    expect(board.loaded.value).toBe(false);

    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: 1 } as never,
      { id: 's2', status: 'archived', agentId: '', title: 'B', createdAt: 2 } as never,
    ];
    expect(board.activeSingles.value.map((s) => s.id)).toEqual(['s1']);
    expect(board.titleOf({ agentId: '', title: '' } as never, () => '?')).toBe('新会话');
    await fiber.dispose();
  });

  it('可摘除性（D19/S2）：fiber dispose → ctx.singleBoard 消失 + 帧订阅回收', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(singlesDomainPlugin);
    expect(ctx.singleBoard).toBeDefined();
    await fiber.dispose();
    expect((ctx as { singleBoard?: unknown }).singleBoard).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.singleBoard = undefined（列表空态）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 singles 域件
    expect((ctx as { singleBoard?: unknown }).singleBoard).toBeUndefined();
  });
});
