// ============================================================
// Groups API ���� GET/POST /api/groups, /api/groups/:groupId/...
// ============================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { GroupManager } from '@routing/group-manager';

export function createGroupsRouter(GroupManager: GroupManager): Router {
  const router = Router();

  /** GET /api/groups ���� ��ȡ����Ⱥ���б� */
  router.get('/', (_req: Request, res: Response) => {
    const groups = GroupManager.listGroups();
    res.json({ groups });
  });

  /** GET /api/groups/:groupId ���� ��ȡ����Ⱥ����Ϣ */
  router.get('/:groupId', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const group = GroupManager.getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: `Ⱥ�� "${req.params.groupId}" ������` });
      return;
    }
    res.json({ group });
  });

  /** POST /api/groups ���� ����Ⱥ�� */
  router.post('/', (req: Request, res: Response) => {
    const { group_id, name, participants, description } = req.body;
    if (!name || !participants?.length) {
      res.status(400).json({ error: '��Ҫ name, participants' });
      return;
    }
    // group_id Ϊ��ʱ�Զ����� UUID
    const finalGroupId: string = (group_id || '').trim() || crypto.randomUUID();
    try {
      const group = GroupManager.createGroup({ group_id: finalGroupId, name, participants, description });
      res.status(201).json({ group });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  /** DELETE /api/groups/:groupId ���� ɾ��Ⱥ�� */
  router.delete('/:groupId', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const ok = GroupManager.deleteGroup(groupId);
    if (!ok) {
      res.status(404).json({ error: `Ⱥ�� "${req.params.groupId}" ������` });
      return;
    }
    res.json({ success: true });
  });

  /** PATCH /api/groups/:groupId ���� ����Ⱥ����Ϣ�����ơ���飩 */
  router.patch('/:groupId', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const { name, description } = req.body;
    const group = GroupManager.getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: `Ⱥ�� "${groupId}" ������` });
      return;
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: '��Ҫ��Ч�� name �ֶ�' });
        return;
      }
      GroupManager.renameGroup(groupId, name.trim());
    }
    if (description !== undefined) {
      group.description = typeof description === 'string' ? description : '';
      GroupManager.saveGroupConfig(group);
    }
    res.json({ success: true, group: GroupManager.getGroup(groupId) });
  });

  /** GET /api/groups/:groupId/history ���� ��ȡȺ����ʷ��Ϣ */
  router.get('/:groupId/history', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const messages = GroupManager.readGroupHistory(groupId, limit, offset);
    res.json({ group_id: req.params.groupId, messages });
  });

  /** POST /api/groups/:groupId/join ���� ����Ⱥ�� */
  router.post('/:groupId/join', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '��Ҫ agent_id' });
      return;
    }
    const ok = GroupManager.joinGroup(groupId, agent_id);
    if (!ok) {
      res.status(400).json({ error: `����Ⱥ�� "${groupId}" ʧ��` });
      return;
    }
    res.json({ success: true, group: GroupManager.getGroup(groupId) });
  });

  /** POST /api/groups/:groupId/leave ���� �뿪Ⱥ�� */
  router.post('/:groupId/leave', (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '��Ҫ agent_id' });
      return;
    }
    const ok = GroupManager.leaveGroup(groupId, agent_id);
    res.json({ success: ok });
  });

  return router;
}
