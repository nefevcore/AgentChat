// ============================================================
// GroupManager —— 群组管理器
//
// 核心职责：
//   1. 管理 Group 的生命周期（创建/销毁/参与者管理）
//   2. 群组消息持久化（groups/<group_id>/messages.jsonl）
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
export function resolveGroupMessagePath(groupId: string): string {
  return path.join(getGlobalConfig().groupsDir, groupId, 'messages.jsonl');
}

/** 获取群组配置文件路径 */
export function resolveGroupConfigPath(groupId: string): string {
  return path.join(getGlobalConfig().groupsDir, groupId, 'group.json');
}

/** 获取房间记忆文件路径 */
export function resolveGroupMemoryPath(groupId: string): string {
  return path.join(getGlobalConfig().groupsDir, groupId, 'memory.md');
}

// ============================================================
// GroupManager
// ============================================================

export class GroupManager extends EventEmitter {
  private registry: AgentRegistry;
  /** 已加载的房间：group_id → GroupConfig */
  private groups = new Map<string, GroupConfig>();

  constructor(registry: AgentRegistry) {
    super();
    this.registry = registry;
    this.loadExistingGroups();
  }

  // ============================================================
  // 房间生命周期
  // ============================================================

  /** 创建新房间 */
  createGroup(config: { group_id: string; name: string; participants: string[]; description?: string }): GroupConfig {
    if (this.groups.has(config.group_id)) {
      throw new Error(`房间 "${config.group_id}" 已存在`);
    }

    // 验证参与者
    for (const p of config.participants) {
      if (!this.registry.has(p)) {
        throw new Error(`参与者 "${p}" 未在注册表中找到`);
      }
    }

    const group: GroupConfig = {
      group_id: config.group_id,
      name: config.name,
      participants: config.participants,
      created_at: Date.now(),
      description: config.description,
    };

    // 持久化群组配置
    const groupDir = path.join(getGlobalConfig().groupsDir, config.group_id);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(resolveGroupConfigPath(config.group_id), JSON.stringify(group, null, 2), 'utf-8');

    // 创建空消息文件
    fs.writeFileSync(resolveGroupMessagePath(config.group_id), '', 'utf-8');

    this.groups.set(config.group_id, group);

    this.emit('group.created', group);
    logger.info(`[GroupManager] 群组已创建：${group.group_id} (${group.name})，参与者：${group.participants.join(', ')}`);

    return group;
  }

  /** 删除房间 */
  deleteGroup(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const groupDir = path.join(getGlobalConfig().groupsDir, groupId);
    if (fs.existsSync(groupDir)) {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }

    this.groups.delete(groupId);
    this.emit('group.deleted', { group_id: groupId });
    logger.info(`[GroupManager] 群组已删除：${groupId}`);
    return true;
  }

  /** 加入群组 */
  joinGroup(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (!this.registry.has(agentId)) return false;
    if (group.participants.includes(agentId)) return true; // 已在群组中

    group.participants.push(agentId);
    this.saveGroupConfig(group);

    this.emit('group.join', { group_id: groupId, agent_id: agentId, group });
    logger.info(`[GroupManager] ${agentId} 加入群组 ${groupId}`);
    return true;
  }

  /** 重命名房间 */
  renameGroup(groupId: string, newName: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    group.name = newName;
    this.saveGroupConfig(group);
    this.emit('group.renamed', { group_id: groupId, name: newName, group });
    logger.info(`[GroupManager] 群组已重命名：${groupId} → "${newName}"`);
    return true;
  }

  /** 离开群组 */
  leaveGroup(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const idx = group.participants.indexOf(agentId);
    if (idx === -1) return false;

    group.participants.splice(idx, 1);
    this.saveGroupConfig(group);

    this.emit('group.leave', { group_id: groupId, agent_id: agentId, group });
    logger.info(`[GroupManager] ${agentId} 离开群组 ${groupId}`);

    // 如果群组为空，自动删除
    if (group.participants.length === 0) {
      this.deleteGroup(groupId);
    }

    return true;
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 获取群组信息 */
  getGroup(groupId: string): GroupConfig | undefined {
    return this.groups.get(groupId);
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
  isParticipant(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    return group ? group.participants.includes(agentId) : false;
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
   *   1. 持久化消息到 groups/<group_id>/messages.jsonl
   *   2. 触发 'group.message' 事件（供 WebUI 监听）
   *   3. 对每个其他参与者触发 'group.trigger' 事件（Router 层监听并调用 router.trigger()）
   *
   * @returns 投递结果摘要
   */
  async deliverGroupMessage(msg: GroupMessage): Promise<{ status: string; group_id: string; message_id: string; triggered: string[] }> {
    const group = this.groups.get(msg.group_id);
    if (!group) {
      throw new Error(`房间 "${msg.group_id}" 不存在`);
    }

    // user 始终允许向任何房间发消息（无需在参与者列表中）
    if (msg.from !== 'user' && !group.participants.includes(msg.from)) {
      throw new Error(`发送者 "${msg.from}" 不在群组 "${msg.group_id}" 中`);
    }

    // 1. 持久化消息
    this.persistGroupMessage(msg);

    // 1.5 检测群聊归档阈值（复用 agent-session 的归档流程）
    // 触发后可能产生 .archive_pending，不阻塞消息投递
    try {
      const mod = await import(
        '../plugins/agent-core/extensions/agent-session/group-archive.js'
      );
      logger.info(`[GroupManager] 群聊归档检测调用: ${msg.group_id} fn=${typeof mod.maybeRequestGroupArchive}`);
      mod.maybeRequestGroupArchive(msg.group_id);
    } catch (err: any) {
      logger.warn(`[GroupManager] 群聊归档检测失败: ${err?.message}`);
    }

    // 2. 触发事件（供 WebUI / 其他监听者）
    this.emit('group.message', msg);

    // 3. 确定触发目标（除发送者外的所有参与者）
    const targets = group.participants.filter(p => p !== msg.from);

    // 4. 对每个目标触发 trigger 事件（Router 层监听并调用 router.trigger()）
    for (const targetId of targets) {
      this.emit('group.trigger', {
        group_id: msg.group_id,
        group_name: group.name,
        from: msg.from,
        to: targetId,
        payload: msg.payload,
        correlation_id: msg.correlation_id,
        data: msg.data,
      });
    }

    logger.info(
      `[GroupManager] ${msg.from} → group:${msg.group_id}，已 trigger ${targets.length} 个参与者：${targets.join(', ')}`
    );

    return {
      status: 'triggered',
      group_id: msg.group_id,
      message_id: msg.correlation_id ?? '',
      triggered: targets,
    };
  }

  // ============================================================
  // 消息持久化
  // ============================================================

  /** 将消息追加到群组消息文件 */
  private persistGroupMessage(msg: GroupMessage): void {
    const filePath = resolveGroupMessagePath(msg.group_id);
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
   * @param groupId 群组 ID
   * @param limit  最大返回条数
   * @param offset 偏移量（从末尾往前跳过的条数）
   */
  readGroupHistory(groupId: string, limit = 50, offset = 0): PersistedGroupMessage[] {
    const filePath = resolveGroupMessagePath(groupId);
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
  saveGroupConfig(group: GroupConfig): void {
    const filePath = resolveGroupConfigPath(group.group_id);
    fs.writeFileSync(filePath, JSON.stringify(group, null, 2), 'utf-8');
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
          this.groups.set(group.group_id, group);
          logger.info(`[GroupManager] 已加载群组：${group.group_id} (${group.name})`);
        } catch {
          logger.warn(`[GroupManager] 无法加载群组配置：${configPath}`);
        }
      }
    }
  }
}
