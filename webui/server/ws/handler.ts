// ============================================================
// WebSocket 连接管理器
// 管理前端 WS 连接，处理入站/出站消息
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

  /** 每个连接+目标Agent 的活跃 AbortController（用于软中断） */
  private activeSessions = new Map<string, AbortController>();

  constructor(options: WSHandlerOptions) {
    this.router = options.router;
    this.registry = options.registry;
    this.messageQuery = options.messageQuery;

    // 监听 Router 事件，推送到所有连接的客户端
    this.router.on('message', (msg: AgentMessage) => {
      this.broadcastRouterEvent(msg);
    });
  }

  /** 生成会话键 */
  private sessionKey(connId: string, agentId: string): string {
    return `${connId}:${agentId}`;
  }

  /** 中断指定连接的指定 Agent 会话 */
  private abortSession(connId: string, agentId: string): boolean {
    const key = this.sessionKey(connId, agentId);
    const controller = this.activeSessions.get(key);
    if (controller) {
      console.log(`[WS] 中断会话：${key}`);
      controller.abort();
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

    // 连接关闭
    ws.on('close', () => {
      // 清理该连接的所有活跃会话
      for (const [key, controller] of this.activeSessions) {
        if (key.startsWith(connId + ':')) {
          controller.abort();
          this.activeSessions.delete(key);
        }
      }
      this.connections.delete(connId);
      console.log(`[WS] 客户端已断开：${connId}（共 ${this.connections.size} 个）`);
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
   * 支持软中断：若该连接+Agent已有活跃会话，先中断再开始新会话
   */
  private async handleChatSend(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to, content, attachments, files, deepThink } = msg.data;

    if (!to || (!content && !files?.length)) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.send 需要提供 "to" 和 "content"' }));
      return;
    }

    // 中断该连接+Agent的已有活跃会话
    const wasAborted = this.abortSession(conn.id, to);
    if (wasAborted) {
      console.log(`[WS] ${conn.id} 中断了 ${to} 的活跃会话以开始新会话`);
      // 发送中断通知给前端
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_INTERRUPTED, {
        agentId: to,
        reason: 'new_message',
      }));
    }

    const correlationId = `webui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 创建新的 AbortController
    const abortController = new AbortController();
    const sessionKey = this.sessionKey(conn.id, to);
    this.activeSessions.set(sessionKey, abortController);

    // 处理附件引用（兼容旧字段 attachments 和新字段 files）
    const fileList = files ?? attachments ?? [];
    let payload = content;
    if (fileList.length > 0) {
      const fileRefs = fileList
        .map((a: any) => `./data/files/${a.hash}`)
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
      // 通过 Router 发送（Agent 内部通过注入的 EventBus 直接发射流式事件）
      await this.router.send(agentMsg, abortController.signal);
    } finally {
      // 仅当 activeSessions 中仍是当前 controller 时才清理（防止误删新会话）
      if (this.activeSessions.get(sessionKey) === abortController) {
        this.activeSessions.delete(sessionKey);
      }
    }
  }

  /**
   * 处理 chat.interrupt → 显式中断当前会话
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
   * 处理 agent.list 请求
   */
  private async handleAgentList(conn: WSConnection): Promise<void> {
    const ids = this.registry.listIds().filter((id: string) => !this.registry.isVirtual(id));
    const agents = await Promise.all(
      ids.map(async (id: string) => {
        const agent = this.registry.getAgent(id);
        // 查询该 Agent 与 user 的最后一条消息
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
        // 最近活动时间戳（用于排序），无消息则为 0
        const lastActivity = lastMsg ? new Date(lastMsg.timestamp).getTime() : 0;
        return {
          id,
          name: this.registry.getAgentName(id),
          description: agent?.systemPrompt?.slice(0, 100) ?? '',
          lastMessage,
          lastActivity,
        };
      })
    );

    // 按最近活动时间降序排列：最近聊过的在上面
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
   * 将 Router 事件广播给所有连接的客户端
   */
  private broadcastRouterEvent(agentMsg: AgentMessage): void {
    const wsData = this.agentMessageToWSData(agentMsg);
    if (!wsData) return;

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
      case 'chat.response.start':
        return msg.data;
      case 'chat.response.chunk':
        return msg.data;
      case 'chat.response.done':
        return msg.data;
      case 'chat.thinking.start':
        return msg.data;
      case 'chat.thinking.chunk':
        return msg.data;
      case 'chat.thinking.done':
        return msg.data;
      case 'chat.tool.start':
        return msg.data;
      case 'chat.tool.done':
        return msg.data;
      case 'chat.interrupted':
        return msg.data;
      default:
        return null;
    }
  }
}
