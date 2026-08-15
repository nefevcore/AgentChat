// ============================================================
// Plugins API 子路由：Agent 装配视图（契约 §3.2 ①）
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PluginManager } from '../plugins';
import { sendPluginError } from '../plugins';

export function createAssemblyRouter(loader: PluginManager): Router {
  const router = Router();

  /** GET :agentId —— Agent 能力装配快照（替代旧扁平数组） */
  router.get('/:agentId', (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId as string;
      const assembly = loader.getAssembly(agentId);
      if (!assembly) {
        res.status(404).json({ error: `Agent "${agentId}" 未找到` });
        return;
      }
      res.json({ assembly });
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** PUT :agentId —— 保存 presets/tools/hooks；归一化旧契约 + 立即热重载 */
  router.put('/:agentId', (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId as string;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const saved = loader.saveAssembly(agentId, {
        ...(body.presets !== undefined ? { presets: body.presets as string[] } : {}),
        ...(body.tools !== undefined ? { tools: body.tools as string[] } : {}),
        ...(body.hooks !== undefined ? { hooks: body.hooks as Record<string, string[]> } : {}),
      });
      res.json({ success: true, assembly: saved.assembly, ...(saved.migrated ? { migrated: true } : {}) });
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  return router;
}
