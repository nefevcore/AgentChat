// ============================================================
// GroupService —— 群组管理服务（v0.5.0 P3）
//
// 对 GroupManager 的薄封装，供 webui API 路由使用。
// 避免 webui 直接 import @routing/group-manager。
// ============================================================

import type { GroupManager } from '@routing/group-manager';
import type { GroupConfig } from '@core/types';

export class GroupService {
  constructor(private groupManager: GroupManager) {}

  /** 列出所有群组 */
  listGroups(): GroupConfig[] {
    return this.groupManager.listGroups();
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
  deleteGroup(groupId: string): void {
    this.groupManager.deleteGroup(groupId);
  }

  /** 获取群组消息历史 */
  getGroupHistory(groupId: string, limit?: number): any[] {
    return this.groupManager.readGroupHistory(groupId, limit);
  }

  /** 底层 GroupManager 实例（供需要完整 API 的场景） */
  getManager(): GroupManager {
    return this.groupManager;
  }
}
