// ============================================================
// @agentchat/jobs/src/plugin.ts —— 通用后台任务注册表插件行（cordis 服务行）
//
// 提供 ctx.jobs（JobService）。由 cordis.yml 挂载（组合行 id: jobs），
// 位于 shell-tools 之前（bash background / job 工具 / subagent 消费）。
// 无 Loader 兜底经 register-core 装载同一行。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { JobService } from './service';

export const name = 'agentchat-jobs';

export function apply(ctx: Context) {
  const jobs = new JobService(ctx);
  ctx.jobs = jobs;
  ctx.logger('jobs').info('ctx.jobs 就绪（通用后台任务注册表；bash/subagent 按 kind 登记）');
}
