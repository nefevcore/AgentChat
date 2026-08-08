// ============================================================
// src/app/loader.ts —— 统一装配（L5，唯一有副作用层的核心）
//
// 职责（← 旧 discovery/agent-loader + plugins/loader 合并）：
//   1. loadGlobalConfig —— 全局配置加载（workspace/config.json + 默认值 + 命名空间解析）
//   2. resolveLLMPool / resolveSearchPool —— 池引用解析（模型池 / 搜索引擎池）
//   3. AgentLoader —— 扫描 agents/ 目录、读差异配置、合并全局基础 → 有效 AgentConfig
//   4. setupPlugins —— 注册插件（builtin/builtin-math）+ 注入服务/装配上下文
//   5. makeAgentAssembly —— 构建 L2 AgentAssembly（createLLM/resolveTools/loadHistory/
//      resolveHooks/emit/systemPrompt），router 构造用
//
// 依赖方向：app → services/plugins/agents/core（装配层允许聚合）。
//   注意：services→app 禁止，故 backupAll 等回调由 index.ts 注入。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/logger';
import type { LLMConfig, LLMProvider, LLMRequestMessage, Tool } from '@core/types';
import type { AgentConfig, AgentAssembly, AgentPlugin } from '@agents/config';
import { deepMerge } from '@agents/config-diff';
import { getCredential, getGlobalCredential } from '@agents/credential-store';
import type { AgentRouter } from '@agents/router';
import type { PluginServices, PluginServiceContext } from '@plugins/types';
import { PluginRegistry } from '@plugins/registry';
import type { TimerManager, TimerEntry, GlobalTimerConfig } from '@plugins/builtin/services/timer';
import type { SubAgentManager } from '@plugins/builtin/services/subagent';
import builtinPlugin from '@plugins/builtin';
import mathPlugin from '@plugins/builtin-math';
import { createLLM as makeLLM } from '@core/llm';
import { agentOfDialog } from '@plugins/builtin/hooks/session';
import { isGroupDialog, groupIdOfDialog } from '@agents/paths';
import type { AgentRegistry } from '@agents/registry';
import { OPENAI_LLM_SCHEMA, DEEPSEEK_LLM_SCHEMA } from '../ui/llm-schemas';

const log = createLogger('[app:loader]');

// ============================================================
// 全局配置加载
// ============================================================

/** 全局配置默认值（照搬旧 core/config DEFAULTS，适配新架构） */
const CONFIG_DEFAULTS: Record<string, any> = {
  maxHops: 5,
  messageQueryDefaultLimit: 5,
  workspaceDir: 'workspace/default',
  agentsDir: '',
  sessionsDir: '',
  groupsDir: '',
  viewerId: 'user',
  llmProviders: {},
  searchProviders: {},
  allowedPaths: [],
  timezone: 'Asia/Shanghai',
  namespaces: {},
};

/** 工作区根绝对路径（与 L3 builtin workspaceRoot() 一致：AGENTCHAT_WORKSPACE 覆盖） */
export function workspaceRoot(wsOverride?: string): string {
  const ws = wsOverride ?? process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default';
  return path.isAbsolute(ws) ? ws : path.resolve(process.cwd(), ws);
}

/**
 * 加载全局配置：默认值 → <workspace>/config.json。
 * 命名空间键（含 "." 的顶层键，如 "tool.bash"）解析到 namespaces；
 * 非命名空间键直接挂载顶层；workspaceDir 覆盖时相对 cwd 解析。
 */
export function loadGlobalConfig(wsOverride?: string): Record<string, any> {
  const cfg: Record<string, any> = { ...CONFIG_DEFAULTS, namespaces: {} };
  const ws = workspaceRoot(wsOverride);
  cfg.workspaceDir = ws;

  const wsConfigPath = path.join(ws, 'config.json');
  if (fs.existsSync(wsConfigPath)) {
    try {
      const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
      for (const key of Object.keys(wsConfig)) {
        const val = wsConfig[key];
        if (val === undefined || val === null) continue;
        if (key.includes('.')) {
          // 命名空间键 → namespaces 字典
          cfg.namespaces[key] = val;
        } else if (key === 'workspaceDir') {
          // workspaceDir 覆盖（相对 → cwd 解析；绝对直接用）
          cfg.workspaceDir = path.isAbsolute(val) ? val : path.resolve(process.cwd(), val);
        } else {
          cfg[key] = val;
        }
      }
    } catch (err: any) {
      log.warn(`读取 ${wsConfigPath} 失败: ${err?.message ?? String(err)}`);
    }
  }

  // 派生路径（缺省从 workspaceDir 派生）
  const w = cfg.workspaceDir;
  if (!cfg.agentsDir) cfg.agentsDir = path.join(w, 'agents');
  if (!cfg.sessionsDir) cfg.sessionsDir = path.join(w, 'sessions');
  if (!cfg.groupsDir) cfg.groupsDir = path.join(w, 'groups');

  return cfg;
}

/** 构建全局配置基线（排除 $ 内部字段，展平 namespaces；Agent 差异合并用） */
export function buildGlobalBase(globalConfig: Record<string, any>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const key of Object.keys(globalConfig)) {
    if (!key.startsWith('$') && key !== 'namespaces') base[key] = globalConfig[key];
  }
  const ns = globalConfig.namespaces as Record<string, Record<string, unknown>> | undefined;
  if (ns) for (const [k, v] of Object.entries(ns)) base[k] = v;
  return base;
}

// ============================================================
// LLM / Search 池解析（照搬旧 loader：环境变量 → 池引用 → 凭据）
// ============================================================

/** 解析字符串中的 ${VAR_NAME} 环境变量引用 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => process.env[varName] ?? '');
}

/** 解析 LLM 配置：env var → credential lookup（池引用时从凭据库回注 api_key） */
function resolveLLMConfig(raw: LLMConfig, globalConfig: Record<string, any>, agentId?: string): LLMConfig {
  let apiKey = raw.api_key ? resolveEnvVars(raw.api_key) : '';
  // 池引用：从凭据库回注 api_key（config.json 中已被抽出）
  if (!apiKey) {
    const provider = (raw as any).$ref ? `pool:${(raw as any).$ref}` : (raw.provider ?? '');
    apiKey = (agentId ? getCredential(agentId, provider) : '') || getGlobalCredential(provider);
  }
  return {
    ...raw,
    api_key: apiKey,
    base_url: raw.base_url ? resolveEnvVars(raw.base_url) : undefined,
    model: raw.model ? resolveEnvVars(raw.model) : undefined,
  };
}

/** 从池中找 default:true 的条目名，没有则返回第一个，都没有则返回 null */
function detectDefaultPoolEntry(pools: Record<string, any>): string | null {
  const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
  if (entries.length === 0) return null;
  const def = entries.find(([_, v]) => v && (v as any).default);
  return def ? def[0] : entries[0][0];
}

/**
 * 解析 LLM 配置中的池引用（照搬旧 resolveLLMPool，五来源）。
 * @param agentId 可选：Agent 级凭据查找（loader 传 config.agent_id）
 */
export function resolveLLMPool(
  raw: LLMConfig | string | undefined,
  globalConfig: Record<string, any>,
  agentId?: string,
): LLMConfig | undefined {
  const pools = (globalConfig.llmProviders ?? {}) as Record<string, any>;

  // 自动检测：从池中找 default 条目，或第一个条目
  if (!raw) {
    const poolName = detectDefaultPoolEntry(pools);
    if (!poolName) return undefined;
    raw = poolName;
  }

  // 形式 1：纯字符串 = 池引用
  if (typeof raw === 'string') {
    const pool = pools[raw];
    if (!pool) {
      log.warn(`LLM 池条目 "${raw}" 未找到，将使用空配置`);
      return undefined;
    }
    // 保留 $ref 用于后续凭据查找
    return resolveLLMConfig({ ...pool, $ref: raw } as LLMConfig, globalConfig, agentId);
  }

  // 形式 2：$ref 引用 + 覆盖
  if (raw.$ref) {
    const poolName = raw.$ref;
    const pool = pools[poolName];
    if (!pool) {
      log.warn(`LLM 池条目 "${poolName}" 未找到，将使用内嵌配置`);
      return resolveLLMConfig(raw, globalConfig, agentId);
    }
    const { $ref, ...overrides } = raw;
    // 保留 $ref 用于后续凭据查找
    return resolveLLMConfig({ ...pool, ...overrides, $ref: poolName } as LLMConfig, globalConfig, agentId);
  }

  // 形式 3：传统内嵌 —— model 名称恰好匹配池条目时自动解析为池引用
  if (!raw.provider && !raw.base_url && raw.model) {
    const poolByName = pools[raw.model];
    if (poolByName) {
      log.info(`LLM model "${raw.model}" 匹配池条目，自动解析为池引用`);
      const { model, ...overrides } = raw;
      return resolveLLMConfig({ ...poolByName, ...overrides, $ref: raw.model } as LLMConfig, globalConfig, agentId);
    }
  }

  // 形式 4：传统内嵌（有 provider 或有 base_url）
  return resolveLLMConfig(raw, globalConfig, agentId);
}

/** 解析 search 命名空间配置（优先级：Agent 显式 > 池 default > 池首项） */
export function resolveSearchPool(
  nsConfig: Record<string, unknown> | undefined,
  globalConfig: Record<string, any>,
): Record<string, unknown> | undefined {
  const pools = (globalConfig.searchProviders ?? {}) as Record<string, any>;
  const entries = () => Object.entries(pools).filter(([k]) => !k.startsWith('$'));

  // 有显式配置（内嵌或 $ref）
  if (nsConfig) {
    const ref = nsConfig.$ref as string | undefined;
    if (!ref) {
      // 内嵌：无 provider/apiKey 时自动合并默认池条目（兼容简写）
      const hasApiKey = nsConfig.tavilyApiKey || nsConfig.serpapiApiKey || nsConfig.braveApiKey;
      if (!nsConfig.provider && !hasApiKey) {
        const list = entries();
        const def = list.find(([_, v]) => v && (v as any).default);
        const poolName = def ? def[0] : list[0]?.[0];
        if (poolName) {
          log.info(`Search 配置自动合并默认池 "${poolName}"`);
          return { ...pools[poolName], ...nsConfig, $ref: poolName };
        }
      }
      return nsConfig;
    }
    const pool = pools[ref];
    if (!pool) {
      log.warn(`搜索引擎条目 "${ref}" 未找到，将使用内嵌配置`);
      return nsConfig;
    }
    const { $ref: _, ...overrides } = nsConfig;
    return { ...pool, ...overrides, $ref: ref };
  }

  // 无配置：自动取池 default 或首项
  const list = entries();
  if (list.length === 0) return undefined;
  const def = list.find(([_, v]) => v && (v as any).default);
  const poolName = def ? def[0] : list[0][0];
  return { ...(pools[poolName] as Record<string, unknown>), $ref: poolName };
}

// ============================================================
// AgentLoader —— 扫描 agents/ 目录 → 有效 AgentConfig
// ============================================================

/**
 * 旧扁平字段 → 新 plugins 声明（历史配置兼容）。
 *
 * 旧架构 Agent 配置用扁平字段：tools / pre_hooks / post_hooks；
 * 新架构（L5）改用 AgentPlugin[]（工具 + 各阶段钩子聚合声明）。
 * 兼容转换：
 *   · tools          → plugins[0].tools（builtin 工具名不变，直接可用）
 *   · pre_hooks      → plugins[0].runStart（旧内置名 → 新 builtin.xxx 名）
 *   · post_hooks     → plugins[0].runEnd（旧内置名 → 新 builtin.xxx 名）
 * 未知名原样保留（解析不到则忽略，不破坏装配）。
 */
const LEGACY_RUN_START_MAP: Record<string, string> = {
  'agent-prompt': 'builtin.build-system-prompt',
  'agent-memory': 'builtin.load-memory',
  'agent-session': 'builtin.load-history',
};
const LEGACY_RUN_END_MAP: Record<string, string> = {
  'agent-memory': 'builtin.update-memory',
  'agent-session': 'builtin.save-session',
};

function legacyToPlugins(diff: Record<string, any>): AgentPlugin[] | undefined {
  const tools = Array.isArray(diff.tools) ? (diff.tools as string[]) : undefined;
  const pre = Array.isArray(diff.pre_hooks) ? (diff.pre_hooks as string[]) : [];
  const post = Array.isArray(diff.post_hooks) ? (diff.post_hooks as string[]) : [];
  if ((!tools || tools.length === 0) && pre.length === 0 && post.length === 0) {
    return undefined;
  }
  return [{
    name: 'legacy',
    tools,
    runStart: pre.length ? pre.map(n => LEGACY_RUN_START_MAP[n] ?? n) : undefined,
    runEnd: post.length ? post.map(n => LEGACY_RUN_END_MAP[n] ?? n) : undefined,
  }];
}

export class AgentLoader {
  constructor(private globalConfig: Record<string, any>) {}

  /** Agent 配置目录（来自全局配置） */
  get agentsDir(): string {
    return this.globalConfig.agentsDir;
  }

  /** 加载单个 Agent（按目录路径）—— 热重载/热加载用 */
  loadOne(agentDirPath: string): { config: AgentConfig } {
    const configPath = path.join(agentDirPath, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`[AgentLoader] ${agentDirPath} 中无 config.json`);
    }

    // 1. 读取 Agent 差异配置
    const agentDiff = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;

    // 2. 合并：全局基础 + Agent 差异 → 有效配置
    const config = deepMerge(buildGlobalBase(this.globalConfig), agentDiff) as unknown as AgentConfig;
    config.agent_id = agentDiff.agent_id;

    // 2.5 旧扁平字段（tools/pre_hooks/post_hooks）→ 新 plugins 声明（历史配置兼容；
    //     缺失时工具/钩子全空 → 模型无工具可用、定时任务无动作）
    if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
      const legacy = legacyToPlugins(agentDiff);
      if (legacy) config.plugins = legacy;
    }

    // 3. 解析 LLM 配置（Agent 覆盖优先 → 池默认 → 池第一个；注入 Agent 级凭据）
    const rawLlm = agentDiff.llm ?? (this.globalConfig as any).llm;
    const llmConfig = resolveLLMPool(rawLlm, this.globalConfig, config.agent_id);
    if (llmConfig) {
      config.llm = llmConfig;
      log.info(
        `Agent "${config.agent_id}" LLM: ${llmConfig.provider ?? '?'}/${llmConfig.model ?? 'default'}` +
        `(temp=${llmConfig.temperature ?? 'default'})`
      );
    }

    // 4. 解析 Search 池（tool.web_search 命名空间）
    const nsSearch = config['tool.web_search'];
    if (nsSearch !== undefined) {
      config['tool.web_search'] = resolveSearchPool(nsSearch as Record<string, unknown>, this.globalConfig);
    }

    log.info(`[AgentLoader] Loaded "${config.agent_id}"（plugins=${Array.isArray(config.plugins) ? config.plugins.length : 0}）`);
    return { config };
  }

  /** 加载全部 Agent */
  loadAll(): Array<{ config: AgentConfig }> {
    if (!fs.existsSync(this.agentsDir)) {
      log.warn(`未找到 Agents 目录：${this.agentsDir}`);
      return [];
    }
    const agentDirs = fs.readdirSync(this.agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(this.agentsDir, e.name));

    const results: Array<{ config: AgentConfig }> = [];
    for (const agentDir of agentDirs) {
      const configPath = path.join(agentDir, 'config.json');
      if (!fs.existsSync(configPath)) {
        log.warn(`[AgentLoader] ${agentDir} 中无 config.json，已跳过`);
        continue;
      }
      try {
        results.push(this.loadOne(agentDir));
      } catch (err: any) {
        log.warn(`[AgentLoader] 加载 ${agentDir} 失败: ${err?.message ?? String(err)}`);
      }
    }
    return results;
  }
}

// ============================================================
// 插件装配（builtin/builtin-math 注册 + 服务/上下文注入）
// ============================================================

export interface PluginSetupOptions {
  router: AgentRouter;
  /** 交互桥（L4 InteractionBridge，PluginServices.interaction） */
  interaction?: PluginServices['interaction'];
  /** 搜索 provider 池（全局配置 searchProviders） */
  searchProviders?: Record<string, Record<string, unknown>>;
  /** Agent 配置目录（agent-prompt 装配 AGENT.md 等） */
  agentsDir?: string;
  /** 定时特殊 hint __archive_all__ 回调（archive 未实现时可缺省） */
  archiveAll?: () => { length: number };
  /** 定时特殊 hint __backup_all__ 回调（services/backup createBackup） */
  backupAll?: () => { skipped: boolean; file?: string; size?: number };
}

export interface PluginSetupResult {
  pluginRegistry: PluginRegistry;
  services: PluginServices;
  timer?: TimerManager;
  subAgent?: SubAgentManager;
}

/** 注册插件 + 注入服务/装配上下文（timer/subagent 惰性装载并接线 router） */
export function setupPlugins(
  globalConfig: Record<string, any>,
  opts: PluginSetupOptions,
  registry?: PluginRegistry,
): PluginSetupResult {
  const pluginRegistry = registry ?? new PluginRegistry();

  // 注册插件（代码模块直接注册，无需磁盘发现）
  pluginRegistry.register(builtinPlugin);
  pluginRegistry.register(mathPlugin);

  const services: PluginServices = {
    router: opts.router,
    interaction: opts.interaction,
    searchProviders: opts.searchProviders,
    agentsDir: opts.agentsDir,
  };
  pluginRegistry.setServices(services);

  // 服务装配上下文（useService 工厂装载时传入）
  const agentTimerNs = (globalConfig.namespaces ?? {})['agent.timer'] as Record<string, unknown> | undefined;
  const serviceContext: PluginServiceContext = {
    workspaceDir: globalConfig.workspaceDir,
    agentsDir: globalConfig.agentsDir,
    timezone: globalConfig.timezone ?? 'Asia/Shanghai',
    holidays: agentTimerNs?.holidays as string[] | undefined,
    makeupWorkdays: agentTimerNs?.makeupWorkdays as string[] | undefined,
    globalTimer: (globalConfig.timer ?? globalConfig.chime) as GlobalTimerConfig,
    archiveAll: opts.archiveAll,
    backupAll: opts.backupAll,
  };
  pluginRegistry.setServiceContext(serviceContext);

  // 装载 timer + subagent（惰性单例），接线 router 事件总线
  const timer = pluginRegistry.useService<TimerManager>('timer');
  const subAgent = pluginRegistry.useService<SubAgentManager>('subagent');
  timer?.setRouter(opts.router);
  subAgent?.setEventBus(opts.router);

  // 第二轮注入（timer/subAgent 已装载）
  services.timer = timer;
  services.subAgent = subAgent;
  pluginRegistry.setServices(services);

  log.info(`插件已装配（timer=${timer ? 'ready' : 'none'}, subagent=${subAgent ? 'ready' : 'none'}）`);
  return { pluginRegistry, services, timer, subAgent };
}

// ============================================================
// AgentAssembly —— L2 装配依赖注入（router 构造用）
// ============================================================

export interface AssemblyDeps {
  pluginRegistry: PluginRegistry;
  /** 晚绑定 router（装配环：assembly → router → setServices(router)） */
  getRouter: () => AgentRouter;
  services: PluginServices;
  globalConfig: Record<string, any>;
}

/** 把 loop 事件包装为 router 'message' 事件（L5 传输层消费） */
function makeAgentEvent(
  type: string,
  payload: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  const dialogId = data?.dialogId as string | undefined;
  // 1v1 排序共享会话键后 dialogId 无法反推 Agent —— 优先显式 agentId（loop emitLoop 附加）
  const agentId = (data?.agentId as string | undefined)
    ?? (dialogId ? agentOfDialog(dialogId) : undefined)
    ?? (data?.agent as string | undefined)
    ?? 'system';
  return {
    from: agentId,
    to: 'user',
    type,
    payload,
    correlation_id: (data?.correlation_id as string) ?? (data?.cid as string),
    data,
    group_id: dialogId ? (isGroupDialog(dialogId) ? groupIdOfDialog(dialogId) : undefined) : data?.groupId,
  };
}

/**
 * 构建 AgentAssembly（L2 createAgentContext 的依赖注入实现）。
 * createLLM/resolveTools 每次投递时被调用，顺手把 services.llm/tools 更新为
 * "当前 Agent"（spawn_subagent 共享父 LLM/受控工具集的约定）。
 */
export function makeAgentAssembly(deps: AssemblyDeps): AgentAssembly {
  const { pluginRegistry, getRouter, services, globalConfig } = deps;

  return {
    // 解析 LLM：config.llm（内嵌/池引用/缺省）→ LLMProvider；credential 由 loader 预注入 + 全局兜底
    createLLM: (raw: LLMConfig | string) => {
      const resolved = resolveLLMPool(raw, globalConfig);
      const llm = makeLLM(resolved ?? {});
      services.llm = llm; // 当前 Agent 约定
      return llm as LLMProvider;
    },

    // 解析工具：L3 PluginRegistry（按名 + config tags/requires 过滤、per-Agent 烘焙）
    resolveTools: (names: string[] | undefined, config: AgentConfig): Map<string, Tool> => {
      const tools = pluginRegistry.resolveTools(names, config);
      services.tools = tools; // 当前 Agent 约定
      return tools;
    },

    // 加载会话历史：L3 builtin loadHistory 服务（<ws>/sessions/<dialogId>/messages.jsonl）
    loadHistory: (convKey: string): LLMRequestMessage[] => {
      const fn = pluginRegistry.useService<(c: string) => LLMRequestMessage[]>('loadHistory');
      return fn ? fn(convKey) : [];
    },

    // 解析钩子：L3 PluginRegistry.resolveHooks（按名收集、工厂烘焙）
    resolveHooks: (names, config) => pluginRegistry.resolveHooks(names, config),

    // 事件发射：包装为 router 'message' 事件（L5 server/ws 监听）
    emit: (type, payload, data) => {
      getRouter().emit('message', makeAgentEvent(type, payload, data));
    },

    // 系统提示词：L3 builtin buildSystemPrompt 服务
    systemPrompt: (config) => {
      const build = pluginRegistry.useService<(
        cfg: AgentConfig,
        deps: PluginServices,
        input?: { toolNames?: string[]; sender?: string; groupId?: string },
      ) => string>('buildSystemPrompt');
      return build ? build(config, services, { sender: 'user' }) : '';
    },
  };
}

// ============================================================
// 插件管理适配器（webui /api/plugins 用；bootstrap 注册为服务 'pluginManager'）
//
// 新架构：插件 = 代码模块（无旧式 tool/pre_hook/post_hook 扩展模型）。
//   · getAllPlugins —— pluginRegistry.listPlugins()（元数据）
//   · getLLMSchemas —— 复用 src/ui/llm-schemas（UI 层表单元数据）
//   · getAgentPlugins —— 从 registry 配置的 plugins 声明展平
// ============================================================

const HOOK_KINDS = ['runStart', 'runEnd', 'turnStart', 'turnEnd', 'toolExecutionStart', 'toolExecutionEnd', 'fallback'] as const;

export function makePluginManager(
  pluginRegistry: PluginRegistry,
  registry: AgentRegistry,
): Record<string, unknown> {
  return {
    getAllPlugins: () => pluginRegistry.listPlugins().map((p) => ({
      name: p.name,
      label: p.label,
      description: p.description ?? '',
      type: 'plugin',
      enabled: true,
    })),
    getConfigSchemas: () => ({}),
    getLLMSchemas: () => ({ openai: OPENAI_LLM_SCHEMA, deepseek: DEEPSEEK_LLM_SCHEMA }),
    getSearchSchemas: () => ({}),
    getAgentPlugins: (agentId: string) => {
      const cfg = registry.get(agentId);
      const plugins = cfg?.plugins ?? [];
      const items: Array<Record<string, unknown>> = [];
      for (const p of plugins) {
        const pluginName = p.name ?? 'builtin';
        for (const t of p.tools ?? []) items.push({ name: t, type: 'tool', enabled: true, plugin: pluginName });
        for (const kind of HOOK_KINDS) {
          for (const h of p[kind] ?? []) {
            items.push({ name: h, type: 'hook', kind, enabled: true, plugin: pluginName });
          }
        }
      }
      return items;
    },
  };
}
