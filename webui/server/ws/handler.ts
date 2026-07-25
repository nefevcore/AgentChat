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
import { AgentRegistry } from '@routing/registry';
import { IMessageQuery } from '@routing/message-query';
import { RoomManager } from '@routing/room-manager';
import { AgentMessage } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { parseWSMessage, buildWSMessage, WSMessageTypes, WSMessage } from './protocol';
import { idleArchive } from '@global/extensions/agent-session/idle-timer';
import { markMemoryUpdateNeeded, forceUpdateMemory } from '@global/extensions/agent-memory/memory';
import { deleteFromJSONL } from '@global/extensions/agent-session/history';

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
}

export interface WSHandlerOptions {
  router: AgentRouter;
  registry: AgentRegistry;
  messageQuery: IMessageQuery;
  roomManager?: RoomManager;
}

export class WSHandler {
  private router: AgentRouter;
  private registry: AgentRegistry;
  private messageQuery: IMessageQuery;
  private roomManager: RoomManager | null;
  private connections = new Map<string, WSConnection>();

  /** 活跃会话：connId:agentId → ActiveSession（按连接隔离） */
  private activeSessions = new Map<string, ActiveSession>();

  constructor(options: WSHandlerOptions) {
    this.router = options.router;
    this.registry = options.registry;
    this.messageQuery = options.messageQuery;
    this.roomManager = options.roomManager ?? null;

    // 监听 Router 事件，推送到所有连接的客户端 + 更新会话快照
    this.router.on('message', (msg: AgentMessage) => {
      this.updateSessionSnapshot(msg);
      this.broadcastRouterEvent(msg);
    });

    // 监听 RoomManager 事件，推送房间消息到前端
    if (this.roomManager) {
      this.roomManager.on('room.message', (msg: AgentMessage) => {
        this.broadcastToAll(WSMessageTypes.ROOM_MESSAGE, {
          room_id: msg.room_id,
          from: msg.from,
          payload: msg.payload,
          correlation_id: msg.correlation_id,
          data: msg.data,
        });
      });

      this.roomManager.on('room.created', (room) => {
        this.broadcastToAll(WSMessageTypes.ROOM_CREATED, { room });
      });

      this.roomManager.on('room.deleted', (info) => {
        this.broadcastToAll(WSMessageTypes.ROOM_DELETED, info);
      });
    }
  }

  /** 生成会话键 */
  private sessionKey(connId: string, agentId: string): string {
    return `${connId}:${agentId}`;
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
      console.log(`[WS] 中断会话：${agentId}（连接 ${connId}）`);
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
    console.log(`[WS] 客户端已连接：${connId}（共 ${this.connections.size} 个）`);

    // 处理前端发来的消息
    ws.on('message', (raw: WebSocket.Data) => {
      this.handleIncoming(conn, raw.toString());
    });

    // 连接关闭 —— 不中断 Agent 会话，Agent 继续在后台执行
    ws.on('close', () => {
      this.connections.delete(connId);
      console.log(`[WS] 客户端已断开：${connId}（共 ${this.connections.size} 个，活跃会话 ${this.activeSessions.size} 个）`);
    });

    // 错误处理
    ws.on('error', (err) => {
      console.error(`[WS] Error on ${connId}: ${err.message}`);
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

    console.log(`[WS] ← ${conn.id}: ${msg.type}`);

    switch (msg.type) {
      case WSMessageTypes.CHAT_SEND:
        await this.handleChatSend(conn, msg);
        break;

      case WSMessageTypes.CHAT_INTERRUPT:
        await this.handleChatInterrupt(conn, msg);
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

      // ---- 群聊类 ----
      case WSMessageTypes.ROOM_LIST:
        await this.handleRoomList(conn);
        break;

      case WSMessageTypes.ROOM_CREATE:
        await this.handleRoomCreate(conn, msg);
        break;

      case WSMessageTypes.ROOM_DELETE:
        await this.handleRoomDelete(conn, msg);
        break;

      case WSMessageTypes.ROOM_JOIN:
        await this.handleRoomJoin(conn, msg);
        break;

      case WSMessageTypes.ROOM_LEAVE:
        await this.handleRoomLeave(conn, msg);
        break;

      case WSMessageTypes.ROOM_MESSAGE:
        await this.handleRoomMessage(conn, msg);
        break;

      case WSMessageTypes.ROOM_HISTORY_REQUEST:
        await this.handleRoomHistoryRequest(conn, msg);
        break;

      case WSMessageTypes.SESSION_ARCHIVE:
        await this.handleSessionArchive(conn, msg);
        break;

      case WSMessageTypes.CHAT_DELETE_MESSAGE:
        await this.handleDeleteMessage(conn, msg);
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
      if (agent) {
        agent.steer({ role: 'user', content: payload, agent_id: 'user' });
        console.log(`[WS] ${conn.id} 向 ${to} 注入转向消息: "${content.slice(0, 40)}"`);
      }
      return;
    }

    // 该连接下 Agent 空闲 → 启动新会话
    const correlationId = `webui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const abortController = new AbortController();
    const snapshot: SessionSnapshot = { phase: 'idle', thinking: '', content: '', turnCount: 0 };
    const session: ActiveSession = { controller: abortController, agentId: to, connId: conn.id, snapshot };
    this.activeSessions.set(sessionKey, session);

    const agentMsg: AgentMessage = {
      from: 'user',
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

    console.log(`[WS] ${conn.id} 显式中断了 ${to} 的会话（活跃=${wasAborted}）`);
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
          from: 'user',
          to: id,
          limit: 1,
        });
        const lastMsg = lastMessages[0] ?? null;
        const lastMessage = lastMsg
          ? {
              role: lastMsg.role,
              content: typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 80) : '',
              timestamp: lastMsg.timestamp,
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

    agents.sort((a, b) => b.lastActivity - a.lastActivity);
    conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_LIST_RESPONSE, { agents }));
  }

  /**
   * 处理 history.request
   */
  private async handleHistoryRequest(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { from, to, limit, offset } = msg.data;
    const messages = await this.messageQuery.query({ from, to, limit, offset });
    conn.ws.send(buildWSMessage(WSMessageTypes.HISTORY_RESPONSE, { messages }));
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

    const snapshot = this.getSessionSnapshot(conn.id, to);
    if (!snapshot) {
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_SESSION_RESUME, {
        agentId: to,
        active: false,
      }));
      return;
    }

    conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_SESSION_RESUME, {
      agentId: to,
      active: true,
      ...snapshot,
    }));
    console.log(`[WS] ${conn.id} 订阅了 ${to} 的活跃会话（phase=${snapshot.phase}）`);
  }

  /**
   * 处理 session.archive → 手动归档消息并标记记忆更新
   */
  private async handleSessionArchive(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { agent, counterpart } = msg.data;
    if (!agent || !counterpart) {
      conn.ws.send(buildWSMessage('error', { message: 'session.archive 需要提供 "agent" 和 "counterpart"' }));
      return;
    }

    try {
      // 1. 归档消息：移入 archive/，按 keepRecentRatio 保留近期消息重建
      idleArchive(agent, counterpart);

      // 2. 标记记忆更新并立即触发 LLM 重写
      markMemoryUpdateNeeded(agent, counterpart);

      const agentInstance = this.registry.getAgent(agent);
      if (agentInstance?.llmProvider) {
        await forceUpdateMemory(agent, counterpart, agentInstance.llmProvider);
      } else {
        console.log(`[WS] ${conn.id} Agent ${agent} 无 LLM 实例，跳过记忆更新`);
      }

      console.log(`[WS] ${conn.id} 手动归档会话：${agent} ↔ ${counterpart}`);

      conn.ws.send(buildWSMessage(WSMessageTypes.SESSION_ARCHIVED, {
        agent,
        counterpart,
        success: true,
      }));
    } catch (err: any) {
      console.error(`[WS] 归档会话失败 (${agent}/${counterpart}): ${err.message}`);
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
    console.log(`[WS] ${conn.id} 删除消息: ${agent}/${counterpart} msg=${messageId} → ${ok ? '成功' : '未找到'}`);

    conn.ws.send(buildWSMessage('chat.message.deleted', {
      agent,
      counterpart,
      messageId,
      success: ok,
    }));
  }

  /**
   * 根据 Router 事件更新会话快照（匹配所有同 agentId 的会话）
   */
  private updateSessionSnapshot(msg: AgentMessage): void {
    const agentId = msg.data?.agentId || msg.data?.agent || msg.from;
    if (!agentId) return;

    // 更新所有匹配 agentId 的活跃会话快照
    for (const session of this.activeSessions.values()) {
      if (session.agentId !== agentId) continue;
      const snap = session.snapshot;
      switch (msg.type) {
        case 'chat.turn.start':
          snap.turnCount++;
          snap.phase = 'idle';
          snap.thinking = '';
          snap.content = '';
          snap.toolCallId = undefined;
          snap.toolName = undefined;
          snap.label = undefined;
          break;
        case 'chat.thinking.start':
          snap.phase = 'thinking';
          snap.label = msg.data?.label;
          break;
        case 'chat.thinking.update':
          snap.phase = 'thinking';
          snap.thinking += msg.data?.delta ?? '';
          break;
        case 'chat.thinking.end':
          snap.phase = 'message';
          break;
        case 'chat.message.start':
          snap.phase = 'message';
          break;
        case 'chat.message.update':
          snap.phase = 'message';
          snap.content += msg.data?.delta ?? '';
          break;
        case 'chat.message.end':
          snap.phase = 'message';
          if (msg.data?.content) snap.content = msg.data.content;
          break;
        case 'chat.message.error':
          snap.phase = 'message';
          snap.content = msg.data?.content ?? msg.payload ?? '';
          snap.error = true;
          break;
        case 'chat.toolcall.start':
          snap.phase = 'tool';
          snap.toolName = msg.data?.name;
          snap.label = msg.data?.name ? `正在准备工具调用: ${msg.data.name}` : '正在准备工具调用...';
          break;
        case 'chat.toolcall.update':
          snap.phase = 'tool';
          break;
        case 'chat.toolcall.end':
          snap.phase = 'tool';
          snap.toolName = msg.data?.name ?? snap.toolName;
          break;
        case 'chat.tool_execution.start':
          snap.phase = 'tool';
          snap.toolCallId = msg.data?.tool_call_id;
          snap.toolName = msg.data?.tool_name;
          snap.label = msg.data?.label;
          break;
        case 'chat.tool_execution.update':
          snap.phase = 'tool';
          break;
        case 'chat.tool_execution.end':
          snap.phase = 'message';
          snap.toolCallId = undefined;
          snap.toolName = undefined;
          snap.label = undefined;
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
  // 群聊房间处理器
  // ============================================================

  /** 处理 room.list */
  private async handleRoomList(conn: WSConnection): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_LIST_RESPONSE, { rooms: [] }));
      return;
    }
    const rooms = this.roomManager.listRooms();
    conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_LIST_RESPONSE, { rooms }));
  }

  /** 处理 room.create */
  private async handleRoomCreate(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage('error', { message: 'RoomManager 未初始化' }));
      return;
    }

    const { room_id, name, participants, description } = msg.data;
    if (!room_id || !name || !participants?.length) {
      conn.ws.send(buildWSMessage('error', { message: 'room.create 需要 room_id, name, participants' }));
      return;
    }

    try {
      const room = this.roomManager.createRoom({ room_id, name, participants, description });
      conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_CREATED, { room }));
    } catch (err: any) {
      conn.ws.send(buildWSMessage('error', { message: err.message }));
    }
  }

  /** 处理 room.delete */
  private async handleRoomDelete(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage('error', { message: 'RoomManager 未初始化' }));
      return;
    }
    const { room_id } = msg.data;
    const ok = this.roomManager.deleteRoom(room_id);
    conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_DELETED, { room_id, success: ok }));
  }

  /** 处理 room.join */
  private async handleRoomJoin(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage('error', { message: 'RoomManager 未初始化' }));
      return;
    }
    const { room_id, agent_id } = msg.data;
    const ok = this.roomManager.joinRoom(room_id, agent_id);
    if (!ok) {
      conn.ws.send(buildWSMessage('error', { message: `加入房间 "${room_id}" 失败` }));
      return;
    }
    const room = this.roomManager.getRoom(room_id);
    conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_JOIN, { room_id, agent_id, room }));
  }

  /** 处理 room.leave */
  private async handleRoomLeave(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage('error', { message: 'RoomManager 未初始化' }));
      return;
    }
    const { room_id, agent_id } = msg.data;
    const ok = this.roomManager.leaveRoom(room_id, agent_id);
    conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_LEAVE, { room_id, agent_id, success: ok }));
  }

  /** 处理 room.message —— 用户通过 WebUI 向房间发送消息 */
  private async handleRoomMessage(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage('error', { message: 'RoomManager 未初始化' }));
      return;
    }
    const { room_id, content, from } = msg.data;
    if (!room_id || !content) {
      conn.ws.send(buildWSMessage('error', { message: 'room.message 需要 room_id, content' }));
      return;
    }

    const sender = from || 'user';
    const correlationId = `webui-room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = this.roomManager.deliverRoomMessage({
        from: sender,
        to: '*',
        type: 'room.message',
        payload: content,
        correlation_id: correlationId,
        room_id,
        data: { content },
      });
      // 仅发送投递确认（不重复发送消息内容，room.message 事件已广播到所有客户端）
      conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_DELIVERED, {
        room_id,
        correlation_id: correlationId,
        delivered_to: result.delivered_to,
      }));
    } catch (err: any) {
      conn.ws.send(buildWSMessage('error', { message: err.message }));
    }
  }

  /** 处理 room.history.request */
  private async handleRoomHistoryRequest(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.roomManager) {
      conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_HISTORY_RESPONSE, { messages: [] }));
      return;
    }
    const { room_id, limit, offset } = msg.data;
    const messages = this.roomManager.readRoomHistory(room_id, limit ?? 50, offset ?? 0);
    conn.ws.send(buildWSMessage(WSMessageTypes.ROOM_HISTORY_RESPONSE, { room_id, messages }));
  }
}
