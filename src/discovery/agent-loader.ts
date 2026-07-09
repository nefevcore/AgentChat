// ============================================================
// AgentLoader —— 自动发现与配置解析引擎
//
// 工作流程：
//   1. 遍历 <workspace>/agents/ 下的所有子目录
//   2. 读取 config.json
//   3. 扫描 src/global/tools + <workspace>/agents/[name]/tools（专属优先覆盖全局）
//   4. 同理解析 src/global/extensions + <workspace>/agents/[name]/extensions
//   5. Fail Fast: 配置引用的工具/扩展找不到则抛异常
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool, Extension, PreProcessHook, PostProcessHook, ToolDefinition } from '../core/types';
import { AgentConfig, AgentBundle, LLMConfig, PluginMeta } from './config-types';
import { getGlobalConfig } from '../core/config';

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
    api_key: resolveEnvVars(raw.api_key),
    base_url: raw.base_url ? resolveEnvVars(raw.base_url) : undefined,
    model: raw.model ? resolveEnvVars(raw.model) : undefined,
  };
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
      console.warn(`[AgentLoader] ${entry.name}/ 中无 tool.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<ToolModule>(entryFile);
      if (mod.tool?.definition?.function?.name) {
        tools.set(mod.tool.definition.function.name, mod.tool);
      }
    } catch (err: any) {
      console.warn(`[AgentLoader] 加载工具 ${entry.name} 失败：${err.message}`);
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
      console.warn(`[AgentLoader] ${entry.name}/ 中无 extension.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<ExtensionModule>(entryFile);
      if (mod.extension?.meta?.name) {
        extensions.set(mod.extension.meta.name, mod.extension);
      }
    } catch (err: any) {
      console.warn(`[AgentLoader] 加载扩展 ${entry.name} 失败：${err.message}`);
    }
  }

  return extensions;
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
      description: tool.description ?? tool.definition.function.description ?? '',
      displayName: tool.displayName,
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
        description: ext.meta.description,
      });
    }
    if (ext.postHook) {
      entries.push({
        name,
        type: 'post_hook' as const,
        description: ext.meta.description,
      });
    }
    extMap.set(name, entries);
  }

  return extMap;
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
  loadAll(): LoadedAgent[] {
    // 0. 预加载全局工具和扩展
    const globalTools = discoverTools(path.join(this.globalDir, 'tools'));
    const globalExtensions = discoverExtensions(path.join(this.globalDir, 'extensions'));

    // 1. 遍历 agents/ 下所有子目录
    if (!fs.existsSync(this.agentsDir)) {
      console.warn(`[AgentLoader] 未找到 Agents 目录：${this.agentsDir}`);
      return [];
    }

    const agentDirs = fs.readdirSync(this.agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(this.agentsDir, e.name));

    const results: LoadedAgent[] = [];

    for (const agentDir of agentDirs) {
      const configPath = path.join(agentDir, 'config.json');

      if (!fs.existsSync(configPath)) {
        console.warn(`[AgentLoader] ${agentDir} 中无 config.json，已跳过`);
        continue;
      }

      // 2. 读取配置
      const config: AgentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 2.1 解析 LLM 配置（环境变量替换）
      let llmConfig: LLMConfig | undefined;
      if (config.llm) {
        llmConfig = resolveLLMConfig(config.llm);
        const tempStr = llmConfig.temperature !== undefined ? String(llmConfig.temperature) : 'default';
        const mtStr = llmConfig.max_tokens !== undefined ? String(llmConfig.max_tokens) : 'unset';
        console.log(
          `[AgentLoader]   LLM: ${llmConfig.provider}/${llmConfig.model ?? 'default'} ` +
          `(temp=${tempStr}, max_tokens=${mtStr})`
        );
      }

      // 3. 加载 Agent 专属工具（覆盖全局）
      const agentTools = discoverTools(path.join(agentDir, 'tools'));
      const mergedTools = mergeMaps(globalTools, agentTools);

      // 4. 加载 Agent 专属扩展
      const agentExtensions = discoverExtensions(path.join(agentDir, 'extensions'));
      const mergedExtensions = mergeMaps(globalExtensions, agentExtensions);

      // 5. Fail Fast: 验证配置中引用的工具和扩展是否存在
      this.validateReferences(config, mergedTools, mergedExtensions);

      // 6. 按配置筛选
      const selectedTools = (config.tools ?? []).map((name) => mergedTools.get(name)!);
      const selectedPreHooks = (config.pre_hooks ?? [])
        .map((name) => mergedExtensions.get(name)?.preHook)
        .filter(Boolean) as PreProcessHook[];
      const selectedPostHooks = (config.post_hooks ?? [])
        .map((name) => mergedExtensions.get(name)?.postHook)
        .filter(Boolean) as PostProcessHook[];

      results.push({
        config,
        llmConfig,
        tools: selectedTools,
        preHooks: selectedPreHooks,
        postHooks: selectedPostHooks,
      });

      console.log(
        `[AgentLoader] Loaded "${config.agent_id}" — ` +
        `${selectedTools.length} tools, ${selectedPreHooks.length} pre-hooks, ${selectedPostHooks.length} post-hooks`
      );
    }

    return results;
  }

  /**
   * 获取所有可用插件元数据（跨所有 Agent）
   * 合并全局和所有 Agent 专属目录的插件
   */
  getAllPlugins(): PluginMeta[] {
    const allMetas = new Map<string, PluginMeta>();

    // 全局工具
    const globalToolMetas = discoverToolMetaModules(path.join(this.globalDir, 'tools'));
    for (const [name, meta] of globalToolMetas) {
      allMetas.set(`tool:${name}`, meta);
    }

    // 全局扩展
    const globalExtMetas = discoverExtensionMetaModules(path.join(this.globalDir, 'extensions'));
    for (const [, entries] of globalExtMetas) {
      for (const meta of entries) {
        allMetas.set(`${meta.type}:${meta.name}`, meta);
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
}
