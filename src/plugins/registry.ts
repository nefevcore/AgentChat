// ============================================================
// src/plugins/registry.ts —— 插件注册表（L3 对 L2/L5 的注入面）
//
// 注册 PluginDefinition，提供：
//   · resolveTools(names, config)  —— 按工具名 + Agent 配置解析工具实例表
//   · resolveHooks(names, config)  —— 按聚合钩子名解析各类钩子数组（支持工厂烘焙）
//   · useService(name)             —— 惰性装载插件对外暴露的服务（plugin.services）
//
// 依赖方向：仅依赖 src/core + @agents/config 类型 + 本层 types（L3→L2→L1 单向）。
// ============================================================

import type { CurrentContext } from '@core/context';
import type { Tool } from '@core/types';
import type { AgentConfig, HookNames } from '@agents/config';
import type { PluginDefinition, PluginMeta, PluginHooks, PluginServices, PluginServiceContext } from './types';
import type { ConfigField } from './schema';

/** 钩子类 → CurrentContext 钩子数组字段名（与 L1 对齐，零映射） */
const HOOK_FIELD = {
  runStart: 'runStartHook',
  runEnd: 'runEndHook',
  turnStart: 'turnStartHook',
  turnEnd: 'turnEndHook',
  toolExecutionStart: 'toolExecutionStartHook',
  toolExecutionEnd: 'toolExecutionEndHook',
  fallback: 'fallbackHook',
} as const;

export type HookKind = keyof PluginHooks;
export type ResolvedHooks = Partial<Pick<CurrentContext,
  | 'runStartHook' | 'runEndHook' | 'turnStartHook' | 'turnEndHook'
  | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'>>;

/**
 * 插件注册表：注册 PluginDefinition → resolveTools / resolveHooks / useService。
 * 工具支持数组（共享）与工厂（per-Agent 烘焙）；钩子支持静态映射与工厂
 * （per-Agent 烘焙 config+services，resolveHooks 时按需解析）；服务经
 * plugin.services 声明，useService 惰性装载并缓存（单例）。
 */
export class PluginRegistry {
  private plugins = new Map<string, PluginDefinition>();

  /** 插件运行时服务（L4 装配时注入） */
  private services: PluginServices;

  /** 服务装配上下文（L5 注入；useService 装载时传给服务工厂） */
  private serviceContext: PluginServiceContext = { workspaceDir: '', agentsDir: '' };

  /** 已装载的服务实例缓存（服务名 → 实例，单例） */
  private serviceInstances = new Map<string, unknown>();

  constructor(services: PluginServices = {}) {
    this.services = services;
  }

  /**
   * 后注入服务（L4 装配环：router 依赖 assembly → registry，需先建 registry → assembly → router，再注入 router）。
   * 引用语义：首次调用直接持有调用方对象；后续调用原地合并到同一对象，保持引用不变。
   * 关键：loader.createLLM/resolveTools 每次投递都会写入 services.llm/tools（"当前 Agent"约定），
   * 这些写入必须对 registry 烘焙的工具（spawn_subagent 读 services.llm 等）可见——
   * 若这里浅拷贝，registry 内部将是另一份对象，父 LLM 永远读不到。
   */
  setServices(services: PluginServices): void {
    if (Object.keys(this.services).length === 0) {
      this.services = services; // 首次：直接引用调用方对象（共享）
    } else {
      Object.assign(this.services, services); // 后续：原地合并，引用不变
    }
  }

  /** 注入服务装配上下文（L5 bootstrap：workspaceDir/agentsDir/timezone 等） */
  setServiceContext(ctx: PluginServiceContext): void {
    this.serviceContext = { ...this.serviceContext, ...ctx };
  }

  /** 注册插件（同名覆盖） */
  register(plugin: PluginDefinition): void {
    this.plugins.set(plugin.meta.name, plugin);
  }

  /** 取消注册 */
  unregister(name: string): void {
    this.plugins.delete(name);
  }

  /**
   * L2 装配用：解析工具实例表（工厂收到 config + services）。
   *
   * 对齐旧架构 v0.4.5+ 注入策略：
   *   1. requires 自动注入 —— 遍历全部工具，requires 非空且匹配 agentTags → 自动注入
   *      （协作工具 send_agent/send_group/query_history 等 requires:['agent'] 无需声明即有）
   *   2. 显式追加 —— names（config.plugins[].tools / 旧 config.tools）里 requires 匹配
   *      或无 requires 的工具 → 注入（旧 config.tools 白名单向后兼容）
   *   3. requires 为空的工具不自动注入，仅经显式 names 注入
   *   'agent' 为隐式基础标签（旧架构所有真实 Agent 自动补 agent；dev/admin/conductor 等才需显式 tags）
   */
  resolveTools(names: string[] | undefined, config: AgentConfig): Map<string, Tool> {
    const out = new Map<string, Tool>();
    const agentTags = new Set(['agent', ...(config.tags ?? [])]);
    const match = (tool: Tool): boolean => {
      if (!tool.requires || tool.requires.length === 0) return true;
      return tool.requires.every(t => agentTags.has(t));
    };

    // 收集全部工具（插件遍历，工厂按 config 烘焙）
    const all: Tool[] = [];
    for (const plugin of this.plugins.values()) {
      const tools = typeof plugin.tools === 'function' ? plugin.tools(config, this.services) : plugin.tools ?? [];
      all.push(...tools);
    }

    // 1. requires 自动注入（requires 非空且匹配 tags）
    for (const tool of all) {
      if (out.has(tool.name)) continue;
      if (tool.requires && tool.requires.length > 0 && match(tool)) out.set(tool.name, tool);
    }

    // 2. 显式追加（names 声明：requires 匹配或无 requires）
    for (const name of names ?? []) {
      if (out.has(name)) continue;
      const tool = all.find(t => t.name === name);
      if (tool && match(tool)) out.set(name, tool);
    }

    return out;
  }

  /** 解析单个插件的钩子（工厂按 config+services 烘焙；静态原样返回） */
  private resolvePluginHooks(plugin: PluginDefinition, config: AgentConfig): PluginHooks {
    return typeof plugin.hooks === 'function' ? plugin.hooks(config, this.services) : (plugin.hooks ?? {});
  }

  /** L2 装配用：按聚合后的钩子名集合解析各类钩子数组（工厂按 config 烘焙） */
  resolveHooks(names: HookNames, config: AgentConfig): ResolvedHooks {
    const out: ResolvedHooks = {};
    for (const kind of Object.keys(HOOK_FIELD) as HookKind[]) {
      const list = names?.[kind];
      if (!list || list.length === 0) continue;
      const fns = list
        .map(n => this.lookupHook(kind, n, config))
        .filter((f): f is NonNullable<typeof f> => f != null);
      if (fns.length > 0) {
        out[HOOK_FIELD[kind]] = fns;
      }
    }
    return out;
  }

  /** 按钩子名查实现（同名后注册者优先；工厂每 Agent 烘焙） */
  private lookupHook(kind: HookKind, name: string, config: AgentConfig): any {
    for (const plugin of [...this.plugins.values()].reverse()) {
      const hooks = this.resolvePluginHooks(plugin, config);
      const fn = hooks[kind]?.[name];
      if (fn) return fn;
    }
    return undefined;
  }

  // ============================================================
  // 服务装载（plugin.services → useService 惰性单例）
  // ============================================================

  /** 所有已注册的服务名（跨插件；同名列后注册者覆盖） */
  listServiceNames(): string[] {
    const names = new Set<string>();
    for (const plugin of this.plugins.values()) {
      for (const name of Object.keys(plugin.services ?? {})) {
        names.add(name);
      }
    }
    return [...names];
  }

  /**
   * 惰性装载插件服务（L5 用，替代旧具名导出 + 手动 import）。
   * 首次调用时执行服务工厂（收到装配上下文 ctx），结果单例缓存。
   * 同名服务后注册者覆盖；未找到返回 undefined。
   */
  useService<T = unknown>(name: string): T | undefined {
    if (this.serviceInstances.has(name)) {
      return this.serviceInstances.get(name) as T;
    }
    // 查找工厂（后注册者优先）
    for (const plugin of [...this.plugins.values()].reverse()) {
      const factory = plugin.services?.[name];
      if (factory) {
        const instance = factory(this.serviceContext);
        this.serviceInstances.set(name, instance);
        return instance as T;
      }
    }
    return undefined;
  }

  /** 手动覆盖/预置服务实例（测试 / L5 装配用） */
  setService(name: string, instance: unknown): void {
    this.serviceInstances.set(name, instance);
  }

  /** 所有已注册插件元数据 */
  listPlugins(): PluginMeta[] {
    return Array.from(this.plugins.values()).map(p => p.meta);
  }

  /** 全部工具目录（工厂按 config 烘焙；供 UI 工具清单展示） */
  listAllTools(config: AgentConfig): Tool[] {
    const all: Tool[] = [];
    for (const plugin of this.plugins.values()) {
      const tools = typeof plugin.tools === 'function' ? plugin.tools(config, this.services) : plugin.tools ?? [];
      all.push(...tools);
    }
    return all;
  }

  /**
   * 收集全部插件的配置命名空间 Schema（命名空间 key → 表单元数据）。
   * 数据源为各插件 PluginDefinition.configs 声明（随代码走），loader 经此
   * 动态装配 /api/plugins/schemas —— 无硬编码。同名命名空间首注册者生效。
   */
  listConfigSchemas(): Record<string, ConfigField[]> {
    const out: Record<string, ConfigField[]> = {};
    for (const plugin of this.plugins.values()) {
      for (const [ns, fields] of Object.entries(plugin.configs ?? {})) {
        if (!(ns in out)) out[ns] = fields;
      }
    }
    return out;
  }
}
