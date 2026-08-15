// ============================================================
// GroupService —— 群组管理服务（L4 门面 + 持久化）
//
// 对 GroupManager（L2 纯内存）的薄封装 + L4 持久化职责：
//   群聊消息落盘：
//     · 群聊本体  sessions/group~<gid>/messages.jsonl —— 由本服务监听
//       group.message.received 统一落盘（send_group 工具投递 + 用户 WebUI 发的
//       群消息的唯一入口），只记录真正投递到群里的消息（无思考/工具）
//     · 周归档    sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl
//       （L3 saveSession 写，含思考/工具，仅分析复盘）
//   本服务负责：
//     · group.created/renamed/join/leave → 写 group.json（元数据，groups/<id>/）
//     · group.deleted → 清理磁盘目录（groups/ + sessions/group~<gid>/）
//     · 启动加载（loadGroupsFromDisk）
//     · 历史读取（getGroupHistory 读群聊本体 messages.jsonl）
//
// 依赖方向：services → agents/core（允许）；Node fs/path；@agents/paths。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { GroupManager, GroupMessage, GroupConfig } from '@agentchat/router';
import { workspaceRoot } from '@agentchat/toolkit';
import { createLogger } from '@agentchat/util';
import { DIALOG_SEP } from '@agentchat/agents';
import { readTailLines } from './history-service';
import type { GroupPersistedMessage } from '@agentchat/protocol';

const log = createLogger('[services:group]');

export type { GroupPersistedMessage } from '@agentchat/protocol';

/** 群组列表项（附带最近活跃时间） */
export interface GroupWithActivity extends GroupConfig {
  lastActivity: number;
}

export class GroupService {
  private wsRoot: string;

  constructor(private groupManager: GroupManager, wsRoot = workspaceRoot()) {
    this.wsRoot = wsRoot;

    // ---- L4 持久化：监听 GroupManager 事件落盘 ----
    // group.message.received 是所有群消息投递的唯一入口（send_group 工具 +
    // 用户 WebUI group.message 都经 deliverGroupMessage 触发）→ 统一落盘群聊本体
    this.groupManager.on('group.message.received', (msg: GroupMessage) => this.saveGroupMessage(msg));
    this.groupManager.on('group.created', (group: GroupConfig) => this.saveGroupConfig(group));
    this.groupManager.on('group.renamed', (info: { group: GroupConfig }) => this.saveGroupConfig(info.group));
    this.groupManager.on('group.join', (info: { group: GroupConfig }) => this.saveGroupConfig(info.group));
    this.groupManager.on('group.leave', (info: { group: GroupConfig }) => this.saveGroupConfig(info.group));
    this.groupManager.on('group.deleted', (info: { group_id: string }) => this.removeGroupDir(info.group_id));
  }

  // ============================================================
  // 路径与持久化（私有）
  // ============================================================

  private groupDir(groupId: string): string {
    return path.join(this.wsRoot, 'groups', groupId);
  }

  /** 群聊会话目录：sessions/group~<gid>（周归档根） */
  private groupSessionsDir(groupId: string): string {
    return path.join(this.wsRoot, 'sessions', `group${DIALOG_SEP}${groupId}`);
  }

  /** 群聊本体文件：sessions/group~<gid>/messages.jsonl（功能历史，只记 send_group 投递的消息） */
  private groupMessagesFile(groupId: string): string {
    return path.join(this.groupSessionsDir(groupId), 'messages.jsonl');
  }

  /** 群消息落盘：group.message.received → 追加一条到群聊本体 */
  private saveGroupMessage(msg: GroupMessage): void {
    try {
      const content = msg.payload ?? msg.data?.content ?? '';
      if (!content) return;
      const entry: GroupPersistedMessage = {
        group_id: msg.group_id,
        role: 'agent',
        content,
        agent_id: msg.from,
        message_id: msg.correlation_id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
      };
      const file = this.groupMessagesFile(msg.group_id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err: any) {
      log.warn(`群聊消息落盘失败: ${err?.message ?? String(err)}`);
    }
  }

  private groupConfigPath(groupId: string): string {
    return path.join(this.groupDir(groupId), 'group.json');
  }

  /** 写 group.json */
  private saveGroupConfig(group: GroupConfig): void {
    try {
      const filePath = this.groupConfigPath(group.group_id);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(group, null, 2), 'utf-8');
    } catch (err: any) {
      log.warn(`群组配置落盘失败（${group.group_id}）: ${err?.message ?? String(err)}`);
    }
  }

  /** 删除群组磁盘目录（group.deleted 触发）：groups/<gid> + sessions/group~<gid> */
  private removeGroupDir(groupId: string): void {
    try {
      for (const dir of [this.groupDir(groupId), this.groupSessionsDir(groupId)]) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      log.info(`群组磁盘目录已清理：${groupId}`);
    } catch (err: any) {
      log.warn(`群组目录清理失败（${groupId}）: ${err?.message ?? String(err)}`);
    }
  }

  // ============================================================
  // 启动加载
  // ============================================================

  /**
   * 从磁盘加载已有群组到内存 GroupManager。
   * 需在 Agent 全部注册后调用（createGroup 校验参与者）；重复调用会跳过已存在群组。
   * @returns 加载的群组数量
   */
  loadGroupsFromDisk(): number {
    const dir = path.join(this.wsRoot, 'groups');
    if (!fs.existsSync(dir)) return 0;

    let loaded = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(dir, entry.name, 'group.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as GroupConfig;
        if (this.groupManager.getGroup(cfg.group_id)) continue; // 已存在
        this.groupManager.createGroup({
          group_id: cfg.group_id,
          name: cfg.name,
          participants: cfg.participants,
          description: cfg.description,
        });
        loaded++;
      } catch (err: any) {
        log.warn(`加载群组失败（${entry.name}）: ${err?.message ?? String(err)}`);
      }
    }
    if (loaded > 0) log.info(`已加载 ${loaded} 个群组`);
    return loaded;
  }

  // ============================================================
  // 群组 CRUD（薄封装）
  // ============================================================

  /** 列出所有群组 */
  listGroups(): GroupConfig[] {
    return this.groupManager.listGroups();
  }

  /** 列出群组并附带最近活跃时间（读群聊本体 messages.jsonl 最后一条时间戳，只读尾部） */
  listGroupsWithActivity(): GroupWithActivity[] {
    return this.groupManager.listGroups().map((g) => {
      let lastActivity = 0;
      try {
        const file = this.groupMessagesFile(g.group_id);
        if (fs.existsSync(file)) {
          const tail = readTailLines(file, 1);
          if (tail.length > 0) {
            const last = JSON.parse(tail[0]);
            lastActivity = new Date(last.timestamp).getTime();
          }
        }
      } catch { /* no history yet */ }
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

  /** 删除群组（内存 + 磁盘目录） */
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
      this.saveGroupConfig(group);
    }
    return this.groupManager.getGroup(groupId);
  }

  /** 获取群组消息历史（读群聊本体 messages.jsonl，最新往前的分页） */
  getGroupHistory(groupId: string, limit = 50, offset = 0): GroupPersistedMessage[] {
    const file = this.groupMessagesFile(groupId);
    if (!fs.existsSync(file)) return [];

    // 快速路径：limit=1 & offset=0（会话列表最新消息预览）→ 只读文件尾部最后一行。
    // 群聊本体按时间追加（saveGroupMessage appendFileSync），最后一行即最新消息。
    if (limit === 1 && offset === 0) {
      const tail = readTailLines(file, 1);
      if (tail.length > 0) {
        try { return [JSON.parse(tail[0]) as GroupPersistedMessage]; } catch { /* 损坏行 → 回退全量 */ }
      }
    }

    const all: GroupPersistedMessage[] = [];
    for (const line of fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)) {
      try { all.push(JSON.parse(line) as GroupPersistedMessage); } catch { /* skip */ }
    }
    // 按时间正序聚合 → 倒序分页（最新在前）→ 返回正序页
    all.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    const end = all.length - offset;
    const start = Math.max(0, end - limit);
    return all.slice(start, end);
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
