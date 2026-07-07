// ============================================================
// AgentChat 统一运行时配置
//
// 配置加载优先级：
//   1. 代码默认值
//   2. <workspace>/config.json 覆盖
//
// 使用方式：
//   import { getGlobalConfig } from './core/config';
//   const cfg = getGlobalConfig();
// ============================================================

// ============================================================
// 配置接口
// ============================================================

export interface AppConfig {
  // ---- 会话与上下文 ----
  /** 上下文压缩触发阈值（估算 token 数），超过即压缩 */
  maxContextTokens: number;
  /** 上下文压缩时保留的最近消息条数 */
  keepRecentMessages: number;
  /** 压缩摘要中每条消息的预览截断长度（字符） */
  summaryPreviewLen: number;
  /** 最大记忆事实条数 */
  maxMemoryFacts: number;

  // ---- Agent 执行 ----
  /** ReAct 循环最大迭代次数 */
  maxIterations: number;
  /** Router 最大跳数（防死循环） */
  maxHops: number;

  // ---- 工具：bash ----
  /** bash 默认超时（毫秒） */
  bashDefaultTimeout: number;
  /** bash 最大超时硬上限（毫秒） */
  bashMaxTimeout: number;
  /** bash 输出截断长度（字符） */
  bashOutputMaxLen: number;
  /** bash 最大缓冲区（字节） */
  bashMaxBuffer: number;

  // ---- 工具：read ----
  /** read_file 输出截断长度（字符） */
  readOutputMaxLen: number;

  // ---- 工具：web_search ----
  /** web_search 默认返回结果数 */
  webSearchDefaultResults: number;
  /** web_search 默认搜索深度 */
  webSearchDefaultDepth: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  /** web_search 默认搜索类别 */
  webSearchDefaultTopic: 'general' | 'news' | 'finance';
  /** web_search 原始内容截断长度（字符） */
  webSearchRawContentMaxLen: number;

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
  /** 技能目录路径（<workspace>/skills/） */
  skillsDir: string;
  /** 工作区级共享工具目录（<workspace>/tools/） */
  toolsDir: string;
  /** 工作区级共享扩展目录（<workspace>/extensions/） */
  extensionsDir: string;
}

// ============================================================
// 默认值
// ============================================================

const DEFAULTS: AppConfig = {
  // 会话与上下文
  maxContextTokens: 100000,
  keepRecentMessages: 10,
  summaryPreviewLen: 200,
  maxMemoryFacts: 50,

  // Agent 执行
  maxIterations: 15,
  maxHops: 5,

  // bash 工具
  bashDefaultTimeout: 30_000,
  bashMaxTimeout: 120_000,
  bashOutputMaxLen: 50_000,
  bashMaxBuffer: 10 * 1024 * 1024, // 10 MB

  // read 工具
  readOutputMaxLen: 100_000,

  // web_search 工具
  webSearchDefaultResults: 5,
  webSearchDefaultDepth: 'advanced',
  webSearchDefaultTopic: 'general',
  webSearchRawContentMaxLen: 2000,

  // 消息查询
  messageQueryDefaultLimit: 50,

  // WebUI
  webuiDefaultPort: 3830,

  // 路径（运行时由 loadConfig 填入实际值）
  workspaceDir: 'workspace/default',
  agentsDir: '',
  sessionsDir: '',
  skillsDir: '',
  toolsDir: '',
  extensionsDir: '',
};

// ============================================================
// 加载函数
// ============================================================

/**
 * 加载配置：默认值 → <workspace>/config.json
 */
function loadConfig(): AppConfig {
  const cfg: AppConfig = { ...DEFAULTS };

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
        if (key in cfg) {
          const val = wsConfig[key];
          if (val !== undefined) {
            (cfg as any)[key] = key === 'workspaceDir' ? require('path').resolve(cfg.workspaceDir, val) : val;
          }
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
  if (!cfg.skillsDir) {
    cfg.skillsDir = require('path').join(ws, 'skills');
  }
  if (!cfg.toolsDir) {
    cfg.toolsDir = require('path').join(ws, 'tools');
  }
  if (!cfg.extensionsDir) {
    cfg.extensionsDir = require('path').join(ws, 'extensions');
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
