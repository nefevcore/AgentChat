// ============================================================
// AgentLoader —— 自动发现与配置解析引擎
//
// 工作流程：
//   1. 遍历 <workspace>/agents/ 下的所有子目录
//   2. 读取 config.json
//   3. 扫描 src/global/*/plugin.json 发现全局插件（PluginManifest 容器模式）
//   4. 扫描 <workspace>/agents/[name]/tools + extensions（Agent 专属插件，子目录模式）
//   5. Fail Fast: 配置引用的工具/扩展找不到则抛异常
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool, Extension, PreProcessHook, PostProcessHook, ToolDefinition, ToolInterceptor } from '@core/types';
import { AgentConfig, AgentBundle, LLMConfig, PluginMeta, PluginManifest, HasConfig, ConfigField } from './config-types';
import { getGlobalConfig } from '@core/config';
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

/** 深度解析对象中所有字符串值的环境变量引用 */
function resolveLLMConfig(raw: LLMConfig): LLMConfig {
  return {
    ...raw,
    api_key: raw.api_key ? resolveEnvVars(raw.api_key) : '',
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
function resolveLLMPool(raw: LLMConfig | string | undefined): LLMConfig | undefined {
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

// ============================================================
// 类型：模块导出形状
// ============================================================

interface ToolModule {
  tool: Tool;
}

interface ExtensionModule {
  extension: Extension;
}

// ============================================================
// 扫描与加载
// ============================================================

/**
 * 从文件路径动态加载模块
 * 使用 require() 来加载编译后的 .js 或 ts-node 处理的 .ts
 */
function loadModule<T>(filePath: string): T {
  // 清除可能的缓存（开发期间）
  delete require.cache[require.resolve(filePath)];
  return require(filePath) as T;
}

/**
 * 从目录发现所有工具（目录 + tool.ts 模式）。
 *
 * 约定：每个工具是一个子目录，目录内必须有 tool.ts（或编译后的 tool.js），
 * 默认导出 `export const tool: Tool`。
 *
 * @returns name → Tool 的 Map（name 取自 tool.definition.function.name）
 */
function discoverTools(dir: string): Map<string, Tool> {
  const tools = new Map<string, Tool>();

  if (!fs.existsSync(dir)) return tools;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const toolDir = path.join(dir, entry.name);
    const tsFile = path.join(toolDir, 'tool.ts');
    const jsFile = path.join(toolDir, 'tool.js');
    const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

    if (!entryFile) {
      logger.warn(`[AgentLoader] ${entry.name}/ 中无 tool.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<ToolModule>(entryFile);
      if (mod.tool?.definition?.function?.name) {
        tools.set(mod.tool.definition.function.name, mod.tool);
      }
    } catch (err: any) {
      logger.warn(`[AgentLoader] 加载工具 ${entry.name} 失败：${err.message}`);
    }
  }

  return tools;
}

/**
 * 从目录发现所有扩展（目录 + extension.ts 模式）。
 *
 * 约定：每个扩展是一个子目录，目录内必须有 extension.ts（或编译后的 extension.js），
 * 默认导出 `export const extension: Extension`。
 *
 * @returns name → Extension 的 Map（name 取自 extension.meta.name）
 */
function discoverExtensions(dir: string): Map<string, Extension> {
  const extensions = new Map<string, Extension>();

  if (!fs.existsSync(dir)) return extensions;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const extDir = path.join(dir, entry.name);

    // 优先 .ts（开发），回退 .js（编译产物）
    const tsFile = path.join(extDir, 'extension.ts');
    const jsFile = path.join(extDir, 'extension.js');
    const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

    if (!entryFile) {
      logger.warn(`[AgentLoader] ${entry.name}/ 中无 extension.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<ExtensionModule>(entryFile);
      if (mod.extension?.name) {
        extensions.set(mod.extension.name, mod.extension);
      }
    } catch (err: any) {
      logger.warn(`[AgentLoader] 加载扩展 ${entry.name} 失败：${err.message}`);
    }
  }

  return extensions;
}

/**
 * 从目录发现所有拦截器（目录 + interceptor.ts 模式）。
 *
 * 约定：每个拦截器是一个子目录，目录内必须有 interceptor.ts，
 * 默认导出 `export const interceptor: ToolInterceptor`。
 *
 * @returns ToolInterceptor 数组
 */
interface InterceptorModule {
  interceptor: ToolInterceptor;
}

function discoverInterceptors(dir: string): ToolInterceptor[] {
  const interceptors: ToolInterceptor[] = [];

  if (!fs.existsSync(dir)) return interceptors;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const intDir = path.join(dir, entry.name);
    const tsFile = path.join(intDir, 'interceptor.ts');
    const jsFile = path.join(intDir, 'interceptor.js');
    const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

    if (!entryFile) {
      logger.warn(`[AgentLoader] ${entry.name}/ 中无 interceptor.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<InterceptorModule>(entryFile);
      if (mod.interceptor) {
        interceptors.push(mod.interceptor);
        logger.info(`[AgentLoader] 已加载拦截器：${entry.name}`);
      }
    } catch (err: any) {
      logger.warn(`[AgentLoader] 加载拦截器 ${entry.name} 失败：${err.message}`);
    }
  }

  return interceptors;
}

// ============================================================
// 单条目加载（按 plugin.json 中声明的 path 精确加载）
// ============================================================

/** 从单个目录加载工具（目录中必须有 tool.ts） */
function loadToolFromDir(dir: string, expectedName: string): Tool | null {
  if (!fs.existsSync(dir)) {
    logger.warn(`[AgentLoader] 工具目录不存在：${dir}`);
    return null;
  }

  const tsFile = path.join(dir, 'tool.ts');
  const jsFile = path.join(dir, 'tool.js');
  const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

  if (!entryFile) {
    logger.warn(`[AgentLoader] ${expectedName} 目录中无 tool.ts，已跳过`);
    return null;
  }

  try {
    const mod = loadModule<ToolModule>(entryFile);
    if (mod.tool?.definition?.function?.name) {
      return mod.tool;
    }
  } catch (err: any) {
    logger.warn(`[AgentLoader] 加载工具 ${expectedName} 失败：${err.message}`);
  }
  return null;
}

/** 从单个目录加载扩展（目录中必须有 extension.ts） */
function loadExtensionFromDir(dir: string, expectedName: string): Extension | null {
  if (!fs.existsSync(dir)) {
    logger.warn(`[AgentLoader] 扩展目录不存在：${dir}`);
    return null;
  }

  const tsFile = path.join(dir, 'extension.ts');
  const jsFile = path.join(dir, 'extension.js');
  const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

  if (!entryFile) {
    logger.warn(`[AgentLoader] ${expectedName} 目录中无 extension.ts，已跳过`);
    return null;
  }

  try {
    const mod = loadModule<ExtensionModule>(entryFile);
    if (mod.extension?.name) {
      return mod.extension;
    }
  } catch (err: any) {
    logger.warn(`[AgentLoader] 加载扩展 ${expectedName} 失败：${err.message}`);
  }
  return null;
}

/** 从单个目录加载拦截器（目录中必须有 interceptor.ts） */
function loadInterceptorFromDir(dir: string, expectedName: string): ToolInterceptor | null {
  if (!fs.existsSync(dir)) {
    logger.warn(`[AgentLoader] 拦截器目录不存在：${dir}`);
    return null;
  }

  const tsFile = path.join(dir, 'interceptor.ts');
  const jsFile = path.join(dir, 'interceptor.js');
  const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

  if (!entryFile) {
    logger.warn(`[AgentLoader] ${expectedName} 目录中无 interceptor.ts，已跳过`);
    return null;
  }

  try {
    const mod = loadModule<InterceptorModule>(entryFile);
    if (mod.interceptor) {
      logger.info(`[AgentLoader] 已加载拦截器：${expectedName}`);
      return mod.interceptor;
    }
  } catch (err: any) {
    logger.warn(`[AgentLoader] 加载拦截器 ${expectedName} 失败：${err.message}`);
  }
  return null;
}

// ============================================================
// 插件元数据加载
// ============================================================

/**
 * 从目录发现所有工具的元数据，返回 name → PluginMeta 的 Map
 */
function discoverToolMetaModules(dir: string): Map<string, PluginMeta> {
  const metas = new Map<string, PluginMeta>();
  const tools = discoverTools(dir);

  for (const [name, tool] of tools) {
    metas.set(name, {
      name,
      type: 'tool',
      label: tool.label,
      description: tool.description ?? '',
    });
  }

  return metas;
}

/**
 * 从目录发现所有扩展的元数据，返回 name → PluginMeta 的 Map。
 * 每个扩展可能同时提供 preHook 和 postHook，因此需要为每种钩子类型
 * 分别生成一条 PluginMeta 记录（name 相同但 type 不同）。
 */
function discoverExtensionMetaModules(dir: string): Map<string, PluginMeta[]> {
  const extMap = new Map<string, PluginMeta[]>();
  const extensions = discoverExtensions(dir);

  for (const [name, ext] of extensions) {
    const entries: PluginMeta[] = [];
    if (ext.preHook) {
      entries.push({
        name,
        type: 'pre_hook' as const,
        label: ext.label,
        description: ext.description ?? '',
      });
    }
    if (ext.postHook) {
      entries.push({
        name,
        type: 'post_hook' as const,
        label: ext.label,
        description: ext.description ?? '',
      });
    }
    extMap.set(name, entries);
  }

  return extMap;
}

// ============================================================
// 全局插件扫描（PluginManifest 容器模式）
// ============================================================

/**
 * 扫描 global 下的所有插件目录（通过 plugin.json 白名单发现）。
 *
 * 每个条目通过 `path` 字段指定其子目录（相对于 plugin.json 所在目录），
 * 不再默认扫描 tools/extensions/interceptors 三个目录。
 *
 * @returns 合并后的 tools / extensions / interceptors
 */
function scanGlobalPlugins(globalDir: string): {
  tools: Map<string, Tool>;
  extensions: Map<string, Extension>;
  interceptors: ToolInterceptor[];
} {
  const allTools = new Map<string, Tool>();
  const allExtensions = new Map<string, Extension>();
  const allInterceptors: ToolInterceptor[] = [];

  if (!fs.existsSync(globalDir)) {
    return { tools: allTools, extensions: allExtensions, interceptors: allInterceptors };
  }

  for (const entry of fs.readdirSync(globalDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(globalDir, entry.name);
    const manifestPath = path.join(pluginDir, 'plugin.json');

    if (!fs.existsSync(manifestPath)) continue;

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    } catch (err: any) {
      logger.warn(`[AgentLoader] 解析 ${manifestPath} 失败：${err.message}`);
      continue;
    }

    const label = manifest.label ?? manifest.name;
    logger.info(`[AgentLoader] 发现插件：${label} (${pluginDir})`);

    // 按 path 加载工具
    for (const t of manifest.tools ?? []) {
      const dir = path.join(pluginDir, t.path ?? `tools/${t.name}`);
      const tool = loadToolFromDir(dir, t.name);
      if (tool) allTools.set(tool.definition.function.name, tool);
    }

    // 按 path 加载扩展
    for (const e of manifest.extensions ?? []) {
      const dir = path.join(pluginDir, e.path ?? `extensions/${e.name}`);
      const ext = loadExtensionFromDir(dir, e.name);
      if (ext) allExtensions.set(ext.name, ext);
    }

    // 按 path 加载拦截器
    for (const i of manifest.interceptors ?? []) {
      const dir = path.join(pluginDir, i.path ?? `interceptors/${i.name}`);
      const interceptor = loadInterceptorFromDir(dir, i.name);
      if (interceptor) allInterceptors.push(interceptor);
    }
  }

  return { tools: allTools, extensions: allExtensions, interceptors: allInterceptors };
}

// ============================================================
// 合并策略
// ============================================================

/** 合并两个 Map，base 在前，override 在后（覆盖同名 key） */
function mergeMaps<K, V>(base: Map<K, V>, override: Map<K, V>): Map<K, V> {
  const result = new Map(base);
  for (const [key, value] of override) {
    result.set(key, value);
  }
  return result;
}

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
  private srcRoot: string;

  /**
   * @param srcRoot 源代码根目录（src/ 目录的绝对路径），用于加载 global tools/extensions
   */
  constructor(srcRoot: string) {
    this.srcRoot = srcRoot;
  }

  /** 获取 global 目录路径（源码中的 tools/extensions） */
  private get globalDir() {
    return path.join(this.srcRoot, 'global');
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
    const { tools: globalTools, extensions: globalExtensions, interceptors: globalInterceptors } =
      scanGlobalPlugins(this.globalDir);

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

    const selectedTools = (config.tools ?? []).map((name) => mergedTools.get(name)!);
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
   * 获取标记了 autoInject 的全局工具列表。
   * 这些工具会自动注入到所有 Agent，无需在 config.json 中单独配置。
   *
   * 扫描所有 global 插件的 plugin.json，加载 autoInject: true 的工具。
   */
  getAutoInjectTools(): Tool[] {
    const tools: Tool[] = [];

    if (!fs.existsSync(this.globalDir)) return tools;

    for (const entry of fs.readdirSync(this.globalDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(this.globalDir, entry.name);
      const manifestPath = path.join(pluginDir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;

      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      } catch { continue; }

      for (const t of manifest.tools ?? []) {
        if (!t.autoInject) continue;
        const dir = path.join(pluginDir, t.path ?? `tools/${t.name}`);
        const tool = loadToolFromDir(dir, t.name);
        if (tool) {
          logger.info(`[AgentLoader] 自动注入工具：${tool.definition.function.name}`);
          tools.push(tool);
        }
      }
    }

    return tools;
  }

  /**
   * 获取所有可用插件元数据（跨所有 Agent）
   * 合并全局和所有 Agent 专属目录的插件
   */
  getAllPlugins(): PluginMeta[] {
    const allMetas = new Map<string, PluginMeta>();

    // 扫描所有全局插件（PluginManifest 白名单模式）
    if (fs.existsSync(this.globalDir)) {
      for (const entry of fs.readdirSync(this.globalDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(this.globalDir, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        let manifest: PluginManifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
        } catch { continue; }

        // 按 path 收集工具元数据
        for (const t of manifest.tools ?? []) {
          const dir = path.join(pluginDir, t.path ?? `tools/${t.name}`);
          const tool = loadToolFromDir(dir, t.name);
          if (tool) {
            allMetas.set(`tool:${tool.definition.function.name}`, {
              name: tool.definition.function.name,
              type: 'tool',
              label: tool.label,
              description: tool.description ?? '',
              autoInject: t.autoInject ?? false,
            });
          }
        }

        // 按 path 收集扩展元数据
        for (const e of manifest.extensions ?? []) {
          const dir = path.join(pluginDir, e.path ?? `extensions/${e.name}`);
          const ext = loadExtensionFromDir(dir, e.name);
          if (ext) {
            if (ext.preHook) {
              allMetas.set(`pre_hook:${ext.name}`, {
                name: ext.name,
                type: 'pre_hook' as const,
                label: ext.label,
                description: ext.description ?? '',
              });
            }
            if (ext.postHook) {
              allMetas.set(`post_hook:${ext.name}`, {
                name: ext.name,
                type: 'post_hook' as const,
                label: ext.label,
                description: ext.description ?? '',
              });
            }
          }
        }
      }
    }

    // 遍历所有 Agent 专属目录的插件
    if (fs.existsSync(this.agentsDir)) {
      const agentDirs = fs.readdirSync(this.agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(this.agentsDir, e.name));

      for (const agentDir of agentDirs) {
        const agentToolMetas = discoverToolMetaModules(path.join(agentDir, 'tools'));
        for (const [name, meta] of agentToolMetas) {
          if (!allMetas.has(`tool:${name}`)) {
            allMetas.set(`tool:${name}`, meta);
          }
        }

        const agentExtMetas = discoverExtensionMetaModules(path.join(agentDir, 'extensions'));
        for (const [, entries] of agentExtMetas) {
          for (const meta of entries) {
            const key = `${meta.type}:${meta.name}`;
            if (!allMetas.has(key)) {
              allMetas.set(key, meta);
            }
          }
        }
      }
    }

    return Array.from(allMetas.values());
  }

  /**
   * 获取指定 Agent 的插件列表，含启用状态
   */
  getAgentPlugins(agentId: string): Array<PluginMeta & { enabled: boolean }> {
    const allPlugins = this.getAllPlugins();

    const agentDir = path.join(this.agentsDir, agentId);
    const configPath = path.join(agentDir, 'config.json');

    let enabledTools: string[] = [];
    let enabledPreHooks: string[] = [];
    let enabledPostHooks: string[] = [];

    if (fs.existsSync(configPath)) {
      const config: AgentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      enabledTools = config.tools ?? [];
      enabledPreHooks = config.pre_hooks ?? [];
      enabledPostHooks = config.post_hooks ?? [];
    }

    return allPlugins.map((p) => {
      let enabled = false;
      switch (p.type) {
        case 'tool': enabled = enabledTools.includes(p.name); break;
        case 'pre_hook': enabled = enabledPreHooks.includes(p.name); break;
        case 'post_hook': enabled = enabledPostHooks.includes(p.name); break;
      }
      return { ...p, enabled };
    });
  }

  /**
   * Fail Fast: 确保 config.json 中引用的所有工具/扩展都存在
   */
  private validateReferences(
    config: AgentConfig,
    tools: Map<string, Tool>,
    extensions: Map<string, Extension>,
  ): void {
    const errors: string[] = [];

    for (const name of config.tools ?? []) {
      if (!tools.has(name)) {
        errors.push(`Tool "${name}" not found (agent: ${config.agent_id})`);
      }
    }

    for (const name of config.pre_hooks ?? []) {
      if (!extensions.has(name) || !extensions.get(name)!.preHook) {
        errors.push(`Pre-hook "${name}" not found (agent: ${config.agent_id})`);
      }
    }

    for (const name of config.post_hooks ?? []) {
      if (!extensions.has(name) || !extensions.get(name)!.postHook) {
        errors.push(`Post-hook "${name}" not found (agent: ${config.agent_id})`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `[AgentLoader] Configuration errors for "${config.agent_id}":\n  - ${errors.join('\n  - ')}`
      );
    }
  }

  // ============================================================
  // 配置 Schema 扫描 —— 从 config.ts 默认值推断可配置项
  // ============================================================

  /**
   * 从 meta.ts 模块中提取 schema 元数据。
   */
  private extractMeta(dir: string): HasConfig | null {
    const tsFile = path.join(dir, 'meta.ts');
    const jsFile = path.join(dir, 'meta.js');
    const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;
    if (!entryFile) return null;

    try {
      const mod = loadModule<Record<string, unknown>>(entryFile);
      if (mod['meta'] && typeof mod['meta'] === 'object') {
        return mod['meta'] as HasConfig;
      }
    } catch (err: any) {
      logger.warn(`[AgentLoader] 提取 meta 失败: ${entryFile} - ${err.message}`);
    }
    return null;
  }

  /** 将 ConfigField[] 转换为 Record 格式（API 兼容） */
  private convertConfig(configuration?: ConfigField[]): Record<string, any> {
    if (!configuration) return {};
    const result: Record<string, any> = {};
    for (const f of configuration) {
      result[f.name] = {
        label: f.label,
        description: f.description,
        type: f.type,
        default: f.default,
        options: f.type === 'select' ? (f as any).options?.map((o: any) => o.value) ?? (f as any).options : undefined,
        accept: f.type === 'file' ? (f as any).accept : undefined,
        showWhen: (f as any).showWhen,
      };
    }
    return result;
  }

  /**
   * 获取所有工具和扩展的配置 schema。
   */
  getConfigSchemas(): { tools: Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; accept?: string }>>; extensions: Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; accept?: string }>> } {
    const tools: Record<string, Record<string, any>> = {};
    const extensions: Record<string, Record<string, any>> = {};

    // 扫描所有全局插件
    if (fs.existsSync(this.globalDir)) {
      for (const entry of fs.readdirSync(this.globalDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(this.globalDir, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        let manifest: PluginManifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
        } catch { continue; }

        // 按 path 收集工具 schema
        for (const t of manifest.tools ?? []) {
          const dir = path.join(pluginDir, t.path ?? `tools/${t.name}`);
          const meta = this.extractMeta(dir);
          if (meta?.configuration) {
            const schema = this.convertConfig(meta.configuration);
            if (meta.label) schema._label = { type: 'label', default: meta.label, label: meta.label };
            tools[t.name] = schema;
          }
        }

        // 按 path 收集扩展 schema
        for (const e of manifest.extensions ?? []) {
          const dir = path.join(pluginDir, e.path ?? `extensions/${e.name}`);
          const nsName = e.name.replace(/-/g, '_');
          const meta = this.extractMeta(dir);
          let schema = this.convertConfig(meta?.configuration);
          if (meta?.label) schema._label = { type: 'label', default: meta.label, label: meta.label };
          if (Object.keys(schema).length > 0) extensions[nsName] = schema;
        }
      }
    }

    return { tools, extensions };
  }

  /**
   * 获取 LLM 提供商配置 schema。
   * 从 src/llm/schemas.ts 导入所有 *_LLM_SCHEMA 导出。
   */
  getLLMSchemas(): Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string }>> {
    const schemas: Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string }>> = {};
    const llmDir = path.join(this.srcRoot, 'llm');
    const schemasFile = path.join(llmDir, 'schemas.ts');
    const schemasJsFile = path.join(llmDir, 'schemas.js');
    const entryFile = fs.existsSync(schemasFile) ? schemasFile : fs.existsSync(schemasJsFile) ? schemasJsFile : null;
    if (!entryFile) return schemas;

    try {
      const mod = loadModule<Record<string, unknown>>(entryFile);
      for (const [key, schema] of Object.entries(mod)) {
        if (key.endsWith('_LLM_SCHEMA') && Array.isArray(schema)) {
          const name = key.replace('_LLM_SCHEMA', '').toLowerCase();
          schemas[name] = this.convertConfig(schema as ConfigField[]);
        }
      }
    } catch (err: any) {
      logger.warn(`[AgentLoader] 加载 LLM schema 失败: ${err.message}`);
    }
    return schemas;
  }

  /**
   * 获取搜索工具的各 provider 配置 schema。
   * 从 global 插件中扫描 web_search 工具的 schemas.ts。
   */
  getSearchSchemas(): Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; accept?: string }>> {
    const schemas: Record<string, Record<string, any>> = {};

    // 在所有全局插件中查找 web_search 工具
    if (fs.existsSync(this.globalDir)) {
      for (const entry of fs.readdirSync(this.globalDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(this.globalDir, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        const searchDir = path.join(pluginDir, 'tools', 'web_search');
        const schemasFile = path.join(searchDir, 'schemas.ts');
        const schemasJsFile = path.join(searchDir, 'schemas.js');
        const entryFile = fs.existsSync(schemasFile) ? schemasFile : fs.existsSync(schemasJsFile) ? schemasJsFile : null;
        if (!entryFile) continue;

        try {
          const mod = loadModule<Record<string, unknown>>(entryFile);
          for (const [key, schema] of Object.entries(mod)) {
            if (key.endsWith('_SEARCH_SCHEMA') && Array.isArray(schema)) {
              const name = key.replace('_SEARCH_SCHEMA', '').toLowerCase();
              schemas[name] = this.convertConfig(schema as ConfigField[]);
            }
          }
        } catch (err: any) {
          logger.warn(`[AgentLoader] 加载 search schema 失败: ${err.message}`);
        }
      }
    }
    return schemas;
  }
}
