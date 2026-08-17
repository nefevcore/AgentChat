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
import { createLogger } from '@agentchat/util';
import type { Context } from '@agentchat/cordis';
import type { Tool, AgentLoopEngine } from '@agentchat/agent-loop';
import type { LLMConfig, LLMProvider } from '@agentchat/llm';
import type { LLMRequestMessage } from '@agentchat/types';
import type { AgentConfig } from '@agentchat/agent-config';
import {
  CAPABILITY_ADMIN,
  collectToolNames,
  collectHookNames,
  resolveAgentDir,
  effectiveHookOrder,
  effectiveToolOverrides,
  normalizeCapabilityTags,
  readHookOrder,
  readToolOverrides,
  type HookNames,
} from '@agentchat/agent-config';
import type { AgentAssembly } from '@agentchat/agents';
import { deepMerge } from '@agentchat/agents';
import { getCredential, getGlobalCredential } from '@agentchat/agents';
import type { AgentRouter } from '@agentchat/router';
import type { PluginServices, ToolsService } from '@agentchat/tools';
import type { HooksService } from '@agentchat/hooks';
import { TimerManager, type TimerEntry, type GlobalTimerConfig } from '@agentchat/timer';
import { SubAgentManager } from '@agentchat/subagent';
import { agentOfDialog } from '@agentchat/agent-session';
import { loadHistory as loadHistoryImpl } from '@agentchat/agent-session';
import { buildSystemPrompt as buildSystemPromptImpl } from '@agentchat/agent-prompt';
import { BUILTIN_HOOK_CATALOG } from '@agentchat/hooks';
import { isGroupDialog, groupIdOfDialog } from '@agentchat/agents';
import type { AgentRegistry } from '@agentchat/agents';
import { OPENAI_LLM_SCHEMA, DEEPSEEK_LLM_SCHEMA, GLM_LLM_SCHEMA, OLLAMA_LLM_SCHEMA, SEARCH_PROVIDER_SCHEMAS } from './llm-schemas';
import { NS_TOOL_BASH, NS_AGENT_MCP, NS_AGENT_MEMORY, NS_AGENT_SESSION } from '@agentchat/toolkit';
import { BASH_CONFIG_SCHEMA } from '@agentchat/shell';
import { MCP_CONFIG_SCHEMA } from '@agentchat/agent-mcp';
import { MEMORY_CONFIG_SCHEMA } from '@agentchat/agent-memory';
import { SESSION_CONFIG_SCHEMA } from '@agentchat/agent-session';
import type {
  AgentToolInfo,
  AssemblyUpdate,
  AssemblyView,
  HookInfo,
  PluginCatalog,
  PluginInfo,
  PluginLibrary,
  PluginProvides,
  StagingRecord,
} from '@agentchat/protocol';
import {
  approveStaging,
  getOrCreatePluginHost,
  grantPermissions,
  listInstalled,
  listStaging,
  listStagingFiles,
  loadManifestFromDir,
  readStagingFile,
  rejectStaging,
  requiredGrants,
  stagePlugin,
  uninstallPlugin,
} from '@agentchat/plugins';
import { DEFAULT_GRANTED_PERMISSIONS, REVIEW_EXPLICIT_REQUIRED } from '@agentchat/plugins';
import { KNOWN_PERMISSIONS } from '@agentchat/agent-config';
import { PluginApiError } from '@agentchat/server/src/api/plugins-shared';
import type { PluginManager } from '@agentchat/server/src/api/plugins';

const log = createLogger('[app:loader]');

// ============================================================
// 全局配置加载
// ============================================================

/** 全局配置默认值（照搬旧 core/config DEFAULTS，适配新架构） */
const CONFIG_DEFAULTS: Record<string, any> = {
  maxHops: 5,
  messageQueryDefaultLimit: 20,
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

    // 2.5 装配意图归一化（读盘兼容旧字段；落盘迁移由 saveAssembly 执行）
    config.tools = effectiveToolOverrides(config);
    config.hooks = effectiveHookOrder(config);
    delete (config as Partial<AgentConfig>).disabledTools;
    delete (config as Partial<AgentConfig>).disabledHooks;

    // 2.6 能力标签归一化（旧 agent → base）+ 插件拆分迁移：
    //     存量 admin 配置曾以 agentchat-dev-tools 装载插件管理工具，
    //     拆分后自动补上 agentchat-plugin-tools preset 保持能力不丢。
    config.tags = normalizeCapabilityTags(config.tags);
    if (Array.isArray(config.presets)
      && config.presets.includes('agentchat-dev-tools')
      && !config.presets.includes('agentchat-plugin-tools')
      && (config.tags ?? []).includes(CAPABILITY_ADMIN)) {
      config.presets = [...config.presets, 'agentchat-plugin-tools'];
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

    log.info(`[AgentLoader] Loaded "${config.agent_id}"（presets=${Array.isArray(config.presets) ? config.presets.length : 0}, hooks=${config.hooks ? 'set' : 'none'}）`);
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
  /** ReAct 引擎入口（ctx.agentLoop；subagent 经构造器注入） */
  engine: AgentLoopEngine;
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
  services: PluginServices;
  timer?: TimerManager;
  subAgent?: SubAgentManager;
}

/** 注册插件 + 注入服务/装配上下文（timer/subagent 惰性装载并接线 router）
 * @param externalServices 可选：复用外部 services 实例（与 makeAgentAssembly 共享，
 *   保证 loader.createLLM 写入的 services.llm/tools 能被 registry 烘焙的工具读到）。
 *   缺省时新建内部实例（独立装配场景，如单测）。 */
export function setupPlugins(
  globalConfig: Record<string, any>,
  opts: PluginSetupOptions,
  externalServices?: PluginServices,
): PluginSetupResult {
  // 复用外部实例（app 装配时传入），或新建内部实例
  const services: PluginServices = externalServices ?? {};
  services.router = opts.router;
  services.interaction = opts.interaction;
  services.searchProviders = opts.searchProviders;
  services.agentsDir = opts.agentsDir;
  services.workspaceDir = globalConfig.workspaceDir;

  // 服务装配上下文（useService 工厂装载时传入）
  const agentTimerNs = (globalConfig.namespaces ?? {})['agent.timer'] as Record<string, unknown> | undefined;
  const serviceContext: Record<string, unknown> = {
    workspaceDir: globalConfig.workspaceDir,
    agentsDir: globalConfig.agentsDir,
    timezone: globalConfig.timezone ?? 'Asia/Shanghai',
    holidays: agentTimerNs?.holidays as string[] | undefined,
    makeupWorkdays: agentTimerNs?.makeupWorkdays as string[] | undefined,
    globalTimer: (globalConfig.timer ?? globalConfig.chime) as GlobalTimerConfig,
    archiveAll: opts.archiveAll,
    backupAll: opts.backupAll,
  };

  // 装载 timer + subagent（直接实例化），接线 router 事件总线
  const timer = new TimerManager({
    workspaceDir: serviceContext.workspaceDir as string,
    agentsDir: serviceContext.agentsDir as string,
    timezone: serviceContext.timezone as string | undefined,
    holidays: serviceContext.holidays as string[] | undefined,
    makeupWorkdays: serviceContext.makeupWorkdays as string[] | undefined,
    globalTimer: serviceContext.globalTimer as never,
    archiveAll: serviceContext.archiveAll as (() => { length: number }) | undefined,
    backupAll: serviceContext.backupAll as (() => { skipped: boolean; file?: string; size?: number }) | undefined,
  });
  const subAgent = new SubAgentManager(opts.engine);
  timer.setRouter(opts.router);
  subAgent.setEventBus(opts.router);

  // 第二轮注入（timer/subAgent 已装载）
  services.timer = timer;
  services.subAgent = subAgent;

  log.info(`插件已装配（timer=${timer ? 'ready' : 'none'}, subagent=${subAgent ? 'ready' : 'none'}）`);
  return { services, timer, subAgent };
}

// ============================================================
// AgentAssembly —— L2 装配依赖注入（router 构造用）
// ============================================================

/**
 * AgentAssembly 装配依赖（boot 宿主层实现注入面）。
 *
 * 必须项由 AgentAssembly 接口保证：
 *   engine / createLLM / resolveTools / resolveHooks / loadHistory
 * 宿主层额外注入：
 *   emit / systemPrompt / reloadAgents / requestRestart / workspaceDir
 */
export interface AgentAssemblyDeps {
  /** cordis 上下文（第三阶段：Assembly 全部经 ctx 服务，必填） */
  ctx: Context;
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

/** 从全局配置提取密钥字段值（llm.api_key / 池条目 api_key / 搜索池 apiKey），供输出脱敏用 */
function collectConfigSecrets(globalConfig: Record<string, any>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v.length > 0) out.push(v); };
  push(globalConfig?.llm?.api_key);
  for (const p of Object.values(globalConfig?.llmProviders ?? {})) {
    if (p && typeof p === 'object') push((p as any).api_key);
  }
  for (const p of Object.values(globalConfig?.searchProviders ?? {})) {
    if (p && typeof p === 'object') {
      push((p as any).tavilyApiKey);
      push((p as any).serpapiApiKey);
      push((p as any).braveApiKey);
    }
  }
  return out;
}

/**
 * 构建 AgentAssembly（L2 createAgentContext 的依赖注入实现）。
 * createLLM/resolveTools 每次投递时被调用，顺手把 services.llm/tools 更新为
 * "当前 Agent"（subagent 共享父 LLM/受控工具集的约定）。
 */
export function makeAgentAssembly(deps: AgentAssemblyDeps): AgentAssembly {
  const { getRouter, services, globalConfig } = deps;
  // 脱敏 secrets 经 ToolContext 注入 security.redact-output 钩子工厂
  services.redactSecrets = collectConfigSecrets(globalConfig);

  return {
    workspaceDir: globalConfig.workspaceDir,
    // ReAct 引擎入口（ctx.agentLoop 服务；契约化后引擎不直接 import）
    engine: deps.ctx.agentLoop,
    // 解析 LLM：config.llm（内嵌/池引用/缺省）→ LLMProvider；credential 由 loader 预注入 + 全局兜底
    createLLM: (raw: LLMConfig | string) => {
      const resolved = resolveLLMPool(raw, globalConfig);
      const llm = deps.ctx.llm.create(resolved ?? {});
      services.llm = llm; // 当前 Agent 约定
      return llm as LLMProvider;
    },

    // 解析工具：ctx.tools（插件化注册；config 为 presets/tools 单一意图来源）
    resolveTools: (config: AgentConfig): Map<string, Tool> => {
      const tools = deps.ctx.tools.resolveTools(config, services);
      services.tools = tools; // 当前 Agent 约定
      return tools;
    },

    // 加载会话历史：ext 直连（<ws>/sessions/<dialogId>/messages.jsonl）
    loadHistory: (convKey: string): LLMRequestMessage[] => loadHistoryImpl(convKey),

    // 解析钩子：ctx.hooks（插件化注册；config.hooks = 启用清单）
    resolveHooks: (config) => deps.ctx.hooks.collect(config, services),

    // 事件发射：包装为 router 'message' 事件（L5 server/ws 监听）
    emit: (type, payload, data) => {
      getRouter().emit('message', makeAgentEvent(type, payload, data));
    },

    // 系统提示词：ext 直连（角色/标签/指引/存储/对话信息装配）
    systemPrompt: (config) => buildSystemPromptImpl(config, services, { sender: 'user' }),
  };
}

// ============================================================
// 插件管理适配器（webui /api/plugins 用；bootstrap 注册为服务 'pluginManager'）
//
// P1（UI/Web 插件化）：
//   · getAssembly/saveAssembly —— 新契约装配视图（presets/tools/hooks）+ 归一化 + 热重载
//   · getCatalog —— 插件/钩子/工具全量目录（单真相源）
//   · getLibrary + stage/approve/reject/uninstall —— 插件库生命周期
//   · getSessionPlugins/reload/unload —— 会话级开发插件
// ============================================================

const HOOK_KINDS = ['runStart', 'runEnd', 'stepStart', 'stepEnd', 'toolExecutionStart', 'toolExecutionEnd', 'fallback'] as const;
const HOOK_KINDS_SET = new Set<string>(HOOK_KINDS);

/** 钩子 kind → 前端分组类型（runStart=前置, runEnd=后置, 其余归 hook） */
const HOOK_TYPE_MAP: Record<string, 'pre_hook' | 'post_hook' | 'hook'> = {
  runStart: 'pre_hook',
  runEnd: 'post_hook',
  stepStart: 'hook',
  stepEnd: 'hook',
  toolExecutionStart: 'hook',
  toolExecutionEnd: 'hook',
  fallback: 'hook',
};

/** 内置插件目录（静态行清单；provides 在 getCatalog 里按注册中心 owner 反查补全） */
const BUILTIN_PLUGIN_CATALOG: Array<{ name: string; label: string; description: string }> = [
  { name: 'agentchat-fs-tools', label: '文件', description: 'read/write/edit 文件工具' },
  { name: 'agentchat-shell-tools', label: 'Shell', description: 'bash 命令执行工具' },
  { name: 'agentchat-web-tools', label: '网络', description: 'web_search/browser 工具' },
  { name: 'agentchat-dev-tools', label: '开发', description: 'code_search/read_logs/reload 开发调试工具' },
  { name: 'agentchat-plugin-tools', label: '插件管理', description: 'register_tool/register_plugin/unregister_plugin/publish_plugin（admin）' },
  { name: 'agentchat-session-tools', label: '会话', description: 'query_history/inspect_session/continue_turn' },
  { name: 'agentchat-restart-tools', label: '重启', description: 'system_restart 后端重启工具' },
  { name: 'agentchat-interaction-tools', label: '交互', description: 'ask_questions 用户询问工具' },
  { name: 'agentchat-agent-tools', label: '协作', description: 'send_agent/list_agents 等多 Agent 工具' },
  { name: 'agentchat-timer-tools', label: '定时', description: 'timer 定时任务工具' },
  { name: 'agentchat-subagent-tools', label: '子代理', description: 'subagent 委托工具' },
  { name: 'agentchat-math', label: '数学', description: 'math（vm 沙箱求值）' },
  { name: 'agentchat-hooks', label: '钩子', description: 'hooks.log-tool 工具执行日志' },
  { name: 'agentchat-agent-prompt', label: '提示词', description: 'build-system-prompt 钩子' },
  { name: 'agentchat-agent-session', label: '会话钩子', description: 'load-history/save-session/idle-reset/archive/log-usage' },
  { name: 'agentchat-agent-memory', label: '记忆', description: 'load-memory/update-memory 钩子' },
  { name: 'agentchat-agent-mcp', label: 'MCP', description: 'open-mcp 钩子' },
  { name: 'agentchat-agent-skill', label: '技能', description: 'discovered_skills 钩子' },
  { name: 'agentchat-security', label: '安全', description: 'security-check 钩子 + 输出脱敏' },
];

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new PluginApiError(400, `${label} 必须是字符串数组`);
  }
  return [...new Set(value as string[])];
}

/** 校验并归一化 tools 意图覆盖（PUT assembly 请求体/写盘用） */
function requireToolOverrides(value: unknown): { include?: string[]; exclude?: string[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginApiError(400, `tools 必须是 { include?: string[], exclude?: string[] } 对象（旧契约 string[] 请先迁移为 { include }）`);
  }
  const obj = value as Record<string, unknown>;
  const include = obj.include !== undefined ? requireStringArray(obj.include, 'tools.include') : undefined;
  const exclude = obj.exclude !== undefined ? requireStringArray(obj.exclude, 'tools.exclude') : undefined;
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

function validateHooksPatch(
  value: unknown,
  label = 'hooks',
): Partial<Record<(typeof HOOK_KINDS)[number], string[]>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginApiError(400, `${label} 必须是 { runStart?: string[], ... } 对象（七类启用清单）`);
  }
  const out: Partial<Record<(typeof HOOK_KINDS)[number], string[]>> = {};
  for (const [kind, list] of Object.entries(value as Record<string, unknown>)) {
    if (!HOOK_KINDS_SET.has(kind)) {
      throw new PluginApiError(400, `${label} 含未知阶段 "${kind}"（可选：${HOOK_KINDS.join('/')}）`);
    }
    out[kind as (typeof HOOK_KINDS)[number]] = requireStringArray(list, `${label}.${kind}`);
  }
  return out;
}

/** PluginManager 装配依赖（P1：热重载经 AgentService；boot 在服务就绪后注入） */
export interface PluginManagerDeps {
  agentService?: { hotReloadAgent(agentId: string, agentDir: string): void };
}

export function makePluginManager(
  registry: AgentRegistry,
  globalConfig: Record<string, any>,
  ctx?: Context,
  deps: PluginManagerDeps = {},
): PluginManager {
  const workspaceDir: string = globalConfig.workspaceDir ?? workspaceRoot();
  const host = ctx ? getOrCreatePluginHost(ctx) : undefined;
  // 用 ctx.get 可选读取：PluginManager 由 boot-finalize 插件 fiber 构造，
  // 该 fiber 未 inject tools/hooks，直接属性访问会被 cordis 拒绝。
  const toolsService = ctx?.get?.('tools') as ToolsService | undefined;
  const hooksService = ctx?.get?.('hooks') as HooksService | undefined;
  const catalogBase = buildGlobalBase(globalConfig) as AgentConfig;

  // ---- 目录构造辅助 ----

  /** manifest.provides（声明优先）与 ToolsService/HooksService owner 反查（补漏）合并 */
  function computeProvides(name: string, manifest: { provides?: { tools: string[]; hooks: string[] } }): PluginProvides {
    const tools = new Set<string>(manifest.provides?.tools ?? []);
    const hooks = new Set<string>(manifest.provides?.hooks ?? []);
    if (toolsService) {
      for (const tool of toolsService.listByOwner(name, catalogBase, {})) tools.add(tool.name);
    }
    if (hooksService) {
      for (const hook of hooksService.listByOwner(name)) hooks.add(hook);
    }
    return { tools: [...tools], hooks: [...hooks] };
  }

  function basePluginInfo(
    manifest: { name: string; version: string; description?: string; author?: string; entry?: string; permissions?: any[] },
    source: PluginInfo['source'],
  ): PluginInfo {
    return {
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      version: manifest.version,
      source,
      ...(manifest.permissions ? { permissions: manifest.permissions as PluginInfo['permissions'] } : {}),
      ...(manifest.entry ? { entry: manifest.entry } : {}),
    };
  }

  /** 开发目录扫描：只扫 <ws>/plugins/<agentId>/* 一层（契约 §6 风险 3） */
  function scanDevPlugins(): PluginInfo[] {
    const root = path.join(workspaceDir, 'plugins');
    if (!fs.existsSync(root)) return [];
    const out: PluginInfo[] = [];
    for (const agentEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!agentEntry.isDirectory() || agentEntry.name.startsWith('.')) continue;
      const agentDir = path.join(root, agentEntry.name);
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(agentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('.')) continue;
        const dir = path.join(agentDir, child.name);
        try {
          const manifest = loadManifestFromDir(dir);
          out.push({
            ...basePluginInfo(manifest, 'dev'),
            label: manifest.name,
            owner: agentEntry.name,
            dir,
            provides: computeProvides(manifest.name, manifest),
          });
        } catch { /* 损坏 manifest 跳过（不阻断目录） */ }
      }
    }
    return out;
  }

  /** 同名合并（优先级：session > dev > installed > builtin；按列表顺序覆盖） */
  function mergePlugins(...lists: PluginInfo[][]): PluginInfo[] {
    const map = new Map<string, PluginInfo>();
    for (const list of lists) {
      for (const p of list) map.set(p.name, p);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- ② 全量目录 ----

  function getCatalog(): PluginCatalog {
    const installed: PluginInfo[] = listInstalled(workspaceDir).map((record) => ({
      ...basePluginInfo(record.manifest, 'installed'),
      label: record.manifest.name,
      owner: record.owner,
      installedAt: record.installedAt,
      dir: path.join(workspaceDir, 'plugins', record.dir),
      grantedPermissions: record.permissions ?? [...DEFAULT_GRANTED_PERMISSIONS],
      provides: computeProvides(record.manifest.name, record.manifest),
    }));
    const session: PluginInfo[] = (host?.list() ?? [])
      .filter((record) => record.sessionOnly)
      .map((record) => ({
        ...basePluginInfo(record.manifest, 'session'),
        label: record.manifest.name,
        owner: record.agentId,
        dir: record.dir,
        grantedPermissions: record.allowedPermissions,
        provides: computeProvides(record.manifest.name, record.manifest),
      }));
    const builtin: PluginInfo[] = BUILTIN_PLUGIN_CATALOG.map((p) => ({
      name: p.name,
      label: p.label,
      description: p.description,
      source: 'builtin' as const,
      provides: computeProvides(p.name, {}),
    }));

    const hooks: HookInfo[] = (hooksService ? hooksService.listCatalog() : []).map(({ kind, name, entry, order }) => {
      const meta = (BUILTIN_HOOK_CATALOG as Record<string, (typeof BUILTIN_HOOK_CATALOG)[string] | undefined>)[name];
      return {
        name,
        kind: kind as HookInfo['kind'],
        label: meta?.label ?? name,
        ...(meta?.description ? { description: meta.description } : {}),
        owner: entry.owner ?? 'builtin',
        order,
        ...(entry.automatic ? { automatic: true } : {}),
        ...(meta?.configNs ? { configNs: meta.configNs } : {}),
        ...(meta?.security ? { security: meta.security } : {}),
      };
    });

    const tools: AgentToolInfo[] = (toolsService ? toolsService.listCatalog(catalogBase, {}) : []).map(({ tool, owner }) => ({
      name: tool.name,
      label: (tool as any).label ?? tool.name,
      description: (tool as any).description ?? '',
      requires: (tool as any).requires ?? [],
      ns: (tool as any).ns ?? '',
      ...(owner ? { owner } : {}),
    }));

    return { plugins: mergePlugins(session, scanDevPlugins(), installed, builtin), hooks, tools };
  }

  // ---- ① AssemblyView + 旧契约归一化 ----

  interface LegacyDerived {
    presets: string[];
    tools: string[];
    hooks: HookNames;
  }

  function deriveLegacyAssembly(cfg: AgentConfig, catalog: PluginCatalog): LegacyDerived {
    const toolNames = collectToolNames(cfg.plugins) ?? [];
    const hookNames = collectHookNames(cfg.plugins);
    const toolOwner = new Map(catalog.tools.filter((t) => t.owner).map((t) => [t.name, t.owner!]));
    const hookOwner = new Map(catalog.hooks.filter((h) => h.owner).map((h) => [h.name, h.owner]));
    const presets = new Set<string>();
    for (const name of toolNames) {
      const owner = toolOwner.get(name);
      if (owner) presets.add(owner);
    }
    for (const list of Object.values(hookNames)) {
      for (const name of list ?? []) {
        const owner = hookOwner.get(name);
        if (owner) presets.add(owner);
      }
    }
    return { presets: [...presets], tools: toolNames, hooks: hookNames };
  }

  /** 读盘级归一化：旧 plugins/tools[]/disabledTools/disabledHooks → 新契约（原地修改，返回是否迁移） */
  function normalizeRawAssembly(raw: Record<string, any>, cfg: AgentConfig, catalog: PluginCatalog): boolean {
    let migrated = false;

    if (Array.isArray(raw.plugins) && !Array.isArray(raw.presets)) {
      const derived = deriveLegacyAssembly(cfg, catalog);
      raw.presets = derived.presets;
      raw.tools = { include: derived.tools };
      raw.hooks = derived.hooks;
      delete raw.plugins;
      migrated = true;
    }

    // 旧 tools: string[] → { include }
    if (Array.isArray(raw.tools)) {
      const include = [...new Set(raw.tools.filter((v: unknown): v is string => typeof v === 'string'))];
      raw.tools = include.length > 0 ? { include } : {};
      migrated = true;
    }

    // 旧 disabledTools → tools.exclude
    if (raw.disabledTools !== undefined) {
      const exclude = Array.isArray(raw.disabledTools)
        ? [...new Set(raw.disabledTools.filter((v: unknown): v is string => typeof v === 'string'))]
        : [];
      const current = readToolOverrides(raw.tools);
      raw.tools = { ...current, ...(exclude.length > 0 ? { exclude } : {}) };
      delete raw.disabledTools;
      migrated = true;
    }

    // 旧 disabledHooks → 从 hooks 启用清单剔除
    if (raw.disabledHooks !== undefined) {
      raw.hooks = readHookOrder(raw.hooks, raw.disabledHooks);
      delete raw.disabledHooks;
      migrated = true;
    }

    // 统一落新形态（读入未知字段丢弃）
    raw.tools = readToolOverrides(raw.tools);
    raw.hooks = readHookOrder(raw.hooks);

    // 能力标签：旧 agent → base；去重
    if (Array.isArray(raw.tags)) {
      const tags = normalizeCapabilityTags(raw.tags);
      if (JSON.stringify(tags) !== JSON.stringify(raw.tags)) {
        raw.tags = tags;
        migrated = true;
      }
    }

    // 插件拆分迁移：admin 配置自动补 agentchat-plugin-tools
    if (Array.isArray(raw.presets)
      && raw.presets.includes('agentchat-dev-tools')
      && !raw.presets.includes('agentchat-plugin-tools')
      && Array.isArray(raw.tags)
      && raw.tags.includes(CAPABILITY_ADMIN)) {
      raw.presets = [...raw.presets, 'agentchat-plugin-tools'];
      migrated = true;
    }

    return migrated;
  }

  /** 按 owner 修剪不属于当前 presets 的 tools/hooks 意图条目（避免死配置） */
  function pruneAssemblyEntries(raw: Record<string, any>, presets: string[], catalog: PluginCatalog): void {
    const presetSet = new Set(presets);
    const toolOwner = new Map(catalog.tools.filter((t) => t.owner).map((t) => [t.name, t.owner!]));
    const hookOwner = new Map(catalog.hooks.filter((h) => h.owner).map((h) => [h.name, h.owner]));
    const prune = (names: string[] | undefined, owners: Map<string, string>): string[] =>
      (names ?? []).filter((n) => {
        const owner = owners.get(n);
        return !owner || presetSet.has(owner);
      });

    const tools = readToolOverrides(raw.tools);
    const include = prune(tools.include, toolOwner);
    const exclude = prune(tools.exclude, toolOwner);
    raw.tools = {
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    };

    const order = readHookOrder(raw.hooks);
    const pruned: HookNames = {};
    for (const kind of HOOK_KINDS) {
      const list = prune(order[kind], hookOwner);
      if (list.length > 0) pruned[kind] = list;
    }
    raw.hooks = pruned;
  }

  function getAssembly(agentId: string): AssemblyView | null {
    const cfg = registry.get(agentId);
    if (!cfg) return null;
    const legacy = !!cfg.plugins && !cfg.presets;
    const derived = legacy ? deriveLegacyAssembly(cfg, getCatalog()) : undefined;
    const presets = cfg.presets ?? derived?.presets ?? [];
    const overrides = effectiveToolOverrides(cfg);
    const order = effectiveHookOrder(cfg);
    const enabled = toolsService ? [...toolsService.resolveTools(cfg, {}).keys()] : [];
    const catalog = getCatalog();
    return {
      agentId,
      presets: [...presets],
      available: catalog.plugins.filter((p) => p.source !== 'builtin' && !presets.includes(p.name)),
      hooks: { order: { ...order }, catalog: catalog.hooks },
      tools: {
        include: [...(overrides.include ?? [])],
        exclude: [...(overrides.exclude ?? [])],
        enabled,
        catalog: catalog.tools,
      },
      ...(legacy ? { legacy: { hasPlugins: true } } : {}),
    };
  }

  function saveAssembly(agentId: string, patch: AssemblyUpdate): { success: true; assembly: AssemblyView; migrated?: boolean } {
    if (!registry.get(agentId)) throw new PluginApiError(404, `Agent "${agentId}" 未找到`);
    const agentDir = resolveAgentDir(agentId, globalConfig.agentsDir) ?? path.join(globalConfig.agentsDir, agentId);
    const configPath = path.join(agentDir, 'config.json');
    if (!fs.existsSync(configPath)) throw new PluginApiError(404, `Agent "${agentId}" 的配置文件不存在`);

    const originalText = fs.readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(originalText) as Record<string, any>;

    // 旧契约 → 新契约（plugins → presets/tools/hooks；disabled* 并入单一意图）
    const migrated = normalizeRawAssembly(raw, registry.get(agentId)!, getCatalog());

    if (patch.presets !== undefined) raw.presets = requireStringArray(patch.presets, 'presets');
    if (patch.tools !== undefined) {
      const next = requireToolOverrides(patch.tools);
      const current = readToolOverrides(raw.tools);
      raw.tools = {
        ...(next.include !== undefined ? { include: next.include } : (current.include ? { include: current.include } : {})),
        ...(next.exclude !== undefined ? { exclude: next.exclude } : (current.exclude ? { exclude: current.exclude } : {})),
      };
    }
    if (patch.hooks !== undefined) {
      const hooks = validateHooksPatch(patch.hooks, 'hooks');
      raw.hooks = { ...readHookOrder(raw.hooks), ...hooks };
    }

    // 启用清单按 owner 修剪（插件未启用时其 tools/hooks 意图条目直接移除）
    pruneAssemblyEntries(raw, Array.isArray(raw.presets) ? raw.presets : [], getCatalog());

    // 原子写盘：临时文件 + rename（契约 §6 风险 4）；reload 失败回滚原文件
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    try {
      fs.renameSync(tmpPath, configPath);
    } catch (err: any) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      throw new PluginApiError(500, `装配配置写盘失败: ${err?.message ?? String(err)}`);
    }

    try {
      deps.agentService?.hotReloadAgent(agentId, agentDir);
    } catch (err: any) {
      fs.writeFileSync(configPath, originalText, 'utf-8');
      throw new PluginApiError(500, `热重载失败，已回滚配置: ${err?.message ?? String(err)}`);
    }

    host?.notifyAssemblyChanged(agentId);
    const assembly = getAssembly(agentId)!;
    return { success: true, assembly, ...(migrated ? { migrated: true } : {}) };
  }

  // ---- ③④⑥ 插件库 / 会话 / 暂存 ----

  function toStagingRecord(record: ReturnType<typeof listStaging>[number]): StagingRecord {
    return {
      id: record.id,
      manifest: {
        name: record.manifest.name,
        version: record.manifest.version,
        ...(record.manifest.entry ? { entry: record.manifest.entry } : {}),
        ...(record.manifest.permissions ? { permissions: record.manifest.permissions } : {}),
      },
      sourceDir: record.sourceDir,
      hash: record.hash,
      owner: record.owner,
      createdAt: record.createdAt,
      requiredGrants: record.requiredGrants ?? requiredGrants(record.manifest),
    };
  }

  function installedInfo(name: string): PluginInfo {
    const record = listInstalled(workspaceDir).find((r) => r.manifest.name === name);
    if (!record) throw new PluginApiError(500, `插件 "${name}" 安装记录缺失（registry 写盘异常）`);
    return {
      ...basePluginInfo(record.manifest, 'installed'),
      label: record.manifest.name,
      owner: record.owner,
      installedAt: record.installedAt,
      dir: path.join(workspaceDir, 'plugins', record.dir),
      grantedPermissions: record.permissions ?? [...DEFAULT_GRANTED_PERMISSIONS],
      provides: computeProvides(record.manifest.name, record.manifest),
    };
  }

  function getLibrary(): PluginLibrary {
    return {
      installed: listInstalled(workspaceDir).map((record) => ({
        ...basePluginInfo(record.manifest, 'installed'),
        label: record.manifest.name,
        owner: record.owner,
        installedAt: record.installedAt,
        dir: path.join(workspaceDir, 'plugins', record.dir),
        grantedPermissions: record.permissions ?? [...DEFAULT_GRANTED_PERMISSIONS],
        provides: computeProvides(record.manifest.name, record.manifest),
      })),
      staging: listStaging(workspaceDir).map(toStagingRecord),
    };
  }

  function stagePluginForLibrary(dir: string, owner: string): StagingRecord {
    const record = stagePlugin(workspaceDir, dir, owner);
    host?.notifyCatalogChanged('staging');
    return toStagingRecord(record);
  }

  async function approvePluginForLibrary(id: string, grants?: unknown): Promise<PluginInfo> {
    const approved = approveStaging(workspaceDir, id, grants);
    if (host) {
      try {
        await host.load({
          manifest: approved.manifest,
          dir: approved.installedDir,
          agentId: approved.manifest.author,
          sessionOnly: false,
          allowedPermissions: approved.permissions,
        });
      } catch (err: any) {
        // 安装记录已落盘（人审已通过）；即时装载失败仅告警，重启扫描会再次尝试
        ctx?.logger?.('plugins').warn(`插件 "${approved.name}" 已安装，但即时装载失败: ${err?.message ?? String(err)}`);
      }
    }
    host?.notifyCatalogChanged('installed');
    return installedInfo(approved.name);
  }

  function rejectPluginForLibrary(id: string): { success: true } {
    rejectStaging(workspaceDir, id);
    host?.notifyCatalogChanged('staging');
    return { success: true };
  }

  async function uninstallPluginFromLibrary(name: string): Promise<{ success: true; backupDir?: string }> {
    const result = uninstallPlugin(workspaceDir, name);
    const unloaded = host?.has(name) ? await host.unload(name) : false;
    if (!unloaded) host?.notifyCatalogChanged('installed');
    return { success: true, ...(result.backupDir ? { backupDir: result.backupDir } : {}) };
  }

  function getSessionPlugins(): PluginInfo[] {
    return (host?.list() ?? [])
      .filter((record) => record.sessionOnly)
      .map((record) => ({
        ...basePluginInfo(record.manifest, 'session'),
        label: record.manifest.name,
        owner: record.agentId,
        grantedPermissions: record.allowedPermissions,
        provides: computeProvides(record.manifest.name, record.manifest),
      }));
  }

  async function reloadSessionPlugin(name: string): Promise<{ status: 'loaded' | 'replaced' }> {
    if (!host) throw new PluginApiError(404, 'PluginHost 未初始化');
    const result = await host.reload(name);
    return { status: result.status === 'loaded' ? 'loaded' : 'replaced' };
  }

  async function unloadSessionPlugin(name: string): Promise<{ success: true }> {
    if (!host) throw new PluginApiError(404, 'PluginHost 未初始化');
    const record = host.get(name);
    if (!record) throw new PluginApiError(404, `会话插件 "${name}" 未加载`);
    if (!record.sessionOnly) {
      throw new PluginApiError(409, `插件 "${name}" 是全局安装插件，请使用 /library/${name}/uninstall`);
    }
    await host.unload(name);
    // 与 unregister_plugin 工具语义一致：回收 owner Agent 的 presets 引用
    await syncSessionPreset(record.agentId, name, false);
    return { success: true };
  }

  /** 会话级注册/卸载后同步 owner Agent 的 presets（找不到 Agent/配置时跳过，不阻断插件生命周期） */
  async function syncSessionPreset(owner: string | undefined, name: string, enable: boolean): Promise<void> {
    if (!owner || !registry.get(owner)) return;
    try {
      const current = registry.get(owner)!.presets ?? [];
      const next = enable
        ? (current.includes(name) ? current : [...current, name])
        : current.filter((n) => n !== name);
      if (next.length === current.length) return;
      saveAssembly(owner, { presets: next });
    } catch (err: any) {
      ctx?.logger?.('plugins').warn(`会话插件 "${name}" 同步 Agent "${owner}" presets 失败: ${err?.message ?? String(err)}`);
    }
  }

  /** P3：把开发目录插件加载为会话级（dev 卡片“注册会话”；不写 Agent presets，
   * 启用需到 Agent 面板插件组勾选对应 preset） */
  async function registerSessionPlugin(
    dir: string,
    owner?: string,
    grants?: unknown,
    watch = true,
  ): Promise<{ status: 'loaded' | 'replaced'; plugin: PluginInfo }> {
    if (typeof dir !== 'string' || dir.trim() === '') throw new PluginApiError(400, 'dir 必填');
    if (!host) throw new PluginApiError(503, 'PluginHost 未初始化');
    const manifest = loadManifestFromDir(dir.trim());
    const result = await host.load({
      manifest,
      dir: dir.trim(),
      agentId: owner,
      sessionOnly: true,
      allowedPermissions: grantPermissions(grants),
      watch,
    });
    if (result.status === 'replaced') host.notifyCatalogChanged('session');
    const record = host.get(manifest.name);
    if (!record) throw new PluginApiError(500, `会话插件 "${manifest.name}" 加载记录缺失`);
    // 与 register_plugin 工具语义一致：自动把插件名写入 owner Agent presets（saveAssembly 自带热重载 + WS）
    await syncSessionPreset(owner, manifest.name, true);
    return {
      status: result.status === 'restored' ? 'replaced' : result.status,
      plugin: {
        ...basePluginInfo(record.manifest, 'session'),
        label: record.manifest.name,
        owner: record.agentId,
        dir: record.dir,
        grantedPermissions: record.allowedPermissions,
        provides: computeProvides(record.manifest.name, record.manifest),
      },
    };
  }

  // ---- 返回 PluginManager（新契约 + 兼容期旧方法） ----

  return {
    getAllPlugins: () => BUILTIN_PLUGIN_CATALOG.map((p) => ({ ...p, type: 'plugin', enabled: true })),
    /** 配置命名空间 Schema：各领域包声明（随代码走），此处聚合收集 */
    getConfigSchemas: () => ({
      namespaces: {
        [NS_TOOL_BASH]: BASH_CONFIG_SCHEMA,
        [NS_AGENT_MCP]: MCP_CONFIG_SCHEMA,
        [NS_AGENT_MEMORY]: MEMORY_CONFIG_SCHEMA,
        [NS_AGENT_SESSION]: SESSION_CONFIG_SCHEMA,
      },
    }),
    getLLMSchemas: () => ({ openai: OPENAI_LLM_SCHEMA, deepseek: DEEPSEEK_LLM_SCHEMA, glm: GLM_LLM_SCHEMA, ollama: OLLAMA_LLM_SCHEMA }),
    getSearchSchemas: () => SEARCH_PROVIDER_SCHEMAS,
    getAgentPlugins: (agentId: string) => {
      const cfg = registry.get(agentId);
      // 新契约：hooks 启用清单；旧 plugins 聚合作为兼容回退
      const hookNames = effectiveHookOrder(cfg ?? ({} as AgentConfig));
      const enabledByKind: Record<string, Set<string>> = {};
      for (const kind of HOOK_KINDS) {
        const set = (enabledByKind[kind] ??= new Set());
        for (const h of hookNames[kind] ?? []) set.add(h);
      }
      const items: Array<Record<string, unknown>> = [];
      // 内置钩子目录（含未启用）：供前端"可用钩子"勾选
      for (const [name, meta] of Object.entries(BUILTIN_HOOK_CATALOG)) {
        items.push({
          name,
          label: meta.label,
          description: meta.description,
          type: HOOK_TYPE_MAP[meta.kind],
          kind: meta.kind,
          enabled: enabledByKind[meta.kind]?.has(name) ?? false,
          plugin: hooksService?.find(meta.kind, name)?.owner ?? 'builtin',
          configNs: meta.configNs,
          security: meta.security,
        });
      }
      // 启用的工具（显式 include；requires 默认启用的由 resolveTools 阶段装配）
      const overrides = effectiveToolOverrides(cfg ?? ({} as AgentConfig));
      for (const t of overrides.include ?? []) items.push({ name: t, type: 'tool', enabled: true, plugin: 'builtin' });
      return items;
    },
    /** 工具清单：全部目录 + 实际启用（presets 插件级过滤 + tags 门禁 + tools include/exclude） */
    getAgentTools: (agentId: string) => {
      const cfg = registry.get(agentId);
      const overrides = effectiveToolOverrides(cfg ?? ({} as AgentConfig));
      const explicit = [...(overrides.include ?? [])];
      const toolsSvc = toolsService;
      const enabledMap = toolsSvc ? toolsSvc.resolveTools(cfg ?? ({} as AgentConfig), {}) : new Map();
      const catalog = (toolsSvc ? toolsSvc.listAll(cfg ?? ({} as any), {}) : []).map((t) => ({
        name: t.name,
        label: (t as any).label ?? t.name,
        description: (t as any).description ?? '',
        requires: (t as any).requires ?? [],
        ns: (t as any).ns ?? '',
      }));
      return { catalog, enabled: Array.from(enabledMap.keys()), explicit };
    },
    /** 全局钩子目录（BUILTIN_HOOK_CATALOG 全量；全局无开关，仅作目录 + 默认配置入口） */
    getGlobalPlugins: () => {
      const items: Array<Record<string, unknown>> = [];
      for (const [name, meta] of Object.entries(BUILTIN_HOOK_CATALOG)) {
        items.push({
          name,
          label: meta.label,
          description: meta.description,
          type: HOOK_TYPE_MAP[meta.kind],
          kind: meta.kind,
          enabled: false,
          plugin: 'builtin',
          configNs: meta.configNs,
          security: meta.security,
        });
      }
      return items;
    },
    /** 全局工具目录（全局 tools include 声明；无自动注入，启用在各 Agent 按 presets/tags） */
    getGlobalTools: () => {
      const base = buildGlobalBase(globalConfig) as AgentConfig;
      const overrides = effectiveToolOverrides(base);
      const explicit = [...(overrides.include ?? [])];
      const catalog = (toolsService ? toolsService.listAll(base as import('@agentchat/agent-config').AgentConfig, {}) : []).map((t) => ({
        name: t.name,
        label: (t as any).label ?? t.name,
        description: (t as any).description ?? '',
        requires: (t as any).requires ?? [],
        ns: (t as any).ns ?? '',
      }));
      return { catalog, explicit };
    },

    // ---- P1 新契约 ----
    getAssembly,
    saveAssembly,
    getCatalog,
    getLibrary,
    stagePlugin: stagePluginForLibrary,
    approvePlugin: approvePluginForLibrary,
    rejectPlugin: rejectPluginForLibrary,
    uninstallPlugin: uninstallPluginFromLibrary,
    getSessionPlugins,
    reloadSessionPlugin,
    unloadSessionPlugin,
    registerSessionPlugin,
    getPermissions: () => ({
      vocabulary: [...KNOWN_PERMISSIONS],
      defaultGranted: [...DEFAULT_GRANTED_PERMISSIONS],
      // P1：ui 展示为需显式勾选（契约 §2.3），但执行期 gate 在 P5 接入
      explicitRequired: [...REVIEW_EXPLICIT_REQUIRED],
    }),
    getStagingTree: (id: string) => ({ files: listStagingFiles(workspaceDir, id) }),
    getStagingFile: (id: string, rel: string) => readStagingFile(workspaceDir, id, rel),
  };
}
