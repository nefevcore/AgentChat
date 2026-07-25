// ============================================================
// RoomManager —— 群聊房间管理器
//
// 核心职责：
//   1. 管理 Room 的生命周期（创建/销毁/参与者管理）
//   2. 房间消息持久化（rooms/<room_id>/messages.jsonl）
//   3. 房间消息投递：收到消息后分发给所有其他参与者
//   4. 通过 EventEmitter 发出 room 事件，供 WebUI 监听
// ============================================================

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';
import { RoomConfig, RoomMessage, AgentMessage, PersistedRoomMessage } from '@core/types';
import { AgentRegistry } from './registry';

// ============================================================
// 路径工具
// ============================================================

/** 获取房间消息文件路径 */
export function resolveRoomMessagePath(roomId: string): string {
  return path.join(getGlobalConfig().roomsDir, roomId, 'messages.jsonl');
}

/** 获取房间配置文件路径 */
export function resolveRoomConfigPath(roomId: string): string {
  return path.join(getGlobalConfig().roomsDir, roomId, 'room.json');
}

/** 获取房间记忆文件路径 */
export function resolveRoomMemoryPath(roomId: string): string {
  return path.join(getGlobalConfig().roomsDir, roomId, 'memory.md');
}

// ============================================================
// RoomManager
// ============================================================

export class RoomManager extends EventEmitter {
  private registry: AgentRegistry;
  /** 已加载的房间：room_id → RoomConfig */
  private rooms = new Map<string, RoomConfig>();

  constructor(registry: AgentRegistry) {
    super();
    this.registry = registry;
    this.loadExistingRooms();
  }

  // ============================================================
  // 房间生命周期
  // ============================================================

  /** 创建新房间 */
  createRoom(config: { room_id: string; name: string; participants: string[]; description?: string }): RoomConfig {
    if (this.rooms.has(config.room_id)) {
      throw new Error(`房间 "${config.room_id}" 已存在`);
    }

    // 验证参与者
    for (const p of config.participants) {
      if (!this.registry.has(p)) {
        throw new Error(`参与者 "${p}" 未在注册表中找到`);
      }
    }

    const room: RoomConfig = {
      room_id: config.room_id,
      name: config.name,
      participants: config.participants,
      created_at: Date.now(),
      description: config.description,
    };

    // 持久化房间配置
    const roomDir = path.join(getGlobalConfig().roomsDir, config.room_id);
    fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(resolveRoomConfigPath(config.room_id), JSON.stringify(room, null, 2), 'utf-8');

    // 创建空消息文件
    fs.writeFileSync(resolveRoomMessagePath(config.room_id), '', 'utf-8');

    this.rooms.set(config.room_id, room);

    this.emit('room.created', room);
    console.log(`[RoomManager] 房间已创建：${room.room_id} (${room.name})，参与者：${room.participants.join(', ')}`);

    return room;
  }

  /** 删除房间 */
  deleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const roomDir = path.join(getGlobalConfig().roomsDir, roomId);
    if (fs.existsSync(roomDir)) {
      fs.rmSync(roomDir, { recursive: true, force: true });
    }

    this.rooms.delete(roomId);
    this.emit('room.deleted', { room_id: roomId });
    console.log(`[RoomManager] 房间已删除：${roomId}`);
    return true;
  }

  /** 加入房间 */
  joinRoom(roomId: string, agentId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    if (!this.registry.has(agentId)) return false;
    if (room.participants.includes(agentId)) return true; // 已在房间中

    room.participants.push(agentId);
    this.saveRoomConfig(room);

    this.emit('room.join', { room_id: roomId, agent_id: agentId, room });
    console.log(`[RoomManager] ${agentId} 加入房间 ${roomId}`);
    return true;
  }

  /** 重命名房间 */
  renameRoom(roomId: string, newName: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.name = newName;
    this.saveRoomConfig(room);
    this.emit('room.renamed', { room_id: roomId, name: newName, room });
    console.log(`[RoomManager] 房间已重命名：${roomId} → "${newName}"`);
    return true;
  }

  /** 离开房间 */
  leaveRoom(roomId: string, agentId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const idx = room.participants.indexOf(agentId);
    if (idx === -1) return false;

    room.participants.splice(idx, 1);
    this.saveRoomConfig(room);

    this.emit('room.leave', { room_id: roomId, agent_id: agentId, room });
    console.log(`[RoomManager] ${agentId} 离开房间 ${roomId}`);

    // 如果房间为空，自动删除
    if (room.participants.length === 0) {
      this.deleteRoom(roomId);
    }

    return true;
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 获取房间信息 */
  getRoom(roomId: string): RoomConfig | undefined {
    return this.rooms.get(roomId);
  }

  /** 列出所有房间 */
  listRooms(): RoomConfig[] {
    return Array.from(this.rooms.values());
  }

  /** 列出某 Agent 参与的房间 */
  listRoomsForAgent(agentId: string): RoomConfig[] {
    return Array.from(this.rooms.values()).filter(r => r.participants.includes(agentId));
  }

  /** 检查 Agent 是否在房间中 */
  isParticipant(roomId: string, agentId: string): boolean {
    const room = this.rooms.get(roomId);
    return room ? room.participants.includes(agentId) : false;
  }

  // ============================================================
  // 消息投递
  // ============================================================

  /**
   * 向房间发送消息并分发给所有其他参与者。
   *
   * 流程：
   *   1. 持久化消息到 rooms/<room_id>/messages.jsonl
   *   2. 触发 'room.message' 事件（供 WebUI 监听）
   *   3. 对每个其他参与者触发投递通知（实际消息由各 Agent 自行读取历史）
   *
   * @returns 投递结果摘要
   */
  deliverRoomMessage(msg: RoomMessage): { status: string; room_id: string; message_id: string; delivered_to: string[] } {
    const room = this.rooms.get(msg.room_id);
    if (!room) {
      throw new Error(`房间 "${msg.room_id}" 不存在`);
    }

    // user 始终允许向任何房间发消息（无需在参与者列表中）
    if (msg.from !== 'user' && !room.participants.includes(msg.from)) {
      throw new Error(`发送者 "${msg.from}" 不在房间 "${msg.room_id}" 中`);
    }

    // 1. 持久化消息
    this.persistRoomMessage(msg);

    // 2. 触发事件（供 WebUI / 其他监听者）
    this.emit('room.message', msg);

    // 3. 确定投递目标（除发送者外的所有参与者）
    const targets = room.participants.filter(p => p !== msg.from);

    // 4. 对每个目标触发投递事件（Router 层监听并调用 Agent.receive()）
    for (const targetId of targets) {
      this.emit('room.deliver', {
        room_id: msg.room_id,
        from: msg.from,
        to: targetId,
        payload: msg.payload,
        correlation_id: msg.correlation_id,
        data: msg.data,
      });
    }

    console.log(
      `[RoomManager] ${msg.from} → room:${msg.room_id}，已投递至 ${targets.length} 个参与者：${targets.join(', ')}`
    );

    return {
      status: 'delivered',
      room_id: msg.room_id,
      message_id: msg.correlation_id ?? '',
      delivered_to: targets,
    };
  }

  // ============================================================
  // 消息持久化
  // ============================================================

  /** 将消息追加到房间消息文件 */
  private persistRoomMessage(msg: RoomMessage): void {
    const filePath = resolveRoomMessagePath(msg.room_id);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const persisted: PersistedRoomMessage = {
      role: 'user', // 房间消息统一以 user 角色存储，由加载方进行角色校正
      content: msg.payload,
      agent_id: msg.from,
      timestamp: new Date().toISOString(),
    };

    fs.appendFileSync(filePath, JSON.stringify(persisted) + '\n', 'utf-8');
  }

  /**
   * 读取房间历史消息
   * @param roomId 房间 ID
   * @param limit  最大返回条数
   * @param offset 偏移量（从末尾往前跳过的条数）
   */
  readRoomHistory(roomId: string, limit = 50, offset = 0): PersistedRoomMessage[] {
    const filePath = resolveRoomMessagePath(roomId);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const end = lines.length - offset;
    const start = Math.max(0, end - limit);
    const page = lines.slice(start, end);

    return page
      .map(line => {
        try { return JSON.parse(line) as PersistedRoomMessage; }
        catch { return null; }
      })
      .filter(Boolean) as PersistedRoomMessage[];
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 持久化房间配置 */
  private saveRoomConfig(room: RoomConfig): void {
    const filePath = resolveRoomConfigPath(room.room_id);
    fs.writeFileSync(filePath, JSON.stringify(room, null, 2), 'utf-8');
  }

  /** 从磁盘加载已有房间 */
  private loadExistingRooms(): void {
    const roomsDir = getGlobalConfig().roomsDir;
    if (!fs.existsSync(roomsDir)) {
      fs.mkdirSync(roomsDir, { recursive: true });
      return;
    }

    const entries = fs.readdirSync(roomsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const entry of entries) {
      const configPath = resolveRoomConfigPath(entry.name);
      if (fs.existsSync(configPath)) {
        try {
          const room = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RoomConfig;
          this.rooms.set(room.room_id, room);
          console.log(`[RoomManager] 已加载房间：${room.room_id} (${room.name})`);
        } catch {
          console.warn(`[RoomManager] 无法加载房间配置：${configPath}`);
        }
      }
    }
  }
}
