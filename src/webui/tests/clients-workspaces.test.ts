// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-workspaces.test.ts —— S2 workspace 域插件验收
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient } from 'ac-client-runtime';
import { workspacesDomainPlugin } from '../src/clients/workspaces';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S2 · workspace 域插件（ctx.workspaceBoard 服务面）', () => {
  it('服务装载与可摘除性：fiber dispose → ctx.workspaceBoard 消失', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(workspacesDomainPlugin);
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
