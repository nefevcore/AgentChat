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
import { workspaceRoot, estimateTokens } from '@agentchat/toolkit';
import { createLogger } from '@agentchat/util';
import { DIALOG_SEP, wrapGroupMsg } from '@agentchat/agents';
import type { GroupFeed, GroupFeedAnchor, GroupFeedPage } from '@agentchat/contracts';
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
  /** 本体归档阈值（总 token 估算） */
  private archiveTokens: number;
  /** 归档后本体保留尾部 token 预算 */
  private keepTokens: number;

  constructor(private groupManager: GroupManager, wsRoot = workspaceRoot(), opts?: {
    /** 本体归档阈值（总 token 估算；默认 500000，对齐 v0.4.x groupArchiveTokens） */
    archiveTokens?: number;
    /** 归档后本体保留尾部的 token 预算（默认 30000） */
    keepTokens?: number;
  }) {
    this.wsRoot = wsRoot;
    this.archiveTokens = opts?.archiveTokens ?? 500_000;
    this.keepTokens = opts?.keepTokens ?? 30_000;

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
      // 本体容量管理（Phase 2.5，恢复 v0.4.x group-archive 轮转）：超阈值归档
      this.maybeArchiveBody(msg.group_id);
    } catch (err: any) {
      log.warn(`群聊消息落盘失败: ${err?.message ?? String(err)}`);
    }
  }

  /**
   * 本体轮转（容量管理，Phase 2.5）：总 token 超 archiveTokens 时——
   *   旧消息 → sessions/group~<gid>/archive/history_N.jsonl（与周归档同根，群删除随目录清理）
   *   机械摘要 → summary_N.md（loadGroupHistory 注入为长期记忆锚点）
   *   重建本体，保留尾部 keepTokens 预算
   * 全程同步 fs（与 saveGroupMessage 的同步 append 同 tick，无交错窗口）。
   * 归档前全员记忆整理编排（v0.4.x 的 pending/done 标记流）为后续增量，不在本批。
   */
  private maybeArchiveBody(groupId: string): void {
    try {
      const file = this.groupMessagesFile(groupId);
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
      if (lines.length === 0) return;
      const parsed = lines
        .map((l) => { try { return JSON.parse(l) as GroupPersistedMessage; } catch { return null; } })
        .filter(Boolean) as GroupPersistedMessage[];
      const totalTokens = parsed.reduce((acc, m) => acc + estimateTokens(m.content ?? ''), 0);
      if (totalTokens <= this.archiveTokens) return;

      // 保留尾部（keepTokens 预算，×1.5 容差对齐 v0.4.x truncateGroupMessages）
      let acc = 0;
      let splitIdx = parsed.length;
      for (let i = parsed.length - 1; i >= 0; i--) {
        const t = estimateTokens(parsed[i].content ?? '');
        if (acc + t > this.keepTokens * 1.5 && acc > 0) break;
        acc += t;
        splitIdx = i;
      }
      if (splitIdx <= 0) return; // 全部都在保留预算内（理论不达：totalTokens 已超阈值）
      const archived = parsed.slice(0, splitIdx);
      const kept = parsed.slice(splitIdx);

      const archiveDir = path.join(this.groupSessionsDir(groupId), 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const existing = fs.readdirSync(archiveDir).filter((f) => /^history_\d+\.jsonl$/.test(f));
      const index = existing.length + 1;
      fs.writeFileSync(
        path.join(archiveDir, `history_${index}.jsonl`),
        archived.map((m) => JSON.stringify(m)).join('\n') + '\n',
        'utf-8',
      );
      // 机械摘要锚点（时间/发送人/内容截断，≤60 条；loadGroupHistory 注入头部）
      const summaryItems = archived
        .filter((m) => (m.content ?? '').trim())
        .slice(-60)
        .map((m) => {
          const ts = (m.timestamp ?? '').slice(0, 16).replace('T', ' ');
          const sender = m.agent_id ?? 'unknown';
          const text = m.content!.length > 150 ? `${m.content!.slice(0, 150)}…` : m.content!;
          return `- [${ts}] ${sender}: ${text.replace(/\n/g, ' ')}`;
        });
      if (summaryItems.length > 0) {
        fs.writeFileSync(
          path.join(archiveDir, `summary_${index}.md`),
          `# 群聊 ${groupId} 早期摘要（归档 ${new Date().toISOString().slice(0, 16)}，${archived.length} 条 → history_${index}.jsonl）\n\n${summaryItems.join('\n')}\n`,
          'utf-8',
        );
      }
      // 重建本体（保留尾部）：先写临时文件再原子替换，崩溃不致本体半损
      const tmp = `${file}.rotating`;
      fs.writeFileSync(tmp, kept.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
      fs.renameSync(tmp, file);
      log.info(`[services:group] 群聊本体轮转 ${groupId}：${archived.length} 条 → archive/history_${index}.jsonl，保留尾部 ${kept.length} 条`);
    } catch (err: any) {
      log.warn(`群聊本体轮转失败（${groupId}，下次消息重试）: ${err?.message ?? String(err)}`);
    }
  }

  /** 读取最新归档摘要（无归档返回 null；loadGroupHistory 注入用） */
  readLatestArchiveSummary(groupId: string): string | null {
    try {
      const archiveDir = path.join(this.groupSessionsDir(groupId), 'archive');
      if (!fs.existsSync(archiveDir)) return null;
      const summaries = fs.readdirSync(archiveDir)
        .filter((f) => /^summary_\d+\.md$/.test(f))
        .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
      if (summaries.length === 0) return null;
      return fs.readFileSync(path.join(archiveDir, summaries[0]), 'utf-8');
    } catch {
      return null;
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

  // ============================================================
  // GroupFeed 实现（单通道化，docs/group-single-channel-design.md §2.6）
  // 群消息内容唯一通道：本体文件 + 锚点增量读取（Router busy 注入消费）
  // ============================================================

  /** 读本体全部行（解析失败行跳过；文件不存在 = 空） */
  private readGroupLines(groupId: string): GroupPersistedMessage[] {
    const file = this.groupMessagesFile(groupId);
    if (!fs.existsSync(file)) return [];
    const out: GroupPersistedMessage[] = [];
    for (const line of fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())) {
      try { out.push(JSON.parse(line) as GroupPersistedMessage); } catch { /* skip */ }
    }
    return out;
  }

  /** 定位锚点下标（返回锚点行的下标；找不到 = -1）：message_id 精确优先，line 回退 */
  private locateAnchorIndex(lines: GroupPersistedMessage[], anchor: GroupFeedAnchor | undefined): number {
    if (!anchor) return -1;
    if (anchor.message_id) {
      const idx = lines.findIndex((m) => m.message_id === anchor.message_id);
      if (idx !== -1) return idx;
    }
    if (typeof anchor.line === 'number' && anchor.line >= 0 && anchor.line < lines.length) {
      return anchor.line;
    }
    return -1;
  }

  async readSince(
    groupId: string,
    anchor: GroupFeedAnchor | undefined,
    opts?: { viewer?: string; maxTokens?: number },
  ): Promise<GroupFeedPage> {
    const lines = this.readGroupLines(groupId);
    const anchorIdx = this.locateAnchorIndex(lines, anchor);
    // 无锚点（busy ctx 未初始化，理论不发生——群 dialog runStart 必设）：空增量，避免双注
    const increment = anchorIdx === -1 ? [] : lines.slice(anchorIdx + 1);
    if (increment.length === 0) {
      const tail = lines[lines.length - 1];
      return {
        injected: '',
        message_ids: [],
        anchor: tail
          ? { ...(tail.message_id ? { message_id: tail.message_id } : {}), line: lines.length - 1 }
          : { line: 0 },
      };
    }

    // 视图包装（单一事实源）：peer 消息 <msg> 包装，own 消息裸文本（与 loadGroupHistory 一致）
    const viewer = opts?.viewer;
    const groupName = this.groupManager.getGroup(groupId)?.name ?? groupId;
    const registry = this.groupManager.getRegistry();
    const rendered = increment.map((m) => {
      const sender = m.agent_id ?? '';
      if (m.role === 'agent' && sender && sender !== viewer) {
        const displayName = registry.getAgentName(sender);
        return wrapGroupMsg({ from: sender, displayName, groupName, content: m.content ?? '' });
      }
      return m.content ?? '';
    });

    // token 上限：超限保留最新部分 + 头部提示行（可用 read_history 查看更早增量）
    const maxTokens = opts?.maxTokens ?? 8000;
    let head = 0;
    let acc = 0;
    for (let i = rendered.length - 1; i >= 0; i--) {
      const t = estimateTokens(rendered[i]);
      if (acc + t > maxTokens && acc > 0) break;
      acc += t;
      head = i;
    }
    const dropped = head;
    const kept = rendered.slice(head);
    const injected = (dropped > 0 ? [`（另有 ${dropped} 条更早的群消息未注入，可用 read_history 查看）`] : [])
      .concat(kept)
      .join('\n');

    const tailMsg = increment[increment.length - 1];
    return {
      injected,
      message_ids: increment.map((m) => m.message_id ?? '').filter(Boolean),
      anchor: {
        ...(tailMsg.message_id ? { message_id: tailMsg.message_id } : {}),
        line: anchorIdx + increment.length,
      },
    };
  }

  async currentAnchor(groupId: string): Promise<GroupFeedAnchor> {
    const lines = this.readGroupLines(groupId);
    const tail = lines[lines.length - 1];
    if (!tail) return { line: 0 };
    return { ...(tail.message_id ? { message_id: tail.message_id } : {}), line: lines.length - 1 };
  }
}
