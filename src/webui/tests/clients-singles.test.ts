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
import { makeRpcStub } from './lib/rpcStub';

/** 域行 client 装载前提：rpc 桩 + conversation（sessions）+ roster */
async function bootDomainRuntime() {
  const boot = await bootWebuiRuntime(makeRpcStub().impl);
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

  it('M28 P0-2 · single 视角出厂贡献：装载 → main:perspective 含 single；卸载 → 消失', async () => {
    const boot = await bootDomainRuntime();
    const ids = () => boot.ctx.slots.entries('main:perspective').map((e) => e.id);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    expect(ids()).toContain('single');
    await fiber.dispose();
    expect(ids()).not.toContain('single');
  });

  it('M28 P2 · sessions 会话列表面板贡献：装载 → primary-sidebar:domain 含 sessions 面板；卸载 → 消失', async () => {
    const boot = await bootDomainRuntime();
    const panelOf = (id: string) => boot.ctx.slots.entries('primary-sidebar:domain').find((e) => e.meta?.panel === id);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    expect(panelOf('sessions')?.id).toBe('webui-domain-singles.panel');
    await fiber.dispose();
    expect(panelOf('sessions')).toBeUndefined();
  });
});
