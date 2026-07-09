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
import { AgentRouter } from '../../../src/routing/router';
import { AgentRegistry } from '../../../src/routing/registry';
import { IMessageQuery } from '../../../src/routing/message-query';
import { AgentMessage } from '../../../src/core/types';
import { parseWSMessage, buildWSMessage, WSMessageTypes, WSMessage } from './protocol';

/**
 * 单个 WebSocket 连接
 */
interface WSConnection {
  ws: WebSocket;
  id: string;
  connectedAt: Date;
}

/**
 * 活跃会话（按 Agent 维度，与 WS 连接解耦）
 */
interface ActiveSession {
  controller: AbortController;
  agentId: string;
  /** 当前会话状态快照（用于重连客户端恢复 UI 状态） */
  snapshot: SessionSnapshot;
}

/**
 * 会话状态快照 —— 重连时发送给客户端以重建 UI
 */
interface SessionSnapshot {
  phase: 'idle' | 'thinking' | 'message' | 'tool';
  thinking: string;
  content: string;
  turnCount: number;
  toolCallId?: string;
  toolName?: string;
  label?: string;
}

export interface WSHandlerOptions {
  router: AgentRouter;
  registry: AgentRegistry;
  messageQuery: IMessageQuery;
}

export class WSHandler {
  private router: AgentRouter;
  private registry: AgentRegistry;
  private messageQuery: IMessageQuery;
  private connections = new Map<string, WSConnection>();

  /** 活跃会话：agentId → ActiveSession（与 WS 连接无关） */
  private activeSessions = new Map<string, ActiveSession>();

  constructor(options: WSHandlerOptions) {
    this.router = options.router;
    this.registry = options.registry;
    this.messageQuery = options.messageQuery;

    // 监听 Router 事件，推送到所有连接的客户端 + 更新会话快照
    this.router.on('message', (msg: AgentMessage) => {
      this.updateSessionSnapshot(msg);
      this.broadcastRouterEvent(msg);
    });
  }

  /** 检查指定 Agent 是否有活跃会话 */
  hasActiveSession(agentId: string): boolean {
    return this.activeSessions.has(agentId);
  }

  /** 获取会话快照 */
  getSessionSnapshot(agentId: string): SessionSnapshot | null {
    return this.activeSessions.get(agentId)?.snapshot ?? null;
  }

  /** 中断指定 Agent 的活跃会话（全局维度） */
  private abortSession(agentId: string): boolean {
    const session = this.activeSessions.get(agentId);
    if (session) {
      console.log(`[WS] 中断会话：${agentId}`);
      session.controller.abort();
      this.activeSessions.delete(agentId);
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

      default:
        conn.ws.send(buildWSMessage('error', { message: `未知的消息类型：${msg.type}` }));
    }
  }

  /**
   * 处理 chat.send → 路由消息到目标 Agent
   * 按 agentId 中断已有活跃会话（无论来自哪个连接），然后开始新会话
   */
  private async handleChatSend(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to, content, attachments, files, deepThink } = msg.data;

    if (!to || (!content && !files?.length)) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.send 需要提供 "to" 和 "content"' }));
      return;
    }

    // 中断该 Agent 的已有活跃会话（全局维度，不限连接）
    const wasAborted = this.abortSession(to);
    if (wasAborted) {
      console.log(`[WS] ${conn.id} 中断了 ${to} 的活跃会话以开始新会话`);
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_INTERRUPTED, {
        agentId: to,
        reason: 'new_message',
      }));
    }

    const correlationId = `webui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 创建新的 AbortController 与会话快照
    const abortController = new AbortController();
    const snapshot: SessionSnapshot = { phase: 'idle', thinking: '', content: '', turnCount: 0 };
    const session: ActiveSession = { controller: abortController, agentId: to, snapshot };
    this.activeSessions.set(to, session);

    // 处理附件引用（兼容旧字段 attachments 和新字段 files）
    const fileList = files ?? attachments ?? [];
    let payload = content;
    if (fileList.length > 0) {
      const fileRefs = fileList
        .map((a: any) => `./files/${a.hash}`)
        .join(', ');
      payload = `${content}\n\n[用户上传了文件：${fileRefs}]`;
    }

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
      // 仅当 activeSessions 中仍是当前 session 时才清理（防止误删新会话）
      if (this.activeSessions.get(to) === session) {
        this.activeSessions.delete(to);
      }
    }
  }

  /**
   * 处理 chat.interrupt → 显式中断指定 Agent 的当前会话
   */
  private async handleChatInterrupt(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to } = msg.data;
    if (!to) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.interrupt 需要提供 "to"' }));
      return;
    }

    const wasAborted = this.abortSession(to);
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
   * 处理 chat.subscribe → 客户端请求订阅某 Agent 的活跃会话（重连场景）
   * 回复 chat.session.resume 包含当前会话快照，客户端据此重建 UI 状态
   */
  private async handleChatSubscribe(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to } = msg.data;
    if (!to) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.subscribe 需要提供 "to"' }));
      return;
    }

    const snapshot = this.getSessionSnapshot(to);
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
   * 根据 Router 事件更新会话快照（用于重连客户端恢复 UI）
   */
  private updateSessionSnapshot(msg: AgentMessage): void {
    // 从消息中提取 agentId
    const agentId = msg.data?.agentId || msg.data?.agent || msg.from;
    if (!agentId) return;
    const session = this.activeSessions.get(agentId);
    if (!session) return;

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
        snap.phase = 'message'; // thinking 结束后进入 message 阶段
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
      case 'chat.tool_execution.end':
        snap.phase = 'message'; // tool 结束后回到 message 阶段（准备下一 turn）
        snap.toolCallId = undefined;
        snap.toolName = undefined;
        snap.label = undefined;
        break;
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
      case 'chat.thinking.start':
      case 'chat.thinking.update':
      case 'chat.thinking.end':
      case 'chat.toolcall.start':
      case 'chat.toolcall.update':
      case 'chat.toolcall.end':
      case 'chat.tool_execution.start':
      case 'chat.tool_execution.end':
        return msg.data ?? {};
      default:
        return null;
    }
  }
}
