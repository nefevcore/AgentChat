// ============================================================
// Plugins API 子路由：插件库生命周期 + 会话插件 + 暂存人审（契约 §3.2 ③④⑥）
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PluginManager } from '../plugins';
import { sendPluginError } from '../plugins';

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      sendPluginError(res, err);
    });
  };
}

export function createLibraryRouter(loader: PluginManager): Router {
  const router = Router();

  /** GET /library —— 已安装 + 待审暂存 */
  router.get('/library', (_req: Request, res: Response) => {
    try {
      res.json(loader.getLibrary());
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** POST /library/stage —— 发布第一阶段：暂存待审 */
  router.post('/library/stage', (req: Request, res: Response) => {
    try {
      const { dir, owner } = (req.body ?? {}) as { dir?: string; owner?: string };
      if (typeof dir !== 'string' || dir.trim() === '') {
        res.status(400).json({ error: 'dir 必填（插件目录绝对路径）' });
        return;
      }
      const staging = loader.stagePlugin(dir, owner ?? 'user');
      res.json({ staging });
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** POST /library/approve —— 人审通过后安装（grants 勾选为 UI 点击确认） */
  router.post('/library/approve', asyncRoute(async (req: Request, res: Response) => {
    const { id, grants } = (req.body ?? {}) as { id?: string; grants?: unknown };
    if (typeof id !== 'string' || id.trim() === '') {
      res.status(400).json({ error: 'id 必填（stage 返回的暂存 id）' });
      return;
    }
    const installed = await loader.approvePlugin(id, grants);
    res.json({ installed });
  }));

  /** POST /library/reject —— 拒绝暂存（删除目录与记录） */
  router.post('/library/reject', (req: Request, res: Response) => {
    try {
      const { id } = (req.body ?? {}) as { id?: string };
      if (typeof id !== 'string' || id.trim() === '') {
        res.status(400).json({ error: 'id 必填' });
        return;
      }
      const result = loader.rejectPlugin(id);
      res.json(result);
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** POST /library/:name/uninstall —— 卸载已安装插件（目录移 .backup） */
  router.post('/library/:name/uninstall', asyncRoute(async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const result = await loader.uninstallPlugin(name);
    res.json(result);
  }));

  /** GET /session —— PluginHost 中 sessionOnly=true 的记录 */
  router.get('/session', (_req: Request, res: Response) => {
    try {
      res.json({ plugins: loader.getSessionPlugins() });
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** POST /session/register —— 开发目录 → 会话级加载（重启即失；不写 presets） */
  router.post('/session/register', asyncRoute(async (req: Request, res: Response) => {
    const { dir, owner, grants, watch } = (req.body ?? {}) as {
      dir?: string; owner?: string; grants?: unknown; watch?: boolean;
    };
    if (typeof dir !== 'string' || dir.trim() === '') {
      res.status(400).json({ error: 'dir 必填（插件目录绝对路径）' });
      return;
    }
    const result = await loader.registerSessionPlugin(dir, owner, grants, watch ?? true);
    res.json(result);
  }));

  /** POST /session/:name/reload —— 会话级插件重载（重读 manifest + 同授予快照） */
  router.post('/session/:name/reload', asyncRoute(async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const result = await loader.reloadSessionPlugin(name);
    res.json(result);
  }));

  /** POST /session/:name/unload —— 会话级插件卸载 */
  router.post('/session/:name/unload', asyncRoute(async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const result = await loader.unloadSessionPlugin(name);
    res.json(result);
  }));

  /** GET /staging/:id/tree —— 暂存目录文件清单（人审只读） */
  router.get('/staging/:id/tree', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      res.json(loader.getStagingTree(id));
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  /** GET /staging/:id/file?path=<rel> —— 暂存文件内容（路径守卫） */
  router.get('/staging/:id/file', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const rel = String(req.query.path ?? '');
      if (!rel) {
        res.status(400).json({ error: '缺少 path 查询参数' });
        return;
      }
      res.json(loader.getStagingFile(id, rel));
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  return router;
}
