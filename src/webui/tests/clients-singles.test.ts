// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-singles.test.ts —— singles 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-singles/client（D19 改裁——前端
// 行独立包；协调走服务面互调：ctx.sessions.chat / feed +
// ctx.roster.defaultPresetId）。「域投影 + ctx.singleBoard 服务面」+
// 可摘除性（D19）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { type Fiber } from 'ac-client-runtime';
import { singlesClientPlugin } from 'ac-client-ui-singles/client';
import { rosterClientPlugin } from 'ac-client-ui-agents/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { stubRpc } from './lib/rpcStub';

/** 域行 client 装载前提：rpc 桩 + conversation（sessions）+ roster */
async function bootDomainRuntime() {
  const boot = await bootWebuiRuntime();
  await stubRpc(boot.ctx);
  await boot.ctx.plugin(rosterClientPlugin);
  return boot;
}

describe('S3-1b · singles 域行 client（域投影 + ctx.singleBoard 服务面）', () => {
  it('服务装载：ctx.singleBoard 可解析；列表/激活态派生（activeSingles 过滤归档）', async () => {
    const boot = await bootDomainRuntime();
    const fiber: Fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
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

  it('上下文协调（服务面互调）：selectSingle → sessions.chat.setSingleContext + feed 活跃分区派生', async () => {
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: 1 } as never,
    ];
    board.selectSingle('s1');
    // feed 活跃分区派生（activeSingleId 唯一事实源在会话服务）
    expect(board.activeSingleId.value).toBe('s1');
    expect(boot.ctx.sessions.feed.activeSingleId.value).toBe('s1');
    board.deselectSingle();
    expect(board.activeSingleId.value).toBe('');
    await fiber.dispose();
  });

  it('可摘除性（D19）：fiber dispose → ctx.singleBoard 消失 + 帧订阅回收', async () => {
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    expect(boot.ctx.singleBoard).toBeDefined();
    await fiber.dispose();
    expect((boot.ctx as { singleBoard?: unknown }).singleBoard).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.singleBoard = undefined（列表空态）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 singles 域件
    expect((ctx as { singleBoard?: unknown }).singleBoard).toBeUndefined();
  });
});
