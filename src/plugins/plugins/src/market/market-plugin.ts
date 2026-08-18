// ============================================================
// @agentchat/plugins/src/market/market-plugin.ts —— ctx.market 服务行
//
// 由 cordis.yml / register-core 挂载；构造零网络（search 显式触发）。
// 后续 HTTP 路由行（/api/plugins/market）与 CLI（agentchat plugin add）
// 都消费本行提供的 ctx.market。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { MarketService, type MarketOptions } from './market';

export const name = 'agentchat-market';

export function apply(ctx: Context, config: MarketOptions = {}) {
  new MarketService(ctx, config);
  ctx.logger('market').info('ctx.market 就绪（市场发现/暂存/安装服务行）');
}
