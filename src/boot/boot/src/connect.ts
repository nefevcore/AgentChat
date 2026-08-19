// ============================================================
// @agentchat/boot/src/connect.ts —— connect-or-boot 客户端工具（P2）
//
// client 表面（headless/tui）用：读 workspace 运行时标识 .runtime →
// 连 owner 的 WS → 复用 @agentchat/protocol 的 WS 消息契约
// （chat.send / chat.* 流事件）。不 boot 组合树；无活实例 → 明确报错
// 提示 `agentchat web`（不做隐式 boot，避免双 owner）。
// ============================================================
import WebSocket from 'ws';
import { findRuntime, describeRuntime, runtimeFilePath } from '@agentchat/toolkit';
import { defaultWorkspaceDir } from './instance';

export { findRuntime, defaultWorkspaceDir, describeRuntime, runtimeFilePath };

/** WS 消息帧（与 WebUI 客户端一致：{ type, data }） */
export interface WSFrame {
  type: string;
  data?: any;
}

export interface ConnectOptions {
  /** 连接超时（缺省 5s） */
  timeoutMs?: number;
}

/** 连接实例的 WS 端点 */
export function instanceWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

/**
 * 连接活实例：无注册表/实例死亡/连接失败 → 抛错（消息面向 CLI 用户）。
 * 返回已 open 的 WebSocket（调用方负责 close）。
 */
export function connectInstance(record: { port: number }, options: ConnectOptions = {}): Promise<WebSocket> {
  const url = instanceWsUrl(record.port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`连接 ${url} 超时`));
    }, options.timeoutMs ?? 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`连接 ${url} 失败: ${(err as Error).message}`));
    });
  });
}

/** 发送一帧 WS 消息 */
export function sendFrame(ws: WebSocket, type: string, data?: unknown): void {
  ws.send(JSON.stringify({ type, data }));
}

/** 订阅 WS 消息帧；返回退订函数 */
export function onFrame(ws: WebSocket, handler: (frame: WSFrame) => void): () => void {
  const listener = (raw: WebSocket.RawData) => {
    try {
      handler(JSON.parse(raw.toString()) as WSFrame);
    } catch { // 非 JSON 帧：忽略（协议外噪音）
    }
  };
  ws.on('message', listener);
  return () => ws.off('message', listener);
}

/**
 * 发现并校验活实例（client 表面入口共用）：
 * 无 .runtime / 残留 / 运行中但无 Web 表面（base/embedded）→ 抛带指引的错误。
 */
export function requireLiveInstance(workspaceDir?: string): { pid: number; port: number; profile: string } {
  const dir = workspaceDir ?? defaultWorkspaceDir();
  const found = findRuntime(dir);
  if (!found) {
    throw new Error(
      `workspace (${dir}) 没有运行中的 AgentChat 实例（无 .runtime）。\n` +
      '请先启动：agentchat web',
    );
  }
  if (!found.alive) {
    throw new Error(
      `发现残留运行时标识（${describeRuntime(found.record)}，进程已退出）。\n` +
      '请先启动：agentchat web',
    );
  }
  if (!found.record.port) {
    throw new Error(
      `实例运行中（${describeRuntime(found.record)}）但未启用 Web 表面（kind=${found.record.kind}）。\n` +
      'headless 需要 web-app owner：agentchat web',
    );
  }
  return { pid: found.record.pid, port: found.record.port, profile: found.record.profile };
}
