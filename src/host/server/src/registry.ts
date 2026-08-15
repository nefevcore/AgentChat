// ============================================================
// ServiceRegistry —— 服务注册表（L4 门面）
//
// src 全部能力的对外登记处。插件启动时经 app 装配注入的
// registerService 回调自主注册服务（插件不直接 import services/），
// services 门面 / webui / TUI / Desktop 通过 get() 获取。
// 未来 RPC：注册的每个服务方法可映射为 RPC 调用（见 rpc.ts）。
//
// L3/L4 解耦：registerPluginServices() 从插件声明的 plugin.services
// 批量发现注册（惰性装载），L4 消费方统一经注册表取用，无需 L5 逐个
// 手动装配或散落 useService 套壳。
//
// 依赖方向：仅依赖 src/core（logger）+ 结构类型（无 L3 强依赖），零 npm。
// ============================================================

import { createLogger } from '@agentchat/util';

const log = createLogger('[services:registry]');

/** 插件服务发现接口（结构类型：对齐 PluginRegistry 的 listServiceNames/useService） */
export interface PluginServiceProvider {
  /** 所有已注册的服务名（跨插件） */
  listServiceNames(): string[];
  /** 惰性装载插件服务（单例缓存；未找到返回 undefined） */
  useService<T = unknown>(name: string): T | undefined;
}

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

  /**
   * 从插件声明批量注册服务（L3 plugin.services → L4 注册表，解耦）。
   * 逐个 useService 惰性装载并注册；插件未提供/未装载成功的跳过。
   * @returns 本次注册的服务数
   */
  registerPluginServices(provider: PluginServiceProvider): number {
    let count = 0;
    for (const name of provider.listServiceNames()) {
      const instance = provider.useService(name);
      if (instance !== undefined) {
        this.register(name, instance);
        count++;
      }
    }
    return count;
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
