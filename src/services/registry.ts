// ============================================================
// ServiceRegistry —— 服务注册表（L4 门面）
//
// src 全部能力的对外登记处。插件启动时经 app 装配注入的
// registerService 回调自主注册服务（插件不直接 import services/），
// services 门面 / webui / TUI / Desktop 通过 get() 获取。
// 未来 RPC：注册的每个服务方法可映射为 RPC 调用（见 rpc.ts）。
//
// 依赖方向：仅依赖 src/core（logger），零 npm。
// ============================================================

import { createLogger } from '@core/logger';

const log = createLogger('[services:registry]');

/** 服务标识 → 实例的注册表 */
export class ServiceRegistry {
  private services = new Map<string, unknown>();

  /** 注册服务（插件启动时调用）。同名重复注册会告警并覆盖。 */
  register<T>(name: string, impl: T): void {
    if (this.services.has(name)) {
      log.warn(`重复注册服务 "${name}"，已覆盖`);
    }
    this.services.set(name, impl);
  }

  /** 获取服务实例（未注册返回 undefined） */
  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  /** 获取服务实例，未注册抛错（用于必需依赖） */
  require<T>(name: string): T {
    const svc = this.services.get(name);
    if (!svc) {
      throw new Error(`服务 "${name}" 未注册`);
    }
    return svc as T;
  }

  /** 列出所有已注册服务名 */
  list(): string[] {
    return [...this.services.keys()];
  }
}
