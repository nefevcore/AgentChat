// ============================================================
// Workspaces API — /api/workspaces（用户工作区，会话树分组）
// 薄传输层：只调 WorkspacesService。挂 server 服务行。
//   GET    /api/workspaces          列表（按名称排序）
//   POST   /api/workspaces          创建（path 必填 = 已存在的文件夹）
//   PATCH  /api/workspaces/:id      更新（name / path）
//   DELETE /api/workspaces/:id      删除登记（会话保留 → 未分组）
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WorkspacesService } from '../workspaces';

export function createWorkspacesRouter(workspaces: WorkspacesService): Router {
  const router = Router();

  /** GET /api/workspaces — 全部用户工作区 */
  router.get('/', (_req: Request, res: Response) => {
    res.json({ workspaces: workspaces.list() });
  });

  /** POST /api/workspaces — 创建（path = 文件夹绝对路径；name 缺省 = 文件夹名） */
  router.post('/', (req: Request, res: Response) => {
    const { name, path: dirPath } = req.body ?? {};
    if (typeof dirPath !== 'string' || !dirPath.trim()) {
      res.status(400).json({ error: '需要 path（文件夹绝对路径）' });
      return;
    }
    try {
      const workspace = workspaces.create({
        path: dirPath,
        ...(typeof name === 'string' && name.trim() ? { name } : {}),
      });
      res.status(201).json({ workspace });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  /** PATCH /api/workspaces/:id — 更新（name / path 至少一个） */
  router.patch('/:id', (req: Request, res: Response) => {
    const { name, path: dirPath } = req.body ?? {};
    const hasName = typeof name === 'string' && name.trim().length > 0;
    const hasPath = typeof dirPath === 'string' && dirPath.trim().length > 0;
    if (!hasName && !hasPath) {
      res.status(400).json({ error: '需要至少一个有效字段（name / path）' });
      return;
    }
    try {
      res.json({
        workspace: workspaces.update(req.params.id as string, {
          ...(hasName ? { name } : {}),
          ...(hasPath ? { path: dirPath } : {}),
        }),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  /** DELETE /api/workspaces/:id — 删除登记（会话保留 → 未分组） */
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      workspaces.delete(req.params.id as string);
      res.json({ deleted: true });
    } catch (err: any) {
      res.status(404).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
