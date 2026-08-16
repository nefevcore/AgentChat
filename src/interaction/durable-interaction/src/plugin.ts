// ============================================================
// @agentchat/durable-interaction/src/plugin.ts —— cordis 插件行
//
// 领域独立：不依赖 bootstrap/tools/hooks。
// 默认 backend=memory；生产组合经 config 或消费方 configure()
// 切换为 jsonl 后端。由 cordis.yml 挂载，registerCoreServices
// 的无 Loader 兜底同样经本行。
// ============================================================

import type { Context } from '@agentchat/cordis';
import { DurableInteractionService, type DurableInteractionConfig } from './service';

export const name = 'agentchat-durable-interaction';
export const inject: string[] = [];

export function apply(ctx: Context, config: DurableInteractionConfig = {}) {
  const service = new DurableInteractionService(ctx, config);
  ctx.logger('durable-interaction').info(`持久化交互服务就绪（backend=${config.backend ?? 'memory'}）`);
  return () => service.dispose();
}
