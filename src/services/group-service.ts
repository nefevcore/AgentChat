// ============================================================
// GroupService —— 群组管理服务（v0.5.0 P3）
//
// 对 GroupManager 的薄封装，供 src/server API 路由使用。
// 避免 server 直接 import @agents/group（webui 只 import services）。
// ============================================================

import * as fs from 'fs';
import type { GroupManager } from '@agents/group';
import { resolveGroupMessagePath } from '@agents/group';
import type { GroupConfig, PersistedGroupMessage } from '@core/types';

/** 群组列表项（附带最近活跃时间） */
export interface GroupWithActivity extends GroupConfig {
  lastActivity: number;
}

export class GroupService {
  constructor(private groupManager: GroupManager) {}

  /** 列出所有群组 */
  listGroups(): GroupConfig[] {
    return this.groupManager.listGroups();
  }

  /** 列出群组并附带最近活跃时间（读 messages 文件最后一条时间戳） */
  listGroupsWithActivity(): GroupWithActivity[] {
    return this.groupManager.listGroups().map((g) => {
      let lastActivity = 0;
      try {
        const filePath = resolveGroupMessagePath(g.group_id);
        if (fs.existsSync(filePath)) {
          const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
          if (lines.length > 0) {
            const last = JSON.parse(lines[lines.length - 1]);
            lastActivity = new Date(last.timestamp).getTime();
          }
        }
      } catch { /* no messages yet */ }
      return { ...g, lastActivity };
    });
  }

  /** 获取单个群组 */
  getGroup(groupId: string): GroupConfig | undefined {
    return this.groupManager.getGroup(groupId);
  }

  /** 创建群组 */
  createGroup(config: { group_id: string; name: string; participants: string[]; description?: string }): GroupConfig {
    return this.groupManager.createGroup(config);
  }

  /** 删除群组 */
  deleteGroup(groupId: string): boolean {
    return this.groupManager.deleteGroup(groupId);
  }

  /** 更新群组名称/描述（name 需非空，由调用方校验） */
  updateGroup(groupId: string, patch: { name?: string; description?: string }): GroupConfig | undefined {
    const group = this.groupManager.getGroup(groupId);
    if (!group) return undefined;
    if (patch.name !== undefined) {
      this.groupManager.renameGroup(groupId, patch.name.trim());
    }
    if (patch.description !== undefined) {
      group.description = typeof patch.description === 'string' ? patch.description : '';
      this.groupManager.saveGroupConfig(group);
    }
    return this.groupManager.getGroup(groupId);
  }

  /** 获取群组消息历史 */
  getGroupHistory(groupId: string, limit?: number, offset?: number): PersistedGroupMessage[] {
    return this.groupManager.readGroupHistory(groupId, limit, offset);
  }

  /** 加入群组 */
  joinGroup(groupId: string, agentId: string): boolean {
    return this.groupManager.joinGroup(groupId, agentId);
  }

  /** 离开群组 */
  leaveGroup(groupId: string, agentId: string): boolean {
    return this.groupManager.leaveGroup(groupId, agentId);
  }

  /** 底层 GroupManager 实例（供需要完整 API 的场景） */
  getManager(): GroupManager {
    return this.groupManager;
  }
}
