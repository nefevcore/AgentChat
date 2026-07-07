// ============================================================
// Agents API —— GET /api/agents
// ============================================================

import { Router, Request, Response } from 'express';
import { AgentRegistry } from '../../../src/routing/registry';

export function createAgentsRouter(registry: AgentRegistry): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const ids = registry.listIds().filter((id: string) => !registry.isVirtual(id));
    const agents = ids.map((id: string) => {
      const agent = registry.getAgent(id);
      return {
        id,
        name: registry.getAgentName(id),
        systemPrompt: agent?.systemPrompt?.slice(0, 100) ?? '',
      };
    });

    res.json({ agents });
  });

  return router;
}
