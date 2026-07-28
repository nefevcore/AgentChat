// ============================================================
// Groups API —— GET/POST /api/groups, /api/groups/:roomId/...
// ============================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { GroupManager } from '@routing/group-manager';

export function createGroupsRouter(GroupManager: GroupManager): Router {
  const router = Router();

  /** GET /api/groups —— 获取所有群组列表 */
  router.get('/', (_req: Request, res: Response) => {
    const rooms = GroupManager.listGroups();
    res.json({ rooms });
  });

  /** GET /api/groups/:roomId —— 获取单个群组信息 */
  router.get('/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const group = GroupManager.getGroup(roomId);
    if (!room) {
      res.status(404).json({ error: `群组 "${req.params.roomId}" 不存在` });
      return;
    }
    res.json({ room });
  });

  /** POST /api/groups —— 创建群组 */
  router.post('/', (req: Request, res: Response) => {
    const { room_id, name, participants, description } = req.body;
    if (!name || !participants?.length) {
      res.status(400).json({ error: '需要 name, participants' });
      return;
    }
    // room_id 为空时自动生成 UUID
    const finalRoomId: string = (room_id || '').trim() || crypto.randomUUID();
    try {
      const group = GroupManager.createGroup({ room_id: finalRoomId, name, participants, description });
      res.status(201).json({ room });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  /** DELETE /api/groups/:roomId —— 删除群组 */
  router.delete('/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const ok = GroupManager.deleteGroup(roomId);
    if (!ok) {
      res.status(404).json({ error: `群组 "${req.params.roomId}" 不存在` });
      return;
    }
    res.json({ success: true });
  });

  /** PATCH /api/groups/:roomId —— 更新群组信息（名称、简介） */
  router.patch('/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { name, description } = req.body;
    const group = GroupManager.getGroup(roomId);
    if (!room) {
      res.status(404).json({ error: `群组 "${roomId}" 不存在` });
      return;
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: '需要有效的 name 字段' });
        return;
      }
      GroupManager.renameGroup(roomId, name.trim());
    }
    if (description !== undefined) {
      group.description = typeof description === 'string' ? description : '';
      GroupManager.saveGroupConfig(room);
    }
    res.json({ success: true, room: GroupManager.getGroup(roomId) });
  });

  /** GET /api/groups/:roomId/history —— 获取群组历史消息 */
  router.get('/:roomId/history', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const messages = GroupManager.readGroupHistory(roomId, limit, offset);
    res.json({ room_id: req.params.roomId, messages });
  });

  /** POST /api/groups/:roomId/join —— 加入群组 */
  router.post('/:roomId/join', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '需要 agent_id' });
      return;
    }
    const ok = GroupManager.joinGroup(roomId, agent_id);
    if (!ok) {
      res.status(400).json({ error: `加入群组 "${roomId}" 失败` });
      return;
    }
    res.json({ success: true, room: GroupManager.getGroup(roomId) });
  });

  /** POST /api/groups/:roomId/leave —— 离开群组 */
  router.post('/:roomId/leave', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '需要 agent_id' });
      return;
    }
    const ok = GroupManager.leaveGroup(roomId, agent_id);
    res.json({ success: ok });
  });

  return router;
}
