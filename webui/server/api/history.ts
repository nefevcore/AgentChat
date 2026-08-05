// ============================================================
// History API —— GET /api/history
// ============================================================

import { Router, Request, Response } from 'express';
import { HistoryService } from '@services/index';
import { logger } from '@utils/logger';

export function createHistoryRouter(historyService: HistoryService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const from = req.query.from as string;
    const to = req.query.to as string;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    if (!from || !to) {
      return res.status(400).json({ error: '缺少必需的查询参数 from 和 to' });
    }

    try {
      const messageQuery = historyService.query;
      if (!messageQuery) {
        return res.status(503).json({ error: '消息查询服务未就绪' });
      }
      const messages = await messageQuery.query({ from, to, limit, offset });
      res.json({ messages });
    } catch (err: any) {
      logger.error(`[History API] Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
