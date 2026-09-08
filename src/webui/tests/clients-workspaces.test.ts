// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-workspaces.test.ts —— workspace 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-workspace/client（D19 改裁——
// 前端行独立包；数据面 = 宿主 REST 端点，无 rpc/帧依赖）。
// M28 P1 行完整：文件预览（overlay）+ 工作区树（main:workspace）
// 席位贡献随行——卸载即消失（可摘除性）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { workspaceClientPlugin } from 'ac-client-ui-workspace/client';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S3-1b · workspace 域行 client（ctx.workspaceBoard 服务面）', () => {
  it('服务装载与可摘除性：fiber dispose → ctx.workspaceBoard 消失', async () => {
    // bootWebuiRuntime：layout 基础件在场（overlay/main:workspace 席位已
    // 声明——注册面 fail-closed 的就绪前提）
    const { ctx } = await bootWebuiRuntime();
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

describe('M28 P1 · workspace 域行席位贡献（行完整：预览 + 树随行）', () => {
  it('文件预览 overlay 贡献 + 工作区树 main:workspace 贡献；卸载 → 贡献消失', async () => {
    const { ctx } = await bootWebuiRuntime(); // layout 基础件在场 → overlay/main:workspace 已声明
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    const fiber = await ctx.plugin(workspaceClientPlugin);
    expect(ids('overlay')).toContain('webui-domain-workspace.file-preview');
    expect(ids('main:workspace')).toContain('webui-domain-workspace.tree');
    await fiber.dispose();
    expect(ids('overlay')).not.toContain('webui-domain-workspace.file-preview');
    expect(ids('main:workspace')).not.toContain('webui-domain-workspace.tree');
  });
});
