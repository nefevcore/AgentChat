// ============================================================
// RPC —— JSON-RPC 2.0 适配层（v0.5.0 P5，TUI/多端打底）
//
// 设计：服务注册表里的每个服务方法可映射为 RPC 调用。
//   agentService.list            →  "agent.list"
//   agentService.getEffectiveConfig → "agent.getConfig"
//   messageQuery.query           →  "history.query"
//
// 传输：复用现有 WebSocket。入站消息带 method 字段即走 RPC：
//   { type: 'rpc', method: 'agent.list', params: {}, id: 1 }
// 出站（同步响应）：
//   { type: 'rpc.response', id: 1, result: {...} }
//   { type: 'rpc.error', id: 1, error: { code, message } }
// 推送仍走现有事件类型（chat.message.update 等），RPC 只管请求-响应。
// ============================================================

import { ServiceRegistry } from '@services/registry';

/** RPC 方法注册项：方法名 → { service, method } */
interface RPCMethodEntry {
  service: unknown;
  method: string;
}

export class RPCBridge {
  private methods = new Map<string, RPCMethodEntry>();

  constructor(private registry: ServiceRegistry) {}

  /**
   * 注册服务到 RPC：把服务的公开方法映射为 "serviceName.methodName"。
   * 例：registerService('agent', agentService) → "agent.list"/"agent.getConfig"...
   */
  registerService<T extends object>(serviceName: string, service: T): void {
    // 只注册公开方法（跳过 constructor / 私有符号）
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
      if (key === 'constructor') continue;
      const fn = (service as Record<string, unknown>)[key];
      if (typeof fn !== 'function') continue;
      const methodName = `${serviceName}.${key}`;
      this.methods.set(methodName, { service, method: key });
      // 驼峰 → kebab 别名（如 getEffectiveConfig → agent.get-effective-config 不需要，
      // 保持 camelCase 即可；TUI 若偏好 kebab 可加）
    }
  }

  /** 列出所有已注册 RPC 方法 */
  listMethods(): string[] {
    return [...this.methods.keys()].sort();
  }

  /**
   * 执行 RPC 调用。
   * @returns { result } 或抛错
   */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const entry = this.methods.get(method);
    if (!entry) {
      throw Object.assign(new Error(`RPC 方法不存在: ${method}`), { code: -32601 });
    }
    const fn = (entry.service as Record<string, unknown>)[entry.method] as
      | ((...args: unknown[]) => unknown)
      | undefined;
    if (!fn) {
      throw Object.assign(new Error(`RPC 方法不可调用: ${method}`), { code: -32601 });
    }
    // 服务方法签名约定：
    //   无参 → call(method) 或 call(method, undefined)
    //   单对象参数 → call(method, obj) 直接透传（服务方法签名为 (arg: T)）
    //   多参 → 需 params 为数组（JSON-RPC params 数组形式）
    if (Array.isArray(params)) {
      return (await fn.apply(entry.service, params)) as T;
    }
    if (params === undefined || params === null) {
      return (await fn.apply(entry.service, [])) as T;
    }
    return (await fn.apply(entry.service, [params])) as T;
  }
}

/** 解析入站 RPC 消息（JSON-RPC 2.0 风格） */
export function parseRPCMessage(msg: { type?: string; method?: string; params?: unknown; id?: number }) {
  if (msg.type !== 'rpc' || typeof msg.method !== 'string') return null;
  return { method: msg.method, params: msg.params, id: msg.id ?? null };
}

/** 构建 RPC 成功响应 */
export function buildRPCSuccess(id: number | null, result: unknown): string {
  return JSON.stringify({ type: 'rpc.response', id, result });
}

/** 构建 RPC 错误响应 */
export function buildRPCError(id: number | null, code: number, message: string): string {
  return JSON.stringify({ type: 'rpc.error', id, error: { code, message } });
}
