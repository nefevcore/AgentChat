// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-workspaces.test.ts —— workspace 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-workspace/client（D19 改裁——
// 前端行独立包；数据面 = 宿主 REST 端点，无 rpc/帧依赖）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient } from 'ac-client-runtime';
import { workspaceClientPlugin } from 'ac-client-ui-workspace/client';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S3-1b · workspace 域行 client（ctx.workspaceBoard 服务面）', () => {
  it('服务装载与可摘除性：fiber dispose → ctx.workspaceBoard 消失', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(workspaceClientPlugin);
    const board = ctx.workspaceBoard;
    expect(board).toBeDefined();
    expect(board.workspaces.value).toEqual([]);
    expect(board.loaded.value).toBe(false);
    await fiber.dispose();
    expect((ctx as { workspaceBoard?: unknown }).workspaceBoard).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.workspaceBoard = undefined', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 workspaces 域件
    expect((ctx as { workspaceBoard?: unknown }).workspaceBoard).toBeUndefined();
  });
});
