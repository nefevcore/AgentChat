// ============================================================
// History API —— GET /api/history
// ============================================================

import { Router, Request, Response } from 'express';
import { IMessageQuery } from '../../../src/routing/message-query';

export function createHistoryRouter(messageQuery: IMessageQuery): Router {
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
      const messages = await messageQuery.query({ from, to, limit, offset });
      res.json({ messages });
    } catch (err: any) {
      console.error(`[History API] Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
