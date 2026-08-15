// ============================================================
// AgentService —— Agent 管理服务（L4 门面）
//
// 收回 src/server/api/agents.ts 重复实现的核心逻辑：
//   创建 LLM / 保存配置（含凭据剥离）/ 热重载 / 差异配置计算 / 列表
// webui / TUI / Desktop 统一通过此服务管理 Agent。
//
// 适配新架构：
//   · registry 只存配置无实例（§7.3）→ 列/查/热重载全部基于 AgentConfig：
//     hotReloadAgent/createAgentRuntime 变为「重读磁盘配置 → 重新注册」，
//     工具/钩子/LLM 由 L5 装配的 AgentAssembly 每次投递时按需解析。
//   · 旧 getGlobalConfig()（core/config）→ services/runtime 注入的全局配置。
//   · 旧 timerManager 全局单例 → TimerManager 实例（注入或 useService('timer')）。
//   · 旧 Agent 实例 assembleSystemPrompt/getToolDefinitions →
//     pluginRegistry useService('buildSystemPrompt') + resolveTools。
//   · AgentInfo 类型本地定义（旧 @shared/types 已不存）。
//
// 依赖方向：services → agents/core/plugins（聚合层，允许）。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLLM as makeLLM } from '@agentchat/llm';
import type { LLMProvider, LLMConfig } from '@agentchat/llm';
import type { AgentRegistry } from '@agentchat/agents';
import type { AgentRouter } from '@agentchat/router';
import { getCredential, getGlobalCredential, setCredential } from '@agentchat/agents';
import { computeDiff, deepMerge } from '@agentchat/agents';
import { collectToolNames } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';

import type { ToolContext, ToolsService } from '@agentchat/tools';
import type { Tool } from '@agentchat/agent-loop';
import type { TimerManager, TimerEntry } from '@agentchat/timer';
import type { ServiceRegistry } from './registry';
import { getGlobalConfig } from './runtime';
import { createLogger } from '@agentchat/util';
import type { AgentInfo } from '@agentchat/protocol';

/** PluginRegistry 结构接口（避免依赖 plugins 域；装配层注入真实实现） */
export interface PluginRegistryLike {
  useService<T = unknown>(name: string): T | undefined;
  resolveTools(names: string[] | undefined, config: AgentConfig): Map<string, Tool>;
}

const log = createLogger('[services:agent]');

export type { TimerEntry };
export type { AgentInfo } from '@agentchat/protocol';

/**
 * AgentLoader 最小结构接口（避免 services→app 反向类型依赖）。
 * L5 app/loader 的 AgentLoader 结构兼容（loadOne 返回有效配置）。
 */
export interface AgentLoaderLike {
  loadOne(agentDir: string): { config: AgentConfig };
}

/** 全局专属字段，不能写入 Agent 差异配置 */
const GLOBAL_ONLY_KEYS = [
  'llmProviders', 'searchProviders', 'workspaceDir', 'agentsDir',
  'sessionsDir', 'groupsDir', 'maxHops', 'messageQueryDefaultLimit',
];

export interface AgentServiceOptions {
  /** cordis 上下文（全面 cordis 化：timer/tools 经 ctx 服务取用，回退 pluginRegistry） */
  ctx?: import('@agentchat/cordis').Context;
  registry: AgentRegistry;
  /** Agent 配置加载器（L5 app/loader 注入；缺省回退直接读 config.json + 全局合并） */
  loader?: AgentLoaderLike;
  agentRouter?: AgentRouter;
  /** 插件注册表（工具解析 / system prompt 服务；L5 注入） */
  pluginRegistry?: PluginRegistryLike;
  /** 定时任务管理器（L5 注入；缺省回退 useService('timer')） */
  timer?: TimerManager;
  /** 插件运行时服务（buildSystemPrompt 装配 deps；L5 注入） */
  pluginServices?: Partial<ToolContext>;
  /** L4 服务注册表（L5 注入；L3 插件服务已批量注册，优先经它取用，回退 useService） */
  serviceRegistry?: ServiceRegistry;
}

export class AgentService {
  private registry: AgentRegistry;
  private loader?: AgentLoaderLike;
  private agentRouter?: AgentRouter;
  private pluginRegistry?: PluginRegistryLike;
  private timer?: TimerManager;
  private pluginServices: Partial<ToolContext>;
  private ctx?: import('@agentchat/cordis').Context;
  private serviceRegistry?: ServiceRegistry;

  constructor(options: AgentServiceOptions) {
    this.registry = options.registry;
    this.loader = options.loader;
    this.agentRouter = options.agentRouter;
    this.pluginRegistry = options.pluginRegistry;
    this.timer = options.timer;
    this.pluginServices = options.pluginServices ?? {};
    this.ctx = options.ctx;
    this.serviceRegistry = options.serviceRegistry;
  }

  /** 构建全局配置基线（Agent 差异配置计算用）：排除 $ 内部字段，展平 namespaces */
  buildGlobalBase(): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    const raw = getGlobalConfig() as unknown as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!key.startsWith('$') && key !== 'namespaces') base[key] = raw[key];
    }
    const ns = raw.namespaces as Record<string, Record<string, unknown>> | undefined;
    if (ns) for (const [k, v] of Object.entries(ns)) base[k] = v;
    return base;
  }

  /** 创建 LLM 实例（从凭据存储注入 api_key；@core/llm 工厂按 provider 分发） */
  createLLM(agentId: string, llmCfg: LLMConfig): LLMProvider {
    const cfg: LLMConfig = { ...llmCfg };
    cfg.api_key = getCredential(agentId, cfg.provider ?? '')
      || getGlobalCredential(cfg.provider ?? '')
      || cfg.api_key || '';
    // 契约化：优先经 ctx.llm 服务（Loader 装配期可注入/mock）；无 ctx 场景回退直连工厂。
    // 用 ctx.get 可选读取（AgentService 构造于 server 服务插件 fiber，未 inject llm）。
    const ctxLlm = this.ctx?.get?.('llm') as { create(cfg: LLMConfig): LLMProvider } | undefined;
    return ctxLlm?.create(cfg) ?? makeLLM(cfg);
  }

  /** 写入 Agent 差异配置（剥离密钥到凭据存储、计算 diff；
   * 装配字段 presets/tools/hooks/plugins 由 PUT /api/plugins/assembly 专责管理，
   * 普通保存未携带这些键时从磁盘现有配置保留，避免覆盖装配保存） */
  saveAgentConfig(agentId: string, agentDir: string, config: Record<string, unknown>): void {
    const configPath = path.join(agentDir, 'config.json');
    const existing = ((): Record<string, unknown> => {
      try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>; }
      catch { return {}; }
    })();
    const oldProvider = (existing.llm as Record<string, unknown> | undefined)?.provider as string | undefined;

    const llm = config.llm as Record<string, unknown> | undefined;
    if (llm?.api_key !== undefined) {
      setCredential(agentId, (llm.provider as string) || 'deepseek', llm.api_key as string);
      delete llm.api_key;
    }
    if (!llm && oldProvider) setCredential(agentId, oldProvider, '');

    // 装配字段保留：普通配置保存不携带时沿用磁盘现值（含 saveAssembly 刚写入的结果）
    for (const key of ['presets', 'tools', 'hooks', 'plugins'] as const) {
      if (!(key in config) && key in existing) config[key] = existing[key];
    }

    for (const key of GLOBAL_ONLY_KEYS) delete config[key];
    config.agent_id = agentId;
    const diff = computeDiff(config, this.buildGlobalBase());
    fs.writeFileSync(configPath, JSON.stringify(diff, null, 2) + '\n', 'utf-8');
    log.info(`Agent "${agentId}" 差异配置已保存 (${Object.keys(diff).length} 项)`);
  }

  /** 写入 Markdown 文件（空内容则删除） */
  writeMDFile(agentDir: string, filename: string, content: string): void {
    const filePath = path.join(agentDir, filename);
    if (content.trim()) { fs.writeFileSync(filePath, content, 'utf-8'); }
    else if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
  }

  /**
   * 直接读取 Agent 目录的 config.json（差异）→ 有效配置（全局基础合并 + 凭据回填）。
   * 无 loader 注入时的兜底实现；L5 装配后走 loader.loadOne。
   */
  private readAgentConfig(agentDir: string): AgentConfig | null {
    const configPath = path.join(agentDir, 'config.json');
    if (!fs.existsSync(configPath)) return null;
    try {
      const diff = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const agentId = (diff.agent_id as string) ?? '';
      const effective = this.getEffectiveConfig(agentId, diff);
      return effective as unknown as AgentConfig;
    } catch (err: any) {
      log.error(`读取 Agent 配置失败（${agentDir}）: ${err?.message ?? String(err)}`);
      return null;
    }
  }

  /**
   * 热重载 Agent：重读磁盘配置并重新注册（新架构 registry 只存配置，
   * 工具/钩子/LLM 由装配层每次投递时按需解析，无需刷新实例）。
   */
  hotReloadAgent(agentId: string, agentDir: string): void {
    if (!this.registry.get(agentId)) return;
    const loaded = this.loader ? this.loader.loadOne(agentDir) : { config: this.readAgentConfig(agentDir)! };
    if (!loaded.config) {
      log.warn(`热重载失败：未找到 Agent "${agentId}" 的有效配置（${agentDir}）`);
      return;
    }
    this.registry.register(loaded.config);
    log.info(`Agent "${agentId}" 已热重载（配置刷新）`);
  }

  /**
   * 热加载新 Agent 到运行时（对齐 bootstrap 流程）：读配置 → 注册到 registry。
   * @throws LLM 缺失时抛错由调用方处理
   */
  createAgentRuntime(agentDir: string): void {
    const loaded = this.loader ? this.loader.loadOne(agentDir) : { config: this.readAgentConfig(agentDir)! };
    const config = loaded.config;
    if (!config) {
      throw new Error(`Agent 配置加载失败: ${agentDir}`);
    }

    // LLM 配置：优先 Agent 自身，回退全局
    if (!config.llm) {
      const gCfg = getGlobalConfig() as any;
      if (gCfg.llm?.provider) {
        (config as any).llm = { ...gCfg.llm } as LLMConfig;
        log.info(`Agent "${config.agent_id}" 使用全局 LLM 配置: ${(config as any).llm.provider}`);
      }
    }
    if (!config.llm) {
      throw new Error(`Agent "${config.agent_id}" 缺少 llm 配置，且全局配置中也没有默认值。`);
    }

    this.registry.register(config);
    log.info(`Agent "${config.agent_id}" 已热加载到运行时`);
  }

  /** 获取 Agent 有效配置：全局基础 + 差异合并，删除全局专属键，回填 api_key。 */
  getEffectiveConfig(agentId: string, agentDiff: Record<string, unknown>): Record<string, unknown> {
    const effective = deepMerge(this.buildGlobalBase(), agentDiff);
    effective.agent_id = agentId;
    for (const key of GLOBAL_ONLY_KEYS) delete effective[key];
    const effLlm = effective.llm as Record<string, unknown> | undefined;
    if (effLlm?.provider) {
      const key = getCredential(agentId, effLlm.provider as string)
        || getGlobalCredential(effLlm.provider as string);
      if (key) effLlm.api_key = key;
    }
    return effective;
  }

  /** 列出所有 Agent（含虚拟） */
  list(): AgentInfo[] {
    return this.registry.list().map((cfg) => {
      const info: AgentInfo = {
        agent_id: cfg.agent_id,
        name: cfg.name,
        virtual: cfg.virtual === true,
      };
      if (cfg.description) info.description = cfg.description;
      if (cfg.avatar) info.avatar = cfg.avatar;
      if (cfg.tags) info.tags = cfg.tags;
      if (cfg.llm) {
        info.llm = typeof cfg.llm === 'string'
          ? { provider: cfg.llm }
          : { provider: cfg.llm.provider ?? '', model: cfg.llm.model };
      }
      return info;
    });
  }

  /** 列出 Agent 基础信息（id/name/virtual，供 API 列表用） */
  listBasic(): Array<{ id: string; name: string; virtual: boolean }> {
    return this.registry.listIds().map((id: string) => ({
      id,
      name: this.registry.getAgentName(id),
      virtual: this.registry.isVirtual(id),
    }));
  }

  /** 注销 Agent（从注册表移除） */
  unregister(agentId: string): void {
    this.registry.unregister(agentId);
  }

  /** 解析定时任务管理器（注入实例优先，回退 L4 注册表 → ctx 服务） */
  private resolveTimer(): TimerManager | undefined {
    const ctxTimer = this.ctx?.get?.('timerManager') as { manager: TimerManager } | undefined;
    return this.timer
      ?? this.serviceRegistry?.get<TimerManager>('timer')
      ?? ctxTimer?.manager ?? this.pluginRegistry?.useService<TimerManager>('timer');
  }

  /** 获取指定 Agent 的定时任务 */
  getAgentTimers(agentId: string): TimerEntry[] {
    return this.resolveTimer()?.getEntries(agentId) ?? [];
  }

  /** 保存指定 Agent 的定时任务 */
  saveAgentTimers(agentId: string, entries: TimerEntry[]): void {
    const timer = this.resolveTimer();
    if (!timer) {
      log.warn('定时任务服务未注册，保存失败');
      return;
    }
    timer.saveEntries(agentId, entries);
  }

  /**
   * 获取 Agent 的 System Prompt 预览（供 webui WS 预览）。
   * 仅真 Agent（非虚拟）可预览，否则抛错。
   * 经 L4 服务注册表取 L3 builtin 服务 buildSystemPrompt（回退 pluginRegistry.useService）。
   */
  async getAgentSystemPrompt(agentId: string): Promise<string> {
    const config = this.registry.get(agentId);
    if (!config || config.virtual) {
      throw new Error(`Agent "${agentId}" 未找到`);
    }
    const build = this.serviceRegistry?.get<
      (config: AgentConfig, deps: ToolContext, input?: { toolNames?: string[]; sender?: string; groupId?: string }) => string
    >('buildSystemPrompt')
      ?? this.pluginRegistry?.useService<
        (config: AgentConfig, deps: ToolContext, input?: { toolNames?: string[]; sender?: string; groupId?: string }) => string
      >('buildSystemPrompt');
    if (!build) {
      throw new Error('buildSystemPrompt 服务未注册（插件未装配）');
    }
    const toolNames = config.tools ?? collectToolNames(config.plugins);
    const ctxTools = this.ctx?.get?.('tools') as ToolsService | undefined;
    const tools = ctxTools
      ? ctxTools.resolveTools(toolNames, config, this.pluginServices)
      : (this.pluginRegistry?.resolveTools(toolNames, config) ?? new Map());
    return build(config, this.pluginServices as ToolContext, {
      toolNames: Array.from(tools.keys()),
      sender: 'user',
    });
  }

  /** 获取 Agent 的工具定义预览（供 webui WS 预览 tool_defs） */
  getAgentToolDefs(agentId: string): Array<Record<string, unknown>> {
    const config = this.registry.get(agentId);
    if (!config || config.virtual) {
      throw new Error(`Agent "${agentId}" 未找到`);
    }
    const toolNames = config.tools ?? collectToolNames(config.plugins);
    const ctxTools = this.ctx?.get?.('tools') as ToolsService | undefined;
    const tools = ctxTools
      ? ctxTools.resolveTools(toolNames, config, this.pluginServices)
      : (this.pluginRegistry?.resolveTools(toolNames, config) ?? new Map());
    return Array.from(tools.values()).map((t) => t.definition as unknown as Record<string, unknown>);
  }
}
