// ============================================================
// Singles API — /api/singles（P3 独立会话）
// 薄传输层：只调 SinglesService。挂 L3（service-plugin 行）。
//   GET    /api/singles          列表（含 lastActivity 排序锚点）
//   POST   /api/singles          创建（agentId + 可选 model/title）
//   GET    /api/singles/:id      单会话元数据
//   PATCH  /api/singles/:id      改标题
//   DELETE /api/singles/:id      归档（软删）
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SinglesService } from '../singles';

export function createSinglesRouter(singles: SinglesService): Router {
  const router = Router();

  /** GET /api/singles — 全部独立会话 */
  router.get('/', (_req: Request, res: Response) => {
    res.json({ singles: singles.list() });
  });

  /** POST /api/singles — 创建 */
  router.post('/', (req: Request, res: Response) => {
    const { agentId, model, title } = req.body ?? {};
    if (typeof agentId !== 'string' || !agentId) {
      res.status(400).json({ error: '需要 agentId' });
      return;
    }
    try {
      const session = singles.create({ agentId, model, title });
      res.status(201).json({ session });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  /** GET /api/singles/:id — 单会话 */
  router.get('/:id', (req: Request, res: Response) => {
    const session = singles.get(req.params.id as string);
    if (!session) {
      res.status(404).json({ error: `独立会话 "${req.params.id}" 不存在` });
      return;
    }
    res.json({ session });
  });

  /** PATCH /api/singles/:id — 改标题 */
  router.patch('/:id', (req: Request, res: Response) => {
    const { title } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: '需要有效的 title 字段' });
      return;
    }
    try {
      res.json({ session: singles.rename(req.params.id as string, title.trim()) });
    } catch (err: any) {
      res.status(404).json({ error: err?.message ?? String(err) });
    }
  });

  /** DELETE /api/singles/:id — 归档（软删，消息保留） */
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      res.json({ session: singles.archive(req.params.id as string) });
    } catch (err: any) {
      res.status(404).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
