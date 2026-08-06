// ============================================================
// 数据备份 API —— POST /api/backup（手工触发）+ GET /api/backup（列表）
// ============================================================

import { Router, Request, Response } from 'express';
import { createBackup, listBackups, BACKUP_KEEP } from '@services/backup';

export function createBackupRouter(): Router {
  const router = Router();

  /** GET /api/backup — 列出已有备份 */
  router.get('/', (req: Request, res: Response) => {
    try {
      res.json({ backups: listBackups(), keep: BACKUP_KEEP });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/backup — 立即执行一次备份（手工触发，强制） */
  router.post('/', (req: Request, res: Response) => {
    try {
      const result = createBackup({ force: true });
      res.json({ status: 'ok', ...result, keep: BACKUP_KEEP });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  return router;
}
