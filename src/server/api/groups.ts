// ============================================================
// Groups API — GET/POST /api/groups, /api/groups/:groupId/...
// 薄传输层：只调 GroupService（业务门面），不直接接触 @agents/group。
// ============================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import type { GroupService } from '@services/group-service';

export function createGroupsRouter(gs: GroupService): Router {
  const router = Router();

  /** GET /api/groups — 获取所有群组列表（含 lastActivity） */
  router.get('/', (_req: Request, res: Response) => {
    res.json({ groups: gs.listGroupsWithActivity() });
  });

  /** GET /api/groups/:groupId — 获取单个群组信息 */
  router.get('/:groupId', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const group = gs.getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: `群组 "${req.params.groupId}" 不存在` });
      return;
    }
    res.json({ group });
  });

  /** POST /api/groups — 创建群组 */
  router.post('/', (req: Request, res: Response) => {
    const { group_id, name, participants, description } = req.body;
    if (!name || !participants?.length) {
      res.status(400).json({ error: '需要 name, participants' });
      return;
    }
    const finalGroupId: string = (group_id || '').trim() || crypto.randomUUID();
    try {
      const group = gs.createGroup({ group_id: finalGroupId, name, participants, description });
      res.status(201).json({ group });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  /** DELETE /api/groups/:groupId — 删除群组 */
  router.delete('/:groupId', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    if (!gs.deleteGroup(groupId)) {
      res.status(404).json({ error: `群组 "${req.params.groupId}" 不存在` });
      return;
    }
    res.json({ success: true });
  });

  /** PATCH /api/groups/:groupId — 更新群组信息（名称、描述） */
  router.patch('/:groupId', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const { name, description } = req.body;
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ error: '需要有效的 name 字段' });
      return;
    }
    const group = gs.updateGroup(groupId, { name, description });
    if (!group) {
      res.status(404).json({ error: `群组 "${groupId}" 不存在` });
      return;
    }
    res.json({ success: true, group });
  });

  /** GET /api/groups/:groupId/history — 获取群组历史消息 */
  router.get('/:groupId/history', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const messages = gs.getGroupHistory(groupId, limit, offset);
    res.json({ group_id: groupId, messages });
  });

  /** POST /api/groups/:groupId/join — 加入群组 */
  router.post('/:groupId/join', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '需要 agent_id' });
      return;
    }
    if (!gs.joinGroup(groupId, agent_id)) {
      res.status(404).json({ error: `群组 "${groupId}" 不存在或加入失败` });
      return;
    }
    res.json({ success: true, group: gs.getGroup(groupId) });
  });

  /** POST /api/groups/:groupId/leave — 离开群组 */
  router.post('/:groupId/leave', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '需要 agent_id' });
      return;
    }
    if (!gs.leaveGroup(groupId, agent_id)) {
      res.status(404).json({ error: `群组 "${groupId}" 不存在或离开失败` });
      return;
    }
    res.json({ success: true, group: gs.getGroup(groupId) });
  });

  return router;
}
