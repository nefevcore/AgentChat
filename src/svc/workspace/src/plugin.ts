// ============================================================
// @agentchat/workspace/src/plugin.ts —— 工作区初始化插件行
//
// inject: bootstrap —— boot 核心行只提供契约（workspaceDir/agentsDir），
// 不执行任何文件初始化。本行负责 files 指引/默认 user/admin/首次引导，
// 并在落盘后调用 core.loadAgents()（保证 user/admin 参与注册扫描）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { initializeWorkspace, WorkspaceService } from './workspace';

export const name = 'agentchat-workspace';
export const inject = ['bootstrap'];

export interface Config {
  /** 可选：额外模板根目录（优先级高于内置候选） */
  templateRoots?: string[];
}

export function apply(ctx: Context, config: Config = {}) {
  const core = ctx.bootstrap;
  const result = initializeWorkspace(core, config.templateRoots);
  new WorkspaceService(ctx, result);
  core.loadAgents();
}
