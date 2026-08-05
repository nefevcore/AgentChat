// ============================================================
// AgentChat 统一运行时配置
//
// 设计原则：
//   · AppConfig 只包含框架级核心配置（路径、路由、循环控制）
//   · 工具/扩展的配置各自定义接口 + 默认值，从 namespaces 字典读取
//   · workspace/config.json 中命名空间键（如 "tool.bash"）自动解析到 namespaces
//   · Agent 级配置覆盖通过 AgentContext.runtimeConfig 实现
//
// 配置加载优先级（工具/扩展）：
//   1. 工具/扩展自身默认值
//   2. workspace/config.json 中对应命名空间（全局）
//   3. Agent 级 config.json 中对应命名空间（runtimeConfig）
//
// 使用方式：
//   import { getGlobalConfig } from './core/config';
//   const cfg = getGlobalConfig();
//   // 工具/扩展请使用各自的 resolveXxxConfig(cfg, ctx?) 函数
// ============================================================

// ============================================================
// 配置接口
// ============================================================

import type { LLMProviderPoolEntry, SearchProviderPoolEntry } from '@core/types';
import type { GlobalTimerConfig } from './types';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

export interface AppConfig {
  // ---- Agent 执行 ----
  /** Router 最大跳数（防死循环） */
  maxHops: number;

  // ---- 消息查询 ----
  /** 历史消息查询默认条数 */
  messageQueryDefaultLimit: number;

  // ---- 路径 ----
  /** 运行时工作根目录，所有子路径均由此派生 */
  workspaceDir: string;
  /** Agent 配置目录路径（<workspace>/agents/） */
  agentsDir: string;
  /** 会话数据目录（<workspace>/sessions/） */
  sessionsDir: string;
  /** 群组数据目录（<workspace>/groups/） */
  groupsDir: string;

  // ---- 视图 ----
  /**
   * 当前视角 Agent ID。前端 WebUI 以此身份查看会话历史、发送消息。
   * 默认 'user'（人类用户视角），可切换为任意 Agent ID 以该 Agent 视角
   * 浏览对话记录。
   */
  viewerId: string;

  // ---- 模型 & 搜索引擎 ----
  /** 模型管理：命名条目，Agent 可通过 "llm": "条目名" 引用 */
  llmProviders: Record<string, LLMProviderPoolEntry>;
  /** 搜索引擎：命名条目，Agent 可通过 "tool.web_search": { "$ref": "条目名" } 引用 */
  searchProviders: Record<string, SearchProviderPoolEntry>;

  // ---- 路径穿透白名单 ----
  /**
   * 全局路径穿透白名单（全局默认，Agent 级 allowedPaths 会覆盖）。
   *
   * - 空数组或未定义时，工具只能访问 workspaceDir 内的路径（默认沙箱）
   * - 指定后，工具可额外访问白名单中的路径（穿透工作区限制）
   * - 支持相对路径（相对于 workspaceDir）和绝对路径
   */
  allowedPaths?: string[];

  // ---- 时区 ----
  /** 时区设置，支持 IANA 时区名称（如 "Asia/Shanghai"）或 UTC 偏移（如 "+08:00", "UTC+8"）。默认 "Asia/Shanghai" */
  timezone: string;

  // ---- 全局定时 ----
  /** 全局定时任务配置（原 chime 泛化）：定时向目标 Agent 发送提示/报时 */
  timer?: GlobalTimerConfig;
  /** 兼容旧键：chime（已泛化为 timer，读取时优先 timer） */
  chime?: GlobalTimerConfig;

  // ---- 扩展配置（命名空间字典） ----
  /**
   * 命名空间配置字典。
   *
   * workspace/config.json 中以 "namespace.key" 命名的顶层键
   * 会被自动解析到此处。例如：
   *   "tool.bash": { "defaultTimeout": 30000 }
   *   → namespaces["tool.bash"] = { defaultTimeout: 30000 }
   *
   * 工具/扩展通过各自的 resolveXxxConfig() 读取对应命名空间。
   */
  namespaces: Record<string, Record<string, unknown>>;
}

// ============================================================
// 默认值
// ============================================================

const DEFAULTS: AppConfig = {
  // Agent 执行
  maxHops: 5,

  // 消息查询
  messageQueryDefaultLimit: 5,

  // 路径（运行时由 loadConfig 填入实际值）
  workspaceDir: 'workspace/default',
  agentsDir: '',
  sessionsDir: '',
  groupsDir: '',

  // 视图
  viewerId: 'user',

  // 模型 & 搜索引擎
  llmProviders: {},
  searchProviders: {},

  // 路径穿透白名单（空 = 仅允许 workspaceDir 内）
  allowedPaths: [],

  // 时区
  timezone: 'Asia/Shanghai',

  // 全局定时（默认空）
  timer: undefined,
  chime: undefined,

  // 命名空间（由 loadConfig 从 workspace/config.json 解析填充）
  namespaces: {},
};

// ============================================================
// 加载函数
// ============================================================

/**
 * 加载配置：默认值 → <workspace>/config.json
 *
 * 命名空间解析规则：
 *   workspace/config.json 中以 "prefix.key" 格式命名的顶层键
 *   （如 "tool.bash"、"extension.agent_session"）会被解析到 namespaces 字典中。
 *   非命名空间键（不含 "."）直接合并到 AppConfig 顶层。
 */
function loadConfig(): AppConfig {
  const cfg: AppConfig = { ...DEFAULTS, namespaces: {} };

  // 1. 确定 workspaceDir（默认 cwd）
  if (!cfg.workspaceDir) {
    cfg.workspaceDir = process.cwd();
  }

  // 2. 加载 <workspace>/config.json（如果存在）
  const wsConfigPath = path.join(cfg.workspaceDir, 'config.json');
  if (fs.existsSync(wsConfigPath)) {
    try {
      const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
      for (const key of Object.keys(wsConfig)) {
        const val = wsConfig[key];
        if (val === undefined || val === null) continue;

        if (key.includes('.')) {
          // 命名空间键 → 存入 namespaces 字典
          cfg.namespaces[key] = val as Record<string, unknown>;
        } else if (key in cfg) {
          // 顶层键 → 直接覆盖
          if (key === 'workspaceDir') {
            (cfg as any)[key] = path.resolve(cfg.workspaceDir, val);
          } else {
            (cfg as any)[key] = val;
          }
        } else {
          // 未知顶层键（如 llm）→ 挂载到 cfg 上
          (cfg as any)[key] = val;
        }
      }
    } catch (err: any) {
      logger.warn(`[Config] 读取 ${wsConfigPath} 失败：${err.message}`);
    }
  }

  // 3. 路径默认值 —— 统一从 workspaceDir 派生
  const ws = cfg.workspaceDir;
  if (!cfg.agentsDir) {
    cfg.agentsDir = path.join(ws, 'agents');
  }
  if (!cfg.sessionsDir) {
    cfg.sessionsDir = path.join(ws, 'sessions');
  }
  if (!cfg.groupsDir) {
    cfg.groupsDir = path.join(ws, 'groups');
  }

  return cfg;
}

// ============================================================
// 默认导出（全局单例，不含 agent 覆盖）
// ============================================================

/** 全局默认配置（懒加载） */
let _globalConfig: AppConfig | null = null;

export function getGlobalConfig(): AppConfig {
  if (!_globalConfig) {
    _globalConfig = loadConfig();
  }
  return _globalConfig;
}

/** 热重载全局配置（保存 config.json 后调用，使池/LLM 等变更即时生效） */
export function reloadGlobalConfig(): AppConfig {
  _globalConfig = loadConfig();
  logger.info('[Config] 全局配置已热重载');
  return _globalConfig;
}

// ============================================================
// 命名空间配置解析辅助函数
// ============================================================

/**
 * 解析工具/扩展的命名空间配置。
 *
 * 合并顺序：默认值 → 全局命名空间 → Agent 级 runtimeConfig
 *
 * @param namespace  命名空间键（如 "tool.bash"、"extension.agent_session"）
 * @param defaults   模块自身默认值
 * @param runtimeCfg 可选的 Agent 级运行时覆盖（来自 AgentContext.runtimeConfig）
 */
export function resolveNamespaceConfig<T extends object>(
  namespace: string,
  defaults: T,
  runtimeCfg?: Record<string, Record<string, unknown>>,
): T {
  const globalCfg = getGlobalConfig();
  const globalNs = globalCfg.namespaces[namespace] as Partial<T> | undefined;
  const agentNs = runtimeCfg?.[namespace] as Partial<T> | undefined;
  return { ...defaults, ...globalNs, ...agentNs };
}

// ============================================================
// 共享路径安全工具
// ============================================================

/**
 * 当前 Agent 的路径穿透白名单（工具执行期间有效）。
 * 由 Agent.runTools() 在执行工具前设置、执行后清除。
 */
let _currentAgentAllowedPaths: string[] | undefined;

/** 设置当前 Agent 的路径穿透白名单（Agent.runTools 调用） */
export function setCurrentAgentAllowedPaths(paths: string[] | undefined): void {
  _currentAgentAllowedPaths = paths;
}

/** 清除当前 Agent 的路径穿透白名单 */
export function clearCurrentAgentAllowedPaths(): void {
  _currentAgentAllowedPaths = undefined;
}

/**
 * 安全解析文件路径，默认限制在工作区内，白名单路径可穿透到外部。
 *
 * 检查顺序：
 *   1. 将 filePath 相对于 workspaceDir 解析为绝对路径
 *   2. 若解析结果在 workspaceDir 内 → 直接放行（向后兼容）
 *   3. 若解析结果在 workspaceDir 外 → 检查白名单：
 *      - 若命中 allowedPaths 中任一条目 → 放行
 *      - 否则拒绝（路径穿越）
 *   4. 白名单条目支持：
 *      - 相对路径（相对于 workspaceDir 解析）
 *      - 绝对路径（直接使用）
 *
 * @param filePath      待解析的文件路径（绝对或相对于 workspaceDir）
 * @param allowedPaths  路径穿透白名单（Agent 级覆盖全局）。
 *                      空数组或未定义 = 仅允许 workspaceDir 内的路径。
 * @returns             安全解析后的绝对路径
 * @throws              路径穿越且不在白名单中时抛出错误
 *
 * @example
 *   // Agent 配置: allowedPaths: ["/tmp/agent_scratch/", "../shared_data/"]
 *   resolveSafePath("/tmp/agent_scratch/output.txt")  // ✅ 白名单穿透
 *   resolveSafePath("files/readme.txt")                // ✅ 在工作区内
 *   resolveSafePath("/etc/passwd")                     // ❌ 不在白名单 → 拒绝
 */
export function resolveSafePath(
  filePath: string,
  allowedPaths?: string[],
): string {
  const gCfg = getGlobalConfig();
  const sandbox = path.resolve(gCfg.workspaceDir);
  const resolved = path.resolve(sandbox, filePath);

  // 1. 在工作区内 → 直接放行
  if (resolved === sandbox || resolved.startsWith(sandbox + path.sep)) {
    return resolved;
  }

  // 2. 在工作区外 → 检查白名单穿透
  // 优先级：参数传入的 allowedPaths > 当前 Agent 的 allowedPaths > 全局 allowedPaths
  const effectiveWhitelist = (allowedPaths && allowedPaths.length > 0)
    ? allowedPaths
    : (_currentAgentAllowedPaths && _currentAgentAllowedPaths.length > 0
      ? _currentAgentAllowedPaths
      : (gCfg.allowedPaths && gCfg.allowedPaths.length > 0 ? gCfg.allowedPaths : undefined));

  if (effectiveWhitelist && effectiveWhitelist.length > 0) {
    const isAllowed = effectiveWhitelist.some((entry) => {
      // 绝对路径直接用；相对路径相对于 workspaceDir 解析
      const resolvedEntry = path.isAbsolute(entry)
        ? path.resolve(entry)
        : path.resolve(sandbox, entry);
      return resolved === resolvedEntry ||
        resolved.startsWith(resolvedEntry + path.sep);
    });

    if (isAllowed) {
      return resolved;
    }
  }

  // 3. 不在工作区内且不在白名单中 → 拒绝
  throw new Error(
    `路径穿越被拒绝："${filePath}" 解析到了工作区 "${sandbox}" 之外。` +
    (effectiveWhitelist && effectiveWhitelist.length > 0
      ? `白名单路径：${effectiveWhitelist.join(', ')}`
      : '未配置路径白名单。'),
  );
}
