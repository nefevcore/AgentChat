// ============================================================
// Agent Presets API — /api/agent-presets（预设 Agent 目录）
//
// 预设（DSH agent-presets 形态）：插件提供的内置 Agent——不出现在
// /api/agents（Agent 列表），仅供独立会话（Session）选用。
// 薄传输层：读 ctx.agentPresets；挂载于 server service-plugin 行。
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentPresetsService } from '@agentchat/agent-presets';

export function createAgentPresetsRouter(presets: AgentPresetsService): Router {
  const router = Router();

  /** GET /api/agent-presets — 全部预设（Session 选用 UI 数据源） */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      presets: presets.list().map((d) => ({
        id: d.agent.agent_id,
        name: d.agent.name,
        label: d.meta.label,
        description: d.meta.description ?? d.agent.description ?? '',
        default: d.meta.default ?? false,
      })),
    });
  });

  return router;
}
