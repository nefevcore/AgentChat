// ============================================================
// @agentchat/plugins/src/market/http-plugin.ts —— /api/plugins/market 路由行（L3）
//
// inject ['http','market']：服务依赖保证路由只在 HTTP 宿主与市场服务
// 就绪后挂载；挂/摘本行 = 挂/摘 /api/plugins/market/*。
//
// 端点（全部显式触发，构造期零网络）：
//   GET  /search?q=关键词     topic 聚合搜索（源失败降级缓存，stale 标记）
//   GET  /cached              本地缓存索引（离线可看清单）
//   POST /stage   {spec}      市场暂存（进 WebUI 待审人审队列）
//   POST /install {spec, grants?, owner?}  一步安装（宿主内热加载）
// ============================================================
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Context } from '@agentchat/cordis';
import { PluginApiError, toPluginApiError } from '@agentchat/server';
import type { MarketService } from './market';

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      // ① 显式 PluginApiError / err.status 优先
      if (err instanceof PluginApiError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // ② 市场局部规则：上游（远端源/网络/解包/契约门禁）→ 502；输入 → 400
      const localRules: Array<[RegExp, number]> = [
        [/不兼容|manifest|tarball|下载|解包|限流|GitHub API|网络/, 502],
        [/找不到|没有可解条目/, 404],
      ];
      for (const [pattern, status] of localRules) {
        if (pattern.test(message)) {
          res.status(status).json({ error: message });
          return;
        }
      }
      // ③ 共享规则映射（registry/权限语义）
      const apiError = toPluginApiError(err);
      res.status(apiError.status).json({ error: apiError.message });
    });
  };
}

function readSpec(req: Request): string {
  const { spec } = (req.body ?? {}) as { spec?: string };
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new PluginApiError(400, 'spec 必填（owner/repo | owner/repo#ref | name）');
  }
  return spec.trim();
}

export const name = 'agentchat-market-http-routes';
export const inject = ['http', 'market'];

export function apply(ctx: Context) {
  const market = ctx.market as MarketService;

  const router = Router();

  /** GET /search?q= —— 市场搜索（源失败 → 缓存 + stale:true） */
  router.get('/search', asyncRoute(async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const result = await market.search(q);
    res.json(result);
  }));

  /** GET /cached —— 本地缓存索引（零网络） */
  router.get('/cached', (_req: Request, res: Response) => {
    res.json({ entries: market.cachedEntries() });
  });

  /** POST /stage —— 市场暂存（返回审查记录；WebUI 待审 tab / CLI staging 可见） */
  router.post('/stage', asyncRoute(async (req: Request, res: Response) => {
    const spec = readSpec(req);
    const { owner } = (req.body ?? {}) as { owner?: string };
    const staging = await market.stage(spec, owner !== undefined ? { owner } : {});
    res.json({ staging });
  }));

  /** POST /install —— 一步安装（缺高危 grants → 400 + 自动清理，前端回落人审流） */
  router.post('/install', asyncRoute(async (req: Request, res: Response) => {
    const spec = readSpec(req);
    const { grants, owner } = (req.body ?? {}) as { grants?: unknown; owner?: string };
    const installed = await market.install(spec, grants, owner !== undefined ? { owner } : {});
    res.json({ installed: { name: installed.name, version: installed.version, hash: installed.hash } });
  }));

  const dispose = ctx.http.register('/api/plugins/market', router);
  ctx.logger('market').info('/api/plugins/market 由市场路由行注册');
  return dispose;
}
