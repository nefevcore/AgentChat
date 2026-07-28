// ============================================================
// GroupManager —— 群组管理器
//
// 核心职责：
//   1. 管理 Group 的生命周期（创建/销毁/参与者管理）
//   2. 群组消息持久化（groups/<room_id>/messages.jsonl）
//   3. 群组消息投递：收到消息后分发给所有其他参与者
//   4. 通过 EventEmitter 发出 group 事件，供 WebUI 监听
// ============================================================

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';
import { GroupConfig, GroupMessage, AgentMessage, PersistedGroupMessage } from '@core/types';
import { AgentRegistry } from './registry';
import { logger } from '../utils/logger';

// ============================================================
// 路径工具
// ============================================================

/** 获取群组消息文件路径 */
export function resolveGroupMessagePath(roomId: string): string {
  return path.join(getGlobalConfig().groupsDir, roomId, 'messages.jsonl');
}

/** 获取群组配置文件路径 */
export function resolveGroupConfigPath(roomId: string): string {
  return path.join(getGlobalConfig().groupsDir, roomId, 'group.json');
}

/** 获取房间记忆文件路径 */
export function resolveGroupMemoryPath(roomId: string): string {
  return path.join(getGlobalConfig().groupsDir, roomId, 'memory.md');
}

// ============================================================
// GroupManager
// ============================================================

export class GroupManager extends EventEmitter {
  private registry: AgentRegistry;
  /** 已加载的房间：room_id → GroupConfig */
  private rooms = new Map<string, GroupConfig>();

  constructor(registry: AgentRegistry) {
    super();
    this.registry = registry;
    this.loadExistingGroups();
  }

  // ============================================================
  // 房间生命周期
  // ============================================================

  /** 创建新房间 */
  createGroup(config: { room_id: string; name: string; participants: string[]; description?: string }): GroupConfig {
    if (this.groups.has(config.room_id)) {
      throw new Error(`房间 "${config.room_id}" 已存在`);
    }

    // 验证参与者
    for (const p of config.participants) {
      if (!this.registry.has(p)) {
        throw new Error(`参与者 "${p}" 未在注册表中找到`);
      }
    }

    const group: GroupConfig = {
      room_id: config.room_id,
      name: config.name,
      participants: config.participants,
      created_at: Date.now(),
      description: config.description,
    };

    // 持久化群组配置
    const roomDir = path.join(getGlobalConfig().groupsDir, config.room_id);
    fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(resolveGroupConfigPath(config.room_id), JSON.stringify(room, null, 2), 'utf-8');

    // 创建空消息文件
    fs.writeFileSync(resolveGroupMessagePath(config.room_id), '', 'utf-8');

    this.groups.set(config.room_id, room);

    this.emit('group.created', room);
    logger.info(`[GroupManager] 群组已创建：${group.room_id} (${group.name})，参与者：${group.participants.join(', ')}`);

    return room;
  }

  /** 删除房间 */
  deleteGroup(roomId: string): boolean {
    const group = this.groups.get(roomId);
    if (!room) return false;

    const roomDir = path.join(getGlobalConfig().groupsDir, roomId);
    if (fs.existsSync(roomDir)) {
      fs.rmSync(roomDir, { recursive: true, force: true });
    }

    this.groups.delete(roomId);
    this.emit('group.deleted', { room_id: roomId });
    logger.info(`[GroupManager] 群组已删除：${roomId}`);
    return true;
  }

  /** 加入群组 */
  joinGroup(roomId: string, agentId: string): boolean {
    const group = this.groups.get(roomId);
    if (!room) return false;
    if (!this.registry.has(agentId)) return false;
    if (group.participants.includes(agentId)) return true; // 已在群组中

    group.participants.push(agentId);
    this.saveGroupConfig(room);

    this.emit('group.join', { room_id: roomId, agent_id: agentId, room });
    logger.info(`[GroupManager] ${agentId} 加入群组 ${roomId}`);
    return true;
  }

  /** 重命名房间 */
  renameGroup(roomId: string, newName: string): boolean {
    const group = this.groups.get(roomId);
    if (!room) return false;
    group.name = newName;
    this.saveGroupConfig(room);
    this.emit('group.renamed', { room_id: roomId, name: newName, room });
    logger.info(`[GroupManager] 群组已重命名：${roomId} → "${newName}"`);
    return true;
  }

  /** 离开群组 */
  leaveGroup(roomId: string, agentId: string): boolean {
    const group = this.groups.get(roomId);
    if (!room) return false;

    const idx = group.participants.indexOf(agentId);
    if (idx === -1) return false;

    group.participants.splice(idx, 1);
    this.saveGroupConfig(room);

    this.emit('group.leave', { room_id: roomId, agent_id: agentId, room });
    logger.info(`[GroupManager] ${agentId} 离开群组 ${roomId}`);

    // 如果群组为空，自动删除
    if (group.participants.length === 0) {
      this.deleteGroup(roomId);
    }

    return true;
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 获取群组信息 */
  getGroup(roomId: string): GroupConfig | undefined {
    return this.groups.get(roomId);
  }

  /** 列出所有群组 */
  listGroups(): GroupConfig[] {
    return Array.from(this.groups.values());
  }

  /** 列出某 Agent 参与的房间 */
  listGroupsForAgent(agentId: string): GroupConfig[] {
    return Array.from(this.groups.values()).filter(r => r.participants.includes(agentId));
  }

  /** 检查 Agent 是否在房间中 */
  isParticipant(roomId: string, agentId: string): boolean {
    const group = this.groups.get(roomId);
    return room ? group.participants.includes(agentId) : false;
  }

  // ============================================================
  // 消息投递
  // ============================================================

  /**
   * 向房间发送消息并以 trigger 模式通知所有其他参与者。
   *
   * trigger 模式：消息持久化后，通过 router.trigger() 通知各参与者。
   * 每个 Agent 自行判断是否需要回复（自主推理），而非强制 push。
   *
   * 流程：
   *   1. 持久化消息到 groups/<room_id>/messages.jsonl
   *   2. 触发 'group.message' 事件（供 WebUI 监听）
   *   3. 对每个其他参与者触发 'group.trigger' 事件（Router 层监听并调用 router.trigger()）
   *
   * @returns 投递结果摘要
   */
  deliverGroupMessage(msg: GroupMessage): { status: string; room_id: string; message_id: string; triggered: string[] } {
    const group = this.groups.get(msg.room_id);
    if (!room) {
      throw new Error(`房间 "${msg.room_id}" 不存在`);
    }

    // user 始终允许向任何房间发消息（无需在参与者列表中）
    if (msg.from !== 'user' && !group.participants.includes(msg.from)) {
      throw new Error(`发送者 "${msg.from}" 不在群组 "${msg.room_id}" 中`);
    }

    // 1. 持久化消息
    this.persistGroupMessage(msg);

    // 2. 触发事件（供 WebUI / 其他监听者）
    this.emit('group.message', msg);

    // 3. 确定触发目标（除发送者外的所有参与者）
    const targets = group.participants.filter(p => p !== msg.from);

    // 4. 对每个目标触发 trigger 事件（Router 层监听并调用 router.trigger()）
    for (const targetId of targets) {
      this.emit('group.trigger', {
        room_id: msg.room_id,
        room_name: group.name,
        from: msg.from,
        to: targetId,
        payload: msg.payload,
        correlation_id: msg.correlation_id,
        data: msg.data,
      });
    }

    logger.info(
      `[GroupManager] ${msg.from} → room:${msg.room_id}，已 trigger ${targets.length} 个参与者：${targets.join(', ')}`
    );

    return {
      status: 'triggered',
      room_id: msg.room_id,
      message_id: msg.correlation_id ?? '',
      triggered: targets,
    };
  }

  // ============================================================
  // 消息持久化
  // ============================================================

  /** 将消息追加到群组消息文件 */
  private persistGroupMessage(msg: GroupMessage): void {
    const filePath = resolveGroupMessagePath(msg.room_id);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const persisted: PersistedGroupMessage = {
      role: 'agent', // 群组消息统一以 agent 角色存储，由加载方进行角色校正
      content: msg.payload,
      agent_id: msg.from,
      timestamp: new Date().toISOString(),
    };

    fs.appendFileSync(filePath, JSON.stringify(persisted) + '\n', 'utf-8');
  }

  /**
   * 读取群组历史消息
   * @param roomId 群组 ID
   * @param limit  最大返回条数
   * @param offset 偏移量（从末尾往前跳过的条数）
   */
  readGroupHistory(roomId: string, limit = 50, offset = 0): PersistedGroupMessage[] {
    const filePath = resolveGroupMessagePath(roomId);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const end = lines.length - offset;
    const start = Math.max(0, end - limit);
    const page = lines.slice(start, end);

    return page
      .map(line => {
        try { return JSON.parse(line) as PersistedGroupMessage; }
        catch { return null; }
      })
      .filter(Boolean) as PersistedGroupMessage[];
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 持久化群组配置 */
  /** 持久化群组配置（供外部 API 修改 description 等字段后保存） */
  saveGroupConfig(room: GroupConfig): void {
    const filePath = resolveGroupConfigPath(group.room_id);
    fs.writeFileSync(filePath, JSON.stringify(room, null, 2), 'utf-8');
  }

  /** 从磁盘加载已有房间 */
  private loadExistingGroups(): void {
    const groupsDir = getGlobalConfig().groupsDir;
    if (!fs.existsSync(groupsDir)) {
      fs.mkdirSync(groupsDir, { recursive: true });
      return;
    }

    const entries = fs.readdirSync(groupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const entry of entries) {
      const configPath = resolveGroupConfigPath(entry.name);
      if (fs.existsSync(configPath)) {
        try {
          const group = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as GroupConfig;
          this.groups.set(group.room_id, room);
          logger.info(`[GroupManager] 已加载群组：${group.room_id} (${group.name})`);
        } catch {
          logger.warn(`[GroupManager] 无法加载群组配置：${configPath}`);
        }
      }
    }
  }
}
