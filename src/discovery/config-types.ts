// ============================================================
// Agent 配置类型
// ============================================================

/**
 * LLM 配置 —— 每个 Agent 独立指定，也可引用模型管理中的条目。
 *
 * 这是 AgentChat 中"共通 LLM 配置参数"的唯一来源。
 * Agent 通过 config.json → llm 覆盖，Hook 通过 ctx.llmConfig 读取。
 * 未指定的字段由各 LLM provider 内部默认值兜底。
 *
 * 池引用：
 *   "llm": "deepseek-pro"              ← 字符串 = 池引用
 *   "llm": { "$ref": "deepseek-pro", "temperature": 0.5 }  ← 引用 + 覆盖
 *   "llm": { "provider": "deepseek", ... }  ← 传统内嵌（向后兼容）
 */
export interface LLMConfig {
  /** 池引用名称（指向 workspace/config.json 中 llmProviders 的条目） */
  $ref?: string;
  /** 提供商类型（池引用时可省略） */
  provider?: 'openai' | 'deepseek' | 'ollama';
  /** API Key，支持 ${ENV_VAR} 环境变量引用 */
  api_key?: string;
  /** API 地址 (可选，默认根据 provider 自动推断) */
  base_url?: string;
  /** 模型名 (可选，默认根据 provider 自动推断) */
  model?: string;
  /** 温度参数 (可选，默认由各 LLM provider 内部决定，范围 0-2) */
  temperature?: number | null;
  /** 最大输出 token (可选，0 或 null = 不限制，默认由 provider 内部决定) */
  max_tokens?: number | null;
  /**
   * 核采样参数 (可选，范围 0-1，默认 1)。
   * 模型会考虑前 top_p 概率的 token。建议与 temperature 二选一调整。
   */
  top_p?: number | null;
  /**
   * 输出格式 (可选)。
   *   - "text": 普通文本输出 (默认)
   *   - "json_object": 强制 JSON 输出
   */
  response_format?: 'text' | 'json_object' | null;
  /**
   * 停止词 (可选)。最多 16 个，模型遇到任一停止词即停止输出。
   * 可为单个字符串或字符串数组。
   */
  stop?: string | string[] | null;
  /** [DeepSeek] 思考强度 (可选，默认 'high') */
  reasoning_effort?: 'high' | 'max';
  /** [DeepSeek] 是否默认开启思考模式 (可选，默认 true) */
  thinking?: boolean;
  /**
   * [DeepSeek] 是否返回输出 token 的对数概率 (可选，默认 false)。
   * 开启后可在 message.content 中获取每个 token 的 logprob。
   */
  logprobs?: boolean | null;
  /**
   * [DeepSeek] 返回 top N 概率 token 及其对数概率 (可选，范围 0-20)。
   * 设置此参数时 logprobs 必须为 true。
   */
  top_logprobs?: number | null;
  /**
   * [DeepSeek] 工具选择策略 (可选)。
   *   - "none": 不调用任何工具
   *   - "auto": 模型自行决定 (默认)
   *   - "required": 必须调用至少一个工具
   */
  tool_choice?: 'none' | 'auto' | 'required' | null;
}

/** 模型管理条目 —— workspace/config.json 中 llmProviders 的值 */
export type LLMProviderPoolEntry = LLMConfig;

/** 搜索引擎条目 —— workspace/config.json 中 searchProviders 的值 */
export interface SearchProviderPoolEntry {
  provider?: string;
  tavilyApiKey?: string;
  serpapiApiKey?: string;
  braveApiKey?: string;
  defaultResults?: number;
  defaultDepth?: string;
  defaultTopic?: string;
  rawContentMaxLen?: number;
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
  /** 昵称 */
  name: string;
  /** 是否为虚拟 Agent（无 LLM，仅作路由端点） */
  virtual?: boolean;
  /** 头像文件名（位于 agents/<目录>/ 下），如 "avatar.png" */
  avatar?: string;
  /** LLM 配置：可内嵌、可引用池条目（字符串）或引用+覆盖 */
  llm?: LLMConfig | string;
  /** 要加载的工具名称列表 */
  tools?: string[];
  /** 要加载的前置钩子名称列表 */
  pre_hooks?: string[];
  /** 要加载的后置钩子名称列表 */
  post_hooks?: string[];
  /**
   * 路径穿透白名单：允许此 Agent 的工具访问 workspaceDir 之外的路径。
   *
   * - 空数组或未定义时，工具只能访问 workspaceDir 内的路径（默认沙箱）
   * - 指定后，工具可额外访问白名单中的路径（穿透工作区限制）
   * - 支持相对路径（相对于 workspaceDir）和绝对路径
   *
   * @example ["/tmp/agent_scratch/", "../shared_data/"]
   */
  allowedPaths?: string[];
  /** 允许任意命名空间前缀的扩展/工具配置 */
  [key: string]: any;
}

/**
 * AgentLoader 打包返回的完整 Agent 描述
 */
export interface AgentBundle {
  config: AgentConfig;
}

// ── 基础元数据 ──
export interface Meta {
  /** 唯一标识 */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
  /**
   * 条件显示：当同级其他字段的值匹配时才显示此字段。
   * 例如 { provider: 'tavily' } 表示仅当 provider 字段值为 'tavily' 时显示。
   */
  showWhen?: Record<string, string | number | boolean>;
}

/**
 * 插件元数据。Extension 和 Tool 的 API 元信息，
 * 由 agent-loader 从 meta.ts 提取后填充 type 字段。
 */
export interface PluginMeta extends Meta {
  type: 'tool' | 'pre_hook' | 'post_hook';
}

// ── 配置字段类型（判别联合） ──
export interface TextFieldMeta extends Meta {
  type: 'text';
  default?: string;
}

export interface PasswordFieldMeta extends Meta {
  type: 'password';
  default?: string;
}

export interface NumberFieldMeta extends Meta {
  type: 'number';
  default?: number;
  min?: number;
  max?: number;
}

export interface CheckboxFieldMeta extends Meta {
  type: 'checkbox';
  default?: boolean;
}

export interface SelectFieldMeta extends Meta {
  type: 'select';
  default?: string | number;
  options: Array<{ label: string; value: string | number }>;
}

export interface FileFieldMeta extends Meta {
  type: 'file';
  default?: string;
  /** 文件过滤扩展名（如 ".mcp"），逗号分隔多个 */ 
  accept?: string;
}

export type ConfigField =
  | TextFieldMeta
  | PasswordFieldMeta
  | NumberFieldMeta
  | CheckboxFieldMeta
  | SelectFieldMeta
  | FileFieldMeta;

/** loader 提取配置信息用 */
export interface HasConfig {
  ns: string;
  label: string;
  description?: string;
  configuration?: ConfigField[];
}
