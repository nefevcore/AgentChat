// ============================================================
// PluginLoader —— 插件发现/加载引擎（v0.5.0 架构重构）
//
// 按重构文档目标结构：
//   plugins/loader.ts  ★ 插件发现/加载（从 agent-loader 移出）
//
// 职责：
//   · 全局插件扫描（plugin.json PluginManifest 容器模式）
//   · 工具/扩展/拦截器目录发现与加载
//   · 插件元数据（getAllPlugins / getAgentPlugins / 配置 Schema）
//   · 全局扩展热重载（reloadGlobalExtensions）
//
// 分层约束：
//   · 本模块只依赖接口类型（@core/types）与插件契约（config-types），
//     不 import 任何插件内部实现。
//   · core 不直接 import 本模块 —— 通过 AppState 注入的 pluginLoader
//     运行时获取（performReload 等场景）。
//   · discovery/agent-loader 保留 Agent 加载（loadOne/loadAll），
//     内部经 PluginLoader 获取全局工具/扩展装配 Agent。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool, Extension, ToolInterceptor } from '@core/types';
import { PluginMeta, PluginManifest, HasConfig, ConfigField } from '../discovery/config-types';
import { getGlobalConfig } from '@core/config';
import { logger } from '../utils/logger';

// ============================================================
// 类型：模块导出形状
// ============================================================

interface ToolModule {
  tool: Tool;
}

interface ExtensionModule {
  extension: Extension;
}

interface InterceptorModule {
  interceptor: ToolInterceptor;
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
export function discoverTools(dir: string): Map<string, Tool> {
  const tools = new Map<string, Tool>();

  if (!fs.existsSync(dir)) return tools;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const toolDir = path.join(dir, entry.name);
    const tsFile = path.join(toolDir, 'tool.ts');
    const jsFile = path.join(toolDir, 'tool.js');
    const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

    if (!entryFile) {
      logger.warn(`[PluginLoader] ${entry.name}/ 中无 tool.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<ToolModule>(entryFile);
      if (mod.tool?.definition?.function?.name) {
        tools.set(mod.tool.definition.function.name, mod.tool);
      }
    } catch (err: any) {
      logger.warn(`[PluginLoader] 加载工具 ${entry.name} 失败：${err.message}`);
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
export function discoverExtensions(dir: string): Map<string, Extension> {
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
      logger.warn(`[PluginLoader] ${entry.name}/ 中无 extension.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<ExtensionModule>(entryFile);
      if (mod.extension?.name) {
        extensions.set(mod.extension.name, mod.extension);
      }
    } catch (err: any) {
      logger.warn(`[PluginLoader] 加载扩展 ${entry.name} 失败：${err.message}`);
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
      logger.warn(`[PluginLoader] ${entry.name}/ 中无 interceptor.ts，已跳过`);
      continue;
    }

    try {
      const mod = loadModule<InterceptorModule>(entryFile);
      if (mod.interceptor) {
        interceptors.push(mod.interceptor);
        logger.info(`[PluginLoader] 已加载拦截器：${entry.name}`);
      }
    } catch (err: any) {
      logger.warn(`[PluginLoader] 加载拦截器 ${entry.name} 失败：${err.message}`);
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
    logger.warn(`[PluginLoader] 工具目录不存在：${dir}`);
    return null;
  }

  const tsFile = path.join(dir, 'tool.ts');
  const jsFile = path.join(dir, 'tool.js');
  const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

  if (!entryFile) {
    logger.warn(`[PluginLoader] ${expectedName} 目录中无 tool.ts，已跳过`);
    return null;
  }

  try {
    const mod = loadModule<ToolModule>(entryFile);
    if (mod.tool?.definition?.function?.name) {
      return mod.tool;
    }
  } catch (err: any) {
    logger.warn(`[PluginLoader] 加载工具 ${expectedName} 失败：${err.message}`);
  }
  return null;
}

/** 从单个目录加载扩展（目录中必须有 extension.ts） */
function loadExtensionFromDir(dir: string, expectedName: string): Extension | null {
  if (!fs.existsSync(dir)) {
    logger.warn(`[PluginLoader] 扩展目录不存在：${dir}`);
    return null;
  }

  const tsFile = path.join(dir, 'extension.ts');
  const jsFile = path.join(dir, 'extension.js');
  const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

  if (!entryFile) {
    logger.warn(`[PluginLoader] ${expectedName} 目录中无 extension.ts，已跳过`);
    return null;
  }

  try {
    const mod = loadModule<ExtensionModule>(entryFile);
    if (mod.extension?.name) {
      return mod.extension;
    }
  } catch (err: any) {
    logger.warn(`[PluginLoader] 加载扩展 ${expectedName} 失败：${err.message}`);
  }
  return null;
}

/** 从单个目录加载拦截器（目录中必须有 interceptor.ts） */
function loadInterceptorFromDir(dir: string, expectedName: string): ToolInterceptor | null {
  if (!fs.existsSync(dir)) {
    logger.warn(`[PluginLoader] 拦截器目录不存在：${dir}`);
    return null;
  }

  const tsFile = path.join(dir, 'interceptor.ts');
  const jsFile = path.join(dir, 'interceptor.js');
  const entryFile = fs.existsSync(tsFile) ? tsFile : fs.existsSync(jsFile) ? jsFile : null;

  if (!entryFile) {
    logger.warn(`[PluginLoader] ${expectedName} 目录中无 interceptor.ts，已跳过`);
    return null;
  }

  try {
    const mod = loadModule<InterceptorModule>(entryFile);
    if (mod.interceptor) {
      logger.info(`[PluginLoader] 已加载拦截器：${expectedName}`);
      return mod.interceptor;
    }
  } catch (err: any) {
    logger.warn(`[PluginLoader] 加载拦截器 ${expectedName} 失败：${err.message}`);
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
 * 扫描 plugins 下的所有插件目录（通过 plugin.json 白名单发现）。
 *
 * 每个条目通过 `path` 字段指定其子目录（相对于 plugin.json 所在目录），
 * 不再默认扫描 tools/extensions/interceptors 三个目录。
 *
 * @returns 合并后的 tools / extensions / interceptors
 */
export function scanGlobalPlugins(globalDir: string): {
  tools: Map<string, Tool>;
  extensions: Map<string, Extension>;
  interceptors: ToolInterceptor[];
  /** 各工具层级（name → level），admin 工具据此自动注入到 admin 角色 Agent */
  toolLevels: Map<string, 'basic' | 'tool' | 'dev' | 'admin'>;
  /** 各工具能力标签要求（name → requires[]），AND 语义 */
  toolRequires: Map<string, string[]>;
} {
  const allTools = new Map<string, Tool>();
  const allExtensions = new Map<string, Extension>();
  const allInterceptors: ToolInterceptor[] = [];
  const toolLevels = new Map<string, 'basic' | 'tool' | 'dev' | 'admin'>();
  const toolRequires = new Map<string, string[]>();

  if (!fs.existsSync(globalDir)) {
    return { tools: allTools, extensions: allExtensions, interceptors: allInterceptors, toolLevels, toolRequires };
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
      logger.warn(`[PluginLoader] 解析 ${manifestPath} 失败：${err.message}`);
      continue;
    }

    const label = manifest.label ?? manifest.name;
    logger.info(`[PluginLoader] 发现插件：${label} (${pluginDir})`);

    // 按 path 加载工具
    for (const t of manifest.tools ?? []) {
      const dir = path.join(pluginDir, t.path ?? `tools/${t.name}`);
      const tool = loadToolFromDir(dir, t.name);
      if (tool) {
        allTools.set(tool.definition.function.name, tool);
        // 记录工具层级（默认：tool；autoInject 已废弃，v0.4.10 起全部按 requires 注入）
        const level = t.level ?? 'tool';
        toolLevels.set(tool.definition.function.name, level);
        // 记录能力标签要求（requires 优先于 level 映射）
        if (t.requires?.length) {
          toolRequires.set(tool.definition.function.name, [...t.requires]);
        } else if (level === 'dev') {
          toolRequires.set(tool.definition.function.name, ['dev']);
        } else if (level === 'admin') {
          toolRequires.set(tool.definition.function.name, ['admin']);
        }
      }
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

  return { tools: allTools, extensions: allExtensions, interceptors: allInterceptors, toolLevels, toolRequires };
}

// ============================================================
// 全局扩展热重载
// ============================================================

/**
 * 重新扫描全局扩展/拦截器并返回新实例。
 * 通过 loadModule 的 cache bust 确保获取最新代码。
 * 返回的钩子函数是全新实例，需由调用方通过 agent.reload() 替换。
 */
export function reloadGlobalExtensions(globalDir: string): {
  extensions: Map<string, Extension>;
  interceptors: ToolInterceptor[];
  tools: Map<string, Tool>;
} {
  const { extensions, interceptors, tools } = scanGlobalPlugins(globalDir);
  logger.info(`[PluginLoader] 全局热重载完成: ${tools.size} tools, ${extensions.size} extensions, ${interceptors.length} interceptors`);
  return { extensions, interceptors, tools };
}

// ============================================================
// 合并策略
// ============================================================

/** 合并两个 Map，base 在前，override 在后（覆盖同名 key） */
export function mergeMaps<K, V>(base: Map<K, V>, override: Map<K, V>): Map<K, V> {
  const result = new Map(base);
  for (const [key, value] of override) {
    result.set(key, value);
  }
  return result;
}

// ============================================================
// 工具注入决策（v0.4.5 提取为纯函数，便于单元测试）
//
// 策略：按工具 requires 匹配 Agent tags 自动注入（替代 config.tools 写死白名单）
//   1. 遍历全部工具，requires 匹配 agentTags → 自动注入
//   2. explicitTools（config.tools 兼容）额外列出、且 requires 匹配（或无 requires）→ 注入
//   3. admin 标签 → 额外注入 level=admin 的工具（兼容旧角色体系）
// ============================================================

export function selectToolsByRequires(
  mergedTools: Map<string, Tool>,
  toolRequires: Map<string, string[]>,
  toolLevels: Map<string, 'basic' | 'tool' | 'dev' | 'admin'>,
  agentTags: string[],
  explicitTools: string[],
): Tool[] {
  const selected: Tool[] = [];
  const selectedNames = new Set<string>();
  const hasTag = (req: string[]) => req.every(r => agentTags.includes(r));

  // 1. 自动注入：requires 匹配 agentTags
  for (const [name, tool] of mergedTools) {
    const req = toolRequires.get(name);
    // 无 requires 的工具：默认不自动注入（需显式 config.tools 或标记基础）
    if (!req || req.length === 0) continue;
    if (!hasTag(req)) continue;
    selected.push(tool);
    selectedNames.add(name);
  }

  // 2. 显式追加：explicitTools（config.tools 兼容旧配置）
  for (const name of explicitTools) {
    if (selectedNames.has(name)) continue;
    const tool = mergedTools.get(name);
    if (!tool) continue;
    const req = toolRequires.get(name);
    if (req && req.length > 0 && !hasTag(req)) continue;
    selected.push(tool);
    selectedNames.add(name);
  }

  // 3. admin 标签 → 注入 level=admin 工具（兼容旧角色体系）
  if (agentTags.includes('admin')) {
    for (const [name, level] of toolLevels) {
      if (level === 'admin' && mergedTools.has(name) && !selectedNames.has(name)) {
        selected.push(mergedTools.get(name)!);
        selectedNames.add(name);
      }
    }
  }

  return selected;
}

// ============================================================
// PluginLoader —— 插件发现门面（bootstrap 注入 AppState / 服务注册表）
// ============================================================

/**
 * 插件发现与加载的统一入口。
 *
 * · bootstrap 创建后注入 AppState（pluginLoader 键）与 ServiceRegistry（pluginLoader 服务），
 * · core/agent 通过 AppState 运行时获取（performReload），不产生编译期依赖；
 * · webui 经 ServiceRegistry 获取（plugins API），不直接 import 核心。
 */
export class PluginLoader {
  private srcRoot: string;

  /**
   * @param srcRoot 源代码根目录（src/ 目录的绝对路径），用于定位 plugins/ 目录
   */
  constructor(srcRoot: string) {
    this.srcRoot = srcRoot;
  }

  /** 获取 plugins 目录路径（全局插件根） */
  private get globalDir() {
    return path.join(this.srcRoot, 'plugins');
  }

  /** 公开插件根目录（供外部读取） */
  getGlobalDir(): string {
    return this.globalDir;
  }

  /** 扫描全部全局插件（plugin.json 容器模式） */
  scanAll(): ReturnType<typeof scanGlobalPlugins> {
    return scanGlobalPlugins(this.globalDir);
  }

  /** 热重载全局扩展/拦截器/工具（cache bust 获取最新代码） */
  reloadGlobalExtensions(): ReturnType<typeof reloadGlobalExtensions> {
    return reloadGlobalExtensions(this.globalDir);
  }

  /** 从目录发现工具（供 core/agent self reload 等场景） */
  discoverTools(dir: string): Map<string, Tool> {
    return discoverTools(dir);
  }

  // ---- 插件元数据（原 AgentLoader 插件部分） ----

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
          // dev/admin 层工具也参与发现（list_tools 可见），但加载时按 requires/level 过滤；均不 autoInject
          const level = t.level ?? 'tool';
          const dir = path.join(pluginDir, t.path ?? `tools/${t.name}`);
          const tool = loadToolFromDir(dir, t.name);
          if (tool) {
            allMetas.set(`tool:${tool.definition.function.name}`, {
              name: tool.definition.function.name,
              type: 'tool',
              label: tool.label,
              description: tool.description ?? '',
              autoInject: t.autoInject ?? false,
              hidden: t.hidden ?? false,
              level,
              requires: t.requires ?? (level === 'dev' ? ['dev'] : level === 'admin' ? ['admin'] : undefined),
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
    const agentsDir = getGlobalConfig().agentsDir;
    if (fs.existsSync(agentsDir)) {
      const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(agentsDir, e.name));

      for (const agentDir of agentDirs) {
        const agentId = path.basename(agentDir);

        const agentToolMetas = discoverToolMetaModules(path.join(agentDir, 'tools'));
        for (const [name, meta] of agentToolMetas) {
          if (!allMetas.has(`tool:${name}`)) {
            allMetas.set(`tool:${name}`, { ...meta, agentId });
          }
        }

        const agentExtMetas = discoverExtensionMetaModules(path.join(agentDir, 'extensions'));
        for (const [, entries] of agentExtMetas) {
          for (const meta of entries) {
            const key = `${meta.type}:${meta.name}`;
            if (!allMetas.has(key)) {
              allMetas.set(key, { ...meta, agentId });
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

    const agentDir = path.join(getGlobalConfig().agentsDir, agentId);
    const configPath = path.join(agentDir, 'config.json');

    let enabledTools: string[] = [];
    let enabledPreHooks: string[] = [];
    let enabledPostHooks: string[] = [];

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { tools?: string[]; pre_hooks?: string[]; post_hooks?: string[] };
      enabledTools = config.tools ?? [];
      enabledPreHooks = config.pre_hooks ?? [];
      enabledPostHooks = config.post_hooks ?? [];
    }

    return allPlugins
      .filter((p) => {
        // 全局插件（agentId === undefined）对所有 Agent 可见
        // Agent 专属插件仅对所属 Agent 可见
        return p.agentId === undefined || p.agentId === agentId;
      })
      .map((p) => {
        let enabled = false;
        switch (p.type) {
          case 'tool': enabled = enabledTools.includes(p.name); break;
          case 'pre_hook': enabled = enabledPreHooks.includes(p.name); break;
          case 'post_hook': enabled = enabledPostHooks.includes(p.name); break;
        }
        return { ...p, enabled };
      });
  }

  // ============================================================
  // 配置 Schema 扫描 —— 从 meta.ts 模块中提取可配置项
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
      logger.warn(`[PluginLoader] 提取 meta 失败: ${entryFile} - ${err.message}`);
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
        display: (f as any).display,
        // ratio 滑动条需要 min/max/step
        ...(f.type === 'ratio' || f.type === 'number' ? {
          min: (f as any).min,
          max: (f as any).max,
          step: (f as any).step,
        } : {}),
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
      logger.warn(`[PluginLoader] 加载 LLM schema 失败: ${err.message}`);
    }
    return schemas;
  }

  /**
   * 获取搜索工具的各 provider 配置 schema。
   * 从全局插件中扫描 web_search 工具的 schemas.ts。
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
          logger.warn(`[PluginLoader] 加载 search schema 失败: ${err.message}`);
        }
      }
    }
    return schemas;
  }
}
