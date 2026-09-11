// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-workspaces.test.ts —— workspace 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-workspace/client（D19 改裁——
// 前端行独立包；数据面 = 宿主 REST 端点，无 rpc/帧依赖）。
// M28 P1 行完整：文件预览（overlay）+ 工作区（aside 席位选区——
// 第四层右侧区域，2026-11 构造对齐·层级修正：aside 席位 = 区域本身，
// 工作区 = 众多选区之一）席位贡献随行——卸载即消失（可摘除性）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { workspaceClientPlugin } from 'ac-client-ui-workspace/client';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S3-1b · workspace 域行 client（ctx.workspaceBoard 服务面）', () => {
  it('服务装载与可摘除性：fiber dispose → ctx.workspaceBoard 消失', async () => {
    // bootWebuiRuntime：layout 基础件在场（overlay/aside 席位已
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
  it('文件预览 overlay 贡献 + 工作区 aside 选区条目；卸载 → 贡献消失', async () => {
    const { ctx } = await bootWebuiRuntime(); // layout 基础件在场 → overlay/aside 已声明
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    const fiber = await ctx.plugin(workspaceClientPlugin);
    expect(ids('overlay')).toContain('webui-domain-workspace.file-preview');
    expect(ids('aux-sidebar')).toContain('webui-domain-workspace.tree');
    // 2026-11 构造对齐·层级修正：aside 席位 = 第四区域本身——工作区 =
    // 众多选区之一（def id 'workspace'）；条目 def 携带 active 谓词 +
    // 辅助活动栏按钮资产（域行供，壳零域文案知识；icon = folder-tree
    // 目录树象形——会话区重构二轮换下 panel-right 面板开关隐喻）
    const { activeAuxSidebarPanel } = await import('ac-client-ui-layout/client/auxSidebarViews.ts');
    const winner = activeAuxSidebarPanel();
    expect(winner?.id).toBe('workspace');
    expect(winner?.active()).toBe(true);
    expect(winner?.rail).toEqual({ icon: 'folder-tree', title: '工作区' });
    await fiber.dispose();
    expect(ids('overlay')).not.toContain('webui-domain-workspace.file-preview');
    expect(ids('aux-sidebar')).not.toContain('webui-domain-workspace.tree');
    expect(activeAuxSidebarPanel()).toBeNull(); // 行卸载 → 区域整体消失（内在于选举）
  });
});
