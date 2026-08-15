// ============================================================
// Plugins API 子路由：插件目录 + 权限词汇表（契约 §3.2 ②⑤）
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PluginManager } from '../plugins';
import { sendPluginError } from '../plugins';

export function createCatalogRouter(loader: PluginManager): Router {
  const router = Router();

  /** GET /catalog —— 插件/钩子/工具全量目录（单真相源） */
  router.get('/catalog', (_req: Request, res: Response) => {
    try {
      res.json(loader.getCatalog());
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** GET /permissions —— 权限词汇表（UI 徽章/勾选框数据源） */
  router.get('/permissions', (_req: Request, res: Response) => {
    try {
      res.json(loader.getPermissions());
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** GET /global/hooks —— 全局钩子目录（兼容期只读） */
  router.get('/global/hooks', (_req: Request, res: Response) => {
    const plugins = loader.getGlobalPlugins();
    res.json({ plugins });
  });

  /** GET /global/tools —— 全局工具目录（兼容期只读） */
  router.get('/global/tools', (_req: Request, res: Response) => {
    const tools = loader.getGlobalTools();
    res.json(tools);
  });

  return router;
}
