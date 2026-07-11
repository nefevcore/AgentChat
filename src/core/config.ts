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

export interface AppConfig {
  // ---- Agent 执行 ----
  /** Router 最大跳数（防死循环） */
  maxHops: number;

  // ---- 消息查询 ----
  /** 历史消息查询默认条数 */
  messageQueryDefaultLimit: number;

  // ---- WebUI ----
  /** WebUI 默认端口 */
  webuiDefaultPort: number;

  // ---- 路径 ----
  /** 运行时工作根目录，所有子路径均由此派生 */
  workspaceDir: string;
  /** Agent 配置目录路径（<workspace>/agents/） */
  agentsDir: string;
  /** 会话数据目录（<workspace>/sessions/） */
  sessionsDir: string;

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
  messageQueryDefaultLimit: 50,

  // WebUI
  webuiDefaultPort: 3830,

  // 路径（运行时由 loadConfig 填入实际值）
  workspaceDir: 'workspace/default',
  agentsDir: '',
  sessionsDir: '',

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
  const wsConfigPath = require('path').join(cfg.workspaceDir, 'config.json');
  if (require('fs').existsSync(wsConfigPath)) {
    try {
      const wsConfig = JSON.parse(require('fs').readFileSync(wsConfigPath, 'utf-8'));
      for (const key of Object.keys(wsConfig)) {
        const val = wsConfig[key];
        if (val === undefined || val === null) continue;

        if (key.includes('.')) {
          // 命名空间键 → 存入 namespaces 字典
          cfg.namespaces[key] = val as Record<string, unknown>;
        } else if (key in cfg) {
          // 顶层键 → 直接覆盖
          if (key === 'workspaceDir') {
            (cfg as any)[key] = require('path').resolve(cfg.workspaceDir, val);
          } else {
            (cfg as any)[key] = val;
          }
        } else {
          // 未知顶层键（如 llm）→ 挂载到 cfg 上
          (cfg as any)[key] = val;
        }
      }
    } catch (err: any) {
      console.warn(`[Config] 读取 ${wsConfigPath} 失败：${err.message}`);
    }
  }

  // 3. 路径默认值 —— 统一从 workspaceDir 派生
  const ws = cfg.workspaceDir;
  if (!cfg.agentsDir) {
    cfg.agentsDir = require('path').join(ws, 'agents');
  }
  if (!cfg.sessionsDir) {
    cfg.sessionsDir = require('path').join(ws, 'sessions');
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
