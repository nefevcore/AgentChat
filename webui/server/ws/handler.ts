// ============================================================
// WebSocket 连接管理器
// 管理前端 WS 连接，处理入站/出站消息
//
// 会话生命周期：
//   · Agent 会话与 WS 连接解耦 —— 关闭页面不会中断 Agent 执行
//   · 用户发送新消息时，按 agentId 中断旧会话（无论来自哪个连接）
//   · 重连时可通过 chat.subscribe 接上正在进行的流式输出
// ============================================================

import * as WebSocket from 'ws';
import { IncomingMessage } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { AgentRouter } from '@routing/router';
import { logger } from '@utils/logger';
import { AgentRegistry } from '@routing/registry';
import { IMessageQuery } from '@routing/message-query';
import { GroupManager } from '@routing/group-manager';
import { AgentMessage } from '@core/types';
import { Agent } from '@core/agent';
import { getGlobalConfig } from '@core/config';
import { parseWSMessage, buildWSMessage, WSMessageTypes, WSMessage } from './protocol';
import { idleArchive } from '@global/agent-core/extensions/agent-session/idle-timer';
import { requestArchive } from '@global/agent-core/extensions/agent-session/archive';
import { markMemoryReviewNeeded } from '@global/agent-core/extensions/agent-memory/memory';
import { deleteFromJSONL } from '@global/agent-core/extensions/agent-session/history';

/**
 * 单个 WebSocket 连接
 */
interface WSConnection {
  ws: WebSocket;
  id: string;
  connectedAt: Date;
}

/**
 * 活跃会话（按连接+Agent 维度，与 WS 连接解耦但隔离不同连接）
 */
interface ActiveSession {
  controller: AbortController;
  agentId: string;
  /** 所属连接的 ID */
  connId: string;
  /** 当前会话状态快照（用于重连客户端恢复 UI 状态） */
  snapshot: SessionSnapshot;
}

/**
 * 会话快照中的一个已处理步骤（AgentMsg 形状，供前端 _agentMsgsToSteps 重建）
 * 对应一次完整的 assistant 轮次：thinking + content + 发起的工具调用（含结果）
 */
interface StepSnapshot {
  role: 'agent' | 'tool';
  content: string;
  thinking?: string;
  label?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: any; result?: string; label?: string }>;
  ts?: number;
}

/**
 * 会话状态快照 —— 重连时发送给客户端以重建 UI
 */
interface SessionSnapshot {
  phase: 'idle' | 'thinking' | 'message' | 'tool' | 'error';
  thinking: string;
  content: string;
  turnCount: number;
  toolCallId?: string;
  toolName?: string;
  label?: string;
  error?: boolean;
  /** 当前轮用户消息（postHook 前未落盘，快照恢复用） */
  userMessage?: string;
  userMessageTs?: number;
  /** 当前轮全部用户输入（原始 + 转向消息），刷新后恢复完整对话流 */
  userMessages?: Array<{ content: string; ts: number }>;
  /** 当前轮已完成的 ReAct 步骤（未落盘的中间过程） */
  steps?: StepSnapshot[];
  /** 内部：当前累积中的步骤（thinking/content/tool 未完成），订阅时并入 steps */
  currentStep?: StepSnapshot;
}

export interface WSHandlerOptions {
  router: AgentRouter;
  registry: AgentRegistry;
  messageQuery: IMessageQuery;
  GroupManager?: GroupManager;
}

export class WSHandler {
  private router: AgentRouter;
  private registry: AgentRegistry;
  private messageQuery: IMessageQuery;
  private groupManager: GroupManager | null = null;
  private connections = new Map<string, WSConnection>();

  /** 活跃会话：connId:agentId → ActiveSession（按连接隔离） */
  private activeSessions = new Map<string, ActiveSession>();

  /**
   * Trigger 发起的会话 correlation_id 集合。
   * 这些会话的流式事件不广播到前端，避免把定时任务/房间触发器产生的
   * Agent 自主推理输出混入用户当前 1:1 对话中，导致会话内容异常。
   */
  private triggerSessionCids = new Set<string>();

  /**
   * chat.send 幂等去重缓存：`${to}|${content}` → 最近处理时间戳。
   * 前端 WS 重连时 pendingMessages 会 flush 重发，若同一内容在短时间内
   * 被投递两次（如断线重连、双击发送），后端会重复启动会话并各持久化一次
   * → 出现两条完全相同的记录（#53/#91 案例）。
   * 窗口 8s：覆盖 WS 重连延迟，同时允许用户 8s 后有意重发同一内容。
   */
  private recentChatSends = new Map<string, number>();
  private static readonly CHAT_SEND_DEDUP_MS = 8000;

  constructor(options: WSHandlerOptions) {
    this.router = options.router;
    this.registry = options.registry;
    this.messageQuery = options.messageQuery;
    this.groupManager = options.GroupManager ?? null;

    // 监听 Router 事件，推送到所有连接的客户端 + 更新会话快照
    this.router.on('message', (msg: AgentMessage) => {
      // Trigger 会话的流式事件不推送到前端 —— 避免定时任务/房间触发器的
      // 自主推理输出污染用户正在进行的 1:1 对话。
      if (this.trackAndCheckTriggerSession(msg)) return;
      this.updateSessionSnapshot(msg);
      this.broadcastRouterEvent(msg);
    });

    // 归档完成通知 → 广播 session.archived（前端刷新消息列表）
    this.router.on('archive.completed', (data: { agent: string; counterpart: string }) => {
      this.broadcastToAll(WSMessageTypes.SESSION_ARCHIVED, {
        agent: data.agent,
        counterpart: data.counterpart,
        success: true,
      });
      logger.info(`[WS] 归档完成广播: ${data.agent} ↔ ${data.counterpart}`);
    });

    // 监听 GroupManager 事件，推送群组消息到前端
    if (this.groupManager) {
      this.groupManager.on('group.message', (msg: AgentMessage) => {
        this.broadcastToAll(WSMessageTypes.GROUP_MESSAGE, {
          group_id: msg.group_id,
          from: msg.from,
          payload: msg.payload,
          correlation_id: msg.correlation_id,
          data: msg.data,
        });
      });

      this.groupManager.on('group.created', (group: any) => {
        this.broadcastToAll(WSMessageTypes.GROUP_CREATED, { group });
      });

      this.groupManager.on('group.deleted', (info) => {
        this.broadcastToAll(WSMessageTypes.GROUP_DELETED, info);
      });
    }

    // 监听 Agent 档案更新事件 → 通知前端刷新清单
    this.router.on('agent.profile.updated', (data: { agentId: string; changed: string[] }) => {
      this.broadcastToAll(WSMessageTypes.AGENT_PROFILE_UPDATED, data);
    });
  }

  /** 生成会话键 */
  private sessionKey(connId: string, agentId: string): string {
    return `${connId}:${agentId}`;
  }

  /**
   * 跟踪并检查 trigger 发起的会话。
   *
   * - chat.start 中 hint 以 `<trigger>` 开头 → 标记该 correlation_id 为 trigger 会话
   * - chat.end → 清理已结束的 trigger 会话标记
   * - 返回 true 表示该事件属于 trigger 会话，不应推送到前端
   */
  private trackAndCheckTriggerSession(msg: AgentMessage): boolean {
    const cid = msg.correlation_id;
    if (!cid) return false;

    if (msg.type === 'chat.start') {
      const hint = msg.data?.hint;
      if (typeof hint === 'string' && hint.startsWith('<trigger>')) {
        this.triggerSessionCids.add(cid);
        logger.info(`[WS] 标记 trigger 会话: ${cid} (agent=${msg.data?.agent})`);
        return true;
      }
    }

    if (msg.type === 'chat.end') {
      if (this.triggerSessionCids.has(cid)) {
        this.triggerSessionCids.delete(cid);
        logger.info(`[WS] 清理 trigger 会话: ${cid}`);
        return true;
      }
    }

    // 已标记的 trigger 会话 → 跳过
    if (this.triggerSessionCids.has(cid)) return true;
    return false;
  }

  /** 解析 Agent 头像 URL */
  private resolveAgentAvatar(agentId: string): string | null {
    const agentsDir = getGlobalConfig().agentsDir;
    if (!fs.existsSync(agentsDir)) return null;

    // 扫描所有子目录匹配 agent_id
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const entry of entries) {
      const configPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(configPath)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.agent_id === agentId) {
          const candidates = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.jpeg', 'avatar.svg'];
          for (const name of candidates) {
            if (fs.existsSync(path.join(agentsDir, entry.name, name))) {
              return `/api/agents/${encodeURIComponent(agentId)}/avatar`;
            }
          }
          return null;
        }
      } catch { /* skip */ }
    }
    return null;
  }

  /** 检查指定 Agent 是否有活跃会话（跨所有连接） */
  hasActiveSession(agentId: string): boolean {
    for (const [key, s] of this.activeSessions) {
      if (s.agentId === agentId) return true;
    }
    return false;
  }

  /** 获取连接专属的会话快照 */
  getSessionSnapshot(connId: string, agentId: string): SessionSnapshot | null {
    return this.activeSessions.get(this.sessionKey(connId, agentId))?.snapshot ?? null;
  }

  /** 中断指定连接的指定 Agent 会话 */
  private abortSession(connId: string, agentId: string): boolean {
    const key = this.sessionKey(connId, agentId);
    const session = this.activeSessions.get(key);
    if (session) {
      logger.info(`[WS] 中断会话：${agentId}（连接 ${connId}）`);
      session.controller.abort();
      this.activeSessions.delete(key);
      return true;
    }
    return false;
  }

  /**
   * 处理新的 WebSocket 连接
   */
  handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    const connId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const conn: WSConnection = {
      ws,
      id: connId,
      connectedAt: new Date(),
    };

    this.connections.set(connId, conn);
    logger.info(`[WS] 客户端已连接：${connId}（共 ${this.connections.size} 个）`);

    // 处理前端发来的消息
    ws.on('message', (raw: WebSocket.Data) => {
      this.handleIncoming(conn, raw.toString());
    });

    // 连接关闭 —— 不中断 Agent 会话，Agent 继续在后台执行
    ws.on('close', () => {
      this.connections.delete(connId);
      logger.info(`[WS] 客户端已断开：${connId}（共 ${this.connections.size} 个，活跃会话 ${this.activeSessions.size} 个）`);
    });

    // 错误处理
    ws.on('error', (err) => {
      logger.error(`[WS] Error on ${connId}: ${err.message}`);
      this.connections.delete(connId);
    });
  }

  /**
   * 处理前端入站消息
   */
  private async handleIncoming(conn: WSConnection, raw: string): Promise<void> {
    const msg = parseWSMessage(raw);
    if (!msg) {
      conn.ws.send(buildWSMessage('error', { message: '无效的消息格式' }));
      return;
    }

    logger.info(`[WS] ← ${conn.id}: ${msg.type}`);

    switch (msg.type) {
      case WSMessageTypes.CHAT_SEND:
        await this.handleChatSend(conn, msg);
        break;

      case WSMessageTypes.CHAT_INTERRUPT:
        await this.handleChatInterrupt(conn, msg);
        break;

      case WSMessageTypes.CHAT_CONTINUE:
        await this.handleChatContinue(conn, msg);
        break;

      case WSMessageTypes.CHAT_SUBSCRIBE:
        await this.handleChatSubscribe(conn, msg);
        break;

      case WSMessageTypes.AGENT_LIST:
        await this.handleAgentList(conn);
        break;

      case WSMessageTypes.HISTORY_REQUEST:
        await this.handleHistoryRequest(conn, msg);
        break;

      // ---- 房间类 ----
      case WSMessageTypes.GROUP_LIST:
        await this.handleGroupList(conn);
        break;

      case WSMessageTypes.GROUP_CREATE:
        await this.handleGroupCreate(conn, msg);
        break;

      case WSMessageTypes.GROUP_DELETE:
        await this.handleGroupDelete(conn, msg);
        break;

      case WSMessageTypes.GROUP_JOIN:
        await this.handleGroupJoin(conn, msg);
        break;

      case WSMessageTypes.GROUP_LEAVE:
        await this.handleGroupLeave(conn, msg);
        break;

      case WSMessageTypes.GROUP_MESSAGE:
        await this.handleGroupMessage(conn, msg);
        break;

      case WSMessageTypes.GROUP_HISTORY_REQUEST:
        await this.handleGroupHistoryRequest(conn, msg);
        break;

      case WSMessageTypes.SESSION_COMPRESS:
        await this.handleSessionCompress(conn, msg);
        break;

      case WSMessageTypes.SESSION_ARCHIVE:
        await this.handleSessionArchive(conn, msg);
        break;

      case WSMessageTypes.CHAT_DELETE_MESSAGE:
        await this.handleDeleteMessage(conn, msg);
        break;

      case WSMessageTypes.AGENT_SYSTEM_PROMPT:
        await this.handleAgentSystemPrompt(conn, msg);
        break;

      case WSMessageTypes.AGENT_TOOL_DEFS:
        await this.handleAgentToolDefs(conn, msg);
        break;

      default:
        conn.ws.send(buildWSMessage('error', { message: `未知的消息类型：${msg.type}` }));
    }
  }

  /**
   * 处理 chat.send → 路由消息到目标 Agent。
   * 同连接的 Agent 正在运行时注入为转向消息，不同连接则独立启动新会话。
   */
  private async handleChatSend(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to, content, attachments, files, deepThink } = msg.data;

    if (!to || (!content && !files?.length)) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.send 需要提供 "to" 和 "content"' }));
      return;
    }

    // ---- 幂等去重：WS 重连 flush 重发或双击时，忽略 8s 内重复的同目标同内容 ----
    const dedupKey = `${to}|${content ?? ''}`;
    const now = Date.now();
    const lastSent = this.recentChatSends.get(dedupKey);
    if (lastSent && now - lastSent < WSHandler.CHAT_SEND_DEDUP_MS) {
      logger.info(`[WS] ${conn.id} 忽略重复 chat.send（${Math.round((now - lastSent) / 1000)}s 内同内容已投递）: "${(content ?? '').slice(0, 40)}"`);
      // 通知前端已收到，避免 UI 无反馈（不重复投递给 Agent）
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_SEND_ACK, { to, deduped: true }));
      return;
    }
    this.recentChatSends.set(dedupKey, now);
    // 清理过期条目，防止 Map 无限增长
    if (this.recentChatSends.size > 100) {
      for (const [k, t] of this.recentChatSends) {
        if (now - t >= WSHandler.CHAT_SEND_DEDUP_MS) this.recentChatSends.delete(k);
      }
    }

    // 处理附件引用
    const fileList = files ?? attachments ?? [];
    let payload = content;
    if (fileList.length > 0) {
      const fileRefs = fileList
        .map((a: any) => `./files/${a.hash}`)
        .join(', ');
      payload = `${content}\n\n[用户上传了文件：${fileRefs}]`;
    }

    // 同连接的 Agent 正在运行 → 注入为转向消息（同一用户追加指令）
    const sessionKey = this.sessionKey(conn.id, to);
    const activeSession = this.activeSessions.get(sessionKey);
    if (activeSession) {
      const agent = this.registry.getAgent(to);
      if (agent && agent instanceof Agent) {
        agent.steer({ role: 'user', content: payload, agent_id: getGlobalConfig().viewerId });
        // 转向消息也记入快照（刷新后恢复完整对话流：问了什么 → 转向了什么）
        const snap = activeSession.snapshot;
        const entry = { content: payload, ts: Date.now() };
        snap.userMessages = [...(snap.userMessages ?? []), entry];
        snap.userMessage = payload;
        snap.userMessageTs = entry.ts;
        logger.info(`[WS] ${conn.id} 向 ${to} 注入转向消息: "${content.slice(0, 40)}"`);
      }
      return;
    }

    // 该连接下 Agent 空闲 → 启动新会话
    const correlationId = `webui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const abortController = new AbortController();
    // 快照记录当前轮用户消息（postHook 前未落盘，刷新后靠快照恢复）
    const snapshot: SessionSnapshot = {
      phase: 'idle', thinking: '', content: '', turnCount: 0,
      userMessage: payload, userMessageTs: Date.now(),
      userMessages: [{ content: payload, ts: Date.now() }],
      steps: [],
    };
    const session: ActiveSession = { controller: abortController, agentId: to, connId: conn.id, snapshot };
    this.activeSessions.set(sessionKey, session);

    const agentMsg: AgentMessage = {
      from: getGlobalConfig().viewerId,
      to,
      type: 'chat.send',
      payload,
      correlation_id: correlationId,
      data: { content, files: fileList, deepThink: !!deepThink },
    };

    try {
      await this.router.send(agentMsg, abortController.signal);
    } finally {
      if (this.activeSessions.get(sessionKey) === session) {
        this.activeSessions.delete(sessionKey);
      }
    }
  }

  /**
   * 处理 chat.interrupt → 仅中断当前连接的会话
   */
  private async handleChatInterrupt(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to } = msg.data;
    if (!to) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.interrupt 需要提供 "to"' }));
      return;
    }

    const wasAborted = this.abortSession(conn.id, to);
    conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_INTERRUPTED, {
      agentId: to,
      reason: 'user_interrupt',
      wasActive: wasAborted,
    }));

    logger.info(`[WS] ${conn.id} 显式中断了 ${to} 的会话（活跃=${wasAborted}）`);
  }

  /**
   * 处理 chat.continue → 触发 Agent 继续生成（基于对话上下文自主推理）。
   *
   * 与 chat.send 不同：不携带新的用户消息，Agent 仅基于 system prompt + 历史
   * 对话记录自行判断是否继续。hint 为空，Agent 自由推理。
   */
  private async handleChatContinue(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to } = msg.data;
    if (!to) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.continue 需要提供 "to"' }));
      return;
    }

    // 该连接下 Agent 正在运行 → 拒绝（以免同时执行两个 trigger）
    const sessionKey = this.sessionKey(conn.id, to);
    if (this.activeSessions.has(sessionKey)) {
      conn.ws.send(buildWSMessage('error', { message: `Agent "${to}" 正在运行，请等待完成后再继续生成` }));
      return;
    }

    const abortController = new AbortController();
    const snapshot: SessionSnapshot = { phase: 'idle', thinking: '', content: '', turnCount: 0, steps: [] };
    const session: ActiveSession = { controller: abortController, agentId: to, connId: conn.id, snapshot };
    this.activeSessions.set(sessionKey, session);

    logger.info(`[WS] ${conn.id} 触发 ${to} 继续生成`);

    try {
      // trigger 不带 hint → Agent 基于历史对话自由推理，不限制轮次
      // target 设为 viewerId，确保消息持久化到 viewer↔agent 会话路径
      await this.router.trigger(to, { target: getGlobalConfig().viewerId }, abortController.signal);
    } finally {
      if (this.activeSessions.get(sessionKey) === session) {
        this.activeSessions.delete(sessionKey);
      }
    }
  }

  /**
   * 处理 agent.list 请求（含活跃会话状态）
   */
  private async handleAgentList(conn: WSConnection): Promise<void> {
    const ids = this.registry.listIds().filter((id: string) => !this.registry.isVirtual(id));
    const agents = await Promise.all(
      ids.map(async (id: string) => {
        const agent = this.registry.getAgent(id);
        const lastMessages = await this.messageQuery.query({
          from: getGlobalConfig().viewerId,
          to: id,
          limit: 1,
        });
        // 最后一条消息才是助手的最新回复（链首是用户消息）
        const lastMsg = lastMessages.at(-1) ?? null;
        const lastMessage = lastMsg
          ? {
              role: lastMsg.role,
              content: typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 80) : '',
              timestamp: lastMsg.timestamp,
              agent_id: lastMsg.agent_id,
            }
          : null;
        const lastActivity = lastMsg ? new Date(lastMsg.timestamp).getTime() : 0;
        return {
          id,
          name: this.registry.getAgentName(id),
          description: '',
          avatar: this.resolveAgentAvatar(id),
          lastMessage,
          lastActivity,
          hasActiveSession: this.hasActiveSession(id),
        };
      })
    );

    // 附加虚拟 Agent（user 等），仅提供名称和头像，前端用于房间成员显示
    const virtualIds = this.registry.listIds().filter((id: string) => this.registry.isVirtual(id));
    for (const id of virtualIds) {
      agents.push({
        id,
        name: this.registry.getAgentName(id),
        description: '',
        avatar: this.resolveAgentAvatar(id),
        lastMessage: null,
        lastActivity: 0,
        hasActiveSession: false,
      });
    }

    agents.sort((a, b) => b.lastActivity - a.lastActivity);
    conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_LIST_RESPONSE, { agents }));
  }

  /**
   * 处理 history.request
   */
  private async handleHistoryRequest(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { from, to, limit, offset } = msg.data;
    const messages = await this.messageQuery.query({ from, to, limit, offset });
    // 统一使用 role='agent' + agent_id 区分身份，前端自行判定左右位置
    conn.ws.send(buildWSMessage(WSMessageTypes.HISTORY_RESPONSE, { messages, agentId: to }));
  }

  /**
   * 处理 chat.subscribe → 客户端请求订阅自已连接的 Agent 活跃会话（重连场景）
   */
  private async handleChatSubscribe(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to } = msg.data;
    if (!to) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.subscribe 需要提供 "to"' }));
      return;
    }

    // 先查本连接，再跨连接 fallback（刷新页面 = 新 WS 连接，旧连接已断开但
    // activeSessions 仍保留到 run 结束，须跨连接找到活跃会话快照）
    const snapshot = this.getSessionSnapshot(conn.id, to) ?? this.findAgentSnapshot(to);
    if (!snapshot) {
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_SESSION_RESUME, {
        agentId: to,
        active: false,
      }));
      return;
    }

    // 序列化步骤：已归档 steps + 当前累积步骤（若有内容）
    const steps = [...(snapshot.steps ?? [])];
    if (snapshot.currentStep) {
      const cs = snapshot.currentStep;
      if (cs.content?.trim() || cs.thinking?.trim() || (cs.tool_calls?.length ?? 0) > 0) {
        steps.push({ ...cs, tool_calls: (cs.tool_calls ?? []).filter(tc => tc.name || tc.result !== undefined) });
      }
    }

    conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_SESSION_RESUME, {
      agentId: to,
      active: true,
      ...snapshot,
      steps,
      currentStep: undefined,
    }));
    logger.info(`[WS] ${conn.id} 订阅了 ${to} 的活跃会话（phase=${snapshot.phase}, steps=${steps.length}）`);
  }

  /** 跨连接查找指定 Agent 的活跃会话快照 */
  private findAgentSnapshot(agentId: string): SessionSnapshot | null {
    for (const s of this.activeSessions.values()) {
      if (s.agentId === agentId) return s.snapshot;
    }
    return null;
  }

  /**
   * 处理 session.compress → 写入压缩标记 + 发 trigger，由 postHook 自动归档
   *
   * 设计：不走 agent.receive() 直接等待，而是写入 .memory_archive_needed 标记文件，
   * 然后通过 router.send() 正常发送 trigger。agent-session 的 postHook 检测到标记后
   * 自动剔除 trigger 消息并调用 idleArchive。全程走 router，无竞态。
   */
  private async handleSessionCompress(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { agent, counterpart } = msg.data;
    if (!agent || !counterpart) {
      conn.ws.send(buildWSMessage('error', { message: 'session.compress 需要提供 "agent" 和 "counterpart"' }));
      return;
    }

    // v0.4.1 归档重构：统一走先整理后归档（requestArchive 驱动整理轮）
    // 旧路径 writeCompressMarker + 手动 trigger 绕过归档编排，已废弃
    requestArchive(agent, counterpart);

    logger.info(`[WS] ${conn.id} 压缩/归档对话（已触发整理）: ${agent} ↔ ${counterpart}`);

    // 回执语义：已触发整理流程（真正归档由 session.archived 通知）
    conn.ws.send(buildWSMessage(WSMessageTypes.SESSION_COMPRESSED, {
      agent,
      counterpart,
      success: true,
    }));
  }

  private async handleSessionArchive(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { agent, counterpart } = msg.data;
    if (!agent || !counterpart) {
      conn.ws.send(buildWSMessage('error', { message: 'session.archive 需要提供 "agent" 和 "counterpart"' }));
      return;
    }

    try {
      // v0.4.1 归档重构：统一走先整理后归档（requestArchive 驱动双方整理轮）
      // 旧路径 idleArchive 绕过记忆整理，改为 requestArchive 后归档由整理轮完成触发
      requestArchive(agent, counterpart);

      logger.info(`[WS] ${conn.id} 手动归档会话（已触发整理）: ${agent} ↔ ${counterpart}`);

      // 回执语义：已触发整理流程（真正归档由 session.archived 通知）
      conn.ws.send(buildWSMessage(WSMessageTypes.SESSION_ARCHIVED, {
        agent,
        counterpart,
        success: true,
        pending: true,
      }));
    } catch (err: any) {
      logger.error(`[WS] 归档会话失败 (${agent}/${counterpart}): ${err.message}`);
      conn.ws.send(buildWSMessage(WSMessageTypes.SESSION_ARCHIVED, {
        agent,
        counterpart,
        success: false,
        error: err.message,
      }));
    }
  }

  /**
   * 处理 chat.delete_message → 从 JSONL 中删除指定消息
   */
  private async handleDeleteMessage(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { agent, counterpart, messageId } = msg.data;
    if (!agent || !counterpart || !messageId) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.delete_message 需要提供 agent, counterpart, messageId' }));
      return;
    }

    const ok = deleteFromJSONL(agent, counterpart, messageId);
    logger.info(`[WS] ${conn.id} 删除消息: ${agent}/${counterpart} msg=${messageId} → ${ok ? '成功' : '未找到'}`);

    conn.ws.send(buildWSMessage('chat.message.deleted', {
      agent,
      counterpart,
      messageId,
      success: ok,
    }));
  }

  /**
   * 处理 agent.system_prompt → 预览 Agent 的 System Prompt
   */
  private async handleAgentSystemPrompt(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { agentId } = msg.data;
    if (!agentId) {
      conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_SYSTEM_PROMPT_RESPONSE, {
        success: false,
        error: '缺少 agentId 参数',
      }));
      return;
    }

    try {
      const agent = this.registry.getAgent(agentId);
      if (!agent || !(agent instanceof Agent)) {
        conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_SYSTEM_PROMPT_RESPONSE, {
          success: false,
          error: `Agent "${agentId}" 未找到`,
        }));
        return;
      }

      const systemPrompt = await (agent as Agent).assembleSystemPrompt(getGlobalConfig().viewerId);
      conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_SYSTEM_PROMPT_RESPONSE, {
        success: true,
        agentId,
        systemPrompt,
      }));
      logger.info(`[WS] ${conn.id} 预览 System Prompt: ${agentId} (${systemPrompt.length} 字符)`);
    } catch (err: any) {
      logger.error(`[WS] 预览 System Prompt 失败 (${agentId}): ${err.message}`);
      conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_SYSTEM_PROMPT_RESPONSE, {
        success: false,
        error: err.message,
      }));
    }
  }

  /**
   * 处理 agent.tool_defs → 预览 Agent 的工具定义
   */
  private async handleAgentToolDefs(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { agentId } = msg.data;
    if (!agentId) {
      conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_TOOL_DEFS_RESPONSE, {
        success: false,
        error: '缺少 agentId 参数',
      }));
      return;
    }

    try {
      const agent = this.registry.getAgent(agentId);
      if (!agent || !(agent instanceof Agent)) {
        conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_TOOL_DEFS_RESPONSE, {
          success: false,
          error: `Agent "${agentId}" 未找到`,
        }));
        return;
      }

      const toolDefs = (agent as Agent).getToolDefinitions();
      // 将 ToolDefinition[] 序列化为 JSON（前端自行格式化为 XML）
      conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_TOOL_DEFS_RESPONSE, {
        success: true,
        agentId,
        toolDefs,
      }));
      logger.info(`[WS] ${conn.id} 预览工具定义: ${agentId} (${toolDefs.length} 个工具)`);
    } catch (err: any) {
      logger.error(`[WS] 预览工具定义失败 (${agentId}): ${err.message}`);
      conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_TOOL_DEFS_RESPONSE, {
        success: false,
        error: err.message,
      }));
    }
  }

  /**
   * 根据 Router 事件更新会话快照（匹配所有同 agentId 的会话）
   */
  /** 确保快照有当前累积步骤（懒创建） */
  private ensureStep(snap: SessionSnapshot): StepSnapshot {
    if (!snap.currentStep) {
      snap.currentStep = { role: 'agent', content: '', tool_calls: [] };
      snap.steps = snap.steps ?? [];
    }
    return snap.currentStep;
  }

  /** 将当前累积步骤归档到 steps（有实际内容才保留） */
  private pushCurrentStep(snap: SessionSnapshot): void {
    const cs = snap.currentStep;
    if (!cs) return;
    const hasContent = cs.content?.trim() || cs.thinking?.trim() || (cs.tool_calls?.length ?? 0) > 0;
    if (!hasContent) { snap.currentStep = undefined; return; }
    snap.steps = snap.steps ?? [];
    snap.steps.push({ ...cs, tool_calls: (cs.tool_calls ?? []).filter(tc => tc.name || tc.result !== undefined) });
    snap.currentStep = undefined;
  }

  private updateSessionSnapshot(msg: AgentMessage): void {
    const agentId = msg.data?.agentId || msg.data?.agent || msg.from;
    if (!agentId) return;

    // 更新所有匹配 agentId 的活跃会话快照
    for (const session of this.activeSessions.values()) {
      if (session.agentId !== agentId) continue;
      const snap = session.snapshot;
      switch (msg.type) {
        case 'chat.turn.start':
          // 上一轮 assistant + 工具结果已完整 → 归档步骤，开始新轮
          this.pushCurrentStep(snap);
          snap.turnCount++;
          snap.phase = 'idle';
          snap.thinking = '';
          snap.content = '';
          snap.toolCallId = undefined;
          snap.toolName = undefined;
          snap.label = undefined;
          break;
        case 'chat.thinking.start':
          this.ensureStep(snap);
          snap.phase = 'thinking';
          snap.label = msg.data?.label;
          if (snap.currentStep) snap.currentStep.label = msg.data?.label;
          break;
        case 'chat.thinking.update':
          this.ensureStep(snap);
          snap.phase = 'thinking';
          snap.thinking += msg.data?.delta ?? '';
          if (snap.currentStep) snap.currentStep.thinking = (snap.currentStep.thinking ?? '') + (msg.data?.delta ?? '');
          break;
        case 'chat.thinking.end':
          this.ensureStep(snap);
          snap.phase = 'message';
          if (snap.currentStep && msg.data?.label) snap.currentStep.label = msg.data.label;
          break;
        case 'chat.message.start':
          this.ensureStep(snap);
          snap.phase = 'message';
          break;
        case 'chat.message.update':
          this.ensureStep(snap);
          snap.phase = 'message';
          snap.content += msg.data?.delta ?? '';
          if (snap.currentStep) snap.currentStep.content = (snap.currentStep.content ?? '') + (msg.data?.delta ?? '');
          break;
        case 'chat.message.end':
          this.ensureStep(snap);
          snap.phase = 'message';
          const fullContent = msg.data?.content ?? msg.payload;
          if (fullContent !== undefined && fullContent !== '') {
            snap.content = fullContent;
            if (snap.currentStep) snap.currentStep.content = fullContent;
          }
          break;
        case 'chat.message.error':
          snap.phase = 'message';
          snap.content = msg.data?.content ?? msg.payload ?? '';
          snap.error = true;
          break;
        case 'chat.toolcall.start':
          this.ensureStep(snap);
          snap.phase = 'tool';
          snap.toolName = msg.data?.name;
          snap.label = msg.data?.name ? `正在准备工具调用: ${msg.data.name}` : '正在准备工具调用...';
          const sIdx: number = msg.data?.index ?? (snap.currentStep?.tool_calls?.length ?? 0);
          const sc = snap.currentStep!;
          while ((sc.tool_calls?.length ?? 0) <= sIdx) sc.tool_calls!.push({ id: `call_${sc.tool_calls!.length}`, name: '', arguments: {} });
          if (msg.data?.name) sc.tool_calls![sIdx].name = msg.data.name;
          break;
        case 'chat.toolcall.update':
          this.ensureStep(snap);
          snap.phase = 'tool';
          break;
        case 'chat.toolcall.end':
          this.ensureStep(snap);
          snap.phase = 'tool';
          snap.toolName = msg.data?.name ?? snap.toolName;
          const eIdx: number = msg.data?.index;
          if (eIdx !== undefined && snap.currentStep?.tool_calls) {
            const tcs = snap.currentStep.tool_calls;
            while (tcs.length <= eIdx) tcs.push({ id: `call_${tcs.length}`, name: '', arguments: {} });
            if (msg.data?.name) tcs[eIdx].name = msg.data.name;
            if (msg.data?.arguments) tcs[eIdx].arguments = msg.data.arguments;
          }
          break;
        case 'chat.tool_execution.start':
          this.ensureStep(snap);
          snap.phase = 'tool';
          snap.toolCallId = msg.data?.tool_call_id;
          snap.toolName = msg.data?.tool_name;
          snap.label = msg.data?.label;
          if (snap.currentStep?.tool_calls) {
            const tid = msg.data?.tool_call_id;
            const tname = msg.data?.tool_name;
            let tc = snap.currentStep.tool_calls.find((c) => c.id === tid);
            if (!tc) {
              tc = snap.currentStep.tool_calls.find((c) => c.name === tname && c.result === undefined);
              if (!tc) { tc = { id: tid || `call_${snap.currentStep.tool_calls.length}`, name: tname || '', arguments: {} }; snap.currentStep.tool_calls.push(tc); }
              if (tid) tc.id = tid;
            }
            tc.label = msg.data?.label;
          }
          break;
        case 'chat.tool_execution.update':
          snap.phase = 'tool';
          break;
        case 'chat.tool_execution.end':
          snap.phase = 'message';
          if (snap.currentStep?.tool_calls) {
            const tc = snap.currentStep.tool_calls.find((c) => c.id === msg.data?.tool_call_id);
            if (tc) tc.result = msg.payload ?? msg.data?.result ?? '';
          }
          snap.toolCallId = undefined;
          snap.toolName = undefined;
          snap.label = undefined;
          break;
        case 'chat.end':
          this.pushCurrentStep(snap);
          break;
      }
    }
  }

  /**
   * 将 Router 事件广播给所有连接的客户端
   */
  private broadcastRouterEvent(agentMsg: AgentMessage): void {
    const wsData = this.agentMessageToWSData(agentMsg);
    if (!wsData) return;

    // 附加 agentId 到事件数据中（从多种来源推断）
    const agentId = agentMsg.data?.agentId || agentMsg.data?.agent || agentMsg.from;
    if (agentId && !wsData.agentId) {
      wsData.agentId = agentId;
    }

    const payload = buildWSMessage(agentMsg.type, wsData);

    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
      }
    }
  }

  /**
   * 将内部 AgentMessage 转换为 WebSocket 数据
   */
  private agentMessageToWSData(msg: AgentMessage): any | null {
    switch (msg.type) {
      case 'chat.start':
      case 'chat.end':
      case 'chat.turn.start':
      case 'chat.turn.end':
      case 'chat.message.start':
      case 'chat.message.update':
      case 'chat.message.end':
      case 'chat.message.error':
      case 'chat.thinking.start':
      case 'chat.thinking.update':
      case 'chat.thinking.end':
      case 'chat.toolcall.start':
      case 'chat.toolcall.update':
      case 'chat.toolcall.end':
      case 'chat.tool_execution.start':
      case 'chat.tool_execution.update':
      case 'chat.tool_execution.end':
        return msg.data ?? {};
      // 虚拟 Agent 消息实时推送
      case 'chat.virtual.receive':
        return msg.data ?? {};
      default:
        return null;
    }
  }

  /** 向所有已连接客户端广播消息 */
  private broadcastToAll(type: string, data: any): void {
    const payload = buildWSMessage(type, data);
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
      }
    }
  }

  // ============================================================
  // 群组处理器
  // ============================================================

  /** 处理 group.list */
  private async handleGroupList(conn: WSConnection): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_LIST_RESPONSE, { groups: [] }));
      return;
    }
    const groups = this.groupManager.listGroups();
    conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_LIST_RESPONSE, { groups }));
  }

  /** 处理 group.create */
  private async handleGroupCreate(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage('error', { message: 'GroupManager 未初始化' }));
      return;
    }

    const { group_id, name, participants, description } = msg.data;
    if (!group_id || !name || !participants?.length) {
      conn.ws.send(buildWSMessage('error', { message: 'group.create 需要 group_id, name, participants' }));
      return;
    }

    try {
      const group = this.groupManager.createGroup({ group_id, name, participants, description });
      conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_CREATED, { group }));
    } catch (err: any) {
      conn.ws.send(buildWSMessage('error', { message: err.message }));
    }
  }

  /** 处理 group.delete */
  private async handleGroupDelete(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage('error', { message: 'GroupManager 未初始化' }));
      return;
    }
    const { group_id } = msg.data;
    const ok = this.groupManager.deleteGroup(group_id);
    conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_DELETED, { group_id, success: ok }));
  }

  /** 处理 group.join */
  private async handleGroupJoin(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage('error', { message: 'GroupManager 未初始化' }));
      return;
    }
    const { group_id, agent_id } = msg.data;
    const ok = this.groupManager.joinGroup(group_id, agent_id);
    if (!ok) {
      conn.ws.send(buildWSMessage('error', { message: `加入群组 "${group_id}" 失败` }));
      return;
    }
    const group = this.groupManager.getGroup(group_id);
    conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_JOIN, { group_id, agent_id, group }));
  }

  /** 处理 group.leave */
  private async handleGroupLeave(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage('error', { message: 'GroupManager 未初始化' }));
      return;
    }
    const { group_id, agent_id } = msg.data;
    const ok = this.groupManager.leaveGroup(group_id, agent_id);
    conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_LEAVE, { group_id, agent_id, success: ok }));
  }

  /** 处理 group.message —— 用户通过 WebUI 向群组发送消息 */
  private async handleGroupMessage(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage('error', { message: 'GroupManager 未初始化' }));
      return;
    }
    const { group_id, content, from } = msg.data;
    if (!group_id || !content) {
      conn.ws.send(buildWSMessage('error', { message: 'group.message 需要 group_id, content' }));
      return;
    }

    const sender = from || getGlobalConfig().viewerId;
    const correlationId = `webui-group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = await this.groupManager.deliverGroupMessage({
        from: sender,
        to: '*',
        type: 'group.message',
        payload: content,
        correlation_id: correlationId,
        group_id,
        data: { content },
      });
      // 仅发送投递确认（不重复发送消息内容，group.message 事件已广播到所有客户端）
      conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_DELIVERED, {
        group_id,
        correlation_id: correlationId,
        triggered: result.triggered,
      }));
    } catch (err: any) {
      conn.ws.send(buildWSMessage('error', { message: err.message }));
    }
  }

  /** 处理 group.history.request */
  private async handleGroupHistoryRequest(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupManager) {
      conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_HISTORY_RESPONSE, { messages: [] }));
      return;
    }
    const { group_id, limit, offset } = msg.data;
    const messages = this.groupManager.readGroupHistory(group_id, limit ?? 50, offset ?? 0);
    conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_HISTORY_RESPONSE, { group_id, messages }));
  }
}
