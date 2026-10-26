// ============================================================
// ac-web-server/src/contract.ts —— Web 传输域契约（纯类型，零运行时）
//
// src WebUIServer + HttpRouteRegistry 的 preview 形态（地图 §3.3）：
//   · 传输层零业务知识——不 import 任何业务服务，业务路由/RPC 由各域
//     行经 route()/registerRpc() 注册（RPC 显式注册，弃 src 反射全量）；
//   · 注册即归属：route/registerRpc 内部经 this.ctx.fiber.effect 挂靠
//     调用方插件 fiber（src HttpRouteRegistry 的 disposer 形态 +
//     fiber 归属改造）；
//   · 依赖零框架：Node 原生 http（不引 express——src 的 cors/json
//     中间件收敛为本服务内置的最小实现）。
// ============================================================
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WsAckKind } from 'ac-ws-protocol';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** multipart/form-data 解析结果（M17-E 上传面；文件数据为 Buffer） */
export interface MultipartBody {
  fields: Record<string, string>;
  files: Record<string, { filename: string; contentType: string; data: Buffer }>;
}

/** 路由处理器收到的请求上下文（原始 req/res 保留逃生口） */
export interface RouteCall {
  method: HttpMethod;
  /** 请求路径（不含 query） */
  path: string;
  query: URLSearchParams;
  /** 路径参数：`:name` 段捕获 + 尾 `*` 捕获为 `params['*']` */
  params: Record<string, string>;
  /**
   * 请求体：Content-Type application/json → 解析对象；
   * multipart/form-data → MultipartBody；其余 → undefined
   */
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

export type RouteHandler = (call: RouteCall) => void | Promise<void>;

/** RPC 处理器（WS 入站 rpc/call 帧的分发目标） */
export type RpcHandler = (
  params: unknown,
  caller: RpcCaller,
) => unknown | Promise<unknown>;

/** RPC 调用方上下文（应答回源连接 + 投递回执） */
export interface RpcCaller {
  requestId: string;
  /** 来源连接 id（定向应答寻址） */
  connId: string;
  /** 投递回执：向来源连接发 ws/ack 帧 + emit ws/ack 事件 */
  ack(kind: WsAckKind, info?: Record<string, unknown>): void;
}

/** 连接信息（listConnections 诊断） */
export interface ConnectionInfo {
  connId: string;
  connectedAt: number;
  remoteAddress?: string;
}
