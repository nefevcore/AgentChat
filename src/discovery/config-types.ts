// ============================================================
// Agent 配置类型
// ============================================================

/**
 * LLM 配置 —— 每个 Agent 独立指定。
 *
 * 这是 AgentChat 中"共通 LLM 配置参数"的唯一来源。
 * Agent 通过 config.json → llm 覆盖，Hook 通过 ctx.llmConfig 读取。
 * 未指定的字段由各 LLM provider 内部默认值兜底。
 */
export interface LLMConfig {
  /** 提供商类型 */
  provider: 'openai' | 'deepseek' | 'ollama';
  /** API Key，支持 ${ENV_VAR} 环境变量引用 */
  api_key: string;
  /** API 地址 (可选，默认根据 provider 自动推断) */
  base_url?: string;
  /** 模型名 (可选，默认根据 provider 自动推断) */
  model?: string;
  /** 温度参数 (可选，默认由各 LLM provider 内部决定) */
  temperature?: number;
  /** 最大输出 token (可选，0 = 不限制，默认由 provider 内部决定) */
  max_tokens?: number;
  /** DeepSeek 思考强度 (可选，默认 'high') */
  reasoning_effort?: 'high' | 'max';
  /** 是否默认开启思考模式 (可选，默认 true) */
  thinking?: boolean;
}

/**
 * Agent 配置 —— 扁平化设计。
 *
 * 配置覆盖顺序：workspace/config.json（全局默认）→ agents/{id}/config.json（Agent 覆盖）
 *
 * 扩展/工具的配置使用命名空间前缀，直接写在顶层：
 *   "extension.agent_session": { "maxContextTokens": 300000 }
 *   "tool.bash":            { "defaultTimeout": 60000 }
 */
export interface AgentConfig {
  /** Agent 唯一标识 */
  agent_id: string;
  /** 显示名称 */
  name: string;
  /** 是否为虚拟 Agent（无 LLM，仅作路由端点） */
  virtual?: boolean;
  /** LLM 配置 */
  llm?: LLMConfig;
  /** 要加载的工具名称列表 */
  tools?: string[];
  /** 要加载的前置钩子名称列表 */
  pre_hooks?: string[];
  /** 要加载的后置钩子名称列表 */
  post_hooks?: string[];
  /** 允许任意命名空间前缀的扩展/工具配置 */
  [key: string]: any;
}

/**
 * AgentLoader 打包返回的完整 Agent 描述
 */
export interface AgentBundle {
  config: AgentConfig;
}

/**
 * 插件元数据（用于前端展示和勾选）
 */
export interface PluginMeta {
  /** 插件唯一标识（工具名或扩展文件名） */
  name: string;
  /** 插件类型 */
  type: 'tool' | 'pre_hook' | 'post_hook';
  /** 功能描述 */
  description: string;
  /** UI 展示名称（工具用 displayName，扩展用 meta.name） */
  displayName?: string;
}
