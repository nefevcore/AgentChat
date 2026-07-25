// ============================================================
// Rooms API —— GET/POST /api/rooms, /api/rooms/:roomId/...
// ============================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { RoomManager } from '@routing/room-manager';

export function createRoomsRouter(roomManager: RoomManager): Router {
  const router = Router();

  /** GET /api/rooms —— 获取所有房间列表 */
  router.get('/', (_req: Request, res: Response) => {
    const rooms = roomManager.listRooms();
    res.json({ rooms });
  });

  /** GET /api/rooms/:roomId —— 获取单个房间信息 */
  router.get('/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const room = roomManager.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: `房间 "${req.params.roomId}" 不存在` });
      return;
    }
    res.json({ room });
  });

  /** POST /api/rooms —— 创建房间 */
  router.post('/', (req: Request, res: Response) => {
    const { room_id, name, participants, description } = req.body;
    if (!name || !participants?.length) {
      res.status(400).json({ error: '需要 name, participants' });
      return;
    }
    // room_id 为空时自动生成 UUID
    const finalRoomId: string = (room_id || '').trim() || crypto.randomUUID();
    try {
      const room = roomManager.createRoom({ room_id: finalRoomId, name, participants, description });
      res.status(201).json({ room });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  /** DELETE /api/rooms/:roomId —— 删除房间 */
  router.delete('/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const ok = roomManager.deleteRoom(roomId);
    if (!ok) {
      res.status(404).json({ error: `房间 "${req.params.roomId}" 不存在` });
      return;
    }
    res.json({ success: true });
  });

  /** PATCH /api/rooms/:roomId —— 更新房间信息（如名称） */
  router.patch('/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: '需要有效的 name 字段' });
      return;
    }
    const room = roomManager.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: `房间 "${roomId}" 不存在` });
      return;
    }
    roomManager.renameRoom(roomId, name.trim());
    res.json({ success: true, room: roomManager.getRoom(roomId) });
  });

  /** GET /api/rooms/:roomId/history —— 获取房间历史消息 */
  router.get('/:roomId/history', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const messages = roomManager.readRoomHistory(roomId, limit, offset);
    res.json({ room_id: req.params.roomId, messages });
  });

  /** POST /api/rooms/:roomId/join —— 加入房间 */
  router.post('/:roomId/join', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '需要 agent_id' });
      return;
    }
    const ok = roomManager.joinRoom(roomId, agent_id);
    if (!ok) {
      res.status(400).json({ error: `加入房间 "${roomId}" 失败` });
      return;
    }
    res.json({ success: true, room: roomManager.getRoom(roomId) });
  });

  /** POST /api/rooms/:roomId/leave —— 离开房间 */
  router.post('/:roomId/leave', (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: '需要 agent_id' });
      return;
    }
    const ok = roomManager.leaveRoom(roomId, agent_id);
    res.json({ success: ok });
  });

  return router;
}
