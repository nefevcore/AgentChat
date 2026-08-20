// ============================================================
// Singles API — /api/singles（P3 独立会话）
// 薄传输层：只调 SinglesService。挂 L3（service-plugin 行）。
//   GET    /api/singles          列表（含 lastActivity 排序锚点）
//   POST   /api/singles          创建（agentId 可空 = 空会话；?reuse=1 复用已有空会话）
//   GET    /api/singles/:id      单会话元数据
//   PATCH  /api/singles/:id      更新（title / agentId（''=清空待选）/ model（null=清除覆盖））
//   DELETE /api/singles/:id      归档（软删；?purge=1 硬删含消息）
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

  /** POST /api/singles — 创建（P4 快速创建：agentId 可空 = 空会话；
   *  ?reuse=1 时若已存在空会话（未选 Agent 且无消息）直接复用——空白会话
   *  全局唯一，create 侧还会清理多余遗留；workspaceId 可选 = 挂入用户工作区） */
  router.post('/', (req: Request, res: Response) => {
    const { agentId, model, title, workspaceId } = req.body ?? {};
    if (agentId !== undefined && typeof agentId !== 'string') {
      res.status(400).json({ error: 'agentId 必须是字符串（空串 = 暂不选择）' });
      return;
    }
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      res.status(400).json({ error: 'workspaceId 必须是字符串（空串 = 未分组）' });
      return;
    }
    try {
      if (req.query.reuse === '1' || req.query.reuse === 'true') {
        const reused = singles.list().find(s => singles.isEmpty(s.id));
        if (reused) {
          res.status(201).json({ session: reused, reused: true });
          return;
        }
      }
      const session = singles.create({ agentId: agentId ?? '', model, title, workspaceId });
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

  /** PATCH /api/singles/:id — 更新（title / agentId（''=清空待选，有消息时禁改）/
   *  model（null=清除覆盖）/ workspaceId（''=移入未分组）） */
  router.patch('/:id', (req: Request, res: Response) => {
    const { title, agentId, model, workspaceId } = req.body ?? {};
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const hasAgent = typeof agentId === 'string';
    const hasModel = model !== undefined && (model === null || typeof model === 'string' || typeof model === 'object');
    const hasWorkspace = typeof workspaceId === 'string';
    if (!hasTitle && !hasAgent && !hasModel && !hasWorkspace) {
      res.status(400).json({ error: '需要至少一个有效字段（title / agentId / model / workspaceId）' });
      return;
    }
    try {
      res.json({
        session: singles.update(req.params.id as string, {
          ...(hasTitle ? { title: title.trim() } : {}),
          ...(hasAgent ? { agentId } : {}),
          ...(hasModel ? { model } : {}),
          ...(hasWorkspace ? { workspaceId } : {}),
        }),
      });
    } catch (err: any) {
      // 规则 1：已有消息的会话禁止换预设/Agent（语义冲突用 409 更准确）
      const locked = /不能更换预设/.test(String(err?.message ?? ''));
      res.status(locked ? 409 : 400).json({ error: err?.message ?? String(err) });
    }
  });

  /** DELETE /api/singles/:id — 归档（软删）；?purge=1 硬删（元数据+消息，不可恢复） */
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      if (req.query.purge === '1' || req.query.purge === 'true') {
        singles.delete(req.params.id as string);
        res.json({ deleted: true });
      } else {
        res.json({ session: singles.archive(req.params.id as string) });
      }
    } catch (err: any) {
      res.status(404).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
