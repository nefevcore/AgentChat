// ============================================================
// WebSocket 连接管理器
// 管理前端 WS 连接，处理入站/出站消息
//
// 会话生命周期：
//   · Agent 会话与 WS 连接解耦 —— 关闭页面不会中断 Agent 执行
//   · 用户发送新消息时，按 agentId 中断旧会话（无论来自哪个连接）
//   · 重连时可通过 chat.subscribe 接上正在进行的流式输出
// ============================================================

import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@agentchat/util';
const logger = createLogger('[server:ws]');
import { RPCBridge, parseRPCMessage, buildRPCSuccess, buildRPCError } from '../rpc';
import { HistoryService } from '../index';
import { GroupService } from '../group-service';
import { configService } from '../config-service';
import { AgentService } from '../agent-service';
import { getInteractionBridge } from '../interactions';
import { getRouter, getRegistry, getGroupManager, requestRestart } from '../runtime';
import type { AgentRouter, AgentRegistry, GroupManager, RouterMessage } from '../runtime';
import { parseWSMessage, buildWSMessage, WSMessageTypes } from './protocol';
import type { WSMessage } from './protocol';
import { PluginEventBus } from '../plugin-events';
import { PLUGIN_EVENT } from '@agentchat/protocol';

/**
 * 单个 WebSocket 连接
 */
interface WSConnection {
  ws: WebSocket;
  id: string;
  connectedAt: Date;
  /** 心跳存活标记：每轮 ping 前置 false，收到 pong 置 true；超时未回 pong 判定为半死连接并清理 */
  isAlive: boolean;
}

/**
 * 活跃会话（按连接+Agent 维度，与 WS 连接解耦但隔离不同连接）
 */
interface ActiveSession {
  controller: AbortController;
  agentId: string;
  /** 所属连接的 ID */
  connId: string;
  /** 会话对方（sender，用于 steer 按会话路由，会话级并行用） */
  sender: string;
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
  messageQuery: HistoryService;
  /** 工作区 dataDir，用于持久化幂等去重缓存（跨重启） */
  dataDir?: string;
  /** RPC 桥（v0.5.0 P5：JSON-RPC over WS，入站 type=rpc 走此分发） */
  rpc?: RPCBridge;
  /** 历史/归档服务（v0.5.0 审查修复：webui 只 import services） */
  historyService?: HistoryService;
  /** Agent 管理服务（v0.5.0 收敛：System Prompt/工具定义预览走服务，不直连 @core/agent） */
  agentService?: AgentService;
  /** 群组门面（历史读取走服务；新架构 GroupManager 纯内存无 fs） */
  groupService?: GroupService;
  /** 插件域事件总线（订阅 catalog.changed/reload/assembly.changed 广播前端） */
  pluginEvents?: PluginEventBus;
}

export class WSHandler {
  private router: AgentRouter;
  private registry: AgentRegistry;
  private messageQuery: HistoryService;
  private groupManager: GroupManager | null = null;
  private rpc: RPCBridge | null = null;
  private historyService: HistoryService | null = null;
  private agentService: AgentService | null = null;
  private groupService: GroupService | null = null;
  private connections = new Map<string, WSConnection>();
  /** 插件域事件订阅 disposer（stop 时撤销） */
  private pluginEventDisposers: Array<() => void> = [];

  /** 心跳间隔（ms）：周期 ping 保活 + 清理半死连接（防长时间闲置被中间设备掐断 / 僵尸连接堆积） */
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
   * 窗口 30s：覆盖 WS 重连延迟 + 用户无意重发间隔（实测 12s/21s 为主），
   * 同时 30s 内发送完全相同内容大概率是重复，可安全忽略。
   * 30s 为折中：60s 对复读机/刷屏场景过宽（用户反馈），
   * 8s 又盖不住 WS 重连后的 flush 重发。
   *
   * v0.4.2 持久化：缓存写入 workspace 文件，重启后加载。
   * 后端重启（Supervisor 拉起）时若内存缓存丢失，重启后用户重发同内容
   * 会绕过窗口 → 重复持久化。持久化使去重跨重启生效。
   */
  private recentChatSends = new Map<string, number>();
  private static readonly CHAT_SEND_DEDUP_MS = 30000;
  /** 去重缓存持久化路径（dataDir/.chat_send_dedup.json） */
  private dedupStorePath: string | null = null;
  private dedupFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WSHandlerOptions) {
    // v0.5.0 收敛：Router/Registry/GroupManager 经 services/runtime 门面获取
    // （webui/server 只 import services，设计文档 7.1）
    this.router = getRouter();
    this.registry = getRegistry();
    this.messageQuery = options.messageQuery;
    this.groupManager = getGroupManager();
    this.rpc = options.rpc ?? null;
    this.historyService = options.historyService ?? null;
    this.agentService = options.agentService ?? null;
    this.groupService = options.groupService ?? null;

    // 持久化幂等去重缓存：重启后加载，避免重复投递绕过 8s 窗口
    if (options.dataDir) {
      try {
        this.dedupStorePath = path.join(options.dataDir, '.chat_send_dedup.json');
        if (fs.existsSync(this.dedupStorePath)) {
          const raw = JSON.parse(fs.readFileSync(this.dedupStorePath, 'utf-8')) as Record<string, number>;
          const now = Date.now();
          for (const [k, t] of Object.entries(raw)) {
            if (now - t < WSHandler.CHAT_SEND_DEDUP_MS) {
              this.recentChatSends.set(k, t);
            }
          }
          if (this.recentChatSends.size > 0) {
            logger.info(`[WS] 已加载 ${this.recentChatSends.size} 条 chat.send 去重记录（跨重启）`);
          }
        }
      } catch (err: any) {
        logger.warn(`[WS] 加载去重缓存失败: ${err.message}`);
      }
    }

    // 监听 Router 事件，推送到所有连接的客户端 + 更新会话快照
    this.router.on('message', (msg: RouterMessage) => {
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

    // 监听 GroupManager 事件，推送群组消息到前端（新架构事件名 group.message.received）
    if (this.groupManager) {
      this.groupManager.on('group.message.received', (msg: RouterMessage) => {
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

    // 插件域事件（P1：UI/Web 插件化）→ 经现有 message 通道广播
    const pluginEvents = options.pluginEvents;
    if (pluginEvents) {
      this.pluginEventDisposers.push(pluginEvents.on(PLUGIN_EVENT.CATALOG_CHANGED, (data) => {
        this.broadcastToAll(PLUGIN_EVENT.CATALOG_CHANGED, data);
      }));
      this.pluginEventDisposers.push(pluginEvents.on(PLUGIN_EVENT.RELOAD, (data) => {
        this.broadcastToAll(PLUGIN_EVENT.RELOAD, data);
      }));
      this.pluginEventDisposers.push(pluginEvents.on(PLUGIN_EVENT.ASSEMBLY_CHANGED, (data) => {
        this.broadcastToAll(PLUGIN_EVENT.ASSEMBLY_CHANGED, data);
      }));
      this.pluginEventDisposers.push(pluginEvents.on(PLUGIN_EVENT.UI_EXTENSIONS_CHANGED, (data) => {
        this.broadcastToAll(PLUGIN_EVENT.UI_EXTENSIONS_CHANGED, data);
      }));
    }

    // 监听交互事件（ask_questions 决策工具）→ 广播前端弹窗
    this.router.on('chat.interaction', (data: Record<string, any>) => {
      this.broadcastToAll(WSMessageTypes.CHAT_INTERACTION, data);
      logger.info(`[WS] 广播交互弹窗: ${data.interaction_id} (${data.agent_id})`);
    });

    // 启动 WS 心跳：周期 ping 保活 + 清理半死连接
    this.startHeartbeat();
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
  private trackAndCheckTriggerSession(msg: RouterMessage): boolean {
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
    const agentsDir = configService.getGlobalConfig().agentsDir;
    // 热重载后的全局配置若缺派生路径，fs/path 会抛
    // "path argument must be of type string" —— 降级返回无头像，不阻断 agent.list。
    if (typeof agentsDir !== 'string' || !fs.existsSync(agentsDir)) return null;

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
      isAlive: true,
    };

    this.connections.set(connId, conn);
    logger.info(`[WS] 客户端已连接：${connId}（共 ${this.connections.size} 个）`);

    // 处理前端发来的消息 —— 必须 catch：handleIncoming 是 async，
    // 任何未捕获 rejection 都可能触发进程级 unhandledRejection 终止（ELIFECYCLE -1）。
    ws.on('message', (raw: WebSocket.Data) => {
      this.handleIncoming(conn, raw.toString()).catch((err: any) => {
        logger.error(`[WS] 入站消息处理失败（${conn.id}）: ${err?.message ?? String(err)}`);
        if (err?.stack) logger.error(err.stack);
        try {
          conn.ws.send(buildWSMessage('error', { message: `处理失败: ${err?.message ?? String(err)}` }));
        } catch { /* 连接可能已关闭 */ }
      });
    });

    // 心跳：收到协议层 Pong 帧视为连接存活（浏览器端自动回复，无需前端代码）
    ws.on('pong', () => {
      conn.isAlive = true;
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
   * 启动 WS 心跳：周期向所有连接发送 ping（协议层保活，防中间设备/NAT 空闲超时），
   * 并清理超过一个周期未回复 pong 的半死连接（如网络 RST 后未触发 close 的僵尸连接）。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [connId, conn] of this.connections) {
        if (conn.ws.readyState !== WebSocket.OPEN) continue;
        if (!conn.isAlive) {
          // 上一轮 ping 未收到 pong → 半死连接，强制清理（terminate 会触发 close 事件清理收尾）
          logger.warn(`[WS] 心跳超时，清理半死连接：${connId}`);
          try { conn.ws.terminate(); } catch { /* ignore */ }
          this.connections.delete(connId);
          continue;
        }
        conn.isAlive = false;
        try { conn.ws.ping(); } catch { /* ignore */ }
      }
    }, WSHandler.HEARTBEAT_INTERVAL_MS);
    // 不阻止进程退出（Supervisor 重启 / stop() 场景）
    this.heartbeatTimer.unref?.();
  }

  /** 停止心跳定时器（服务器关闭时调用） */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const dispose of this.pluginEventDisposers.splice(0)) {
      dispose();
    }
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

    // ---- RPC 分支（v0.5.0 P5）：type=rpc 时走 JSON-RPC 分发 ----
    if (msg.type === 'rpc') {
      if (!this.rpc) {
        conn.ws.send(buildRPCError((msg.data as any)?.id ?? null, -32601, 'RPC 桥未初始化'));
        return;
      }
      // WS 消息格式 { type:'rpc', data:{ method, params, id } }——从 data 提取 RPC 字段
      const rpcMsg = {
        type: 'rpc',
        method: (msg.data as any)?.method,
        params: (msg.data as any)?.params,
        id: (msg.data as any)?.id ?? null,
      };
      const parsed = parseRPCMessage(rpcMsg);
      if (!parsed) {
        conn.ws.send(buildRPCError(null, -32600, '无效的 RPC 消息'));
        return;
      }
      try {
        const result = await this.rpc.call(parsed.method, parsed.params);
        conn.ws.send(buildRPCSuccess(parsed.id, result));
      } catch (err: any) {
        conn.ws.send(buildRPCError(parsed.id, err?.code ?? -32603, err?.message ?? String(err)));
      }
      return;
    }

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

      case WSMessageTypes.SYSTEM_RESTART:
        await this.handleSystemRestart(conn);
        break;

      // 交互响应（ask_questions 决策）
      case WSMessageTypes.CHAT_INTERACT_RESPOND:
        await this.handleInteractRespond(conn, msg);
        break;

      default:
        conn.ws.send(buildWSMessage('error', { message: `未知的消息类型：${msg.type}` }));
    }
  }

  /**
   * 处理 system.restart → 优雅关闭并重启后端（Supervisor 模式）。
   * 先广播重启中，再触发 gracefulShutdown(42)。
   */
  private async handleSystemRestart(conn: WSConnection): Promise<void> {
    // 广播重启中（让所有客户端显示状态）
    this.broadcastToAll(WSMessageTypes.SYSTEM_RESTARTING, { message: '后端正在重启…' });
    logger.warn(`[WS] ${conn.id} 请求后端完全重启`);
    // 延迟一点让广播先发出，再触发关闭
    setTimeout(() => {
      try {
        // requestRestart 在 Supervisor 模式下以 42 退出由父进程拉起；非托管退化为退出
        requestRestart('ws-system-restart');
      } catch (err: any) {
        logger.error(`[WS] 触发重启失败: ${err.message}`);
        conn.ws.send(buildWSMessage('error', { message: `重启失败: ${err.message}` }));
      }
    }, 200);
  }

  /**
   * 处理 chat.interact.respond → 用户响应 ask_questions 决策。
   * 通过 InteractionBridge 定位 pending 并 resolve，Agent 工具继续执行。
   */
  private async handleInteractRespond(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { interaction_id, choice } = msg.data ?? {};
    if (!interaction_id || typeof choice !== 'string') {
      conn.ws.send(buildWSMessage('error', { message: 'chat.interact.respond 需要 interaction_id 和 choice' }));
      return;
    }
    try {
      const bridge = getInteractionBridge();
      if (!bridge) {
        conn.ws.send(buildWSMessage('error', { message: '交互桥未初始化' }));
        return;
      }
      const result = bridge.respond(interaction_id, choice);
      if (!result.ok) {
        conn.ws.send(buildWSMessage('error', { message: result.error }));
        return;
      }
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_INTERACT_RESPOND, { interaction_id, ok: true }));
    } catch (err: any) {
      conn.ws.send(buildWSMessage('error', { message: `交互响应失败: ${err.message}` }));
    }
  }

  /**
   * 处理 chat.send → 路由消息到目标 Agent。
   * 同连接的 Agent 正在运行时注入为转向消息，不同连接则独立启动新会话。
   */
  private async handleChatSend(conn: WSConnection, msg: WSMessage): Promise<void> {
    const { to, content, attachments, files, deepThink, requestId } = msg.data;

    if (!to || (!content && !files?.length)) {
      conn.ws.send(buildWSMessage('error', { message: 'chat.send 需要提供 "to" 和 "content"' }));
      return;
    }

    // ---- 幂等去重：以客户端 requestId 为键（前端每次手动发送生成新 id；
    //      WS 重连 flush 重发同一对象保留同一 id）。旧客户端无 requestId 时回退
    //      to|content（保留兼容），但失败后重试同一文案不再被 30s 内容去重吞掉 ----
    const dedupKey = requestId ? `${to}|req:${requestId}` : `${to}|content:${content ?? ''}`;
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
    this.scheduleDedupPersist();

    // 处理附件引用
    const fileList = files ?? attachments ?? [];
    let payload = content;
    if (fileList.length > 0) {
      // 路径：优先用存储的相对路径（a.text，如 files/<agentId>/_tmp/x.txt）；
      // 兼容旧格式（hash 命名时代，a.hash 即文件名）
      const fileRefs = fileList
        .map((a: any) => {
          const p = a.text || a.path || `./files/${a.hash}`;
          return p.startsWith('./') || p.startsWith('files/') ? p : `./${p}`;
        })
        .join(', ');
      payload = `${content}\n\n[用户上传了文件：${fileRefs}]`;
    }

    // 同连接的 Agent 正在运行 → 注入为转向消息（同一用户追加指令）
    const sessionKey = this.sessionKey(conn.id, to);
    const activeSession = this.activeSessions.get(sessionKey);
    if (activeSession) {
      const config = this.registry.get(to);
      const sender = activeSession.sender || configService.getGlobalConfig().viewerId;
      // 新架构：router 内置 per-conv runningMap，同会话运行中 send 自动注入为转向消息
      if (config && !config.virtual) {
        void this.router.send({
          from: sender,
          to,
          type: 'chat.send',
          payload,
          correlation_id: `webui-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          data: { content, files: fileList, deepThink: !!deepThink },
        }).catch((err: any) => logger.warn(`[WS] 转向消息投递失败: ${err?.message ?? err}`));
      }
      // 转向消息也记入快照（刷新后恢复完整对话流：问了什么 → 转向了什么）
      const snap = activeSession.snapshot;
      const entry = { content: payload, ts: Date.now() };
      snap.userMessages = [...(snap.userMessages ?? []), entry];
      snap.userMessage = payload;
      snap.userMessageTs = entry.ts;
      logger.info(`[WS] ${conn.id} 向 ${to} 注入转向消息: "${content.slice(0, 40)}"`);
      // 对方正忙提示：告知前端消息已作为追加指令注入（避免用户以为没响应）
      conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_SEND_ACK, { to, busy: true, queued: true }));
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
    const session: ActiveSession = { controller: abortController, agentId: to, connId: conn.id, sender: configService.getGlobalConfig().viewerId, snapshot };
    this.activeSessions.set(sessionKey, session);

    const agentMsg: RouterMessage = {
      from: configService.getGlobalConfig().viewerId,
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

  /** 节流持久化去重缓存（500ms 合并写） */
  private scheduleDedupPersist(): void {
    if (!this.dedupStorePath) return;
    if (this.dedupFlushTimer) return;
    this.dedupFlushTimer = setTimeout(() => {
      this.dedupFlushTimer = null;
      try {
        // 只保留未过期的条目
        const now = Date.now();
        const alive: Record<string, number> = {};
        for (const [k, t] of this.recentChatSends) {
          if (now - t < WSHandler.CHAT_SEND_DEDUP_MS) alive[k] = t;
        }
        fs.writeFileSync(this.dedupStorePath!, JSON.stringify(alive), 'utf-8');
      } catch (err: any) {
        logger.warn(`[WS] 持久化去重缓存失败: ${err.message}`);
      }
    }, 500);
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
    // 跨连接兜底：直接中断 Router runningMap 中该 Agent 的所有活跃会话
    // （中断后新消息若撞上未清理的收尾会话，router 会等待清理后新建而非注入转向）
    const routerAborted = this.router.abortSession(to);
    conn.ws.send(buildWSMessage(WSMessageTypes.CHAT_INTERRUPTED, {
      agentId: to,
      reason: 'user_interrupt',
      wasActive: wasAborted || routerAborted,
    }));

    logger.info(`[WS] ${conn.id} 显式中断了 ${to} 的会话（活跃=${wasAborted || routerAborted}）`);
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
    const session: ActiveSession = { controller: abortController, agentId: to, connId: conn.id, sender: configService.getGlobalConfig().viewerId, snapshot };
    this.activeSessions.set(sessionKey, session);

    logger.info(`[WS] ${conn.id} 触发 ${to} 继续生成`);

    try {
      // trigger 不带 hint → Agent 基于历史对话自由推理，不限制轮次
      // target 设为 viewerId，确保消息持久化到 viewer↔agent 会话路径
      await this.router.trigger(to, { target: configService.getGlobalConfig().viewerId }, abortController.signal);
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
    const globalConfig = configService.getGlobalConfig();
    const viewerId = typeof globalConfig.viewerId === 'string' ? globalConfig.viewerId : 'user';
    const ids = this.registry.listIds().filter((id: string) => !this.registry.isVirtual(id));
    const agents = await Promise.all(
      ids.map(async (id: string) => {
        const lastMessages = await this.messageQuery.query({
          from: viewerId,
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
        const lastActivity = lastMsg?.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
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
    await this.historyService?.requestArchive(agent, counterpart);

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
      await this.historyService?.requestArchive(agent, counterpart);

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

    const ok = await this.historyService?.deleteFromJSONL(agent, counterpart, messageId) ?? false;
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
      if (!this.agentService) {
        conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_SYSTEM_PROMPT_RESPONSE, {
          success: false,
          error: 'AgentService 未初始化',
        }));
        return;
      }

      const systemPrompt = await this.agentService.getAgentSystemPrompt(agentId);
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
      if (!this.agentService) {
        conn.ws.send(buildWSMessage(WSMessageTypes.AGENT_TOOL_DEFS_RESPONSE, {
          success: false,
          error: 'AgentService 未初始化',
        }));
        return;
      }

      const toolDefs = this.agentService.getAgentToolDefs(agentId);
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

  private updateSessionSnapshot(msg: RouterMessage): void {
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
  private broadcastRouterEvent(agentMsg: RouterMessage): void {
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
   * 将内部 RouterMessage 转换为 WebSocket 数据
   */
  private agentMessageToWSData(msg: RouterMessage): any | null {
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

    const sender = from || configService.getGlobalConfig().viewerId;
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
      conn.ws.send(buildWSMessage('error', { message: err.message, group_id }));
    }
  }

  /** 处理 group.history.request */
  private async handleGroupHistoryRequest(conn: WSConnection, msg: WSMessage): Promise<void> {
    if (!this.groupService) {
      conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_HISTORY_RESPONSE, { messages: [] }));
      return;
    }
    const { group_id, limit, offset } = msg.data;
    // 新架构：GroupManager 纯内存，历史读取走 GroupService（L4 落盘）
    const messages = this.groupService.getGroupHistory(group_id, limit ?? 50, offset ?? 0);
    conn.ws.send(buildWSMessage(WSMessageTypes.GROUP_HISTORY_RESPONSE, { group_id, messages }));
  }
}
