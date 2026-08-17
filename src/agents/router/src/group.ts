// ============================================================
// src/agents/group.ts —— 群组管理（纯内存，L2 只做状态与分发）
//
// 核心职责（仅内存态）：
//   1. 群组生命周期：创建/删除/加入/离开/重命名/查询
//   2. 消息分发：deliverGroupMessage 校验后触发事件，不落盘
//
// 已移出（归 L4/L5）：
//   · 落盘（groups/<id>/messages.jsonl、group.json、memory.md）—— L4 持久化层
//   · 历史读取（readGroupHistory）—— L4 从它落盘的目录读取
//   · 群聊归档检测（groupArchiveTrigger）—— L3 插件侧
//   · 网络失效模式 —— 已随 router 移除
//
// 事件面（供上层监听）：
//   · 'group.created' / 'group.deleted' / 'group.join' / 'group.leave' / 'group.renamed'
//   · 'group.message.received' —— L4 监听落盘；L5/WebUI 监听实时展示
//   · 'group.trigger' —— router 监听并调用 router.trigger() 通知参与者
//
// 依赖方向：仅依赖 src/core 与本层 registry/router 类型（相对导入）。
// ============================================================

import { EventEmitter } from 'events';
import { createLogger } from '@agentchat/util';
import type { AgentRegistry } from '@agentchat/agents';
import type { RouterMessage } from './router';

const log = createLogger('[agents:group]');

// ============================================================
// 群组类型
// ============================================================

/** 群组配置 */
export interface GroupConfig {
  /** 房间唯一标识 */
  group_id: string;
  /** 房间显示名称 */
  name: string;
  /** 参与者 Agent ID 列表 */
  participants: string[];
  /** 创建时间戳 */
  created_at: number;
  /** 房间描述（可选） */
  description?: string;
}

/** 群组消息（扩展 RouterMessage，group_id 必填） */
export interface GroupMessage extends RouterMessage {
  /** 所属群组 ID */
  group_id: string;
}

/** 群组 trigger 投递载荷（router 监听 group.trigger 时消费） */
export interface GroupTriggerDelivery {
  group_id: string;
  group_name: string;
  from: string;
  to: string;
  payload: string;
  correlation_id?: string;
  data?: Record<string, any>;
}

/** 群组消息投递结果 */
export interface GroupDeliveryResult {
  status: string;
  group_id: string;
  message_id: string;
  triggered: string[];
}

// ============================================================
// GroupManager（纯内存）
// ============================================================

export class GroupManager extends EventEmitter {
  private registry: AgentRegistry;
  /** 已加载的房间：group_id → GroupConfig */
  private groups = new Map<string, GroupConfig>();

  constructor(registry: AgentRegistry) {
    super();
    this.registry = registry;
  }

  /** 注册表访问（GroupFeed 名称解析等 L4 消费用） */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  // ============================================================
  // 房间生命周期
  // ============================================================

  /** 创建新房间 */
  createGroup(config: { group_id: string; name: string; participants: string[]; description?: string }): GroupConfig {
    if (this.groups.has(config.group_id)) {
      throw new Error(`房间 "${config.group_id}" 已存在`);
    }

    // 验证参与者（user 虚拟端点也需注册）
    for (const p of config.participants) {
      if (!this.registry.has(p)) {
        throw new Error(`参与者 "${p}" 未在注册表中找到`);
      }
    }

    const group: GroupConfig = {
      group_id: config.group_id,
      name: config.name,
      participants: [...config.participants],
      created_at: Date.now(),
      description: config.description,
    };

    this.groups.set(group.group_id, group);
    this.emit('group.created', group);
    log.info(`[GroupManager] 群组已创建：${group.group_id} (${group.name})，参与者：${group.participants.join(', ')}`);
    return group;
  }

  /** 删除房间（L4 负责清理磁盘目录） */
  deleteGroup(groupId: string): boolean {
    if (!this.groups.has(groupId)) return false;
    this.groups.delete(groupId);
    this.emit('group.deleted', { group_id: groupId });
    log.info(`[GroupManager] 群组已删除：${groupId}`);
    return true;
  }

  /** 加入群组 */
  joinGroup(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (!this.registry.has(agentId)) return false;
    if (group.participants.includes(agentId)) return true; // 已在群组中

    group.participants.push(agentId);
    this.emit('group.join', { group_id: groupId, agent_id: agentId, group });
    log.info(`[GroupManager] ${agentId} 加入群组 ${groupId}`);
    return true;
  }

  /** 重命名房间 */
  renameGroup(groupId: string, newName: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    group.name = newName;
    this.emit('group.renamed', { group_id: groupId, name: newName, group });
    log.info(`[GroupManager] 群组已重命名：${groupId} → "${newName}"`);
    return true;
  }

  /** 离开群组；群组清空时自动删除 */
  leaveGroup(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const idx = group.participants.indexOf(agentId);
    if (idx === -1) return false;

    group.participants.splice(idx, 1);
    this.emit('group.leave', { group_id: groupId, agent_id: agentId, group });
    log.info(`[GroupManager] ${agentId} 离开群组 ${groupId}`);

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
  // 消息投递（只分发，不落盘）
  // ============================================================

  /**
   * 向房间投递消息并以 trigger 模式通知所有其他参与者。
   *
   * 流程：
   *   1. 校验房间存在 + 发送者合规（user 始终允许）
   *   2. 触发 'group.message.received' 事件（L4 监听落盘 / L5 监听展示）
   *   3. 对每个其他参与者触发 'group.trigger' 事件（router 监听 → trigger）
   *
   * 持久化由 L4 监听 group.message.received 完成；本方法不触碰文件系统。
   */
  async deliverGroupMessage(msg: GroupMessage): Promise<GroupDeliveryResult> {
    const group = this.groups.get(msg.group_id);
    if (!group) {
      throw new Error(`房间 "${msg.group_id}" 不存在`);
    }

    // user 始终允许向任何房间发消息（无需在参与者列表中）
    if (msg.from !== 'user' && !group.participants.includes(msg.from)) {
      throw new Error(`发送者 "${msg.from}" 不在群组 "${msg.group_id}" 中`);
    }

    // 统一铸造 correlation_id（缺省生成；send_group 工具/旧路径可不带）。
    // 落盘（group.message.received → saveGroupMessage 的 message_id）与
    // trigger（group.trigger → RunStartMeta.sourceMeta.message_id）共用同一 id，
    // 为历史加载的按 id 剔除与单通道通知化提供消息身份（设计文档 §3 Phase 1）。
    msg.correlation_id ??= `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 触发事件（供 L4 落盘 / L5 WebUI 监听）
    this.emit('group.message.received', msg);

    // 确定触发目标（除发送者外的所有参与者）
    const targets = group.participants.filter(p => p !== msg.from);

    // 对每个目标触发 trigger 事件（Router 层监听并调用 router.trigger()）
    for (const targetId of targets) {
      this.emit('group.trigger', {
        group_id: msg.group_id,
        group_name: group.name,
        from: msg.from,
        to: targetId,
        payload: msg.payload,
        correlation_id: msg.correlation_id,
        data: msg.data,
      } satisfies GroupTriggerDelivery);
    }

    log.info(
      `[GroupManager] ${msg.from} → group:${msg.group_id}，已 trigger ${targets.length} 个参与者：${targets.join(', ')}`
    );

    return {
      status: 'triggered',
      group_id: msg.group_id,
      message_id: msg.correlation_id ?? '',
      triggered: targets,
    };
  }
}
