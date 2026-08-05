// ============================================================
// AgentLoader —— Agent 加载引擎（v0.5.0 架构重构）
//
// 职责：只负责 Agent 加载（文档目标结构：discovery/ ★ 拆分：只留 Agent 加载）。
// 全局插件发现/加载已移入 plugins/loader.ts（PluginLoader）。
//
// 工作流程：
//   1. 遍历 <workspace>/agents/ 下的所有子目录
//   2. 读取 config.json
//   3. 经 PluginLoader.scanAll() 获取全局工具/扩展（src/plugins/*/plugin.json 容器模式）
//   4. 扫描 <workspace>/agents/[name]/tools + extensions（Agent 专属插件，子目录模式）
//   5. 配置引用的工具/扩展找不到时 warn 并自动跳过（不阻塞启动）
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool, Extension, PreProcessHook, PostProcessHook, ToolInterceptor } from '@core/types';
import { AgentConfig, AgentBundle, LLMConfig } from './config-types';
import { PluginLoader, scanGlobalPlugins, discoverTools, discoverExtensions, selectToolsByRequires, mergeMaps } from '../plugins/loader';
import { getGlobalConfig } from '@core/config';
import { getCredential } from '@infra/credential-store';
import { deepMerge } from '@core/config-diff';
import { logger } from '../utils/logger';

// ============================================================
// 环境变量引用解析
// ============================================================

/** 解析字符串中的 ${VAR_NAME} 环境变量引用 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/** 解析 LLM 配置：env var → credential lookup（池引用时从凭据库回注 api_key） */
function resolveLLMConfig(raw: LLMConfig): LLMConfig {
  let apiKey = raw.api_key ? resolveEnvVars(raw.api_key) : '';
  // 池引用：从凭据库回注 api_key（config.json 中已被抽出）
  if (!apiKey && (raw as any).$ref) {
    const ref = (raw as any).$ref as string;
    apiKey = getCredential((raw as any)._agentId || '', `pool:${ref}`)
      || getCredential('__global__', `pool:${ref}`);
  }
  return {
    ...raw,
    api_key: apiKey,
    base_url: raw.base_url ? resolveEnvVars(raw.base_url) : undefined,
    model: raw.model ? resolveEnvVars(raw.model) : undefined,
  };
}

// ============================================================
// 模型管理解析
// ============================================================

/** 从池中找 default:true 的条目名，没有则返回第一个，都没有则返回 null */
function detectDefaultPoolEntry(): string | null {
  const pools = getGlobalConfig().llmProviders;
  const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
  if (entries.length === 0) return null;
  const def = entries.find(([_, v]) => v && (v as any).default);
  return def ? def[0] : entries[0][0];
}

/**
 * 解析 LLM 配置中的池引用。
 *
 * 支持五种来源（按优先级）：
 *   1. "pool-name"                     → 纯字符串引用
 *   2. { "$ref": "pool-name", ... }     → 引用 + 字段覆盖
 *   3. { "model": "pool-name" }         → model 名匹配池条目时自动解析为引用
 *   4. { "provider": "deepseek", ... }  → 传统内嵌（直接返回）
 *   5. undefined                        → 自动取池中 default:true 条目，否则取第一个
 */
export function resolveLLMPool(raw: LLMConfig | string | undefined): LLMConfig | undefined {
  // 自动检测：从池中找 default 条目，或第一个条目
  if (!raw) {
    raw = detectDefaultPoolEntry() ?? undefined;
    if (!raw) return undefined;
  }

  // 形式 1：纯字符串 = 池引用
  if (typeof raw === 'string') {
    const pool = getGlobalConfig().llmProviders[raw];
    if (!pool) {
      logger.warn(`[AgentLoader] LLM 池条目 "${raw}" 未找到，将使用空配置`);
      return undefined;
    }
    // 保留 $ref 用于后续凭据查找
    return resolveLLMConfig({ ...pool, $ref: raw } as LLMConfig);
  }

  // 形式 2：$ref 引用 + 覆盖
  if (raw.$ref) {
    const poolName = raw.$ref;
    const pool = getGlobalConfig().llmProviders[poolName];
    if (!pool) {
      logger.warn(`[AgentLoader] LLM 池条目 "${poolName}" 未找到，将使用内嵌配置`);
      return resolveLLMConfig(raw);
    }
    const { $ref, ...overrides } = raw;
    // 保留 $ref 用于后续凭据查找
    const merged = { ...pool, ...overrides, $ref: poolName } as LLMConfig;
    return resolveLLMConfig(merged);
  }

  // 形式 3：传统内嵌 —— 但如果 model 名称恰好匹配池条目，且未显式指定 provider，
  // 则自动解析为池引用（兼容 `"llm": { "model": "deepseek-v4-pro" }` 这类简写）。
  if (!raw.provider && !raw.base_url && raw.model) {
    const poolByName = getGlobalConfig().llmProviders[raw.model];
    if (poolByName) {
      logger.info(`[AgentLoader] LLM model "${raw.model}" 匹配池条目，自动解析为池引用`);
      const { model, ...overrides } = raw;
      const merged = { ...poolByName, ...overrides, $ref: raw.model } as LLMConfig;
      return resolveLLMConfig(merged);
    }
  }

  // 形式 4：传统内嵌（有 provider 或有 base_url）
  return resolveLLMConfig(raw);
}

/**
 * 解析 search 命名空间配置。
 *
 * 优先级：Agent 显式配置 > 池 default 条目 > 池首项 > 工具默认值
 */
function resolveSearchPool(nsConfig: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  // 有显式配置（内嵌或 $ref）→ 按原逻辑
  if (nsConfig) {
    const ref = nsConfig.$ref as string | undefined;
    if (!ref) {
      // 内嵌配置：如果没有 $ref 且缺少 provider / api key 字段，
      // 自动合并默认池条目（兼容 `"tool.web_search": { "defaultResults": 10 }` 此类简写）
      const hasApiKey = nsConfig.tavilyApiKey || nsConfig.serpapiApiKey || nsConfig.braveApiKey;
      if (!nsConfig.provider && !hasApiKey) {
        const pools = getGlobalConfig().searchProviders;
        const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
        const def = entries.find(([_, v]) => v && (v as any).default);
        const poolName = def ? def[0] : entries[0]?.[0];
        if (poolName) {
      logger.info(`[AgentLoader] Search 配置自动合并默认池 "${poolName}"`);
          const pool = pools[poolName] as Record<string, unknown>;
          // 保留 $ref 用于凭据查找
          return { ...pool, ...nsConfig, $ref: poolName };
        }
      }
      return nsConfig;
    }
    const pool = getGlobalConfig().searchProviders[ref];
    if (!pool) {
      logger.warn(`[AgentLoader] 搜索引擎条目 "${ref}" 未找到，将使用内嵌配置`);
      return nsConfig;
    }
    const { $ref: _, ...overrides } = nsConfig;
    return { ...pool, ...overrides, $ref: ref } as Record<string, unknown>;
  }
  // 无配置：自动从池取 default 或首项
  const pools = getGlobalConfig().searchProviders;
  const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
  if (entries.length === 0) return undefined;
  const def = entries.find(([_, v]) => v && (v as any).default);
  const poolName = def ? def[0] : entries[0][0];
  return { ...(pools[poolName] as Record<string, unknown>), $ref: poolName };
}

// 插件发现/加载（discoverTools / discoverExtensions / discoverInterceptors /
// scanGlobalPlugins / reloadGlobalExtensions / selectToolsByRequires / mergeMaps）
// 已迁移至 ../plugins/loader（v0.5.0 架构重构）。

// ============================================================
// 合并策略与工具注入决策（已迁移至 ../plugins/loader）
// ============================================================
// ============================================================
// AgentLoader
// ============================================================

export interface LoadedAgent {
  config: AgentConfig;
  /** 解析后的 LLM 配置 (环境变量已替换) */
  llmConfig?: LLMConfig;
  tools: Tool[];
  preHooks: PreProcessHook[];
  postHooks: PostProcessHook[];
  /** 全局拦截器（框架强制，非 Agent 可选） */
  interceptors: ToolInterceptor[];
}

export class AgentLoader {
  /** 插件发现/加载引擎（全局工具/扩展来源） */
  private pluginLoader: PluginLoader;

  /**
   * @param srcRoot 源代码根目录（src/ 目录的绝对路径）
   * @param pluginLoader 插件发现引擎（缺省时自建，默认定位 srcRoot/plugins）
   */
  constructor(srcRoot: string, pluginLoader?: PluginLoader) {
    this.pluginLoader = pluginLoader ?? new PluginLoader(srcRoot);
  }

  /** 获取 plugins 目录路径（全局插件根，委托 PluginLoader） */
  getGlobalDir(): string {
    return this.pluginLoader.getGlobalDir();
  }

  /** 获取 agents 配置目录路径（来自运行时配置） */
  private get agentsDir() {
    return getGlobalConfig().agentsDir;
  }

  /**
   * 加载所有 Agent 配置与依赖
   * @returns LoadedAgent 数组
   */
  /**
   * 加载单个 Agent（按目录路径）。
   * 用于热重载：配置保存后无需重启整个服务。
   */
  loadOne(agentDirPath: string): LoadedAgent {
    const { tools: globalTools, extensions: globalExtensions, interceptors: globalInterceptors, toolLevels, toolRequires } =
      this.pluginLoader.scanAll();

    const configPath = path.join(agentDirPath, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`[AgentLoader] ${agentDirPath} 中无 config.json`);
    }

    // 1. 读取 Agent 差异配置（仅包含与全局不同的项）
    const agentDiff: AgentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // 2. 构建全局基准配置
    const globalBase: Record<string, unknown> = {};
    const globalRaw = getGlobalConfig() as unknown as Record<string, unknown>;
    for (const key of Object.keys(globalRaw)) {
      if (!key.startsWith('$') && key !== 'namespaces') {
        globalBase[key] = globalRaw[key];
      }
    }
    const gNamespaces = globalRaw.namespaces as Record<string, Record<string, unknown>> | undefined;
    if (gNamespaces) {
      for (const [nsKey, nsVal] of Object.entries(gNamespaces)) {
        globalBase[nsKey] = nsVal;
      }
    }

    // 3. 合并：全局基础 + Agent 差异 → 有效配置
    const config: AgentConfig = deepMerge(globalBase as any, agentDiff as any) as any;
    // 确保 agent_id 使用差异配置中声明的值
    config.agent_id = agentDiff.agent_id;

    // 4. 解析 LLM 配置（Agent 覆盖优先 → 池默认 → 池第一个）
    let llmConfig: LLMConfig | undefined;
    const rawLlm = (agentDiff as any).llm ?? (globalBase as any).llm;
    llmConfig = resolveLLMPool(rawLlm);
    if (llmConfig) {
      logger.info(
        `[AgentLoader]   LLM: ${llmConfig.provider}/${llmConfig.model ?? 'default'} ` +
        `(temp=${llmConfig.temperature ?? 'default'}, max_tokens=${llmConfig.max_tokens ?? 'unset'})`
      );
    }

    // 5. 解析 Search 配置（池自动检测：default 条目或首项）
    config['tool.web_search'] = resolveSearchPool(config['tool.web_search'] as Record<string, unknown> | undefined);

    const agentTools = discoverTools(path.join(agentDirPath, 'tools'));
    const mergedTools = mergeMaps(globalTools, agentTools);

    const agentExtensions = discoverExtensions(path.join(agentDirPath, 'extensions'));
    const mergedExtensions = mergeMaps(globalExtensions, agentExtensions);

    this.validateReferences(config, mergedTools, mergedExtensions);

    // 能力标签驱动：按 tags 过滤工具
    //   tags 组合式：["agent"]=基础、["dev"]=开发、["admin"]=管理、["sap"]=领域
    //   工具 requires 为 AND 语义：Agent 需包含全部要求的标签才可用
    //   v0.4.6：移除 role→tags 兼容映射（role 字段已从全部 Agent 配置移除），
    //   无 tags 的 Agent 视为无能力标签（仅 autoInject 工具可用）
    const agentTags: string[] = config.tags?.length ? [...config.tags] : [];
    const hasTag = (req: string[]) => req.every(r => agentTags.includes(r));

    // v0.4.5 注入策略：按 requires 自动注入（替代 config.tools 写死白名单）
    //   1. 遍历全部工具（全局 + Agent 专属），requires 匹配 agentTags → 自动注入
    //   2. config.tools 退化为显式追加（向后兼容）：额外列出、且 requires 匹配（或无 requires）→ 注入
    //   3. autoInject 工具由 bootstrap 单独注入（getAutoInjectTools），不在此处
    //   4. admin 标签额外注入 level=admin 工具（兼容旧角色体系）
    const selectedTools = selectToolsByRequires(
      mergedTools,
      toolRequires,
      toolLevels,
      agentTags,
      config.tools ?? [],
    );

    // 能力标签校验日志（诊断用）：requires 不匹配的工具被剔除
    for (const [name, tool] of mergedTools) {
      if (!selectedTools.some(t => t === tool)) continue;
      const req = toolRequires.get(name);
      if (req && req.length > 0 && !req.every(r => agentTags.includes(r))) {
        logger.warn(`[AgentLoader] "${config.agent_id}" (tags=${agentTags.join(',') || 'none'}) 无权使用工具 "${name}"（需 ${req.join('+')}），已剔除`);
      }
    }
    const selectedPreHooks = (config.pre_hooks ?? [])
      .map((name) => mergedExtensions.get(name)?.preHook)
      .filter(Boolean) as PreProcessHook[];
    const selectedPostHooks = (config.post_hooks ?? [])
      .map((name) => mergedExtensions.get(name)?.postHook)
      .filter(Boolean) as PostProcessHook[];

    const loaded: LoadedAgent = {
      config,
      llmConfig,
      tools: selectedTools,
      preHooks: selectedPreHooks,
      postHooks: selectedPostHooks,
      interceptors: globalInterceptors,
    };

    logger.info(
      `[AgentLoader] Loaded "${config.agent_id}" — ` +
      `${selectedTools.length} tools, ${selectedPreHooks.length} pre-hooks, ${selectedPostHooks.length} post-hooks`
    );

    return loaded;
  }

  loadAll(): LoadedAgent[] {
    if (!fs.existsSync(this.agentsDir)) {
      logger.warn(`[AgentLoader] 未找到 Agents 目录：${this.agentsDir}`);
      return [];
    }

    const agentDirs = fs.readdirSync(this.agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(this.agentsDir, e.name));

    const results: LoadedAgent[] = [];
    for (const agentDir of agentDirs) {
      const configPath = path.join(agentDir, 'config.json');
      if (!fs.existsSync(configPath)) {
        logger.warn(`[AgentLoader] ${agentDir} 中无 config.json，已跳过`);
        continue;
      }
      results.push(this.loadOne(agentDir));
    }

    return results;
  }

  /**
   * 验证并清理 config.json 中引用的工具/扩展列表。
   * 不存在的引用会被 warn 并从配置中移除，确保不会阻塞启动。
   * （适用于 MCP 工具变更导致配置失效的场景）
   */
  private validateReferences(
    config: AgentConfig,
    tools: Map<string, Tool>,
    extensions: Map<string, Extension>,
  ): void {
    // 过滤并移除不存在的工具引用
    const invalidTools: string[] = [];
    if (config.tools) {
      config.tools = config.tools.filter((name) => {
        const exists = tools.has(name);
        if (!exists) invalidTools.push(name);
        return exists;
      });
    }

    // 过滤并移除不存在的 pre_hook 引用
    const invalidPreHooks: string[] = [];
    if (config.pre_hooks) {
      config.pre_hooks = config.pre_hooks.filter((name) => {
        const exists = extensions.has(name) && !!extensions.get(name)!.preHook;
        if (!exists) invalidPreHooks.push(name);
        return exists;
      });
    }

    // 过滤并移除不存在的 post_hook 引用
    const invalidPostHooks: string[] = [];
    if (config.post_hooks) {
      config.post_hooks = config.post_hooks.filter((name) => {
        const exists = extensions.has(name) && !!extensions.get(name)!.postHook;
        if (!exists) invalidPostHooks.push(name);
        return exists;
      });
    }

    // 将错误降级为 warning，不阻塞启动
    if (invalidTools.length > 0) {
      logger.warn(
        `[AgentLoader] Agent "${config.agent_id}" 引用了 ${invalidTools.length} 个不存在的工具，已自动移除：${invalidTools.join(', ')}`
      );
    }
    if (invalidPreHooks.length > 0) {
      logger.warn(
        `[AgentLoader] Agent "${config.agent_id}" 引用了 ${invalidPreHooks.length} 个不存在的 pre_hook，已自动移除：${invalidPreHooks.join(', ')}`
      );
    }
    if (invalidPostHooks.length > 0) {
      logger.warn(
        `[AgentLoader] Agent "${config.agent_id}" 引用了 ${invalidPostHooks.length} 个不存在的 post_hook，已自动移除：${invalidPostHooks.join(', ')}`
      );
    }
  }

  // 配置 Schema 扫描（extractMeta / convertConfig / getConfigSchemas /
  // getLLMSchemas / getSearchSchemas）已迁移至 ../plugins/loader（PluginLoader，
  // v0.5.0 架构重构）。
}
